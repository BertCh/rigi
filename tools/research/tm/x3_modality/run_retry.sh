#!/bin/sh
# run run_match.py with the given args; retry (up to 6x) after crashes (MPS segfaults under memory pressure); resumable.
cd "$(dirname "$0")"
for i in 1 2 3 4 5 6; do
  ../../../matcher/.venv/bin/python run_match.py "$@"; rc=$?
  echo "EXIT $rc (attempt $i)"
  [ $rc -eq 0 ] && break
  sleep 20
done
