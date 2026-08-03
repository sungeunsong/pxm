#!/bin/sh
set -eu

load_secret() {
  variable="$1"
  eval "file=\${${variable}_FILE:-}"
  if [ -n "$file" ]; then
    if [ ! -r "$file" ]; then
      echo "secret file for $variable is not readable: $file" >&2
      exit 1
    fi
    value=$(cat "$file")
    if [ -z "$value" ]; then
      echo "secret file for $variable is empty" >&2
      exit 1
    fi
    export "$variable=$value"
    unset "${variable}_FILE"
  fi
}

for variable in \
  MONGODB_URL \
  CREDENTIAL_SECRET_KEY \
  PXM_BOOTSTRAP_ADMIN_PASSWORD \
  PXM_EXTERNAL_APPROVAL_SECRET \
  SMTP_PASSWORD
do
  load_secret "$variable"
done

if [ "$(id -u)" = "0" ]; then
  if [ -z "${PXM_RUN_AS_UID:-}" ] || [ -z "${PXM_RUN_AS_GID:-}" ]; then
    echo "PXM_RUN_AS_UID and PXM_RUN_AS_GID are required when the secret loader starts as root" >&2
    exit 1
  fi
  exec setpriv \
    --reuid="$PXM_RUN_AS_UID" \
    --regid="$PXM_RUN_AS_GID" \
    --init-groups \
    "$@"
fi

exec "$@"
