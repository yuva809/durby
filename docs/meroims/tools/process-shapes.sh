#!/usr/bin/env bash
# Usage: process-shapes.sh <rea-inspect_web_page-result.json> <name>
# Redacts tokens, saves the raw passive capture, and writes value-free
# request/response shapes per endpoint (deduped per endpoint).
set -euo pipefail
SRC="$1"; NAME="$2"
OUT="$(cd "$(dirname "$0")/.." && pwd)/evidence/captures"
mkdir -p "$OUT"
RAW="$OUT/raw-$NAME.json"; SHP="$OUT/shapes-$NAME.txt"

cp "$SRC" "$RAW"
sed -E -i '' \
  -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[REDACTED_JWT]/g' \
  -e 's/((access_token|token|refresh_token)=)[^"&\\ ]+/\1[REDACTED]/g' "$RAW"
jq empty "$RAW"

jq -r '
  .normalized_result.network.requests[]
  | select(.method != "OPTIONS") | select((.url.url? // .url) | tostring | test("api-dev"))
  | . as $r
  | (($r.url.url? // $r.url) | tostring | sub("https://api-dev.meroims.com"; "") | sub("\\?.*"; "")
     | gsub("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"; "{id}")) as $p
  | ($r.url.query_parameter_names? // []) as $q
  | "## \($r.method) \($p)" + (if ($q | length) > 0 then " ?{" + ($q | join(",")) + "}" else "" end),
    ( ["request", "response"][] as $side
      | ($r.body_shapes[$side] // empty) as $s
      | ($s.properties[]? | "    \($side): " + ([.path[] | if .kind == "property" then .name else "[]" end] | join(".")) + " : " + (.types | join("|"))) )
' "$RAW" | awk '/^## /{cur=$0; if(!(cur in H)){H[cur]=1; print}; next} {k=cur"|"$0; if(!(k in S)){S[k]=1; print}}' > "$SHP"

echo "window: $(jq -c '.normalized_result.capture_window' "$RAW")"
echo "endpoints: $(grep -c '^## ' "$SHP")  lines: $(wc -l < "$SHP")"
