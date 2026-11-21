#!/usr/bin/env bash
# DESTRUCTIVE, test data only. Wipes one organization (scripts/wipe/wipe-tenant.sql), then creates AsiaMight again
# through the platform API (scripts/onboard/create-customer.mjs). The owner sets their own password from the email link.
#
#   STAFF_EMAIL=<platform admin email> bash scripts/wipe/recreate-customer.sh <old organization id>
#
# Run on the server in /opt/durby. It asks for the platform admin password at a prompt (never stored).
set -euo pipefail

ORG_ID="${1:?usage: recreate-customer.sh <old organization id>}"
: "${STAFF_EMAIL:?set STAFF_EMAIL to a platform admin email}"
PLATFORM_API="${PLATFORM_API:-https://app.durby.tech/api/v1}"
OWNER="asiamight01@gmail.com"
NAME="AsiaMight"
PARTNER="AsiaMight"

cd /opt/durby

echo "== Dry run: counts what would be deleted, then rolls back"
bin/dc exec -T postgres psql -U postgres durby -v org_id="$ORG_ID" -v apply_yes=0 < scripts/wipe/wipe-tenant.sql

echo
read -r -p "Type WIPE to delete this organization's data for good: " answer
if [ "$answer" != "WIPE" ]; then
  echo "Stopped. Nothing was deleted."
  exit 1
fi

echo "== Wiping $ORG_ID"
bin/dc exec -T postgres psql -U postgres durby -v org_id="$ORG_ID" -v apply_yes=1 < scripts/wipe/wipe-tenant.sql

echo "== Creating $NAME for $OWNER"
read -r -s -p "Platform admin password (not shown): " STAFF_PASSWORD
echo
docker run --rm \
  -e STAFF_EMAIL="$STAFF_EMAIL" -e STAFF_PASSWORD="$STAFF_PASSWORD" -e PLATFORM_API="$PLATFORM_API" \
  -v /opt/durby:/work -w /work node:22-alpine \
  node scripts/onboard/create-customer.mjs --name "$NAME" --owner "$OWNER" --partner "$PARTNER"
unset STAFF_PASSWORD

echo "Done. The owner gets an invitation email to set their own password."
