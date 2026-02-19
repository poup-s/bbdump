#!/bin/bash
set -e

# bbdump installer
# Usage: curl -fsSL https://raw.githubusercontent.com/poup-s/bbDump-app/main/scripts/install.sh | bash
# Override version: BBDUMP_VERSION=1.0.9 curl -fsSL ... | bash

REPO="poup-s/bbDump-app"
APP_NAME="bbdump"
GITHUB_API="https://api.github.com/repos/${REPO}/releases/latest"
GITHUB_DL="https://github.com/${REPO}/releases/download"

# --- Colors & Styles ---
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Styled output ---
step()    { echo -e "\n  ${CYAN}${BOLD}▸${NC} ${BOLD}$1${NC}"; }
info()    { echo -e "    ${DIM}$1${NC}"; }
success() { echo -e "    ${GREEN}✔${NC} $1"; }
warn()    { echo -e "    ${YELLOW}⚠${NC} $1"; }
error()   { echo -e "\n    ${RED}✖ $1${NC}" >&2; exit 1; }

# --- Cleanup ---
TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

# --- Banner ---
banner() {
  echo ""
  echo -e "${BOLD}${CYAN}"
  echo "    ┌─────────────────────────────────┐"
  echo "    │                                 │"
  echo "    │          ☕  bbdump             │"
  echo "    │     Modern PostgreSQL Manager   │"
  echo "    │                                 │"
  echo "    └─────────────────────────────────┘"
  echo -e "${NC}"
}

# --- Detect platform ---
detect_platform() {
  step "Detecting platform"

  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      error "Unsupported OS: $OS (only macOS and Linux are supported)" ;;
  esac

  case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *)             error "Unsupported architecture: $ARCH" ;;
  esac

  success "Detected ${BOLD}${PLATFORM}${NC} ${BOLD}${ARCH}${NC}"
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

  local response
  response=$(curl -fsSL "$GITHUB_API" 2>/dev/null) || error "Could not reach GitHub API. Check your internet connection."

  VERSION=$(echo "$response" | grep '"tag_name"' | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')

  if [ -z "$VERSION" ]; then
    error "Could not determine the latest version. Try: BBDUMP_VERSION=1.0.9 bash install.sh"
  fi

  # Strip leading 'v' if present
  VERSION="${VERSION#v}"

  success "v${VERSION}"
}

# --- Build download URL ---
build_download_url() {
  case "$PLATFORM" in
    macos)
      if [ "$ARCH" = "arm64" ]; then
        FILENAME="${APP_NAME}-${VERSION}-arm64.dmg"
      else
        FILENAME="${APP_NAME}-${VERSION}.dmg"
      fi
      ;;
    linux)
      if [ "$ARCH" = "x64" ]; then
        LINUX_ARCH="x86_64"
      else
        LINUX_ARCH="$ARCH"
      fi
      FILENAME="${APP_NAME}-${VERSION}-${LINUX_ARCH}.AppImage"
      ;;
  esac

  DOWNLOAD_URL="${GITHUB_DL}/${VERSION}/${FILENAME}"
}

# --- Download ---
download() {
  step "Downloading ${APP_NAME} v${VERSION}"
  info "${DIM}${DOWNLOAD_URL}${NC}"

  TMP_DIR=$(mktemp -d)
  DOWNLOAD_PATH="${TMP_DIR}/${FILENAME}"

  curl -fSL --progress-bar -o "$DOWNLOAD_PATH" "$DOWNLOAD_URL" || error "Download failed. Make sure version ${VERSION} exists for ${PLATFORM} ${ARCH}."
  success "Download complete"
}

# --- Install macOS ---
install_macos() {
  step "Installing to /Applications"

  local mount_point

  info "Mounting DMG..."
  mount_point=$(hdiutil attach "$DOWNLOAD_PATH" -nobrowse -quiet 2>/dev/null | grep "/Volumes" | sed 's/.*\(\/Volumes\/.*\)/\1/' | head -1)

  if [ -z "$mount_point" ]; then
    mount_point=$(ls -d /Volumes/${APP_NAME}* 2>/dev/null | head -1)
  fi

  if [ -z "$mount_point" ] || [ ! -d "$mount_point" ]; then
    error "Could not mount the DMG"
  fi

  local app_source="${mount_point}/${APP_NAME}.app"
  local install_path="/Applications/${APP_NAME}.app"

  if [ ! -d "$app_source" ]; then
    hdiutil detach "$mount_point" -quiet 2>/dev/null || true
    error "${APP_NAME}.app not found in DMG"
  fi

  # Remove quarantine from source
  xattr -cr "$app_source" 2>/dev/null || true

  # Remove existing installation
  if [ -d "$install_path" ]; then
    warn "Existing version found, replacing..."
    rm -rf "$install_path"
  fi

  cp -R "$app_source" "$install_path"

  # Remove quarantine from installed app
  xattr -cr "$install_path" 2>/dev/null || true

  # Unmount DMG
  hdiutil detach "$mount_point" -quiet 2>/dev/null || true

  success "Installed to /Applications/${APP_NAME}.app"
}

