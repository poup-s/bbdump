# Backup & Restore

## Backups

bbdump backs up with `pg_dump` in its custom format (`-F c`), compressed (level 6). A backup can be started:

- from a database card: **Backup**, after a confirmation;
- from the **Backups** page or the **Tasks** page: **Back up now**;
- on a schedule (see [Scheduled Tasks](scheduled-tasks.md));
- by an AI assistant through the MCP server (see [MCP Server](mcp-server.md)).

Progress and errors go to the **Logs** page. A database reached through SSH gets its tunnel for the whole dump.

### Backup settings

Per database, in the **Backup** section of its settings (or the last step when adding it):

| Setting | Description | Default |
|---------|-------------|---------|
| **Output directory** | Folder the backups are written to | The default backup folder |
| **Backups to keep** | Older backups of this database are deleted after each successful backup | All |
| **Encrypt backup files** | Encrypt each dump with AES-256-GCM | Off |
| **Verify each backup** | Read the whole dump back before trusting it | On |

The default backup folder for new databases is set in **Settings → Backups** (initially `backups/` in the data folder, see [Configuration](configuration.md)).

### What happens during a backup

1. **The right `pg_dump` is picked** for the server's version. `pg_dump` reads servers of its own major version and older ones, never newer ones: bbdump uses the same major version when it is installed, otherwise the closest newer one. If every installed `pg_dump` is older than the server, the backup stops with the command to install the right one (e.g. `brew install postgresql@17`). When the server's version cannot be read, the newest `pg_dump` is used.
2. **Free disk space is checked** against an estimate of the dump size.
3. **`pg_dump` runs** (30 minutes at most by default).
4. **The dump is verified**: `pg_restore` reads the whole archive, not only its table of contents. A truncated or corrupt dump is reported as a failed backup.
5. **The dump is encrypted**, if turned on, with the key from **Settings → Security** (see [Encryption & Security](encryption-and-security.md)).
6. **Retention** deletes the oldest backups of this database beyond the number to keep.
7. **The run is recorded** (success or failure, duration, size) for the **Tasks** page.

A failed run never leaves a partial file behind.

Files are named `<database id>_<timestamp>.backup`, for example:

```
c42a45e5-8817-48b2-869e-ca56171e980a_2026-03-30T14-00-00-000Z.backup
```

An encrypted backup keeps the same name. Retention only counts files named this way, in the folder of the new backup.

### Backups page

![Backups](../captures/backups.webp)

Backups are grouped by database, the most recently backed up first. Each group shows its total size, its retention ("Keeps the last 5") and a **Back up now** button. A group whose database was removed from bbdump stays listed as "(removed from bbdump)".

Each backup shows its date (the newest is marked **latest**), size and whether it is encrypted, with these actions:

- **Restore** (below)
- **Show in Finder** / **Show in folder**
- **Export a copy**: save it elsewhere
- **Delete**

Several backups can be selected to delete them at once, and the list can be filtered by database. It lists every folder backups are written to: each database's output folder, the default folder and the internal one.

## Restore

**Restore** on a backup opens a two-step dialog.

![Restore](../captures/restore.webp)

### 1. Target

- **Existing Database**: any saved database, local or remote. **Next** is enabled after a 5-second wait.
- **New Database**: a name and a port; a new local database is created, then the backup is restored into it. Not shown in remote-only mode (see [Projects and databases](projects-and-databases.md#usage-mode)).

### 2. Confirmation

Type the target's name to confirm. For an existing database, **Back up … before replacing it** is on by default: the target is backed up first, so you can go back from the **Backups** page. If that backup fails, nothing is restored. This backup counts like any other, retention included.

### A restore replaces the content

Restoring into an existing database replaces its content with the backup's:

1. The schemas the backup contains are emptied first (`DROP SCHEMA … CASCADE`), all in **one transaction**: either every one is emptied, or none is. Tables the backup does not have are deleted with them. Schemas the backup does not contain (Supabase's `auth`, `storage`…) are left alone.
2. The schema, the data and then the indexes, constraints and triggers are restored with `pg_restore` (without owners or privileges, so a backup restores under another user). CHECK constraints are set aside while the rows load, then put back.

If the schemas cannot be emptied (missing rights, a lock held more than 15 seconds), **nothing is changed** and the reason is shown. This is what happens on a hosted database whose schemas belong to another role than yours (common on managed platforms): the restore is refused rather than half done.

The dialog reports the result: restored, restored with errors (the errors are listed), or failed. Encrypted backups are decrypted to a temporary file for the restore, deleted afterwards.

### Restore into another database

The target does not have to be the database the backup came from: restore a production backup into a local copy, or into a new local database. To bring a local copy up to date without replacing it, use **Update from…** instead (see [Projects and databases](projects-and-databases.md#update-from)).
