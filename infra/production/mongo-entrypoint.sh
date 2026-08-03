#!/bin/sh
set -eu

read_secret() {
  variable="$1"
  eval "file=\${${variable}_FILE:-}"
  if [ -z "$file" ] || [ ! -r "$file" ]; then
    echo "required MongoDB secret is not readable: $variable" >&2
    exit 1
  fi
  value=$(cat "$file")
  if [ -z "$value" ]; then
    echo "required MongoDB secret is empty: $variable" >&2
    exit 1
  fi
  export "$variable=$value"
  unset "${variable}_FILE"
}

read_secret MONGO_INITDB_ROOT_PASSWORD
read_secret PXM_MONGO_APP_PASSWORD

key_file=${PXM_MONGO_KEY_FILE:-/run/secrets/mongo_keyfile}
if [ ! -r "$key_file" ]; then
  echo "MongoDB replica-set key file is not readable" >&2
  exit 1
fi
install -o mongodb -g mongodb -m 0400 "$key_file" /data/configdb/pxm-keyfile

exec /usr/local/bin/docker-entrypoint.sh "$@"
