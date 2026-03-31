#!/bin/bash
set -e

# bbdump installer
# Usage: curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/install.sh | bash
# Override: BBDUMP_VERSION=1.0.9 curl -fsSL ... | bash
# Skip deps: BBDUMP_NO_DEPS=1 curl -fsSL ... | bash
#        or: curl -fsSL ... | bash -s -- --no-deps
# Uninstall: curl -fsSL ... | bash -s -- --uninstall

REPO="poup-s/bbdump"
APP_NAME="bbdump"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
GITHUB_DL="https://github.com/${REPO}/releases/download"

# --- Parse arguments ---
SKIP_DEPS="${BBDUMP_NO_DEPS:-0}"
FORCE_UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-deps) SKIP_DEPS=1 ;;
    --uninstall) FORCE_UNINSTALL=1 ;;
  esac
done

# Animation toggles:
# - Disabled automatically on non-interactive terminals
# - Can be disabled manually: BBDUMP_NO_ANIM=1
if [ -t 1 ] && [ "${BBDUMP_NO_ANIM:-0}" != "1" ]; then
  ENABLE_ANIM=1
else
  ENABLE_ANIM=0
fi

# --- Palette: neon green / teal (aligned with website) ---
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors)" -ge 256 ] 2>/dev/null; then
  R='\033[0m'
  B='\033[1m'
  D='\033[2m'
  M='\033[38;5;48m'       # Neon green
  M2='\033[38;5;50m'      # Bright teal
  A='\033[38;5;86m'       # Mint accent
  G='\033[38;5;46m'       # Success green
  Y='\033[38;5;221m'      # Yellow
  E='\033[38;5;203m'      # Red
  T='\033[38;5;252m'      # Light gray
  T2='\033[38;5;245m'     # Muted
else
  R='\033[0m'
  B='\033[1m'
  D='\033[2m'
  M='\033[0;32m'
  M2='\033[1;36m'
  A='\033[1;32m'
  G='\033[0;32m'
  Y='\033[1;33m'
  E='\033[0;31m'
  T='\033[0;37m'
  T2='\033[2m'
fi

# --- Output ---
STEP_NUM=0
step() {
  STEP_NUM=$((STEP_NUM + 1))
  echo -e "\n  ${M}──[${B}${STEP_NUM}${R}${M}]──────────────────────────────────────────${R}"
  echo -e "  ${M}───▶${R} ${B}$1${R}"
}
info()    { echo -e "    ${T2}$1${R}"; }
success() { echo -e "    ${G}✓${R} $1"; }
warn()    { echo -e "    ${Y}⚠${R} $1"; }
error()   { echo -e "\n    ${E}✗ $1${R}" >&2; exit 1; }

sleep_if_anim() {
  if [ "$ENABLE_ANIM" -eq 1 ]; then
    sleep "$1"
  fi
}

