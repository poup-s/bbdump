# Encryption & Security

## Overview

bbdump encrypts sensitive data at two levels:

1. **Password encryption** — Database passwords stored in the config file are encrypted
2. **Backup encryption** — Backup files can be optionally encrypted on disk

Both use **AES-256-GCM**, a symmetric authenticated encryption algorithm.

## Encryption Key

### Generation

On first launch, bbdump generates a random 256-bit encryption key and saves it to:

```
~/.bbdump/.encryption.key
```

The file is created with restricted permissions (`0600` — owner read/write only).

### Key Management

In **Settings**, you can:

| Action | Description |
|--------|-------------|
| **Export key** | Save the encryption key to a file for backup or transfer |
| **Import key** | Load an encryption key from a file (replaces the current key) |

> **Important:** If you lose your encryption key, encrypted passwords and backup files cannot be recovered. Export your key and store it securely.

### Multi-Machine Setup

To use the same databases on multiple machines:

1. Export the encryption key from the source machine
2. Import it on the target machine
3. Copy the `config.json` file

Passwords encrypted on one machine can then be decrypted on the other.

## Password Encryption

When you save a database connection with a password:

1. The password is encrypted using AES-256-GCM with the encryption key
2. The encrypted value is stored in `config.json` in the format: `iv:authTag:encryptedData` (hex-encoded)
3. When connecting, the password is decrypted in memory — the plaintext is never written to disk

Encryption is applied per-database and is enabled by default for all new connections.

## Backup File Encryption

When **Encrypt backup** is enabled on a database:

1. `pg_dump` creates the backup file normally
2. bbdump encrypts the entire file using AES-256-GCM
3. The original unencrypted file is deleted
4. The encrypted file is saved with the `.enc` extension appended

### Restoring Encrypted Backups

Encrypted backups are decrypted automatically when restoring through bbdump. The process is transparent — select the encrypted backup file and restore as usual.

> Encrypted backups can only be restored on a machine that has the same encryption key.

## Electron Security

bbdump follows Electron security best practices:

| Feature | Description |
|---------|-------------|
| **Context isolation** | The renderer process cannot access Node.js APIs directly |
| **Preload script** | Only explicitly exposed IPC methods are available to the renderer |
| **No remote module** | The deprecated `remote` module is not used |
| **IPC invoke** | All communication uses the request/response `invoke` pattern |

## File Permissions

| File | Permissions | Description |
|------|-------------|-------------|
| `~/.bbdump/.encryption.key` | `0600` | Read/write by owner only |
| `~/.bbdump/config.json` | Default | Contains encrypted passwords |
| Backup files | Default | Optionally encrypted with AES-256-GCM |

## Best Practices

- **Export your encryption key** and store it in a secure location (password manager, encrypted drive)
- **Do not share** your `config.json` file — it contains encrypted credentials that can be decrypted with the key
- **Enable backup encryption** for databases containing sensitive data
- **Use SSL** when connecting to remote databases
- Use the **Mask** feature on projects when screen sharing to hide credentials
