# bbdump

<img src="logo.png" alt="bbdump logo" width="100">

A cross-platform desktop application for managing PostgreSQL databases — backups, restores, scheduling, encryption, data browsing, and more.

Built with Electron, Vue 3, and Tailwind CSS.

## Features

- **Backup & Restore** — Manual and scheduled (cron) backups using `pg_dump`/`pg_restore`, with support for custom format, plain SQL, and compression
- **Database Viewer** — Browse tables, edit rows, inspect schemas, view relations (Vue Flow graph), and monitor performance stats
- **Proxy Server** — Built-in TCP proxy per project to route local connections to any configured database
- **Encryption** — AES-256-GCM encryption for stored passwords and backup files
- **Project Organization** — Group databases into projects with color coding and drag-and-drop
- **Scheduling** — Visual cron editor with presets, manual mode, and per-database play/pause controls
- **Database Duplication** — Clone databases across servers with a single click
- **Local DB Creation** — Create and manage local PostgreSQL databases directly from the app
- **Cross-platform** — macOS (Apple Silicon + Intel), Windows, and Linux
- **i18n** — English and French

## Installation

### From Release (recommended)

Download the latest release for your platform from [GitHub Releases](https://github.com/poup-s/bbdump/releases):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `bbdump-*-arm64.dmg` |
| macOS (Intel) | `bbdump-*.dmg` |
| Windows | `bbdump-*.exe` |
| Linux | `bbdump-*.AppImage` or `bbdump-*.deb` |

**macOS note:** The app is not code-signed. On first launch, right-click the app and select "Open", then confirm. Alternatively, remove the quarantine flag:

```bash
xattr -cr /Applications/bbdump.app
```

### From Source

```bash
git clone https://github.com/poup-s/bbdump.git
cd bbdump
npm install
npm run dev
```

**Prerequisites:** Node.js 18+, PostgreSQL client tools (`pg_dump` in PATH).

## Building

```bash
npm run build          # Compile TypeScript + Vite
npm run dist           # Build + package for current platform
npm run dist:mac       # macOS (DMG, arm64 + x64)
npm run dist:win       # Windows (NSIS + Portable)
npm run dist:linux     # Linux (AppImage + deb)
```

## Architecture

bbdump follows the standard Electron 3-layer model:

- **Main process** (`src/main/`) — Node.js backend handling database operations, backup execution, cron scheduling, encryption, and file I/O
- **Preload** (`src/preload/`) — Context bridge exposing safe IPC APIs to the renderer
- **Renderer** (`src/renderer/`) — Vue 3 SPA with Tailwind CSS

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.

## Configuration

All user data is stored in `~/.bbdump/`:

- `config.json` — Database connections and app settings
- `logs/app.log` — Application logs
- `.encryption.key` — AES-256 key (auto-generated, mode 600)

Databases can be configured through the UI or by pasting a PostgreSQL connection URL:

```
postgresql://user:password@host:port/database
```

## Security

- **AES-256-GCM** encryption for passwords (per-database opt-in, enabled by default)
- **Encryption key** auto-generated on first launch, stored with restricted permissions
- **Electron context isolation** enabled
- Backup files can be independently encrypted
- Export/import encryption keys for multi-machine setups

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License

[MIT](./LICENSE) — Copyright (c) 2024-2026 Poups
