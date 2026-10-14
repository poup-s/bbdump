# Projects and databases

The **Databases** page lists your databases, grouped into projects: a local database, its dev copy and production side by side.

![Databases](../captures/databases.webp)

## Projects

A project groups the databases of one app and gives them a shared [proxy](proxy-server.md).

**New Project** opens the project dialog:

- **Name**
- **Color**: a preset or a custom color
- **Databases**: a database belongs to one project only; checking one that is in another project moves it here.

Each project header has:

| Action | What it does |
|--------|--------------|
| **Mask** / **Unmask** | Hides the names of the project's databases, e.g. while sharing your screen |
| **Proxy** | Turns the project's TCP proxy on or off and picks its target (see [Proxy Server](proxy-server.md)) |
| **Add DB** | Creates a local database in this project (not shown in remote-only mode) |
| **Edit** | Name, color and databases. The proxy settings are kept |
| **Delete** | Removes the project. Its databases are not deleted: they move to **Ungrouped** |

Databases can be dragged within a project, from one project to another, or out of the ungrouped list. Databases that belong to no project are listed under **Ungrouped**.

## Usage mode

**Settings → Usage mode** has two modes:

- **PostgreSQL on this computer**: local server features (create, duplicate, restore into a new database, extensions, "Update from…"). Remote databases work too.
- **Remote databases only**: bbdump only uses the PostgreSQL client tools (`pg_dump`, `psql`, `pg_restore`) to reach your servers, and hides the local server features.

Switching to remote-only installs or removes nothing: PostgreSQL and your local databases stay where they are, and the local server can be added back at any time.

## Local databases

**Create Local DB** (or **Add DB** in a project header) creates a database on this computer's PostgreSQL server and adds it to bbdump:

| Field | Description |
|-------|-------------|
| Database name | Letters, numbers and underscores, starting with a letter |
| Display name | Optional, shown in the app |
| Project | Optional |
| Password | Advanced setting. Empty: local authentication (peer/ident) |
| Port | Advanced setting. Checked for availability |

PostgreSQL is installed and started first if needed. Automatic backups are off for a new local database: turn them on in its settings.

## Remote databases

**Add External Connection** opens a three-step dialog: **Method**, **Connection**, **Backup**.

![Add a remote database](../captures/add-connection.webp)

The methods:

- **Connection URL**: one line from your host.
- **Manual entry**: host, port, user and password.
- **Server via SSH**: PostgreSQL on a server you reach with `ssh`.
- **Where do I find the URL?**: guides for Supabase, Neon, Railway and Render.

**Test connection** shows the PostgreSQL version and the number of tables. Passwords are always stored encrypted (see [Encryption & Security](encryption-and-security.md)).

### Connection URL

```
postgresql://user:password@host:5432/database?sslmode=require
```

Paste the URL (the **Paste** button reads the clipboard). bbdump shows what it read: host, port, user, database and SSL mode.

