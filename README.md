<p align="center">
  <img src="logo.png" alt="bbdump logo" width="120">
</p>

<h1 align="center">bbdump</h1>

<p align="center">
  A desktop application for managing PostgreSQL databases —<br>
  backups, restores, scheduling, encryption, data browsing, and more.
</p>

<p align="center">
  <a href="https://poups.dev/bbdump">Website</a> &middot;
  <a href="https://github.com/poup-s/bbdump/releases">Download</a> &middot;
  <a href="https://github.com/poup-s/bbdump/issues">Report a bug</a>
</p>

![Dashboard](captures/dashboard.png)

## Features

### Project & Database Management

Organize your databases into color-coded projects. Add local or external connections, duplicate databases across servers, and manage everything from a single view.

![Databases](captures/databases.png)

### Backup & Restore

Manual and scheduled backups using `pg_dump`/`pg_restore`. Supports custom format, plain SQL, compression, and AES-256-GCM encryption.

![Backups](captures/backups.png)

### Database Viewer

Browse tables, inspect data, search across columns, and inspect row details.

![Viewer](captures/viewer-data.png)

![Search](captures/viewer-search.png)

Click any row to open the detail panel. Edit fields inline — modified values are highlighted, save or discard with one click.

![Row Detail](captures/viewer-row.png)
![Edit Row](captures/viewer-edit-row.png)

### Schema Visualizer

Interactive graph of your database schema — tables, columns, and foreign key relationships rendered with Vue Flow.

![Schema](captures/viewer-schema.png)

### SQL Builder

Visual query builder with SELECT, FROM, WHERE, JOIN, and LIMIT clauses. Build queries visually or switch to raw SQL mode.

![SQL](captures/viewer-sql.png)
![SQL with results](captures/viewer-sql-2.png)
![SQL raw mode](captures/viewer-sql-3.png)

### Proxy Server

Built-in TCP proxy per project to route local connections to any configured database. Switch targets instantly without changing your app config.

![Proxy](captures/proxy.png)

### Scheduled Tasks

Visual cron editor with presets and per-database controls. Automate backups, vacuum, reindex, and health checks.

![Tasks](captures/tasks.png)

### Logs

Real-time application logs with level and database filtering. Track every backup, restore, and operation.

![Logs](captures/logs.png)

### MCP Server (Claude Desktop)

bbdump includes a built-in PostgreSQL MCP server that connects Claude to your databases. Install it in one click from Settings — Claude can then explore schemas, read data, run queries, and execute mutations with confirmation prompts. 31 tools exposed including schema inspection, full-text search, query explain, and more.

### System Tray

Quick access to your projects and databases from the menu bar. Trigger backups and monitor status without opening the full app.

<p>
  <img src="captures/mini-app.png" alt="Tray" width="280">
  <img src="captures/mini-app-proxy.png" alt="Tray with proxy" width="280">
</p>

## Installation

### Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash
```

Detects your platform, downloads the latest release, installs PostgreSQL if needed, and sets everything up. See [full installation docs](docs/installation.md) for options.

### From Release

Download the latest release from [GitHub Releases](https://github.com/poup-s/bbdump/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `bbdump-*-arm64.dmg` |
| macOS (Intel) | `bbdump-*.dmg` |
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
