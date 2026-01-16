# Guide de création de release GitHub

Ce guide explique comment créer une release GitHub avec les fichiers DMG compilés.

## Prérequis

- Avoir compilé les DMG : `npm run dist:mac`
- Avoir les fichiers dans le dossier `release/`

## Étapes

1. **Aller sur la page des releases GitHub**
   - https://github.com/poup-s/bbdump/releases/new

2. **Créer un nouveau tag**
   - Tag : `v1.9.0` (ou la version correspondante)
   - Target : `main` (ou la branche principale)
   - Release title : `Version 1.9.0` (ou le titre souhaité)

3. **Ajouter une description** (optionnel mais recommandé)
   ```markdown
   ## Version 1.9.0
   
   ### Nouvelles fonctionnalités
   - ...
   
   ### Corrections
   - ...
   ```

4. **Uploader les fichiers DMG**
   - Glisser-déposer les fichiers depuis `release/` :
     - `bbdump-1.9.0-arm64.dmg` (Apple Silicon)
     - `bbdump-1.9.0.dmg` (Intel Mac)

5. **Publier la release**
   - Cliquer sur "Publish release"

## Vérification

Après publication, vérifier que :
- Les fichiers DMG sont téléchargeables
- Les liens dans le README fonctionnent
- Le script d'installation fonctionne avec les nouveaux fichiers

## Notes

- Les fichiers DMG ne doivent **pas** être commités dans Git (ils sont dans `.gitignore`)
- Seuls les fichiers dans `release/` doivent être uploadés
- Les fichiers `.blockmap` peuvent être uploadés aussi pour les mises à jour automatiques


## Troubleshooting

### "bbdump est endommagé et ne peut pas être ouvert"

Si vous rencontrez cette erreur sur macOS, c'est parce que l'application n'est pas signée numériquement. Pour corriger cela :

1. Ouvrez le Terminal
2. Exécutez la commande suivante :
   ```bash
   xattr -cr /Applications/bbdump.app
   ```
   (Adaptez le chemin si l'application n'est pas dans le dossier Applications)
3. Relancez l'application



