#!/usr/bin/env bash
# T6 stage-1 search + verification for bench photos → final poses in the tools/bench/t5 shape.
#
#   tools/matcher/stage1/run.sh <ids...>                 # dev ids (test ids are refused)
#   STAGE1_ALLOW_TEST=1 tools/matcher/stage1/run.sh <ids...>   # the lead's single test run
#
# Needs: the dev server on :3100 (shared), tools/matcher/.venv + weights, ≥ 3 GB free disk.
# Starts ONE private headless worker (vendored render worker, pages blocked from :8768), closes it at
# the end. Does not touch the service on :8765.
# Output:
#   tools/bench/t6/out/<id>.json         final pose, eye {lat, lon, h}, confidenceLevel (HIGH/LOW), checks
#   tools/bench/t6/out/raw/<id>.json     all stage-1 hypotheses and their stage-2 (fused) verification
# Env: STAGE1_OUT (default tools/bench/t6/out), STAGE1_TMP (render temp dir; default $TMPDIR)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
OUT="${STAGE1_OUT:-$ROOT/tools/bench/t6/out}"
export TORCH_HOME="$HERE/../weights"
export PYTHONDONTWRITEBYTECODE=1
export PYTORCH_ENABLE_MPS_FALLBACK=1
free_gb=$(df -g "$ROOT" | awk 'NR==2{print $4}')
if [ "${free_gb:-0}" -lt 3 ]; then echo "stage1: less than 3 GB free disk, refusing" >&2; exit 2; fi
extra=()
if [ "${STAGE1_ALLOW_TEST:-0}" = "1" ]; then extra+=(--allow-test); fi
"$HERE/../.venv/bin/python" "$HERE/pipeline.py" "$@" --out "$OUT/raw" ${extra[@]+"${extra[@]}"}
"$HERE/../.venv/bin/python" "$HERE/finalize.py" --raw "$OUT/raw" --out "$OUT" "$@"
