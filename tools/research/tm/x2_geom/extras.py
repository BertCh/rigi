"""X2 extras: FOV estimates vs manifest/ref, pano-resampling self-check, runtimes.  -> extras.json"""
from __future__ import annotations
import _env  # noqa: F401
import glob, json, math
import numpy as np

R = {f.split("/")[-1][:-5]: json.load(open(f)) for f in sorted(glob.glob(str(_env.HERE / "results/*.json")))}
out = {}
# FOV
fov = {}
for m in ("moge_l", "moge_b", "da3_b"):
    e_ref, e_man_known, e_man_unknown = [], [], []
    for p, r in R.items():
        pred = r["fov_pred"][m]["hfov"]
        c = next((x for x in r["refs"] if x["verdict"] == "correct"), None)
        if c:
            href = 2 * math.degrees(math.atan(math.tan(math.radians(c["pose"]["vfov"]) / 2) * r["aspect"]))
            e_ref.append(pred - href)
        (e_man_known if r["focal_known"] else e_man_unknown).append(pred - r["hfov0"])
    f = lambda a: {"n": len(a), "median_err": float(np.median(a)), "median_abs": float(np.median(np.abs(a))),  # noqa: E731
                   "within5deg": int(np.sum(np.abs(a) <= 5)), "within10pct_rel": None}
    fov[m] = {"vs_correct_ref": f(e_ref), "vs_manifest_focal_known": f(e_man_known), "vs_manifest_focal_unknown": f(e_man_unknown)}
    rel = [abs(e) / h for e, h in zip(e_ref, [0] * 0)] if False else None
out["fov"] = fov
# manifest vs ref (baseline for comparison)
e = []
for p, r in R.items():
    c = next((x for x in r["refs"] if x["verdict"] == "correct"), None)
    if c and r["focal_known"]:
        href = 2 * math.degrees(math.atan(math.tan(math.radians(c["pose"]["vfov"]) / 2) * r["aspect"]))
        e.append(r["hfov0"] - href)
out["fov_manifest_known_vs_ref"] = {"n": len(e), "median_abs": float(np.median(np.abs(e))) if e else None}
# pano self-check
pv = [x["pano_vs_render"] for r in R.values() for x in r["refs"] if x.get("pano_vs_render")]
out["pano_check"] = {"n_refs_at_stated_eye": len(pv),
                     "median_medAbsLogD": float(np.median([x["medAbsLogD"] for x in pv if x["medAbsLogD"] is not None])),
                     "median_skyAgree": float(np.median([x["skyAgree"] for x in pv])),
                     "min_skyAgree": float(np.min([x["skyAgree"] for x in pv])),
                     "median_ref_cover": float(np.median([x["pano_cover"] for r in R.values() for x in r["refs"]]))}
# runtimes
t = [json.loads(l) for l in open(_env.HERE / "timing_mps.jsonl")]
rt = {}
for m in ("moge_l", "moge_b", "da3_b"):
    s = [x["s"] for x in t if x["model"] == m][1:]  # drop warm-up
    rt[m] = {"mps_median_s": float(np.median(s)), "mps_p90_s": float(np.percentile(s, 90))}
rt["cpu_note"] = "CPU fp32, 3 photos, load avg ~8-14: moge_l 9.7-11.5 s, moge_b 5.7-7.1 s, da3_b 11.3-15.2 s"
rt["eval_s_per_photo_median"] = float(np.median([r["eval_s"] for r in R.values()]))
out["runtime"] = rt
json.dump(out, open(_env.HERE / "extras.json", "w"), indent=1)
print(json.dumps(out, indent=1))
