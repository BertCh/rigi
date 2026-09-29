#!/bin/bash
# Design phase: odd DEV ids only, backbone sweep with the "bb" config set. usage: run_design.sh BB [BB...]
cd "$(dirname "$0")"
PY=../../../matcher/.venv/bin/python
ODD=$($PY -c "import sys;sys.path.insert(0,'..');import tm_common as t;print(' '.join(p for p in t.dev_ids() if int(p[3:])%2))")
for BB in "$@"; do
  $PY run.py $BB d_$BB --cfgs bb --wait $ODD 2>&1 | grep --line-buffered -v -i warn
done
echo DESIGN_DONE
