"""Experiment: FOV-aware render-match sweep (stage1 pipeline.fine_sweep) at each viewpoint candidate.
Question: does the best-supported eye recover photos that fail at the stated eye, without hurting ones that work?
Usage: eyeprobe.py id ...  → .cache/eyeprobe/<id>.json   (dev only unless V2_ALLOW_TEST=1)"""
import os, sys, json, time, traceback
from pathlib import Path
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "stage1")); sys.path.insert(0, str(HERE))
import s1, pipeline as PL, viewpoints as VP

OUT = HERE / ".cache" / "eyeprobe"; OUT.mkdir(parents=True, exist_ok=True)
ids = sys.argv[1:]
if os.environ.get("V2_ALLOW_TEST") != "1":
    assert not (set(ids) & s1.test_ids()), "test ids refused"
man = s1.manifest()
w = s1.Worker(port=int(os.environ.get("V2_PORT", 8769)))
try:
    for pid in ids:
        f = OUT / f"{pid}.json"
        if f.exists():
            continue
        e = man[pid]
        t0 = time.time()
        cands = VP.candidates(e["lat"], e["lon"])
        rec = {"id": pid, "cands": []}
        for c in cands:
            ent = {**e, "lat": c["lat"], "lon": c["lon"], "altitudeM": None}
            ph = s1.Photo(pid, ent)
            se = s1.Session(w, ph)
            r = {**{k: c[k] for k in ("why", "e", "n", "ground", "open", "lat", "lon")}}
            for att in range(3):
                try:
                    ed_eye = se.render(poses=[{"yaw": 0, "pitch": 0, "roll": 0, "vfov": ph.vfov0}])[2]["eye"]
                    hy, _, info = PL.fine_sweep(se, ph, ed_eye)
                    r.update({"eye": ed_eye, "hyps": hy, "info": info}); break
                except Exception as ex:  # noqa: BLE001
                    r["error"] = f"{type(ex).__name__}: {ex}"
            rec["cands"].append(r)
            ph.cleanup()
            print(pid, r["why"], round(r["e"]), round(r["n"]), [h["inliers"] for h in r.get("hyps", [])][:3], r.get("error", ""), flush=True)
        rec["ms"] = round((time.time() - t0) * 1000)
        json.dump(rec, open(f, "w"))
finally:
    w.close()
