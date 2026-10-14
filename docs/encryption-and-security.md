# Encryption & Security

## What is encrypted

Everything uses **AES-256-GCM** (authenticated encryption, a random IV each time) with one key kept on your computer.

| Data | Where | When |
|------|-------|------|
| Database passwords | `config.json` | Always |
| Neon API key | `cloud-credentials.json` | When you connect a Neon account |
| Undo data of AI changes (rows before and after) | `ai-journal/` | For each change that has an undo point |
| Backup files | Your backup folders | When **Encrypt backup files** is on for the database |

`<data dir>` below is `~/Library/Application Support/bbdump` on macOS and `~/.config/bbdump` on Linux (see [Configuration](configuration.md)).

## Encryption key

On first launch, bbdump generates a random 256-bit key and saves it, hex-encoded, to `<data dir>/.encryption.key`, readable by your user only (mode 600).

**Settings → Security → Encryption key**:

| Action | Description |
|--------|-------------|
| **Export Key** | Saves a copy of the key to a file you choose |
| **Import Key** | Replaces the key with one from a file (64 hex characters). The previous key is kept next to it as `.encryption.key.backup-<timestamp>`. |

Passwords saved with the old key can no longer be read once another key is imported: export the current one first if you may need it. The imported key applies at once (before 1.2.2, after a restart).

> **Keep an exported copy of your key somewhere safe** (password manager, encrypted drive). Without it, saved passwords and encrypted backups cannot be read on another computer, or after the key file is lost.

### Moving to another computer

1. Export the key on the old computer.
2. Install bbdump on the new one, import the key, and copy `config.json` into its data folder (bbdump closed).
3. Start bbdump: passwords and encrypted backups can be read there too.

## Passwords

- A password is encrypted as soon as the database is saved, and stored in `config.json` as `iv:authTag:ciphertext` (hex). It is decrypted in memory only, when bbdump connects.
- A password pasted inside a connection URL is taken out of the URL and stored in the encrypted field; the URL is saved without it.
- The interface never receives saved passwords: it shows `••••••••`.
- Configurations from bbdump 1.0.2, which could hold passwords in clear (in connection URLs), are migrated at launch, and the `.bak` copy is replaced too.
- `config.json` is written with mode 600.

## Encrypted backups

Turn on **Encrypt backup files** in a database's backup settings. After `pg_dump` (and the check of the dump, on by default), bbdump encrypts the whole file and deletes the unencrypted one. The file keeps its name; bbdump recognizes it by its header.

Restoring through bbdump decrypts it automatically into a temporary file, removed afterwards. An encrypted backup can only be restored with the same key: on another computer, import the key first.

## AI assistants (MCP)

- The MCP server runs queries in read-only transactions. Every write (INSERT, UPDATE, DELETE…) waits for your approval in bbdump, unless you turn on **Let assistants change data without asking** in Settings (off by default).
- Each change is recorded in the AI journal, with the rows before and after (encrypted), and can be undone in one click.
- The MCP server talks to the app through a local server listening on `127.0.0.1` only, on a random port. A new random token is created at each launch and written with the port to `<data dir>/.mcp-confirm-port` (mode 600); requests without it are rejected, so a web page cannot reach it.
- **Anonymize for AI**, per database: chosen columns reach the assistant anonymized, and a result whose origin is unknown is shown to you first. Your database is never changed. See [MCP Server](mcp-server.md).

## Network

- **No telemetry**: bbdump sends nothing about you or your databases.
- bbdump connects to your databases; to GitHub to check for updates and download them; to the Neon API if you connect a Neon account; and, when you ask it to install something, to Homebrew or your package manager.
- The project proxy and SSH tunnels listen on `127.0.0.1` only.
- SSH connections use your own `ssh` and `~/.ssh/config`: bbdump stores no SSH key or passphrase.
- Use SSL for remote databases: pick the SSL mode (up to `verify-full`, with a CA certificate) in the database's connection settings. bbdump turns SSL on for hosts that require it.

## Anonymized copies

When you duplicate a database with anonymization, the rows are streamed with the chosen columns already replaced: the real values never reach your machine, and no backup of the source is kept.

## The app itself

| Protection | Description |
|------------|-------------|
| **Context isolation and sandbox** | The interface has no access to Node.js |
| **IPC allowlist** | The interface can only call an explicit list of channels |
| **No remote content** | Windows only show the bundled interface; links open in your browser |

## Files and permissions

| File | Permissions | Contents |
|------|-------------|----------|
| `.encryption.key` | 600 | The key |
| `config.json` | 600 | Settings, encrypted passwords |
| `cloud-credentials.json` | 600 | Encrypted Neon API key |
| `.mcp-confirm-port` | 600 | Port and per-launch token |
| Backup files | Default | Encrypted if the option is on |

## Good practices

- Export your encryption key and store it safely.
- Do not share `config.json` together with the key: with both, the passwords can be decrypted.
- Encrypt the backups of databases holding personal or sensitive data.
- Keep the AI approval on, and use **Anonymize for AI** on databases with personal data.
- Use **Mask** on a project when sharing your screen: it hides its name and its databases' names.
