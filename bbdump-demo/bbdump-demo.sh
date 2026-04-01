#!/usr/bin/env bash
# Crée et remplit la base PostgreSQL bbdump-demo-french-towns en une seule commande.
set -euo pipefail

DB_NAME="bbdump-demo-french-towns"
SQL_FILE="$(dirname "$0")/french-towns-communes-francaises.sql"

# Detect PostgreSQL binaries (Homebrew, system, or PATH)
PG_BIN=""
for dir in /opt/homebrew/opt/postgresql@*/bin /opt/homebrew/opt/libpq/bin /usr/local/opt/postgresql@*/bin /usr/local/bin /usr/bin; do
  if [[ -x "$dir/psql" ]]; then
    PG_BIN="$dir"
    break
  fi
done

if [[ -n "$PG_BIN" ]]; then
  export PATH="$PG_BIN:$PATH"
fi

if ! command -v psql &>/dev/null; then
  echo "PostgreSQL introuvable. Installez-le (ex: brew install postgresql)." >&2
  exit 1
fi

# Check if the database already exists
if psql -lqt | cut -d\| -f1 | grep -qw "$DB_NAME"; then
  echo "La base $DB_NAME existe déjà."
else
  createdb "$DB_NAME"
  echo "Base créée : $DB_NAME"
  echo "Import des données..."
  psql -q -d "$DB_NAME" -f "$SQL_FILE"
  echo "Base importée."
fi

# Register in bbdump config if the app is installed
BBDUMP_CONFIG=""
case "$(uname)" in
  Darwin) BBDUMP_CONFIG="$HOME/Library/Application Support/bbdump/config.json" ;;
  Linux)  BBDUMP_CONFIG="$HOME/.config/bbdump/config.json" ;;
  *)      BBDUMP_CONFIG="$APPDATA/bbdump/config.json" ;;
esac

if [[ -f "$BBDUMP_CONFIG" ]]; then
  # Check if this demo database is already registered
  if grep -q "$DB_NAME" "$BBDUMP_CONFIG" 2>/dev/null; then
    echo "La base est déjà enregistrée dans bbdump."
  else
    DB_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    PROJECT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    CURRENT_USER="$(whoami)"

    # Use a temp file for safe in-place edit
    TMP_CONFIG="$(mktemp)"
    python3 -c "
import json, sys

with open(sys.argv[1], 'r') as f:
    config = json.load(f)

db = {
    'id': '$DB_ID',
    'name': '$DB_NAME',
    'displayName': 'Demo — Communes de France',
    'host': 'localhost',
    'port': 5432,
    'user': '$CURRENT_USER',
    'password': '',
    'encrypted': False,
    'encryptBackups': False,
    'enabled': False,
    'cron': '',
    'output': '',
    'ssl': False,
    'isLocalBbdump': True,
    'masked': False
}

project = {
    'id': '$PROJECT_ID',
    'name': 'bbdump-demo',
    'color': 'bg-green-500',
    'databaseIds': ['$DB_ID'],
    'masked': False,
    'proxyEnabled': False
}

config.setdefault('databases', []).append(db)
config.setdefault('projects', []).append(project)

with open(sys.argv[2], 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
" "$BBDUMP_CONFIG" "$TMP_CONFIG"

    mv "$TMP_CONFIG" "$BBDUMP_CONFIG"
    echo "Base ajoutée dans bbdump (projet \"bbdump-demo\")."

    # Restart bbdump if it's running so it picks up the new config
    case "$(uname)" in
      Darwin)
        if osascript -e 'tell application "System Events" to (name of processes) contains "bbdump"' 2>/dev/null | grep -q true; then
          echo "bbdump est en cours d'exécution — redémarrage..."
          osascript -e 'tell application "bbdump" to quit' 2>/dev/null || true
          sleep 2
          open -a bbdump 2>/dev/null && echo "bbdump redémarré." || echo "Relancez bbdump manuellement."
        fi
        ;;
      *)
        if pgrep -x bbdump &>/dev/null; then
          echo "Relancez bbdump pour voir le projet demo."
        fi
        ;;
    esac
  fi
else
  echo "bbdump n'est pas installé — la base est utilisable directement via psql."
fi

echo "Terminé — la base $DB_NAME est prête."
