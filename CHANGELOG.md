# Changelog

## 1.1.1 — 2026-10-08

### Fixed

- **Backing up or duplicating a database failed with "pg_dump version mismatch"** when its
  server was older than every installed pg_dump (e.g. a PostgreSQL 16 server with pg_dump 17
  and 18 installed). pg_dump reads servers of its own version and older ones: the same major
  version is still preferred, otherwise the closest newer one is used. When the server's
  version cannot be detected, the newest pg_dump is used instead of the system default. The
  error now only appears when every pg_dump is older than the server, with the command to
  install the right one.

## 1.1.0 — 2026-10-02

### Upgrading from 1.0.2

- **macOS:** 1.0.2 cannot update itself (builds are not code-signed, so the macOS updater
  rejects them). Reinstall once with the install script or the DMG from this release:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash
  ```
  From 1.1.0 on, "Download update" opens the release page instead of failing.
- Your configuration is migrated automatically and stays readable by 1.0.2.
- **macOS 13 (Ventura) or later is now required** (Electron 44). Stay on 1.0.2 on macOS 12.

### Fixed

- **Restoring into an existing database did not replace its content**, though the dialog
  said so and reported success: tables already there were not recreated and their rows
  not loaded (duplicate keys), and those errors were hidden. Now:
  - The schemas the backup contains are emptied first, in one transaction: if that fails
    (missing rights, a lock), nothing is changed and the reason is shown. Schemas the
    backup does not contain (Supabase's auth, storage…) are left alone.
  - The dialog reads the result: "restored", "restored, with errors" (listed), or the
    failure. It used to show "Restoring…" even when the restore had failed.
  - "Back up the database before replacing it", on by default: the restore does not start
    if that backup fails.
- **Editing a database dropped some of its settings**: its last backup date (so a
  catch-up backup ran again), its masking and its "Update from…" source were lost when
  saving the edit dialog. They are kept.
- **Changing the default backup folder in Settings was not saved**: the new folder was
  shown and confirmed, but new databases kept the old one.
- **A duplicated database looked already backed up**: the copy got the date of the dump
  of its source, so it showed a backup it never had and the catch-up of missed
  scheduled backups could skip it. Copies no longer get that date, and copies made by
  earlier versions lose it at startup (the date stays on the database that has the
  backup files). The dump made to duplicate now counts as a backup of the source
  (retention, history).
- **Editing a project wiped its proxy settings** (port, target, on/off, masked, collapsed):
  the dialog's name, colour and databases now update the project instead of replacing it.
- A database could end up in two projects when picked in the project dialog; it now moves
  (as with drag and drop), and a proxy that targeted it in its old project is stopped.

- **Backups failed for connection URLs with extra parameters** (Prisma's `schema`,
  `pgbouncer`, `connection_limit`, `pool_timeout`…): pg_dump refuses parameters it does not
  know. Only libpq's own parameters are now passed to the PostgreSQL tools; the others are
  listed in the log. The saved URL is unchanged.
- Connection URLs are read the same way everywhere and never throw: passwords with
  unencoded `@`, `:`, `/` or `%`, IPv6 hosts; several hosts are refused with a message.

- **Adding a row in the viewer failed on many tables**: the primary key could not be typed
  (tables whose ids are made by the app, e.g. Prisma), and empty columns were sent as
  NULL, overriding their database default. Identity and generated columns are handled too.
- **"role postgres does not exist"** on macOS with Homebrew (#4): bbdump now uses the
  role that actually exists on the local server, and repairs databases saved by 1.0.2.
- **PostgreSQL 18** is detected; Homebrew installs are consistently `postgresql@17`, and the
  running service is preferred when several versions are installed.
- **Backups with parallel jobs > 1** always failed; they now run (the option is ignored for
  the custom format, which does not support it).
- A failed or interrupted backup no longer leaves a truncated `.backup` that looks restorable.
- Scheduled backups fired right after launch could fail before `pg_dump` was located.
- The "Encrypt password" checkbox in the connection form actually toggled backup file
  encryption; it is now labeled "Encrypt backup files".
- The generated SQL "copy" button in the query builder did nothing.
- Missing translations (raw keys like `common.loading` were displayed).
- The uninstall step of `install.sh` targeted a directory the app never uses.
- External databases no longer require a stored password (trust auth, `~/.pgpass`, client
  certificates); PostgreSQL tools never wait on a password prompt.
- Switching raw SQL back to the query builder no longer breaks on commas, `AND`/`OR` or
  keywords inside strings or quoted names.
- Browsing very large tables no longer runs a full `COUNT(*)` on every page.
- **Linux ARM64 AppImage did not start** on a stock system (its launcher needed the
  `zlib1g-dev` package). AppImages now use the static AppImage runtime: no `libfuse2`
  needed either, only the `fusermount3` that current distributions ship.
- Backups failed with "pg_dump not found" when PostgreSQL was installed while bbdump was
  running (e.g. from the onboarding): the tools are now looked up again.
- The onboarding now starts in the system language, and shows install steps translated.
- **Backups saved outside the internal folder were invisible**: the Backups page (and its
  download / delete) only looked in the app's own folder, while a database or the default
  folder could point elsewhere. It now lists every backup folder.
- Settings showed the internal folder as "Default backup location" even after it was changed.
- Deleting a backup asked to confirm deleting "this database".
- "Copy all" (proxy activity) and "Copy SQL" (query details) reported success even when
  the clipboard write failed.
- Closing the proxy activity dialog with × kept polling its logs every 3 seconds.
- Clicking twice on a button that asks for confirmation showed the same question twice in a row.
- MCP server:
  - Every tool failed on macOS with Homebrew until `use_connection` (it connected as the
    `postgres` role, which Homebrew does not create): the default user is now the OS user.
  - `execute_query` loaded the whole result in memory before cutting it; rows are now
    limited on the server. Queries mentioning `DELETE` or `UPDATE` in a string or a column
    name (`comment`, `lock`…) are no longer refused.
  - Errors were returned as normal answers; they are now flagged as errors, with a hint
    (wrong connection, unknown table or column…). A refused, expired or unreachable
    confirmation is told apart.
  - Foreign keys across schemas or on several columns were missing or mixed up; a missing
    table returned an empty description.
  - `insert_rows` used the first row's columns only and wrote NULL over column defaults.
  - `test_connection` ignored the connection's SSL mode and CA certificate.
  - `full_text_search` announced a query syntax it did not accept (now web-search syntax).
  - `list_tables` ran `COUNT(*)` on every never-analyzed table (exact counts are now for
    small tables only); `list_functions` listed a function once per comment.
  - Connection URLs with special characters in the password are read correctly.

### Security

- **Passwords of databases added by connection URL were stored in clear text** in
  `config.json` (inside the URL) and shown in the UI. The password is now moved into the
  encrypted password field and put back into the URL in memory only; existing
  configurations are migrated automatically on first launch.
- The read-only SQL mode (viewer and MCP `execute_query` / `explain_query`) could be escaped
  with a multi-statement query (`SELECT 1; COMMIT; …`). Only single statements are accepted now.
- Database connection values were interpolated into a shell command during size estimation.
- Connection strings (with passwords) were written to the log file; credentials are now masked.
- Links and `window.open` could load remote pages inside the app window; they now open in
  the system browser. A Content-Security-Policy was added.
- The local MCP confirmation server now requires a per-launch token, rejects browser
  requests and limits request size.
- `install.sh` verifies the downloaded app against the published SHA-512 checksum.
- bbdump no longer tries common passwords (`postgres`, `admin`, `password`) on the local server.
- MCP `execute_write_query` with `dry_run`: a payload such as `INSERT …; COMMIT; …` could
  make the "dry run" permanent after the user approved it. A dry run now takes one
  statement only. Updates and deletes show the number of rows they will touch in the
  confirmation.

### Added

- **What's new tour**, shown once after updating from 1.0: seven short slides playing the
  new screens (in English or French, like the app), with what changes for you and what to
  do about it right there — start bbdump at login, update the AI clients that still point
  to 1.0, and how restoring now behaves. "Skip" closes it for good; Info → "See what's new
  in 1.1" opens it again. New installs do not see it (the onboarding covers the same).
- **Databases on a server, through SSH** (a VPS whose PostgreSQL is not exposed): a third
  way to add a database, "Server via SSH". bbdump opens the tunnel itself when the
  database is used (explorer, scheduled and manual backups, restore, duplicate, "Update
  from…", project proxy, AI assistants), shares it, and closes it after 10 minutes unused.
  - bbdump runs your own `ssh`: your `~/.ssh/config` aliases (listed in the dialog),
    keys, agent (1Password, Keychain), `known_hosts` and `ProxyJump` apply as they are;
    no key is copied. The tunnel listens on 127.0.0.1 only, on a free port.
  - Credentials can be read from the server: the `DATABASE_URL` of an env file (e.g.
    `.env.production`) is read over SSH and filled in; the password is stored encrypted.
    A URL pointing to a Docker Compose service name is flagged (its port must be published).
  - "Search the server" finds that file for you: the `.env` files under your home, `/srv`,
    `/var/www`, `/opt` and `/home` that hold a PostgreSQL URL, listed by path and variable
    name (copies like `.env.production.bak-…` and examples after the real one). Only the
    names leave the server, never the values; one click reads the chosen file.
  - The test checks SSH, then PostgreSQL through the tunnel. An unknown server shows its
    fingerprints and can be trusted (added to `known_hosts`); a changed key is refused.
  - The project proxy keeps the tunnel open while it runs: a local app can reach the
    server's database at a fixed local address. The MCP server asks the app for the tunnel.
  - Tunnels left by a session that crashed are stopped at the next start.
  - Stored so that 1.0.2 fails to connect rather than reaching another database: the
    database's host and port are the server's and the remote port.

- **New onboarding**, walking through the 3D database stack: choose how you use bbdump
  (PostgreSQL on this computer, or remote databases only), a machine check
  adapted to macOS and Linux (Debian/Ubuntu, Fedora/RHEL, Arch, openSUSE) with one-click
  installs (on Linux, one system password prompt installs, initializes and starts
  PostgreSQL and creates your role) and the exact command to run by hand, then your data,
  backup folder and AI clients.
- **Usage mode** (Settings): in "remote databases only" mode, local-server features are
  hidden. Existing installations keep the local mode. Settings show the current mode and
  the local server's state; "Add a local server…" opens the machine check (detect,
  install, start), and switching to remote only hides features — nothing is uninstalled.
  An onboarding opened from the app can be cancelled (Esc) without changing anything.
- **Table tabs in the database viewer**: each table opens in a tab that keeps its search,
  page, sort, column widths and pending edits when switching tables. A single click opens
  a preview tab (italic) that the next table replaces; it stays once you search, sort,
  page or edit in it, or on double-click. The tab strip scrolls with the mouse wheel.
  Open tabs, their view and sort are remembered per database (search text stays in
  memory only).
- **Duplicate a row** (row detail, ⌘D): the add form is pre-filled from the row. Sequences,
  identities, generated ids and "now" timestamps are left to the database; an
  app-generated key (Prisma cuid, uuid) gets a fresh value in the same format, shown as
  generated and editable. A key or unique value still equal to the original row is
  highlighted, can be fixed in one click ("Make unique": `name+copy@domain` for emails),
  and blocks adding the row until changed. An open add / duplicate form keeps its tab.
- **All schemas in the database viewer** (#1): schema selector, schema-qualified tables,
  relations and foreign keys across schemas, SQL builder with properly quoted names. Table
  row counts are instant estimates (exact count on demand) instead of a `COUNT(*)` on every
  table. Restores handle CHECK constraints in every schema, not only `public`.
- **SSL modes and CA certificates** (#5): disable / prefer / require / verify-ca / verify-full,
  with a root certificate file (e.g. AWS RDS `global-bundle.pem`). Applies to the viewer,
  backups, restores, the TCP proxy (now with SNI) and the MCP server.
- **Client tools only** (#2): the setup no longer requires Homebrew or a local PostgreSQL
  server; remote databases work with `pg_dump`, `psql` and `pg_restore` alone.
- **MCP one-click install** for Claude Desktop, Claude Code, Codex, Cursor, Windsurf, Devin desktop,
  VS Code and OpenCode (#3). The MCP server runs with bbdump's own runtime (no system Node.js needed).
  The MCP server now also works with databases saved as connection strings.
- **Scheduling that survives restarts:** optional launch at login (hidden in the tray),
  catch-up of backups missed while bbdump was closed, no overlapping runs, and a system
  notification when a scheduled backup fails.
- **Backup verification:** each dump is read back entirely with `pg_restore`; a corrupt dump
  is reported as a failure.
- **Retention:** keep only the N most recent backups of a database (off by default).
- **MCP server 1.1 (45 tools, 4 prompts)**, for Claude, Codex, Cursor and the other clients:
  - `get_schema_overview`: every table, column, key and relation in one compact call;
    `get_table_ddl` (CREATE TABLE as it exists); `profile_table` (NULLs, distinct values,
    min/max, most frequent values on a sample).
  - Diagnosis: `database_health` (cache, connections, long transactions, locks, VACUUM,
    unused / duplicate / invalid indexes, tables without primary key, sequences near their
    limit, transaction ID wraparound), `suggest_indexes` (foreign keys without index,
    sequential-scan heavy tables), `test_index` (hypothetical index with hypopg, nothing
    created), `get_slow_queries` (pg_stat_statements), `list_locks`, `cancel_query`.
  - Backups: `create_backup` before a risky change and `list_backups`, done by the bbdump app.
  - `read_rows` filters and multi-column sorting; `markdown` and `csv` result formats;
    query parameters (`$1`); `explain_query` summary (sequential scans, slowest nodes,
    bad estimates).
  - Tool annotations (read-only / destructive), so clients can auto-approve reads.
  - Prompts: explore a database, optimize a query, health check, make a change safely.
  - The default schema follows the connection (Prisma `?schema=`, `search_path`).
- **Undo for AI changes**: every write made through MCP saves an undo point when it can —
  the rows it touches, before and after, cascades included (rows a foreign key deletes
  or changes) — stored on this computer, encrypted, for 30 days. Nothing is written in
  the database.
  - Structured tools read the rows inside the change's own transaction; a free
    INSERT/UPDATE/DELETE is watched by a temporary trigger (created and removed inside
    the transaction, whatever the table size), or compared whole on small tables when
    triggers are not allowed. DDL and multi-statement queries have no undo point: the
    confirmation says so and the AI is told to back up first.
  - The confirmation shows whether an undo point will be saved, and its size.
  - **AI journal** (⋯ menu of a database): every AI change with its SQL, client, and the
    rows before/after; "Undo this change" restores them in one transaction. Undo is
    refused when those rows changed since, and the dialog shows them as they are now.
  - MCP tools `list_changes` and `undo_change` (confirmed in bbdump).
- **Update a local database from another one of its project** (⋯ menu of a local
  database in a project with several databases → "Update from…"), e.g. a dev copy that
  fell behind prod. Analysis → Choices → Preview → Apply:
  - Schema: what the local database lacks — schemas, extensions, enum types and values
    (in place), tables (with their sequences), columns, defaults, constraints, indexes,
    foreign keys (after every table), functions, views, triggers. Additions are selected;
    anything destructive (removed column, type change, local-only table) is listed but
    never selected by default. Each change runs on its own savepoint: one that fails is
    reported and skipped.
  - Data: rows missing locally, found by primary key and copied parents first; rows
    already there are kept (ON CONFLICT DO NOTHING); rows whose parent is not copied are
    skipped, never left orphaned; "last 30 / 7 days" filter when the table has a date
    column; sequences moved past the copied ids; tables over a million rows left out by
    default.
  - Personal data (emails, names, phones, addresses, IPs, IBAN…) detected by column name
    and anonymized while copying, deterministically (unique values stay unique).
  - The source is only read, in one READ ONLY snapshot; only a database on the local
    server can be written (local server flag and an address on this computer: a remote
    database is never offered as a target, so never overwritten), from a database of the
    same project, and it is backed up first (on by default). The source is remembered per
    database.
  - MCP `compare_databases`: what a database lacks compared to another (schema additions,
    destructive differences, missing rows per table, personal data columns, optional
    SQL), both only read — e.g. "how far is my local copy behind prod?".
- **Extension catalog** (⋯ menu of a local database, or Settings → PostgreSQL): about 90
  extensions by category (AI & vectors, geography, search, data types, analytics,
  scheduling, performance, security, integrations, development), with search and a
  description each. Besides the extensions already on the server, the catalog lists
  well-known ones to add: pgvector, PostGIS, pgRouting, pg_cron, pg_partman, TimescaleDB,
  Citus, HypoPG, pgAudit, pg_repack…
  - With a Homebrew PostgreSQL, "Install" runs `brew install` and enables the extension.
  - On Linux (Debian / Ubuntu, Fedora, PGDG for RHEL-like), "Install" installs the
    package with one system password prompt, as in the onboarding, then enables it.
    Without a graphical prompt, the exact command for the server's version is shown.
  - Extensions loaded at startup (pg_cron, pgAudit, TimescaleDB, pg_stat_statements…) are
    added to `shared_preload_libraries` with `ALTER SYSTEM`, and PostgreSQL can be
    restarted from the dialog; extensions waiting for the restart are enabled afterwards.
  - Removing an extension asks for confirmation (its types and functions are dropped).
    It no longer removes the library from `shared_preload_libraries`, which other
    databases of the server may use.
- **Cloud databases in the add dialog**: "Quick connect" becomes "Where do I find the URL?",
  a step-by-step guide for Supabase, Neon, Railway and Render with a button to their
  dashboard, and a Paste button (the clipboard is read only on that click).
  - The host is recognized from the URL (also AWS RDS and Scaleway) and SSL is turned on
    when the URL does not set it.
  - Pooled URLs that break pg_dump (Supabase port 6543, Neon `-pooler` host) are flagged,
    with a one-click switch to the session pooler / direct connection.
  - A password placeholder left in the URL (`[YOUR-PASSWORD]`) is flagged.
  - **Neon account**: with a Neon API key, pick the project, branch and database; bbdump
    fetches the direct (non-pooled) connection URL, password included. The key is only
    used to read, kept encrypted in `cloud-credentials.json` next to the config (0600,
    `config.json` unchanged), and "Forget the key" deletes it.

### Changed

- **French: "tu" everywhere.** About 125 texts still used "vous" (introduction, database
  viewer, confirmations, Settings, installer messages) next to dialogs in "tu"; all now
  use "tu". Confirmations are shorter ("Supprimer la sauvegarde « … » ? C'est
  irréversible." instead of "Êtes-vous sûr de vouloir…"). English is unchanged.

- **Settings page redone**: sections listed on the left (General, Usage mode, Backups,
  Security, AI assistants, local PostgreSQL) and followed while scrolling; the same row
  everywhere, the same switches (amber or red when the setting is risky).
  - **Appearance**: light, dark or system (shared with the sidebar button).
  - Default backup folder with "Show in Finder"; the encryption key shows whether it
    exists and why to export it; importing a key now asks first (it replaces the current
    one, and passwords saved with it can no longer be read).
  - Clearer texts for write queries in the SQL editor and for letting AI assistants
    change data without asking.

- **Home page cards redone** (the 3D scene keeps its exact place and size):
  - **Status** is now real: failed or missed backups, an invalid schedule, no automatic
    backup, or bbdump not starting at login, the most serious first (it always said
    "Healthy"); a backup in progress shows here too.
  - **Databases**: local / remote, and how many are backed up automatically.
  - **Last backup** (which database, when, failed or not) and the next one.
  - **Backup storage**: total, files, databases, and the largest.
  - Each card opens the matching page; the cards refresh when a backup starts or ends.

- **Tasks page redone**: the next backup, how many are scheduled, off or failing, then
  each scheduled database in run order with its schedule in words ("Every day at 02:00",
  "Monday to Friday at 00:00"), the next run ("in 6 h · tomorrow 00:00"), the last runs
  (successes and failures, with the error), retention, verification and encryption, and
  Back up now / on-off / edit. Databases with automatic backups off are listed below with
  "Turn on" and "Set up".
  - A missed scheduled backup is flagged; while bbdump does not start at login, a banner
    says scheduled backups only run while it is open, with a button to change that.
  - Paused databases were missing from the page (it only listed running timers), so its
    "Paused" status could never show.
  - Every backup run (manual, scheduled, caught up; success or failure, duration, size) is
    kept in `backup-history.json` next to the config (last 30 per database; `config.json`
    unchanged). Removing a database from bbdump removes its history.
- **Backups page redone**: files grouped by database (latest first) with each group's
  count, size and retention, and Back up now; per file the date ("today 17:34", "31 min
  ago"), size, encryption, then Restore, Show in Finder, Export a copy, Delete. Several
  files (or a whole group) can be selected and deleted at once. The page refreshes when a
  backup ends.

- **Logs page redone** for speed and reading:
  - Only the rows on screen are drawn: 20,000 entries open in about a quarter of a second
    and scroll without lag (the page used to draw up to 10,000 rows at once).
  - **Live**: new entries appear as they are written; only what was added since the last
    read is fetched, and a reader scrolled down keeps their place ("↑ 3 new").
  - One line per entry with a separator per day; clicking it (or ↑ ↓) shows the whole
    message, full date and a Copy button in a panel below.
  - Level filter with counts, database filter, search highlighted in the results.
  - Multi-line messages (stack traces, pg_dump output) are one entry again: their next
    lines were shown as separate entries dated "now".
  - "Show in Finder" opens the log file; "Clear" also deletes the older rotated files.

- **Info page redone** in the style of Settings: the version and its update status (when it
  was last checked, download, install, release notes; on macOS and .deb, a note that the
  new version is installed from its page), the environment (system, pg_dump, Electron)
  with "Copy diagnostic info" (versions only, no database) and "Report a problem", where
  bbdump keeps its files with "Show in Finder", and the project's links.
  - A failed update check showed "bbdump is up to date"; it now says it failed, and why.
- **Notifications (toasts) redesigned**: a plain card like the dialogs, light and dark, newest
  on top, at most four. Hovering one keeps it on screen. Errors stay longer and show the
  technical detail (PostgreSQL's message…) on its own line, selectable; the same message
  shown again is counted (×2) instead of stacking. Screen readers announce them.
- **Notification texts made consistent** (about 140, English and French): short ("Backup
  deleted", "Couldn't delete the backup"), no "successfully" or exclamation marks, French
  in "tu" like the rest of the app. Mistakes in a form are warnings, not errors.
  - A finished or failed backup now names the database, and a failed one shows why.
  - Deleting a local database that PostgreSQL refused to drop no longer shows both a
    warning and "deleted": only the warning, with the reason.
  - "View →" on the update notification was always in English.

- **Database dialogs redesigned** in the onboarding's language, light and dark: one shell
  (header, step bars or a section rail, footer with Enter to continue), the same fields
  everywhere and a single green accent.
  - Add a remote database: Method → Connection → Backup steps. Retention and backup
    verification are now offered when adding (they were only in Edit), and file
    encryption moved from the connection step to the backup step.
  - Edit: Connection / Backup / Schedule rail instead of one long scroll; SSL options are
    shown in URL mode too; opening from the tasks page lands on Schedule.
  - Test connection in both (server version and table count); while editing, an empty
    password field means "unchanged" and the test uses the saved password, decrypted in
    the main process only. The masked password is no longer shown as the field value.
  - Create a local database: errors shown under the field as you type, existing names
    refused, custom project colours shown, progress in place of the form.
  - The other dialogs use the same shell: project, confirmations, duplicate, restore
    (Target → Confirmation steps, with Back), extensions, proxy activity, local server
    password and query details.
  - Local server password: a wrong password is shown under the field instead of a toast.
- **Database list**: each card keeps Backup and View; Copy URL, Duplicate, Edit and
  Delete / Disconnect are in a ⋯ menu (same labels and order). Cards and drag and drop
  are unchanged.
- **Project proxy**: the header shows a pill `:port → database` (green when running,
  amber when it needs a target). Clicking it opens the switch: your app → the stable
  URL (click to copy) → the project's databases, where one click changes the target.
  Status, connections, port, logs and the on/off switch sit underneath. The radio
  buttons on the cards are gone; the routed database carries a "proxy" badge and the
  others offer "Set as proxy target" in their menu. The proxy configuration is unchanged.
- **Linux:** backups go to `~/Documents/bbdump` by default for new setups, instead of the
  hidden `~/.config/bbdump/backups`. Existing configurations are not changed.
- Electron 28 → 44, electron-builder 26, node-cron 4; all dependency advisories resolved.
- The packaged MCP server ships with its dependencies (production only) and its own
  `package.json`.
- GitHub Actions: CI on every push/PR, and a manual workflow that builds release artifacts.
- `config.json` is written atomically, with a `config.json.bak` copy; an unreadable file is
  set aside and restored from the backup instead of being overwritten.
- Update checks only report strictly newer versions.
