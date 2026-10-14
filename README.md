<p align="center">
  <img src="logo.png" alt="bbdump logo" width="120">
</p>

<h1 align="center">bbdump</h1>

<p align="center">
  A desktop app for your PostgreSQL databases, local or remote —<br>
  verified backups, real restores, anonymized copies, a data explorer, and AI assistants that stay in your control.
</p>

<p align="center">
  <a href="https://poups.dev/bbdump">Website</a> &middot;
  <a href="https://github.com/poup-s/bbdump/releases">Download</a> &middot;
  <a href="https://github.com/poup-s/bbdump/issues">Report a bug</a>
</p>

![Dashboard](captures/dashboard.webp)

## Features

### Projects and databases, wherever they are

Group your databases into projects: a local database, its dev copy and production side by side. bbdump can install and run PostgreSQL on your machine, and reaches remote databases in several ways:

- **Connection URL** or manual entry, with SSL modes and certificates;
- **Server via SSH**: pick the host from your `~/.ssh/config`, bbdump opens the tunnel itself and can find the credentials in the server's `.env`;
- **Cloud guides** for Supabase, Neon, Railway and Render — with a Neon API key, pick the project, branch and database from a list.

Any database can be duplicated into a new local one in one click.

![Databases](captures/databases.webp)

![Add a remote database](captures/add-connection.webp)

### Anonymized copies

Duplicate a database with its personal data anonymized. Columns that look personal (email, phone, name, address, IP…) are chosen for you and partly starred by default, keeping their shape (`bob1234@email.fr` → `****234@email.fr`). Each column can become a fake value, a masked one or NULL, and a table can be copied without its rows (sessions and tokens are empty by default). A column linked by a foreign key follows the one it points to, and unique columns stay unique.

The rows are streamed with the chosen columns already replaced: the real values never reach your machine, and no backup of the source is kept.

![Anonymize while duplicating](captures/anonymize.webp)

### Update a local copy from production

**Update from…** compares a local database with another one of its project, production included, and copies only what it lacks: schema additions, then the missing rows, optionally anonymized. The source is only read; you see the SQL before anything runs, and the local database is backed up first.

![Update from another database](captures/sync.webp)

### Backups you can count on

`pg_dump` backups, compressed and optionally encrypted (AES-256-GCM). Each backup is read back to check it, only the last N are kept, and the right `pg_dump` is picked for the server's version.

Schedule them per database with a visual cron editor. bbdump starts hidden at login, and the backups missed while it was closed run at launch.

![Backups](captures/backups.webp)

![Scheduled tasks](captures/tasks.webp)

### Restores that really replace the content

Restoring replaces the database's content: the schemas in the backup are emptied first, in one transaction, so nothing is half done. The target is backed up before, so you can always go back.

![Restore](captures/restore.webp)

### Database explorer

Browse tables in tabs, search, open a row to edit it, follow the relations, and see every schema in an interactive graph. Build queries visually or in SQL, check performance, and enable extensions from a catalog (pgvector, PostGIS, TimescaleDB…) — bbdump installs their packages on the local server when needed.

![Data](captures/viewer-data.webp)

![Row detail](captures/viewer-row.webp)

![Schema](captures/viewer-schema.webp)

![SQL builder](captures/viewer-sql.webp)

![Extensions](captures/extensions.webp)

### AI assistants (MCP)

bbdump comes with a PostgreSQL MCP server and connects it in one click to Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Devin, VS Code or OpenCode (any other MCP client can use the configuration to copy). 45 tools and 4 prompts: the whole schema in one call, data profiling, query plans, health checks, index advice with hypothetical indexes, slow queries, comparisons between databases, and more.

- **Every change asks you first**, in the menu bar. It is recorded in a journal, with the rows before and after, and can be undone in one click.
- **Anonymize for AI**, per database: chosen columns reach the assistant anonymized. A result whose origin is unknown (a computed column, a view, free SQL) is shown to you first, with a few values: send it, anonymize more, or block it. The database itself is never changed.

![AI assistants](captures/ai-clients.webp)

![Anonymize for AI](captures/ai-anonymize.webp)

