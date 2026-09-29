#!/bin/sh
# Reproduce the Commons Swiss-mountain benchmark. Steps 1-2 need only stdlib python3;
# steps 3-4 need PIL (uses the existing matcher venv). Screening (screen_notes.txt) is manual:
# view work/sheets/*.jpg and record accepted candidate indices before running make_selection.py.
set -e
cd "$(dirname "$0")"
PY=../../matcher/.venv/bin/python
python3 01_discover.py        # geosearch + category walks -> work/titles.json
python3 02_meta.py a          # cheap metadata for all titles -> work/meta_a.json
python3 02_meta.py b          # EXIF + wikitext for top 2500 -> work/meta_b.json
python3 02_meta.py rank       # -> work/candidates.json (640, region round-robin)
$PY 03_sheets.py              # thumbnails + 4x4 contact sheets -> work/sheets/
python3 make_selection.py     # screen_notes.txt -> selection.json (balanced 100)
$PY 04_finalize.py            # -> ../data/photos, manifest.json, ATTRIBUTION.md
