#!/bin/bash

# Automatic installation script for macOS
# This script automatically removes the quarantine flag and installs bbdump

# Do not exit immediately on error to allow searching
set +e

APP_NAME="bbdump"
DMG_PATTERN="/Volumes/${APP_NAME}*"
APP_PATH="${DMG_PATTERN}/${APP_NAME}.app"
INSTALL_PATH="/Applications/${APP_NAME}.app"

# Allow specifying the volume manually via environment variable
if [ -n "$DMG_VOLUME" ]; then
    echo "📌 Using specified volume: $DMG_VOLUME"
else
    echo "🔍 Searching for mounted DMG..."
    # First search for volumes starting with "bbdump"
    DMG_VOLUME=$(ls -d /Volumes/${APP_NAME}* 2>/dev/null | head -1)
    
    # If not found, search all volumes for a .app file named bbdump
    if [ -z "$DMG_VOLUME" ]; then
        echo "   Searching all mounted volumes..."
        for vol in /Volumes/*; do
            if [ -d "$vol" ] && [ -d "$vol/${APP_NAME}.app" ]; then
                DMG_VOLUME="$vol"
                echo "   ✅ Found in: $vol"
                break
            fi
        done
    fi
fi

if [ -z "$DMG_VOLUME" ]; then
    echo "❌ Error: No ${APP_NAME} volume found."
    echo ""
    echo "📋 Currently mounted volumes:"
    ls -1 /Volumes/ 2>/dev/null | grep -v "^$" | while read vol; do
        echo "   - $vol"
    done
    echo ""
    echo "💡 Possible solutions:"
    echo "   1. Make sure you have mounted the .dmg file (double-click the .dmg file)"
    echo "   2. If the volume has a different name, you can specify it manually:"
    echo "      export DMG_VOLUME=\"/Volumes/volume-name\""
    echo "      bash scripts/install-mac.sh"
    echo "   3. Or install manually:"
    echo "      xattr -cr /Volumes/[VOLUME-NAME]/bbdump.app"
    echo "      cp -R /Volumes/[VOLUME-NAME]/bbdump.app /Applications/"
    echo "      xattr -cr /Applications/bbdump.app"
    exit 1
fi

APP_SOURCE="${DMG_VOLUME}/${APP_NAME}.app"

if [ ! -d "$APP_SOURCE" ]; then
    echo "❌ Error: ${APP_NAME}.app not found in ${DMG_VOLUME}"
    echo ""
    echo "📋 Contents of volume ${DMG_VOLUME}:"
    ls -la "$DMG_VOLUME" 2>/dev/null | head -10 || echo "   (Unable to list contents)"
    echo ""
    echo "💡 Please verify that:"
    echo "   1. The volume is properly mounted"
    echo "   2. The .app file is named '${APP_NAME}.app'"
    echo "   3. You have read permissions on the volume"
    exit 1
fi

echo "✅ Volume found: ${DMG_VOLUME}"
echo "📦 Application found: ${APP_SOURCE}"

echo ""
echo "🔓 Removing quarantine flag from DMG..."
xattr -cr "$APP_SOURCE"
if [ $? -eq 0 ]; then
    echo "✅ Quarantine flag removed successfully"
else
    echo "⚠️  Warning: Could not remove quarantine flag (may require sudo)"
fi

echo ""
echo "📥 Installing the application to /Applications..."
if [ -d "$INSTALL_PATH" ]; then
    echo "⚠️  An existing version was found. Removing..."
    rm -rf "$INSTALL_PATH"
fi

set -e
cp -R "$APP_SOURCE" "$INSTALL_PATH"
echo "✅ Application copied successfully"
set +e

echo ""
echo "🔓 Removing quarantine flag from installed application..."
xattr -cr "$INSTALL_PATH"
if [ $? -eq 0 ]; then
    echo "✅ Quarantine flag removed from installed application"
else
    echo "⚠️  Warning: Could not remove quarantine flag (may require sudo)"
    echo "   Try manually: sudo xattr -cr ${INSTALL_PATH}"
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📝 To launch the application:"
echo "   1. Open the Applications folder in Finder"
echo "   2. Double-click ${APP_NAME}.app"
echo "   3. If macOS shows a warning:"
echo "      - Right-click > Open"
echo "      - Click 'Open' in the dialog box"
echo ""
echo "🚀 Or launch directly from Terminal:"
echo "   open ${INSTALL_PATH}"

