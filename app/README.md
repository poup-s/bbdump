# Applications compilées

> **Note** : Les fichiers DMG ne sont pas versionnés dans ce dépôt car ils sont trop volumineux (~350MB chacun).
> 
> **Téléchargez-les depuis les [GitHub Releases](https://github.com/poup-s/bbdump/releases)** où ils sont disponibles en tant qu'assets de release.

## Versions disponibles

Les fichiers DMG sont générés dans le dossier `release/` lors du build et doivent être uploadés manuellement sur GitHub Releases :

- `bbdump-1.9.0-arm64.dmg` - Version pour Apple Silicon (M1/M2/M3)
- `bbdump-1.9.0.dmg` - Version pour Intel Mac

## Créer une release GitHub

1. Build les DMG : `npm run dist:mac`
2. Aller sur https://github.com/poup-s/bbdump/releases/new
3. Créer un tag (ex: `v1.9.0`)
4. Uploader les fichiers depuis `release/` :
   - `bbdump-1.9.0-arm64.dmg`
   - `bbdump-1.9.0.dmg`

## Installation

Voir le [README principal](../README.md) pour les instructions d'installation.

