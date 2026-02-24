import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearLegacyLocalStorage,
  consumeDailyDueReminders,
  createTodo as createTodoRecord,
  deleteTodo as deleteTodoRecord,
  getDailyCompletionHeatmap,
  getUiPrefs,
  getWindowPrefs,
  listTodos,
  loadLegacyTodosFromLocalStorage,
  migrateLegacyTodosIfNeeded,
  saveUiPrefs,
  setRecurrenceCheck as setRecurrenceCheckRecord,
  setAlwaysOnTop as setAlwaysOnTopRecord,
  setWindowSizeClass as setWindowSizeClassRecord,
  toggleTodo as toggleTodoRecord,
  updateTodo as updateTodoRecord,
} from './storage';
import type {
  DailyHeatmapDay,
  DueReminder,
  DeletedSnapshot,
  Filter,
  MotionMode,
  ReadabilityMode,
  RecurrenceTag,
  ReduceMotionOverride,
  Todo,
  UiPrefs,
  WindowSizeClass,
} from './types';

type TodoPatch = {
  title?: string;
  recurrenceTag?: RecurrenceTag;
  recurrenceCheckedAt?: string | null;
  note?: string;
  completed?: boolean;
  dueDate?: string | null;
  reminderEnabled?: boolean;
};

const DEFAULT_UI_PREFS: UiPrefs = {
  motionMode: 'balanced',
  readabilityMode: 'adaptive',
  reduceMotionOverride: 'system',
};

const SIZE_CLASS_DIMENSIONS: Record<WindowSizeClass, { width: number; height: number }> = {
  mini: { width: 380, height: 520 },
  standard: { width: 760, height: 620 },
  wide: { width: 920, height: 680 },
};

const RESIZE_SNAP_DEBOUNCE_MS = 180;
const RESIZE_STABILITY_HOLD_MS = 160;
const DAILY_HEATMAP_DAYS = 90;
const HEATMAP_ROW_ORDER = [0, 1, 2, 3, 4, 5, 6] as const;

type DailyHeatmapCell = {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  label: string;
  isToday: boolean;
};

type UrgencyLevel = 'none' | 'upcoming' | 'soon' | 'today' | 'overdue';

function getSizeClassLabel(sizeClass: WindowSizeClass): string {
  if (sizeClass === 'mini') {
    return 'Compact';
  }
  if (sizeClass === 'standard') {
    return 'Standard';
  }
  return 'Wide';
}

