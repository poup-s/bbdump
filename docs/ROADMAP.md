# Roadmap — ideas to discuss

Not commitments: directions to discuss before planning. Items move to the changelog once
they are designed and scheduled.

## 1. bbdump self-hosted in Docker (Umbrel, CasaOS, Unraid, NAS)

**Idea:** run bbdump itself as a container on a home server or NAS, used from a browser,
backing up the PostgreSQL databases of the other services (other containers, VPS, managed
databases). Published as an app on Umbrel's app store and similar platforms.

**Why:**
- Backups run 24/7 on an always-on machine, instead of only while the desktop app is open.
- One place to back up every database of a self-hosted setup.
- Natural fit for the Umbrel / CasaOS / Unraid community.

**What it implies:**
- Always "remote databases only": no local PostgreSQL server features. The `usageMode:
  'remote'` introduced in 1.1.0 already hides them; the Docker edition would force it.
- A **headless server mode**: the core (backups, scheduling, viewer, SSL, MCP) is plain
  Node already; Electron-only parts (window, tray, dialogs, notifications, app paths)
  need server equivalents.
- An **HTTP/WebSocket API** exposing the same actions as today's IPC, and a transport
  layer in the Vue app so the same UI runs in Electron (IPC) or in a browser (HTTP).
- **Authentication** (mandatory once the UI is reachable on a network), and HTTPS behind
  the platform's reverse proxy.
- Packaging: Docker image (with pg_dump/pg_restore for several PostgreSQL versions),
  `docker-compose.yml`, `umbrel-app.yml`; data and backups in mounted volumes.
- The encryption key then lives on the server: document how to back it up.

**Open questions:** one image for all platforms (arm64 + x64)? Which PostgreSQL client
versions to ship? Notifications (email, webhook, ntfy/Gotify)? Multi-user or single user?

## 2. Docker as a local PostgreSQL engine (desktop app)

**Idea:** in the desktop app, a third usage mode (the "Docker — coming soon" card of the
onboarding) where bbdump creates and drives PostgreSQL containers instead of using a
PostgreSQL installed on the system.

**Why:**
- Several PostgreSQL versions side by side (e.g. 14 for an old project, 18 to test).
- No system install: no Homebrew, no sudo, no service, no role; identical on macOS,
  Linux and Windows, and the most realistic path to a Windows version.
- Isolation (deleting a database removes everything), environments matching production,
  disposable databases to test that a backup really restores.
- `pg_dump` can run inside the container, with the server's exact version.

**Trade-offs:** requires Docker Desktop installed and running (memory use), slightly
slower disk on macOS, one more tool to understand.

**Scope to decide:** create/start/stop/delete containers from bbdump, detect existing
PostgreSQL containers (e.g. from docker compose projects) to back them up, choice of
image version per database.

---

Also on the list: macOS code signing (blocked on an Apple Developer account), remote
backup destinations (S3-compatible), Windows support.
