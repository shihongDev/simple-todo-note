# Simple Todo Note

Always-visible Windows desktop todo app.

## Features

- SQLite-backed local persistence (Tauri Rust backend)
- Task CRUD (create, edit, delete) + per-task notes
- Search and filters (`all`, `open`, `done`)
- One-time legacy migration from old `localStorage` data
- Always-on-top panel mode (`mini` / `expanded`)
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

- `src/App.tsx`: UI, async CRUD flows, panel controls
- `src/storage.ts`: Tauri invoke adapters + migration helpers
- `src/types.ts`: shared frontend data contracts
- `src/styles.css`: minimal responsive styling
- `src-tauri/src/main.rs`: SQLite commands, startup logic, window persistence, autostart
- `src-tauri/tauri.conf.json`: app/build/bundle configuration
