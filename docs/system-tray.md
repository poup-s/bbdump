# Menu Bar

bbdump lives in the menu bar (macOS) or the system tray (Linux). Closing or minimizing the window keeps it running there: scheduled backups, project proxies and the MCP confirmations keep working.

<p>
  <img src="../captures/tray.webp" alt="Menu bar popup" width="300">
</p>

## The popup

Click the icon to open it. It shows:

- the number of databases;
- your **projects**, each with its databases (click a project to fold it), and the databases outside any project;
- for each database, the state of its last backup (dot: success, failure, in progress) and a button to **open it in the explorer**;
- when a project's proxy is on: its port and state (green: running, amber: no target yet), and a **radio button** on each database to switch the proxy target (with a confirmation);
- the number of **backups** and the space they take;
- **Open bbdump**, to bring back the main window.

Right-click the icon for **Open bbdump** and **Quit**.

Names hidden with **Mask** in the app stay hidden in the popup.

## AI change confirmation

When an AI assistant wants to change something through the MCP server (insert, update, delete, a write query, a new database, cancelling a query, undoing a change), the popup opens on its own and shows:

- the operation, the tool, the database and the table;
- what the change does, how many rows it touches, and whether an undo point will be saved;
- the SQL.

Choose **Approve** or **Deny**. Without an answer within **60 seconds**, the change is refused. If bbdump was closed, the MCP server starts it (hidden) to ask you.

**Always allow (disable confirmations)** approves this change and turns confirmations off for the following ones. It is the same setting as **Settings → AI assistants (MCP) → Let assistants change data without asking**, where you can turn confirmations back on. Changes made without asking are still recorded in the AI journal and can be undone.

## Data going to the AI

On a database with **Anonymize for AI** on, a result whose text columns cannot be traced to a table (a computed column such as `upper(email)`, a view, free SQL) is shown to you before it goes to the assistant. The popup lists:

- the database and the number of rows;
- each column with its origin: **anonymized** (a column you chose), **computed or view** (unknown origin), or plain;
- a few values per column, so you can judge. These values stay on your computer.

Columns that are checked are anonymized; anonymized and unknown columns are checked by default, and you can check or uncheck any of them. Then:

- **Send**: the result goes to the assistant with the checked columns anonymized;
- **Anonymize all**: every column is anonymized;
- **Block**: the assistant gets nothing, and is told not to ask again.

Without an answer within **60 seconds**, the result is sent with the checked columns anonymized. This popup also appears when confirmations of changes are turned off.

See [MCP Server](mcp-server.md#personal-data-anonymized-for-ai) for what is anonymized and how.

## Start at login

**Settings → General → Launch at login** starts bbdump hidden in the menu bar when you log in, so scheduled backups run without opening the app. Backups missed while bbdump was closed run at launch.

On macOS this uses the system login items; on Linux, an autostart entry (`~/.config/autostart/bbdump.desktop`).
