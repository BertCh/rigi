"""v3 step 2: build work/candidates.json (CH pool head + world pool) and contact sheets, reusing v1's
03_sheets.py unchanged but bound to the v3 common (work dir = collect_v3/work).

Usage: tools/matcher/.venv/bin/python 20_sheets.py [N_CH]
Indices on the sheets are indices into collect_v3/work/candidates.json.
"""
import os
import runpy
import sys

import common  # v3 common; pre-registered so the v1 script's `from common import ...` binds here
from common import HERE, load, save

n_ch = int(sys.argv[1]) if len(sys.argv) > 1 else 288
if not os.path.exists(os.path.join(common.WORK, "candidates.json")):
    cands = load("pool_ch.json")[:n_ch] + load("pool_world.json")
    save("candidates.json", cands)
    print(len(cands), "candidates;", "world start index", n_ch)
sys.argv = [sys.argv[0]]
runpy.run_path(os.path.join(HERE, "..", "collect", "03_sheets.py"), run_name="__main__")
