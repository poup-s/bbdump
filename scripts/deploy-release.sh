#!/bin/bash
set -e

# Usage:
#   npm run deploy:release           → patch (1.0.10 → 1.0.11)
#   npm run deploy:release minor     → minor (1.0.10 → 1.1.0)
#   npm run deploy:release major     → major (1.0.10 → 2.0.0)
#   npm run deploy:release 1.2.3     → exact version

RELEASE_REPO="poup-s/bbDump-app"
BUMP="${1:-patch}"

# --- Get current version ---
CURRENT=$(node -p "require('./package.json').version")
echo ""
echo "============================================"
echo "  bbdump — Deploy Release"
echo "============================================"
echo ""
echo "Current version: ${CURRENT}"

# --- Compute new version ---
if echo "$BUMP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  VERSION="$BUMP"
else
  case "$BUMP" in
    patch|minor|major) ;;
    *) echo "Error: argument must be patch, minor, major, or a semver (e.g., 1.2.3)"; exit 1 ;;
  esac
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case "$BUMP" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  esac
  VERSION="${MAJOR}.${MINOR}.${PATCH}"
fi

echo "New version:     ${VERSION} (${BUMP})"
echo ""

# --- Generate release notes from git log ---
echo "==> Generating release notes..."

# Find last tag to diff against
LAST_TAG=$(git tag --list --sort=-v:refname | head -1 2>/dev/null || true)

if [ -n "$LAST_TAG" ]; then
  echo "    Commits since ${LAST_TAG}:"
  COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"- %s" --no-merges 2>/dev/null || true)
else
  echo "    All recent commits:"
  COMMITS=$(git log --pretty=format:"- %s" --no-merges -20 2>/dev/null || true)
fi

if [ -z "$COMMITS" ]; then
  COMMITS="- Release ${VERSION}"
fi

# Build release notes
NOTES="## bbdump v${VERSION}

### Changes
${COMMITS}
"

echo "$NOTES"
echo ""

# --- Update version ---
echo "==> Updating version to ${VERSION}..."
npm version "$VERSION" --no-git-tag-version

# --- Build MCP server ---
echo "==> Building MCP server..."
cd mcp-postgres && npm run build && cd ..

# --- Build app ---
echo "==> Building Electron app..."
npm run build

# --- Package for all platforms ---
echo "==> Packaging for macOS..."
npx electron-builder --mac

echo "==> Packaging for Windows..."
npx electron-builder --win

echo "==> Packaging for Linux..."
npx electron-builder --linux

# --- Prepare output folder ---
OUT_DIR="release/v${VERSION}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp release/bbdump-${VERSION}* "$OUT_DIR/" 2>/dev/null || true
cp release/latest-mac.yml "$OUT_DIR/" 2>/dev/null || true
cp release/latest-linux.yml "$OUT_DIR/" 2>/dev/null || true
cp release/latest.yml "$OUT_DIR/" 2>/dev/null || true

echo ""
echo "==> Artifacts:"
ls -lh "$OUT_DIR/"

# --- Create git tag ---
echo ""
echo "==> Creating git tag v${VERSION}..."
git add package.json package-lock.json 2>/dev/null || true
git commit -m "release: v${VERSION}" 2>/dev/null || true
git tag "v${VERSION}"

# --- Upload to GitHub ---
echo ""
echo "==> Publishing release on GitHub (${RELEASE_REPO})..."
gh release create "${VERSION}" ${OUT_DIR}/* \
  --repo "${RELEASE_REPO}" \
  --title "v${VERSION}" \
  --notes "${NOTES}"

echo ""
echo "============================================"
echo "  v${VERSION} deployed!"
echo "  https://github.com/${RELEASE_REPO}/releases/tag/${VERSION}"
echo "============================================"
