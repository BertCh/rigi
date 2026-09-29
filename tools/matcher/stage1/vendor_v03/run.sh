#!/usr/bin/env bash
# Start the render-and-match service on :8765 (needs the dev server on :3100 for photoId mode).
#   tools/matcher/server/run.sh [--port 8765] [--host 127.0.0.1] [--no-warm-renderer]
#   env: APP_URL (default http://localhost:3100), MATCHER_CORS (comma list of allowed origins),
#        MATCHER_TIMEOUT_MS (default 120000), MATCHER_MAX_PAGES (warm /photo pages, default 1)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export TORCH_HOME="$HERE/../../weights"
export PYTHONDONTWRITEBYTECODE=1
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec "$HERE/../../.venv/bin/python" "$HERE/app.py" "$@"
