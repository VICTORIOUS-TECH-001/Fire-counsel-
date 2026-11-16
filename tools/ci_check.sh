#!/usr/bin/env bash
# Preserve the command's exit status and expose a bounded failure excerpt in
# GitHub check annotations/summary, even when full log downloads are unavailable.
set -uo pipefail

if (( $# < 2 )) || [[ ! "$1" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Usage: bash tools/ci_check.sh LABEL COMMAND [ARG ...]" >&2
  exit 2
fi
label="$1"
shift
mkdir -p .cache/ci || exit 1
log=".cache/ci/${label}.log"

"$@" 2>&1 | tee "$log"
statuses=("${PIPESTATUS[@]}")
status="${statuses[0]}"
if (( status == 0 )); then status="${statuses[1]}"; fi

if (( status != 0 )); then
  node --input-type=module - "$label" "$log" "$status" <<'JS'
import { appendFileSync, readFileSync } from "node:fs";
const [label, path, status] = process.argv.slice(2);
const tail = readFileSync(path, "utf8").replace(/\u001b\[[0-9;]*m/g, "").slice(-14000);
const message = `Command exited with status ${status}.\n${tail}`;
const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
console.log(`::error title=${label} failed::${escaped}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const fence = "`".repeat(Math.max(3, ...[...tail.matchAll(/`+/g)].map(match => match[0].length + 1)));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ${label} failed (exit ${status})\n\n${fence}text\n${tail}\n${fence}\n`);
}
JS
fi

exit "$status"
