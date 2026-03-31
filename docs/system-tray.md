# System Tray

bbdump lives in your menu bar (macOS) or system tray (Linux) for quick access without opening the full application.

## Overview

The tray popup provides a compact view of your databases organized by project. It shows:

- Total number of databases and their connection status
- Total backup count and storage used
- All projects with their databases

## Features

### Quick Actions

Each database in the tray has a backup button to trigger an immediate backup without opening the main window.

### Proxy Status

When a project has its proxy enabled:

- The project row shows the proxy port (e.g. `:54321`)
- The proxy target database is highlighted
- Click the dropdown arrow to expand/collapse the project's databases

### MCP Confirmation

When Claude requests a mutation through the MCP server, the confirmation prompt appears directly in the tray popup:

- The requested SQL operation is displayed
- **Approve** or **Deny** buttons
- 60-second countdown timer
- The tray icon flashes to get your attention

### Open Full App

Click **Open bbdump** at the bottom of the tray popup to open the main application window.

## Tray Icon

The tray icon indicates the app is running in the background. bbdump continues to:

- Execute scheduled backup tasks
- Serve proxy connections
- Listen for MCP requests

Even when the main window is closed.
