#!/usr/bin/env bash
# Start the Step Inside near-field service (default http://127.0.0.1:8767).
#   tools/nearfield/run.sh [--port 8767] [--host 127.0.0.1]
#   env: NEARFIELD_IDLE_S (unload model after idle, 300), NEARFIELD_CACHE_MB (1024), NEARFIELD_DEVICE (mps|cpu),
#        NEARFIELD_GPU_WAIT_S (900). Selftest: tools/matcher/.venv/bin/python tools/nearfield/service/selftest.py
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PYTHONDONTWRITEBYTECODE=1
export PYTORCH_ENABLE_MPS_FALLBACK=1
export TORCH_HOME="$HERE/service/weights/torch"
export HF_HUB_OFFLINE=1
exec "$ROOT/tools/matcher/.venv/bin/python" "$HERE/service/app.py" "$@"
