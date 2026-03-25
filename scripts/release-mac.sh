#!/bin/bash
set -e

VERSION="$1"

if [ -z "$VERSION" ]; then
  echo "Usage: npm run release:mac <version>"
  echo "Example: npm run release:mac 1.0.7"
  exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Error: Version must be in semver format (e.g., 1.0.7)"
  exit 1
fi

echo "==> Building bbdump v${VERSION} for macOS..."

# 1. Update version in package.json (no git tag)
npm version "$VERSION" --no-git-tag-version

# 2. Build MCP server
echo "==> Building MCP server..."
cd mcp-postgres && npm run build && cd ..

# 3. Build & package
echo "==> Building Electron app + packaging..."
npm run build
npx electron-builder --mac

# 4. Prepare clean output folder
OUT_DIR="release/v${VERSION}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Copy only the files for this version + the update manifest
cp release/bbdump-${VERSION}* "$OUT_DIR/" 2>/dev/null || true
cp release/latest-mac.yml "$OUT_DIR/"

echo ""
echo "==> Done! Release files ready in: ${OUT_DIR}/"
echo ""
ls -lh "$OUT_DIR/"
echo ""
echo "Upload these files to GitHub release ${VERSION} (repo: poup-s/bbdump):"
echo "  gh release create ${VERSION} ${OUT_DIR}/* --repo poup-s/bbdump --title \"${VERSION}\" --notes \"Release ${VERSION}\""
