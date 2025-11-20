const { createApp } = Vue;
const { ipcRenderer } = require('electron');

// i18n translations
const translations = {
  en: {
    app: {
      title: 'BBDUMP',
      subtitle: 'Backup Manager'
    },
    tabs: {
      databases: 'Databases',
      backups: 'Backups',
      logs: 'Logs',
      scheduled: 'Scheduled',
      settings: 'Settings',
      about: 'About'
    },
    databases: {
      title: 'CONFIGURED DATABASES',
      addButton: 'Add Database',
      noData: 'NO DATABASES CONFIGURED',
      backup: 'Backup',
      running: 'Running...',
      edit: 'Edit',
      delete: 'Delete',
      pauseSchedule: 'Pause scheduled tasks',
      enableSchedule: 'Enable scheduled tasks',
      encrypted: 'PASS',
      encryptedBackup: 'BACKUP',
      deleteConfirm: 'Are you sure you want to delete the database "{name}"?',
      tableDatabase: 'Database',
      tableHost: 'Host / Connection',
      tableSchedule: 'Schedule',
      tableEncryption: 'Encryption',
      tableBackup: 'Backup',
      tableActions: 'Actions',
      statusActive: '⏸ ACTIVE',
      statusPaused: '▶ PAUSED',
      statusManual: 'Manual',
      viewDatabase: 'View Database'
    },
    backups: {
      title: 'Performed backups',
      stats: '{count} backup(s) displayed • {size}',
      statsTotal: '({total} total)',
      deleteSelected: 'Delete ({count})',
      refresh: 'Refresh',
      filter: 'Filter by database:',
      filterAll: 'All databases',
      filterReset: 'Reset',
      selected: '{count} selected',
      noData: 'NO BACKUPS FOUND',
      noFiltered: 'NO BACKUP FOR THIS DATABASE',
      showAll: 'Show all backups',
      file: 'File',
      size: 'Size',
      encryption: 'Encryption',
      encrypted: '🔒 ENCRYPTED',
      notEncrypted: '—',
      date: 'Date',
      import: 'Import',
      delete: 'Delete',
      deleteConfirm: 'Are you sure you want to delete the backup "{name}"?\n\nThis action is irreversible.',
      deleteMultipleConfirm: 'Are you sure you want to delete {count} backup(s)?\n\nThis action is irreversible.',
      deleteSuccess: '{count} backup(s) deleted successfully',
      deleteError: '{success} backup(s) deleted, {error} error(s)'
    },
    logs: {
      title: 'Application logs',
      refresh: 'Refresh',
      clear: 'Clear',
      noData: 'No logs available',
      clearConfirm: 'Are you sure you want to clear all logs?'
    },
    scheduled: {
      title: 'Scheduled tasks',
      refresh: 'Refresh',
      noData: 'No scheduled tasks',
      database: 'Database',
      status: 'Status',
      statusActive: '● Active',
      statusPaused: '⏸ Paused',
      schedule: 'Schedule',
      lastBackup: 'Last backup',
      never: 'Never'
    },
    settings: {
      title: 'Security settings',
      language: 'Language',
      languageDescription: 'Choose your preferred language',
      encryptionTitle: '🔒 Encryption key',
      keyPresent: 'Encryption key present',
      keyAbsent: 'Encryption key absent',
      keyPresentDesc: 'Your passwords are encrypted with AES-256-GCM.',
      keyAbsentDesc: 'No key found. A new key will be generated automatically.',
      exportKeyTitle: '📤 Export Key',
      exportKeyDesc: 'Save the encryption key to a file to transfer it to another machine or keep it safe.',
      exportKeyButton: 'Export Key',
      importKeyTitle: '📥 Import Key',
      importKeyDesc: 'Restore an encryption key from a file. Required to decrypt passwords on a new machine.',
      importKeyButton: 'Import Key',
      warningTitle: 'Important - Key Security',
      warningItems: [
        'Without this key, your passwords CANNOT be decrypted',
        'Save the key in a safe place (USB, encrypted cloud)',
        'NEVER share this key publicly',
        'Use the same key on all machines to share the config'
      ],
      useCaseTitle: '💡 Use cases',
      exportUseCase: 'Export:',
      exportItems: [
        'Create a security backup of your key',
        'Transfer your configuration to another machine',
        'Share configuration between multiple instances'
      ],
      importUseCase: 'Import:',
      importItems: [
        'Restore a key from a backup',
        'Configure a new machine with an existing key',
        'Synchronize multiple application instances'
      ],
      exportWarning: '⚠️ WARNING!\n\nYou are about to export the encryption key.\nThis key allows decryption of all your passwords.\n\nMake sure to store it in a safe place!\n\nContinue?',
      exportSuccess: '✓ Key exported successfully!\n\nLocation: {path}\n\nSave this file in a safe place (USB, encrypted cloud, etc.)',
      exportError: '✗ Export error: {error}',
      importWarning: '⚠️ WARNING!\n\nYou are about to import an encryption key.\nThis will replace the current key.\n\nAfter import, only passwords encrypted with this new key will be decryptable.\n\nDo you want to continue?',
      importSuccess: '✓ Key imported successfully!\n\nThe application will restart to apply the changes.',
      importError: '✗ Import error: {error}',
      copyPath: '📋 Path copied to clipboard!',
      copyError: '✗ Error during key export'
    },
    about: {
      title: 'Information',
      version: 'Version',
      author: 'Author',
      encryption: 'Encryption',
      platform: 'Platform',
      updates: 'Updates',
      updateAvailable: '🎉 New version available: {version}',
      updateCurrent: 'Your version: {version}',
      upToDate: '✓ You are using the latest version',
      checkButton: 'Check for updates',
      checking: 'Checking...',
      checkNote: 'Check is done on GitHub Releases. Make sure you have an internet connection.',
      description: 'bbdump is a cross-platform PostgreSQL backup manager that allows you to schedule and manage your database backups.',
      features: '...',
      copyright: '© 2025 {author}. All rights reserved.'
    },
    modal: {
      addDatabase: 'Add a database',
      editDatabase: 'Edit database',
      warning: '<strong>Important:</strong> The database must ALREADY EXIST on your PostgreSQL server. This application only configures backups, it does not create databases.',
      editWarning: '<strong>Reminder:</strong> Make sure the database name corresponds to an EXISTING database on your PostgreSQL server.',
      manualConfig: 'Manual Config',
      urlConfig: 'PostgreSQL URL',
      connectionUrl: 'PostgreSQL connection URL',
      urlFormat: 'Format: postgresql://user:password@host:port/database',
      dbName: 'Database name',
      dbNameTech: 'Technical name of the database on PostgreSQL',
      displayName: 'Display name (optional)',
      displayNamePlaceholder: 'E.g.: Production DB, Mobile App, etc.',
      displayNameDesc: 'Friendly name to better identify this database in the interface',
      host: 'Host',
      port: 'Port',
      user: 'User',
      password: 'Password',
      passwordPlaceholder: 'Leave empty to keep current password',
      passwordKeep: 'Leave empty to keep the current password',
      encryptPassword: 'Encrypt password (recommended)',
      encryptBackups: 'Encrypt backup files',
      encryptBackupsDesc: '.backup files will be encrypted (AES-256-GCM)',
      scheduling: '⏰ Automatic scheduling <span class="text-gray-400 text-xs">(optional)</span>',
      cronNone: 'None',
      cronPreset: '⚡ Preset',
      cronVisual: 'Visual',
      cronManual: 'Manual',
      cronChoose: 'Choose a frequency...',
      cronExpression: 'Expression: {expr}',
      cronNoSelection: 'No selection',
      cronMinute: 'Minute',
      cronHour: 'Hour',
      cronDay: 'Day',
      cronMonth: 'Month',
      cronDayWeek: 'Day of week',
      cronHelp: '* = all, 0-59 for minute, 0-23 for hour, 1-31 for day, 1-12 for month, 0-7 for day of week',
      cronFormat: 'Format: minute hour day month day_of_week',
      cronManualOnly: 'Manual backups only',
      outputPath: 'Output path',
      addButton: 'Add',
      editButton: 'Edit',
      cancel: 'Cancel',
      close: 'Close'
    },
    restore: {
      title: 'Import a backup',
      titleProgress: 'Restore in progress',
      fileToRestore: '📁 File to restore:',
      warning: '<strong>⚠️  Warning:</strong> This operation will import data from the backup into the target database. Existing data will be overwritten.',
      targetUrl: 'Target database URL',
      targetUrlDesc: 'The database must exist and be accessible',
      startButton: '🚀 Start restore',
      cancel: 'Cancel',
      inProgress: 'Restore in progress...',
      success: 'Restore successful!',
      error: 'Error during restore',
      source: '📁 Source:',
      target: '🎯 Target:',
      close: 'Close',
      confirmMsg: 'Are you sure you want to restore "{file}" into database "{name}"?\n\n⚠️ WARNING: This operation will overwrite existing data in the target database!'
    },
    backup: {
      title: 'Backup in progress - {name}',
      inProgress: 'Backup in progress...',
      success: 'Backup completed successfully',
      error: 'Error during backup',
      errorLabel: 'Error:',
      close: 'Close',
      waiting: 'Waiting for logs...'
    },
    cron: {
      everyDay2am: 'Every day at 2:00 AM',
      everyDayMidnight: 'Every day at midnight',
      every6hours: 'Every 6 hours',
      every12hours: 'Every 12 hours',
      everySunday: 'Every Sunday at midnight',
      everyMonday: 'Every Monday at midnight',
      firstOfMonth: '1st of each month at midnight',
      weekdays3am: 'Monday to Friday at 3:00 AM',
      custom: 'Custom'
    },
    toasts: {
      scheduledBackupStarted: 'Automatic backup started: {name}',
      scheduledBackupSuccess: 'Backup successful: {name}',
      scheduledBackupError: 'Backup error: {name}',
      scheduleEnabled: 'Scheduled tasks enabled: {name}',
      schedulePaused: 'Scheduled tasks paused: {name}',
      scheduleError: 'Error during modification',
      updateError: 'Error: Unable to check for updates. Check your internet connection or configure the GitHub URL in the code.'
    }
  },
  fr: {
    app: {
      title: 'BBDUMP',
      subtitle: 'Backup Manager'
    },
    tabs: {
      databases: 'Databases',
      backups: 'Backups',
      logs: 'Logs',
      scheduled: 'Scheduled',
      settings: 'Settings',
      about: 'About'
    },
    databases: {
      title: 'BASES DE DONNÉES CONFIGURÉES',
      addButton: 'Ajouter une base',
      noData: 'AUCUNE BASE DE DONNÉES CONFIGURÉE',
      backup: 'Backup',
      running: 'En cours...',
      edit: 'Modifier',
      delete: 'Supprimer',
      pauseSchedule: 'Pause les tâches planifiées',
      enableSchedule: 'Activer les tâches planifiées',
      encrypted: 'PASS',
      encryptedBackup: 'BACKUP',
      deleteConfirm: 'Êtes-vous sûr de vouloir supprimer la base "{name}" ?',
      tableDatabase: 'Base de données',
      tableHost: 'Hôte / Connexion',
      tableSchedule: 'Planification',
      tableEncryption: 'Chiffrement',
      tableBackup: 'Backup',
      tableActions: 'Actions',
      statusActive: '⏸ ACTIF',
      statusPaused: '▶ PAUSE',
      statusManual: 'Manuel',
      viewDatabase: 'Voir la base'
    },
    backups: {
      title: 'Sauvegardes réalisées',
      stats: '{count} sauvegarde(s) affichée(s) • {size}',
      statsTotal: '({total} total)',
      deleteSelected: 'Delete ({count})',
      refresh: 'Refresh',
      filter: 'Filtrer par base :',
      filterAll: 'Toutes les bases de données',
      filterReset: 'Réinitialiser',
      selected: '{count} sélectionné(s)',
      noData: 'NO BACKUPS FOUND',
      noFiltered: 'AUCUN BACKUP POUR CETTE BASE',
      showAll: 'Afficher tous les backups',
      file: 'File',
      size: 'Size',
      encryption: 'Chiffrement',
      encrypted: '🔒 CHIFFRÉ',
      notEncrypted: '—',
      date: 'Date',
      import: 'Import',
      delete: 'Delete',
      deleteConfirm: 'Êtes-vous sûr de vouloir supprimer la sauvegarde "{name}" ?\n\nCette action est irréversible.',
      deleteMultipleConfirm: 'Êtes-vous sûr de vouloir supprimer {count} sauvegarde(s) ?\n\nCette action est irréversible.',
      deleteSuccess: '{count} sauvegarde(s) supprimée(s) avec succès',
      deleteError: '{success} sauvegarde(s) supprimée(s), {error} erreur(s)'
    },
    logs: {
      title: 'Logs de l\'application',
      refresh: 'Refresh',
      clear: 'Clear',
      noData: 'Aucun log disponible',
      clearConfirm: 'Êtes-vous sûr de vouloir effacer tous les logs ?'
    },
    scheduled: {
      title: 'Tâches planifiées',
      refresh: 'Refresh',
      noData: 'Aucune tâche planifiée',
      database: 'Base de données',
      status: 'Statut',
      statusActive: '● Actif',
      statusPaused: '⏸ En pause',
      schedule: 'Planification',
      lastBackup: 'Dernier backup',
      never: 'Jamais'
    },
    settings: {
      title: 'Paramètres de sécurité',
      language: 'Langue',
      languageDescription: 'Choisissez votre langue préférée',
      encryptionTitle: '🔒 Clé de chiffrement',
      keyPresent: 'Clé de chiffrement présente',
      keyAbsent: 'Clé de chiffrement absente',
      keyPresentDesc: 'Vos mots de passe sont chiffrés avec AES-256-GCM.',
      keyAbsentDesc: 'Aucune clé trouvée. Une nouvelle clé sera générée automatiquement.',
      exportKeyTitle: '📤 Export Key',
      exportKeyDesc: 'Sauvegardez la clé de chiffrement dans un fichier pour la transférer vers une autre machine ou la mettre en sécurité.',
      exportKeyButton: 'Export Key',
      importKeyTitle: '📥 Import Key',
      importKeyDesc: 'Restaurez une clé de chiffrement depuis un fichier. Nécessaire pour déchiffrer les mots de passe sur une nouvelle machine.',
      importKeyButton: 'Import Key',
      warningTitle: 'Important - Sécurité de la clé',
      warningItems: [
        'Sans cette clé, vos mots de passe ne peuvent PAS être déchiffrés',
        'Sauvegardez la clé dans un endroit sûr (USB, cloud chiffré)',
        'Ne partagez JAMAIS cette clé publiquement',
        'Utilisez la même clé sur toutes les machines pour partager la config'
      ],
      useCaseTitle: '💡 Cas d\'usage',
      exportUseCase: 'Export :',
      exportItems: [
        'Créer un backup de sécurité de votre clé',
        'Transférer votre configuration vers une autre machine',
        'Partager la configuration entre plusieurs instances'
      ],
      importUseCase: 'Import :',
      importItems: [
        'Restaurer une clé depuis un backup',
        'Configurer une nouvelle machine avec une clé existante',
        'Synchroniser plusieurs instances de l\'application'
      ],
      exportWarning: '⚠️ ATTENTION !\n\nVous allez exporter la clé de chiffrement.\nCette clé permet de déchiffrer tous vos mots de passe.\n\nAssurez-vous de la stocker dans un endroit sûr !\n\nContinuer ?',
      exportSuccess: '✓ Clé exportée avec succès !\n\nEmplacement : {path}\n\nSauvegardez ce fichier dans un lieu sûr (USB, cloud chiffré, etc.)',
      exportError: '✗ Erreur lors de l\'export : {error}',
      importWarning: '⚠️ ATTENTION !\n\nVous allez importer une clé de chiffrement.\nCela remplacera la clé actuelle.\n\nAprès l\'import, seuls les mots de passe chiffrés avec cette nouvelle clé seront déchiffrables.\n\nVoulez-vous continuer ?',
      importSuccess: '✓ Clé importée avec succès !\n\nL\'application va redémarrer pour appliquer les changements.',
      importError: '✗ Erreur lors de l\'import : {error}',
      copyPath: '📋 Chemin copié dans le presse-papier !',
      copyError: '✗ Erreur lors de l\'export de la clé'
    },
    about: {
      title: 'Informations',
      version: 'Version',
      author: 'Auteur',
      encryption: 'Chiffrement',
      platform: 'Platform',
      updates: 'Mises à jour',
      updateAvailable: '🎉 Nouvelle version disponible : {version}',
      updateCurrent: 'Votre version : {version}',
      upToDate: '✓ Vous utilisez la dernière version',
      checkButton: 'Vérifier les mises à jour',
      checking: 'Vérification...',
      checkNote: 'La vérification se fait sur GitHub Releases. Assurez-vous d\'avoir une connexion internet.',
      description: 'bbdump est un gestionnaire de sauvegardes PostgreSQL cross-platform qui permet de planifier et gérer vos backups.',
      features: '...',
      copyright: '© 2025 {author}. Tous droits réservés.'
    },
    modal: {
      addDatabase: 'Ajouter une base de données',
      editDatabase: 'Modifier la base de données',
      warning: '<strong>Important :</strong> La base de données doit DÉJÀ EXISTER sur votre serveur PostgreSQL. Cette application configure seulement des backups, elle ne crée pas de bases de données.',
      editWarning: '<strong>Rappel :</strong> Assurez-vous que le nom de la base correspond à une base EXISTANTE sur votre serveur PostgreSQL.',
      manualConfig: 'Manual Config',
      urlConfig: 'PostgreSQL URL',
      connectionUrl: 'URL de connexion PostgreSQL',
      urlFormat: 'Format: postgresql://utilisateur:motdepasse@host:port/nom_base',
      dbName: 'Nom de la base',
      dbNameTech: 'Nom technique de la base sur PostgreSQL',
      displayName: 'Nom d\'affichage (optionnel)',
      displayNamePlaceholder: 'Ex: Base de production, App mobile, etc.',
      displayNameDesc: 'Nom convivial pour mieux identifier cette base dans l\'interface',
      host: 'Host',
      port: 'Port',
      user: 'Utilisateur',
      password: 'Mot de passe',
      passwordPlaceholder: 'Laisser vide pour ne pas changer',
      passwordKeep: 'Laissez vide pour conserver le mot de passe actuel',
      encryptPassword: 'Chiffrer le mot de passe (recommandé)',
      encryptBackups: 'Chiffrer les fichiers de backup',
      encryptBackupsDesc: 'Les fichiers .backup seront chiffrés (AES-256-GCM)',
      scheduling: '⏰ Planification automatique <span class="text-gray-400 text-xs">(optionnel)</span>',
      cronNone: 'None',
      cronPreset: '⚡ Présélection',
      cronVisual: 'Visual',
      cronManual: 'Manual',
      cronChoose: 'Choisir une fréquence...',
      cronExpression: 'Expression: {expr}',
      cronNoSelection: 'Aucune sélection',
      cronMinute: 'Minute',
      cronHour: 'Heure',
      cronDay: 'Jour',
      cronMonth: 'Mois',
      cronDayWeek: 'Jour sem.',
      cronHelp: '* = tous, 0-59 pour minute, 0-23 pour heure, 1-31 pour jour, 1-12 pour mois, 0-7 pour jour semaine',
      cronFormat: 'Format: minute heure jour mois jour_semaine',
      cronManualOnly: 'Sauvegardes manuelles uniquement',
      outputPath: 'Chemin de sortie',
      addButton: 'Ajouter',
      editButton: 'Modifier',
      cancel: 'Annuler',
      close: 'Fermer'
    },
    restore: {
      title: 'Import une sauvegarde',
      titleProgress: 'Restauration en cours',
      fileToRestore: '📁 Fichier à restaurer :',
      warning: '<strong>⚠️  Attention :</strong> Cette opération va importer les données du backup dans la base cible. Les données existantes seront écrasées.',
      targetUrl: 'URL de la base de données cible',
      targetUrlDesc: 'La base de données doit exister et être accessible',
      startButton: '🚀 Démarrer la restauration',
      cancel: 'Annuler',
      inProgress: 'Restauration en cours...',
      success: 'Restauration réussie !',
      error: 'Erreur lors de la restauration',
      source: '📁 Source :',
      target: '🎯 Cible :',
      close: 'Fermer',
      confirmMsg: 'Êtes-vous sûr de vouloir restaurer "{file}" dans la base "{name}" ?\n\n⚠️ ATTENTION : Cette opération va écraser les données existantes dans la base cible !'
    },
    backup: {
      title: 'Backup en cours - {name}',
      inProgress: 'Sauvegarde en cours...',
      success: 'Sauvegarde terminée avec succès',
      error: 'Erreur lors de la sauvegarde',
      errorLabel: 'Erreur:',
      close: 'Fermer',
      waiting: 'En attente de logs...'
    },
    cron: {
      everyDay2am: 'Tous les jours à 2h00',
      everyDayMidnight: 'Tous les jours à minuit',
      every6hours: 'Toutes les 6 heures',
      every12hours: 'Toutes les 12 heures',
      everySunday: 'Tous les dimanches à minuit',
      everyMonday: 'Tous les lundis à minuit',
      firstOfMonth: 'Le 1er de chaque mois à minuit',
      weekdays3am: 'Du lundi au vendredi à 3h00',
      custom: 'Personnalisé'
    },
    toasts: {
      scheduledBackupStarted: 'Backup automatique démarré : {name}',
      scheduledBackupSuccess: 'Backup réussi : {name}',
      scheduledBackupError: 'Erreur backup : {name}',
      scheduleEnabled: 'Tâches planifiées activées : {name}',
      schedulePaused: 'Tâches planifiées en pause : {name}',
      scheduleError: 'Erreur lors de la modification',
      updateError: 'Erreur : Impossible de vérifier les mises à jour. Vérifiez votre connexion internet ou configurez l\'URL GitHub dans le code.'
    }
  }
};

