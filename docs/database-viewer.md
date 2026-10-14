# Database Explorer

The explorer lets you browse and edit the data of any database, local or remote (cloud, SSH). Open it with **View** on a database card, or from the menu bar popup.

![Data](../captures/viewer-data.webp)

## Layout

The sidebar on the left holds:

- **Schema Visualizer**, **Performance** (databases on the local server) and **SQL Builder**;
- a **schema selector**: every schema of the database, not only `public`;
- the tables of the selected schema, with a filter and their row count.

### Row counts

Counts in the sidebar are instant: `~1.2K` is an estimate from PostgreSQL's statistics, a plain number is exact, `?` means the table was never analyzed. bbdump only runs an exact `COUNT(*)` for small tables without statistics. Once a table is open, the grid shows its exact total (or the estimate, prefixed with `~`, above a million rows) and the sidebar follows.

## Tables in tabs

Each table opens in a tab that keeps its search, page, sort, column widths and pending edits when you switch to another one.

- A single click opens a **preview tab** (in italics) that the next table replaces. It stays once you search, sort, page or edit in it, or when you double-click it.
- A dot marks a tab with unsaved edits; closing it (or the explorer) asks first.
- Middle-click closes a tab; the tab strip scrolls with the mouse wheel.
- Open tabs, their view and sort are remembered per database. The search text is not saved to disk.

Each tab has three views: **Data**, **Relations** and **Schema**.

## Data

| Feature | Description |
|---------|-------------|
| **Search** | Finds rows where any column contains the text (case-insensitive) |
| **Sort** | Click a column header to sort ascending, then descending |
| **Resize** | Drag the edge of a column header |
| **Paging** | 25, 50, 100 or 200 rows per page, or go to a page number |
| **Foreign keys** | A linked value (🔗) opens the row it points to, next to the grid |
| **Add row** | Insert a row (tables with a primary key) |
| **Export CSV** | Download the current page as a CSV file |
| **Refresh** | Reload the data |

### Row detail and edit

Click a row to open its detail on the right:

![Row detail](../captures/viewer-row.webp)

- Every field with its type, a copy button and a link to the row it references.
- Edit fields in place: text, numbers, dates, booleans, JSON. Changed fields are highlighted; **Save** or **Discard**. Nullable fields can be set to `NULL`. The primary key is read-only.
- **Duplicate** (⌘D) opens the add form pre-filled from the row. Sequences, identities, generated ids and "now" timestamps are left to the database; an id the app generates (Prisma cuid, uuid) gets a fresh value in the same format. A key or unique value still equal to the original is highlighted and blocks adding until it is changed (**Make unique** fixes it in one click).
- **Delete** asks for confirmation.

In the add form, columns with a default (sequence, `now()`…) can stay empty, and a foreign key column offers a searchable list of the rows it can point to.

## Relations

A graph of the table and the tables directly linked to it by foreign keys, in both directions, across schemas. **Magic Layout** rearranges it.

## Schema

The columns of the table (name, type, nullable, default, primary key, foreign key) and the tables that reference it (**Referenced by**).

## Schema Visualizer

An interactive graph of the tables of the selected schema, plus the tables of other schemas linked to them by a foreign key. Each table shows its columns and types; foreign keys are drawn between columns.

![Schema](../captures/viewer-schema.webp)

- Pan, zoom and drag tables; the layout is automatic at first.
- Double-click a table to open it in a tab.

## SQL Builder

![SQL builder](../captures/viewer-sql.webp)

### Visual mode

Build `SELECT`, `UPDATE`, `DELETE` or `INSERT` queries from blocks:

| Block | Description |
|-------|-------------|
| **SELECT / FROM** | Table and columns |
| **JOIN** | INNER, LEFT, RIGHT or FULL, with the ON condition suggested from foreign keys |
| **WHERE** | Conditions with `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `ILIKE`, `IN`, `IS NULL`, `IS NOT NULL` |
| **GROUP BY / ORDER BY / LIMIT** | Grouping, sorting and row limit |
| **SET / VALUES** | Values for `UPDATE` and `INSERT` |

The generated SQL is shown as you build, and can be copied. An `UPDATE` or `DELETE` without `WHERE` is flagged.

### SQL mode

Switch the **SQL** toggle to write the query yourself (switching back rebuilds the blocks when it can).

- Run with **⌘/Ctrl+Enter** or **Execute**; results show in a grid with the row count and duration.
- Queries run in a **READ ONLY** transaction, return at most 5,000 rows and stop after 60 seconds. Only one statement is accepted.
- `INSERT`, `UPDATE`, `DELETE`, `DROP`… need **Settings → Security → Write queries in the SQL editor**, and each one asks for confirmation.
- **History** keeps the last 20 queries of the session; **Export CSV** downloads the results.

## Performance

Available for databases on the local server. It lists the **slowest queries** recorded by `pg_stat_statements`: calls, mean time, rows and share of the total execution time, with the full SQL to copy.

When `pg_stat_statements` is not active, the tab explains why and can fix the configuration (`shared_preload_libraries`) and restart PostgreSQL for you. **Reset Statistics** starts over.

## Extensions

Open the catalog from the **⋯** menu of a database on the local server, or from **Settings → Local PostgreSQL**.

![Extensions](../captures/extensions.webp)

- About 90 extensions by category: AI & vectors, geography, search, data types, analytics, scheduling, performance, security, integrations, development. Each has a description, a link to its documentation, and a search.
- Besides the extensions already on the server, the catalog lists well-known ones to add: pgvector, PostGIS, pgRouting, pg_cron, pg_partman, TimescaleDB, Citus, HypoPG, pgAudit, pg_repack…
- **Install** puts the package on the local server, then enables the extension: `brew install` with a Homebrew PostgreSQL; on Linux (Debian / Ubuntu, Fedora, PGDG for RHEL-like systems) one system password prompt installs the package. Without a graphical prompt, the exact command for your server's version is shown to copy.
- Extensions loaded at startup (pg_cron, pgAudit, TimescaleDB, pg_stat_statements…) are added to `shared_preload_libraries`, and PostgreSQL can be restarted from the dialog; they are enabled after the restart.
- **Remove** asks for confirmation: the extension's types and functions are dropped.

When you duplicate a database that uses an extension the local server lacks (PostGIS, for example), the duplicate dialog names it first and offers to install it.
