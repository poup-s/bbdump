# bbdump

<img src="logo.png" alt="bbdump logo" width="80">

A cross-platform desktop application for managing PostgreSQL databases — backups, restores, scheduling, encryption, data browsing, and more.

Built with Electron, Vue 3, and Tailwind CSS.

![Dashboard](captures/dashboard.png)

## Features

### Project & Database Management

Organize your databases into color-coded projects. Add local or external connections, duplicate databases across servers, and manage everything from a single view.

![Databases](captures/databases.png)

### Backup & Restore

Manual and scheduled backups using `pg_dump`/`pg_restore`. Supports custom format, plain SQL, compression, and AES-256-GCM encryption.

![Backups](captures/backups.png)

### Database Viewer

Browse tables, inspect data, edit rows inline, and search across your database.

![Viewer](captures/viewer-data.png)

### Schema Visualizer

Interactive graph of your database schema — tables, columns, and foreign key relationships rendered with Vue Flow.

![Schema](captures/viewer-schema.png)

### SQL Builder

Visual query builder with SELECT, FROM, WHERE, JOIN, and LIMIT clauses. Write and execute raw SQL queries directly.

![SQL](captures/viewer-sql.png)

### Proxy Server

Built-in TCP proxy per project to route local connections to any configured database. Switch targets instantly without changing your app config.

![Proxy](captures/proxy.png)

### Scheduled Tasks

Visual cron editor with presets and per-database controls. Automate backups, vacuum, reindex, and health checks.

![Tasks](captures/tasks.png)

### System Tray

Quick access to your projects and databases from the menu bar. Trigger backups and monitor status without opening the full app.

<p>
  <img src="captures/mini-app.png" alt="Tray" width="280">
  <img src="captures/mini-app-proxy.png" alt="Tray with proxy" width="280">
</p>

## Installation

### From Release (recommended)

Download the latest release from [GitHub Releases](https://github.com/poup-s/bbdump/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `bbdump-*-arm64.dmg` |
| macOS (Intel) | `bbdump-*.dmg` |
| Windows | `bbdump-*.exe` |
| Linux | `bbdump-*.AppImage` or `bbdump-*.deb` |

**macOS note:** The app is not code-signed. On first launch, right-click the app and select "Open", then confirm. Alternatively:

```bash
xattr -cr /Applications/bbdump.app
```

### From Source

```bash
git clone https://github.com/poup-s/bbdump.git
cd bbdump
npm install
npm run dev
```

**Prerequisites:** Node.js 18+, PostgreSQL client tools (`pg_dump` in PATH).

## Building

```bash
npm run build          # Compile TypeScript + Vite
npm run dist           # Build + package for current platform
npm run dist:mac       # macOS (DMG)
npm run dist:win       # Windows (NSIS + Portable)
npm run dist:linux     # Linux (AppImage + deb)
```

## Configuration

All user data is stored in `~/.bbdump/`:

| File | Description |
|------|-------------|
| `config.json` | Database connections and app settings |
| `logs/app.log` | Application logs |
| `.encryption.key` | AES-256 key (auto-generated, mode 600) |

Databases can be configured through the UI or by pasting a PostgreSQL connection URL:

```
postgresql://user:password@host:port/database
```

## Security

- AES-256-GCM encryption for passwords and backup files
- Encryption key auto-generated on first launch with restricted permissions
- Electron context isolation enabled
- Export/import encryption keys for multi-machine setups

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](./LICENSE) — Copyright (c) 2024-2026 Poups