- The host is recognized for Supabase, Neon, Railway, Render, AWS RDS and Scaleway. For these, SSL is turned on when the URL does not set it.
- A URL that still holds a password placeholder (`[YOUR-PASSWORD]`) is flagged.
- **Supabase transaction pooler** (port 6543) and **Neon pooled connections** (`-pooler`) break `pg_dump`: bbdump says so and offers the session pooler (5432) or the direct endpoint in one click.
- Parameters the PostgreSQL tools do not know (Prisma's `schema`, `pgbouncer`, `connection_limit`…) are not passed to them. The saved URL is unchanged.

When editing a database saved from a URL, a URL without a password keeps the saved one.

### Manual entry and SSL

Manual entry asks for the database name, an optional display name, host, port, user and password. The database name is fixed once saved: add a new connection for another database.

SSL modes:

| Mode | Meaning |
|------|---------|
| `disable` | No encryption |
| `prefer` | Encrypt if the server supports it |
| `require` | Always encrypt, certificate not checked (Neon, Supabase…) |
| `verify-ca` | Encrypt and verify the certificate authority |
| `verify-full` | Encrypt, verify the authority and the host name (recommended for AWS RDS) |

A **CA certificate (root cert)** file (`.pem`, `.crt`, `.cer`) can be chosen for `verify-ca` and `verify-full`. For AWS RDS, download `global-bundle.pem` from AWS and use it with `verify-full`.

### Server via SSH

For PostgreSQL on a server (a VPS) whose port is not exposed. bbdump runs your own `ssh`: your `~/.ssh/config`, keys, agent, `known_hosts` and `ProxyJump` apply as they are, and nothing is copied.

1. **SSH access**: pick the host from your `~/.ssh/config`, or type a host name, user and port.
2. **PostgreSQL as seen from the server**: host and port, usually `localhost` and `5432`.
3. **Credentials**, three ways:
   - **Search the server**: looks in `~`, `/srv`, `/var/www`, `/opt` and `/home` for `.env` files holding a PostgreSQL URL, and lists each file with its variable. Pick one to read it.
   - **Read the server's .env**: type the file path and the variable name (e.g. `DATABASE_URL`).
   - **Paste a URL**: its host is the database as seen from the server.

On the first connection to a server, bbdump shows its fingerprint and asks you to trust it (added to your `known_hosts`, as `ssh` does). A changed fingerprint is refused. The test checks SSH first, then PostgreSQL through the tunnel.

If the URL points to a Docker container name, bbdump reaches it through `localhost` on the server: the container's port must be published (`ports: "127.0.0.1:5432:5432"` in docker-compose).

The tunnel (`ssh -N -L 127.0.0.1:<local port>:<host>:<port>`) is opened by bbdump when the database is used: explorer, backups, restores, duplicates, the project proxy, the MCP server. It is shared by all of them, reopened if it drops, and closed after 10 minutes without use. Tunnels left over by a crash are closed at the next launch.

An SSH database shows an `ssh · host` badge. It has no **Copy connection URL** action, since no other app could use that address: point your app at the project proxy instead.

### Cloud guides

**Where do I find the URL?** shows the steps for each host and a button to open its dashboard:

| Host | Where to find the URL |
|------|-----------------------|
| **Supabase** | **Connect** → **Session pooler** URI (the direct connection only works over IPv6). Replace `[YOUR-PASSWORD]` |
| **Neon** | **Connect** on the project dashboard, connection pooling off. Or use an API key, below |
| **Railway** | Postgres service → **Variables** → `DATABASE_PUBLIC_URL` (`DATABASE_URL` only works inside Railway) |
| **Render** | Database → **Connections** → **External Database URL** |

**Neon with an API key**: create a key in Neon (**Account settings → API keys**) and paste it. bbdump lists your projects, branches and databases: pick one and its connection URL is filled in. The key is kept encrypted on this computer (`cloud-credentials.json`), only used to read your projects and their connection details, and removed with **Forget the key**.

### Backup and schedule

The last step sets where and how the database is backed up: backup folder, number of backups to keep, encryption, verification, and automatic backups with their schedule. See [Backup & Restore](backup-and-restore.md) and [Scheduled Tasks](scheduled-tasks.md). The same settings are in the **Backup** and **Schedule** sections when editing.

## Database card

Each database shows:

- a dot: green when automatic backups are on, gray when off;
- a badge: `local` (created on the local server by bbdump), `external`, or `ssh · host`;
- `proxy` when the project proxy routes to it, **AI anonymized** when [anonymization for AI](mcp-server.md) is on;
- its size.

**Backup** (after a confirmation) and **View** (the [explorer](database-viewer.md)) are on the card. The **⋯** menu has the rest:

| Action | Description |
|--------|-------------|
| **Copy connection URL** | Not for SSH databases |
| **Duplicate** | Copy into a new local database (below) |
| **Edit** | Connection, Backup and Schedule sections |
| **Extensions** | Local databases only (below) |
| **Update from…** | Local databases in a project with other databases (below) |
| **AI journal** | Changes made by AI assistants and their undo (see [MCP Server](mcp-server.md)) |
| **Anonymize for AI** | Columns AI assistants only see anonymized (see [MCP Server](mcp-server.md)) |
| **Set as proxy target** | When the project proxy is on and routes elsewhere |
| **Delete** / **Disconnect** | A local database is dropped from the server. A remote one is only removed from bbdump and stays on its server |

## Duplicate to local

**Duplicate** copies any database, local or remote, into a new database on the local server. Choose its name, and optionally a password and port. The copy goes into the same project as its source.

Before copying, bbdump compares the source's extensions with the local server's. A missing one (e.g. PostGIS) is named, because what depends on it (types, columns, tables) could not be copied:

- **Install** installs it when bbdump can (Homebrew on macOS; apt or dnf on Linux, which asks for your system password);
- otherwise the command to run is shown, or a note when the extension only exists at that host.

A plain duplicate makes a backup of the source (it counts as a normal backup of the source, with its retention and history), creates the local database and restores the backup into it. If something could not be copied, the warnings name the missing extensions and the tables left out.

Turn on **Anonymize personal data** to copy the database with its personal data replaced. No backup of the source is made then. See [Anonymization](anonymization.md).

## Update from…

**Update from…** brings a local database up to date with another database of its project, production included. It is offered for databases on the local server whose project has at least one other database.

![Update from another database](../captures/sync.webp)

1. **Analysis**: bbdump compares the two databases. The source is only read, in one read-only snapshot.
2. **Choices**: the schema additions (changes that would lose local data are listed but left unchecked), then the tables with rows missing locally (only tables with a primary key; tables over a million rows are left out by default; a table with a date column can be limited to the last 30 or 7 days), and the columns to anonymize.
3. **Preview**: the SQL to run. **Back up … before applying** is on by default.
4. **Apply**: extensions and enum values first, then the schema changes in one transaction, then the rows, parents first. Rows already in the local database are kept as they are; rows whose parent is missing locally are skipped.

The source used last time is remembered. Anonymization while updating is described in [Anonymization](anonymization.md#anonymization-in-update-from).

## Extensions

**Extensions** in the ⋯ menu of a local database lists about 90 extensions by category (pgvector, PostGIS, TimescaleDB…). Those available on the server are enabled or removed in one click. For the others, bbdump installs the package when it can (Homebrew on macOS; apt or dnf on Linux, with a system password prompt), or shows the command to run. Extensions that must be loaded at startup offer a PostgreSQL restart.

![Extensions](../captures/extensions.webp)

## Anonymize for AI

**Anonymize for AI** in the ⋯ menu chooses columns that AI assistants only see anonymized through the MCP server. The data is never changed. Databases where it is on show an **AI anonymized** badge. See [MCP Server](mcp-server.md).
