# Quick Start

From the first launch to your first backup and restore. If bbdump is not installed yet, see [Installation](installation.md).

![Dashboard](../captures/dashboard.webp)

## 1. Go through the setup

On first launch, bbdump asks a few questions:

1. **How will you use bbdump?**
   - *PostgreSQL on this computer*: bbdump installs or uses a local server, so you can create, duplicate and restore databases here. Remote databases work too.
   - *Remote databases only*: only the client tools (`pg_dump`, `psql`), no server. The local server features are hidden.
2. **Check this machine**: the client tools are required; in local mode the server too. Install what is missing from there, or continue and re-check later.
3. **Your data**: in local mode, pick the databases found on the server; in remote mode, paste a connection URL (optional). Then choose the default backup folder: a synced folder (iCloud, Dropbox, Nextcloud) keeps a copy off this computer.
4. **AI assistants** (optional): connect Claude Desktop, Claude Code, Cursor and others to bbdump's MCP server.

Everything can be changed later in **Settings**, and the setup can be replayed from **Settings → General → Introduction**.

## 2. Add a database

Open the **DB** tab.

![Databases](../captures/databases.webp)

### A remote database

Click **Add External Connection** and pick a method:

- **Connection URL**: paste `postgresql://user:password@host:5432/database`. The fields are read from it, and Supabase, Neon, Railway and Render URLs are recognized (SSL is turned on when the host requires it). **Where do I find the URL?** opens a guide per host; with a Neon API key you can pick the project, branch and database from a list.
- **Manual entry**: host, port, user, password and SSL mode.
- **SSH** (database on a server you reach over SSH): pick a host from your `~/.ssh/config`. bbdump opens the tunnel itself and can read the credentials from a `.env` file on the server.

Test the connection, then choose where and how this database is backed up: folder, number of backups to keep, encryption, verification, and an optional schedule.

![Add a remote database](../captures/add-connection.webp)

### A local database (local mode)

Click **Create Local DB**, give it a name and create it on your local server. Any database can also be copied into a new local one with **Duplicate** in its card menu, with its personal data anonymized if you want.

### Group them in projects

**New Project** groups databases (e.g. local copy, staging, production) and gives the project its own [proxy](proxy-server.md). Drag databases between projects, or assign them later.

## 3. Back up

Click **Backup** on the database card. bbdump runs `pg_dump` with the version that matches the server, reads the dump back to check it (on by default), encrypts it if asked, and keeps only the last N backups if you set a limit. Progress shows in the app, details in the **Logs** tab, and the file in the **Backups** tab.

![Backups](../captures/backups.webp)

## 4. Restore

In the **Backups** tab, click **Restore** on a backup and choose the target:

- **Existing Database**: its content is replaced. The schemas in the backup are emptied first, in one transaction, and the target is backed up before (on by default), so you can go back. You continue after a 5-second countdown, then type the database name to confirm.
- **New Database** (local mode): a new local database is created and the backup restored into it.

![Restore](../captures/restore.webp)

## 5. Schedule backups

Turn on **Back up automatically** in a database's settings, or from the **Tasks** tab, and pick a frequency with the visual cron editor. The **Tasks** tab shows the next run, the last runs and their result.

Scheduled backups run while bbdump is open. Turn on **Launch at login** (Settings → General, or the button in the Tasks tab): bbdump then starts hidden in the menu bar, and backups missed while it was closed run at startup.

![Scheduled tasks](../captures/tasks.webp)

## Next steps

- [Projects & Databases](projects-and-databases.md): projects, duplication, anonymized copies, **Update from…**
- [Backup & Restore](backup-and-restore.md): backup options, encryption, retention, restores
- [Database Viewer](database-viewer.md): browse and edit data, schema graph, SQL builder, extensions
- [Scheduled Tasks](scheduled-tasks.md): schedules and catch-up
- [MCP Server](mcp-server.md): connect your AI assistants, approvals, AI journal, anonymization for AI
- [Configuration](configuration.md) and [Encryption & Security](encryption-and-security.md)
