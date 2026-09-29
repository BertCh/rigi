#!/usr/bin/env bash
# Single pre-registered test-set run (reports/test-prereg.md): arms A, B, C in order, one at a time.
set -u
cd "$(dirname "$0")/../../.."
LOG=tools/bench/final/out/drive.log
PRE=$(shasum reports/test-prereg.md | cut -d' ' -f1)
IDS=$(python3 -c "import json;print(' '.join(json.load(open('tools/bench/split.json'))['test']))")
echo "prereg_sha1=$PRE split_sha1=$(shasum tools/bench/split.json | cut -d' ' -f1) start=$(date -u +%FT%TZ) n=$(echo $IDS | wc -w)" | tee -a $LOG
for ARM in A B C; do
  free=$(df -g /System/Volumes/Data | tail -1 | awk '{print $4}')
  if [ "$free" -lt 3 ]; then echo "DISK STOP before arm $ARM (free ${free} GB)" | tee -a $LOG; exit 2; fi
  echo "arm $ARM start $(date -u +%FT%TZ) prereg_sha1=$PRE swap=$(sysctl -n vm.swapusage)" | tee -a $LOG
  FINAL_ALLOW_TEST=1 PREREG_SHA1=$PRE tools/bench/final/run_arm.sh $ARM $IDS >> tools/bench/final/out/drive.$ARM.stdout 2>&1
  echo "arm $ARM end $(date -u +%FT%TZ) exit=$? records=$(ls tools/bench/final/out/$ARM/*.json 2>/dev/null | wc -l)" | tee -a $LOG
done
echo "ALL DONE $(date -u +%FT%TZ)" | tee -a $LOG