function resolveNearestSizeClass(width: number, height: number): WindowSizeClass {
  const entries = Object.entries(SIZE_CLASS_DIMENSIONS) as Array<
    [WindowSizeClass, { width: number; height: number }]
  >;

  let best: WindowSizeClass = 'mini';
  let bestScore = Number.POSITIVE_INFINITY;

  for (const [candidate, dimensions] of entries) {
    const widthScore = Math.abs(width - dimensions.width);
    const heightScore = Math.abs(height - dimensions.height);
    const score = widthScore * 0.65 + heightScore * 0.35;

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function getRecurrencePrefix(tag: RecurrenceTag): string {
  if (tag === 'daily') {
    return '[Daily] ';
  }
  if (tag === 'weekly') {
    return '[Weekly] ';
  }
  if (tag === 'bi-weekly') {
    return '[Bi-weekly] ';
  }
  return '';
}

function getRecurrenceLabel(tag: RecurrenceTag): string {
  if (tag === 'daily') {
    return 'Daily';
  }
  if (tag === 'weekly') {
    return 'Weekly';
  }
  if (tag === 'bi-weekly') {
    return 'Bi-weekly';
  }
  return 'None';
}

function isRecurringTag(tag: RecurrenceTag): boolean {
  return tag !== 'none';
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function isRecurringCycleChecked(todo: Todo, now: Date = new Date()): boolean {
  if (todo.completed) {
    return true;
  }

  if (!isRecurringTag(todo.recurrenceTag)) {
    return todo.completed;
  }

  if (!todo.recurrenceCheckedAt) {
    return false;
  }

  const checkedAt = new Date(todo.recurrenceCheckedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    return false;
  }

  if (todo.recurrenceTag === 'daily') {
    return isSameLocalDay(checkedAt, now);
  }

  const elapsedMs = now.getTime() - checkedAt.getTime();
  const cycleDays = todo.recurrenceTag === 'weekly' ? 7 : 14;
  return elapsedMs < cycleDays * 24 * 60 * 60 * 1000;
}

function getCycleStatusLabel(tag: RecurrenceTag): string {
  if (tag === 'daily') {
    return 'Done today';
  }
  if (tag === 'weekly') {
    return 'Done this week';
  }
  if (tag === 'bi-weekly') {
    return 'Done this cycle';
  }
  return '';
}

function formatDisplayTitle(todo: Todo): string {
  return `${getRecurrencePrefix(todo.recurrenceTag)}${todo.title}`;
}

function getMotionLabel(value: MotionMode): string {
  if (value === 'high') {
    return 'High';
  }
  if (value === 'low') {
    return 'Low';
  }
  return 'Balanced';
}

function getReadabilityLabel(value: ReadabilityMode): string {
  if (value === 'pure') {
    return 'Pure glass';
  }
  if (value === 'strong') {
    return 'Strong text';
  }
  return 'Adaptive';
}

function getReduceMotionLabel(value: ReduceMotionOverride): string {
  if (value === 'on') {
    return 'Always on';
  }
  if (value === 'off') {
    return 'Always off';
  }
  return 'System';
}

function getStatusButtonLabel(todo: Todo): string {
  if (todo.completed) {
    return 'Move to Open';
  }
  return 'Move to Done';
}

function formatDateLabel(value: string | null): string {
  if (!value) {
    return 'No due date';
  }

  try {
    return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return value;
  }
}

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toDateLabelFromKey(dateKey: string): string {
  const [yearRaw, monthRaw, dayRaw] = dateKey.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return dateKey;
  }

  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function parseLocalDateKey(dateKey: string): Date | null {
  const [yearRaw, monthRaw, dayRaw] = dateKey.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const parsed = new Date(year, month - 1, day);
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function getTodoUrgency(todo: Todo, now: Date = new Date()): UrgencyLevel {
  if (todo.completed) {
    return 'none';
  }

  if (isRecurringTag(todo.recurrenceTag) && isRecurringCycleChecked(todo, now)) {
    return 'none';
  }

  if (!todo.dueDate) {
    return 'none';
  }

  const dueDate = parseLocalDateKey(todo.dueDate);
  if (!dueDate) {
    return 'none';
  }

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const deltaDays = Math.round((dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

  if (deltaDays < 0) {
    return 'overdue';
  }
  if (deltaDays === 0) {
    return 'today';
  }
  if (deltaDays <= 2) {
    return 'soon';
  }
  if (deltaDays <= 7) {
    return 'upcoming';
  }
  return 'none';
}

function buildReminderNotification(reminders: DueReminder[]): { title: string; body: string } {
  if (reminders.length === 0) {
    return { title: '', body: '' };
  }

  if (reminders.length === 1) {
    const reminder = reminders[0];
    const prefix =
      reminder.daysOverdue > 0
        ? `Overdue by ${reminder.daysOverdue} day${reminder.daysOverdue === 1 ? '' : 's'}`
        : 'Due today';
    return {
      title: `${prefix}: ${reminder.title}`,
      body: `Due ${toDateLabelFromKey(reminder.dueDate)}`,
    };
  }

  const overdueCount = reminders.filter((reminder) => reminder.daysOverdue > 0).length;
  const todayCount = reminders.length - overdueCount;

  const parts: string[] = [];
  if (todayCount > 0) {
    parts.push(`${todayCount} due today`);
  }
  if (overdueCount > 0) {
    parts.push(`${overdueCount} overdue`);
  }

  return {
    title: `${reminders.length} tasks need attention`,
    body: `${parts.join(' • ')}${parts.length > 0 ? ' • ' : ''}${reminders[0].title}`,
  };
}

function toHeatmapLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) {
    return 0;
  }

  if (count === 1) {
    return 1;
  }

  if (count <= 3) {
    return 2;
  }

  if (count <= 5) {
    return 3;
  }

  return 4;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Something went wrong.';
}

function App() {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pointerFrame = useRef<number | null>(null);
  const resizeSnapTimer = useRef<number | null>(null);
  const resizeReleaseTimer = useRef<number | null>(null);
  const activeSizeClassRef = useRef<WindowSizeClass>('mini');
  const finishFxTimers = useRef<Map<string, number>>(new Map());
  const midnightReminderTimer = useRef<number | null>(null);
  const reminderCheckInFlight = useRef(false);

  const [todos, setTodos] = useState<Todo[]>([]);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [sizeClass, setSizeClass] = useState<WindowSizeClass>('mini');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [isResizingWindow, setIsResizingWindow] = useState(false);

  const [newTitle, setNewTitle] = useState('');
  const [newRecurrenceTag, setNewRecurrenceTag] = useState<RecurrenceTag>('none');
  const [newDueDate, setNewDueDate] = useState('');
  const [isAddOpen, setIsAddOpen] = useState(false);

  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(DEFAULT_UI_PREFS);
  const [systemPrefersReducedMotion, setSystemPrefersReducedMotion] = useState(false);

  const [detailTitle, setDetailTitle] = useState('');
  const [detailNote, setDetailNote] = useState('');

  const [deletedSnapshot, setDeletedSnapshot] = useState<DeletedSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [finishingTodoIds, setFinishingTodoIds] = useState<string[]>([]);
  const [dailyHeatmapDays, setDailyHeatmapDays] = useState<DailyHeatmapDay[]>([]);

  const undoTimer = useRef<number | null>(null);

  const selectedTodo = todos.find((todo) => todo.id === selectedTodoId) ?? null;
  const openCount = todos.filter((todo) => !todo.completed).length;
  const effectiveReducedMotion =
    isResizingWindow ||
    uiPrefs.reduceMotionOverride === 'on' ||
    (uiPrefs.reduceMotionOverride === 'system' && systemPrefersReducedMotion);

  const filteredTodos = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return todos.filter((todo) => {
      if (filter === 'open' && todo.completed) {
        return false;
      }

      if (filter === 'done' && !todo.completed) {
        return false;
      }

      if (!needle) {
        return true;
      }

      return (
        todo.title.toLowerCase().includes(needle) ||
        getRecurrenceLabel(todo.recurrenceTag).toLowerCase().includes(needle) ||
        todo.note.toLowerCase().includes(needle) ||
        (todo.dueDate ?? '').toLowerCase().includes(needle)
      );
    });
  }, [filter, search, todos]);

  const dailyHeatmap = useMemo(() => {
    const countByDate = new Map<string, number>();
    for (const entry of dailyHeatmapDays) {
      const nextCount = Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0;
      countByDate.set(entry.date, nextCount);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = toLocalDateKey(today);

    const cells: DailyHeatmapCell[] = [];
    for (let offset = DAILY_HEATMAP_DAYS - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const dateKey = toLocalDateKey(date);
      const count = countByDate.get(dateKey) ?? 0;

      cells.push({
        date: dateKey,
        count,
        level: 0,
        label: `${count} daily ${count === 1 ? 'task' : 'tasks'} done on ${toDateLabelFromKey(dateKey)}`,
        isToday: dateKey === todayKey,
      });
    }

    const maxCount = cells.reduce((max, cell) => Math.max(max, cell.count), 0);
    const leveledCells = cells.map((cell) => ({
      ...cell,
      level: toHeatmapLevel(cell.count),
    }));

    const startDate = new Date(today);
    startDate.setDate(today.getDate() - (DAILY_HEATMAP_DAYS - 1));
    const leadingEmptyCells = startDate.getDay();
    const flatGrid: Array<DailyHeatmapCell | null> = [
      ...Array.from({ length: leadingEmptyCells }, () => null),
      ...leveledCells,
    ];

    const weeks: Array<Array<DailyHeatmapCell | null>> = [];
    for (let index = 0; index < flatGrid.length; index += 7) {
      weeks.push(flatGrid.slice(index, index + 7));
    }

    return {
      weeks,
      maxCount,
    };
  }, [dailyHeatmapDays]);

  useEffect(() => {
    activeSizeClassRef.current = sizeClass;
  }, [sizeClass]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setSystemPrefersReducedMotion(media.matches);

    const onChange = (event: MediaQueryListEvent) => {
      setSystemPrefersReducedMotion(event.matches);
    };

    media.addEventListener('change', onChange);
    return () => {
      media.removeEventListener('change', onChange);
    };
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return;
    }

    const maxTiltDegrees =
      uiPrefs.motionMode === 'high' ? 4.2 : uiPrefs.motionMode === 'low' ? 1.2 : 2.4;

    const commitPointer = (x: number, y: number) => {
      shell.style.setProperty('--cursor-x', `${(x * 100).toFixed(2)}%`);
      shell.style.setProperty('--cursor-y', `${(y * 100).toFixed(2)}%`);

      if (effectiveReducedMotion) {
        shell.style.setProperty('--tilt-x', '0deg');
        shell.style.setProperty('--tilt-y', '0deg');
        return;
      }

      const tiltX = (0.5 - y) * maxTiltDegrees * 2;
      const tiltY = (x - 0.5) * maxTiltDegrees * 2;
      shell.style.setProperty('--tilt-x', `${tiltX.toFixed(3)}deg`);
      shell.style.setProperty('--tilt-y', `${tiltY.toFixed(3)}deg`);
    };

    let nextX = 0.5;
    let nextY = 0.5;

    const queueCommit = () => {
      if (pointerFrame.current !== null) {
        return;
      }

      pointerFrame.current = window.requestAnimationFrame(() => {
        pointerFrame.current = null;
        commitPointer(nextX, nextY);
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      const bounds = shell.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }

      nextX = Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1);
      nextY = Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1);
      queueCommit();
    };

    const onPointerLeave = () => {
      nextX = 0.5;
      nextY = 0.5;
      queueCommit();
    };

    shell.addEventListener('pointermove', onPointerMove);
    shell.addEventListener('pointerleave', onPointerLeave);
    commitPointer(0.5, 0.5);

    return () => {
      shell.removeEventListener('pointermove', onPointerMove);
      shell.removeEventListener('pointerleave', onPointerLeave);
      if (pointerFrame.current !== null) {
        window.cancelAnimationFrame(pointerFrame.current);
        pointerFrame.current = null;
      }
    };
  }, [effectiveReducedMotion, uiPrefs.motionMode]);

  useEffect(() => {
    const onResize = () => {
      setIsResizingWindow(true);

      if (resizeSnapTimer.current !== null) {
        window.clearTimeout(resizeSnapTimer.current);
      }

      if (resizeReleaseTimer.current !== null) {
        window.clearTimeout(resizeReleaseTimer.current);
      }

      resizeSnapTimer.current = window.setTimeout(() => {
        resizeSnapTimer.current = null;
        const target = resolveNearestSizeClass(window.innerWidth, window.innerHeight);
        if (target !== activeSizeClassRef.current) {
          void switchSizeClass(target);
        }

        resizeReleaseTimer.current = window.setTimeout(() => {
          resizeReleaseTimer.current = null;
          setIsResizingWindow(false);
        }, RESIZE_STABILITY_HOLD_MS);
      }, RESIZE_SNAP_DEBOUNCE_MS);
    };

    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      if (resizeSnapTimer.current !== null) {
        window.clearTimeout(resizeSnapTimer.current);
        resizeSnapTimer.current = null;
      }
      if (resizeReleaseTimer.current !== null) {
        window.clearTimeout(resizeReleaseTimer.current);
        resizeReleaseTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadApp() {
      try {
        const legacyTodos = loadLegacyTodosFromLocalStorage();
        const migration = await migrateLegacyTodosIfNeeded(legacyTodos);

        if (legacyTodos.length > 0 && (migration.migratedCount > 0 || migration.alreadyMigrated)) {
          clearLegacyLocalStorage();
        }

        const [initialTodos, prefs, nextUiPrefs, nextHeatmap] = await Promise.all([
          listTodos(),
          getWindowPrefs(),
          getUiPrefs(),
          getDailyCompletionHeatmap(DAILY_HEATMAP_DAYS),
        ]);

        if (!active) {
          return;
        }

        setTodos(initialTodos);
        setSelectedTodoId(initialTodos[0]?.id ?? null);
        const restoredSizeClass = prefs.sizeClass ?? (prefs.mode === 'mini' ? 'mini' : 'wide');
        activeSizeClassRef.current = restoredSizeClass;
        setSizeClass(restoredSizeClass);
        setAlwaysOnTop(prefs.alwaysOnTop);
        setUiPrefs(nextUiPrefs);
        setDailyHeatmapDays(nextHeatmap);
      } catch (error) {
        if (active) {
          setErrorMessage(toErrorMessage(error));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadApp();

    return () => {
      active = false;
      if (undoTimer.current !== null) {
        window.clearTimeout(undoTimer.current);
      }
      if (midnightReminderTimer.current !== null) {
        window.clearTimeout(midnightReminderTimer.current);
        midnightReminderTimer.current = null;
      }
      for (const timer of finishFxTimers.current.values()) {
        window.clearTimeout(timer);
      }
      finishFxTimers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (selectedTodoId && !todos.some((todo) => todo.id === selectedTodoId)) {
      setSelectedTodoId(todos[0]?.id ?? null);
    }
  }, [selectedTodoId, todos]);

  useEffect(() => {
    setDetailTitle(selectedTodo?.title ?? '');
    setDetailNote(selectedTodo?.note ?? '');
  }, [selectedTodoId]);

  useEffect(() => {
    if (!selectedTodo) {
      return;
    }

    const timer = window.setTimeout(() => {
      const trimmedTitle = detailTitle.trim();

      if (trimmedTitle.length > 0 && trimmedTitle !== selectedTodo.title) {
        void applyTodoPatch(selectedTodo.id, { title: trimmedTitle });
      }

      if (detailNote !== selectedTodo.note) {
        void applyTodoPatch(selectedTodo.id, { note: detailNote });
      }
    }, 220);

    return () => window.clearTimeout(timer);
  }, [detailTitle, detailNote, selectedTodo]);

  useEffect(() => {
    if (loading) {
      return;
    }

    void runDailyReminderCheck();
    scheduleNextMidnightReminderCheck();

    const onFocus = () => {
      void runDailyReminderCheck();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void runDailyReminderCheck();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (midnightReminderTimer.current !== null) {
        window.clearTimeout(midnightReminderTimer.current);
        midnightReminderTimer.current = null;
      }
    };
  }, [loading]);

  async function refreshTodos(preferredId?: string | null) {
    const nextTodos = await listTodos();
    setTodos(nextTodos);

    setSelectedTodoId((currentId) => {
      const candidate = preferredId ?? currentId;
      if (candidate && nextTodos.some((todo) => todo.id === candidate)) {
        return candidate;
      }

      return nextTodos[0]?.id ?? null;
    });
  }

  async function refreshDailyHeatmap() {
    try {
      const nextHeatmap = await getDailyCompletionHeatmap(DAILY_HEATMAP_DAYS);
      setDailyHeatmapDays(nextHeatmap);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function ensureNotificationPermission(): Promise<NotificationPermission | null> {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return null;
    }

    let permission = Notification.permission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
      } catch {
        return null;
      }
    }

    return permission;
  }

  async function showDueReminderNotification(reminders: DueReminder[]) {
    if (reminders.length === 0 || typeof window === 'undefined' || !('Notification' in window)) {
      return;
    }

    const message = buildReminderNotification(reminders);
    const notification = new Notification(message.title, {
      body: message.body,
      tag: `simple-todo-day-reminder-${toLocalDateKey(new Date())}`,
    });

    notification.onclick = () => {
      window.focus();
      const firstReminder = reminders[0];
      if (firstReminder) {
        setSelectedTodoId(firstReminder.id);
        if (activeSizeClassRef.current === 'mini') {
          void switchSizeClass('standard');
        }
      }
      notification.close();
    };
  }

  async function runDailyReminderCheck() {
    if (reminderCheckInFlight.current) {
      return;
    }

    reminderCheckInFlight.current = true;

    try {
      const permission = await ensureNotificationPermission();
      if (permission !== 'granted') {
        return;
      }

      const reminders = await consumeDailyDueReminders();
      if (reminders.length > 0) {
        await showDueReminderNotification(reminders);
      }
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    } finally {
      reminderCheckInFlight.current = false;
    }
  }

  function scheduleNextMidnightReminderCheck() {
    if (midnightReminderTimer.current !== null) {
      window.clearTimeout(midnightReminderTimer.current);
      midnightReminderTimer.current = null;
    }

    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 2, 0);
    const delayMs = Math.max(1000, nextMidnight.getTime() - now.getTime());

    midnightReminderTimer.current = window.setTimeout(() => {
      midnightReminderTimer.current = null;
      void runDailyReminderCheck();
      scheduleNextMidnightReminderCheck();
    }, delayMs);
  }

  async function addTodo(event: FormEvent) {
    event.preventDefault();

    const title = newTitle.trim();
    if (!title) {
      return;
    }

    try {
      const created = await createTodoRecord({
        title,
        recurrenceTag: newRecurrenceTag,
        dueDate: newDueDate || null,
      });

      setTodos((previous) => [created, ...previous]);
      setSelectedTodoId(created.id);
      setNewTitle('');
      setNewRecurrenceTag('none');
      setNewDueDate('');
      setIsAddOpen(false);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function applyTodoPatch(todoId: string, patch: TodoPatch) {
    const target = todos.find((todo) => todo.id === todoId);
    if (!target) {
      return;
    }

    const optimistic: Todo = {
      ...target,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    setTodos((previous) => previous.map((todo) => (todo.id === todoId ? optimistic : todo)));

    const payload: {
      id: string;
      title?: string;
      recurrenceTag?: RecurrenceTag;
      note?: string;
      completed?: boolean;
      dueDate?: string | null;
      reminderEnabled?: boolean;
    } = { id: todoId };

    if ('title' in patch) {
      payload.title = patch.title;
    }

    if ('note' in patch) {
      payload.note = patch.note;
    }

    if ('recurrenceTag' in patch) {
      payload.recurrenceTag = patch.recurrenceTag;
    }

    if ('completed' in patch) {
      payload.completed = patch.completed;
    }

    if ('dueDate' in patch) {
      payload.dueDate = patch.dueDate ?? null;
    }

    if ('reminderEnabled' in patch) {
      payload.reminderEnabled = patch.reminderEnabled;
    }

    try {
      const saved = await updateTodoRecord(payload);
      setTodos((previous) => previous.map((todo) => (todo.id === todoId ? saved : todo)));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      await refreshTodos(todoId);
    }
  }

  async function toggleTodo(todoId: string) {
    const target = todos.find((todo) => todo.id === todoId);
    if (!target) {
      return;
    }

    if (!target.completed) {
      triggerFinishEffect(todoId);
    }

    setTodos((previous) =>
      previous.map((todo) =>
        todo.id === todoId ? { ...todo, completed: !todo.completed, updatedAt: new Date().toISOString() } : todo,
      ),
    );

    try {
      const updated = await toggleTodoRecord(todoId);
      setTodos((previous) => previous.map((todo) => (todo.id === todoId ? updated : todo)));
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      await refreshTodos(todoId);
    }
  }

  async function setRecurringCycleCheck(todoId: string, checked: boolean) {
    const target = todos.find((todo) => todo.id === todoId);
    if (!target || !isRecurringTag(target.recurrenceTag)) {
      return;
    }

    if (checked && !isRecurringCycleChecked(target)) {
      triggerFinishEffect(todoId);
    }

    const optimistic: Todo = {
      ...target,
      recurrenceCheckedAt: checked ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };

    setTodos((previous) => previous.map((todo) => (todo.id === todoId ? optimistic : todo)));

    try {
      const updated = await setRecurrenceCheckRecord(todoId, checked);
      setTodos((previous) => previous.map((todo) => (todo.id === todoId ? updated : todo)));
      if (target.recurrenceTag === 'daily') {
        void refreshDailyHeatmap();
      }
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      await refreshTodos(todoId);
    }
  }

  async function handleChecklistToggle(todo: Todo) {
    if (!isRecurringTag(todo.recurrenceTag) || todo.completed) {
      await toggleTodo(todo.id);
      return;
    }

    const checked = isRecurringCycleChecked(todo);
    await setRecurringCycleCheck(todo.id, !checked);
  }

  function triggerFinishEffect(todoId: string) {
    setFinishingTodoIds((current) => (current.includes(todoId) ? current : [...current, todoId]));

    const activeTimer = finishFxTimers.current.get(todoId);
    if (activeTimer !== undefined) {
      window.clearTimeout(activeTimer);
    }

    const timer = window.setTimeout(() => {
      setFinishingTodoIds((current) => current.filter((id) => id !== todoId));
      finishFxTimers.current.delete(todoId);
    }, 700);

    finishFxTimers.current.set(todoId, timer);
  }

  async function finalizeDelete(todoId: string) {
    try {
      await deleteTodoRecord(todoId);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      await refreshTodos();
    } finally {
      setDeletedSnapshot((current) => (current?.todo.id === todoId ? null : current));
    }
  }

  function deleteTodo(todoId: string) {
    if (deletedSnapshot) {
      if (undoTimer.current !== null) {
        window.clearTimeout(undoTimer.current);
        undoTimer.current = null;
      }
      void finalizeDelete(deletedSnapshot.todo.id);
      setDeletedSnapshot(null);
    }

    const index = todos.findIndex((todo) => todo.id === todoId);
    if (index === -1) {
      return;
    }

    const target = todos[index];

    setTodos((previous) => previous.filter((todo) => todo.id !== todoId));
    if (selectedTodoId === todoId) {
      setSelectedTodoId(null);
    }

    setDeletedSnapshot({ todo: target, index });

    undoTimer.current = window.setTimeout(() => {
      void finalizeDelete(target.id);
      undoTimer.current = null;
    }, 5000);
  }

  function undoDelete() {
    if (!deletedSnapshot) {
      return;
    }

    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }

    setTodos((previous) => {
      const next = [...previous];
      const index = Math.min(deletedSnapshot.index, next.length);
      next.splice(index, 0, deletedSnapshot.todo);
      return next;
    });

    setSelectedTodoId(deletedSnapshot.todo.id);
    setDeletedSnapshot(null);
  }

  async function applyUiPrefsPatch(patch: Partial<UiPrefs>) {
    const previous = uiPrefs;
    const next: UiPrefs = {
      ...previous,
      ...patch,
    };

    setUiPrefs(next);

    try {
      await saveUiPrefs(next);
      setErrorMessage(null);
    } catch (error) {
      setUiPrefs(previous);
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function switchSizeClass(nextSizeClass: WindowSizeClass) {
    const currentSizeClass = activeSizeClassRef.current;
    if (nextSizeClass === currentSizeClass) {
      return;
    }

    setSizeClass(nextSizeClass);
    activeSizeClassRef.current = nextSizeClass;

    try {
      const prefs = await setWindowSizeClassRecord(nextSizeClass);
      const resolvedSizeClass = prefs.sizeClass ?? (prefs.mode === 'mini' ? 'mini' : 'wide');
      activeSizeClassRef.current = resolvedSizeClass;
      setSizeClass(resolvedSizeClass);
      setAlwaysOnTop(prefs.alwaysOnTop);
      setErrorMessage(null);
    } catch (error) {
      activeSizeClassRef.current = currentSizeClass;
      setSizeClass(currentSizeClass);
      setErrorMessage(toErrorMessage(error));
    }
  }

  async function toggleAlwaysOnTop() {
    const nextValue = !alwaysOnTop;
    setAlwaysOnTop(nextValue);

    try {
      const prefs = await setAlwaysOnTopRecord(nextValue);
      setAlwaysOnTop(prefs.alwaysOnTop);
      setErrorMessage(null);
    } catch (error) {
      setAlwaysOnTop(!nextValue);
      setErrorMessage(toErrorMessage(error));
    }
  }

  function handleTodoSelect(todoId: string) {
    setSelectedTodoId(todoId);

    if (sizeClass === 'mini') {
      void switchSizeClass('standard');
    }
  }

  function openTodoDetails(todoId: string) {
    handleTodoSelect(todoId);
  }

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-size-class={sizeClass}
      data-motion={uiPrefs.motionMode}
      data-readability={uiPrefs.readabilityMode}
      data-reduce-motion={effectiveReducedMotion ? 'true' : 'false'}
      data-resizing-window={isResizingWindow ? 'true' : 'false'}
    >
      <header className="top-bar">
        <div className="title-block">
          <h1>Today's Tasks</h1>
        </div>

        <div className="window-controls">
          <p className="metric-pill">{openCount} active</p>
          {(['mini', 'standard', 'wide'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={sizeClass === option ? 'active-size' : ''}
              onClick={() => void switchSizeClass(option)}
            >
              {getSizeClassLabel(option)}
            </button>
          ))}
          <button
            type="button"
            className={alwaysOnTop ? 'pin-active' : ''}
            onClick={() => void toggleAlwaysOnTop()}
          >
            {alwaysOnTop ? 'Pinned' : 'Pin'}
          </button>
        </div>
      </header>

      {errorMessage && <p className="error-banner">{errorMessage}</p>}
      {loading && <p className="loading-banner">Loading tasks...</p>}

      <section className="workspace">
        <aside className="list-panel">
          <div className="toolbar">
            <div className="toolbar-head">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search"
                aria-label="Search tasks"
              />
              <button
                type="button"
                className={`add-toggle ${isAddOpen ? 'active' : ''}`}
                onClick={() => setIsAddOpen((current) => !current)}
                aria-expanded={isAddOpen}
                aria-controls="add-task-panel"
              >
                {isAddOpen ? 'Close' : 'Add'}
              </button>
            </div>

            {isAddOpen && (
              <section className="add-popover" id="add-task-panel" aria-label="Create task">
                <form onSubmit={addTodo} className="create-form">
                  <input
                    className="create-title"
                    value={newTitle}
                    onChange={(event) => setNewTitle(event.target.value)}
                    placeholder="Add a task..."
                    aria-label="Task title"
                    maxLength={160}
                    autoFocus
                  />
                  <select
                    className="create-tag"
                    value={newRecurrenceTag}
                    onChange={(event) => setNewRecurrenceTag(event.target.value as RecurrenceTag)}
                    aria-label="Task recurrence tag"
                  >
                    <option value="none">No tag</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="bi-weekly">Bi-weekly</option>
                  </select>
                  <input
                    className="create-date"
                    type="date"
                    value={newDueDate}
                    onChange={(event) => setNewDueDate(event.target.value)}
                    aria-label="Due date"
                  />
                  <button className="create-submit" type="submit">
                    Create
                  </button>
                </form>
              </section>
            )}

            <div className="filters" role="tablist" aria-label="Task filters">
              {(['all', 'open', 'done'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={filter === option ? 'active' : ''}
                  onClick={() => setFilter(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>

          <ul className="todo-list">
            {filteredTodos.map((todo) => {
              const cycleChecked = isRecurringCycleChecked(todo);
              const recurringOpen = isRecurringTag(todo.recurrenceTag) && !todo.completed;
              const isFinishing = finishingTodoIds.includes(todo.id);
              const urgencyLevel = getTodoUrgency(todo);

              return (
                <li key={todo.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    className={`todo-item ${selectedTodoId === todo.id ? 'selected' : ''} ${isFinishing ? 'finish-fx' : ''}`}
                    data-urgency={urgencyLevel}
                    onClick={() => void handleChecklistToggle(todo)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        void handleChecklistToggle(todo);
                      }
                    }}
                    aria-label={
                      !isRecurringTag(todo.recurrenceTag) || todo.completed
                        ? `${todo.completed ? 'Reopen' : 'Complete'} ${formatDisplayTitle(todo)}`
                        : cycleChecked
                          ? `Clear this cycle check for ${formatDisplayTitle(todo)}`
                          : `Mark ${formatDisplayTitle(todo)} done for this cycle`
                    }
                  >
                    <span className={`status-pill ${cycleChecked ? 'checked' : ''}`} aria-hidden="true" />
                    <div>
                      <p className={todo.completed ? 'done' : recurringOpen && cycleChecked ? 'cycle-complete' : ''}>
                        {formatDisplayTitle(todo)}
                      </p>
                      <span>{formatDateLabel(todo.dueDate)}</span>
                      {recurringOpen && cycleChecked && (
                        <span className="recurrence-state">{getCycleStatusLabel(todo.recurrenceTag)}</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="todo-details"
                      onClick={(event) => {
                        event.stopPropagation();
                        openTodoDetails(todo.id);
                      }}
                    >
                      Details
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {filteredTodos.length === 0 && <p className="empty-state">No tasks match this view.</p>}
        </aside>

        {sizeClass !== 'mini' && (
          <article className="detail-panel">
            <section className="heatmap-card" aria-label="Daily completion heatmap">
              <div className="heatmap-head">
                <p>Daily completion map</p>
                <span>Last {DAILY_HEATMAP_DAYS} days</span>
              </div>

              <div
                className="heatmap-grid"
                role="img"
                aria-label={`GitHub-style map of daily task completions over the last ${DAILY_HEATMAP_DAYS} days.`}
              >
                {dailyHeatmap.weeks.map((week, weekIndex) => (
                  <div key={`week-${weekIndex}`} className="heatmap-week">
                    {HEATMAP_ROW_ORDER.map((row) => {
                      const cell = week[row] ?? null;
                      if (!cell) {
                        return <span key={`week-${weekIndex}-row-${row}`} className="heatmap-cell is-empty" aria-hidden="true" />;
                      }

                      return (
                        <span
                          key={cell.date}
                          className={`heatmap-cell level-${cell.level}${cell.isToday ? ' is-today' : ''}`}
                          title={cell.label}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>

              <div className="heatmap-legend" aria-hidden="true">
                <span>Less</span>
                <span className="heatmap-cell level-0" />
                <span className="heatmap-cell level-1" />
                <span className="heatmap-cell level-2" />
                <span className="heatmap-cell level-3" />
                <span className="heatmap-cell level-4" />
                <span>More</span>
              </div>
              <p className="heatmap-caption">
                Peak day: {dailyHeatmap.maxCount} completion{dailyHeatmap.maxCount === 1 ? '' : 's'}.
              </p>
            </section>

            {selectedTodo ? (
              <>
                <div className="detail-header">
                  <input
                    value={detailTitle}
                    onChange={(event) => setDetailTitle(event.target.value)}
                    aria-label="Edit task title"
                    maxLength={160}
                  />
                  <button type="button" className="danger-button" onClick={() => deleteTodo(selectedTodo.id)}>
                    Delete
                  </button>
                </div>

                <div className="field-row">
                  <label htmlFor="recurrence-tag">Tag</label>
                  <select
                    id="recurrence-tag"
                    value={selectedTodo.recurrenceTag}
                    onChange={(event) =>
                      void applyTodoPatch(selectedTodo.id, {
                        recurrenceTag: event.target.value as RecurrenceTag,
                      })
                    }
                  >
                    <option value="none">No tag</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="bi-weekly">Bi-weekly</option>
                  </select>
                </div>

                <div className="field-row">
                  <label htmlFor="due-date">Due date</label>
                  <input
                    id="due-date"
                    type="date"
                    value={selectedTodo.dueDate ?? ''}
                    onChange={(event) =>
                      void applyTodoPatch(selectedTodo.id, {
                        dueDate: event.target.value.length > 0 ? event.target.value : null,
                      })
                    }
                  />
                </div>

                <div className="field-row">
                  <label htmlFor="reminder-toggle">Reminder</label>
                  <div className="status-cell">
                    <button
                      id="reminder-toggle"
                      type="button"
                      className={`status-toggle ${selectedTodo.reminderEnabled ? 'is-on' : ''}`}
                      onClick={() =>
                        void applyTodoPatch(selectedTodo.id, {
                          reminderEnabled: !selectedTodo.reminderEnabled,
                        })
                      }
                    >
                      {selectedTodo.reminderEnabled ? 'Daily reminders on' : 'Daily reminders off'}
                    </button>
                    <p className="status-hint">
                      Once per day for due or overdue tasks while the app is running
                      {selectedTodo.dueDate ? '.' : ' (set a due date to activate).'}
                    </p>
                  </div>
                </div>

                <div className="field-row">
                  <label htmlFor="status">Status</label>
                  <div className="status-cell">
                    <button id="status" type="button" className="status-toggle" onClick={() => void toggleTodo(selectedTodo.id)}>
                      {getStatusButtonLabel(selectedTodo)}
                    </button>
                    {isRecurringTag(selectedTodo.recurrenceTag) && !selectedTodo.completed && (
                      <p className="status-hint">Recurring tasks stay in Open when checked in the task list.</p>
                    )}
                  </div>
                </div>

                {isRecurringTag(selectedTodo.recurrenceTag) && !selectedTodo.completed && (
                  <div className="field-row">
                    <label htmlFor="cycle-check">This cycle</label>
                    <button
                      id="cycle-check"
                      type="button"
                      className="status-toggle"
                      onClick={() =>
                        void setRecurringCycleCheck(
                          selectedTodo.id,
                          !isRecurringCycleChecked(selectedTodo),
                        )
                      }
                    >
                      {isRecurringCycleChecked(selectedTodo)
                        ? 'Clear cycle check'
                        : `Mark ${getRecurrenceLabel(selectedTodo.recurrenceTag)} done`}
                    </button>
                  </div>
                )}

                <section className="appearance-panel" aria-label="Appearance settings">
                  <p className="appearance-title">Appearance</p>
                  <div className="field-row">
                    <label htmlFor="motion-mode">Motion</label>
                    <select
                      id="motion-mode"
                      value={uiPrefs.motionMode}
                      onChange={(event) =>
                        void applyUiPrefsPatch({
                          motionMode: event.target.value as MotionMode,
                        })
                      }
                    >
                      <option value="balanced">{getMotionLabel('balanced')}</option>
                      <option value="high">{getMotionLabel('high')}</option>
                      <option value="low">{getMotionLabel('low')}</option>
                    </select>
                  </div>
                  <div className="field-row">
                    <label htmlFor="readability-mode">Readability</label>
                    <select
                      id="readability-mode"
                      value={uiPrefs.readabilityMode}
                      onChange={(event) =>
                        void applyUiPrefsPatch({
                          readabilityMode: event.target.value as ReadabilityMode,
                        })
                      }
                    >
                      <option value="adaptive">{getReadabilityLabel('adaptive')}</option>
                      <option value="pure">{getReadabilityLabel('pure')}</option>
                      <option value="strong">{getReadabilityLabel('strong')}</option>
                    </select>
                  </div>
                  <div className="field-row">
                    <label htmlFor="reduce-motion-mode">Reduce motion</label>
                    <select
                      id="reduce-motion-mode"
                      value={uiPrefs.reduceMotionOverride}
                      onChange={(event) =>
                        void applyUiPrefsPatch({
                          reduceMotionOverride: event.target.value as ReduceMotionOverride,
                        })
                      }
                    >
                      <option value="system">{getReduceMotionLabel('system')}</option>
                      <option value="on">{getReduceMotionLabel('on')}</option>
                      <option value="off">{getReduceMotionLabel('off')}</option>
                    </select>
                  </div>
                </section>

                <label htmlFor="note-editor" className="note-label">
                  Note
                </label>
                <textarea
                  id="note-editor"
                  value={detailNote}
                  onChange={(event) => setDetailNote(event.target.value)}
                  placeholder="Capture details, links, and context..."
                />
              </>
            ) : (
              <div className="empty-detail">
                <p>Select a task to edit details.</p>
              </div>
            )}
          </article>
        )}
      </section>

      {deletedSnapshot && (
        <div className="undo-toast" role="status" aria-live="polite">
          <span>Task deleted.</span>
          <button type="button" onClick={undoDelete}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
