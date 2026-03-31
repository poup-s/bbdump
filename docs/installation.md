# Installation

## Quick Install (recommended)

Install bbdump with a single command. The script detects your platform, downloads the latest release, installs PostgreSQL if needed, and sets everything up.

```bash
curl -fsSL https://poups.dev/bbdump.sh | bash | bash
```

**Options:**

| Flag / Variable | Description |
|-----------------|-------------|
| `BBDUMP_VERSION=1.2.2` | Install a specific version |
| `--no-deps` | Skip PostgreSQL installation |
| `--uninstall` | Uninstall bbdump (interactive component selection) |

**Examples:**

```bash
# Install a specific version
BBDUMP_VERSION=1.2.2 curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash

# Install without dependencies
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash -s -- --no-deps

# Uninstall
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash -s -- --uninstall
```

The installer handles:
- **macOS** — Downloads DMG, installs to `/Applications`, installs PostgreSQL via Homebrew, removes quarantine flag
- **Linux** — Downloads AppImage to `~/.local/bin`, creates desktop shortcut, installs PostgreSQL via apt/dnf/pacman, checks FUSE dependency

## From Release (manual)

Download the latest release for your platform from [GitHub Releases](https://github.com/poup-s/bbdump/releases).

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `bbdump-*-arm64.dmg` |
| macOS (Intel) | `bbdump-*.dmg` |
| Linux | `bbdump-*.AppImage` or `bbdump-*.deb` |

### macOS

1. Download the `.dmg` file matching your architecture
2. Open the DMG and drag bbdump to your Applications folder
3. On first launch, macOS will block the app because it is not code-signed

**To allow the app to run**, either:
- Right-click the app > **Open** > confirm in the dialog
- Or run the following command in Terminal:

```bash
xattr -cr /Applications/bbdump.app
```

### Linux

**AppImage:**

```bash
chmod +x bbdump-*.AppImage
./bbdump-*.AppImage
```

**Debian/Ubuntu (.deb):**

```bash
sudo dpkg -i bbdump-*.deb
```

## From Source

### Prerequisites

- **Node.js** 18 or later
- **PostgreSQL client tools** — `pg_dump` and `pg_restore` must be available in your PATH
  - macOS: `brew install postgresql` or `brew install libpq`
  - Linux: `sudo apt install postgresql-client`

### Build and Run

```bash
git clone https://github.com/poup-s/bbdump.git
cd bbdump
npm install
npm run dev
```

This compiles TypeScript (main process), builds the Vue renderer with Vite, and launches Electron.

### Package for Distribution

```bash
npm run dist           # Current platform
npm run dist:mac       # macOS (DMG, arm64 + x64)
npm run dist:linux     # Linux (AppImage + deb)
```

Output files are written to the `release/` directory.

## Auto-Updates

bbdump checks for updates automatically on launch via GitHub Releases. When a new version is available, a notification appears with download progress. The update is installed automatically when you quit the app.

## Uninstalling

### Via the installer (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash -s -- --uninstall
```

The interactive uninstaller lets you select which components to remove: app, desktop shortcut, PostgreSQL, Homebrew (macOS), and user data.

### Manual

**macOS:**

1. Quit bbdump
2. Move `bbdump.app` from Applications to Trash
3. Optionally remove user data: `rm -rf ~/.bbdump`

**Linux:**

```bash
# AppImage — just delete the file
rm ~/.local/bin/bbdump

# deb
sudo dpkg -r bbdump

# Remove user data (optional)
rm -rf ~/.bbdump
```
