#!/usr/bin/env bash
# In-the-wild benchmark harness (see run.ts for the full flag list and manifest format).
#   tools/bench/harness/run.sh <manifest.json> [--methods app,cascade,fused] [--ids a,b]
#       [--conditions given|full,nogravity,noheading,none] [--out DIR] [--matcher-url URL]
#       [--no-overlay] [--overlay-methods app,cascade,fused] [--force]
# Needs the dev server on :3100 (APP_URL) for app + fused; fused uses the matcher service on :8765
# if it has ad-hoc support, else starts a private one on :8766 for the run.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
avail_kb=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2{print $4}')
if [[ -n "${avail_kb:-}" && "$avail_kb" -lt 2000000 ]]; then
  echo "[harness] less than 2 GB free on /System/Volumes/Data; refusing to run" >&2
  exit 1
fi
cd "$ROOT"
exec "$ROOT/node_modules/.bin/tsx" "$HERE/run.ts" "$@"
