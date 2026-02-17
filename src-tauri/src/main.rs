#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, State, WebviewWindow, WindowEvent};
use uuid::Uuid;

const MIGRATION_KEY: &str = "legacy_migration_done";
const WINDOW_PREFS_KEY: &str = "window_prefs_json";
const UI_PREFS_KEY: &str = "ui_prefs_json";
const RECURRENCE_NONE: &str = "none";
const RECURRENCE_DAILY: &str = "daily";
const RECURRENCE_BI_WEEKLY: &str = "bi-weekly";

type CommandResult<T> = Result<T, String>;

struct AppState {
  db: Mutex<Connection>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Todo {
  id: String,
  title: String,
  recurrence_tag: String,
  note: String,
  completed: bool,
  due_date: Option<String>,
  created_at: String,
  updated_at: String,
  #[serde(skip_serializing, skip_deserializing)]
  sort_order: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTodoInput {
  title: String,
  recurrence_tag: Option<String>,
  note: Option<String>,
  due_date: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTodoInput {
  id: String,
  title: Option<String>,
  recurrence_tag: Option<String>,
  note: Option<String>,
  completed: Option<bool>,
  due_date: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyTodo {
  id: String,
  title: String,
  #[serde(default)]
  recurrence_tag: Option<String>,
  note: String,
  completed: bool,
  due_date: Option<String>,
  created_at: String,
  updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationResult {
  migrated_count: usize,
  already_migrated: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PanelMode {
  Mini,
  Expanded,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum MotionMode {
  Balanced,
  High,
  Low,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ReadabilityMode {
  Adaptive,
  Pure,
  Strong,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ReduceMotionOverride {
  System,
  On,
  Off,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowPrefs {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  mode: PanelMode,
  always_on_top: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct UiPrefs {
  motion_mode: MotionMode,
  readability_mode: ReadabilityMode,
  reduce_motion_override: ReduceMotionOverride,
}

impl Default for WindowPrefs {
  fn default() -> Self {
    Self {
      x: 80.0,
      y: 80.0,
      width: 380.0,
      height: 520.0,
      mode: PanelMode::Mini,
      always_on_top: true,
    }
  }
}

impl Default for UiPrefs {
  fn default() -> Self {
    Self {
      motion_mode: MotionMode::Balanced,
      readability_mode: ReadabilityMode::Adaptive,
      reduce_motion_override: ReduceMotionOverride::System,
    }
  }
}

fn now_iso() -> String {
  Utc::now().to_rfc3339()
}

fn normalize_date(value: Option<String>) -> Option<String> {
  value.and_then(|candidate| {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
      None
    } else {
      Some(trimmed.to_string())
    }
  })
}

fn normalize_recurrence_tag(value: Option<String>) -> String {
  match value.as_deref().map(str::trim) {
    Some(RECURRENCE_DAILY) => RECURRENCE_DAILY.to_string(),
    Some(RECURRENCE_BI_WEEKLY) => RECURRENCE_BI_WEEKLY.to_string(),
    _ => RECURRENCE_NONE.to_string(),
  }
}

fn to_db_bool(value: bool) -> i64 {
  if value {
    1
  } else {
    0
  }
}

fn map_todo_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Todo> {
  Ok(Todo {
    id: row.get(0)?,
    title: row.get(1)?,
    recurrence_tag: row.get(2)?,
    note: row.get(3)?,
    completed: row.get::<_, i64>(4)? != 0,
    due_date: row.get(5)?,
    created_at: row.get(6)?,
    updated_at: row.get(7)?,
    sort_order: row.get(8)?,
  })
}

fn ensure_schema(conn: &Connection) -> CommandResult<()> {
  conn
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        recurrence_tag TEXT NOT NULL DEFAULT 'none',
        note TEXT NOT NULL DEFAULT '',
        completed INTEGER NOT NULL DEFAULT 0,
        due_date TEXT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_todos_sort_order ON todos(sort_order);
      CREATE INDEX IF NOT EXISTS idx_todos_completed_sort ON todos(completed, sort_order);
    "#,
    )
    .map_err(|err| err.to_string())?;

  if let Err(err) = conn.execute(
    "ALTER TABLE todos ADD COLUMN recurrence_tag TEXT NOT NULL DEFAULT 'none'",
    [],
  ) {
    let message = err.to_string();
    if !message.contains("duplicate column name") {
      return Err(message);
    }
  }

  Ok(())
}

fn get_todo_by_id(conn: &Connection, id: &str) -> CommandResult<Option<Todo>> {
  conn
    .query_row(
      "SELECT id, title, recurrence_tag, note, completed, due_date, created_at, updated_at, sort_order
       FROM todos WHERE id = ?1",
      params![id],
      map_todo_row,
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> CommandResult<()> {
  conn
    .execute(
      "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![key, value],
    )
    .map_err(|err| err.to_string())?;

  Ok(())
}

fn get_meta(conn: &Connection, key: &str) -> CommandResult<Option<String>> {
  conn
    .query_row("SELECT value FROM app_meta WHERE key = ?1", params![key], |row| {
      row.get(0)
    })
    .optional()
    .map_err(|err| err.to_string())
}

fn get_window_prefs_from_conn(conn: &Connection) -> CommandResult<WindowPrefs> {
  let raw = get_meta(conn, WINDOW_PREFS_KEY)?;

  match raw {
    Some(value) => serde_json::from_str::<WindowPrefs>(&value).map_err(|err| err.to_string()),
    None => Ok(WindowPrefs::default()),
  }
}

fn save_window_prefs_to_conn(conn: &Connection, prefs: &WindowPrefs) -> CommandResult<()> {
  let value = serde_json::to_string(prefs).map_err(|err| err.to_string())?;
  set_meta(conn, WINDOW_PREFS_KEY, &value)
}

fn get_ui_prefs_from_conn(conn: &Connection) -> CommandResult<UiPrefs> {
  let raw = get_meta(conn, UI_PREFS_KEY)?;

  match raw {
    Some(value) => serde_json::from_str::<UiPrefs>(&value).map_err(|err| err.to_string()),
    None => Ok(UiPrefs::default()),
  }
}

fn save_ui_prefs_to_conn(conn: &Connection, prefs: &UiPrefs) -> CommandResult<()> {
  let value = serde_json::to_string(prefs).map_err(|err| err.to_string())?;
  set_meta(conn, UI_PREFS_KEY, &value)
}

fn apply_window_prefs(window: &WebviewWindow, prefs: &WindowPrefs) -> CommandResult<()> {
  window
    .set_size(Size::Logical(LogicalSize::new(prefs.width, prefs.height)))
    .map_err(|err| err.to_string())?;

  window
    .set_position(Position::Logical(LogicalPosition::new(prefs.x, prefs.y)))
    .map_err(|err| err.to_string())?;

  window
    .set_always_on_top(prefs.always_on_top)
    .map_err(|err| err.to_string())?;

  Ok(())
}

fn save_window_position(app: &AppHandle, x: f64, y: f64) -> CommandResult<()> {
  let Some(state) = app.try_state::<AppState>() else {
    return Ok(());
  };

  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;
  let mut prefs = get_window_prefs_from_conn(&conn)?;
  prefs.x = x;
  prefs.y = y;
  save_window_prefs_to_conn(&conn, &prefs)
}

fn save_window_size(app: &AppHandle, width: f64, height: f64) -> CommandResult<()> {
  let Some(state) = app.try_state::<AppState>() else {
    return Ok(());
  };

  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;
  let mut prefs = get_window_prefs_from_conn(&conn)?;
  prefs.width = width;
  prefs.height = height;
  save_window_prefs_to_conn(&conn, &prefs)
}

fn attach_window_persistence(window: WebviewWindow, app: AppHandle) {
  window.on_window_event(move |event| match event {
    WindowEvent::Moved(position) => {
      let _ = save_window_position(&app, position.x as f64, position.y as f64);
    }
    WindowEvent::Resized(size) => {
      let _ = save_window_size(&app, size.width as f64, size.height as f64);
    }
    _ => {}
  });
}

#[cfg(target_os = "windows")]
fn ensure_windows_autostart(key_name: &str) -> CommandResult<()> {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;

  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let (run_key, _) = hkcu
    .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
    .map_err(|err| err.to_string())?;

  let current_exe = std::env::current_exe().map_err(|err| err.to_string())?;
  let command = format!("\"{}\"", current_exe.display());

  run_key
    .set_value(key_name, &command)
    .map_err(|err| err.to_string())?;

  Ok(())
}

#[cfg(not(target_os = "windows"))]
fn ensure_windows_autostart(_key_name: &str) -> CommandResult<()> {
  Ok(())
}

#[tauri::command]
fn list_todos(state: State<'_, AppState>) -> CommandResult<Vec<Todo>> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let mut statement = conn
    .prepare(
      "SELECT id, title, recurrence_tag, note, completed, due_date, created_at, updated_at, sort_order
       FROM todos ORDER BY sort_order ASC, created_at DESC",
    )
    .map_err(|err| err.to_string())?;

  let rows = statement
    .query_map([], map_todo_row)
    .map_err(|err| err.to_string())?;

  let mut todos = Vec::new();
  for row in rows {
    todos.push(row.map_err(|err| err.to_string())?);
  }

  Ok(todos)
}

#[tauri::command]
fn create_todo(state: State<'_, AppState>, input: CreateTodoInput) -> CommandResult<Todo> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let trimmed_title = input.title.trim();
  if trimmed_title.is_empty() {
    return Err("Title cannot be empty".to_string());
  }

  let sort_order: i64 = conn
    .query_row(
      "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM todos",
      [],
      |row| row.get(0),
    )
    .map_err(|err| err.to_string())?;

  let now = now_iso();
  let todo = Todo {
    id: Uuid::new_v4().to_string(),
    title: trimmed_title.to_string(),
    recurrence_tag: normalize_recurrence_tag(input.recurrence_tag),
    note: input.note.unwrap_or_default(),
    completed: false,
    due_date: normalize_date(input.due_date),
    created_at: now.clone(),
    updated_at: now,
    sort_order,
  };

  conn
    .execute(
      "INSERT INTO todos
       (id, title, recurrence_tag, note, completed, due_date, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      params![
        &todo.id,
        &todo.title,
        &todo.recurrence_tag,
        &todo.note,
        to_db_bool(todo.completed),
        &todo.due_date,
        todo.sort_order,
        &todo.created_at,
        &todo.updated_at,
      ],
    )
    .map_err(|err| err.to_string())?;

  Ok(todo)
}

#[tauri::command]
fn update_todo(state: State<'_, AppState>, input: UpdateTodoInput) -> CommandResult<Todo> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let existing = get_todo_by_id(&conn, &input.id)?
    .ok_or_else(|| format!("Todo not found: {}", input.id))?;

  let mut updated = existing;

  if let Some(title) = input.title {
    let trimmed = title.trim();
    if trimmed.is_empty() {
      return Err("Title cannot be empty".to_string());
    }
    updated.title = trimmed.to_string();
  }

  if let Some(recurrence_tag) = input.recurrence_tag {
    updated.recurrence_tag = normalize_recurrence_tag(Some(recurrence_tag));
  }

  if let Some(note) = input.note {
    updated.note = note;
  }

  if let Some(completed) = input.completed {
    updated.completed = completed;
  }

  if let Some(due_date) = input.due_date {
    updated.due_date = normalize_date(due_date);
  }

  updated.updated_at = now_iso();

  conn
    .execute(
      "UPDATE todos
       SET title = ?2, recurrence_tag = ?3, note = ?4, completed = ?5, due_date = ?6, updated_at = ?7
       WHERE id = ?1",
      params![
        &updated.id,
        &updated.title,
        &updated.recurrence_tag,
        &updated.note,
        to_db_bool(updated.completed),
        &updated.due_date,
        &updated.updated_at,
      ],
    )
    .map_err(|err| err.to_string())?;

  Ok(updated)
}

#[tauri::command]
fn toggle_todo(state: State<'_, AppState>, id: String) -> CommandResult<Todo> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let mut target = get_todo_by_id(&conn, &id)?.ok_or_else(|| format!("Todo not found: {id}"))?;
  target.completed = !target.completed;
  target.updated_at = now_iso();

  conn
    .execute(
      "UPDATE todos SET completed = ?2, updated_at = ?3 WHERE id = ?1",
      params![&target.id, to_db_bool(target.completed), &target.updated_at],
    )
    .map_err(|err| err.to_string())?;

  Ok(target)
}

#[tauri::command]
fn delete_todo(state: State<'_, AppState>, id: String) -> CommandResult<()> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  conn
    .execute("DELETE FROM todos WHERE id = ?1", params![id])
    .map_err(|err| err.to_string())?;

  Ok(())
}

#[tauri::command]
fn reorder_todos(state: State<'_, AppState>, ids: Vec<String>) -> CommandResult<()> {
  let mut conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let tx = conn.transaction().map_err(|err| err.to_string())?;
  let now = now_iso();

  for (index, id) in ids.iter().enumerate() {
    tx
      .execute(
        "UPDATE todos SET sort_order = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, index as i64, &now],
      )
      .map_err(|err| err.to_string())?;
  }

  tx.commit().map_err(|err| err.to_string())?;
  Ok(())
}

#[tauri::command]
fn migrate_legacy_todos_if_needed(
  state: State<'_, AppState>,
  payload: Vec<LegacyTodo>,
) -> CommandResult<MigrationResult> {
  let mut conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let already_migrated = get_meta(&conn, MIGRATION_KEY)?.as_deref() == Some("true");
  if already_migrated {
    return Ok(MigrationResult {
      migrated_count: 0,
      already_migrated: true,
    });
  }

  let tx = conn.transaction().map_err(|err| err.to_string())?;
  let mut migrated_count = 0usize;

  let min_sort: i64 = tx
    .query_row("SELECT COALESCE(MIN(sort_order), 0) FROM todos", [], |row| row.get(0))
    .map_err(|err| err.to_string())?;

  let mut next_sort = min_sort - payload.len() as i64;

  for legacy in payload {
    let trimmed_title = legacy.title.trim();
    if trimmed_title.is_empty() {
      continue;
    }

    let id = if legacy.id.trim().is_empty() {
      Uuid::new_v4().to_string()
    } else {
      legacy.id
    };

    let created_at = if legacy.created_at.trim().is_empty() {
      now_iso()
    } else {
      legacy.created_at
    };

    let updated_at = if legacy.updated_at.trim().is_empty() {
      created_at.clone()
    } else {
      legacy.updated_at
    };

    let inserted = tx
      .execute(
        "INSERT OR IGNORE INTO todos
         (id, title, recurrence_tag, note, completed, due_date, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
          id,
          trimmed_title,
          normalize_recurrence_tag(legacy.recurrence_tag),
          legacy.note,
          to_db_bool(legacy.completed),
          normalize_date(legacy.due_date),
          next_sort,
          created_at,
          updated_at,
        ],
      )
      .map_err(|err| err.to_string())?;

    if inserted > 0 {
      migrated_count += 1;
      next_sort += 1;
    }
  }

  tx
    .execute(
      "INSERT INTO app_meta (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      params![MIGRATION_KEY, "true"],
    )
    .map_err(|err| err.to_string())?;

  tx.commit().map_err(|err| err.to_string())?;

  Ok(MigrationResult {
    migrated_count,
    already_migrated: false,
  })
}

#[tauri::command]
fn get_window_prefs(state: State<'_, AppState>) -> CommandResult<WindowPrefs> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  get_window_prefs_from_conn(&conn)
}

#[tauri::command]
fn save_window_prefs(state: State<'_, AppState>, input: WindowPrefs) -> CommandResult<()> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  save_window_prefs_to_conn(&conn, &input)
}

#[tauri::command]
fn get_ui_prefs(state: State<'_, AppState>) -> CommandResult<UiPrefs> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  get_ui_prefs_from_conn(&conn)
}

#[tauri::command]
fn save_ui_prefs(state: State<'_, AppState>, input: UiPrefs) -> CommandResult<()> {
  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  save_ui_prefs_to_conn(&conn, &input)
}

#[tauri::command]
fn set_panel_mode(
  state: State<'_, AppState>,
  app: AppHandle,
  mode: PanelMode,
) -> CommandResult<WindowPrefs> {
  let (target_width, target_height) = match mode {
    PanelMode::Mini => (380.0, 520.0),
    PanelMode::Expanded => (920.0, 680.0),
  };

  if let Some(window) = app.get_webview_window("main") {
    window
      .set_size(Size::Logical(LogicalSize::new(target_width, target_height)))
      .map_err(|err| err.to_string())?;
  }

  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let mut prefs = get_window_prefs_from_conn(&conn)?;
  prefs.mode = mode;
  prefs.width = target_width;
  prefs.height = target_height;
  save_window_prefs_to_conn(&conn, &prefs)?;

  Ok(prefs)
}

#[tauri::command]
fn set_always_on_top(
  state: State<'_, AppState>,
  app: AppHandle,
  enabled: bool,
) -> CommandResult<WindowPrefs> {
  if let Some(window) = app.get_webview_window("main") {
    window
      .set_always_on_top(enabled)
      .map_err(|err| err.to_string())?;
  }

  let conn = state
    .db
    .lock()
    .map_err(|_| "Failed to acquire database lock".to_string())?;

  let mut prefs = get_window_prefs_from_conn(&conn)?;
  prefs.always_on_top = enabled;
  save_window_prefs_to_conn(&conn, &prefs)?;

  Ok(prefs)
}

fn main() {
  tauri::Builder::default()
    .setup(|app| {
      let app_data_dir = app.path().app_data_dir().map_err(std::io::Error::other)?;
      std::fs::create_dir_all(&app_data_dir).map_err(std::io::Error::other)?;

      let db_path = app_data_dir.join("simple_todo_note.db");
      let conn = Connection::open(db_path).map_err(std::io::Error::other)?;
      ensure_schema(&conn).map_err(std::io::Error::other)?;

      let prefs = get_window_prefs_from_conn(&conn).unwrap_or_default();
      app.manage(AppState { db: Mutex::new(conn) });

      if let Some(window) = app.get_webview_window("main") {
        let _ = apply_window_prefs(&window, &prefs);
        attach_window_persistence(window, app.handle().clone());
      }

      let _ = ensure_windows_autostart("SimpleTodoNote");

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      list_todos,
      create_todo,
      update_todo,
      toggle_todo,
      delete_todo,
      reorder_todos,
      migrate_legacy_todos_if_needed,
      get_window_prefs,
      save_window_prefs,
      get_ui_prefs,
      save_ui_prefs,
      set_panel_mode,
      set_always_on_top,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
