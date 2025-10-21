# bbdump - PostgreSQL Backup Manager

<img src="logo.png" alt="bbdump logo" width="100">

Application Electron cross-platform pour gérer les sauvegardes automatisées et manuelles de bases de données PostgreSQL.

## 🚀 Fonctionnalités

- ✅ Interface graphique moderne
- ✅ Gestion de multiples bases de données PostgreSQL
- ✅ **Configuration simplifiée via URL PostgreSQL**
- ✅ **Modification des bases de données configurées**
- ✅ **Éditeur de cron visuel** (4 modes : Aucune, Présélection, Visuel, Manuel)
- ✅ **Contrôle Play/Pause des tâches planifiées** par base de données
- ✅ Sauvegardes automatiques planifiées (cron) - **optionnel**
- ✅ Sauvegardes manuelles à la demande
- ✅ **Visualisation et gestion des sauvegardes** (liste, taille, suppression)
- ✅ **Restauration/Import de sauvegardes** vers n'importe quelle base PostgreSQL
- ✅ **Chiffrement AES-256-GCM des mots de passe** 🔒 (optionnel par base)
- ✅ **Export/Import de la clé de chiffrement** via interface graphique
- ✅ **Notifications toast en temps réel** pour les backups automatiques
- ✅ Visualisation des logs en temps réel
- ✅ Cross-platform (macOS, Windows, Linux)

## 📋 Prérequis

- Node.js 18+ et npm
- PostgreSQL client tools (`pg_dump` doit être dans le PATH)
- PostgreSQL server accessible

## 🛠️ Installation

1. **Cloner le projet**
```bash
git clone <url>
cd bbdump
```

2. **Installer les dépendances**
```bash
npm install
```

3. **Configurer votre première base de données**

Vous pouvez soit :
- Utiliser l'interface graphique (recommandé) : Lancez l'application et cliquez sur "+ Ajouter une base"
- Éditer le fichier `config.json` manuellement :

```json
{
  "databases": [
    {
      "name": "ma_base",
      "host": "localhost",
      "port": 5432,
      "user": "postgres",
      "password": "mon_mot_de_passe",
      "cron": "0 2 * * *",
      "output": "backups/ma_base.backup"
    }
  ]
}
```

**Note** : Le champ `cron` est optionnel. Laissez-le vide (`""`) si vous ne voulez que des sauvegardes manuelles.

## 🎯 Utilisation

### Mode développement

```bash
npm run dev
```

Cette commande va :
1. Compiler le TypeScript vers JavaScript
2. Lancer l'application Electron

### Compiler le projet

```bash
npm run build
```

### Créer un exécutable

```bash
npm run dist
```

Les exécutables seront générés dans le dossier `release/`.

## 📂 Structure du projet

```
bbdump/
├── src/
│   ├── main/              # Process principal Electron
│   │   ├── main.ts        # Point d'entrée, gestion IPC
│   │   ├── backup.ts      # Exécution de pg_dump
│   │   ├── cron.ts        # Gestion des tâches planifiées
│   │   └── logger.ts      # Système de logs
│   ├── renderer/          # Interface utilisateur
│   │   ├── App.vue        # Composant principal Vue
│   │   ├── index.html     # Point d'entrée HTML
│   │   └── app.ts         # Initialisation Vue
│   └── types/
│       └── config.d.ts    # Types TypeScript
├── backups/               # Dossier des sauvegardes
├── logs/                  # Logs de l'application
├── config.json            # Configuration des bases
├── package.json
└── tsconfig.json
```

## ⚙️ Configuration

### Ajout d'une base de données

Deux méthodes sont disponibles :

1. **Configuration manuelle** : Saisir chaque paramètre individuellement
2. **URL PostgreSQL** : Coller directement une URL de connexion

**Format URL** :
```
postgresql://utilisateur:motdepasse@host:port/nom_base
```

**Exemple** :
```
postgresql://postgres:password@127.0.0.1:5432/ma_base
```

### Modification d'une base de données

Pour modifier une base de données existante :

1. Cliquer sur le bouton **✏️ (Modifier)** sur la carte de la base
2. Une fenêtre modale s'ouvre avec les paramètres actuels pré-remplis
3. Modifier les paramètres souhaités (mode manuel ou URL)
4. Cliquer sur **Modifier** pour sauvegarder

Les modifications sont immédiatement prises en compte. Si vous modifiez l'expression cron, la planification sera automatiquement mise à jour.

### Contrôle Play/Pause des tâches planifiées

Chaque base de données avec une planification (cron) dispose d'un **bouton Play/Pause** permettant d'activer ou désactiver temporairement les backups automatiques :

- **⏸ Bouton vert (pause)** : Les tâches planifiées sont actives
- **▶ Bouton gris (play)** : Les tâches planifiées sont en pause

**Fonctionnement :**
- Cliquer sur le bouton pour basculer entre les deux états
- Une notification toast confirme le changement
- L'état est sauvegardé immédiatement dans `config.json`
- Les backups manuels (bouton "Backup") fonctionnent toujours, même en pause

**Cas d'usage :**
- Mettre en pause les backups pendant une maintenance
- Désactiver temporairement un backup trop gourmand
- Tester une configuration sans lancer les tâches automatiques

