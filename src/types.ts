export type Filter = 'all' | 'open' | 'done';

export type PanelMode = 'mini' | 'expanded';

export type Todo = {
  id: string;
  title: string;
  note: string;
  completed: boolean;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LegacyTodo = Todo;

export type CreateTodoInput = {
  title: string;
  note?: string;
  dueDate?: string | null;
};

export type UpdateTodoInput = {
  id: string;
  title?: string;
  note?: string;
  completed?: boolean;
  dueDate?: string | null;
};

export type MigrationResult = {
  migratedCount: number;
  alreadyMigrated: boolean;
};

export type WindowPrefs = {
  x: number;
  y: number;
  width: number;
  height: number;
  mode: PanelMode;
  alwaysOnTop: boolean;
};

export type DeletedSnapshot = {
  todo: Todo;
  index: number;
};