type_line() {
  local text="$1"
  if [ "$ENABLE_ANIM" -eq 0 ]; then
    echo -e "$text"
    return
  fi

  local i ch
  for ((i = 0; i < ${#text}; i++)); do
    ch="${text:$i:1}"
    printf "%s" "$ch"
    sleep 0.006
  done
  printf "\n"
}

# --- Spinner ---
spinner_pid=""
spinner() {
  local msg="$1"
  [ "$ENABLE_ANIM" -eq 0 ] && return 0
  (
    while true; do
      for c in "${M}◐${R}" "${M}◓${R}" "${M2}◑${R}" "${A}◒${R}"; do
        printf "\r    %b %b${T2}%s${R}   " "$c" "" "$msg"
        sleep 0.12
      done
    done
  ) &
  spinner_pid=$!
}

stop_spinner() {
  [ "$ENABLE_ANIM" -eq 0 ] && return 0
  [ -n "$spinner_pid" ] && kill "$spinner_pid" 2>/dev/null; wait "$spinner_pid" 2>/dev/null || true
  printf "\r\033[K"
  spinner_pid=""
}

pulse_separator() {
  local line="────────────────────────────────────────────────────"
  if [ "$ENABLE_ANIM" -eq 0 ]; then
    echo -e "  ${T2}${line}${R}"
    return
  fi

  echo -ne "  ${T2}"
  for ((i = 0; i < ${#line}; i++)); do
    printf "%s" "${line:$i:1}"
    sleep 0.003
  done
  echo -e "${R}"
}

# --- Cleanup ---
TMP_DIR=""
cleanup() {
  stop_spinner
  if [ "$ENABLE_ANIM" -eq 1 ]; then
    printf "\033[?25h"
  fi
  [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# --- Intro / banner ---
banner() {
  echo ""
  echo -e "  ${M2}${B}██████╗ ██████╗ ██████╗ ██╗   ██╗███╗   ███╗██████╗ ${R}"
  echo -e "  ${M2}${B}██╔══██╗██╔══██╗██╔══██╗██║   ██║████╗ ████║██╔══██╗${R}"
  echo -e "  ${M}${B}██████╔╝██████╔╝██║  ██║██║   ██║██╔████╔██║██████╔╝${R}"
  echo -e "  ${M}${B}██╔══██╗██╔══██╗██║  ██║██║   ██║██║╚██╔╝██║██╔═══╝ ${R}"
  echo -e "  ${A}${B}██████╔╝██████╔╝██████╔╝╚██████╔╝██║ ╚═╝ ██║██║     ${R}"
  echo -e "  ${A}${B}╚═════╝ ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝     ╚═╝╚═╝     ${R}"
  echo -e "  ${T2}bbdump - PostgreSQL Manager${R}"
  echo ""
}

show_intro() {
  if [ "$ENABLE_ANIM" -eq 1 ]; then
    printf "\033[?25l"
    printf "  ${T2}initializing installer"
    for _ in 1 2 3; do
      printf "."
      sleep 0.18
    done
    printf "${R}\n"
  fi

  banner
  type_line "  Build with Love by Poups."
  pulse_separator
}

# --- Detect platform ---
detect_platform() {
  step "Detecting platform"

  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      error "Unsupported OS: $OS (macOS and Linux only)" ;;
  esac

  case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)             error "Unsupported architecture: $ARCH" ;;
  esac

  success "${B}${PLATFORM}${R} / ${B}${ARCH}${R}"
}

# --- Get latest version ---
get_latest_version() {
  step "Fetching latest version"

  if [ -n "$BBDUMP_VERSION" ]; then
    VERSION="$BBDUMP_VERSION"
    info "Using pinned version"
    success "v${VERSION}"
    return
  fi

  spinner "GitHub API…"
  local response
  response=$(curl -fsSL -H "User-Agent: bbdump-installer" "$GITHUB_API" 2>/dev/null) || true
  stop_spinner

  VERSION=$(echo "$response" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')

  # Fallback: scrape latest redirect if API fails (rate limit)
  if [ -z "$VERSION" ]; then
    info "API rate-limited, trying fallback…"
    spinner "Resolving latest version…"
    VERSION=$(curl -fsSI -H "User-Agent: bbdump-installer" "https://github.com/${REPO}/releases/latest" 2>/dev/null | grep -i "^location:" | sed -E 's|.*/tag/v?([^[:space:]]+).*|\1|' | tr -d '\r')
    stop_spinner
  fi

  [ -z "$VERSION" ] && error "Could not get version. Try: BBDUMP_VERSION=1.0.2 bash install.sh"
  VERSION="${VERSION#v}"

  success "v${VERSION}"
}

# --- Build download URL ---
build_download_url() {
  case "$PLATFORM" in
    macos)
      [ "$ARCH" = "arm64" ] && FILENAME="${APP_NAME}-${VERSION}-arm64.dmg" || FILENAME="${APP_NAME}-${VERSION}.dmg"
      ;;
    linux)
      [ "$ARCH" = "x64" ] && LINUX_ARCH="x86_64" || LINUX_ARCH="$ARCH"
      FILENAME="${APP_NAME}-${VERSION}-${LINUX_ARCH}.AppImage"
      ;;
  esac
  DOWNLOAD_URL="${GITHUB_DL}/${VERSION}/${FILENAME}"
}

# --- Download ---
download() {
  step "Downloading ${APP_NAME} v${VERSION}"
  info "${T2}${DOWNLOAD_URL}${R}"
  echo ""

  TMP_DIR=$(mktemp -d)
  DOWNLOAD_PATH="${TMP_DIR}/${FILENAME}"

  # Try to get file size for custom progress bar
  local total_size
  total_size=$(curl -sIL "$DOWNLOAD_URL" | grep -i "content-length" | tail -n 1 | awk '{print $2}' | tr -d '\r')

  echo -e "    ${T2}┌──────────────────────────────────────────────────┐${R}"

  # Fallback to standard curl progress if total_size cannot be determined or animations disabled
  if ! [[ "$total_size" =~ ^[0-9]+$ ]] || [ "$ENABLE_ANIM" -eq 0 ]; then
    if curl -fSL --progress-bar -o "$DOWNLOAD_PATH" "$DOWNLOAD_URL"; then
      echo -e "    ${T2}└──────────────────────────────────────────────────┘${R}"
      echo ""
      success "Download complete"
    else
      echo -e "    ${T2}└──────────────────────────────────────────────────┘${R}"
      error "Download failed. Version ${VERSION} may not exist for ${PLATFORM}/${ARCH}."
    fi
    return
  fi

  # Custom animated progress bar
  curl -fSL "$DOWNLOAD_URL" -o "$DOWNLOAD_PATH" > /dev/null 2>&1 &
  local curl_pid=$!

  printf "    ${T2}│${R}                                                  ${T2}│${R}   0%%\r"

  while kill -0 "$curl_pid" 2>/dev/null; do
    local current_size=0
    if [ -f "$DOWNLOAD_PATH" ]; then
      current_size=$(wc -c < "$DOWNLOAD_PATH" | tr -d ' ')
    fi

    local pct=$(( current_size * 100 / total_size ))
    [ "$pct" -gt 100 ] && pct=100
    local filled=$(( pct / 2 ))
    local empty=$(( 50 - filled ))

    local bar_filled=""
    local i
    for ((i=0; i<filled; i++)); do bar_filled="${bar_filled}█"; done
    local bar_empty=""
    for ((i=0; i<empty; i++)); do bar_empty="${bar_empty} "; done

    printf "\r    ${T2}│${R}${G}%s${R}%s${T2}│${R} %3d%%" "$bar_filled" "$bar_empty" "$pct"
    sleep 0.1
  done

  wait "$curl_pid"
  local status=$?

  if [ $status -eq 0 ]; then
    local bar_filled=""
    local i
    for ((i=0; i<50; i++)); do bar_filled="${bar_filled}█"; done
    printf "\r    ${T2}│${R}${G}%s${R}${T2}│${R} 100%%\n" "$bar_filled"
    echo -e "    ${T2}└──────────────────────────────────────────────────┘${R}"
    echo ""
    success "Download complete"
  else
    printf "\n"
    error "Download failed. Version ${VERSION} may not exist for ${PLATFORM}/${ARCH}."
  fi
}

# --- Install macOS ---
install_macos() {
  step "Installing to /Applications"

  local mount_point

  spinner "Mounting DMG…"
  mount_point=$(hdiutil attach "$DOWNLOAD_PATH" -nobrowse -quiet 2>/dev/null | grep "/Volumes" | sed 's/.*\(\/Volumes\/.*\)/\1/' | head -1)
  [ -z "$mount_point" ] && mount_point=$(ls -d /Volumes/${APP_NAME}* 2>/dev/null | head -1)
  stop_spinner

  [ -z "$mount_point" ] || [ ! -d "$mount_point" ] && error "Could not mount DMG"

  local app_source="${mount_point}/${APP_NAME}.app"
  local install_path="/Applications/${APP_NAME}.app"

  [ ! -d "$app_source" ] && { hdiutil detach "$mount_point" -quiet 2>/dev/null || true; error "${APP_NAME}.app not found in DMG"; }

  xattr -cr "$app_source" 2>/dev/null || true

  # Replace existing
  [ -d "$install_path" ] && { warn "Replacing existing…"; rm -rf "$install_path"; }

  spinner "Copying…"
  cp -R "$app_source" "$install_path"
  stop_spinner

  xattr -cr "$install_path" 2>/dev/null || true
  hdiutil detach "$mount_point" -quiet 2>/dev/null || true

  success "Installed to /Applications/${APP_NAME}.app"
}

# --- Check FUSE (Linux) ---
check_fuse() {
  if ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then return 0; fi
  if [ -f /usr/lib/libfuse.so.2 ] || [ -f /usr/lib/x86_64-linux-gnu/libfuse.so.2 ]; then return 0; fi

  echo ""
  warn "FUSE is required for AppImages (libfuse2)"
  echo ""
  echo -e "    ${T2}Install:${R}"
  if command -v apt >/dev/null 2>&1; then
    echo -e "      ${B}sudo apt install libfuse2${R}"
  elif command -v dnf >/dev/null 2>&1; then
    echo -e "      ${B}sudo dnf install fuse-libs${R}"
  elif command -v pacman >/dev/null 2>&1; then
    echo -e "      ${B}sudo pacman -S fuse2${R}"
  else
    echo -e "      ${B}Install libfuse2 via your package manager${R}"
  fi
  echo ""
  echo -e "    ${T2}Then:${R} ${B}${APP_NAME}${R}"
}

# --- Install Linux ---
install_linux() {
  step "Installing to ~/.local/bin"

  local install_dir="$HOME/.local/bin"
  local install_path="${install_dir}/${APP_NAME}"

  check_fuse

  [ ! -d "$install_dir" ] && { mkdir -p "$install_dir"; info "Created ${install_dir}"; }
  [ -f "$install_path" ] && { warn "Replacing existing…"; rm -f "$install_path"; }

  cp "$DOWNLOAD_PATH" "$install_path"
  chmod +x "$install_path"

  success "Installed to ${install_path}"

  if ! echo "$PATH" | grep -q "$install_dir"; then
    echo ""
    warn "~/.local/bin is not in PATH"
    echo -e "    ${T2}Add to ~/.bashrc or ~/.zshrc:${R}"
    echo -e "      ${B}export PATH=\"\$HOME/.local/bin:\$PATH\"${R}"
  fi

  # Create desktop shortcut
  create_desktop_entry "$install_path"
}

# --- Create .desktop entry (Linux) ---
create_desktop_entry() {
  local exec_path="$1"
  local icon_dir="$HOME/.local/share/icons/hicolor/256x256/apps"
  local icon_path="${icon_dir}/${APP_NAME}.png"
  local desktop_dir="$HOME/.local/share/applications"
  local desktop_path="${desktop_dir}/${APP_NAME}.desktop"

  step "Creating application shortcut"

  # Extract icon from AppImage
  mkdir -p "$icon_dir"
  local pixmaps_dir="$HOME/.local/share/pixmaps"
  mkdir -p "$pixmaps_dir"
  local icon_extracted=0
  spinner "Extracting icon…"

  # Method 1: Extract from AppImage using --appimage-extract
  if [ -f "$exec_path" ]; then
    local tmp_extract="/tmp/bbdump-icon-extract-$$"
    rm -rf "$tmp_extract"
    mkdir -p "$tmp_extract"
    (cd "$tmp_extract" && "$exec_path" --appimage-extract "*.png" >/dev/null 2>&1) || true
    # Look for the app icon in extracted files
    local extracted_icon=""
    for f in "$tmp_extract/squashfs-root/${APP_NAME}.png" "$tmp_extract/squashfs-root/"*.png; do
      if [ -f "$f" ]; then
        extracted_icon="$f"
        break
      fi
    done
    if [ -n "$extracted_icon" ] && [ -f "$extracted_icon" ]; then
      cp "$extracted_icon" "$icon_path"
      cp "$extracted_icon" "${pixmaps_dir}/${APP_NAME}.png"
      icon_extracted=1
    fi
    rm -rf "$tmp_extract"
  fi

  # Method 2: Download from GitHub release assets
  if [ "$icon_extracted" -eq 0 ]; then
    if curl -fsSL "https://github.com/${REPO}/releases/download/${VERSION}/logo.png" -o "$icon_path" 2>/dev/null; then
      cp "$icon_path" "${pixmaps_dir}/${APP_NAME}.png"
      icon_extracted=1
    fi
  fi

  stop_spinner

  # Use icon theme name (not absolute path) so GNOME launcher resolves it properly
  local icon_name="${APP_NAME}"
  if [ "$icon_extracted" -eq 1 ]; then
    success "Icon installed"
  else
    warn "Could not extract icon — shortcut will use a generic icon"
    icon_name="utilities-terminal"
  fi

  # Create .desktop file
  mkdir -p "$desktop_dir"
  cat > "$desktop_path" <<DESKTOP
[Desktop Entry]
Name=bbdump
Comment=PostgreSQL Backup Manager
Exec=${exec_path} %U
Icon=${icon_name}
Type=Application
Terminal=false
Categories=Development;Database;
Keywords=postgresql;backup;database;dump;
StartupWMClass=bbdump
DESKTOP

  chmod +x "$desktop_path"

  # Validate .desktop file if desktop-file-validate is available
  if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$desktop_path" 2>/dev/null || true
  fi

  # Update desktop database
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$desktop_dir" 2>/dev/null || true
  fi

  # Refresh icon cache so the icon appears immediately
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  fi

  # On GNOME, also refresh the app list
  if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database "$HOME/.local/share/mime" 2>/dev/null || true
  fi

  success "Shortcut added to applications menu"
}

# --- Install dependencies: Homebrew (macOS) ---
install_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    success "Homebrew already installed"
    BREW_CMD="brew"
    return 0
  fi

  # Check common Homebrew paths not in PATH
  if [ "$ARCH" = "arm64" ] && [ -x /opt/homebrew/bin/brew ]; then
    success "Homebrew found at /opt/homebrew/bin/brew"
    BREW_CMD="/opt/homebrew/bin/brew"
    return 0
  elif [ -x /usr/local/bin/brew ]; then
    success "Homebrew found at /usr/local/bin/brew"
    BREW_CMD="/usr/local/bin/brew"
    return 0
  fi

  info "Installing Homebrew…"
  spinner "Downloading Homebrew…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null 2>&1 || {
    stop_spinner
    warn "Homebrew auto-install failed — install manually:"
    echo -e "      ${B}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"${R}"
    return 1
  }
  stop_spinner

  # Determine brew path after install
  if [ "$ARCH" = "arm64" ] && [ -x /opt/homebrew/bin/brew ]; then
    BREW_CMD="/opt/homebrew/bin/brew"
  elif [ -x /usr/local/bin/brew ]; then
    BREW_CMD="/usr/local/bin/brew"
  else
    BREW_CMD="brew"
  fi

  success "Homebrew installed"
}

# --- Install dependencies: PostgreSQL (macOS via Homebrew) ---
install_deps_macos() {
  step "Installing dependencies (macOS)"

  install_homebrew || return 0

  # Check if PostgreSQL is already installed via Homebrew
  if "$BREW_CMD" list postgresql@17 >/dev/null 2>&1 || "$BREW_CMD" list postgresql@16 >/dev/null 2>&1; then
    success "PostgreSQL already installed via Homebrew"
  else
    # Also check if pg_dump/psql/postgres are available from any source
    if command -v pg_dump >/dev/null 2>&1 && command -v psql >/dev/null 2>&1 && command -v postgres >/dev/null 2>&1; then
      success "PostgreSQL tools already available"
    else
      info "Installing PostgreSQL 17 via Homebrew…"
      spinner "brew install postgresql@17…"
      if "$BREW_CMD" install postgresql@17 >/dev/null 2>&1; then
        stop_spinner
        success "PostgreSQL 17 installed"
      else
        stop_spinner
        info "Trying PostgreSQL 16…"
        spinner "brew install postgresql@16…"
        if "$BREW_CMD" install postgresql@16 >/dev/null 2>&1; then
          stop_spinner
          success "PostgreSQL 16 installed"
        else
          stop_spinner
          warn "Could not install PostgreSQL via Homebrew"
          echo -e "      ${T2}Try manually:${R} ${B}brew install postgresql@17${R}"
          return 0
        fi
      fi
    fi
  fi

  # Clean up Homebrew download cache
  "$BREW_CMD" cleanup -s >/dev/null 2>&1 || true

  # Start PostgreSQL service
  local pg_version=""
  if "$BREW_CMD" list postgresql@17 >/dev/null 2>&1; then
    pg_version="postgresql@17"
  elif "$BREW_CMD" list postgresql@16 >/dev/null 2>&1; then
    pg_version="postgresql@16"
  fi

  if [ -n "$pg_version" ]; then
    if "$BREW_CMD" services list 2>/dev/null | grep -q "${pg_version}.*started"; then
      success "PostgreSQL service already running"
    else
      spinner "Starting PostgreSQL service…"
      "$BREW_CMD" services start "$pg_version" >/dev/null 2>&1 || true
      stop_spinner
      # Verify it started
      sleep 1
      if "$BREW_CMD" services list 2>/dev/null | grep -q "${pg_version}.*started"; then
        success "PostgreSQL service started"
      else
        warn "Could not auto-start PostgreSQL"
        echo -e "      ${T2}Start manually:${R} ${B}brew services start ${pg_version}${R}"
      fi
    fi
  fi
}

# --- Detect Linux package manager ---
# --- Pre-cache sudo credentials (needed for curl | bash where stdin is the pipe) ---
ensure_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    return 0  # Already root
  fi
  if sudo -n true 2>/dev/null; then
    return 0  # Already cached / NOPASSWD
  fi
  info "Root privileges required — please enter your password"
  sudo -v < /dev/tty
}

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    PKG_MGR="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MGR="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG_MGR="yum"
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MGR="pacman"
  else
    PKG_MGR=""
  fi
}

# --- Ensure pg_dump/pg_restore match the server version (Linux) ---
ensure_matching_client_tools() {
  # Detect the running PostgreSQL server version
  local server_version=""

  # Try psql to get server version
  if command -v psql >/dev/null 2>&1; then
    server_version=$(psql -h /var/run/postgresql -p 5432 -U postgres -t -c "SELECT version();" 2>/dev/null | grep -oP 'PostgreSQL \K\d+' || true)
    # Fallback: try with current user
    if [ -z "$server_version" ]; then
      server_version=$(psql -h /var/run/postgresql -p 5432 -t -c "SELECT version();" 2>/dev/null | grep -oP 'PostgreSQL \K\d+' || true)
    fi
  fi

  # Fallback: check installed server package versions
  if [ -z "$server_version" ]; then
    server_version=$(ls -d /usr/lib/postgresql/*/bin/postgres 2>/dev/null | sort -rV | head -1 | grep -oP '/usr/lib/postgresql/\K\d+' || true)
  fi

  if [ -z "$server_version" ]; then
    return 0
  fi

  info "PostgreSQL server version: ${server_version}"

  # Check if pg_dump matches the server version
  local pgdump_version=""
  if command -v pg_dump >/dev/null 2>&1; then
    pgdump_version=$(pg_dump --version 2>/dev/null | grep -oP '\d+' | head -1 || true)
  fi

  # Also check version-specific path
  local versioned_pgdump="/usr/lib/postgresql/${server_version}/bin/pg_dump"
  if [ -x "$versioned_pgdump" ]; then
    success "pg_dump ${server_version} available at ${versioned_pgdump}"
    return 0
  fi

  if [ "$pgdump_version" = "$server_version" ]; then
    success "pg_dump version matches server (v${server_version})"
    return 0
  fi

  # Version mismatch — install matching client tools
  warn "pg_dump v${pgdump_version:-unknown} does not match server v${server_version}"
  info "Installing postgresql-client-${server_version}…"
  ensure_sudo


  case "$PKG_MGR" in
    apt)
      # Check if the package is available in current repos
      if ! apt-cache show "postgresql-client-${server_version}" >/dev/null 2>&1; then
        # Add PostgreSQL official repository
        info "Adding PostgreSQL apt repository for version ${server_version}…"
        spinner "Adding PGDG repository…"
        sudo sh -c "echo 'deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main' > /etc/apt/sources.list.d/pgdg.list" 2>/dev/null || true
        curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg 2>/dev/null || true
        sudo DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
        stop_spinner
      fi
      spinner "Installing postgresql-client-${server_version}…"
      if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "postgresql-client-${server_version}" >/dev/null 2>&1; then
        stop_spinner
        success "postgresql-client-${server_version} installed"
      else
        stop_spinner
        warn "Could not install postgresql-client-${server_version}"
        echo -e "      ${T2}Install manually:${R} ${B}sudo apt install postgresql-client-${server_version}${R}"
      fi
      ;;
    dnf|yum)
      spinner "Installing postgresql${server_version}…"
      if sudo $PKG_MGR install -y "postgresql${server_version}" >/dev/null 2>&1; then
        stop_spinner
        success "postgresql${server_version} client installed"
      else
        stop_spinner
        warn "Could not install matching client — try manually"
      fi
      ;;
    pacman)
      # Arch uses a single postgresql package
      info "Arch Linux uses a single PostgreSQL package — client version matches server"
      ;;
  esac
}

# --- Install dependencies: PostgreSQL (Linux) ---
install_deps_linux() {
  step "Installing dependencies (Linux)"

  detect_pkg_manager
  ensure_sudo


  # Check if already installed
  if command -v pg_dump >/dev/null 2>&1 && command -v psql >/dev/null 2>&1 && command -v postgres >/dev/null 2>&1; then
    success "PostgreSQL tools already available"
    # Start service if not running
    local svc_started=0
    # Try versioned service names first (Debian/Ubuntu: postgresql@14-main etc.)
    for svc in $(systemctl list-unit-files 'postgresql*' --no-legend 2>/dev/null | awk '{print $1}'); do
      if systemctl is-active "$svc" >/dev/null 2>&1; then
        success "PostgreSQL service already running ($svc)"
        svc_started=1
        break
      fi
    done
    if [ "$svc_started" -eq 0 ]; then
      spinner "Starting PostgreSQL service…"
      # Try all detected service names
      for svc in $(systemctl list-unit-files 'postgresql*' --no-legend 2>/dev/null | awk '{print $1}') postgresql; do
        sudo systemctl start "$svc" 2>/dev/null && svc_started=1 && break || true
      done
      sudo systemctl enable postgresql 2>/dev/null || true
      stop_spinner
      if [ "$svc_started" -eq 1 ]; then
        success "PostgreSQL service started"
      else
        warn "Could not auto-start PostgreSQL"
        echo -e "      ${T2}Start manually:${R} ${B}sudo systemctl start postgresql${R}"
      fi
    fi
    # Ensure pg_dump version matches server version
    ensure_matching_client_tools
    return 0
  fi

  if [ -z "$PKG_MGR" ]; then
    warn "No supported package manager found"
    echo -e "      ${T2}Install PostgreSQL manually for your distribution${R}"
    return 0
  fi

  info "Installing PostgreSQL via ${PKG_MGR}…"

  case "$PKG_MGR" in
    apt)
      spinner "apt-get update…"
      sudo DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
      stop_spinner
      spinner "Installing postgresql…"
      if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib >/dev/null 2>&1; then
        stop_spinner
        success "PostgreSQL installed"
      else
        stop_spinner
        warn "Installation failed — try manually:"
        echo -e "      ${B}sudo apt-get install postgresql postgresql-contrib${R}"
        return 0
      fi
      ;;
    dnf)
      spinner "Installing postgresql…"
      if sudo dnf install -y postgresql-server postgresql-contrib >/dev/null 2>&1; then
        stop_spinner
        success "PostgreSQL installed"
        # Initialize database on RHEL/Fedora
        if [ ! -d /var/lib/pgsql/data ] || [ -z "$(ls -A /var/lib/pgsql/data 2>/dev/null)" ]; then
          spinner "Initializing database…"
          sudo postgresql-setup --initdb >/dev/null 2>&1 || true
          stop_spinner
        fi
      else
        stop_spinner
        warn "Installation failed — try manually:"
        echo -e "      ${B}sudo dnf install postgresql-server postgresql-contrib${R}"
        return 0
      fi
      ;;
    yum)
      spinner "Installing postgresql…"
      if sudo yum install -y postgresql-server postgresql-contrib >/dev/null 2>&1; then
        stop_spinner
        success "PostgreSQL installed"
        if [ ! -d /var/lib/pgsql/data ] || [ -z "$(ls -A /var/lib/pgsql/data 2>/dev/null)" ]; then
          spinner "Initializing database…"
          sudo postgresql-setup --initdb >/dev/null 2>&1 || true
          stop_spinner
        fi
      else
        stop_spinner
        warn "Installation failed — try manually:"
        echo -e "      ${B}sudo yum install postgresql-server postgresql-contrib${R}"
        return 0
      fi
      ;;
    pacman)
      spinner "Installing postgresql…"
      if sudo pacman -S --noconfirm postgresql >/dev/null 2>&1; then
        stop_spinner
        success "PostgreSQL installed"
        # Initialize on Arch
        if [ ! -d /var/lib/postgres/data ] || [ -z "$(ls -A /var/lib/postgres/data 2>/dev/null)" ]; then
          spinner "Initializing database…"
          sudo -u postgres initdb -D /var/lib/postgres/data >/dev/null 2>&1 || true
          stop_spinner
        fi
      else
        stop_spinner
        warn "Installation failed — try manually:"
        echo -e "      ${B}sudo pacman -S postgresql${R}"
        return 0
      fi
      ;;
  esac

  # Start and enable the service
  spinner "Starting PostgreSQL service…"
  # Try all detected service names
  local svc_started=0
  for svc in $(systemctl list-unit-files 'postgresql*' --no-legend 2>/dev/null | awk '{print $1}') postgresql; do
    sudo systemctl start "$svc" 2>/dev/null && svc_started=1 && break || true
  done
  sudo systemctl enable postgresql 2>/dev/null || true
  stop_spinner

  if [ "$svc_started" -eq 1 ] || systemctl is-active postgresql >/dev/null 2>&1; then
    success "PostgreSQL service started"
  else
    warn "Could not auto-start PostgreSQL"
    echo -e "      ${T2}Start manually:${R} ${B}sudo systemctl start postgresql${R}"
  fi

  # Ensure pg_dump version matches the server
  ensure_matching_client_tools
}

# --- Install dependencies (router) ---
install_dependencies() {
  if [ "$SKIP_DEPS" = "1" ]; then
    info "Skipping dependencies (--no-deps)"
    return 0
  fi

  case "$PLATFORM" in
    macos) install_deps_macos ;;
    linux) install_deps_linux ;;
  esac
}

# --- Success: minimal, confident ---
done_banner() {
  echo ""
  if [ "$ENABLE_ANIM" -eq 1 ]; then
    local f
    for f in \
      "${M2}◦${R} ${T2}deploying final touches...${R}" \
      "${A}◦${R} ${T2}deploying final touches...${R}" \
      "${M}◦${R} ${T2}deploying final touches...${R}"
    do
      printf "\r  %b" "$f"
      sleep 0.16
    done
    printf "\r\033[K"
  fi

  echo -e "  ${G}${B}┌───────────────────────────────────────────────┐${R}"
  echo -e "  ${G}${B}│${R}  ${G}✓${R}  ${B}bbdump v${VERSION}${R} installed successfully      ${G}${B}│${R}"
  echo -e "  ${G}${B}└───────────────────────────────────────────────┘${R}"
  echo ""

  if [ "$PLATFORM" = "macos" ]; then
    echo -e "  ${T2}Run:${R}  ${B}open -a ${APP_NAME}${R}"
    echo -e "  ${T2}If blocked:${R} Right-click → Open → Open"
  else
    echo -e "  ${T2}Run:${R}  ${B}${APP_NAME}${R}"
  fi

  echo ""
  echo -e "  ${T2}${D}github.com/${REPO}${R}  ${T2}${D}ko-fi.com/poup_s${R}"
  echo ""
}

# ─────────────────────────────────────────────────────────
# --- Uninstall system ---
# ─────────────────────────────────────────────────────────

# --- Check if already installed ---
check_existing_install() {
  case "$PLATFORM" in
    macos) [ -d "/Applications/${APP_NAME}.app" ] && return 0 ;;
    linux) [ -f "$HOME/.local/bin/${APP_NAME}" ] && return 0 ;;
  esac
  return 1
}

# --- Uninstall: bbdump app (macOS) ---
uninstall_app_macos() {
  step "Uninstalling bbdump app"
  if [ -d "/Applications/${APP_NAME}.app" ]; then
    rm -rf "/Applications/${APP_NAME}.app"
    success "Removed /Applications/${APP_NAME}.app"
  else
    warn "App not found in /Applications"
  fi
}

# --- Uninstall: bbdump app (Linux) ---
uninstall_app_linux() {
  step "Uninstalling bbdump app"
  local app_path="$HOME/.local/bin/${APP_NAME}"
  if [ -f "$app_path" ]; then
    rm -f "$app_path"
    success "Removed ${app_path}"
  else
    warn "App not found at ${app_path}"
  fi
}

# --- Uninstall: desktop shortcut (Linux) ---
uninstall_desktop_entry() {
  step "Removing desktop shortcut"
  local desktop_path="$HOME/.local/share/applications/${APP_NAME}.desktop"
  local icon_path="$HOME/.local/share/icons/hicolor/256x256/apps/${APP_NAME}.png"
  local pixmaps_icon="$HOME/.local/share/pixmaps/${APP_NAME}.png"
  local removed=0

  if [ -f "$desktop_path" ]; then
    rm -f "$desktop_path"
    success "Removed ${desktop_path}"
    removed=1
  fi
  if [ -f "$icon_path" ]; then
    rm -f "$icon_path"
    removed=1
  fi
  if [ -f "$pixmaps_icon" ]; then
    rm -f "$pixmaps_icon"
    removed=1
  fi

  if [ "$removed" -eq 1 ]; then
    success "Removed icons"
    # Update caches
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
      gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    fi
  else
    warn "No desktop shortcut found"
  fi
}

# --- Uninstall: PostgreSQL (macOS via Homebrew) ---
uninstall_postgresql_macos() {
  step "Uninstalling PostgreSQL (Homebrew)"
  local brew_cmd=""
  if command -v brew >/dev/null 2>&1; then
    brew_cmd="brew"
  elif [ -x /opt/homebrew/bin/brew ]; then
    brew_cmd="/opt/homebrew/bin/brew"
  elif [ -x /usr/local/bin/brew ]; then
    brew_cmd="/usr/local/bin/brew"
  fi

  if [ -z "$brew_cmd" ]; then
    warn "Homebrew not found — cannot uninstall PostgreSQL"
    return
  fi

  local pg_version=""
  if "$brew_cmd" list postgresql@17 >/dev/null 2>&1; then
    pg_version="postgresql@17"
  elif "$brew_cmd" list postgresql@16 >/dev/null 2>&1; then
    pg_version="postgresql@16"
  fi

  if [ -z "$pg_version" ]; then
    warn "PostgreSQL not found via Homebrew"
    return
  fi

  # Stop service first
  "$brew_cmd" services stop "$pg_version" 2>/dev/null || true

  spinner "Uninstalling ${pg_version}…"
  if "$brew_cmd" uninstall "$pg_version" 2>/dev/null; then
    stop_spinner
    success "${pg_version} uninstalled"
  else
    stop_spinner
    warn "Could not uninstall ${pg_version}"
    echo -e "      ${T2}Try manually:${R} ${B}brew uninstall ${pg_version}${R}"
  fi
}

# --- Uninstall: PostgreSQL (Linux) ---
uninstall_postgresql_linux() {
  step "Uninstalling PostgreSQL"
  detect_pkg_manager
  ensure_sudo


  # Stop services
  for svc in $(systemctl list-unit-files 'postgresql*' --no-legend 2>/dev/null | awk '{print $1}'); do
    sudo systemctl stop "$svc" 2>/dev/null || true
    sudo systemctl disable "$svc" 2>/dev/null || true
  done

  case "$PKG_MGR" in
    apt)
      spinner "Removing PostgreSQL packages…"
      # Remove all postgresql-related packages
      local pg_pkgs
      pg_pkgs=$(dpkg -l 2>/dev/null | grep -oP 'postgresql[-\w]*' | sort -u | tr '\n' ' ' || true)
      if [ -n "$pg_pkgs" ]; then
        sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y $pg_pkgs 2>/dev/null || true
      fi
      sudo DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>/dev/null || true
      stop_spinner
      success "PostgreSQL packages removed"
      ;;
    dnf|yum)
      spinner "Removing PostgreSQL packages…"
      sudo $PKG_MGR remove -y postgresql-server postgresql-contrib postgresql 2>/dev/null || true
      stop_spinner
      success "PostgreSQL packages removed"
      ;;
    pacman)
      spinner "Removing PostgreSQL…"
      sudo pacman -Rns --noconfirm postgresql 2>/dev/null || true
      stop_spinner
      success "PostgreSQL removed"
      ;;
    *)
      warn "No supported package manager — remove PostgreSQL manually"
      ;;
  esac
}

# --- Uninstall: Homebrew (macOS) ---
uninstall_homebrew() {
  step "Uninstalling Homebrew"
  warn "${E}This will remove Homebrew and ALL its packages${R}"
  echo -ne "    ${Y}Are you sure? [y/N]:${R} "
  read -r answer < /dev/tty
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    info "Skipped"
    return
  fi

  spinner "Uninstalling Homebrew…"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)" >/dev/null 2>&1 || {
    stop_spinner
    warn "Auto-uninstall failed — run manually:"
    echo -e "      ${B}/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/uninstall.sh)\"${R}"
    return
  }
  stop_spinner
  success "Homebrew uninstalled"
}

# --- Uninstall: bbdump config & data ---
uninstall_config_data() {
  step "Removing bbdump data"
  local data_dir="$HOME/.bbdump"
  if [ -d "$data_dir" ]; then
    warn "${E}This will delete all config, encryption keys, and logs${R}"
    echo -ne "    ${Y}Are you sure? [y/N]:${R} "
    read -r answer < /dev/tty
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
      rm -rf "$data_dir"
      success "Removed ${data_dir}"
    else
      info "Skipped"
    fi
  else
    info "No data directory found (~/.bbdump)"
  fi
}

# --- Interactive uninstall menu ---
show_uninstall_menu() {
  echo ""
  echo -e "  ${Y}${B}bbdump is already installed${R}"
  echo ""
  echo -e "  ${T2}Choose an action:${R}"
  echo ""
  echo -e "    ${B}1)${R} Reinstall / Update"
  echo -e "    ${B}2)${R} Uninstall (select components)"
  echo -e "    ${B}3)${R} Exit"
  echo ""
  echo -ne "  ${M}▶${R} Choice [1-3]: "
  read -r choice < /dev/tty

  case "$choice" in
    1)
      return 0  # Continue with normal install
      ;;
    2)
      show_uninstall_components
      exit 0
      ;;
    3|"")
      echo ""
      info "Bye!"
      exit 0
      ;;
    *)
      warn "Invalid choice"
      exit 1
      ;;
  esac
}

# --- Component selection for uninstall ---
show_uninstall_components() {
  echo ""
  echo -e "  ${E}${B}── Uninstall Components ─────────────────────────${R}"
  echo ""

  # Build component list based on platform
  local components=()
  local labels=()
  local statuses=()

  # 1. App
  if [ "$PLATFORM" = "macos" ]; then
    components+=("app_macos")
    labels+=("bbdump app (/Applications/bbdump.app)")
    if [ -d "/Applications/${APP_NAME}.app" ]; then statuses+=("installed"); else statuses+=("not found"); fi
  else
    components+=("app_linux")
    labels+=("bbdump app (~/.local/bin/bbdump)")
    if [ -f "$HOME/.local/bin/${APP_NAME}" ]; then statuses+=("installed"); else statuses+=("not found"); fi
  fi

  # 2. Desktop shortcut (Linux only)
  if [ "$PLATFORM" = "linux" ]; then
    components+=("desktop")
    labels+=("Desktop shortcut")
    if [ -f "$HOME/.local/share/applications/${APP_NAME}.desktop" ]; then statuses+=("installed"); else statuses+=("not found"); fi
  fi

  # 3. PostgreSQL
  if [ "$PLATFORM" = "macos" ]; then
    components+=("pg_macos")
    local brew_cmd=""
    if command -v brew >/dev/null 2>&1; then brew_cmd="brew"
    elif [ -x /opt/homebrew/bin/brew ]; then brew_cmd="/opt/homebrew/bin/brew"
    elif [ -x /usr/local/bin/brew ]; then brew_cmd="/usr/local/bin/brew"
    fi
    if [ -n "$brew_cmd" ] && ("$brew_cmd" list postgresql@17 >/dev/null 2>&1 || "$brew_cmd" list postgresql@16 >/dev/null 2>&1); then
      labels+=("PostgreSQL (Homebrew)")
      statuses+=("installed")
    else
      labels+=("PostgreSQL (Homebrew)")
      statuses+=("not found")
    fi
  else
    components+=("pg_linux")
    labels+=("PostgreSQL server & client tools")
    if command -v postgres >/dev/null 2>&1 || command -v pg_dump >/dev/null 2>&1; then statuses+=("installed"); else statuses+=("not found"); fi
  fi

  # 4. Homebrew (macOS only)
  if [ "$PLATFORM" = "macos" ]; then
    components+=("homebrew")
    labels+=("Homebrew")
    if command -v brew >/dev/null 2>&1 || [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; then
      statuses+=("installed")
    else
      statuses+=("not found")
    fi
  fi

  # 5. Config data
  components+=("config")
  labels+=("bbdump data (~/.bbdump/)")
  if [ -d "$HOME/.bbdump" ]; then statuses+=("found"); else statuses+=("not found"); fi

  # Display components
  local i
  for ((i=0; i<${#components[@]}; i++)); do
    local num=$((i + 1))
    if [ "${statuses[$i]}" = "not found" ]; then
      echo -e "    ${T2}${num}) ${labels[$i]}  — not found${R}"
    else
      echo -e "    ${B}${num})${R} ${labels[$i]}  ${G}✓${R}"
    fi
  done

  echo ""
  echo -e "    ${B}A)${R} Uninstall ALL"
  echo -e "    ${B}0)${R} Cancel"
  echo ""
  echo -ne "  ${M}▶${R} Select components (e.g. ${B}1 3${R} or ${B}A${R}): "
  read -r selections < /dev/tty

  [ "$selections" = "0" ] || [ -z "$selections" ] && { info "Cancelled"; return; }

  # Parse selections
  local selected=()
  if echo "$selections" | grep -qiE '^a(ll)?$'; then
    for ((i=0; i<${#components[@]}; i++)); do
      if [ "${statuses[$i]}" != "not found" ]; then
        selected+=("${components[$i]}")
      fi
    done
  else
    for sel in $selections; do
      local idx=$((sel - 1))
      if [ "$idx" -ge 0 ] 2>/dev/null && [ "$idx" -lt "${#components[@]}" ]; then
        if [ "${statuses[$idx]}" != "not found" ]; then
          selected+=("${components[$idx]}")
        fi
      fi
    done
  fi

  if [ ${#selected[@]} -eq 0 ]; then
    warn "Nothing to uninstall"
    return
  fi

  # Confirmation summary
  echo ""
  echo -e "  ${E}${B}Will uninstall:${R}"
  for comp in "${selected[@]}"; do
    case "$comp" in
      app_macos)  echo -e "    ${E}•${R} bbdump app" ;;
      app_linux)  echo -e "    ${E}•${R} bbdump app" ;;
      desktop)    echo -e "    ${E}•${R} Desktop shortcut" ;;
      pg_macos)   echo -e "    ${E}•${R} PostgreSQL (Homebrew)" ;;
      pg_linux)   echo -e "    ${E}•${R} PostgreSQL server & client tools" ;;
      homebrew)   echo -e "    ${E}•${R} Homebrew (and all packages)" ;;
      config)     echo -e "    ${E}•${R} bbdump data (~/.bbdump/)" ;;
    esac
  done
  echo ""
  echo -ne "  ${E}${B}Confirm? [y/N]:${R} "
  read -r confirm < /dev/tty

  if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    info "Cancelled"
    return
  fi

  # Execute each uninstall
  for comp in "${selected[@]}"; do
    case "$comp" in
      app_macos)  uninstall_app_macos ;;
      app_linux)  uninstall_app_linux ;;
      desktop)    uninstall_desktop_entry ;;
      pg_macos)   uninstall_postgresql_macos ;;
      pg_linux)   uninstall_postgresql_linux ;;
      homebrew)   uninstall_homebrew ;;
      config)     uninstall_config_data ;;
    esac
  done

  echo ""
  echo -e "  ${G}${B}┌───────────────────────────────────────────────┐${R}"
  echo -e "  ${G}${B}│${R}  ${G}✓${R}  ${B}Uninstall complete${R}                        ${G}${B}│${R}"
  echo -e "  ${G}${B}└───────────────────────────────────────────────┘${R}"
  echo ""
}

# --- Main ---
main() {
  show_intro
  detect_platform

  # Check for existing install — offer uninstall menu
  if [ "$FORCE_UNINSTALL" -eq 1 ]; then
    show_uninstall_components
    exit 0
  elif check_existing_install; then
    show_uninstall_menu
  fi

  get_latest_version
  build_download_url
  download

  case "$PLATFORM" in
    macos) install_macos ;;
    linux) install_linux ;;
  esac

  install_dependencies
  done_banner
}

main
