#!/bin/sh
# Single entrypoint for every Railway service built from this image.
#   SERVICE_ROLE=web    (default) → prisma migrate deploy, then next start
#   SERVICE_ROLE=worker           → DM worker (+ cron loop when CRON_BASE_URL is set)
set -e

ROLE="${SERVICE_ROLE:-web}"
BIN="./node_modules/.bin"

if [ "$ROLE" = "worker" ]; then
  if [ -n "${CRON_BASE_URL:-}" ]; then
    echo "[start] cron loop → $CRON_BASE_URL"
    sh scripts/cron.sh &
  fi
  echo "[start] worker"
  exec "$BIN/tsx" worker/dm-worker.ts
fi

echo "[start] prisma migrate deploy"
"$BIN/prisma" migrate deploy

echo "[start] web on port ${PORT:-3000}"
exec "$BIN/next" start -H 0.0.0.0 -p "${PORT:-3000}"
