import type {
  CreateTodoInput,
  LegacyTodo,
  MigrationResult,
  PanelMode,
  Todo,
  UpdateTodoInput,
  WindowPrefs,
} from './types';

const TODOS_KEY = 'simple_todo_note.todos.v1';
const SELECTED_KEY = 'simple_todo_note.selected.v1';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type TauriRuntime = {
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
    };
  };
  __TAURI_INTERNALS__?: {
    invoke?: TauriInvoke;
  };
};

function isTodoLike(value: unknown): value is Todo {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const todo = value as Partial<Todo>;

  return (
    typeof todo.id === 'string' &&
    typeof todo.title === 'string' &&
    typeof todo.note === 'string' &&
    typeof todo.completed === 'boolean' &&
    (typeof todo.dueDate === 'string' || todo.dueDate === null) &&
    typeof todo.createdAt === 'string' &&
    typeof todo.updatedAt === 'string'
  );
}

function getInvoke(): TauriInvoke | null {
  const runtime = window as Window & TauriRuntime;

  if (runtime.__TAURI__?.core?.invoke) {
    return runtime.__TAURI__.core.invoke;
  }

  if (runtime.__TAURI_INTERNALS__?.invoke) {
    return runtime.__TAURI_INTERNALS__.invoke;
  }

  return null;
}

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const invoke = getInvoke();

  if (!invoke) {
    throw new Error('Tauri runtime is not available. Launch with `npm run app:dev` or packaged app.');
  }

  return invoke<T>(command, args);
}

export function loadLegacyTodosFromLocalStorage(): LegacyTodo[] {
  try {
    const raw = localStorage.getItem(TODOS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isTodoLike);
  } catch {
    return [];
  }
}

export function clearLegacyLocalStorage(): void {
  localStorage.removeItem(TODOS_KEY);
  localStorage.removeItem(SELECTED_KEY);
}

export async function migrateLegacyTodosIfNeeded(payload: LegacyTodo[]): Promise<MigrationResult> {
  return invokeCommand<MigrationResult>('migrate_legacy_todos_if_needed', { payload });
}

export async function listTodos(): Promise<Todo[]> {
  return invokeCommand<Todo[]>('list_todos');
}

export async function createTodo(input: CreateTodoInput): Promise<Todo> {
  return invokeCommand<Todo>('create_todo', { input });
}

export async function updateTodo(input: UpdateTodoInput): Promise<Todo> {
  return invokeCommand<Todo>('update_todo', { input });
}

export async function toggleTodo(id: string): Promise<Todo> {
  return invokeCommand<Todo>('toggle_todo', { id });
}

export async function deleteTodo(id: string): Promise<void> {
  await invokeCommand('delete_todo', { id });
}

export async function reorderTodos(ids: string[]): Promise<void> {
  await invokeCommand('reorder_todos', { ids });
}

export async function getWindowPrefs(): Promise<WindowPrefs> {
  return invokeCommand<WindowPrefs>('get_window_prefs');
}

export async function saveWindowPrefs(input: WindowPrefs): Promise<void> {
  await invokeCommand('save_window_prefs', { input });
}

export async function setPanelMode(mode: PanelMode): Promise<WindowPrefs> {
  return invokeCommand<WindowPrefs>('set_panel_mode', { mode });
}

export async function setAlwaysOnTop(enabled: boolean): Promise<WindowPrefs> {
  return invokeCommand<WindowPrefs>('set_always_on_top', { enabled });
}