createApp({
  data() {
    return {
      activeTab: 'databases',
      config: { databases: [] },
      logs: [],
      scheduledTasks: [],
      showAddModal: false,
      showEditModal: false,
      isBackingUp: {},
      openMenuDb: null, // Pour tracker quel menu database est ouvert
      showDbViewer: false,
      viewerDb: null,
      dbTables: [],
      selectedTable: null,
      tableSchema: null,
      tableData: [],
      tableDataTotal: 0,
      tableDataOffset: 0,
      tableDataHasMore: false,
      tableRelations: [],
      loadingTables: false,
      loadingTableData: false,
      loadingMoreData: false,
      viewerSections: {
        schema: false,
        relations: false,
        data: true
      },
      tableDataSearch: '',
      searchDebounceTimer: null,
      visibleColumns: [],
      showColumnsMenu: false,
      useUrl: false,
      connectionUrl: '',
      editingDb: null,
      editingDbOriginalName: '',
      cronMode: 'none', // 'none', 'preset', 'visual', 'manual'
      cronPreset: '',
      cronVisual: {
        minute: '0',
        hour: '2',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*'
      },
      currentLanguage: localStorage.getItem('bbdump_language') || 'fr',
      newDb: {
        name: '',
        displayName: '',
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: '',
        encrypted: true,
        encryptBackups: false,
        cron: '',
        output: 'backups/database.backup',
        enabled: true
      },
      backups: [],
      backupStats: { total: 0, totalSize: 0 },
      showRestoreModal: false,
      restoreBackupFile: '',
      restoreUrl: '',
      restoreProgress: {
        backupFile: '',
        targetUrl: '',
        logs: [],
        status: 'input', // 'input', 'running', 'success', 'error'
        error: null
      },
      encryptionKeyExists: false,
      encryptionKeyPath: '',
      appVersion: '1.8.3',
      appAuthor: 'Poups',
      checkingUpdate: false,
      updateAvailable: false,
      latestVersion: null,
      showBackupModal: false,
      backupProgress: {
        dbName: '',
        logs: [],
        status: 'running', // 'running', 'success', 'error'
        error: null
      },
      backupFilter: 'all',
      selectedBackups: [],
      toasts: []
    };
  },
  
  mounted() {
    this.loadConfig();
    this.loadLogs();
    this.loadScheduledTasks();
    this.loadBackups();
    this.checkEncryptionKey();

    // Fermer les menus quand on clique ailleurs
    document.addEventListener('click', () => {
      this.openMenuDb = null;
      this.showColumnsMenu = false;
    });
    
    // Écouter les événements de backup automatique
    ipcRenderer.on('scheduled-backup-started', (event, data) => {
      const displayName = this.getDbDisplayNameByName(data.database);
      this.showToast(this.t('toasts.scheduledBackupStarted', { name: displayName }), 'info');
    });

    ipcRenderer.on('scheduled-backup-completed', (event, data) => {
      const displayName = this.getDbDisplayNameByName(data.database);
      if (data.success) {
        this.showToast(this.t('toasts.scheduledBackupSuccess', { name: displayName }), 'success');
        this.loadBackups(); // Rafraîchir la liste des backups
      } else {
        this.showToast(this.t('toasts.scheduledBackupError', { name: displayName }), 'error');
      }
      this.loadLogs(); // Rafraîchir les logs
    });
  },
  
  watch: {
    tableDataSearch(newValue) {
      // Debounce la recherche pour ne pas faire trop de requêtes
      if (this.searchDebounceTimer) {
        clearTimeout(this.searchDebounceTimer);
      }

      this.searchDebounceTimer = setTimeout(() => {
        this.performSearch();
      }, 500); // Attendre 500ms après la dernière frappe
    }
  },

  computed: {
    // i18n translation function
    t() {
      return (key, params = {}) => {
        const keys = key.split('.');
        let value = translations[this.currentLanguage];

        for (const k of keys) {
          if (value && typeof value === 'object') {
            value = value[k];
          } else {
            return key;
          }
        }

        // Replace parameters like {name}, {count}, etc.
        if (typeof value === 'string' && Object.keys(params).length > 0) {
          return value.replace(/\{(\w+)\}/g, (match, paramKey) => {
            return params[paramKey] !== undefined ? params[paramKey] : match;
          });
        }

        return value || key;
      };
    },

    // Dynamic tabs with translations
    tabs() {
      return [
        { id: 'databases', label: this.t('tabs.databases') },
        { id: 'backups', label: this.t('tabs.backups') },
        { id: 'logs', label: this.t('tabs.logs') },
        { id: 'scheduled', label: this.t('tabs.scheduled') },
        { id: 'settings', label: this.t('tabs.settings') },
        { id: 'about', label: this.t('tabs.about') }
      ];
    },

    // Dynamic cron presets with translations
    cronPresets() {
      return [
        { value: '0 2 * * *', label: this.t('cron.everyDay2am') },
        { value: '0 0 * * *', label: this.t('cron.everyDayMidnight') },
        { value: '0 */6 * * *', label: this.t('cron.every6hours') },
        { value: '0 */12 * * *', label: this.t('cron.every12hours') },
        { value: '0 0 * * 0', label: this.t('cron.everySunday') },
        { value: '0 0 * * 1', label: this.t('cron.everyMonday') },
        { value: '0 0 1 * *', label: this.t('cron.firstOfMonth') },
        { value: '0 3 * * 1-5', label: this.t('cron.weekdays3am') }
      ];
    },

    filteredBackups() {
      if (this.backupFilter === 'all') {
        return this.backups;
      }
      return this.backups.filter(backup => {
        // Extraire le nom de la DB du nom du fichier (avant le timestamp)
        const dbName = backup.name.split('_')[0];
        return dbName === this.backupFilter;
      });
    },

    // Helper pour obtenir le nom d'affichage d'une DB
    getDbDisplayName() {
      return (db) => {
        if (db.displayName && db.displayName.trim() !== '') {
          return db.displayName;
        }
        return db.name;
      };
    },
    
    availableDatabases() {
      // Extraire les noms de DB uniques des backups
      const dbNames = new Set();
      this.backups.forEach(backup => {
        const dbName = backup.name.split('_')[0];
        dbNames.add(dbName);
      });
      return Array.from(dbNames).sort();
    },
    
    filteredBackupStats() {
      const filtered = this.filteredBackups;
      return {
        total: filtered.length,
        totalSize: filtered.reduce((sum, backup) => sum + backup.size, 0)
      };
    },
    
    allSelected() {
      return this.filteredBackups.length > 0 && 
             this.selectedBackups.length === this.filteredBackups.length;
    },
    
    someSelected() {
      return this.selectedBackups.length > 0 && 
             this.selectedBackups.length < this.filteredBackups.length;
    }
  },
  
  methods: {
    toggleDbMenu(dbName) {
      this.openMenuDb = this.openMenuDb === dbName ? null : dbName;
    },

    toggleColumn(columnName) {
      const index = this.visibleColumns.indexOf(columnName);
      if (index > -1) {
        // Empêcher de décocher si c'est la dernière colonne visible
        if (this.visibleColumns.length > 1) {
          this.visibleColumns.splice(index, 1);
        }
      } else {
        this.visibleColumns.push(columnName);
      }
    },

    selectAllColumns() {
      if (this.tableData.length > 0) {
        this.visibleColumns = Object.keys(this.tableData[0]);
      }
    },

    deselectAllColumns() {
      // Garder au moins une colonne visible (la première)
      if (this.tableData.length > 0) {
        this.visibleColumns = [Object.keys(this.tableData[0])[0]];
      }
    },

    async openDatabaseViewer(db) {
      this.viewerDb = db;
      this.showDbViewer = true;
      this.selectedTable = null;
      this.tableSchema = null;
      this.tableData = [];
      this.tableRelations = [];
      await this.loadDatabaseTables();
    },

    closeDatabaseViewer() {
      this.showDbViewer = false;
      this.viewerDb = null;
      this.dbTables = [];
      this.selectedTable = null;
    },

    async loadDatabaseTables() {
      if (!this.viewerDb) return;

      this.loadingTables = true;
      try {
        const result = await ipcRenderer.invoke('get-database-tables', {
          host: this.viewerDb.host,
          port: this.viewerDb.port,
          user: this.viewerDb.user,
          password: this.viewerDb.password,
          database: this.viewerDb.name,
          connectionString: this.viewerDb.connectionString
        });
        this.dbTables = result.tables;
      } catch (error) {
        console.error('Error loading tables:', error);
        alert('Error loading database tables: ' + error.message);
      } finally {
        this.loadingTables = false;
      }
    },

    async selectTable(tableName) {
      this.selectedTable = tableName;
      this.tableDataSearch = ''; // Reset search when changing table
      this.tableDataOffset = 0;
      this.loadingTableData = true;

      try {
        // Charger le schéma
        const schemaResult = await ipcRenderer.invoke('get-table-schema', {
          host: this.viewerDb.host,
          port: this.viewerDb.port,
          user: this.viewerDb.user,
          password: this.viewerDb.password,
          database: this.viewerDb.name,
          connectionString: this.viewerDb.connectionString,
          table: tableName
        });
        this.tableSchema = schemaResult;

        // Charger un aperçu des données
        await this.loadTableData(false);

        // Initialiser toutes les colonnes comme visibles
        if (this.tableData.length > 0) {
          this.visibleColumns = Object.keys(this.tableData[0]);
        }

        // Charger les relations
        const relationsResult = await ipcRenderer.invoke('get-table-relations', {
          host: this.viewerDb.host,
          port: this.viewerDb.port,
          user: this.viewerDb.user,
          password: this.viewerDb.password,
          database: this.viewerDb.name,
          connectionString: this.viewerDb.connectionString,
          table: this.selectedTable
        });
        this.tableRelations = relationsResult.relations;
      } catch (error) {
        console.error('Error loading table data:', error);
        alert('Error loading table: ' + error.message);
      } finally {
        this.loadingTableData = false;
      }
    },

    async loadTableData(append = false) {
      if (!this.selectedTable) return;

      try {
        const dataResult = await ipcRenderer.invoke('get-table-data', {
          host: this.viewerDb.host,
          port: this.viewerDb.port,
          user: this.viewerDb.user,
          password: this.viewerDb.password,
          database: this.viewerDb.name,
          connectionString: this.viewerDb.connectionString,
          table: this.selectedTable,
          limit: 100,
          offset: append ? this.tableDataOffset : 0,
          search: this.tableDataSearch || undefined
        });

        if (append) {
          this.tableData = [...this.tableData, ...dataResult.rows];
        } else {
          this.tableData = dataResult.rows;
        }

        this.tableDataTotal = dataResult.total;
        this.tableDataOffset = dataResult.offset + dataResult.rows.length;
        this.tableDataHasMore = dataResult.hasMore;
      } catch (error) {
        console.error('Error loading table data:', error);
        throw error;
      }
    },

    async loadMoreData() {
      if (!this.tableDataHasMore || this.loadingMoreData) return;

      this.loadingMoreData = true;
      try {
        await this.loadTableData(true);
      } catch (error) {
        alert('Error loading more data: ' + error.message);
      } finally {
        this.loadingMoreData = false;
      }
    },

    async performSearch() {
      if (!this.selectedTable) return;

      this.tableDataOffset = 0;
      this.loadingTableData = true;
      try {
        await this.loadTableData(false);
      } catch (error) {
        alert('Error searching data: ' + error.message);
      } finally {
        this.loadingTableData = false;
      }
    },

    async loadConfig() {
      try {
        this.config = await ipcRenderer.invoke('get-config');
      } catch (error) {
        console.error('Erreur lors du chargement de la configuration:', error);
      }
    },
    
    async loadLogs() {
      try {
        this.logs = await ipcRenderer.invoke('get-logs', 100);
      } catch (error) {
        console.error('Erreur lors du chargement des logs:', error);
      }
    },
    
    async loadScheduledTasks() {
      try {
        this.scheduledTasks = await ipcRenderer.invoke('get-scheduled-tasks');
      } catch (error) {
        console.error('Erreur lors du chargement des tâches planifiées:', error);
      }
    },
    
    async loadBackups() {
      try {
        const result = await ipcRenderer.invoke('get-backups');
        this.backups = result.backups;
        this.backupStats = result.stats;
      } catch (error) {
        console.error('Erreur lors du chargement des sauvegardes:', error);
      }
    },

    async checkEncryptionKey() {
      try {
        const result = await ipcRenderer.invoke('check-encryption-key');
        this.encryptionKeyExists = result.exists;
        this.encryptionKeyPath = result.path;
      } catch (error) {
        console.error('Erreur lors de la vérification de la clé:', error);
      }
    },

    async exportEncryptionKey() {
      if (!confirm(this.t('settings.exportWarning'))) {
        return;
      }

      try {
        const result = await ipcRenderer.invoke('export-encryption-key');
        if (result.success) {
          alert(this.t('settings.exportSuccess', { path: result.path }));
        } else {
          alert(this.t('settings.exportError', { error: result.error }));
        }
      } catch (error) {
        console.error('Erreur lors de l\'export de la clé:', error);
        alert(this.t('settings.copyError'));
      }
    },

    async importEncryptionKey() {
      if (!confirm(this.t('settings.importWarning'))) {
        return;
      }

      try {
        const result = await ipcRenderer.invoke('import-encryption-key');
        if (result.success) {
          alert(this.t('settings.importSuccess'));
          // Recharger la config
          await this.loadConfig();
          await this.checkEncryptionKey();
        } else if (result.cancelled) {
          // Utilisateur a annulé
        } else {
          alert(this.t('settings.importError', { error: result.error }));
        }
      } catch (error) {
        console.error('Erreur lors de l\'import de la clé:', error);
        alert(this.t('settings.copyError'));
      }
    },

    copyEncryptionKeyPath() {
      navigator.clipboard.writeText(this.encryptionKeyPath);
      alert(this.t('settings.copyPath'));
    },
    
    async deleteBackup(filename) {
      if (confirm(`Êtes-vous sûr de vouloir supprimer la sauvegarde "${filename}" ?\n\nCette action est irréversible.`)) {
        try {
          await ipcRenderer.invoke('delete-backup', filename);
          this.selectedBackups = this.selectedBackups.filter(name => name !== filename);
          this.loadBackups();
        } catch (error) {
          console.error('Erreur lors de la suppression:', error);
          alert('Erreur lors de la suppression de la sauvegarde');
        }
      }
    },
    
    toggleBackupSelection(filename) {
      const index = this.selectedBackups.indexOf(filename);
      if (index > -1) {
        this.selectedBackups.splice(index, 1);
      } else {
        this.selectedBackups.push(filename);
      }
    },
    
    toggleSelectAll() {
      if (this.allSelected) {
        this.selectedBackups = [];
      } else {
        this.selectedBackups = this.filteredBackups.map(b => b.name);
      }
    },
    
    async deleteSelectedBackups() {
      const count = this.selectedBackups.length;
      if (count === 0) {
        alert('Aucune sauvegarde sélectionnée');
        return;
      }
      
      const confirmMsg = `Êtes-vous sûr de vouloir supprimer ${count} sauvegarde(s) ?\n\nCette action est irréversible.`;
      if (!confirm(confirmMsg)) {
        return;
      }
      
      try {
        let successCount = 0;
        let errorCount = 0;
        
        for (const filename of this.selectedBackups) {
          try {
            await ipcRenderer.invoke('delete-backup', filename);
            successCount++;
          } catch (error) {
            console.error(`Erreur lors de la suppression de ${filename}:`, error);
            errorCount++;
          }
        }
        
        this.selectedBackups = [];
        this.loadBackups();
        
        if (errorCount > 0) {
          alert(`${successCount} sauvegarde(s) supprimée(s), ${errorCount} erreur(s)`);
        } else {
          alert(`${successCount} sauvegarde(s) supprimée(s) avec succès`);
        }
      } catch (error) {
        console.error('Erreur lors de la suppression multiple:', error);
        alert('Erreur lors de la suppression des sauvegardes');
      }
    },
    
    clearBackupFilter() {
      this.backupFilter = 'all';
      this.selectedBackups = [];
    },
    
    formatFileSize(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    },
    
    openRestoreModal(backupFile) {
      this.restoreBackupFile = backupFile;
      this.restoreUrl = '';
      this.restoreProgress = {
        backupFile: backupFile,
        targetUrl: '',
        logs: [],
        status: 'input',
        error: null
      };
      this.showRestoreModal = true;
    },
    
    closeRestoreModal() {
      this.showRestoreModal = false;
      this.restoreBackupFile = '';
      this.restoreUrl = '';
      this.restoreProgress = {
        backupFile: '',
        targetUrl: '',
        logs: [],
        status: 'input',
        error: null
      };
    },
    
    async startRestoreBackup() {
      if (!this.restoreUrl || this.restoreUrl.trim() === '') {
        alert('Veuillez saisir une URL de base de données');
        return;
      }
      
      // Valider l'URL
      const parsed = this.parsePostgresUrl(this.restoreUrl);
      if (!parsed) {
        alert('URL PostgreSQL invalide. Format attendu: postgresql://user:password@host:port/database');
        return;
      }

      const confirmMsg = `Êtes-vous sûr de vouloir restaurer "${this.restoreBackupFile}" dans la base "${parsed.name}" ?\n\n⚠️ ATTENTION : Cette opération va écraser les données existantes dans la base cible !`;

      if (!confirm(confirmMsg)) {
        return;
      }

      // Passer en mode exécution
      this.restoreProgress.status = 'running';
      this.restoreProgress.targetUrl = this.restoreUrl;
      this.restoreProgress.logs = [];
      this.restoreProgress.error = null;

      // Ajouter la connectionString complète à l'objet target
      const target = {
        ...parsed,
        connectionString: this.restoreUrl
      };

      // Démarrer l'exécution
      await this.executeRestore(target);
    },
    
    async executeRestore(target) {
      this.addRestoreLog('🔄 Préparation de la restauration...', 'info');
      await this.sleep(300);
      
      this.addRestoreLog(`📁 Fichier source : ${this.restoreBackupFile}`, 'info');
      this.addRestoreLog(`🎯 Base cible : ${target.name}@${target.host}:${target.port}`, 'info');
      await this.sleep(500);
      
      this.addRestoreLog('⚠️  ATTENTION : Les données existantes vont être écrasées !', 'warning');
      await this.sleep(500);
      
      this.addRestoreLog('🚀 Démarrage de pg_restore...', 'info');
      await this.sleep(300);
      
      try {
        const result = await ipcRenderer.invoke('restore-backup', {
          backupFile: this.restoreBackupFile,
          target: target
        });
        
        await this.sleep(300);
        
        if (result.success) {
          this.addRestoreLog('✅ Restauration réussie !', 'success');
          
          if (result.output) {
            const outputLines = result.output.split('\n').filter(line => line.trim());
            outputLines.forEach(line => {
              this.addRestoreLog(line, 'info');
            });
          }
          
          this.restoreProgress.status = 'success';
          this.loadLogs(); // Rafraîchir les logs
        } else {
          this.addRestoreLog('❌ Erreur lors de la restauration', 'error');
          if (result.error) {
            const errorLines = result.error.split('\n').filter(line => line.trim());
            errorLines.forEach(line => {
              this.addRestoreLog(line, 'error');
            });
          }
          this.restoreProgress.status = 'error';
          this.restoreProgress.error = result.error || 'Erreur inconnue';
        }
      } catch (error) {
        console.error('Erreur lors de la restauration:', error);
        this.addRestoreLog(`❌ Erreur inattendue : ${error.message}`, 'error');
        this.restoreProgress.status = 'error';
        this.restoreProgress.error = error.message;
      }
    },
    
    addRestoreLog(message, type = 'info') {
      const timestamp = new Date().toLocaleTimeString('fr-FR');
      this.restoreProgress.logs.push({
        timestamp,
        message,
        type // 'info', 'success', 'error', 'warning'
      });
      
      // Auto-scroll
      this.$nextTick(() => {
        const logsContainer = this.$refs.restoreLogsContainer;
        if (logsContainer) {
          logsContainer.scrollTop = logsContainer.scrollHeight;
        }
      });
    },
    
    async clearLogs() {
      if (confirm('Êtes-vous sûr de vouloir effacer tous les logs ?')) {
        try {
          await ipcRenderer.invoke('clear-logs');
          this.logs = [];
        } catch (error) {
          console.error('Erreur lors de l\'effacement des logs:', error);
        }
      }
    },
    
    parsePostgresUrl(url) {
      try {
        console.log('=== PARSING URL ===');
        console.log('Input URL:', url);

        // Vérifier que c'est bien une URL PostgreSQL
        if (!url.startsWith('postgresql://') && !url.startsWith('postgres://')) {
          console.error('❌ Not a PostgreSQL URL');
          return null;
        }

        // L'API URL du navigateur ne reconnaît pas postgresql: comme protocole structuré
        // On remplace temporairement par http: pour parser correctement
        const httpUrl = url.replace(/^postgres(ql)?:\/\//, 'http://');
        console.log('Temporary HTTP URL for parsing:', httpUrl);

        const parsedUrl = new URL(httpUrl);
        console.log('Parsed URL object:', parsedUrl);
        console.log('Username:', parsedUrl.username);
        console.log('Password:', parsedUrl.password ? '***' : 'EMPTY');
        console.log('Hostname:', parsedUrl.hostname);
        console.log('Port:', parsedUrl.port);
        console.log('Pathname:', parsedUrl.pathname);

        // Extraire le nom de la base de données (sans les query parameters)
        const pathname = parsedUrl.pathname;
        const dbName = pathname.startsWith('/') ? pathname.substring(1) : pathname;
        console.log('DB Name extracted:', dbName);

        if (!parsedUrl.username || !parsedUrl.password || !parsedUrl.hostname || !dbName) {
          console.error('❌ Required fields missing:');
          console.error('  - username:', parsedUrl.username || 'MISSING');
          console.error('  - password:', parsedUrl.password ? 'OK' : 'MISSING');
          console.error('  - hostname:', parsedUrl.hostname || 'MISSING');
          console.error('  - dbName:', dbName || 'MISSING');
          return null;
        }

        const result = {
          user: decodeURIComponent(parsedUrl.username),
          password: decodeURIComponent(parsedUrl.password),
          host: parsedUrl.hostname,
          port: parseInt(parsedUrl.port || '5432'),
          name: dbName
        };
        console.log('✅ Parse successful:', result);
        return result;
      } catch (error) {
        console.error('❌ Exception during parsing:', error);
        return null;
      }
    },
    
    async addDatabase() {
      try {
        let dbConfig = { ...this.newDb };
        
        // Si utilisation d'une URL, parser l'URL
        if (this.useUrl && this.connectionUrl) {
          const parsed = this.parsePostgresUrl(this.connectionUrl);
          if (!parsed) {
            alert('URL PostgreSQL invalide. Format attendu: postgresql://user:password@host:port/database');
            return;
          }
          dbConfig = {
            ...dbConfig,
            connectionString: this.connectionUrl,
            name: parsed.name,
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            password: parsed.password,
            output: `backups/${parsed.name}.backup`
          };
        }
        
        // Appliquer le cron sélectionné
        dbConfig.cron = this.applyCronSelection();
        
        // Vérifier que le nom n'est pas vide
        if (!dbConfig.name) {
          alert('Le nom de la base de données est obligatoire');
          return;
        }
        
        this.config = await ipcRenderer.invoke('add-database', dbConfig);
        this.closeAddModal();
        this.loadScheduledTasks();
      } catch (error) {
        console.error('Erreur lors de l\'ajout de la base:', error);
        alert('Erreur lors de l\'ajout de la base de données');
      }
    },
    
    async removeDatabase(name) {
      if (confirm(this.t('databases.deleteConfirm', { name }))) {
        try {
          this.config = await ipcRenderer.invoke('remove-database', name);
          this.loadScheduledTasks();
        } catch (error) {
          console.error('Erreur lors de la suppression:', error);
        }
      }
    },
    
    async toggleSchedule(name) {
      try {
        const db = this.config.databases.find(d => d.name === name);
        if (!db) return;

        const newEnabledState = !(db.enabled !== false); // Par défaut true si undefined
        this.config = await ipcRenderer.invoke('toggle-schedule', name, newEnabledState);
        this.loadScheduledTasks();

        const displayName = this.getDbDisplayNameByName(name);
        if (newEnabledState) {
          this.showToast(this.t('toasts.scheduleEnabled', { name: displayName }), 'success');
        } else {
          this.showToast(this.t('toasts.schedulePaused', { name: displayName }), 'warning');
        }
      } catch (error) {
        console.error('Erreur lors du toggle:', error);
        this.showToast(this.t('toasts.scheduleError'), 'error');
      }
    },
    
    openEditModal(db) {
      this.editingDbOriginalName = db.name;
      this.editingDb = { 
        ...db,
        _originalPassword: db.password //Backup le mot de passe masqué original
      };
      this.useUrl = false;
      this.connectionUrl = '';
      this.parseCronToVisual(db.cron);
      this.showEditModal = true;
    },
    
    async updateDatabase() {
      try {
        let dbConfig = { ...this.editingDb };
        
        // Si utilisation d'une URL, parser l'URL
        if (this.useUrl && this.connectionUrl) {
          const parsed = this.parsePostgresUrl(this.connectionUrl);
          if (!parsed) {
            alert('URL PostgreSQL invalide. Format attendu: postgresql://user:password@host:port/database');
            return;
          }
          dbConfig = {
            ...dbConfig,
            connectionString: this.connectionUrl,
            name: parsed.name,
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            password: parsed.password,
            output: `backups/${parsed.name}.backup`
          };
        }
        
        // Appliquer le cron sélectionné
        dbConfig.cron = this.applyCronSelection();
        
        // Vérifier que le nom n'est pas vide
        if (!dbConfig.name) {
          alert('Le nom de la base de données est obligatoire');
          return;
        }
        
        this.config = await ipcRenderer.invoke('update-database', this.editingDbOriginalName, dbConfig);
        this.closeEditModal();
        this.loadScheduledTasks();
      } catch (error) {
        console.error('Erreur lors de la modification de la base:', error);
        alert('Erreur lors de la modification de la base de données');
      }
    },
    
    closeEditModal() {
      this.showEditModal = false;
      this.editingDb = null;
      this.editingDbOriginalName = '';
      this.useUrl = false;
      this.connectionUrl = '';
      this.cronMode = 'none';
      this.cronPreset = '';
      this.cronVisual = {
        minute: '0',
        hour: '2',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*'
      };
    },
    
    openBackupModal(name) {
      // Ouvrir la modal et initialiser
      this.backupProgress = {
        dbName: name,
        logs: [],
        status: 'running',
        error: null
      };
      this.showBackupModal = true;
      
      // Lancer le backup
      this.executeBackup(name);
    },
    
    async executeBackup(name) {
      this.isBackingUp[name] = true;
      
      // Log initial
      this.addBackupLog(`Démarrage de la sauvegarde de ${name}...`);
      
      // Simuler des logs de progression
      this.addBackupLog(`Connexion à la base de données PostgreSQL...`);
      await this.sleep(300);
      
      this.addBackupLog(`Vérification des permissions...`);
      await this.sleep(200);
      
      this.addBackupLog(`Préparation de pg_dump...`);
      await this.sleep(200);
      
      this.addBackupLog(`Exécution de la sauvegarde...`);
      
      try {
        const result = await ipcRenderer.invoke('backup-now', name);
        
        if (result.success) {
          this.addBackupLog(`Sauvegarde terminée avec succès`);
          if (result.message) {
            this.addBackupLog(result.message);
          }
          this.addBackupLog(`Timestamp: ${result.timestamp}`);
          this.backupProgress.status = 'success';
          this.loadLogs();
          this.loadBackups();
        } else {
          this.addBackupLog(`ERREUR: ${result.error}`, 'error');
          this.backupProgress.status = 'error';
          this.backupProgress.error = result.error;
        }
      } catch (error) {
        console.error('Erreur lors de la sauvegarde:', error);
        this.addBackupLog(`ERREUR CRITIQUE: ${error.message || error}`, 'error');
        this.backupProgress.status = 'error';
        this.backupProgress.error = error.message || 'Erreur inconnue';
      } finally {
        this.isBackingUp[name] = false;
      }
    },
    
    addBackupLog(message, type = 'info') {
      const timestamp = new Date().toLocaleTimeString();
      const prefix = type === 'error' ? '✗' : type === 'success' ? '✓' : '>';
      this.backupProgress.logs.push(`[${timestamp}] ${prefix} ${message}`);
      
      // Auto-scroll vers le bas
      this.$nextTick(() => {
        const logsContainer = document.querySelector('.backup-logs-container');
        if (logsContainer) {
          logsContainer.scrollTop = logsContainer.scrollHeight;
        }
      });
    },
    
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },
    
    closeBackupModal() {
      this.showBackupModal = false;
      this.backupProgress = {
        dbName: '',
        logs: [],
        status: 'running',
        error: null
      };
    },
    
    async backupNow(name) {
      // Rediriger vers la nouvelle modal
      this.openBackupModal(name);
    },
    
    buildCronFromVisual() {
      return `${this.cronVisual.minute} ${this.cronVisual.hour} ${this.cronVisual.dayOfMonth} ${this.cronVisual.month} ${this.cronVisual.dayOfWeek}`;
    },
    
    parseCronToVisual(cronStr) {
      if (!cronStr || cronStr.trim() === '') {
        this.cronMode = 'none';
        return;
      }
      
      // Vérifier si c'est un preset
      const preset = this.cronPresets.find(p => p.value === cronStr);
      if (preset) {
        this.cronMode = 'preset';
        this.cronPreset = cronStr;
        return;
      }
      
      // Sinon, essayer de parser pour le mode visuel
      const parts = cronStr.split(' ');
      if (parts.length === 5) {
        this.cronMode = 'visual';
        this.cronVisual = {
          minute: parts[0],
          hour: parts[1],
          dayOfMonth: parts[2],
          month: parts[3],
          dayOfWeek: parts[4]
        };
      } else {
        this.cronMode = 'manual';
      }
    },
    
    applyCronSelection() {
      if (this.cronMode === 'none') {
        return '';
      } else if (this.cronMode === 'preset') {
        return this.cronPreset;
      } else if (this.cronMode === 'visual') {
        return this.buildCronFromVisual();
      } else {
        return this.newDb.cron || this.editingDb?.cron || '';
      }
    },
    
    closeAddModal() {
      this.showAddModal = false;
      this.useUrl = false;
      this.connectionUrl = '';
      this.cronMode = 'none';
      this.cronPreset = '';
      this.cronVisual = {
        minute: '0',
        hour: '2',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*'
      };
      this.newDb = {
        name: '',
        displayName: '',
        host: 'localhost',
        port: 5432,
        user: 'postgres',
        password: '',
        cron: '',
        output: 'backups/database.backup',
        enabled: true
      };
    },
    
    formatDate(dateStr) {
      const date = new Date(dateStr);
      return date.toLocaleString('fr-FR');
    },
    
    getStatusClass(status) {
      const classes = {
        success: 'bg-green-100 text-green-800',
        error: 'bg-red-100 text-red-800',
        running: 'bg-blue-100 text-blue-800',
        idle: 'bg-gray-100 text-gray-800'
      };
      return classes[status] || classes.idle;
    },
    
    getStatusLabel(status) {
      const labels = {
        success: 'Succès',
        error: 'Erreur',
        running: 'En cours',
        idle: 'Inactif'
      };
      return labels[status] || 'Inconnu';
    },
    
    getLogClass(level) {
      const classes = {
        error: 'bg-red-50',
        warn: 'bg-gray-50',
        info: 'bg-gray-50'
      };
      return classes[level] || classes.info;
    },
    
    getLevelClass(level) {
      const classes = {
        error: 'text-gray-900',
        warn: 'text-gray-600',
        info: 'text-black'
      };
      return classes[level] || classes.info;
    },
    
    getDbByName(name) {
      return this.config.databases.find(db => db.name === name);
    },
    
    getDbDisplayNameByName(name) {
      const db = this.getDbByName(name);
      if (db) {
        return this.getDbDisplayName(db);
      }
      return name;
    },
    
    describeCron(cron) {
      const patterns = {
        '0 2 * * *': this.t('cron.everyDay2am'),
        '0 0 * * *': this.t('cron.everyDayMidnight'),
        '0 */6 * * *': this.t('cron.every6hours'),
        '0 */12 * * *': this.t('cron.every12hours'),
        '0 0 * * 0': this.t('cron.everySunday'),
        '0 0 * * 1': this.t('cron.everyMonday'),
        '0 0 1 * *': this.t('cron.firstOfMonth'),
        '0 3 * * 1-5': this.t('cron.weekdays3am')
      };
      return patterns[cron] || this.t('cron.custom');
    },

    changeLanguage(lang) {
      this.currentLanguage = lang;
      localStorage.setItem('bbdump_language', lang);
    },
    
    showToast(message, type = 'info', duration = 5000) {
      const id = Date.now();
      const toast = {
        id,
        message,
        type, // 'info', 'success', 'error', 'warning'
        show: true
      };
      
      this.toasts.push(toast);
      
      // Auto-remove après la durée spécifiée
      setTimeout(() => {
        this.removeToast(id);
      }, duration);
    },
    
    removeToast(id) {
      const index = this.toasts.findIndex(t => t.id === id);
      if (index > -1) {
        this.toasts.splice(index, 1);
      }
    },
    
    async checkForUpdates() {
      this.checkingUpdate = true;
      this.updateAvailable = false;
      this.latestVersion = null;
      
      try {
        // GitHub Releases API endpoint
        // Replace YOUR_USERNAME with your actual GitHub username
        const githubRepoUrl = 'https://api.github.com/repos/YOUR_USERNAME/bbdump/releases/latest';
        
        const response = await fetch(githubRepoUrl);
        
        if (!response.ok) {
          throw new Error('Impossible de vérifier les mises à jour');
        }
        
        const data = await response.json();
        this.latestVersion = data.tag_name.replace('v', ''); // Enlever le 'v' si présent
        
        // Comparer les versions
        const current = this.appVersion.split('.').map(Number);
        const latest = this.latestVersion.split('.').map(Number);
        
        for (let i = 0; i < 3; i++) {
          if (latest[i] > current[i]) {
            this.updateAvailable = true;
            this.showToast(`Nouvelle version disponible : ${this.latestVersion}`, 'info', 8000);
            break;
          } else if (latest[i] < current[i]) {
            break;
          }
        }
        
        if (!this.updateAvailable) {
          this.showToast(this.t('about.upToDate'), 'success');
        }
      } catch (error) {
        console.error('Erreur lors de la vérification des mises à jour:', error);
        this.showToast(this.t('toasts.updateError'), 'error', 10000);
      } finally {
        this.checkingUpdate = false;
      }
    }
  },
  
  template: `
    <div class="min-h-screen bg-white transition-colors">
      <!-- Header -->
      <header class="border-b border-gray-200">
        <div class="max-w-7xl mx-auto px-8 py-6">
          <div class="flex justify-between items-center">
            <div class="flex items-center space-x-4">
              <img src="logo.png" alt="bbdump logo" class="w-12 h-12">
              <div>
                <h1 class="text-2xl font-light tracking-wide text-black">
                  BBDUMP
                </h1>
                <p class="text-xs text-gray-500 uppercase tracking-wider">Backup Manager</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <!-- Main Content -->
      <main class="max-w-7xl mx-auto px-8 py-8">
        <!-- Tabs -->
        <div class="mb-8 border-b border-gray-200">
          <nav class="-mb-px flex space-x-12">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              @click="activeTab = tab.id"
              :class="[
                activeTab === tab.id
                  ? 'border-black text-black'
                  : 'border-transparent text-gray-400 hover:text-gray-600',
                'whitespace-nowrap py-4 border-b-2 font-medium text-sm tracking-wide uppercase transition-colors'
              ]"
            >
              {{ tab.label }}
            </button>
          </nav>
        </div>

        <!-- Databases Tab -->
        <div v-if="activeTab === 'databases'" class="space-y-8">
          <div class="flex justify-between items-center">
            <h2 class="text-lg font-medium text-black tracking-wide">{{ t('databases.title') }}</h2>
            <button
              @click="showAddModal = true"
              class="px-6 py-2 text-sm font-medium bg-black text-white hover:bg-gray-800 transition-colors"
            >
              {{ t('databases.addButton') }}
            </button>
          </div>

          <div v-if="config.databases.length === 0" class="text-center py-20 border border-gray-200">
            <p class="text-gray-400 text-sm tracking-wide">{{ t('databases.noData') }}</p>
          </div>

          <div v-else class="border border-gray-200">
            <table class="min-w-full">
              <thead class="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('databases.tableDatabase') }}
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('databases.tableHost') }}
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('databases.tableSchedule') }}
                  </th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('databases.tableEncryption') }}
                  </th>
                  <th class="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('databases.tableBackup') }}
                  </th>
                  <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('databases.tableActions') }}
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr
                  v-for="db in config.databases"
                  :key="db.name"
                  class="hover:bg-gray-50"
                >
                  <!-- Database name -->
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div class="text-sm font-medium text-gray-900">{{ getDbDisplayName(db) }}</div>
                    <div v-if="db.displayName && db.displayName.trim() !== ''" class="text-xs text-gray-500 font-mono">{{ db.name }}</div>
                  </td>

                  <!-- Host/Connection -->
                  <td class="px-6 py-4">
                    <div class="flex items-center gap-2">
                      <div class="text-xs text-gray-600 font-mono">
                        {{ db.host }}:{{ db.port }}
                      </div>
                      <span
                        v-if="db.connectionString"
                        class="inline-flex items-center px-2 py-0.5 bg-blue-100 text-blue-800 text-[10px] font-mono"
                        title="Using PostgreSQL connection string"
                      >
                        URL
                      </span>
                    </div>
                  </td>

                  <!-- Schedule -->
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div v-if="db.cron" class="text-xs text-gray-600 font-mono">{{ db.cron }}</div>
                    <div v-else class="text-xs text-gray-400">—</div>
                  </td>

                  <!-- Encryption -->
                  <td class="px-6 py-4 whitespace-nowrap text-center">
                    <div class="flex items-center justify-center gap-1 flex-wrap">
                      <!-- Warning si mot de passe NON chiffré (rare et dangereux) -->
                      <span
                        v-if="db.encrypted === false"
                        class="inline-flex items-center px-2 py-0.5 bg-red-600 text-white text-[10px] font-mono"
                        title="⚠️ Password stored in plain text (not recommended)"
                      >
                        🔓 PWD
                      </span>
                      <!-- Badge si backups chiffrés -->
                      <span
                        v-if="db.encryptBackups"
                        class="inline-flex items-center px-2 py-0.5 bg-black text-white text-[10px] font-mono"
                        :title="t('databases.encryptedBackup')"
                      >
                        🔒 BAK
                      </span>
                      <!-- Si rien de spécial -->
                      <span v-if="!db.encryptBackups && db.encrypted !== false" class="text-gray-400 text-xs">—</span>
                    </div>
                  </td>

                  <!-- Status -->
                  <td class="px-6 py-4 whitespace-nowrap text-center">
                    <button
                      v-if="db.cron && db.cron.trim() !== ''"
                      @click="toggleSchedule(db.name)"
                      :class="[
                        'inline-flex items-center px-3 py-1 text-white text-xs font-medium',
                        db.enabled !== false ? 'bg-green-600 hover:bg-green-700' : 'bg-gray-500 hover:bg-gray-600'
                      ]"
                      :title="db.enabled !== false ? t('databases.pauseSchedule') : t('databases.enableSchedule')"
                    >
                      {{ db.enabled !== false ? t('databases.statusActive') : t('databases.statusPaused') }}
                    </button>
                    <span v-else class="text-gray-400 text-xs">{{ t('databases.statusManual') }}</span>
                  </td>

                  <!-- Actions -->
                  <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium relative">
                    <button
                      @click.stop="toggleDbMenu(db.name)"
                      class="p-2 hover:bg-gray-100 rounded transition-colors"
                      :title="t('databases.tableActions')"
                    >
                      <svg class="w-5 h-5 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
                      </svg>
                    </button>

                    <!-- Dropdown Menu -->
                    <div
                      v-if="openMenuDb === db.name"
                      @click.stop
                      class="absolute right-0 mt-2 w-48 bg-white border border-gray-200 shadow-lg z-50 rounded-sm overflow-hidden"
                    >
                      <button
                        @click="openDatabaseViewer(db); openMenuDb = null"
                        class="w-full text-left px-4 py-3 text-sm hover:bg-gray-50 flex items-center gap-3 transition-colors border-b border-gray-100"
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                        </svg>
                        <span>{{ t('databases.viewDatabase') }}</span>
                      </button>
                      <button
                        @click="backupNow(db.name); openMenuDb = null"
                        :disabled="isBackingUp[db.name]"
                        class="w-full text-left px-4 py-3 text-sm hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center gap-3 transition-colors border-b border-gray-100"
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span>{{ isBackingUp[db.name] ? t('databases.running') : t('databases.backup') }}</span>
                      </button>
                      <button
                        @click="openEditModal(db); openMenuDb = null"
                        class="w-full text-left px-4 py-3 text-sm hover:bg-gray-50 flex items-center gap-3 transition-colors border-b border-gray-100"
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                        </svg>
                        <span>{{ t('databases.edit') }}</span>
                      </button>
                      <button
                        @click="removeDatabase(db.name); openMenuDb = null"
                        class="w-full text-left px-4 py-3 text-sm text-red-600 hover:bg-red-50 flex items-center gap-3 transition-colors"
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                        </svg>
                        <span>{{ t('databases.delete') }}</span>
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Backups Tab -->
        <div v-if="activeTab === 'backups'" class="space-y-4">
          <!-- Header avec stats et actions -->
          <div class="flex justify-between items-center">
            <div>
              <h2 class="text-xl font-semibold text-gray-900">{{ t('backups.title') }}</h2>
              <p class="text-sm text-gray-500 mt-1">
                {{ t('backups.stats', { count: filteredBackupStats.total, size: formatFileSize(filteredBackupStats.totalSize) }) }}
                <span v-if="backupFilter !== 'all'" class="text-gray-400">
                  {{ t('backups.statsTotal', { total: backupStats.total }) }}
                </span>
              </p>
            </div>
            <div class="flex gap-2">
              <button
                v-if="selectedBackups.length > 0"
                @click="deleteSelectedBackups"
                class="px-4 py-2 bg-red-600 text-white hover:bg-red-700 transition-colors"
              >
                {{ t('backups.deleteSelected', { count: selectedBackups.length }) }}
              </button>
              <button
                @click="loadBackups"
                class="px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors"
              >
                {{ t('backups.refresh') }}
              </button>
            </div>
          </div>

          <!-- Filtre par base de données -->
          <div v-if="backups.length > 0" class="flex items-center gap-3 bg-gray-50 p-3 border border-gray-200">
            <label class="text-sm font-medium text-gray-700">Filtrer par base :</label>
            <select
              v-model="backupFilter"
              class="px-3 py-1 border border-gray-300 focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="all">Toutes les bases de données</option>
              <option v-for="dbName in availableDatabases" :key="dbName" :value="dbName">
                {{ dbName }}
              </option>
            </select>
            <button
              v-if="backupFilter !== 'all'"
              @click="clearBackupFilter"
              class="text-xs text-gray-600 hover:text-gray-900 underline"
            >
              Réinitialiser
            </button>
            <div class="flex-1"></div>
            <span v-if="selectedBackups.length > 0" class="text-sm text-gray-600">
              {{ selectedBackups.length }} sélectionné(s)
            </span>
          </div>

          <div v-if="backups.length === 0" class="text-center py-20 border border-gray-200">
            <p class="text-gray-400 text-sm tracking-wide">NO BACKUPS FOUND</p>
          </div>

          <div v-else-if="filteredBackups.length === 0" class="text-center py-20 border border-gray-200">
            <p class="text-gray-400 text-sm tracking-wide">AUCUN BACKUP POUR CETTE BASE</p>
            <button
              @click="clearBackupFilter"
              class="mt-3 text-sm text-gray-600 hover:text-gray-900 underline"
            >
              Afficher tous les backups
            </button>
          </div>

          <div v-else class="border border-gray-200">
            <table class="min-w-full">
              <thead class="border-b border-gray-200">
                <tr>
                  <th class="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                    <input
                      type="checkbox"
                      :checked="allSelected"
                      :indeterminate.prop="someSelected"
                      @change="toggleSelectAll"
                      class="w-4 h-4 cursor-pointer"
                      title="Tout sélectionner / Tout désélectionner"
                    />
                  </th>
                  <th class="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    File
                  </th>
                  <th class="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Size
                  </th>
                  <th class="px-6 py-4 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-32">
                    Chiffrement
                  </th>
                  <th class="px-6 py-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date
                  </th>
                  <th class="px-6 py-4 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr
                  v-for="backup in filteredBackups"
                  :key="backup.name"
                  :class="[
                    'hover:bg-gray-50',
                    selectedBackups.includes(backup.name) ? 'bg-blue-50' : ''
                  ]"
                >
                  <td class="px-6 py-4 whitespace-nowrap">
                    <input
                      type="checkbox"
                      :checked="selectedBackups.includes(backup.name)"
                      @change="toggleBackupSelection(backup.name)"
                      class="w-4 h-4 cursor-pointer"
                    />
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div class="flex items-center gap-2">
                      <div>
                        <div class="text-sm font-medium text-gray-900">
                          {{ backup.name }}
                        </div>
                        <div class="text-xs text-gray-500">
                          {{ backup.path }}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {{ formatFileSize(backup.size) }}
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap text-center">
                    <span 
                      v-if="backup.encrypted"
                      class="inline-flex items-center justify-center px-3 py-1 bg-black text-white text-xs font-mono"
                      title="Fichier de backup chiffré avec AES-256-GCM"
                    >
                      🔒 CHIFFRÉ
                    </span>
                    <span 
                      v-else
                      class="inline-flex items-center justify-center text-gray-400 text-xs"
                      title="Fichier de backup non chiffré"
                    >
                      —
                    </span>
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {{ formatDate(backup.created) }}
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      @click="openRestoreModal(backup.name)"
                      class="text-black hover:text-blue-900"
                      title="Importer dans une DB"
                    >
                      Import
                    </button>
                    <button
                      @click="deleteBackup(backup.name)"
                      class="text-gray-900 hover:text-red-900 ml-4"
                      title="Supprimer"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Logs Tab -->
        <div v-if="activeTab === 'logs'" class="space-y-4">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-semibold text-gray-900">Logs de l'application</h2>
            <div class="flex gap-2">
              <button
                @click="loadLogs"
                class="px-4 py-2 bg-black text-white  hover:bg-gray-800 transition-colors"
              >
                {{ t('logs.refresh') }}
              </button>
              <button
                @click="clearLogs"
                class="px-4 py-2 bg-gray-900 text-white  hover:bg-black transition-colors"
              >
                {{ t('logs.clear') }}
              </button>
            </div>
          </div>

          <div class="bg-white   p-6">
            <div v-if="logs.length === 0" class="text-center py-8 text-gray-500">
              Aucun log disponible
            </div>
            <div v-else class="space-y-2 max-h-96 overflow-y-auto font-mono text-sm">
              <div
                v-for="(log, index) in logs"
                :key="index"
                :class="getLogClass(log.level)"
                class="p-2 "
              >
                <span class="text-gray-500">[{{ formatDate(log.timestamp) }}]</span>
                <span :class="getLevelClass(log.level)" class="font-semibold">[{{ log.level.toUpperCase() }}]</span>
                <span v-if="log.database" class="text-black">[{{ log.database }}]</span>
                <span>{{ log.message }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Scheduled Tasks Tab -->
        <div v-if="activeTab === 'scheduled'" class="space-y-4">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-semibold text-gray-900">{{ t('scheduled.title') }}</h2>
            <button
              @click="loadScheduledTasks"
              class="px-4 py-2 bg-black text-white  hover:bg-gray-800 transition-colors"
            >
              {{ t('scheduled.refresh') }}
            </button>
          </div>

          <div class="bg-white border border-gray-200 overflow-hidden">
            <table class="min-w-full divide-y divide-gray-200">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('scheduled.database') }}
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('scheduled.status') }}
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('scheduled.schedule') }}
                  </th>
                  <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {{ t('scheduled.lastBackup') }}
                  </th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-gray-200">
                <tr v-if="scheduledTasks.length === 0">
                  <td colspan="4" class="px-6 py-4 text-center text-gray-500">
                   {{ t('scheduled.noData') }}
                  </td>
                </tr>
                <tr v-for="task in scheduledTasks" :key="task.database">
                  <td class="px-6 py-4 whitespace-nowrap">
                    <div>
                      <div class="text-sm font-medium text-gray-900">
                        {{ getDbDisplayNameByName(task.database) }}
                      </div>
                      <div v-if="getDbByName(task.database)?.displayName" class="text-xs text-gray-400 font-mono mt-1">
                        {{ task.database }}
                      </div>
                    </div>
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap">
                    <span 
                      :class="[
                        'inline-flex items-center px-2.5 py-0.5 text-xs font-medium',
                        getDbByName(task.database)?.enabled !== false ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                      ]"
                    >
                      {{ getDbByName(task.database)?.enabled !== false ? t('scheduled.active') : t('scheduled.paused') }}
                    </span>
                  </td>
                  <td class="px-6 py-4">
                    <div class="text-sm font-mono text-gray-900">{{ task.schedule }}</div>
                    <div class="text-xs text-gray-500 mt-1">→ {{ t('scheduled.cron', { cron: describeCron(task.schedule) }) }}</div>
                  </td>
                  <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    <div v-if="getDbByName(task.database)?.lastBackup">
                      {{ formatDate(getDbByName(task.database).lastBackup) }}
                    </div>
                    <div v-else class="text-gray-400">
                      {{ t('scheduled.never') }}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Settings Tab -->
        <div v-if="activeTab === 'settings'" class="space-y-6">
          <h2 class="text-xl font-semibold text-gray-900">{{ t('settings.title') }}</h2>

          <!-- Language Selector -->
          <div class="bg-white border border-gray-200 p-6">
            <h3 class="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              🌍 {{ t('settings.language') }}
            </h3>
            <p class="text-sm text-gray-600 mb-4">
              {{ t('settings.languageDescription') }}
            </p>
            <div class="flex gap-3">
              <button
                @click="changeLanguage('en')"
                :class="[
                  'flex-1 px-6 py-3 font-medium transition-colors',
                  currentLanguage === 'en'
                    ? 'bg-black text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                ]"
              >
                🇬🇧 English
              </button>
              <button
                @click="changeLanguage('fr')"
                :class="[
                  'flex-1 px-6 py-3 font-medium transition-colors',
                  currentLanguage === 'fr'
                    ? 'bg-black text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                ]"
              >
                🇫🇷 Français
              </button>
            </div>
          </div>

          <!-- Encryption Key Section -->
          <div class="bg-white p-6 border border-gray-200">
            <h3 class="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              {{ t('settings.encryptionTitle') }}
            </h3>

            <div class="space-y-4">
              <!-- Key Status -->
              <div class="bg-blue-50 border border-blue-200 p-4">
                <div class="flex items-start">
                  <div class="flex-shrink-0">
                    <span class="text-2xl">{{ encryptionKeyExists ? '🔒' : '⚠️' }}</span>
                  </div>
                  <div class="ml-3 flex-1">
                    <h4 class="text-sm font-medium text-blue-900">
                      {{ encryptionKeyExists ? t('settings.keyPresent') : t('settings.keyAbsent') }}
                    </h4>
                    <div class="mt-2 text-sm text-blue-700">
                      <p v-if="encryptionKeyExists">
                        {{ t('settings.keyPresentDesc') }}
                      </p>
                      <p v-else class="text-gray-700">
                        {{ t('settings.keyAbsentDesc') }}
                      </p>
                    </div>
                    <div v-if="encryptionKeyExists" class="mt-2 flex items-center space-x-2">
                      <code class="text-xs bg-white px-2 py-1  border border-blue-300 flex-1">
                        {{ encryptionKeyPath }}
                      </code>
                      <button
                        @click="copyEncryptionKeyPath"
                        class="text-black hover:text-blue-800 text-xs"
                        title="Copier le chemin"
                      >
                        
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Actions -->
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <!-- Export -->
                <div class="border border-gray-200 p-4">
                  <h4 class="font-medium text-gray-900 mb-2 flex items-center">
                    {{ t('settings.exportKeyTitle') }}
                  </h4>
                  <p class="text-sm text-gray-600 mb-3">
                    {{ t('settings.exportKeyDesc') }}
                  </p>
                  <button
                    @click="exportEncryptionKey"
                    :disabled="!encryptionKeyExists"
                    class="w-full px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                  >
                    {{ t('settings.exportKeyButton') }}
                  </button>
                </div>

                <!-- Import -->
                <div class="border border-gray-200 p-4">
                  <h4 class="font-medium text-gray-900 mb-2 flex items-center">
                    {{ t('settings.importKeyTitle') }}
                  </h4>
                  <p class="text-sm text-gray-600 mb-3">
                    {{ t('settings.importKeyDesc') }}
                  </p>
                  <button
                    @click="importEncryptionKey"
                    class="w-full px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors"
                  >
                    {{ t('settings.importKeyButton') }}
                  </button>
                </div>
              </div>

              <!-- Warning -->
              <div class="bg-gray-50 border border-gray-200 p-4">
                <div class="flex">
                  <div class="flex-shrink-0">
                    <span class="text-2xl">⚠️</span>
                  </div>
                  <div class="ml-3">
                    <h4 class="text-sm font-medium text-gray-900">
                      {{ t('settings.warningTitle') }}
                    </h4>
                    <div class="mt-2 text-sm text-gray-700">
                      <ul class="list-disc list-inside space-y-1">
                        <li v-for="(item, index) in t('settings.warningItems')" :key="index">{{ item }}</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Info -->
              <div class="bg-gray-50 border border-gray-200 p-4">
                <h4 class="text-sm font-medium text-gray-900 mb-2">
                  {{ t('settings.useCaseTitle') }}
                </h4>
                <div class="text-sm text-gray-600 space-y-2">
                  <p><strong>{{ t('settings.exportUseCase') }}</strong></p>
                  <ul class="list-disc list-inside ml-4 space-y-1">
                    <li v-for="(item, index) in t('settings.exportItems')" :key="index">{{ item }}</li>
                  </ul>
                  <p class="mt-3"><strong>{{ t('settings.importUseCase') }}</strong></p>
                  <ul class="list-disc list-inside ml-4 space-y-1">
                    <li v-for="(item, index) in t('settings.importItems')" :key="index">{{ item }}</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- About Tab -->
        <div v-if="activeTab === 'about'" class="space-y-6">
          <div class="flex items-center space-x-4 mb-8">
            <img src="logo.png" alt="bbdump logo" class="w-20 h-20">
            <!-- Version Info -->
            <div class="bg-white border border-gray-200 p-6">
              <h3 class="text-lg font-semibold text-gray-900 mb-4">{{ t('about.title') }}</h3>
              <div class="space-y-3 text-sm">
                <div class="flex items-center justify-between py-2 border-b border-gray-100">
                  <span class="text-gray-600">{{ t('about.version') }}</span>
                  <span class="font-mono font-medium text-black">{{ appVersion }}</span>
                </div>
                <div class="flex items-center justify-between py-2 border-b border-gray-100">
                  <span class="text-gray-600">{{ t('about.author') }}</span>
                  <span class="font-medium text-black">{{ appAuthor }}</span>
                </div>
              </div>

          

          <!-- Check for Updates -->
          <div class="bg-white p-6">
            <h3 class="text-lg font-semibold text-gray-900 mb-4">{{ t('about.updates') }}</h3>
            
            <div v-if="updateAvailable" class="mb-4 p-4 bg-green-50 border border-green-200">
              <p class="text-sm text-green-800 font-medium">
                🎉 {{ t('about.updateAvailable', { version: latestVersion }) }}
              </p>
              <p class="text-xs text-green-700 mt-1">
                {{ t('about.updateCurrent', { version: appVersion }) }}
              </p>
            </div>
            
            <div v-if="!updateAvailable && latestVersion" class="mb-4 p-4 bg-blue-50 border border-blue-200">
              <p class="text-sm text-blue-800 font-medium">
                {{ t('about.upToDate') }}
              </p>
            </div>
            
            <button
              @click="checkForUpdates"
              :disabled="checkingUpdate"
              class="w-full px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              {{ checkingUpdate ? t('about.checking') : t('about.checkButton') }}
            </button>

            <p class="text-xs text-gray-500 mt-3">
              La vérification se fait sur GitHub Releases. Assurez-vous d'avoir une connexion internet.
            </p>
          </div>
            </div>

          </div>
        </div>
      </main>

      <!-- Add Database Modal -->
      <div v-if="showAddModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div class="bg-white  border border-gray-200 p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
          <h3 class="text-xl font-semibold text-gray-900 mb-4">Ajouter une base de données</h3>
          
          <!-- Warning -->
          <div class="mb-4 p-3 bg-yellow-50 border border-yellow-200">
            <p class="text-xs text-yellow-800">
              <strong>Important :</strong> La base de données doit DÉJÀ EXISTER sur votre serveur PostgreSQL. Cette application configure seulement des backups, elle ne crée pas de bases de données.
            </p>
          </div>
          
          <!-- Toggle entre URL et formulaire manuel -->
          <div class="mb-4 flex gap-2">
            <button
              type="button"
              @click="useUrl = false"
              :class="[
                !useUrl ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                'flex-1 px-3 py-2  transition-colors text-sm'
              ]"
            >
              Manual Config
            </button>
            <button
              type="button"
              @click="useUrl = true"
              :class="[
                useUrl ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                'flex-1 px-3 py-2  transition-colors text-sm'
              ]"
            >
              PostgreSQL URL
            </button>
          </div>

          <form @submit.prevent="addDatabase" class="space-y-4">
            <!-- Mode URL -->
            <div v-if="useUrl">
              <label class="block text-sm font-medium text-gray-700 mb-1">URL de connexion PostgreSQL</label>
              <input
                v-model="connectionUrl"
                type="text"
                required
                placeholder="postgresql://postgres:password@127.0.0.1:5432/database"
                class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <p class="text-xs text-gray-500 mt-1">
                Format: postgresql://utilisateur:motdepasse@host:port/nom_base
              </p>
            </div>

            <!-- Mode manuel -->
            <div v-if="!useUrl" class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Nom de la base</label>
                <input
                  v-model="newDb.name"
                  type="text"
                  required
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 mt-1">
                  Nom technique de la base sur PostgreSQL
                </p>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Nom d'affichage (optionnel)</label>
                <input
                  v-model="newDb.displayName"
                  type="text"
                  placeholder="Ex: Base de production, App mobile, etc."
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 mt-1">
                  Nom convivial pour mieux identifier cette base dans l'interface
                </p>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">Host</label>
                  <input
                    v-model="newDb.host"
                    type="text"
                    required
                    class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">Port</label>
                  <input
                    v-model.number="newDb.port"
                    type="number"
                    required
                    class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Utilisateur</label>
                <input
                  v-model="newDb.user"
                  type="text"
                  required
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Mot de passe</label>
                <input
                  v-model="newDb.password"
                  type="password"
                  required
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
              </div>
              
              <!-- Chiffrement credentials -->
              <div class="col-span-2">
                <label class="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    v-model="newDb.encrypted"
                    class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span class="text-sm text-gray-700">Chiffrer le mot de passe (recommandé)</span>
                </label>
              </div>
              
              <!-- Chiffrement backups -->
              <div class="col-span-2">
                <label class="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    v-model="newDb.encryptBackups"
                    class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span class="text-sm text-gray-700">Chiffrer les fichiers de backup</span>
                </label>
                <p class="text-xs text-gray-500 mt-1 ml-6">Les fichiers .backup seront chiffrés (AES-256-GCM)</p>
              </div>
            </div>

            <!-- Éditeur de Cron -->
            <div class="border border-gray-300  p-4">
              <label class="block text-sm font-medium text-gray-700 mb-3">
                 Planification automatique <span class="text-gray-400 text-xs">(optionnel)</span>
              </label>
              
              <!-- Sélection du mode -->
              <div class="grid grid-cols-2 gap-2 mb-3">
                <button
                  type="button"
                  @click="cronMode = 'none'"
                  :class="[
                    cronMode === 'none' ? 'bg-gray-600 text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                  None
                </button>
                <button
                  type="button"
                  @click="cronMode = 'preset'"
                  :class="[
                    cronMode === 'preset' ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                   Présélection
                </button>
                <button
                  type="button"
                  @click="cronMode = 'visual'"
                  :class="[
                    cronMode === 'visual' ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                  Visual
                </button>
                <button
                  type="button"
                  @click="cronMode = 'manual'"
                  :class="[
                    cronMode === 'manual' ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                  Manual
                </button>
              </div>

              <!-- Mode Présélection -->
              <div v-if="cronMode === 'preset'">
                <select
                  v-model="cronPreset"
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Choisir une fréquence...</option>
                  <option v-for="preset in cronPresets" :key="preset.value" :value="preset.value">
                    {{ preset.label }}
                  </option>
                </select>
                <p class="text-xs text-gray-500 mt-1">
                  Expression: {{ cronPreset || 'Aucune sélection' }}
                </p>
              </div>

              <!-- ModeVisual -->
              <div v-if="cronMode === 'visual'" class="space-y-3">
                <div class="grid grid-cols-5 gap-2">
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Minute</label>
                    <input
                      v-model="cronVisual.minute"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Heure</label>
                    <input
                      v-model="cronVisual.hour"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Jour</label>
                    <input
                      v-model="cronVisual.dayOfMonth"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Mois</label>
                    <input
                      v-model="cronVisual.month"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Jour sem.</label>
                    <input
                      v-model="cronVisual.dayOfWeek"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                </div>
                <p class="text-xs text-gray-500 mt-1">
                  Expression: {{ buildCronFromVisual() }}
                </p>
                <p class="text-xs text-gray-400">
                  * = tous, 0-59 pour minute, 0-23 pour heure, 1-31 pour jour, 1-12 pour mois, 0-7 pour jour semaine
                </p>
              </div>

              <!-- ModeManual -->
              <div v-if="cronMode === 'manual'">
                <input
                  v-model="newDb.cron"
                  type="text"
                  placeholder="Ex: 0 2 * * *"
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500 text-sm font-mono"
                />
                <p class="text-xs text-gray-500 mt-1">
                  Format: minute heure jour mois jour_semaine
                </p>
              </div>

              <!-- ModeNone -->
              <div v-if="cronMode === 'none'" class="text-center py-2 text-gray-500 text-sm">
                Sauvegardes manuelles uniquement
              </div>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Chemin de sortie</label>
              <input
                v-model="newDb.output"
                type="text"
                required
                placeholder="backups/ma_base.backup"
                class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div class="flex gap-2 pt-4">
              <button
                type="submit"
                class="flex-1 px-4 py-2 bg-black text-white  hover:bg-gray-800 transition-colors"
              >
                Ajouter
              </button>
              <button
                type="button"
                @click="closeAddModal"
                class="flex-1 px-4 py-2 bg-gray-300 text-gray-800  hover:bg-gray-400 transition-colors"
              >
                Annuler
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Edit Database Modal -->
      <div v-if="showEditModal && editingDb" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div class="bg-white  border border-gray-200 p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
          <h3 class="text-xl font-semibold text-gray-900 mb-4">Modifier la base de données</h3>
          
          <!-- Warning -->
          <div class="mb-4 p-3 bg-yellow-50 border border-yellow-200">
            <p class="text-xs text-yellow-800">
              <strong>Rappel :</strong> Assurez-vous que le nom de la base correspond à une base EXISTANTE sur votre serveur PostgreSQL.
            </p>
          </div>
          
          <!-- Toggle entre URL et formulaire manuel -->
          <div class="mb-4 flex gap-2">
            <button
              type="button"
              @click="useUrl = false"
              :class="[
                !useUrl ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                'flex-1 px-3 py-2  transition-colors text-sm'
              ]"
            >
              Manual Config
            </button>
            <button
              type="button"
              @click="useUrl = true"
              :class="[
                useUrl ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                'flex-1 px-3 py-2  transition-colors text-sm'
              ]"
            >
              PostgreSQL URL
            </button>
          </div>

          <form @submit.prevent="updateDatabase" class="space-y-4">
            <!-- Mode URL -->
            <div v-if="useUrl">
              <label class="block text-sm font-medium text-gray-700 mb-1">URL de connexion PostgreSQL</label>
              <input
                v-model="connectionUrl"
                type="text"
                required
                placeholder="postgresql://postgres:password@127.0.0.1:5432/database"
                class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500 font-mono text-sm"
              />
              <p class="text-xs text-gray-500 mt-1">
                Format: postgresql://utilisateur:motdepasse@host:port/nom_base
              </p>
            </div>

            <!-- Mode manuel -->
            <div v-if="!useUrl" class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Nom de la base</label>
                <input
                  v-model="editingDb.name"
                  type="text"
                  required
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 mt-1">
                  Nom technique de la base sur PostgreSQL
                </p>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Nom d'affichage (optionnel)</label>
                <input
                  v-model="editingDb.displayName"
                  type="text"
                  placeholder="Ex: Base de production, App mobile, etc."
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
                <p class="text-xs text-gray-500 mt-1">
                  Nom convivial pour mieux identifier cette base dans l'interface
                </p>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">Host</label>
                  <input
                    v-model="editingDb.host"
                    type="text"
                    required
                    class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">Port</label>
                  <input
                    v-model.number="editingDb.port"
                    type="number"
                    required
                    class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Utilisateur</label>
                <input
                  v-model="editingDb.user"
                  type="text"
                  required
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">Mot de passe</label>
                <input
                  v-model="editingDb.password"
                  type="password"
                  :placeholder="editingDb._originalPassword === '••••••••' ? 'Laisser vide pour ne pas changer' : ''"
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
                />
                <p v-if="editingDb._originalPassword === '••••••••'" class="text-xs text-gray-500 mt-1">
                  Laissez vide pour conserver le mot de passe actuel
                </p>
              </div>
              
              <!-- Chiffrement credentials -->
              <div class="col-span-2">
                <label class="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    v-model="editingDb.encrypted"
                    class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span class="text-sm text-gray-700">Chiffrer le mot de passe (recommandé)</span>
                </label>
              </div>
              
              <!-- Chiffrement backups -->
              <div class="col-span-2">
                <label class="flex items-center space-x-2 cursor-pointer">
                  <input
                    type="checkbox"
                    v-model="editingDb.encryptBackups"
                    class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span class="text-sm text-gray-700">Chiffrer les fichiers de backup</span>
                </label>
                <p class="text-xs text-gray-500 mt-1 ml-6">Les fichiers .backup seront chiffrés (AES-256-GCM)</p>
              </div>
            </div>

            <!-- Éditeur de Cron -->
            <div class="border border-gray-300  p-4">
              <label class="block text-sm font-medium text-gray-700 mb-3">
                 Planification automatique <span class="text-gray-400 text-xs">(optionnel)</span>
              </label>
              
              <!-- Sélection du mode -->
              <div class="grid grid-cols-2 gap-2 mb-3">
                <button
                  type="button"
                  @click="cronMode = 'none'"
                  :class="[
                    cronMode === 'none' ? 'bg-gray-600 text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                  None
                </button>
                <button
                  type="button"
                  @click="cronMode = 'preset'"
                  :class="[
                    cronMode === 'preset' ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                   Présélection
                </button>
                <button
                  type="button"
                  @click="cronMode = 'visual'"
                  :class="[
                    cronMode === 'visual' ? 'bg-black text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                  Visual
                </button>
                <button
                  type="button"
                  @click="cronMode = 'manual'"
                  :class="[
                    cronMode === 'manual' ? 'bg-gray-900 text-white' : 'bg-gray-200 text-gray-700',
                    'px-3 py-2  transition-colors text-xs'
                  ]"
                >
                  Manual
                </button>
              </div>

              <!-- Mode Présélection -->
              <div v-if="cronMode === 'preset'">
                <select
                  v-model="cronPreset"
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="">Choisir une fréquence...</option>
                  <option v-for="preset in cronPresets" :key="preset.value" :value="preset.value">
                    {{ preset.label }}
                  </option>
                </select>
                <p class="text-xs text-gray-500 mt-1">
                  Expression: {{ cronPreset || 'Aucune sélection' }}
                </p>
              </div>

              <!-- ModeVisual -->
              <div v-if="cronMode === 'visual'" class="space-y-3">
                <div class="grid grid-cols-5 gap-2">
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Minute</label>
                    <input
                      v-model="cronVisual.minute"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Heure</label>
                    <input
                      v-model="cronVisual.hour"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Jour</label>
                    <input
                      v-model="cronVisual.dayOfMonth"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Mois</label>
                    <input
                      v-model="cronVisual.month"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                  <div>
                    <label class="block text-xs text-gray-600 mb-1">Jour sem.</label>
                    <input
                      v-model="cronVisual.dayOfWeek"
                      type="text"
                      placeholder="*"
                      class="w-full px-2 py-1 border border-gray-300  text-sm"
                    />
                  </div>
                </div>
                <p class="text-xs text-gray-500 mt-1">
                  Expression: {{ buildCronFromVisual() }}
                </p>
                <p class="text-xs text-gray-400">
                  * = tous, 0-59 pour minute, 0-23 pour heure, 1-31 pour jour, 1-12 pour mois, 0-7 pour jour semaine
                </p>
              </div>

              <!-- ModeManual -->
              <div v-if="cronMode === 'manual'">
                <input
                  v-model="editingDb.cron"
                  type="text"
                  placeholder="Ex: 0 2 * * *"
                  class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500 text-sm font-mono"
                />
                <p class="text-xs text-gray-500 mt-1">
                  Format: minute heure jour mois jour_semaine
                </p>
              </div>

              <!-- ModeNone -->
              <div v-if="cronMode === 'none'" class="text-center py-2 text-gray-500 text-sm">
                Sauvegardes manuelles uniquement
              </div>
            </div>

            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">Chemin de sortie</label>
              <input
                v-model="editingDb.output"
                type="text"
                required
                placeholder="backups/ma_base.backup"
                class="w-full px-3 py-2 border border-gray-300  focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div class="flex gap-2 pt-4">
              <button
                type="submit"
                class="flex-1 px-4 py-2 bg-black text-white  hover:bg-gray-800 transition-colors"
              >
                Modifier
              </button>
              <button
                type="button"
                @click="closeEditModal"
                class="flex-1 px-4 py-2 bg-gray-300 text-gray-800  hover:bg-gray-400 transition-colors"
              >
                Annuler
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Restore Backup Modal -->
      <div v-if="showRestoreModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div class="bg-white border border-gray-200 p-6 w-full max-w-2xl max-h-[80vh] flex flex-col">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-xl font-semibold text-gray-900">
              {{ restoreProgress.status === 'input' ? 'Import une sauvegarde' : 'Restauration en cours' }}
            </h3>
            <button
              v-if="restoreProgress.status !== 'running'"
              @click="closeRestoreModal"
              class="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          <!-- Input Form (status: input) -->
          <div v-if="restoreProgress.status === 'input'">
            <div class="mb-4 p-3 bg-blue-50 border border-blue-200">
              <p class="text-sm text-blue-800">
                <strong>📁 Fichier à restaurer :</strong><br>
                <span class="font-mono text-xs">{{ restoreBackupFile }}</span>
              </p>
            </div>

            <div class="mb-4 p-3 bg-yellow-50 border border-yellow-200">
              <p class="text-xs text-yellow-800">
                <strong>⚠️  Attention :</strong> Cette opération va importer les données du backup dans la base cible. Les données existantes seront écrasées.
              </p>
            </div>
            
            <form @submit.prevent="startRestoreBackup" class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  URL de la base de données cible
                </label>
                <input
                  v-model="restoreUrl"
                  type="text"
                  required
                  placeholder="postgresql://user:password@host:port/database"
                  class="w-full px-3 py-2 border border-gray-300 focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                />
                <p class="text-xs text-gray-500 mt-1">
                  La base de données doit exister et être accessible
                </p>
              </div>

              <div class="flex gap-2 pt-4">
                <button
                  type="submit"
                  class="flex-1 px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors"
                >
                  🚀 Démarrer la restauration
                </button>
                <button
                  type="button"
                  @click="closeRestoreModal"
                  class="flex-1 px-4 py-2 bg-gray-300 text-gray-800 hover:bg-gray-400 transition-colors"
                >
                  Annuler
                </button>
              </div>
            </form>
          </div>

          <!-- Progress View (status: running, success, error) -->
          <div v-else class="flex-1 flex flex-col min-h-0">
            <!-- Status Indicator -->
            <div class="mb-4">
              <div v-if="restoreProgress.status === 'running'" class="flex items-center space-x-2">
                <div class="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
                <span class="text-sm text-gray-700">Restauration en cours...</span>
              </div>
              <div v-else-if="restoreProgress.status === 'success'" class="flex items-center space-x-2">
                <div class="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center">
                  <span class="text-white text-xs">✓</span>
                </div>
                <span class="text-sm text-green-700 font-medium">Restauration réussie !</span>
              </div>
              <div v-else-if="restoreProgress.status === 'error'" class="flex items-center space-x-2">
                <div class="w-5 h-5 bg-red-500 rounded-full flex items-center justify-center">
                  <span class="text-white text-xs">✗</span>
                </div>
                <span class="text-sm text-red-700 font-medium">Erreur lors de la restauration</span>
              </div>
            </div>

            <!-- Restore Info -->
            <div class="mb-3 text-xs text-gray-600 space-y-1">
              <div><strong>📁 Source :</strong> {{ restoreProgress.backupFile }}</div>
              <div><strong>🎯 Cible :</strong> {{ restoreProgress.targetUrl }}</div>
            </div>

            <!-- Error Message -->
            <div v-if="restoreProgress.error" class="mb-4 p-3 bg-red-50 border border-red-200">
              <p class="text-sm text-red-800 font-mono whitespace-pre-wrap">{{ restoreProgress.error }}</p>
            </div>

            <!-- Logs Console -->
            <div class="flex-1 bg-black text-green-400 p-4 font-mono text-xs overflow-y-auto min-h-[300px]" ref="restoreLogsContainer">
              <div v-for="(log, index) in restoreProgress.logs" :key="index" class="mb-1">
                <span class="text-gray-500">[{{ log.timestamp }}]</span>
                <span
                  :class="{
                    'text-green-400': log.type === 'success',
                    'text-red-400': log.type === 'error',
                    'text-yellow-400': log.type === 'warning',
                    'text-blue-400': log.type === 'info'
                  }"
                >
                  {{ log.message }}
                </span>
              </div>
            </div>

            <!-- Close Button -->
            <div class="mt-4 flex justify-end">
              <button
                v-if="restoreProgress.status !== 'running'"
                @click="closeRestoreModal"
                class="px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors"
              >
                Fermer
              </button>
              <button
                v-else
                disabled
                class="px-4 py-2 bg-gray-400 text-white cursor-not-allowed"
              >
                Restauration en cours...
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Backup Progress Modal -->
      <div v-if="showBackupModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div class="bg-white border border-gray-200 p-6 w-full max-w-2xl max-h-[80vh] flex flex-col">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-xl font-semibold text-gray-900">
              Backup en cours - {{ backupProgress.dbName }}
            </h3>
            <button
              v-if="backupProgress.status !== 'running'"
              @click="closeBackupModal"
              class="text-gray-500 hover:text-gray-700"
            >
              ✕
            </button>
          </div>

          <!-- Status Indicator -->
          <div class="mb-4">
            <div v-if="backupProgress.status === 'running'" class="flex items-center space-x-2">
              <div class="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
              <span class="text-sm text-gray-700">Sauvegarde en cours...</span>
            </div>
            <div v-else-if="backupProgress.status === 'success'" class="flex items-center space-x-2 text-green-700">
              <span class="text-2xl">✓</span>
              <span class="text-sm font-medium">Sauvegarde terminée avec succès</span>
            </div>
            <div v-else-if="backupProgress.status === 'error'" class="flex items-center space-x-2 text-red-700">
              <span class="text-2xl">✗</span>
              <span class="text-sm font-medium">Erreur lors de la sauvegarde</span>
            </div>
          </div>

          <!-- Error Message -->
          <div v-if="backupProgress.error" class="mb-4 p-3 bg-red-50 border border-red-200">
            <p class="text-sm text-red-800">
              <strong>Erreur:</strong> {{ backupProgress.error }}
            </p>
          </div>

          <!-- Logs Container -->
          <div class="backup-logs-container flex-1 bg-gray-900 text-green-400 p-4 overflow-y-auto font-mono text-xs mb-4 min-h-[300px] max-h-[400px]">
            <div v-if="backupProgress.logs.length === 0" class="text-gray-500">
              En attente de logs...
            </div>
            <div v-for="(log, index) in backupProgress.logs" :key="index" class="mb-1">
              {{ log }}
            </div>
          </div>

          <!-- Actions -->
          <div class="flex justify-end gap-2">
            <button
              v-if="backupProgress.status !== 'running'"
              @click="closeBackupModal"
              class="px-4 py-2 bg-black text-white hover:bg-gray-800 transition-colors"
            >
              Fermer
            </button>
            <button
              v-else
              disabled
              class="px-4 py-2 bg-gray-400 text-white cursor-not-allowed"
            >
              Backup en cours...
            </button>
          </div>
        </div>
      </div>

      <!-- Toast Notifications -->
      <div class="fixed top-4 right-4 z-50 space-y-3">
        <transition-group name="toast">
          <div
            v-for="toast in toasts"
            :key="toast.id"
            class="bg-white border border-black shadow-2xl min-w-[320px] max-w-md overflow-hidden"
          >
            <div class="flex items-stretch">
              <!-- Barre de couleur latérale -->
              <div
                :class="[
                  'w-1',
                  toast.type === 'success' ? 'bg-green-500' : '',
                  toast.type === 'error' ? 'bg-red-500' : '',
                  toast.type === 'warning' ? 'bg-yellow-500' : '',
                  toast.type === 'info' ? 'bg-blue-500' : ''
                ]"
              ></div>
              
              <!-- Contenu -->
              <div class="flex-1 px-4 py-3 flex items-start justify-between">
                <p class="text-sm font-medium text-black pr-3">{{ toast.message }}</p>
                <button
                  @click="removeToast(toast.id)"
                  class="text-gray-400 hover:text-black transition-colors flex-shrink-0 text-lg leading-none mt-0.5"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        </transition-group>
      </div>

      <!-- Database Viewer Modal (Fullscreen) -->
      <div v-if="showDbViewer" class="fixed inset-0 bg-white z-50 flex flex-col">
        <!-- Header -->
        <div class="bg-black text-white px-6 py-4 flex items-center justify-between">
          <div class="flex items-center gap-4">
            <h2 class="text-lg font-medium">{{ viewerDb ? getDbDisplayName(viewerDb) : '' }}</h2>
            <span v-if="viewerDb" class="text-sm text-gray-400 font-mono">
              {{ viewerDb.host }}:{{ viewerDb.port }} / {{ viewerDb.name }}
            </span>
          </div>
          <button
            @click="closeDatabaseViewer"
            class="text-white hover:text-gray-300 text-xl px-3 py-1"
          >
            ✕
          </button>
        </div>

        <!-- Main Content -->
        <div class="flex-1 flex overflow-hidden">
          <!-- Sidebar: List of Tables -->
          <div class="w-64 bg-gray-50 border-r border-gray-200 overflow-y-auto">
            <div class="p-4">
              <h3 class="text-sm font-medium text-gray-700 uppercase tracking-wide mb-3">Tables</h3>

              <div v-if="loadingTables" class="text-center py-8 text-gray-500 text-sm">
                Loading tables...
              </div>

              <div v-else-if="dbTables.length === 0" class="text-center py-8 text-gray-400 text-sm">
                No tables found
              </div>

              <div v-else class="space-y-1">
                <button
                  v-for="table in dbTables"
                  :key="table.name"
                  @click="selectTable(table.name)"
                  :class="[
                    'w-full text-left px-3 py-2 text-sm transition-colors flex items-center justify-between',
                    selectedTable === table.name
                      ? 'bg-black text-white'
                      : 'hover:bg-gray-200 text-gray-700'
                  ]"
                >
                  <span>{{ table.name }}</span>
                  <span v-if="table.row_count" class="text-xs opacity-60">{{ table.row_count }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Main Panel: Table Details -->
          <div class="flex-1 overflow-auto bg-white">
            <div v-if="!selectedTable" class="flex items-center justify-center h-full text-gray-400">
              <div class="text-center">
                <svg class="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/>
                </svg>
                <p class="text-sm">Select a table to view its structure and data</p>
              </div>
            </div>

            <div v-else-if="loadingTableData" class="flex items-center justify-center h-full">
              <div class="text-center text-gray-500">
                <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-black mx-auto mb-4"></div>
                <p>Loading table data...</p>
              </div>
            </div>

            <div v-else class="p-6 space-y-6">
              <!-- Table Name -->
              <div>
                <h3 class="text-2xl font-bold text-gray-900 mb-2">{{ selectedTable }}</h3>
                <p v-if="tableSchema" class="text-sm text-gray-500">{{ tableSchema.columns.length }} columns</p>
              </div>

              <!-- Schema Section -->
              <div v-if="tableSchema">
                <button
                  @click="viewerSections.schema = !viewerSections.schema"
                  class="w-full flex items-center justify-between py-2 hover:bg-gray-50 transition-colors"
                >
                  <h4 class="text-sm font-medium text-gray-700 uppercase tracking-wide">
                    Schema
                    <span class="text-gray-400 text-xs ml-2">({{ tableSchema.columns.length }} columns)</span>
                  </h4>
                  <svg
                    class="w-5 h-5 text-gray-500 transition-transform"
                    :class="{ 'rotate-180': viewerSections.schema }"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
                <div v-show="viewerSections.schema" class="border border-gray-200 rounded mt-3">
                  <table class="min-w-full">
                    <thead class="bg-gray-50">
                      <tr>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Column</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Nullable</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Default</th>
                        <th class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Key</th>
                      </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
                      <tr v-for="col in tableSchema.columns" :key="col.column_name">
                        <td class="px-4 py-2 text-sm font-mono text-gray-900">{{ col.column_name }}</td>
                        <td class="px-4 py-2 text-sm font-mono text-gray-600">{{ col.data_type }}</td>
                        <td class="px-4 py-2 text-sm text-gray-600">{{ col.is_nullable }}</td>
                        <td class="px-4 py-2 text-sm font-mono text-gray-600">{{ col.column_default || '—' }}</td>
                        <td class="px-4 py-2 text-sm">
                          <span v-if="col.is_primary" class="px-2 py-0.5 bg-yellow-100 text-yellow-800 text-xs font-mono">PK</span>
                          <span v-if="col.is_foreign" class="px-2 py-0.5 bg-blue-100 text-blue-800 text-xs font-mono">FK</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <!-- Relations Section -->
              <div v-if="tableRelations && tableRelations.length > 0">
                <button
                  @click="viewerSections.relations = !viewerSections.relations"
                  class="w-full flex items-center justify-between py-2 hover:bg-gray-50 transition-colors"
                >
                  <h4 class="text-sm font-medium text-gray-700 uppercase tracking-wide">
                    Relations
                    <span class="text-gray-400 text-xs ml-2">({{ tableRelations.length }})</span>
                  </h4>
                  <svg
                    class="w-5 h-5 text-gray-500 transition-transform"
                    :class="{ 'rotate-180': viewerSections.relations }"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
                <div v-show="viewerSections.relations" class="space-y-2 mt-3">
                  <div v-for="rel in tableRelations" :key="rel.constraint_name" class="border border-gray-200 rounded p-3 bg-gray-50">
                    <div class="flex items-center gap-2 text-sm">
                      <span class="font-mono text-gray-900">{{ rel.column_name }}</span>
                      <span class="text-gray-400">→</span>
                      <span class="font-mono text-blue-600">{{ rel.foreign_table_name }}.{{ rel.foreign_column_name }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Data Preview Section -->
              <div v-if="tableData && tableData.length > 0">
                <button
                  @click="viewerSections.data = !viewerSections.data"
                  class="w-full flex items-center justify-between py-2 hover:bg-gray-50 transition-colors"
                >
                  <h4 class="text-sm font-medium text-gray-700 uppercase tracking-wide">
                    Data Preview
                    <span class="text-gray-400 text-xs ml-2">
                      ({{ tableData.length }} / {{ tableDataTotal }} rows{{ tableDataSearch ? ' matching' : '' }})
                    </span>
                  </h4>
                  <svg
                    class="w-5 h-5 text-gray-500 transition-transform"
                    :class="{ 'rotate-180': viewerSections.data }"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                  </svg>
                </button>
                <div v-show="viewerSections.data" class="mt-3 space-y-3">
                  <!-- Toolbar: Search + Columns -->
                  <div class="flex gap-2">
                    <!-- Search Box -->
                    <div class="flex-1 flex items-center gap-2 bg-gray-50 border border-gray-200 rounded px-3 py-2">
                      <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                      </svg>
                      <input
                        v-model="tableDataSearch"
                        type="text"
                        placeholder="Search in data..."
                        class="flex-1 bg-transparent outline-none text-sm text-gray-700 placeholder-gray-400"
                      />
                      <button
                        v-if="tableDataSearch"
                        @click="tableDataSearch = ''"
                        class="text-gray-400 hover:text-gray-600 text-sm"
                      >
                        ✕
                      </button>
                    </div>

                    <!-- Columns Selector -->
                    <div class="relative">
                      <button
                        @click.stop="showColumnsMenu = !showColumnsMenu"
                        class="px-4 py-2 bg-gray-50 border border-gray-200 rounded hover:bg-gray-100 transition-colors flex items-center gap-2 text-sm font-medium text-gray-700"
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"/>
                        </svg>
                        Columns
                        <span class="text-xs text-gray-500">({{ visibleColumns.length }})</span>
                      </button>

                      <!-- Dropdown Menu -->
                      <div
                        v-if="showColumnsMenu && tableData.length > 0"
                        @click.stop
                        class="absolute right-0 mt-2 w-64 bg-white border border-gray-200 shadow-lg rounded z-50 max-h-96 overflow-y-auto"
                      >
                        <!-- Header -->
                        <div class="sticky top-0 bg-gray-50 border-b border-gray-200 px-3 py-2 flex items-center justify-between">
                          <span class="text-xs font-medium text-gray-700 uppercase">Select Columns</span>
                          <div class="flex gap-2">
                            <button
                              @click="selectAllColumns"
                              class="text-xs text-blue-600 hover:text-blue-800"
                            >
                              All
                            </button>
                            <button
                              @click="deselectAllColumns"
                              class="text-xs text-gray-600 hover:text-gray-800"
                            >
                              Clear
                            </button>
                          </div>
                        </div>

                        <!-- Column Checkboxes -->
                        <div class="py-1">
                          <label
                            v-for="column in Object.keys(tableData[0])"
                            :key="column"
                            class="flex items-center px-3 py-2 hover:bg-gray-50 cursor-pointer transition-colors"
                          >
                            <input
                              type="checkbox"
                              :checked="visibleColumns.includes(column)"
                              @change="toggleColumn(column)"
                              class="w-4 h-4 cursor-pointer"
                            />
                            <span class="ml-3 text-sm font-mono text-gray-700">{{ column }}</span>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>

                  <!-- Table -->
                  <div class="border border-gray-200 rounded overflow-x-auto">
                  <table class="min-w-full">
                    <thead class="bg-gray-50">
                      <tr>
                        <th v-for="key in visibleColumns" :key="key" class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                          {{ key }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="bg-white divide-y divide-gray-200">
                      <tr v-if="tableData.length === 0 && tableDataSearch">
                        <td :colspan="visibleColumns.length" class="px-4 py-8 text-center text-gray-400 text-sm">
                          No results found for "{{ tableDataSearch }}"
                        </td>
                      </tr>
                      <tr v-for="(row, idx) in tableData" :key="idx" class="hover:bg-gray-50">
                        <td v-for="key in visibleColumns" :key="key" class="px-4 py-2 text-sm font-mono text-gray-600 max-w-xs truncate">
                          {{ row[key] !== null && row[key] !== undefined ? row[key] : '—' }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  </div>

                  <!-- Load More Button -->
                  <div v-if="tableDataHasMore" class="flex justify-center py-4">
                    <button
                      @click="loadMoreData"
                      :disabled="loadingMoreData"
                      class="px-6 py-2 bg-black text-white hover:bg-gray-800 disabled:bg-gray-400 transition-colors text-sm font-medium"
                    >
                      {{ loadingMoreData ? 'Loading...' : 'Load More (100 rows)' }}
                    </button>
                  </div>

                  <!-- Info Footer -->
                  <div class="text-center text-xs text-gray-500 py-2">
                    Showing {{ tableData.length }} of {{ tableDataTotal }} total rows
                  </div>
                </div>
              </div>

              <div v-else-if="selectedTable && !loadingTableData">
                <p class="text-gray-400 text-center py-8">No data in this table</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}).mount('#app');
