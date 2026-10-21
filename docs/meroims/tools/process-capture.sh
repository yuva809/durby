#!/usr/bin/env bash
# Usage: process-capture.sh <rea-scenario-result.json> <flow-name>
# Redacts tokens, saves the raw capture, and writes a deduped API catalog
# (method path ?{query param names} -> status) per scenario step.
set -euo pipefail
SRC="$1"; NAME="$2"
OUT="$(cd "$(dirname "$0")/.." && pwd)/evidence/captures"
mkdir -p "$OUT"
RAW="$OUT/raw-$NAME.json"

cp "$SRC" "$RAW"
sed -E -i '' \
  -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED_JWT]/g' \
  -e 's/((access_token|token|refresh_token)=)[^"&\\ ]+/\1[REDACTED]/g' "$RAW"
jq empty "$RAW"

jq -r '
  .normalized_result.events.items as $all
  | ($all | map(select(.kind=="response")) | map({(.transaction_id): .status}) | add // {}) as $resp
  | $all[] | select(.kind=="request") | select(.url.url | test("/api/"))
  | "step\(.step_index)\t\(.method) \(.url.url | sub("https://[^/]+"; "") | sub("\\?.*"; ""))"
    + (if (.url.query_parameter_names | length) > 0 then " ?{" + (.url.query_parameter_names | join(",")) + "}" else "" end)
    + " -> " + ($resp[.transaction_id] | tostring)
' "$RAW" | sort -u > "$OUT/flow-$NAME.txt"

echo "steps:"
jq -r '.normalized_result.steps[] | "  \(.step_id // .index): \(.outcome // .status // "?")"' "$RAW" 2>/dev/null || true
echo "final url: $(jq -r '.normalized_result.steps[-1].capture.url // .normalized_result.final_capture.url // "?"' "$RAW" 2>/dev/null)"
cat "$OUT/flow-$NAME.txt"
