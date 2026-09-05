#!/usr/bin/env bash
# Dumps the assistant database to a timestamped file.
#
# The dump is the backup, not the Docker volume: a volume copy is tied to this
# Postgres version and to this machine, while a dump restores anywhere. It runs
# through `docker compose exec`, so it needs no Postgres client tools installed
# on the host.
#
#   ./scripts/backup-db.sh [destination-directory]
#
# Default destination is ./backups, which .gitignore already excludes. Point it
# somewhere off this machine for a backup that survives losing the machine.
set -euo pipefail

DEST="${1:-backups}"
cd "$(dirname "$0")/.."

# Read the credentials compose itself uses, so the two cannot disagree.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
USER_NAME="${POSTGRES_USER:-assistant}"
DB_NAME="${POSTGRES_DB:-assistant}"

mkdir -p "$DEST"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DEST/${DB_NAME}-${STAMP}.dump"

# Custom format (-Fc): compressed, and restorable selectively with pg_restore.
docker compose exec -T postgres \
  pg_dump -U "$USER_NAME" -d "$DB_NAME" -Fc --no-owner > "$FILE"

# A dump that cannot be read back is not a backup. Listing the archive's table
# of contents fails loudly on a truncated or empty file. It goes through a
# temporary file inside the container because pg_restore seeks, and a pipe
# cannot be seeked.
VERIFY='cat > /tmp/verify.dump
pg_restore --list /tmp/verify.dump > /dev/null
status=$?
rm -f /tmp/verify.dump
exit $status'
docker compose exec -T postgres sh -c "$VERIFY" < "$FILE"

echo "$FILE ($(wc -c < "$FILE") bytes, table of contents verified)"
