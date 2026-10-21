#!/usr/bin/env bash
# Usage: post-batch.sh <batch-name> <rea-inspect-result-file>
# Combines the CDP driver output (evidence/routes/<batch>.json) with the REA passive
# capture (value-free shapes) and writes docs/routes/<batch>.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; B="$1"; REA="$2"
DRV="$ROOT/evidence/routes/$B.json"; MD="$ROOT/docs/routes/$B.md"
mkdir -p "$ROOT/docs/routes"
"$ROOT/tools/process-shapes.sh" "$REA" "$B" >/dev/null
SHP="$ROOT/evidence/captures/shapes-$B.txt"
SHELL_RE='^(GET /api/(account-config|core/billing/status|core/branches/mine|core/me|core/notifications|events/stream|overview))$'

{
  echo "# Route dossiers — $B"
  echo
  echo "Generated from \`evidence/routes/$B.json\` (CDP driver: UI inventory + API calls, read-only, writes blocked at network layer)"
  echo "and \`evidence/captures/shapes-$B.txt\` (REA passive capture: value-free JSON shapes). Shell calls made on every page are omitted."
  echo "Blocked write attempts in this batch: $(jq '.blocked | length' "$DRV")"
  echo
  jq -r --arg shell "$SHELL_RE" '
    . as $root
    | .steps[]
    | . as $s
    | "## `\($s.ui.path // "?")` — \($s.ui.headings[0] // $s.id)",
      "",
      (if $s.error then "**Error:** \($s.error)\n" else empty end),
      (if $s.note then "_\($s.note)_\n" else empty end),
      (if $s.opened then "- Row open: \($s.opened.result) (\($s.opened.from) → \($s.opened.to))" else empty end),
      "- Headings: \(($s.ui.headings // []) | join(" · "))",
      "- Actions/buttons: \(($s.ui.buttons // []) | join(" · "))",
      (if (($s.ui.tabs // []) | length) > 0 then "- Tabs: \($s.ui.tabs | join(" · "))" else empty end),
      (if (($s.ui.tableHeaders // []) | length) > 0 then "- Table columns: " + ([$s.ui.tableHeaders[] | join(" | ")] | join("  ‖  ")) else empty end),
      (if (($s.ui.fields // []) | length) > 0 then "- Form fields: " + ([$s.ui.fields[] | "\(.label // .name)\(if .required then "*" else "" end) [\(.type)]"] | unique | join(" · ")) else empty end),
      (if (($s.ui.emptyStates // []) | length) > 0 then "- Empty state: \($s.ui.emptyStates | join(" / "))" else empty end),
      (if $s.ui.dialog then "- Detail panel/dialog: headings \(($s.ui.dialog.headings // []) | join(" · ")); actions \(($s.ui.dialog.buttons // []) | join(" · "))" else empty end),
      (if (($s.skippedTabs // []) | length) > 0 then "- Tabs skipped by safety filter: \($s.skippedTabs | join(", "))" else empty end),
      ( [$root.api[] | select(.step == $s.id or (.step | startswith($s.id + "#"))) | "\(.method) \(.path)" + (if (.params | length) > 0 then " ?{" + (.params | join(",")) + "}" else "" end) + (if (.step | contains("#")) then "  ← tab " + (.step | split("#")[1]) else "" end)]
        | unique | map(select((split(" ?")[0] | test($shell)) | not))
        | if length > 0 then "- API calls:\n" + (map("  - `" + . + "`") | join("\n")) else "- API calls: (none beyond shell)" end ),
      ( [$s.tabViews[]? | select(.ui) | "  - **\(.tab)**: headings \((.ui.headings // [])[0:4] | join(" · ")); fields \((.ui.fields // []) | length); columns \(((.ui.tableHeaders // [])[0] // []) | join(" | "))"]
        | if length > 0 then "- Tab views:\n" + join("\n") else empty end ),
      ""
  ' "$DRV"
} > "$MD"

echo "driver: $(cat "$ROOT/evidence/routes/$B.log" 2>/dev/null)"
echo "blocked: $(jq -c '.blocked' "$DRV")"
echo "routes documented: $(grep -c '^## ' "$MD")  -> docs/routes/$B.md"
echo "shape endpoints captured: $(grep -c '^## ' "$SHP")"
echo "NEW endpoints (not in any earlier shape file):"
comm -13 <(ls "$ROOT"/evidence/captures/shapes-*.txt | grep -v "shapes-$B.txt" | xargs cat | grep '^## ' | sed 's/ ?{.*//' | sort -u) \
         <(grep '^## ' "$SHP" | sed 's/ ?{.*//' | sort -u)
