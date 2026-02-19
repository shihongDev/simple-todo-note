import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearLegacyLocalStorage,
  createTodo as createTodoRecord,
  deleteTodo as deleteTodoRecord,
  getUiPrefs,
  getWindowPrefs,
  listTodos,
  loadLegacyTodosFromLocalStorage,
  migrateLegacyTodosIfNeeded,
  saveUiPrefs,
  setRecurrenceCheck as setRecurrenceCheckRecord,
  setAlwaysOnTop as setAlwaysOnTopRecord,
  setPanelMode as setPanelModeRecord,
  toggleTodo as toggleTodoRecord,
  updateTodo as updateTodoRecord,
} from './storage';
import type {
  DeletedSnapshot,
  Filter,
  MotionMode,
  PanelMode,
  ReadabilityMode,
  RecurrenceTag,
  ReduceMotionOverride,
  Todo,
  UiPrefs,
} from './types';

type TodoPatch = {
  title?: string;
  recurrenceTag?: RecurrenceTag;
  recurrenceCheckedAt?: string | null;
  note?: string;
  completed?: boolean;
  dueDate?: string | null;
};

const DEFAULT_UI_PREFS: UiPrefs = {
  motionMode: 'balanced',
  readabilityMode: 'adaptive',
  reduceMotionOverride: 'system',
};

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

  const [todos, setTodos] = useState<Todo[]>([]);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [panelMode, setPanelMode] = useState<PanelMode>('mini');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);

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

  const undoTimer = useRef<number | null>(null);

  const selectedTodo = todos.find((todo) => todo.id === selectedTodoId) ?? null;
  const openCount = todos.filter((todo) => !todo.completed).length;
  const effectiveReducedMotion =
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
    let active = true;

    async function loadApp() {
      try {
        const legacyTodos = loadLegacyTodosFromLocalStorage();
        const migration = await migrateLegacyTodosIfNeeded(legacyTodos);

        if (legacyTodos.length > 0 && (migration.migratedCount > 0 || migration.alreadyMigrated)) {
          clearLegacyLocalStorage();
        }

        const [initialTodos, prefs, nextUiPrefs] = await Promise.all([
          listTodos(),
          getWindowPrefs(),
          getUiPrefs(),
        ]);

        if (!active) {
          return;
        }

        setTodos(initialTodos);
        setSelectedTodoId(initialTodos[0]?.id ?? null);
        setPanelMode(prefs.mode);
        setAlwaysOnTop(prefs.alwaysOnTop);
        setUiPrefs(nextUiPrefs);
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

    const optimistic: Todo = {
      ...target,
      recurrenceCheckedAt: checked ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };

    setTodos((previous) => previous.map((todo) => (todo.id === todoId ? optimistic : todo)));

    try {
      const updated = await setRecurrenceCheckRecord(todoId, checked);
      setTodos((previous) => previous.map((todo) => (todo.id === todoId ? updated : todo)));
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

  async function switchPanelMode(nextMode: PanelMode) {
    if (nextMode === panelMode) {
      return;
    }

    const previousMode = panelMode;
    setPanelMode(nextMode);

    try {
      const prefs = await setPanelModeRecord(nextMode);
      setPanelMode(prefs.mode);
      setAlwaysOnTop(prefs.alwaysOnTop);
      setErrorMessage(null);
    } catch (error) {
      setPanelMode(previousMode);
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

    if (panelMode === 'mini') {
      void switchPanelMode('expanded');
    }
  }

  return (
    <div
      ref={shellRef}
      className={`app-shell ${panelMode}`}
      data-motion={uiPrefs.motionMode}
      data-readability={uiPrefs.readabilityMode}
      data-reduce-motion={effectiveReducedMotion ? 'true' : 'false'}
    >
      <header className="top-bar">
        <div>
          <p className="eyebrow">Simple Todo Note</p>
          <h1>Focus list</h1>
        </div>

        <div className="window-controls">
          <p className="open-count">{openCount} open</p>
          <button type="button" onClick={() => void switchPanelMode(panelMode === 'mini' ? 'expanded' : 'mini')}>
            {panelMode === 'mini' ? 'Expand' : 'Compact'}
          </button>
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

              return (
                <li key={todo.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    className={`todo-item ${selectedTodoId === todo.id ? 'selected' : ''}`}
                    onClick={() => handleTodoSelect(todo.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleTodoSelect(todo.id);
                      }
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={cycleChecked}
                      onChange={() => void handleChecklistToggle(todo)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={
                        !isRecurringTag(todo.recurrenceTag) || todo.completed
                          ? `Mark ${formatDisplayTitle(todo)} as ${todo.completed ? 'open' : 'done'}`
                          : cycleChecked
                            ? `Clear this cycle check for ${formatDisplayTitle(todo)}`
                            : `Mark ${formatDisplayTitle(todo)} done for this cycle`
                      }
                    />
                    <div>
                      <p className={todo.completed ? 'done' : recurringOpen && cycleChecked ? 'cycle-complete' : ''}>
                        {formatDisplayTitle(todo)}
                      </p>
                      <span>{formatDateLabel(todo.dueDate)}</span>
                      {recurringOpen && cycleChecked && (
                        <span className="recurrence-state">{getCycleStatusLabel(todo.recurrenceTag)}</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {filteredTodos.length === 0 && <p className="empty-state">No tasks match this view.</p>}
        </aside>

        {panelMode === 'expanded' && (
          <article className="detail-panel">
            {selectedTodo ? (
              <>
                <div className="detail-header">
                  <input
                    value={detailTitle}
                    onChange={(event) => setDetailTitle(event.target.value)}
                    aria-label="Edit task title"
                    maxLength={160}
                  />
                  <button type="button" onClick={() => deleteTodo(selectedTodo.id)}>
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
