# bbdump demo

A ready-to-use PostgreSQL demo database to try bbdump instantly.

## What's inside

The database **bbdump-demo-french-towns** contains the full French administrative structure (INSEE data):

| Table       | Rows   | Description          |
|-------------|--------|----------------------|
| Regions     | 26     | Regions              |
| Departments | 100    | Departments          |
| Towns       | 36 684 | Towns (communes)     |

## Prerequisites

- PostgreSQL installed and running locally
- `createdb` / `psql` available (via Homebrew, system install, or PATH)

## Usage

```bash
./bbdump-demo/bbdump-demo.sh
```

The script will:

1. Create the `bbdump-demo-french-towns` database
2. Import all regions, departments, and towns
3. If bbdump is installed, register the database and create a **bbdump-demo** project
4. If bbdump is running, restart it automatically (macOS)

The script is idempotent — you can run it again safely.

## Cleanup

```bash
./bbdump-demo/bbdump-demo-cleanup.sh
```

Removes the database, the bbdump config entry, and restarts the app if running.
