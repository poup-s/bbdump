# bbdump — Features

> Modern, cross-platform PostgreSQL manager with automated backups, encryption, and a sleek UI.

---

## Database Management

- **Add databases** — Connect to any PostgreSQL instance via host/port/user/password or connection URL
- **Create local databases** — Spin up new PostgreSQL databases directly from the app
- **Duplicate databases** — Clone a remote database to a local instance (backup + restore)
- **Edit & remove** — Update connection settings or remove databases from the configuration
- **SSL support** — Connect to databases requiring `sslmode=require`
- **Display names** — Assign friendly names for easier identification
- **Hide databases** — Mask database names in the UI (useful when screen-sharing)
- **Auto-discovery** — Detect existing databases on localhost

---

## Backup & Restore

- **One-click backups** — Trigger a manual backup for any configured database
- **Scheduled backups** — Cron-based automation (hourly, daily, weekly, monthly, or custom expression)
- **Backup encryption** — AES-256-GCM file encryption per database
- **Compression** — Configurable pg_dump compression level (0–9)
- **Parallel jobs** — Speed up backups with multiple parallel workers
- **Timeout control** — Per-database backup timeout (default 30 min)
- **Restore to existing DB** — Restore a backup to an existing database with a 5-second safety countdown
- **Restore to new DB** — Auto-create a new database and restore into it
- **Encrypted backup support** — Seamless decrypt + restore for encrypted backups
- **Backup browser** — List, filter, and delete backups organized by database
- **Storage stats** — Track total backup count and disk usage

---

## Database Viewer

- **Browse table data** — Paginated data grid with search and column sorting
- **Inline editing** — Edit cells, add rows, delete rows directly in the UI
- **Foreign key navigation** — Click FK values to jump to the related table
- **CSV export** — Export table data to CSV
- **Schema inspector** — View columns, types, constraints, primary keys, defaults
- **Relationship visualizer** — Interactive graph of table relationships (Vue Flow)
- **SQL query builder** — Visual builder for SELECT / UPDATE / INSERT / DELETE
- **Raw SQL editor** — Execute arbitrary SQL with transaction safety and auto-rollback
- **Query history** — Track previously executed queries
- **Read-only by default** — Mutations require explicit opt-in

---

## Performance Insights

- **pg_stat_statements** — View slowest queries with execution stats (calls, mean time, rows)
- **Query impact analysis** — See the percentage impact of each query
- **Extension manager** — Install / uninstall PostgreSQL extensions from the UI
- **Reset statistics** — Clear performance data to start fresh
- **Auto-config** — Automatically configure PostgreSQL for pg_stat_statements

---

## PostgreSQL Administration

- **Server info** — View PostgreSQL version, data directory, port
- **Database list** — See all databases with owner, encoding, collation, size
- **Active connections** — Inspect PID, user, client address, state, current query
- **Kill connections** — Terminate individual connections
- **Drop databases** — Delete databases with safety guards (protects system DBs)
- **Connection testing** — Test connectivity to any configured database
- **Server restart** — Restart PostgreSQL from the UI

---

## Security

- **Password encryption** — AES-256-GCM encryption for all stored passwords
- **Backup file encryption** — Per-database optional file encryption
- **Encryption key management** — Export / import keys for backup or cross-machine transfer
- **Secure key storage** — Key file with restrictive permissions (mode 600)
- **Auto key generation** — Transparent key creation on first use

---

## Scheduling

- **Cron editor** — Preset templates, visual editor, or raw cron expression
- **Per-database schedules** — Enable / disable / pause each database independently
- **Scheduled tasks view** — Dashboard of all active schedules with last backup timestamp
- **Real-time notifications** — Toast alerts when a scheduled backup completes

---

## MCP Integration (AI Assistants)

- **22 tools** for AI assistants (Claude, Cursor, Windsurf, etc.)
- **Read & write** — List databases, query tables, edit data, manage backups via MCP
- **Mutation confirmations** — Approval popup before any AI-triggered write operation
- **Claude Desktop install** — One-click MCP server registration
- **Custom config** — Copy JSON config for other MCP-compatible tools

---

## System Tray

- **Tray icon** — App runs in the background with a system tray presence
- **Quick access popup** — View and edit databases without opening the full window
- **Context menu** — Open app or quit from the tray

---

## Auto-Updater

- **Update checking** — Manual or automatic check against GitHub Releases
- **Download progress** — Track download percentage in the UI
- **One-click install** — Download and restart to apply updates
- **Release notes** — View what's new before updating

---

## Onboarding

- **Language selection** — Choose English or French
- **Prerequisites check** — Detects pg_dump, psql, PostgreSQL server, Homebrew (macOS)
- **Auto-install** — Install missing tools directly from the onboarding wizard
- **Database discovery** — Import existing local databases
- **Backup path setup** — Configure default backup directory
- **MCP setup** — Optional AI integration setup

---

## Dashboard

- **Stats overview** — Total databases (local vs external), backup count, storage usage
- **System health** — PostgreSQL connection status
- **Recent backups** — Quick glance at latest backup activity
- **3D scene** — Interactive Three.js dashboard background

---

## Settings

- **Language** — Switch between English and French
- **Default backup path** — Global backup directory
- **SQL mutations** — Allow / disallow write queries in the viewer
- **MCP confirmations** — Skip or require approval for AI mutations
- **Encryption key** — Export / import management

---

## Logging

- **Structured logs** — Info, warning, error levels
- **Database filtering** — Filter logs by database
- **Full-text search** — Find specific log entries
- **Copy to clipboard** — Copy individual entries or the full log
- **Clear logs** — Wipe the log history

---

## Cross-Platform

| Platform | Formats |
|----------|---------|
| macOS | DMG (arm64 + x64) |
| Windows | NSIS installer + Portable |
| Linux | AppImage + deb |

**One-line install (macOS & Linux):**

```bash
curl -fsSL https://poups.dev/bbdump/install.sh | bash
```

---

## Internationalization

- English and French
- All UI strings localized
- Pluralization and parameter interpolation support

---

*Built with Electron, Vue 3, Tailwind CSS, and Three.js.*
