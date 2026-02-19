export type Filter = 'all' | 'open' | 'done';

export type PanelMode = 'mini' | 'expanded';
export type MotionMode = 'balanced' | 'high' | 'low';
export type ReadabilityMode = 'adaptive' | 'pure' | 'strong';
export type ReduceMotionOverride = 'system' | 'on' | 'off';

export type RecurrenceTag = 'none' | 'daily' | 'weekly' | 'bi-weekly';

export type Todo = {
  id: string;
  title: string;
  recurrenceTag: RecurrenceTag;
  recurrenceCheckedAt: string | null;
  note: string;
  completed: boolean;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LegacyTodo = Omit<Todo, 'recurrenceTag' | 'recurrenceCheckedAt'> & {
  recurrenceTag?: RecurrenceTag;
  recurrenceCheckedAt?: string | null;
};

export type CreateTodoInput = {
  title: string;
  recurrenceTag?: RecurrenceTag;
  note?: string;
  dueDate?: string | null;
};

export type UpdateTodoInput = {
  id: string;
  title?: string;
  recurrenceTag?: RecurrenceTag;
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

export type UiPrefs = {
  motionMode: MotionMode;
  readabilityMode: ReadabilityMode;
  reduceMotionOverride: ReduceMotionOverride;
};

export type DeletedSnapshot = {
  todo: Todo;
  index: number;
};
