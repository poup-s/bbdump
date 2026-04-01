#!/usr/bin/env bash
# Supprime la base demo et son entrée dans bbdump.
set -euo pipefail

DB_NAME="bbdump-demo-french-towns"

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

# Drop the database
if psql -lqt | cut -d\| -f1 | grep -qw "$DB_NAME"; then
  dropdb "$DB_NAME"
  echo "Base $DB_NAME supprimée."
else
  echo "La base $DB_NAME n'existe pas."
fi

# Remove from bbdump config
BBDUMP_CONFIG=""
case "$(uname)" in
  Darwin) BBDUMP_CONFIG="$HOME/Library/Application Support/bbdump/config.json" ;;
  Linux)  BBDUMP_CONFIG="$HOME/.config/bbdump/config.json" ;;
  *)      BBDUMP_CONFIG="$APPDATA/bbdump/config.json" ;;
esac

if [[ -f "$BBDUMP_CONFIG" ]] && grep -q "$DB_NAME" "$BBDUMP_CONFIG" 2>/dev/null; then
  TMP_CONFIG="$(mktemp)"
  python3 -c "
import json, sys

with open(sys.argv[1], 'r') as f:
    config = json.load(f)

# Find and remove the demo database, collect its id
removed_ids = set()
databases = []
for db in config.get('databases', []):
    if db.get('name') == '$DB_NAME':
        removed_ids.add(db['id'])
    else:
        databases.append(db)
config['databases'] = databases

# Remove the demo project and clean references
projects = []
for p in config.get('projects', []):
    if p.get('name') == 'bbdump-demo':
        continue
    p['databaseIds'] = [d for d in p.get('databaseIds', []) if d not in removed_ids]
    projects.append(p)
config['projects'] = projects

with open(sys.argv[2], 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
" "$BBDUMP_CONFIG" "$TMP_CONFIG"

  mv "$TMP_CONFIG" "$BBDUMP_CONFIG"
  echo "Entrée supprimée de la config bbdump."

  # Restart bbdump if running
  case "$(uname)" in
    Darwin)
      if osascript -e 'tell application "System Events" to (name of processes) contains "bbdump"' 2>/dev/null | grep -q true; then
        echo "Redémarrage de bbdump..."
        osascript -e 'tell application "bbdump" to quit' 2>/dev/null || true
        sleep 2
        open -a bbdump 2>/dev/null && echo "bbdump redémarré." || echo "Relancez bbdump manuellement."
      fi
      ;;
    *)
      if pgrep -x bbdump &>/dev/null; then
        echo "Relancez bbdump pour appliquer les changements."
      fi
      ;;
  esac
else
  echo "Rien à nettoyer dans la config bbdump."
fi

echo "Cleanup terminé."
