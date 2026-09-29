#!/bin/sh
# Reproduce the wild v3 HELD-OUT set (tools/bench/data_v3). Reads the v1 collection (../collect/work, ../data) read-only.
# Screening (screen_notes.txt) is manual: view work/sheets/*.jpg and record accepted candidate indices.
set -e
cd "$(dirname "$0")"
PY=../../matcher/.venv/bin/python
python3 05_extra_meta.py ch      # heavy meta for under-represented CH regions -> work/meta_b_extra.json
python3 05_extra_meta.py world   # non-Swiss geosearch + meta -> work/world_*.json
python3 10_pool.py               # v1 metadata minus the v1 100 and near-dups -> work/pool_ch.json, pool_world.json
$PY 20_sheets.py 288             # candidates.json (288 CH + world) + contact sheets (v1 03_sheets.py)
python3 30_make_selection.py     # screen_notes.txt -> selection.json (60 CH + <=15 world, stratified)
$PY 40_finalize.py               # -> ../data_v3/photos, manifest.json, ATTRIBUTION.md
