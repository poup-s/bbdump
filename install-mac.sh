#!/bin/bash

# Script d'installation automatique pour macOS
# Ce script retire automatiquement le flag de quarantaine et installe bbdump

set -e

APP_NAME="bbdump"
DMG_PATTERN="/Volumes/${APP_NAME}*"
APP_PATH="${DMG_PATTERN}/${APP_NAME}.app"
INSTALL_PATH="/Applications/${APP_NAME}.app"

echo "🔍 Recherche du DMG monté..."
DMG_VOLUME=$(ls -d /Volumes/${APP_NAME}* 2>/dev/null | head -1)

if [ -z "$DMG_VOLUME" ]; then
    echo "❌ Erreur : Aucun volume ${APP_NAME} trouvé."
    echo "   Assurez-vous d'avoir monté le fichier .dmg"
    exit 1
fi

APP_SOURCE="${DMG_VOLUME}/${APP_NAME}.app"

if [ ! -d "$APP_SOURCE" ]; then
    echo "❌ Erreur : ${APP_NAME}.app introuvable dans ${DMG_VOLUME}"
    exit 1
fi

echo "✅ Volume trouvé : ${DMG_VOLUME}"
echo "📦 Application trouvée : ${APP_SOURCE}"

echo ""
echo "🔓 Retrait du flag de quarantaine du DMG..."
xattr -cr "$APP_SOURCE"
if [ $? -eq 0 ]; then
    echo "✅ Flag de quarantaine retiré avec succès"
else
    echo "⚠️  Attention : Impossible de retirer le flag de quarantaine (peut nécessiter sudo)"
fi

echo ""
echo "📥 Installation de l'application dans /Applications..."
if [ -d "$INSTALL_PATH" ]; then
    echo "⚠️  Une version existante a été trouvée. Suppression..."
    rm -rf "$INSTALL_PATH"
fi

cp -R "$APP_SOURCE" "$INSTALL_PATH"
if [ $? -eq 0 ]; then
    echo "✅ Application copiée avec succès"
else
    echo "❌ Erreur lors de la copie"
    exit 1
fi

echo ""
echo "🔓 Retrait du flag de quarantaine de l'application installée..."
xattr -cr "$INSTALL_PATH"
if [ $? -eq 0 ]; then
    echo "✅ Flag de quarantaine retiré de l'application installée"
else
    echo "⚠️  Attention : Impossible de retirer le flag de quarantaine (peut nécessiter sudo)"
    echo "   Essayez manuellement : sudo xattr -cr ${INSTALL_PATH}"
fi

echo ""
echo "✅ Installation terminée !"
echo ""
echo "📝 Pour lancer l'application :"
echo "   1. Ouvrez le dossier Applications dans Finder"
echo "   2. Double-cliquez sur ${APP_NAME}.app"
echo "   3. Si macOS affiche un avertissement :"
echo "      - Clic droit > Ouvrir"
echo "      - Cliquez sur 'Ouvrir' dans la boîte de dialogue"
echo ""
echo "🚀 Ou lancez directement depuis Terminal :"
echo "   open ${INSTALL_PATH}"

