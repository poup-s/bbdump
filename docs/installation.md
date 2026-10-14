# Installation

bbdump runs on **macOS 13 or later** (Apple Silicon and Intel) and on **Linux** (beta, x64 and arm64).

## Quick install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash
```

The script detects your platform, downloads the latest release, checks it against the sha512 published with the release, and installs it:

- **macOS**: copies `bbdump.app` to `/Applications` and removes the quarantine flag, so the app opens without the unsigned-app warning. It then installs Homebrew if needed, and PostgreSQL 17 (16 as a fallback) with Homebrew, and starts the service.
- **Linux**: copies the AppImage to `~/.local/bin/bbdump`, adds a shortcut to the applications menu, warns if FUSE (`libfuse2`) is missing, then installs PostgreSQL with `apt`, `dnf`, `yum` or `pacman` (asks for `sudo`) and starts it. On Debian/Ubuntu it also installs the `pg_dump` matching the server's version.

If bbdump is running, it is closed before being replaced and reopened on the new version. If bbdump is already installed, the script asks whether to reinstall/update or uninstall.

### Options

| Flag / variable | Effect |
|-----------------|--------|
| `--no-deps` or `BBDUMP_NO_DEPS=1` | Install the app only: no Homebrew, no PostgreSQL |
| `--uninstall` | Go straight to the uninstaller |
| `BBDUMP_VERSION=1.2.1` | Install this version instead of the latest |
| `BBDUMP_NO_ANIM=1` | No animations in the terminal |

```bash
# App only (e.g. you only use remote databases and already have the client tools)
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash -s -- --no-deps

# A given version
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | BBDUMP_VERSION=1.2.1 bash
```

> The script installs a full PostgreSQL server. If you only work with remote databases, use `--no-deps` and install just the client tools (see [PostgreSQL client tools](#postgresql-client-tools)).

## From a release

Download the latest release from [GitHub Releases](https://github.com/poup-s/bbdump/releases):

| Platform | File |
|----------|------|
| macOS 13+ (Apple Silicon) | `bbdump-*-arm64.dmg` |
| macOS 13+ (Intel) | `bbdump-*.dmg` |
| Linux x64 (beta) | `bbdump-*-x86_64.AppImage` or `bbdump-*.deb` |
| Linux arm64 (beta) | `bbdump-*-arm64.AppImage` |

### macOS

1. Open the DMG and drag bbdump to **Applications**.
2. The app is not code-signed yet, so macOS blocks the first launch. Right-click the app, choose **Open**, then confirm. Or run:

```bash
xattr -cr /Applications/bbdump.app
```

This is needed once: later versions install themselves from the app (see [Updates](#updates)).

### Linux

**AppImage:**

```bash
chmod +x bbdump-*.AppImage
./bbdump-*.AppImage
```

AppImages need FUSE 2 (`sudo apt install libfuse2` on Debian/Ubuntu).

**Debian/Ubuntu (.deb):**

```bash
sudo apt install ./bbdump-*.deb
```

## First launch

A short setup guides you through:

1. **Usage mode**: *PostgreSQL on this computer* (bbdump installs or uses a local server to create and restore databases here; remote databases work too) or *Remote databases only* (client tools only, no server). You can switch later in **Settings → Usage mode**.
2. **This machine**: checks the PostgreSQL client tools and, in local mode, the server. Missing pieces can be installed from there (Homebrew on macOS; your system password is asked once).
3. **Your data**: pick the local databases to manage or paste the URL of a first remote database, then the default backup folder.
4. **AI**: optionally connect your AI assistants to bbdump's MCP server.

The setup can be replayed from **Settings → General → Introduction**. See [Quick Start](quick-start.md) for what comes next.

## PostgreSQL client tools

bbdump uses `pg_dump`, `pg_restore` and `psql`. It looks for them in your `PATH` and in the usual Homebrew folders, and picks the `pg_dump` that matches each server's version when several are installed.

```bash
# macOS
brew install libpq            # client tools only
brew install postgresql@17    # server + client tools

# Debian/Ubuntu
sudo apt install postgresql-client
```

## From source

Prerequisites: **Node.js 22.12+** and the PostgreSQL client tools.

```bash
git clone https://github.com/poup-s/bbdump.git
cd bbdump
npm install
npm run dev        # build, then launch Electron
```

In development (app not packaged), bbdump keeps its data in the repository folder instead of the usual data folder.

### Build packages

```bash
npm run build          # TypeScript + Vite
npm test               # tests (no database or network needed)
npm run dist:mac       # macOS: DMG + ZIP, Apple Silicon and Intel
npm run dist:linux     # Linux: AppImage (x64, arm64) + deb (x64)
```

Packages are written to `release/`.

## Updates

bbdump checks for a new version on GitHub at launch, and from **About → Check now**. When one is available, a notification points to the About page, where you download it, then **Install and restart**.

| Install | Update |
|---------|--------|
| macOS (1.1.2 and later) | In place: bbdump downloads the release zip, checks its sha512, replaces the app (the previous one is kept as `bbdump.previous.app` until the copy succeeds) and relaunches. This needs the app in a folder you can write to, such as `/Applications`; otherwise the release page opens. |
| macOS 1.0.2 – 1.1.1 | No in-place update: install 1.1.2 or later once by hand (or with the script). |
| Linux AppImage | In place: **Install and restart**, or at the next quit once downloaded. |
| Linux `.deb` | No automatic update: the release page opens, install the new `.deb`. |

Running the install script again also updates bbdump.

## Uninstalling

### With the script

```bash
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash -s -- --uninstall
```

You pick what to remove: the app, the Linux shortcut, PostgreSQL, Homebrew (macOS). Your data is not removed this way: delete it by hand (below).

### By hand

1. Quit bbdump (menu bar icon → Quit).
2. Remove the app:
   - macOS: move `/Applications/bbdump.app` to the Trash.
   - AppImage: `rm ~/.local/bin/bbdump` (and `~/.local/share/applications/bbdump.desktop`).
   - `.deb`: `sudo apt remove bbdump`.
3. Optionally remove your data (configuration, encryption key, history, logs). Export the encryption key first if you may need your encrypted backups again.

```bash
rm -rf ~/Library/Application\ Support/bbdump   # macOS
rm -rf ~/.config/bbdump                        # Linux
```

Backups stored outside these folders (your backup folder, e.g. `~/Documents/bbdump` on Linux) are not touched. If you turned on **Launch at login** or connected AI assistants, turn them off in Settings before uninstalling.
