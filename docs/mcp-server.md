# MCP Server

bbdump includes a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that allows Claude Desktop to interact with your PostgreSQL databases.

## Overview

Once installed, Claude can:

- List and switch between all your bbdump-configured databases
- Explore schemas, tables, columns, indexes, and relationships
- Read and search data
- Run SELECT queries and analyze performance with EXPLAIN
- Insert, update, and delete rows (with confirmation)
- Inspect extensions, functions, triggers, views, sequences, and enums

## Installation

1. Open bbdump **Settings**
2. In the **MCP Server** section, click **Install in Claude Desktop**
3. bbdump automatically configures Claude Desktop's configuration file
4. Restart Claude Desktop

That's it. Claude can now access your databases.

### What Happens During Installation

bbdump modifies Claude Desktop's config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) to register the `bbdump-postgres` MCP server. It passes:

- The path to bbdump's MCP server binary
- Environment variables pointing to your config and encryption key

## Available Tools

The MCP server exposes 31 tools organized by category:

### Connections

| Tool | Description |
|------|-------------|
| `list_connections` | List all databases configured in bbdump |
| `use_connection` | Switch the active database connection |
| `test_connection` | Verify connection parameters |

### Schema Exploration

| Tool | Description |
|------|-------------|
| `list_schemas` | List user schemas |
| `list_tables` | List tables with row counts |
| `describe_table` | Full table structure — columns, types, keys, constraints |
| `list_indexes` | Table indexes with usage statistics |
| `list_foreign_keys` | Foreign key relationships |

### Data Access

| Tool | Description |
|------|-------------|
| `read_rows` | Read table data with pagination and sorting (max 5,000 rows) |
| `search_table` | Pattern search across all columns |
| `count_rows` | Count rows in a table |
| `find_column` | Search for column names across the database |

### Queries

| Tool | Description |
|------|-------------|
| `execute_query` | Run read-only SELECT queries with timeout |
| `explain_query` | EXPLAIN ANALYZE for performance analysis |

### Mutations (require confirmation)

| Tool | Description |
|------|-------------|
| `insert_rows` | Insert rows into a table |
| `update_rows` | Update rows with WHERE filters |
| `delete_rows` | Delete rows with WHERE filters |
| `execute_write_query` | Run custom INSERT/UPDATE/DELETE SQL |

### Database Management

| Tool | Description |
|------|-------------|
| `list_databases` | List all PostgreSQL databases with size and owner |
| `create_database` | Create a new database (requires confirmation) |

### Extras

| Tool | Description |
|------|-------------|
| `list_extensions` | Installed and available extensions |
| `list_functions` | User-defined functions |
| `list_triggers` | Table triggers |
| `list_views` | Views in the database |
| `list_enums` | ENUM types |
| `list_sequences` | Sequence objects |
| `list_active_connections` | Active connections to databases |
| `get_table_stats` | Live/dead tuples, vacuum history |
| `get_database_size` | Total database size |
| `full_text_search` | Full-text search on text columns |
| `query_history` | Query history from the current MCP session |

## Mutation Confirmation

Write operations (INSERT, UPDATE, DELETE, CREATE DATABASE) require user confirmation:

1. Claude requests a mutation through the MCP server
2. bbdump shows a confirmation prompt in the system tray popup
3. You have **60 seconds** to approve or deny
4. If approved, the mutation is executed
5. If denied or timed out, the operation is cancelled

### Skip Confirmation

In **Settings**, you can enable **Skip MCP mutation confirmation** to auto-approve all mutations. Use this only in development environments.

## Troubleshooting

### Claude doesn't see the MCP server

- Ensure you restarted Claude Desktop after installation
- Check that the config file was updated: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Verify bbdump is running (the MCP server reads bbdump's config)

### Connection errors

- Ensure the target database is accessible from your machine
- Check that your database credentials in bbdump are correct
- Look at bbdump's **Logs** tab for error details

### Mutations are blocked

- Check the confirmation prompt in the system tray
- Ensure bbdump's main window or tray is accessible
- If the confirmation server is not running, restart bbdump
