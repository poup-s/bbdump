# Projects & Databases

## Projects

Projects are the top-level organizational unit in bbdump. Each project groups related databases and provides shared features like proxy and masking.

### Creating a Project

1. Go to the **DB** tab
2. Click **+ New Project**
3. Configure:
   - **Name** — Project display name
   - **Color** — Choose from presets or pick a custom color
   - **Databases** — Select which databases belong to this project
4. Click **Save**

### Managing Projects

Each project header shows:
- Project name and color indicator
- **Mask** — Hide all credentials for this project (useful for screen sharing)
- **Proxy** toggle — Enable/disable the TCP proxy (see [Proxy Server](proxy-server.md))
- **+ Add DB** — Add a new database to this project
- **Edit** / **Delete** — Modify or remove the project
- **Collapse/Expand** — Show or hide the project's databases

### Drag & Drop

Databases can be reordered within a project or moved between projects by dragging them.

## Databases

### Adding an External Connection

Click **+ Add External Connection** to open the database modal:

**Connection tab:**

| Field | Description |
|-------|-------------|
| Display name | Optional friendly name shown in the UI |
| Host | Server hostname or IP |
| Port | PostgreSQL port (default: 5432) |
| Database | Database name |
| User | PostgreSQL username |
| Password | Password (encrypted at rest with AES-256-GCM) |
| SSL | Enable SSL connection |

**Connection URL:**

You can paste a PostgreSQL URL instead of filling fields manually:

```
postgresql://user:password@host:port/database?sslmode=require
```

bbdump parses the URL and populates all fields automatically.

**Cloud presets:**

Quick configuration templates for:
- **Supabase** — Pre-fills host pattern, port 5432, SSL enabled
- **Neon** — Pre-fills host pattern, port 5432, SSL enabled

**Backup configuration tab:**

| Field | Description | Default |
|-------|-------------|---------|
| Format | `custom` or `plain` | custom |
| Compression | 0 (none) to 9 (max) | 6 |
| Parallel jobs | Number of parallel dump jobs | 1 |
| Timeout | Max backup duration in seconds | 0 (no limit) |
| Encrypt backup | Encrypt the output file | false |

### Creating a Local Database

Click **+ Create Local DB**:

| Field | Description |
|-------|-------------|
| Database name | Lowercase, alphanumeric, underscores only |
| Project | Optional project assignment |

bbdump creates the database on your local PostgreSQL server and adds it to your configuration.

### Database Actions

Each database row provides:

| Action | Description |
|--------|-------------|
| **URL** | Copy the PostgreSQL connection string to clipboard |
| **Backup** | Run an immediate backup |
| **View** | Open the database viewer |
| **Duplicate** | Clone the database to a local copy |
| **Edit** | Modify connection settings |
| **Delete** / **Disconnect** | Remove from bbdump (local = delete DB, external = disconnect only) |

### Duplicating a Database

The duplication feature copies a remote database to your local PostgreSQL server:

1. Click **Duplicate** on any database
2. Enter a name for the local copy
3. Optionally assign to a project
4. bbdump runs a 4-step process:
   - **Backup** — Dump the source database
   - **Create** — Create the new local database
   - **Restore** — Restore the dump into the new database
   - **Complete** — Register the new database in bbdump

This is useful for creating local development copies of production or staging databases.

### Database Status Indicators

| Indicator | Meaning |
|-----------|---------|
| Green dot | Connection successful |
| Gray dot | Not tested / inactive |
| `local` badge | Created and managed by bbdump |
| `external` badge | External connection |
| Size badge | Database size (e.g. `1.2 MB`) |

## Ungrouped Databases

Databases not assigned to any project appear at the bottom of the list under a separate section. You can drag them into a project at any time.
