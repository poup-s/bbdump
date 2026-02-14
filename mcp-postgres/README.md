# MCP PostgreSQL Server

A read-only PostgreSQL MCP (Model Context Protocol) server that allows LLMs to explore and query PostgreSQL databases.

## Installation

```bash
cd mcp-postgres
npm install
npm run build
```

## Configuration

Connection is configured via standard PostgreSQL environment variables:

| Variable | Default | Description |
|---|---|---|
| `PGHOST` | `localhost` | Server host |
| `PGPORT` | `5432` | Server port |
| `PGUSER` | `postgres` | Username |
| `PGPASSWORD` | (empty) | Password |
| `PGDATABASE` | `postgres` | Default database |
| `MCP_STATEMENT_TIMEOUT` | `60000` | Query timeout (ms) |
| `MCP_MAX_ROWS` | `5000` | Maximum rows per query |

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-postgres/build/index.js"],
      "env": {
        "PGHOST": "localhost",
        "PGPORT": "5432",
        "PGUSER": "postgres",
        "PGPASSWORD": "your_password"
      }
    }
  }
}
```

## Available Tools (20)

### Databases
- **`list_databases`** — List all databases with size, owner, encoding, connections
- **`create_database`** — Create a new database (only write operation)

### Tables
- **`list_tables`** — List tables with row count estimates
- **`describe_table`** — Full table structure: columns, types, PK, FK, defaults

### Data
- **`read_rows`** — Read rows with pagination and sorting
- **`search_table`** — Full-text ILIKE search across all columns
- **`count_rows`** — Count rows with optional WHERE filter

### Query
- **`execute_query`** — Execute read-only SQL queries
- **`explain_query`** — EXPLAIN ANALYZE for performance analysis

### Schema
- **`list_schemas`** — List database schemas
- **`list_indexes`** — List indexes with size and usage stats
- **`list_foreign_keys`** — List FK relationships
- **`list_enums`** — List ENUM types and values
- **`get_database_size`** — Detailed size breakdown by table/index

### Extras
- **`list_extensions`** — List PostgreSQL extensions
- **`get_table_stats`** — Table statistics (dead tuples, vacuum info)
- **`find_column`** — Search for column names across all tables
- **`list_views`** — List views with SQL definitions
- **`list_functions`** — List stored functions/procedures
- **`list_active_connections`** — List active server connections

## Security

- All queries (except `create_database`) run inside `BEGIN READ ONLY` transactions
- Parameterized queries everywhere (no string interpolation for values)
- `pg-format` for safe identifier escaping
- Statement timeout (60s default)
- Max 5000 rows per query
- Write operations blocked in `execute_query` via regex + READ ONLY transaction
- Database name validation for `create_database`

## Testing

```bash
npx @modelcontextprotocol/inspector node build/index.js
```
