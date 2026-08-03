#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
production_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file=${PXM_PRODUCTION_COMPOSE_FILE:-$production_dir/docker-compose.yml}
archive=${1:-}
identity=${PXM_BACKUP_AGE_IDENTITY:-}
source_db=${MONGO_INITDB_DATABASE:-pxm}
minimum_workflows=${PXM_RESTORE_MIN_WORKFLOWS:-1}

if [ -z "$archive" ] || [ ! -f "$archive" ]; then
  echo "usage: PXM_BACKUP_AGE_IDENTITY=/secure/key $0 <backup.archive.gz.age>" >&2
  exit 1
fi
if [ -z "$identity" ] || [ ! -r "$identity" ]; then
  echo "PXM_BACKUP_AGE_IDENTITY must point to a readable age identity" >&2
  exit 1
fi
case "$minimum_workflows" in
  *[!0-9]*|'') echo "PXM_RESTORE_MIN_WORKFLOWS must be a non-negative integer" >&2; exit 1 ;;
esac
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }

checksum="$archive.sha256"
if [ ! -f "$checksum" ]; then
  echo "backup checksum is required: $checksum" >&2
  exit 1
fi
(cd "$(dirname "$archive")" && sha256sum -c "$(basename "$checksum")")

restore_db="pxm_restore_verify_$(date -u +%Y%m%d%H%M%S)_$$"
case "$restore_db" in
  pxm_restore_verify_[0-9]*) ;;
  *) echo "unsafe restore database name" >&2; exit 1 ;;
esac

cleanup() {
  docker compose -f "$compose_file" --env-file "$production_dir/.env.production" exec -T mongodb sh -ec '
    mongosh --quiet --host 127.0.0.1 --port 27017 \
      --username "$MONGO_INITDB_ROOT_USERNAME" \
      --password "$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE")" \
      --authenticationDatabase admin \
      --eval "db.getSiblingDB(\"$1\").dropDatabase()" >/dev/null
  ' sh "$restore_db" || true
}
trap cleanup EXIT HUP INT TERM

age --decrypt --identity "$identity" "$archive" | \
  docker compose -f "$compose_file" --env-file "$production_dir/.env.production" exec -T mongodb sh -ec '
    exec mongorestore \
      --host 127.0.0.1 --port 27017 \
      --username "$MONGO_INITDB_ROOT_USERNAME" \
      --password "$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE")" \
      --authenticationDatabase admin \
      --archive --gzip \
      --nsFrom "$1.*" --nsTo "$2.*"
  ' sh "$source_db" "$restore_db"

workflow_count=$(docker compose -f "$compose_file" --env-file "$production_dir/.env.production" exec -T mongodb sh -ec '
  mongosh --quiet --host 127.0.0.1 --port 27017 \
    --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE")" \
    --authenticationDatabase admin \
    --eval "db.getSiblingDB(\"$1\").v2_process_definitions.countDocuments({})"
' sh "$restore_db" | tail -n 1 | tr -d '[:space:]')

case "$workflow_count" in
  *[!0-9]*|'') echo "restore verification returned an invalid workflow count" >&2; exit 1 ;;
esac
if [ "$workflow_count" -lt "$minimum_workflows" ]; then
  echo "restore verification failed: workflows=$workflow_count expected>=$minimum_workflows" >&2
  exit 1
fi

echo "restore verification passed: database=$restore_db workflows=$workflow_count"
