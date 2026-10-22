#!/bin/sh
# Applies infra/postgres/init/*.sql to the running local Postgres (docker compose) as superuser.
# Init scripts only run on an empty volume; this brings an existing volume up to date.
# Every script there must be idempotent. Run before `pnpm db:migrate`.
# Not in init/ itself: Postgres would run it on first start.
set -eu

cd "$(dirname "$0")/../.."

for script in infra/postgres/init/*.sql; do
  echo "applying $script"
  docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d durby <"$script"
done
