#!/bin/bash
# H1 generation chain (PROTOCOL.txt order S2 -> S5 -> S3a -> S3b -> S4), deadlines per the budget rule.
cd "$(dirname "$0")"
PY=../../../matcher/.venv/bin/python
for st in S2 S5; do
  echo "=== $st start $(date -u +%FT%TZ)"; $PY gen.py $st > logs/gen_$st.log 2>&1; echo "=== $st end $(date -u +%FT%TZ)"
done
echo "=== S3a start $(date -u +%FT%TZ)"; $PY gen.py S3a --deadline-utc 2026-09-28T23:15 > logs/gen_S3a.log 2>&1; echo "=== S3a end $(date -u +%FT%TZ)"
echo "=== S3b start $(date -u +%FT%TZ)"; $PY gen.py S3b --deadline-utc 2026-09-29T00:15 > logs/gen_S3b.log 2>&1; echo "=== S3b end $(date -u +%FT%TZ)"
echo "=== S4 start $(date -u +%FT%TZ)"; $PY gen.py S4 --deadline-utc 2026-09-29T01:00 > logs/gen_S4.log 2>&1; echo "=== S4 end $(date -u +%FT%TZ)"
