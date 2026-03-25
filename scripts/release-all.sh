#!/bin/bash
set -e

VERSION="$1"

if [ -z "$VERSION" ]; then
  echo "Usage: npm run release:all <version>"
  echo "Example: npm run release:all 1.0.10"
  exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Version must be in semver format (e.g., 1.0.10)"
  exit 1
fi

echo "============================================"
echo "  bbdump v${VERSION} — Release ALL platforms"
echo "============================================"
echo ""

# 1. Update version in package.json (no git tag)
echo "==> Updating version to ${VERSION}..."
npm version "$VERSION" --no-git-tag-version

# 2. Build MCP server
echo "==> Building MCP server..."
cd mcp-postgres && npm run build && cd ..

# 3. Build app (TypeScript + Vite)
echo "==> Building Electron app..."
npm run build

# 4. Package for all platforms
echo "==> Packaging for macOS..."
npx electron-builder --mac

echo "==> Packaging for Windows..."
npx electron-builder --win

echo "==> Packaging for Linux..."
npx electron-builder --linux

# 5. Prepare clean output folder
OUT_DIR="release/v${VERSION}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Copy all artifacts for this version
cp release/bbdump-${VERSION}* "$OUT_DIR/" 2>/dev/null || true

# Copy update manifests
cp release/latest-mac.yml "$OUT_DIR/" 2>/dev/null || true
cp release/latest-linux.yml "$OUT_DIR/" 2>/dev/null || true
cp release/latest.yml "$OUT_DIR/" 2>/dev/null || true

echo ""
echo "============================================"
echo "  Done! Release files ready in: ${OUT_DIR}/"
echo "============================================"
echo ""
ls -lh "$OUT_DIR/"
echo ""
echo "Upload to GitHub (repo: poup-s/bbdump):"
echo "  gh release create ${VERSION} ${OUT_DIR}/* --repo poup-s/bbdump --title \"${VERSION}\" --notes \"Release ${VERSION}\""
