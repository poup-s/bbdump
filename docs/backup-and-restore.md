# Backup & Restore

## Backup

bbdump uses `pg_dump` under the hood to create PostgreSQL backups.

### Running a Manual Backup

1. Go to the **DB** tab
2. Click **Backup** next to the target database
3. The backup starts immediately
4. Progress is streamed in real time to the **Logs** tab

The backup file is saved to your configured backup directory (default: `~/.bbdump/backups/`).

### Backup Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| **Custom** | `.backup` | PostgreSQL custom format — compressed, supports selective restore, parallel restore. Recommended. |
| **Plain** | `.sql` | Plain-text SQL dump — human-readable, can be executed with `psql` |

### Backup Options

These options are configured per-database when editing the connection:

| Option | Description | Default |
|--------|-------------|---------|
| **Compression** | Compression level from 0 (none) to 9 (maximum) | 6 |
| **Parallel jobs** | Number of parallel dump threads for large databases | 1 |
| **Timeout** | Maximum backup duration in seconds. 0 = no limit | 0 |
| **Encrypt backup** | Encrypt the backup file with AES-256-GCM after creation | false |

### Backup File Naming

Files are named with the pattern:

```
{database_id}_{timestamp}.backup
```

Example: `c42a45e5-8817-48b2-869e-ca56171e980a_2026-03-30T14-00-00-000Z.backup`

### Encrypted Backups

When backup encryption is enabled:

1. `pg_dump` creates the backup file normally
2. bbdump encrypts the file using AES-256-GCM with your encryption key
3. The original unencrypted file is deleted
4. The encrypted file uses the `.backup.enc` extension

Encrypted backups are decrypted automatically when restoring through bbdump.

## Restore

### Restoring a Backup

1. Go to the **Backups** tab
2. Find the backup you want to restore
3. Click **Restore**
4. Choose a target:
   - **Existing database** — Select a database already configured in bbdump
   - **New database** — Enter a name to create a new local database
5. A **5-second countdown** starts before the restore begins — this is a safety measure to prevent accidental restores
6. Confirm to proceed

### Restore Process

bbdump uses `pg_restore` (for custom format) or `psql` (for plain SQL) to restore backups:

1. If targeting an existing database, existing data is dropped and replaced
2. Schema and data are restored from the backup file
3. If the backup was encrypted, it is decrypted in memory before restore
4. Progress and any warnings are streamed to the **Logs** tab

### Managing Backups

The **Backups** tab lists all backup files with:

| Column | Description |
|--------|-------------|
| **Database** | Source database name and backup file path |
| **Date** | Backup creation date and time |
| **Size** | File size |
| **Actions** | Restore, Download, Delete |

**Filtering:** Use the dropdown to filter backups by database (all databases or a specific one).

**Download:** Save a copy of the backup file to a custom location.

**Delete:** Permanently remove the backup file from disk.

## Backup Storage

By default, backups are stored in `~/.bbdump/backups/`. You can change this location in **Settings > Backup Location**.

All backup files in the configured directory are scanned and displayed in the Backups tab, regardless of which database they belong to.
