#!/bin/sh
# E2 resume chain: wait for s2_fetch, then variants (CPU), then matching (gpu_lock per batch). One heavy step at a time.
cd "$(dirname "$0")"
PY=../../../matcher/.venv/bin/python
until grep -q S2EXIT logs/s2_fetch.log 2>/dev/null; do sleep 15; done
$PY -u appearance.py > logs/appearance.log 2>&1; echo "APPEXIT $?" >> logs/appearance.log
$PY -u match_run.py > logs/match.log 2>&1; echo "MATCHEXIT $?" >> logs/match.log