### Proxy per project

A TCP proxy per project gives your app one fixed address and routes it to the database of your choice: switch from the local copy to another one without touching your app's configuration.

### Logs

Live application logs, filtered by level and database: every backup, restore and AI change is there.

![Logs](captures/logs.webp)

### Menu bar

Your projects and databases from the menu bar: switch the proxy target, open a database in the explorer, see your backups at a glance. AI changes and anonymization choices are confirmed there too.

<p>
  <img src="captures/tray.webp" alt="Menu bar" width="300">
</p>

### Updates

bbdump updates itself on macOS (from 1.1.2) and as an AppImage on Linux. After an update, a short tour shows what is new; the About page keeps every tour.

## Installation

### Quick install

```bash
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash
```

Detects your platform, downloads the latest release, installs PostgreSQL if needed, and sets everything up. If bbdump is running, it is closed and reopened on the new version. See [the installation docs](docs/installation.md) for options.

### From a release

Download the latest release from [GitHub Releases](https://github.com/poup-s/bbdump/releases):

| Platform | File |
|----------|------|
| macOS 13+ (Apple Silicon) | `bbdump-*-arm64.dmg` |
| macOS 13+ (Intel) | `bbdump-*.dmg` |
| Linux (beta) | `bbdump-*.AppImage` or `bbdump-*.deb` |
| Windows 10/11 (beta) | `bbdump-*-setup.exe` (x64 and ARM64) |

**macOS:** the app is not code-signed yet. On first launch, right-click it and choose **Open**, then confirm, or run:

```bash
xattr -cr /Applications/bbdump.app
```

**Windows (beta):** remote databases and a PostgreSQL already running on the computer; bbdump does not install a local server there. The installer is not signed yet: on "Windows protected your PC", choose **More info → Run anyway**. Backups need the PostgreSQL client tools — see [installation](docs/installation.md#postgresql-client-tools).

Later versions install themselves from the app. The `.deb` package does not update itself: install the new one.

### From source

```bash
git clone https://github.com/poup-s/bbdump.git
cd bbdump
npm install
npm run dev
```

**Prerequisites:** Node.js 22.12+, PostgreSQL client tools (`pg_dump`, `psql`).

## Demo database

Want to try bbdump right away? A script creates a PostgreSQL database with the 36,000+ French towns and registers it in bbdump:

```bash
./bbdump-demo/bbdump-demo.sh
```

See [bbdump-demo/README.md](bbdump-demo/README.md) for details.

## Building

```bash
npm run build          # TypeScript + Vite
npm test               # tests (no database or network needed)
npm run dist:mac       # macOS: DMG + ZIP, Apple Silicon and Intel
npm run dist:linux     # Linux: AppImage + deb
```

## Configuration

User data lives in `~/Library/Application Support/bbdump/` (macOS) or `~/.config/bbdump/` (Linux):

| File | Contents |
|------|----------|
| `config.json` | Databases, projects and settings (passwords encrypted) |
| `.encryption.key` | AES-256 key, generated on first launch (mode 600) |
| `backup-history.json` | Backup runs, successes and failures |
| `ai-masking.json` | Columns anonymized for AI assistants, per database |
| `ai-journal/` | Changes made by AI assistants, with their undo data (encrypted) |
| `cloud-credentials.json` | Neon API key (encrypted) |
| `logs/app.log` | Application logs |

Databases can be added from the UI or by pasting a connection URL:

```
postgresql://user:password@host:port/database
```

## Security

- Passwords, backups (optional), the Neon API key and the AI journal are encrypted with AES-256-GCM; the key is generated on first launch with restricted permissions and can be exported for another machine.
- No telemetry: bbdump sends nothing about you or your databases.
- The MCP server talks to the app through a local server (127.0.0.1) protected by a per-launch token; every change asks for your confirmation.
- Anonymized copies never bring the real values to your machine, and anonymization for AI filters what assistants read without touching the data.
- Electron context isolation and a strict list of IPC channels.

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

## License

[MIT](./LICENSE) — Copyright (c) 2024-2026 Poups
