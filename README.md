# Simple Todo Note

Always-visible Windows desktop todo app with an Apple-inspired liquid glass UI.

## Features

- SQLite-backed local persistence (Tauri Rust backend)
- Task CRUD (create, edit, delete) + per-task notes
- Recurrence tag per task (`none`, `daily`, `weekly`, `bi-weekly`) shown as a name prefix
- Recurring checkbox behavior: marks the current cycle complete while keeping the task in `open`
- Explicit status control to move any task to `done` / `open`
- Search and filters (`all`, `open`, `done`)
- One-time legacy migration from old `localStorage` data
- Window size classes with snap-to-stable geometry (`mini`, `standard`, `wide`)
- Appearance controls persisted to SQLite (`motion`, `readability`, `reduce motion`)
- Auto-start registration at Windows login
- Soft-delete with 5-second undo

## Stack

- Frontend: React + TypeScript + Vite
- Desktop runtime: Tauri 2
- Database: SQLite (`rusqlite`, bundled SQLite)

## Run

Install JS dependencies:

```bash
npm install
```

Run as browser UI only:

```bash
npm run dev
```

Run as desktop app (recommended):

```bash
npm run app:dev
```

Build desktop installer:

```bash
npm run app:build
```

## Data location

SQLite file path (Windows):

- `%APPDATA%/<identifier>/simple_todo_note.db`

Current identifier in `src-tauri/tauri.conf.json`:

- `com.shiho.simpletodonote`

## Project structure

- `src/App.tsx`: UI, async CRUD flows, size-class controls
- `src/storage.ts`: Tauri invoke adapters + migration helpers
- `src/types.ts`: shared frontend data contracts
- `src/styles.css`: liquid glass styling, responsive layout, motion/readability modes
- `src-tauri/src/main.rs`: SQLite commands, startup logic, window persistence, autostart
- `src-tauri/tauri.conf.json`: app/build/bundle configuration
