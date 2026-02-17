import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearLegacyLocalStorage,
  createTodo as createTodoRecord,
  deleteTodo as deleteTodoRecord,
  getWindowPrefs,
  listTodos,
  loadLegacyTodosFromLocalStorage,
  migrateLegacyTodosIfNeeded,
  setAlwaysOnTop as setAlwaysOnTopRecord,
  setPanelMode as setPanelModeRecord,
  toggleTodo as toggleTodoRecord,
  updateTodo as updateTodoRecord,
} from './storage';
import type { DeletedSnapshot, Filter, PanelMode, Todo } from './types';

type TodoPatch = {
  title?: string;
  note?: string;
  completed?: boolean;
  dueDate?: string | null;
};

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
  const [todos, setTodos] = useState<Todo[]>([]);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const [panelMode, setPanelMode] = useState<PanelMode>('mini');
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);

  const [newTitle, setNewTitle] = useState('');
  const [newDueDate, setNewDueDate] = useState('');

  const [detailTitle, setDetailTitle] = useState('');
  const [detailNote, setDetailNote] = useState('');

  const [deletedSnapshot, setDeletedSnapshot] = useState<DeletedSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const undoTimer = useRef<number | null>(null);

  const selectedTodo = todos.find((todo) => todo.id === selectedTodoId) ?? null;
  const openCount = todos.filter((todo) => !todo.completed).length;

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
        todo.note.toLowerCase().includes(needle) ||
        (todo.dueDate ?? '').toLowerCase().includes(needle)
      );
    });
  }, [filter, search, todos]);

  useEffect(() => {
    let active = true;

    async function loadApp() {
      try {
        const legacyTodos = loadLegacyTodosFromLocalStorage();
        const migration = await migrateLegacyTodosIfNeeded(legacyTodos);

        if (legacyTodos.length > 0 && (migration.migratedCount > 0 || migration.alreadyMigrated)) {
          clearLegacyLocalStorage();
        }

        const [initialTodos, prefs] = await Promise.all([listTodos(), getWindowPrefs()]);

        if (!active) {
          return;
        }

        setTodos(initialTodos);
        setSelectedTodoId(initialTodos[0]?.id ?? null);
        setPanelMode(prefs.mode);
        setAlwaysOnTop(prefs.alwaysOnTop);
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
        dueDate: newDueDate || null,
      });

      setTodos((previous) => [created, ...previous]);
      setSelectedTodoId(created.id);
      setNewTitle('');
      setNewDueDate('');
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
    <div className={`app-shell ${panelMode}`}>
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

      <section className="create-card">
        <form onSubmit={addTodo} className="create-form">
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="Add a task..."
            aria-label="Task title"
            maxLength={160}
          />
          <input
            type="date"
            value={newDueDate}
            onChange={(event) => setNewDueDate(event.target.value)}
            aria-label="Due date"
          />
          <button type="submit">New</button>
        </form>
      </section>

      <section className="workspace">
        <aside className="list-panel">
          <div className="toolbar">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              aria-label="Search tasks"
            />
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
            {filteredTodos.map((todo) => (
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
                    checked={todo.completed}
                    onChange={() => void toggleTodo(todo.id)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Mark ${todo.title} as ${todo.completed ? 'open' : 'done'}`}
                  />
                  <div>
                    <p className={todo.completed ? 'done' : ''}>{todo.title}</p>
                    <span>{formatDateLabel(todo.dueDate)}</span>
                  </div>
                </div>
              </li>
            ))}
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
                  <button id="status" type="button" className="status-toggle" onClick={() => void toggleTodo(selectedTodo.id)}>
                    {selectedTodo.completed ? 'Done' : 'Open'}
                  </button>
                </div>

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
