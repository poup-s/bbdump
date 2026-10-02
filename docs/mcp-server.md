# MCP Server

bbdump includes a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI assistants (Claude Desktop, Claude Code, Codex, Cursor, Windsurf / Devin desktop, VS Code, OpenCode and any other MCP client) work with your PostgreSQL databases.

Reads are free; every write needs your approval in bbdump (see [Mutation Confirmation](#mutation-confirmation)).

## Overview

Once installed, your AI assistant can:

- List and switch between all your bbdump-configured databases (local, cloud or over SSH)
- Explore schemas, tables, columns, indexes, and relationships — the whole schema in one call
- Read, search and profile data
- Run read-only queries and analyze performance with EXPLAIN
- Check the database's health, get index advice, find slow queries and locks
- Insert, update, and delete rows (with confirmation), and undo those changes
- Back up a database before a risky change, and compare two databases

## Installation

1. Open bbdump **Settings** (or the last step of the onboarding)
2. In the **AI assistants (MCP)** section, click **Connect** next to your client
3. Restart the client

bbdump detects which clients are present. A client shows **Update available** when its entry points to an older bbdump setup (for example after moving the app, or after updating from 1.0.2): click **Update all**.

### Supported clients

| Client | Config file bbdump edits | Entry |
|--------|--------------------------|-------|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Linux `~/.config/Claude/claude_desktop_config.json` | `mcpServers.bbdump-postgres` |
| Claude Code | `~/.claude.json` (user scope, via `claude mcp add-json --scope user` when the CLI is found) | top-level `mcpServers.bbdump-postgres`, `"type": "stdio"` |
| Codex (OpenAI) | `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) — TOML | `[mcp_servers.bbdump-postgres]` with `command`, `args`, and `[mcp_servers.bbdump-postgres.env]` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.bbdump-postgres`, `"type": "stdio"` |
| Windsurf (older versions) | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.bbdump-postgres` |
| Devin desktop (formerly Windsurf) | `~/.config/devin/mcp_config.json` (or `$XDG_CONFIG_HOME/devin/`) | `mcpServers.bbdump-postgres` |
| VS Code | macOS `~/Library/Application Support/Code/User/mcp.json`, Linux `~/.config/Code/User/mcp.json` | `servers.bbdump-postgres`, `"type": "stdio"` |
| OpenCode | `~/.config/opencode/opencode.json` (or `opencode.jsonc`) | `mcp.bbdump-postgres`, `"type": "local"`, `command` array, `environment` |

### What happens during installation

- The previous file is saved next to it as `<file>.bak`, then the new content is written atomically (temporary file + rename).
- Files with comments (JSONC) are read, but comments are not kept in the rewritten file; they stay in the `.bak`.
- A file bbdump cannot parse is left untouched and the error is shown.
- **Disconnect** deletes only the `bbdump-postgres` entry.

The server runs on bbdump's own executable in Node mode (`ELECTRON_RUN_AS_NODE=1`), so no Node.js installation is needed. Each entry passes:

| Variable | Purpose |
|----------|---------|
| `ELECTRON_RUN_AS_NODE` | Runs the bbdump binary as Node.js |
| `BBDUMP_CONFIG_PATH` | bbdump's `config.json` (database connections) |
| `BBDUMP_KEY_PATH` | Encryption key used to decrypt stored passwords |
| `MCP_CONFIRM_PORT_FILE` | Port and token of bbdump's confirmation server |
| `BBDUMP_APP_PATH` | Used to start bbdump when a write needs confirmation and the app is closed |

On macOS, move bbdump to `/Applications` before installing: an app opened from Downloads may run from a temporary path (App Translocation) that disappears later. On Linux AppImage, the command is the AppImage file and the server is copied to bbdump's data folder, because the AppImage mount point changes on every launch.

### Other clients (manual configuration)

**Settings → AI assistants (MCP) → Another client: configuration to copy** shows a ready-to-paste snippet with the real paths of your machine:

```json
{
  "mcpServers": {
    "bbdump-postgres": {
      "command": "/Applications/bbdump.app/Contents/MacOS/bbdump",
      "args": ["/Applications/bbdump.app/Contents/Resources/mcp-postgres/index.js"],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "BBDUMP_CONFIG_PATH": "~/Library/Application Support/bbdump/config.json",
        "BBDUMP_KEY_PATH": "~/Library/Application Support/bbdump/.encryption.key",
        "MCP_CONFIRM_PORT_FILE": "~/Library/Application Support/bbdump/.mcp-confirm-port",
        "BBDUMP_APP_PATH": "/Applications/bbdump.app"
      }
    }
  }
}
```

(The snippet from Settings uses absolute paths; `~` is shortened here.)

## Available Tools

The MCP server exposes 45 tools and 4 prompts. Tools are annotated (read-only or destructive), so clients can approve reads automatically. Tools marked ✱ change something and need your confirmation in bbdump.

### Connections

| Tool | Description |
|------|-------------|
| `list_connections` | Databases saved in bbdump and the active connection (passwords never shown) |
| `use_connection` | Switch the active connection (an SSH database gets its tunnel from the app) |
| `test_connection` | Check that a saved database is reachable, without switching to it |

### Databases

| Tool | Description |
|------|-------------|
| `list_databases` | Databases of the active server with size, owner and open connections |
| `create_database` ✱ | Create a database on the active server |

### Schema

| Tool | Description |
|------|-------------|
| `get_schema_overview` | The whole schema in one compact call: tables, columns, keys, relations |
| `list_schemas` | User schemas with owner and table count |
| `list_tables` | Tables with row counts (exact for small tables, estimate otherwise), size and comment |
| `describe_table` | Columns, keys (multi-column and cross-schema), constraints, indexes of a table or view |
| `get_table_ddl` | The CREATE TABLE statement of a table as it exists |
| `list_indexes` | Indexes with definition, size, usage and validity |
| `list_foreign_keys` | Foreign keys of a table, both directions, with ON DELETE / ON UPDATE |
| `find_column` | Columns whose name matches a pattern, across schemas |
| `list_views` | Views and materialized views with their definition |
| `list_functions` | Functions and procedures with arguments, return type and language |
| `list_triggers` | Triggers of a table |
| `list_enums` | ENUM types and their values |
| `list_sequences` | Sequences with last value and share used |
| `list_extensions` | Installed extensions and those available on the server |

### Data

| Tool | Description |
|------|-------------|
| `read_rows` | Rows with filters, multi-column sorting, column selection and paging (up to 5,000) |
| `search_table` | Rows where any column contains a text |
| `full_text_search` | Language-aware full-text search (web-search syntax) |
| `count_rows` | Row count, estimate or exact, with optional filters |
| `profile_table` | NULLs, distinct values, min/max and most frequent values on a sample |

### Queries

| Tool | Description |
|------|-------------|
| `execute_query` | Read-only SQL in a READ ONLY transaction, rows limited on the server, `$1` parameters, markdown / CSV output |
| `explain_query` | Execution plan with a summary: sequential scans, slowest nodes, bad estimates |
| `query_history` | Queries and changes run in this MCP session |

### Health and performance

| Tool | Description |
|------|-------------|
| `database_health` | Cache, connections, long transactions, VACUUM, index problems, sequences near their limit, wraparound |
| `suggest_indexes` | Foreign keys without an index, tables read by sequential scans |
| `test_index` | Plan with a hypothetical index (hypopg), nothing created |
| `get_slow_queries` | Most expensive queries (pg_stat_statements) |
| `list_locks` | Blocked sessions and what blocks them |
| `list_active_connections` | Sessions on the server, their state and running time |
| `get_table_stats` | Live/dead rows, scans, last (auto)vacuum and analyze |
| `get_database_size` | Database size and its largest tables |
| `cancel_query` ✱ | Cancel a query or close a session |

### Changes and undo

| Tool | Description |
|------|-------------|
| `insert_rows` ✱ | Insert rows (missing columns get their default) |
| `update_rows` ✱ | Update rows matching filters (at least one) |
| `delete_rows` ✱ | Delete rows matching filters (at least one) |
| `execute_write_query` ✱ | SQL that changes data or schema, in one transaction; `dry_run` rolls back |
| `list_changes` | Changes made through MCP, with their undo point |
| `undo_change` ✱ | Put back the rows a change touched, in one transaction |

### Backups and comparison

| Tool | Description |
|------|-------------|
| `create_backup` | Back up a database with bbdump before a risky change |
| `list_backups` | Backups made by bbdump |
| `compare_databases` | What a target database lacks compared to a source (schema and rows), both only read |

### Prompts

| Prompt | Purpose |
|--------|---------|
| `explore_database` | Understand a database: its tables, relations, and what the data looks like |
| `optimize_query` | Find why a query is slow and how to fix it, without changing the database |
| `health_check` | Check the health of a database and get a prioritized to-do list |
| `safe_change` | Apply a data or schema change with a backup and a dry run first |

## Mutation Confirmation

Write operations (the tools marked ✱) require user confirmation:

1. The assistant requests a mutation through the MCP server
2. bbdump shows a confirmation prompt in the system tray popup
3. You have **60 seconds** to approve or deny
4. If approved, the mutation is executed
5. If denied or timed out, the operation is cancelled

If bbdump is closed, the MCP server starts it to show the prompt.

The confirmation server listens on `127.0.0.1` only. At each launch bbdump generates a random token and writes it with the port to `.mcp-confirm-port` (readable by your user only). Requests without the token, requests sent by a web page (with an `Origin` header) and bodies over 64 KB are rejected.

### Skip Confirmation

In **Settings → AI assistants (MCP)**, **Let assistants change data without asking** approves every change automatically. Use this only in development environments.

## Troubleshooting

### The client doesn't see the MCP server

- Restart the client after installation
- Check the client in **Settings → AI assistants (MCP)**: it should say **Connected** (click **Update all** if it says **Update available**)
- Open the config file shown under the client name and look for `bbdump-postgres`
- The server reads bbdump's config file directly: bbdump itself only needs to run to confirm writes

### Connection errors

- Ensure the target database is accessible from your machine
- Check that your database credentials in bbdump are correct
- Look at bbdump's **Logs** tab for error details

### Mutations are blocked

- Check the confirmation prompt in the system tray
- Ensure bbdump's main window or tray is accessible
- If the confirmation server is not running, restart bbdump
- After updating from bbdump 1.0.2, click **Update all** so each client's entry uses the new command
