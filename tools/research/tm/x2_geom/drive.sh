#!/bin/bash
# usage: drive.sh <shard k> <nshards>  — score photos as their cache DONE + geom appear
cd "$(dirname "$0")"
PY=../../../matcher/.venv/bin/python
IDS=$(PYTHONPATH= $PY -c "import _env,tm_common;ids=tm_common.dev_ids();print(' '.join(ids[$1::$2]))")
while true; do
  left=0
  for p in $IDS; do
    [ -f results/$p.json ] && continue
    if [ -f ../cache/$p/DONE ] && [ -f geom/$p.moge_l.npz ] && [ -f geom/$p.moge_b.npz ] && [ -f geom/$p.da3_b.npz ]; then
      PYTHONPATH= $PY -W ignore run_eval.py $p
    else
      left=$((left+1))
    fi
  done
  [ $left -eq 0 ] && break
  [ -f ../cache/ALL_DONE ] && [ -f geom/.infer_done ] && break
  sleep 30
done
echo "shard $1 finished"