### Format de l'expression Cron (optionnel)

L'expression cron est **facultative**. Si vous ne souhaitez que des sauvegardes manuelles, laissez ce champ vide.

L'expression cron suit le format standard :
```
* * * * *
│ │ │ │ │
│ │ │ │ └─── Jour de la semaine (0-7, 0 et 7 = dimanche)
│ │ │ └───── Mois (1-12)
│ │ └─────── Jour du mois (1-31)
│ └───────── Heure (0-23)
└─────────── Minute (0-59)
```

**Exemples :**
- `0 2 * * *` - Tous les jours à 2h du matin
- `0 0 * * 0` - Tous les dimanches à minuit
- `0 */6 * * *` - Toutes les 6 heures
- `0 0 1 * *` - Le 1er de chaque mois à minuit

### Options de pg_dump utilisées

```bash
pg_dump -h <host> -p <port> -U <user> -F c -b -v -f <output> <database>
```

- `-F c` : Format custom (compressé)
- `-b` : Inclure les large objects
- `-v` : Mode verbose
- `-f` : Fichier de sortie

## 🔒 Sécurité

L'application implémente un système de **chiffrement optionnel** pour protéger vos credentials :

- 🔐 **Algorithme** : AES-256-GCM (Advanced Encryption Standard)
- 🔑 **Clé** : 256 bits générée **automatiquement** au premier lancement (aucune action requise !)
- ✅ **Authentification** : Tag GCM pour détecter toute altération
- 🔄 **Migration automatique** : Les mots de passe en clair sont chiffrés automatiquement
- 👁️ **Masquage dans l'UI** : Les mots de passe sont affichés comme `••••••••`
- ⚡ **Zero-config** : Tout fonctionne automatiquement, sans configuration !
- 🎛️ **Chiffrement optionnel** : Choisissez par base de données (activé par défaut, recommandé)


Chaque base de données peut avoir son propre niveau de sécurité :

- ✅ **Chiffré (recommandé)** : Badge 🔒 affiché, mot de passe sécurisé dans `config.json`
- ⚠️ **Non chiffré** : Pas de badge, mot de passe en clair dans `config.json`

**Dans le formulaire d'ajout/édition** :
```
☑ Chiffrer le mot de passe (recommandé)
```

Cochez cette case pour activer le chiffrement (activé par défaut). Voir [CHIFFREMENT_OPTIONNEL.md](CHIFFREMENT_OPTIONNEL.md) pour plus de détails.

### Fichier de clé

🎉 **GÉNÉRATION AUTOMATIQUE** : Au premier lancement, l'application crée automatiquement le fichier `.encryption.key` - **vous n'avez rien à faire** !

⚠️ **Important (après le premier lancement)** :
- ✅ **Sauvegardez** ce fichier dans un lieu sûr (USB, cloud chiffré)
- ✅ **Ne le commitez JAMAIS** dans Git (déjà dans `.gitignore`)
- ✅ Sans ce fichier, les mots de passe chiffrés ne peuvent pas être déchiffrés
- ✅ Les permissions sont appliquées automatiquement (600)
- ℹ️ **Non requis** pour les bases avec chiffrement désactivé

💡 **En résumé** : Lancez l'app → tout fonctionne ! Pensez juste à sauvegarder `.encryption.key` pour ne pas le perdre.

### Export/Import de la clé

Un onglet **⚙️ Paramètres** est disponible dans l'application pour gérer facilement la clé de chiffrement :

**Export (sauvegarde)** :
- Permet de sauvegarder la clé dans un fichier `.key`
- Utile pour créer un backup sécurisé
- Nécessaire pour transférer la config vers une autre machine

**Import (restauration)** :
- Permet de restaurer une clé depuis un fichier
- Utile pour configurer une nouvelle machine
- Permet de synchroniser plusieurs instances de l'application

🎯 **Cas d'usage** : Si vous utilisez l'application sur plusieurs machines (PC bureau + laptop), exportez la clé depuis la première et importez-la sur la seconde pour partager la même configuration.

Pour plus de détails sur la sécurité, consultez [SECURITY.md](SECURITY.md).

## 📝 Logs

Les logs sont stockés dans `logs/app.log` et incluent :
- Démarrage/arrêt de l'application
- Créations/suppressions de tâches planifiées
- Succès/échecs des sauvegardes
- Erreurs système

## 🐛 Dépannage

### pg_dump non trouvé

Si vous obtenez l'erreur "pg_dump: command not found", assurez-vous que :
1. PostgreSQL client tools est installé
2. Le PATH inclut le dossier bin de PostgreSQL

**macOS** (avec Homebrew) :
```bash
brew install postgresql
```

**Windows** :
Installer PostgreSQL et ajouter `C:\Program Files\PostgreSQL\<version>\bin` au PATH.

**Linux** :
```bash
sudo apt-get install postgresql-client
```

### Erreurs de connexion

Vérifiez que :
- Le serveur PostgreSQL est démarré
- L'host et le port sont corrects
- L'utilisateur a les permissions nécessaires
- Le mot de passe est correct


## 📄 Licence

MIT

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

