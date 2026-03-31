# Configuration

## File Locations

All bbdump data is stored in `~/.bbdump/`:

| Path | Description |
|------|-------------|
| `~/.bbdump/config.json` | Main configuration file — databases, projects, settings |
| `~/.bbdump/.encryption.key` | AES-256 encryption key (mode 0600) |
| `~/.bbdump/backups/` | Default backup storage directory |
| `~/.bbdump/logs/app.log` | Application logs |
| `~/.bbdump/.mcp-confirm-port` | MCP confirmation server port (runtime) |

## App Settings

Access settings from the **Settings** tab in the sidebar.

| Setting | Description | Default |
|---------|-------------|---------|
| **Language** | UI language — English or French | English |
| **Backup location** | Directory where backup files are stored | `~/.bbdump/backups/` |
| **SQL mutations** | Allow INSERT/UPDATE/DELETE in the SQL Builder | Disabled |
| **MCP skip confirmation** | Auto-approve MCP mutation requests | Disabled |

## Encryption Key Management

| Action | Description |
|--------|-------------|
| **Export** | Save the current encryption key to a file |
| **Import** | Replace the current encryption key with one from a file |

See [Encryption & Security](encryption-and-security.md) for details.

## MCP Server

| Action | Description |
|--------|-------------|
| **Install in Claude Desktop** | Register bbdump's MCP server in Claude Desktop's config |
| **Uninstall** | Remove the MCP server registration |

See [MCP Server](mcp-server.md) for details.

## PostgreSQL Client Tools

bbdump requires `pg_dump` and `pg_restore` to be available in your PATH. The app detects these tools automatically on launch.

**macOS (Homebrew):**

```bash
brew install postgresql
# or just the client tools:
brew install libpq
```

**Linux (Debian/Ubuntu):**

```bash
sudo apt install postgresql-client
```

If the tools are not found, bbdump displays a warning and backup/restore features are disabled.

## Connection URL Format

bbdump supports standard PostgreSQL connection URLs:

```
postgresql://[user[:password]@][host[:port]][/database][?parameter=value]
```

**Examples:**

```
postgresql://myuser:secret@db.example.com:5432/mydb
postgresql://myuser@localhost/mydb?sslmode=require
postgresql://myuser:secret@db.example.com/mydb
```

When pasting a URL in the database modal, all fields are parsed and populated automatically.

## Dark Mode

bbdump follows your system appearance setting. The toggle in the sidebar footer switches between light and dark mode manually.
