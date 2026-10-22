# Configuration

## Data folder

bbdump keeps its data in the app data folder, written `<data dir>` below:

- macOS: `~/Library/Application Support/bbdump`
- Linux: `~/.config/bbdump`

| Path | Contents |
|------|----------|
| `config.json` | Databases, projects and settings. Passwords are encrypted, never stored in clear (see [Encryption & Security](encryption-and-security.md)). |
| `config.json.bak` | The previous version of `config.json` |
| `.encryption.key` | AES-256 key, generated on first launch (mode 600) |
| `backup-history.json` | Backup runs, successes and failures (Tasks tab) |
| `ai-masking.json` | Columns anonymized for AI assistants, per database |
| `ai-journal/` | Changes made by AI assistants, with their undo data (encrypted) |
| `ai-chat-history/` | Conversations of the database chat, per database (encrypted) |
| `dashboards/` | Dashboards and their conversation with the AI, per database, and their kept results (encrypted) |
| `cloud-credentials.json` | Neon API key (encrypted, mode 600) |
| `ssh-tunnels.json` | SSH tunnels opened by bbdump, so the ones left by a crash are closed at the next launch |
| `.mcp-confirm-port` | Port and per-launch token of the local server the MCP server talks to (mode 600) |
| `logs/app.log` | Application logs, rotated at 5 MB (`app.log.1` to `app.log.3`) |
| `backups/` | Internal backup folder (the default one on macOS) |

`config.json` is written atomically: a temporary file is written, then renamed, and the previous version is kept as `config.json.bak`. If `config.json` cannot be read at launch, it is set aside as `config.json.corrupt-<timestamp>` and the `.bak` is used instead.

You do not need to edit these files: everything is set from the app.

> In development (`npm run dev`), these files are written in the repository folder instead.

## Settings

Open **Settings** in the sidebar.

### General

| Setting | Description | Default |
|---------|-------------|---------|
| **Language** | English or French | Your system language (French if it is French, English otherwise) |
| **Appearance** | Light, Dark or System | System |
| **Launch at login** | bbdump starts hidden in the menu bar so scheduled backups run; the ones missed while it was closed are caught up at startup | Off |
| **Introduction** | Replays the first-launch setup, with the check of this computer | |

On Linux, **Launch at login** writes `~/.config/autostart/bbdump.desktop`.

### Usage mode

- **PostgreSQL on this computer**: local server features (create, duplicate, restore into a new local database, extensions, server settings), plus remote databases. The status of the local server is shown here.
- **Remote databases only**: bbdump only uses the client tools (`pg_dump`, `psql`) to reach your servers; local server features are hidden.

Switching to remote never uninstalls anything: PostgreSQL and your local databases stay. **Add a local server…** goes back through the machine check.

### Backups

**Default backup folder**: where new databases save their backups. By default `<data dir>/backups` on macOS and `~/Documents/bbdump` on Linux. Each database can use its own folder (its settings → Backup).

### Security

| Setting | Description | Default |
|---------|-------------|---------|
| **Encryption key** | **Export Key** saves it to a file; **Import Key** replaces it with one from a file | |
| **Write queries in the SQL editor** | Allows UPDATE, DELETE, INSERT, DROP… in the SQL editor, each after a confirmation | Off |

See [Encryption & Security](encryption-and-security.md).

### AI assistants (MCP)

- One-click connection for each supported client: Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Devin desktop, VS Code, OpenCode.
- **Let assistants change data without asking**: off by default, so each change waits for your approval. Even when on, changes stay in the AI journal and can be undone.
- **Another client: configuration to copy**: a ready-made snippet for any other MCP client. It runs on bbdump's own binary, no Node.js needed.

See [MCP Server](mcp-server.md).

### Local PostgreSQL

Local mode only: the local server's status and settings.

## PostgreSQL client tools

bbdump needs `pg_dump`, `pg_restore` and `psql`. It looks for them in your `PATH` and in the Homebrew folders (`/opt/homebrew/bin`, `/usr/local/bin`), and uses the `pg_dump` that matches each server's major version (or the closest newer one) when several are installed.

```bash
# macOS
brew install libpq            # client tools only
brew install postgresql@17    # server + client tools

# Debian/Ubuntu
sudo apt install postgresql-client
```

If they are missing, the machine check (first launch, or **Settings → General → Introduction**) says which ones and can install them.

## Connection URLs

A database can be added by pasting a standard PostgreSQL URL:

```
postgresql://[user[:password]@]host[:port][/database][?parameter=value]
```

```
postgresql://myuser:secret@db.example.com:5432/mydb?sslmode=require
postgresql://myuser@localhost/mydb
```

The fields are read from the URL, including `sslmode` and `sslrootcert`. The password is taken out of the URL and stored encrypted in its own field; the URL is saved without it.

Supabase, Neon, Railway and Render URLs are recognized: bbdump turns SSL on when the host requires it, and warns about pooled connections that break `pg_dump` (Supabase transaction pooler on port 6543, Neon `-pooler` endpoints).

## Hiding names when sharing your screen

The **Mask** button next to a project's name hides the project's name, and the names and SSH hosts of its databases, in the interface.
