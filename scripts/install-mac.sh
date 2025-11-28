#!/bin/bash

# Script d'installation automatique pour macOS
# Ce script retire automatiquement le flag de quarantaine et installe bbdump

# Ne pas quitter immédiatement en cas d'erreur pour permettre la recherche
set +e

APP_NAME="bbdump"
DMG_PATTERN="/Volumes/${APP_NAME}*"
APP_PATH="${DMG_PATTERN}/${APP_NAME}.app"
INSTALL_PATH="/Applications/${APP_NAME}.app"

# Permettre de spécifier le volume manuellement via variable d'environnement
if [ -n "$DMG_VOLUME" ]; then
    echo "📌 Utilisation du volume spécifié : $DMG_VOLUME"
else
    echo "🔍 Recherche du DMG monté..."
    # Chercher d'abord les volumes qui commencent par "bbdump"
    DMG_VOLUME=$(ls -d /Volumes/${APP_NAME}* 2>/dev/null | head -1)
    
    # Si pas trouvé, chercher dans tous les volumes un fichier .app nommé bbdump
    if [ -z "$DMG_VOLUME" ]; then
        echo "   Recherche dans tous les volumes montés..."
        for vol in /Volumes/*; do
            if [ -d "$vol" ] && [ -d "$vol/${APP_NAME}.app" ]; then
                DMG_VOLUME="$vol"
                echo "   ✅ Trouvé dans : $vol"
                break
            fi
        done
    fi
fi

if [ -z "$DMG_VOLUME" ]; then
    echo "❌ Erreur : Aucun volume ${APP_NAME} trouvé."
    echo ""
    echo "📋 Volumes actuellement montés :"
    ls -1 /Volumes/ 2>/dev/null | grep -v "^$" | while read vol; do
        echo "   - $vol"
    done
    echo ""
    echo "💡 Solutions possibles :"
    echo "   1. Assurez-vous d'avoir monté le fichier .dmg (double-clic sur le fichier .dmg)"
    echo "   2. Si le volume a un nom différent, vous pouvez le spécifier manuellement :"
    echo "      export DMG_VOLUME=\"/Volumes/nom-du-volume\""
    echo "      bash scripts/install-mac.sh"
    echo "   3. Ou installez manuellement :"
    echo "      xattr -cr /Volumes/[NOM-DU-VOLUME]/bbdump.app"
    echo "      cp -R /Volumes/[NOM-DU-VOLUME]/bbdump.app /Applications/"
    echo "      xattr -cr /Applications/bbdump.app"
    exit 1
fi

APP_SOURCE="${DMG_VOLUME}/${APP_NAME}.app"

if [ ! -d "$APP_SOURCE" ]; then
    echo "❌ Erreur : ${APP_NAME}.app introuvable dans ${DMG_VOLUME}"
    echo ""
    echo "📋 Contenu du volume ${DMG_VOLUME} :"
    ls -la "$DMG_VOLUME" 2>/dev/null | head -10 || echo "   (Impossible de lister le contenu)"
    echo ""
    echo "💡 Vérifiez que :"
    echo "   1. Le volume est bien monté"
    echo "   2. Le fichier .app s'appelle bien '${APP_NAME}.app'"
    echo "   3. Vous avez les permissions de lecture sur le volume"
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

set -e
cp -R "$APP_SOURCE" "$INSTALL_PATH"
echo "✅ Application copiée avec succès"
set +e

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

