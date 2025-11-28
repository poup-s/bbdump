# Scripts d'installation

Ce dossier contient les scripts d'installation pour différentes plateformes.

## macOS

### `install-mac.sh`

Script d'installation automatique pour macOS qui :
- Retire automatiquement le flag de quarantaine macOS
- Installe l'application dans `/Applications`
- Configure les permissions nécessaires

**Utilisation :**

```bash
# Depuis GitHub (recommandé)
curl -fsSL https://raw.githubusercontent.com/poup-s/bbdump/main/scripts/install-mac.sh | bash

# Ou si vous avez cloné le dépôt
bash scripts/install-mac.sh
```

**Prérequis :**
- DMG monté (double-clic sur le fichier `.dmg`)
- Terminal ouvert

