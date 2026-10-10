#!/usr/bin/env bash
# tsc-no-new-diagnostics.sh — fail if the current tree introduces any TypeScript
# diagnostic that is not already present on the baseline ref (default: main).
#
# Usage: scripts/tsc-no-new-diagnostics.sh [BASE_REF]
#
# How:
#   1. `git worktree add` BASE_REF into a temp dir (node_modules symlinked from
#      this checkout so both sides compile against identical dependencies).
#   2. Run `npx tsc --noEmit -p .` on the baseline and on the working tree.
#   3. Normalise each diagnostic to the KEY  file|TScode|message  and compare
#      the sorted key sets; print every NEW diagnostic (with its current line)
#      and exit 1 if there are any.
#
# Why the key omits line/column: edits shift line numbers in touched files, so
# a pre-existing diagnostic would otherwise look "new" just because code above
# it moved. Keying on file+code+message keeps it stable. Trade-off: a genuinely
# new diagnostic that is textually identical to an existing one in the same
# file is not detected — we compare MULTISETS (duplicate keys are counted via
# `uniq -c`) so an extra occurrence of an identical message is still reported.
set -euo pipefail

BASE_REF="${1:-main}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
WT="$(mktemp -d /tmp/ciq-tsc-base.XXXXXX)"
OUT="$(mktemp -d /tmp/ciq-tsc-out.XXXXXX)"
cleanup() {
  git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  rm -rf "$OUT"
}
trap cleanup EXIT

git worktree add --detach --quiet "$WT" "$BASE_REF"
ln -s "$ROOT/node_modules" "$WT/node_modules"

run_tsc() { # $1 dir, $2 raw output file
  ( cd "$1" && npx tsc --noEmit -p . > "$2" 2>&1 ) || true
}
# "path(line,col): error TSxxxx: message"  ->  "path|TSxxxx|message"
to_keys() {
  grep -E '^[^ ].*\([0-9]+,[0-9]+\): error TS[0-9]+:' "$1" \
    | sed -E 's/^(.*)\([0-9]+,[0-9]+\): error (TS[0-9]+): (.*)$/\1|\2|\3/' \
    | sort | uniq -c | sed -E 's/^ *([0-9]+) /\1\t/' | sort -t$'\t' -k2 || true
}

echo "[tsc-diff] baseline: $BASE_REF ($(git rev-parse --short "$BASE_REF"))"
run_tsc "$WT" "$OUT/base.raw"
echo "[tsc-diff] current:  working tree ($(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD))"
run_tsc "$ROOT" "$OUT/cur.raw"

to_keys "$OUT/base.raw" > "$OUT/base.keys"
to_keys "$OUT/cur.raw"  > "$OUT/cur.keys"
BASE_N=$(grep -cE ': error TS[0-9]+:' "$OUT/base.raw" || true)
CUR_N=$(grep -cE ': error TS[0-9]+:' "$OUT/cur.raw" || true)

# A key is NEW if absent from baseline or present more times than in baseline.
NEW_KEYS="$OUT/new.keys"
awk -F'\t' 'NR==FNR { base[$2]=$1; next } { b = ($2 in base) ? base[$2] : 0; if ($1 > b) print ($1 - b) "\t" $2 }' \
  "$OUT/base.keys" "$OUT/cur.keys" > "$NEW_KEYS"

echo "[tsc-diff] baseline diagnostics: $BASE_N   current diagnostics: $CUR_N"
if [ -s "$NEW_KEYS" ]; then
  echo "[tsc-diff] NEW diagnostics vs $BASE_REF:"
  while IFS=$'\t' read -r extra key; do
    file="${key%%|*}"; rest="${key#*|}"; code="${rest%%|*}"; msg="${rest#*|}"
    echo "  (+$extra) $file $code: $msg"
    grep -F "$file(" "$OUT/cur.raw" | grep -F "error $code: $msg" | sed 's/^/        at /' || true
  done < "$NEW_KEYS"
  exit 1
fi
echo "[tsc-diff] NO NEW diagnostics vs $BASE_REF baseline ($BASE_N baseline diagnostics remain)"
