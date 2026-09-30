#!/usr/bin/env bash
# Start the pose-propagation relative-rotation service (roadmap R5; default http://127.0.0.1:8769).
#   tools/nearfield/propagate/run_service.sh [--port 8769] [--host 127.0.0.1]
# CPU only (ALIKED + LightGlue, same estimator as run_propagate.py). The app finds it at
# VITE_PROPAGATE_URL (default http://127.0.0.1:8769); when it is down the /roll panel says so.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
export PYTHONDONTWRITEBYTECODE=1
exec "$ROOT/tools/matcher/.venv/bin/python" "$HERE/service.py" "$@"
