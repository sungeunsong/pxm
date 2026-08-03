#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
production_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file=${PXM_PRODUCTION_COMPOSE_FILE:-$production_dir/docker-compose.yml}
output_dir=${1:-${PXM_BACKUP_DIR:-/var/backups/pxm}}
recipient=${PXM_BACKUP_AGE_RECIPIENT:-}
retention_days=${PXM_BACKUP_RETENTION_DAYS:-30}

case "$output_dir" in
  ''|/) echo "unsafe backup output directory: $output_dir" >&2; exit 1 ;;
esac
case "$retention_days" in
  *[!0-9]*|'') echo "PXM_BACKUP_RETENTION_DAYS must be a positive integer" >&2; exit 1 ;;
esac
if [ -z "$recipient" ]; then
  echo "PXM_BACKUP_AGE_RECIPIENT is required; plaintext production backups are not allowed" >&2
  exit 1
fi
command -v age >/dev/null 2>&1 || { echo "age is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }

umask 077
mkdir -p "$output_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
database=${MONGO_INITDB_DATABASE:-pxm}
final="$output_dir/pxm-$database-$timestamp.archive.gz.age"
temporary=$(mktemp "$output_dir/.pxm-backup.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

docker compose -f "$compose_file" --env-file "$production_dir/.env.production" exec -T mongodb sh -ec '
  exec mongodump \
    --host 127.0.0.1 --port 27017 \
    --username "$MONGO_INITDB_ROOT_USERNAME" \
    --password "$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE")" \
    --authenticationDatabase admin \
    --db "$MONGO_INITDB_DATABASE" \
    --archive --gzip
' | age --encrypt --recipient "$recipient" --output "$temporary"

test -s "$temporary"
mv "$temporary" "$final"
sha256sum "$final" > "$final.sha256"
find "$output_dir" -maxdepth 1 -type f \
  \( -name 'pxm-*.archive.gz.age' -o -name 'pxm-*.archive.gz.age.sha256' \) \
  -mtime "+$retention_days" -delete
trap - EXIT HUP INT TERM

echo "encrypted backup created: $final"
