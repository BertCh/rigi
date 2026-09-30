#!/bin/zsh
# one runner at a time: e3_run -> e3_posthoc -> delete regenerable data/<pid>
cd "$(dirname "$0")"
PY=../../../matcher/.venv/bin/python
export PYTHONPATH=../.pylib
for pid in "$@"; do
  while true; do
    fr=$(memory_pressure | tail -1 | grep -o '[0-9]*%' | tr -d '%')
    [ "$fr" -ge 20 ] && break
    echo "$(date +%T) low memory ($fr%), waiting"; sleep 60
  done
  echo "$(date +%T) start $pid (mem free $fr%)"
  [ -f out/$pid.json ] || $PY e3_run.py $pid 2>&1 | grep -v -i warn
  $PY e3_posthoc.py $pid 2>&1 | grep -v -i warn
  if [ -f out/$pid.json ] && [ -f out_posthoc/$pid.json ]; then rm -rf data/$pid; fi
done
echo "$(date +%T) ALL DONE"
