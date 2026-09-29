#!/usr/bin/env bash
# Single-test-run runner (T6 lead run).  tools/bench/final/run_arm.sh <A|B|C> <ids...>
#   A = CPU replay of the v0.3.4 service logic · B = T6 frozen (rule 292fb74f…) · C = T5 pose6 from B's pose
#   → tools/bench/final/out/<arm>/<id>.json, log tools/bench/final/out/<arm>/run.log
# Test ids need FINAL_ALLOW_TEST=1. One private headless worker per photo (child process, killed after);
# never talks to :8765. Wall cap FINAL_WALL_S (600 s). Resumable; infra failures re-run (≤ 2), same stamp.
# Run C only after B has finished for the same ids.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
[ $# -ge 2 ] || { echo "usage: $0 <A|B|C> <ids...>" >&2; exit 64; }
free_gb=$(df -g "$ROOT" | awk 'NR==2{print $4}')
[ "${free_gb:-0}" -ge 3 ] || { echo "run_arm: < 3 GB free disk, refusing" >&2; exit 2; }
curl -s -m 5 -o /dev/null http://localhost:3100/ || { echo "run_arm: dev server :3100 not reachable" >&2; exit 3; }
export MATCHER_LG_DEVICE="${MATCHER_LG_DEVICE:-cpu}" TORCH_HOME="$ROOT/tools/matcher/weights" PYTORCH_ENABLE_MPS_FALLBACK=1 PYTHONDONTWRITEBYTECODE=1
arm="$1"; shift
mkdir -p "$HERE/out/$arm"
exec "$ROOT/tools/matcher/.venv/bin/python" "$HERE/final.py" --arm "$arm" "$@"
