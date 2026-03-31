# Quick Start

This guide walks you through setting up bbdump for the first time — from creating a project to running your first backup.

## 1. Create a Project

Projects group related databases together (e.g. production, staging, local).

1. Open bbdump and go to the **DB** tab
2. Click **+ New Project**
3. Enter a project name and pick a color
4. Click **Save**

> You can also assign databases to a project later.

## 2. Add a Database

### External Connection

1. Click **+ Add External Connection**
2. Choose your connection method:
   - **URL** — Paste a PostgreSQL connection string: `postgresql://user:password@host:port/database`
   - **Manual** — Fill in host, port, database name, user, and password individually
   - **Presets** — Quick configuration for Supabase or Neon
3. Optionally assign the database to a project
4. Click **Save**

### Local Database

1. Click **+ Create Local DB**
2. Enter a database name (lowercase, no spaces)
3. Optionally assign it to a project
4. Click **Create**

bbdump will create the database on your local PostgreSQL server.

## 3. Run a Backup

1. In the database list, click **Backup** next to the database you want to back up
2. The backup starts immediately using `pg_dump`
3. Progress and logs appear in real time in the **Logs** tab
4. Once complete, the backup file appears in the **Backups** tab

### Backup Options

By default, backups use the PostgreSQL custom format with compression. You can configure per-database:

- **Format** — Custom (`.backup`) or plain SQL (`.sql`)
- **Compression** — Level 0-9
- **Parallel jobs** — Speed up large backups
- **File encryption** — Encrypt the backup file with AES-256-GCM
- **Timeout** — Maximum duration before the backup is cancelled

These options are configured when editing a database connection.

## 4. Restore a Backup

1. Go to the **Backups** tab
2. Click **Restore** next to the backup file
3. Choose your restore target:
   - **Existing database** — Restore into a database already configured in bbdump
   - **New database** — Create a new local database and restore into it
4. Confirm the operation (a 5-second countdown ensures you don't restore by accident)

## 5. Schedule Automatic Backups

1. Go to the **Tasks** tab
2. Click **+** to create a new scheduled task
3. Select the database and choose a schedule:
   - **Presets** — Every hour, daily at 2 AM, weekly, monthly, etc.
   - **Custom** — Enter a cron expression manually
4. The task runs automatically in the background

## Next Steps

- [Projects & Databases](projects-and-databases.md) — Learn about project organization, duplication, and proxy
- [Database Viewer](database-viewer.md) — Browse your data, edit rows, and run SQL queries
- [Scheduled Tasks](scheduled-tasks.md) — Advanced scheduling and retention options
- [MCP Server](mcp-server.md) — Connect Claude to your databases
