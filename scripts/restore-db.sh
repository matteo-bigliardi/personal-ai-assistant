#!/usr/bin/env bash
# Restores a dump produced by backup-db.sh.
#
#   ./scripts/restore-db.sh backups/assistant-20260905T090707Z.dump [database]
#
# The restore is the half of a backup procedure that is usually never tested,
# so this script exists to make testing it cheap: pass a second argument to
# restore into a scratch database instead of the live one. Without it, the
# target is the real database and the script says so and asks.
#
# Stop the assistant first (`docker compose stop assistant`): restoring under a
# running app means writes landing in a database being replaced underneath it.
set -euo pipefail

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "usage: $0 <dump-file> [target-database]" >&2
  exit 1
fi
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
USER_NAME="${POSTGRES_USER:-assistant}"
LIVE_DB="${POSTGRES_DB:-assistant}"
TARGET="${2:-$LIVE_DB}"

if [ "$TARGET" = "$LIVE_DB" ]; then
  printf 'This REPLACES every table in "%s". Type the database name to continue: ' "$TARGET"
  read -r answer
  [ "$answer" = "$TARGET" ] || { echo "aborted"; exit 1; }
fi

# Created if missing, so restoring into a scratch database is one command.
docker compose exec -T postgres \
  psql -U "$USER_NAME" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$TARGET'" | grep -q 1 ||
  docker compose exec -T postgres createdb -U "$USER_NAME" "$TARGET"

# --clean --if-exists drops what the dump is about to recreate, so restoring
# over an existing database does not fail on every object that already exists.
# Ownership is not restored (--no-owner): the dump may come from another host.
RESTORE="cat > /tmp/restore.dump
pg_restore -U $USER_NAME -d $TARGET --clean --if-exists --no-owner /tmp/restore.dump
status=\$?
rm -f /tmp/restore.dump
exit \$status"
docker compose exec -T postgres sh -c "$RESTORE" < "$FILE"

echo "restored $FILE into $TARGET"
