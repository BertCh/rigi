"""For dev photos with a verified-correct pose at the stated eye: where does the stated eye rank, and does the
top eye's pose agree with the ref? Output .cache/eyecal/<id>.json"""
import sys, json, os
from multiprocessing import Pool
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
import refs, eyesearch as ES
OUT = Path(__file__).parent / ".cache" / "eyecal"; OUT.mkdir(parents=True, exist_ok=True)
RAD, STEP = float(os.environ.get("RAD", 300)), float(os.environ.get("STEP", 50))

def run(pid):
    f = OUT / f"{pid}.json"
    if f.exists(): return pid
    ed, m = ES.load_edges(pid)
    es = ES.EyeSearch(ed, m, RAD)
    res = es.search(RAD, STEP, top=10)
    json.dump({"id": pid, "refs": refs.correct_refs(pid), "rows": res["rows"], "ms": res["ms"]}, open(f, "w"))
    return pid

if __name__ == "__main__":
    ids = sys.argv[1:] or refs.dev_ids()
    with Pool(int(os.environ.get("NP", 4))) as p:
        for pid in p.imap_unordered(run, ids):
            print(pid, flush=True)
