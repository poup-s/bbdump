# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

bbdump is a cross-platform Electron desktop application for managing PostgreSQL database backups with automated scheduling, encryption, and a modern Vue 3 UI.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript (main process) + Vite (renderer)
npm run build:renderer # Vite build only (renderer/frontend)
npm run dev            # Full build then launch Electron
npm start              # Launch Electron (requires prior build)

# Distribution
npm run dist           # Build + package for current platform
npm run dist:mac       # macOS (DMG, arm64 + x64)
npm run dist:win       # Windows (NSIS + Portable)
npm run dist:linux     # Linux (AppImage + deb)
```

There are no test suites, linters, or formatters configured.

## Architecture

### Electron Process Model (3 layers)

1. **Main process** (`src/main/`) — Node.js backend: database operations, backup execution (pg_dump/pg_restore via child_process.spawn), cron scheduling, encryption, file I/O. Entry point: `src/main/main.ts`.

2. **Preload** (`src/preload/index.ts`) — Context bridge exposing safe IPC and shell APIs to the renderer via `window.electron`.

3. **Renderer** (`src/renderer/src/`) — Vue 3 SPA with Tailwind CSS. Entry point: `src/renderer/src/main.ts`, root component: `App.vue`.

### IPC Communication

All renderer↔main communication goes through `ipcRenderer.invoke()`. IPC handlers are organized in `src/main/ipc/`:
- `configIpc.ts` — Database CRUD, backup/restore operations, config, logs
- `dbViewerIpc.ts` — Table queries, schema inspection, row editing, extensions, CSV export
- `systemIpc.ts` — PostgreSQL config viewer, connection management, service restart
- `databaseCreationIpc.ts` — Local database creation

The renderer wraps IPC calls through `src/renderer/src/electron.ts`.

### State Management

No Pinia/Vuex — uses a single `reactive()` proxy in `src/renderer/src/store.ts`. Contains databases, backups, logs, scheduled tasks, modal visibility flags, and UI state. All components import and mutate this store directly.

### Navigation

Tab-based navigation in `App.vue` (no vue-router). Active tab stored in `store.activeTab`. Components conditionally rendered.

### Internationalization

Manual translation system in `src/renderer/src/i18n.ts` supporting English and French. Accessed via `useI18n()` composable. Translation keys use dot notation (e.g., `nav.databases`, `database.host`). Supports pluralization and parameter interpolation with `{param}` syntax.

### Key Directories

- `src/main/tools/` — Detection and installation of pg_dump/psql (Homebrew integration)
- `src/main/os/` — OS-specific path and platform detection
- `src/renderer/src/components/db-viewer/` — Database viewer sub-app (table data, schema, relations, Vue Flow visualizer, performance stats)
- `src/renderer/src/components/3d/` — Three.js dashboard scene (via TresJS)
- `src/renderer/src/composables/` — Vue 3 composition hooks (`useI18n`, `useToast`, `useConfirm`, `useDashboardData`)

### Build Pipeline

- TypeScript (`tsc`) compiles `src/main/` and `src/preload/` to `dist/` (target ES2020, module commonjs)
- Vite compiles `src/renderer/` to `dist/renderer/` (root is `src/renderer`, `@` alias → `src/renderer/src`)
- Electron Builder packages from `dist/` into `release/`

### User Data Paths

Configuration and data stored at `~/.bbdump/` (OS-dependent, managed in `src/main/paths.ts`):
- `config.json` — App configuration and database connection list
- `logs/app.log` — Application logs
- Encryption keys stored with mode 600

### Security

- AES-256-GCM encryption for passwords (`src/main/encryption.ts`) and backup files (`src/main/fileEncryption.ts`)
- Electron context isolation enabled
- Config sanitization in `src/main/configHelper.ts`

## Conventions

- When adding new IPC channels: register handler in the appropriate `src/main/ipc/` file, then call via `window.electron.ipcRenderer.invoke()` in the renderer
- All user-facing strings must go through the i18n system — add keys to both `en` and `fr` in `src/renderer/src/i18n.ts`
- Types for database, backup, log, and task entities live in `src/renderer/src/types.ts` and `src/types/config.d.ts`
