<p align="center">
  <img src="logo.png" alt="bbdump logo" width="120">
</p>

<h1 align="center">bbdump</h1>

<p align="center">
  A desktop app for your PostgreSQL databases, local or remote —<br>
  verified backups, real restores, anonymized copies, a data explorer, a chat with your data, and AI assistants that stay in your control.<br>
  macOS and Linux, Windows in beta.
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

Duplicate a database with its personal data anonymized. Columns that look personal (email, phone, name, address, IP…) are chosen for you and partly starred by default, keeping their shape (`bob1234@email.fr` → `****234@email.fr`). Each column can become a realistic fake (first and last names, emails, cities and addresses picked from word lists: `Camille Martin`, `camille.martin.3f2a@example.com`), a masked value or NULL. Numbers and dates can get noise (±10 %, dates ±30 days) or dates be rounded to the month or year; a birth date keeps only its year by default. A table can be copied without its rows (sessions and tokens are empty by default). A column linked by a foreign key follows the one it points to, and unique columns stay unique.

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

### Chat with a database

Ask a database a question in plain words: the **AI chat** button on its card opens a conversation with the AI tool already on your computer (Claude Code, Codex or OpenCode, with your own account) or a local model (Ollama, LM Studio). The AI only reads, through bbdump's MCP server limited to that database. Answers come as key figures, charts and tables with the SQL behind them, and each step the AI took can be unfolded.

- Columns anonymized for AI stay anonymized. A result that could hide personal data is shown to you in the chat first, column by column, with what the AI would see.
- Conversations are kept per database, encrypted, for 30 days (pinned ones for good). The history can be turned off.

More in [Database Chat](docs/database-chat.md).

![Chat with a database](captures/chat.webp)

### AI assistants (MCP)

bbdump comes with a PostgreSQL MCP server and connects it in one click to Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Devin, VS Code or OpenCode (any other MCP client can use the configuration to copy). 45 tools and 4 prompts: the whole schema in one call, data profiling, query plans, health checks, index advice with hypothetical indexes, slow queries, comparisons between databases, and more.

- **Every change asks you first**, in the menu bar. It is recorded in a journal, with the rows before and after, and can be undone in one click.
- **Anonymize for AI**, per database: chosen columns reach the assistant anonymized. A computed result that could come from an anonymized column (a computed column, a view, free SQL) is shown to you first, with a few values: send it, anonymize more, or block it. The database itself is never changed.

![AI assistants](captures/ai-clients.webp)

![Anonymize for AI](captures/ai-anonymize.webp)

### Proxy per project

A TCP proxy per project gives your app one fixed address and routes it to the database of your choice: switch from the local copy to another one without touching your app's configuration.

### Logs

Live application logs, filtered by level and database: every backup, restore and AI change is there.

![Logs](captures/logs.webp)

### Menu bar

Your projects and databases from the menu bar (the notification area on Windows): switch the proxy target, open a database in the explorer, see your backups at a glance. AI changes and anonymization choices are confirmed there too.

<p>
  <img src="captures/tray.webp" alt="Menu bar" width="300">
</p>

### Updates

bbdump updates itself on macOS (from 1.1.2), on Windows, and as an AppImage on Linux. After an update, a short tour shows what is new; the About page keeps every tour.

## Installation

### Quick install (macOS and Linux)

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

**Windows (beta):** remote databases, and a local PostgreSQL that bbdump installs with winget (or one already there), extensions included. The PostgreSQL client tools install in one click from the app — see [installation](docs/installation.md#windows-beta). The installer is not signed yet: on "Windows protected your PC", choose **More info → Run anyway**.

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
npm run dist:win       # Windows: NSIS installer, x64 and ARM64 (on Windows, or the release workflow)
```

## Configuration

User data lives in `~/Library/Application Support/bbdump/` (macOS), `~/.config/bbdump/` (Linux) or `%APPDATA%\bbdump\` (Windows):

| File | Contents |
|------|----------|
| `config.json` | Databases, projects and settings (passwords encrypted) |
| `.encryption.key` | AES-256 key, generated on first launch (mode 600) |
| `backup-history.json` | Backup runs, successes and failures |
| `ai-masking.json` | Columns anonymized for AI assistants, per database |
| `ai-journal/` | Changes made by AI assistants, with their undo data (encrypted) |
| `ai-chat-history/` | Database chat conversations (encrypted, 30 days unless pinned) |
| `cloud-credentials.json` | Neon API key (encrypted) |
| `local-server.json` | Windows: password of the local server's `postgres` user (encrypted) |
| `logs/app.log` | Application logs |

Databases can be added from the UI or by pasting a connection URL:

```
postgresql://user:password@host:port/database
```

## Security

- Passwords, backups (optional), the Neon API key, the AI journal and the chat history are encrypted with AES-256-GCM; the key is generated on first launch with restricted permissions and can be exported for another machine.
- No telemetry: bbdump sends nothing about you or your databases.
- The MCP server talks to the app through a local server (127.0.0.1) protected by a per-launch token; every change asks for your confirmation.
- Anonymized copies never bring the real values to your machine, and anonymization for AI filters what assistants read without touching the data.
- The database chat only reads, through bbdump's MCP server limited to that database; the AI tool gets none of its own shell, file or web tools.
- Electron context isolation and a strict list of IPC channels.

## Contributing

Contributions are welcome. Please open an issue first to discuss what you would like to change.

## License

[MIT](./LICENSE) — Copyright (c) 2024-2026 Poups
