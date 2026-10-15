# Roadmap

What bbdump already does, what comes next, and ideas still being discussed. Plans can change; the [changelog](../CHANGELOG.md) has the details of each release.

## Done

### 1.1 (October 2026)

- **Remote databases**: connection URL with SSL modes and CA certificates, databases on a server **via SSH** (bbdump opens the tunnel), cloud guides for Supabase, Neon, Railway and Render, Neon account by API key.
- **Client tools only**: remote databases work without a local PostgreSQL server ("remote databases only" mode).
- **Verified backups**: each dump is read back; retention of the last N backups; the right `pg_dump` for the server's version.
- **Restores that really replace the content**, in one transaction, with a backup of the target first.
- **Scheduling that survives restarts**: launch at login (hidden), catch-up of missed backups, a notification when one fails.
- **Update from…**: bring a local copy up to date with another database of its project (schema and missing rows, optionally anonymized).
- **Explorer**: tables in tabs, every schema, row duplication, extension catalog with package install on the local server.
- **AI assistants**: one-click setup for Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Devin, VS Code and OpenCode; 45 tools and 4 prompts; **AI journal** with undo of every change.
- New onboarding, and pages redone (home, tasks, backups, logs, settings).

### 1.1.2

- **bbdump updates itself on macOS**: download, checksum check, install and restart, from the app.

### 1.2

- **Anonymized duplicates**: copy a database with its personal data anonymized; the real values never reach your machine.
- **Anonymization for AI**: chosen columns reach AI assistants anonymized, and results of unknown origin are shown to you first.
- **What's new** tours after each update, all kept on the Info page.

### 1.2.1

- Duplicating a database **checks its extensions first**: a missing one (e.g. PostGIS) is named, with an install button when possible, and the tables not copied are listed.

## Next: Windows (beta) in 1.3

- **Both usage modes**: remote databases only, or a local PostgreSQL server that bbdump installs with winget (a Windows service) or that was already there.
- Windows installer (x64 and ARM64) and automatic updates. The app will not be code-signed at first, so Windows may show a SmartScreen warning.
- `pg_dump` and `psql` found in the usual PostgreSQL install folders; SSH through Windows' OpenSSH.
- Notification area icon, and launch hidden at login.

## Later

- **Remote backup destination** (S3-compatible storage): postponed to a later version.
- **macOS code signing**: blocked for now (no Apple Developer account yet). Until then, the first launch needs right-click → Open, and bbdump updates itself without the macOS updater.
- Other languages than English and French: not planned for now.

## Ideas being discussed

Not commitments: directions to discuss before planning.

### bbdump self-hosted in Docker (Umbrel, CasaOS, Unraid, NAS)

Run bbdump as a container on a home server or NAS, used from a browser, to back up the PostgreSQL databases of other services around the clock. It would be "remote databases only", and needs a server mode, an HTTP API for the same interface, authentication, and a Docker image with several `pg_dump` versions.

Open questions: arm64 and x64 images, which PostgreSQL client versions to ship, notifications (email, webhook, ntfy/Gotify), single or multiple users.

### Docker as a local PostgreSQL engine

A third usage mode in the desktop app, where bbdump creates and drives PostgreSQL containers instead of using a PostgreSQL installed on the system: several versions side by side, no system install, disposable databases to test that a backup restores. It requires Docker Desktop to be installed and running.
