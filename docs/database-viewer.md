# Database Viewer

The database viewer is a full-featured interface for exploring and interacting with your PostgreSQL databases. Open it by clicking **View** on any database.

## Navigation

The viewer has a sidebar on the left listing all tables in the database with their row counts. The main area has four modes accessible from the sidebar:

- **Schema Visualizer** — Interactive relationship graph
- **Performance** — Table statistics and health metrics
- **SQL Builder** — Visual query builder and raw SQL editor
- **Table Explorer** — Browse data, relations, and schema (default)

## Table Explorer

### Data Tab

Displays table data in a paginated grid.

**Features:**

| Feature | Description |
|---------|-------------|
| **Column sorting** | Click any column header to sort ascending/descending |
| **Column reordering** | Drag column headers to rearrange |
| **Pagination** | Navigate pages, configure rows per page (10, 25, 50, 100) |
| **Search** | Full-text search across all columns |
| **Add row** | Insert a new row directly from the UI |
| **Refresh** | Reload table data |
| **Export CSV** | Download the current view as a CSV file |

### Row Detail Panel

Click any row to open the detail panel on the right side:

- View all field values with their PostgreSQL types
- **Edit mode** — Modify field values inline. Changed fields are highlighted in yellow.
- **Save** or **Discard** changes
- **Copy** individual field values
- **NULL toggle** — Set a field to NULL

### Relations Tab

Displays foreign key relationships for the selected table:

- **Outgoing** — Tables this table references
- **Incoming** — Tables that reference this table
- Click a related table to navigate to it

### Schema Tab

Shows the full table structure:

| Info | Description |
|------|-------------|
| **Columns** | Name, type, nullable, default value, primary key |
| **Indexes** | Index name, columns, type (btree, gin, etc.), unique flag |
| **Constraints** | Primary keys, foreign keys, check constraints, unique constraints |
| **Triggers** | Associated triggers and their definitions |

## Schema Visualizer

An interactive graph showing all tables and their relationships:

- Each table is rendered as a card with column names and types
- Foreign key relationships are drawn as connecting lines
- **Pan and zoom** — Navigate large schemas
- **Drag** — Rearrange table positions
- Tables from the sidebar can be highlighted in the graph

Powered by Vue Flow with an automatic dagre layout.

## Performance

Displays PostgreSQL statistics for each table:

| Metric | Description |
|--------|-------------|
| **Live tuples** | Current number of live rows |
| **Dead tuples** | Rows marked for deletion (waiting for VACUUM) |
| **Last vacuum** | When the table was last vacuumed |
| **Last analyze** | When statistics were last updated |
| **Sequential scans** | Number of sequential table scans |
| **Index scans** | Number of index scans |
| **Table size** | Size on disk |
| **Index size** | Total size of all indexes |

## SQL Builder

### Visual Mode

Build queries visually with form controls:

| Clause | Description |
|--------|-------------|
| **SELECT** | Choose columns, toggle DISTINCT |
| **FROM** | Select the source table |
| **WHERE** | Add filter conditions with operators (=, !=, >, <, LIKE, IN, etc.) |
| **JOIN** | Add JOIN clauses with table, type (INNER, LEFT, RIGHT, FULL), and ON condition |
| **ORDER BY** | Sort by column, ascending or descending |
| **LIMIT** | Quick presets (10, 25, 50, 100, 500) or custom value |

The generated SQL is displayed in real time and can be copied.

### Raw SQL Mode

Toggle to raw SQL mode to write queries directly:

- Full SQL editor with syntax highlighting
- Execute queries with **Ctrl+Enter** or the Execute button
- Results displayed in a data grid
- Row count and execution time shown
- **Export CSV** — Download query results
- Supports SELECT, INSERT, UPDATE, DELETE (mutations must be enabled in Settings)

### Unsaved Changes Guard

If you have unsaved edits to a row and try to navigate away, a confirmation dialog prevents accidental data loss.