# --- Check FUSE (Linux) ---
check_fuse() {
  if ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
    return 0
  fi
  if [ -f /usr/lib/libfuse.so.2 ] || [ -f /usr/lib/x86_64-linux-gnu/libfuse.so.2 ]; then
    return 0
  fi

  echo ""
  warn "FUSE is not installed. AppImages require libfuse2."
  echo ""
  echo -e "    Install it with:"
  if command -v apt >/dev/null 2>&1; then
    echo -e "      ${BOLD}sudo apt install libfuse2${NC}"
  elif command -v dnf >/dev/null 2>&1; then
    echo -e "      ${BOLD}sudo dnf install fuse-libs${NC}"
  elif command -v pacman >/dev/null 2>&1; then
    echo -e "      ${BOLD}sudo pacman -S fuse2${NC}"
  else
    echo -e "      ${BOLD}Install libfuse2 via your package manager${NC}"
  fi
  echo ""
  echo -e "    Then run: ${BOLD}${APP_NAME}${NC}"
}

# --- Install Linux ---
install_linux() {
  step "Installing to ~/.local/bin"

  local install_dir="$HOME/.local/bin"
  local install_path="${install_dir}/${APP_NAME}"

  # Check FUSE dependency
  check_fuse

  # Create ~/.local/bin if needed
  if [ ! -d "$install_dir" ]; then
    mkdir -p "$install_dir"
    info "Created ${install_dir}"
  fi

  # Remove existing
  if [ -f "$install_path" ]; then
    warn "Existing version found, replacing..."
    rm -f "$install_path"
  fi

  cp "$DOWNLOAD_PATH" "$install_path"
  chmod +x "$install_path"

  success "Installed to ${install_path}"

  # Check if ~/.local/bin is in PATH
  if ! echo "$PATH" | grep -q "$install_dir"; then
    echo ""
    warn "${install_dir} is not in your PATH."
    echo -e "    Add this line to your ~/.bashrc or ~/.zshrc:"
    echo -e "      ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  fi
}

# --- Success banner ---
done_banner() {
  echo ""
  echo -e "  ${GREEN}${BOLD}┌─────────────────────────────────────┐${NC}"
  echo -e "  ${GREEN}${BOLD}│${NC}                                     ${GREEN}${BOLD}│${NC}"
  echo -e "  ${GREEN}${BOLD}│${NC}   ${GREEN}✔${NC}  ${BOLD}bbdump v${VERSION}${NC} installed!       ${GREEN}${BOLD}│${NC}"
  echo -e "  ${GREEN}${BOLD}│${NC}                                     ${GREEN}${BOLD}│${NC}"
  echo -e "  ${GREEN}${BOLD}└─────────────────────────────────────┘${NC}"

  echo ""
  if [ "$PLATFORM" = "macos" ]; then
    echo -e "  ${DIM}Get started:${NC}"
    echo -e "    ${BOLD}open /Applications/${APP_NAME}.app${NC}"
    echo ""
    echo -e "  ${DIM}If macOS shows a warning:${NC}"
    echo -e "    ${DIM}Right-click the app > Open > Open${NC}"
  else
    echo -e "  ${DIM}Get started:${NC}"
    echo -e "    ${BOLD}${APP_NAME}${NC}"
  fi

  echo ""
  echo -e "  ${DIM}Star us on GitHub: ${BLUE}https://github.com/${REPO}${NC}"
  echo -e "  ${DIM}Support the project: ${MAGENTA}https://ko-fi.com/poup_s${NC}"
  echo ""
}

# --- Main ---
main() {
  banner
  detect_platform
  get_latest_version
  build_download_url
  download

  case "$PLATFORM" in
    macos) install_macos ;;
    linux) install_linux ;;
  esac

  done_banner
}

main
