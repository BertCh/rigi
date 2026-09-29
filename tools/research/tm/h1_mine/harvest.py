"""H1: collect every candidate pose (S0 harvest, S1 dev_loma, S2/S5/S3/S4 runs) into runs/candidates_raw.json.
No rendering / matching here. One row per scored pose with its native support numbers and provenance."""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tm_common  # noqa: E402

ROOT = tm_common.ROOT
V2OUT = ROOT / "tools/matcher/v2/out"
MAN = {e["id"]: e for e in json.load(open(ROOT / "tools/bench/data/manifest.json"))}
DEV = sorted(tm_common.dev_ids())
RUNS = HERE / "runs"


def p4(p):
    return {k: float(p[k]) for k in ("yaw", "pitch", "roll", "vfov")}


def t6_rows(pid, rec, src, detail, matcher, eye_latlon=None):
    """Rows from one T6 record (stage1.pipeline.run_photo): verified candidates (fused) + unverified stage-1 hyps."""
    rows = []
    if not rec or not rec.get("candidates"):
        return rows
    lat, lon = eye_latlon or (rec["lat"], rec["lon"])
    ez = float(rec["eye"][2]) if rec.get("eye") else None
    for i, c in enumerate(rec["candidates"]):
        f = c.get("fused")
        base = {"pid": pid, "src": src, "detail": f"{detail}#c{i}", "matcher": matcher, "stage1Source": c.get("source"),
                "alsoFrom": c.get("alsoFrom"), "stage1Inliers": c.get("inliers"), "stage1Pose": p4(c["pose"])}
        if f and f.get("pose"):
            ch = f.get("checks") or {}
            bg = f.get("basinGap")
            rows.append({**base, "kind": "fused", "pose": p4(f["pose"]),
                         "eye": {"lat": lat, "lon": lon, "h": float(f["eye"][2]) if f.get("eye") else ez},
                         "prior": p4(c["pose"]), "corrFused": c.get("corrFused"),
                         "native": {"fusedInliers": f.get("inliers"), "fusedLevel": f.get("level"), "fusedInlierFrac": f.get("inlierFrac"),
                                    "nLifted": f.get("nLifted"), "matchSupport": ch.get("matchSupport"), "cueAgreeDeg": ch.get("cueAgreeDeg"),
                                    "skylineMedPx": ch.get("skylineMedPx"), "skyScore": f.get("skyScore"), "sweepSup": f.get("sweepSup"),
                                    "basinGap": bg.get("gap") if isinstance(bg, dict) else None, "fusionScore": f.get("fusionScore")}})
        elif f is None and not c.get("error"):
            # stage-1 hypothesis never verified (beyond MAX_VERIFY)
            rows.append({**base, "kind": "stage1", "pose": p4(c["pose"]), "eye": {"lat": lat, "lon": lon, "h": ez},
                         "native": {"stage1Inliers": c.get("inliers"), "skyScore0": c.get("skyScore0"), "appScore": c.get("appScore")}})
    return rows


def main():
    rows = []
    # ---- S0a: v2 ALIKED records (stated T6 + moved-eye T6)
    for pid in DEV:
        f = V2OUT / "dev/raw" / f"{pid}.json"
        if not f.exists():
            continue
        recs = json.load(open(f))
        for k, r in recs.items():
            if k == "stated":
                rows += t6_rows(pid, r, "S0", "v2dev:stated", "aliked")
            else:
                rows += t6_rows(pid, r, "S0", f"v2dev:{k}", "aliked")
    # ---- S0b: X3 single-view solves (ring + refs renders at their cached eyes)
    x3 = json.load(open(ROOT / "tools/research/tm/x3_modality/results_final.json"))["views"]
    for m in ("loma", "aliked"):
        for pid, vs in x3[m]["sat"].items():
            if pid not in MAN:
                continue
            meta = json.load(open(tm_common.CACHE / pid / "meta.json"))
            eyes = {f"refs/{v['tag']}": v["eye"] for v in meta["views"]["refs"]}
            for tag, v in vs.items():
                if not v.get("pose"):
                    continue
                ez = (eyes.get(tag) or meta["eye"])[2]
                rows.append({"pid": pid, "src": "S0", "detail": f"x3:{m}:sat:{tag}", "matcher": m, "kind": "solve",
                             "pose": p4(v["pose"]), "eye": {"lat": MAN[pid]["lat"], "lon": MAN[pid]["lon"], "h": float(ez)},
                             "native": {"solveInliers": v.get("inliers"), "inlFrac": v.get("inlFrac")}})
    # ---- S0c: v2 eyeprobe cache (ALIKED fine sweep at viewpoint candidates)
    for f in sorted((ROOT / "tools/matcher/v2/.cache/eyeprobe").glob("*.json")):
        r = json.load(open(f))
        pid = r["id"]
        if pid not in MAN:
            continue
        for c in r["cands"]:
            for j, h in enumerate(c.get("hyps") or []):
                rows.append({"pid": pid, "src": "S0", "detail": f"eyeprobe:{c['why']}:{round(c['e'])},{round(c['n'])}#h{j}", "matcher": "aliked",
                             "kind": "probe", "pose": p4(h["pose"]),
                             "eye": {"lat": c["lat"], "lon": c["lon"], "h": float(c["eye"][2]) if c.get("eye") else None},
                             "native": {"windowInliers": h.get("inliers")}})
    # ---- S1: T6+LoMa stated (dev_loma)
    for pid in DEV:
        f = V2OUT / "dev_loma/raw" / f"{pid}.json"
        rec = json.load(open(f))["stated"] if f.exists() else None
        if rec and not rec.get("error"):
            rows += t6_rows(pid, rec, "S1", "dev_loma:stated", "loma")
        elif (RUNS / "S1" / f"{pid}.json").exists():  # dev_loma record failed -> h1 re-run (same path)
            rows += t6_rows(pid, json.load(open(RUNS / "S1" / f"{pid}.json")), "S1", "h1rerun:stated", "loma")
    # ---- S2
    for f in sorted((RUNS / "S2").glob("wc_*.json")):
        r = json.load(open(f))
        for i, c in enumerate(r.get("candidates") or []):
            fz = c.get("fused")
            if not fz or not fz.get("pose"):
                continue
            ch = fz.get("checks") or {}
            rows.append({"pid": r["id"], "src": "S2", "detail": f"x1feat#r{c.get('rank')}", "matcher": "loma", "kind": "fused",
                         "pose": p4(fz["pose"]), "eye": {"lat": r["lat"], "lon": r["lon"], "h": float(fz["eye"][2])},
                         "prior": p4(c["pose"]), "corrFused": c.get("corrFused"), "stage1Source": "x1feat", "stage1Pose": p4(c["pose"]),
                         "native": {"fusedInliers": fz.get("inliers"), "fusedLevel": fz.get("level"), "fusedInlierFrac": fz.get("inlierFrac"),
                                    "nLifted": fz.get("nLifted"), "matchSupport": ch.get("matchSupport"), "cueAgreeDeg": ch.get("cueAgreeDeg"),
                                    "skylineMedPx": ch.get("skylineMedPx"), "x1score": c.get("x1score")}})
    # ---- S5
    for f in sorted((RUNS / "S5").glob("wc_*.json")):
        r = json.load(open(f))
        if r.get("skip"):
            continue
        rows += t6_rows(r["id"], r, "S5", "masked", "loma")
    # ---- S3 (probe hyps + full T6 at eyes)
    for st in ("S3a", "S3b"):
        for f in sorted((RUNS / st).glob("wc_*.json")):
            r = json.load(open(f))
            pid = r["id"]
            for p in r.get("probes") or []:
                for j, h in enumerate(p.get("hyps") or []):
                    rows.append({"pid": pid, "src": "S3", "detail": f"probe:{p['why']}:{round(p['e'])},{round(p['n'])}#h{j}", "matcher": "loma",
                                 "kind": "probe", "pose": p4(h["pose"]), "eye": {"lat": p["lat"], "lon": p["lon"], "h": None},
                                 "native": {"windowInliers": h.get("inliers"), "eyeBest": p.get("best")}})
            for k, rk in (r.get("eyeRecs") or {}).items():
                rows += t6_rows(pid, rk, "S3", f"{st}:eye:{k}", "loma", eye_latlon=(rk["lat"], rk["lon"]))
    # ---- S4 pilot
    for f in sorted((RUNS / "S4").glob("wc_*.json")):
        r = json.load(open(f))
        pid = r["id"]
        for ey in r.get("eyes") or []:
            for i, c in enumerate(ey.get("candidates") or []):
                fz = c.get("fused")
                if not fz or not fz.get("pose"):
                    continue
                ch = fz.get("checks") or {}
                rows.append({"pid": pid, "src": "S4", "detail": f"displaced:{ey['why']}#c{i}", "matcher": "loma", "kind": "fused",
                             "pose": p4(fz["pose"]), "eye": {"lat": ey["lat"], "lon": ey["lon"], "h": float(fz["eye"][2])},
                             "prior": p4(c["pose"]), "corrFused": c.get("corrFused"), "stage1Source": "sweepfine", "stage1Pose": p4(c["pose"]),
                             "pilot": {"why": ey["why"], "dist": ey.get("dist"), "osm": ey.get("osm")}, "pageAlt": round(ey["h"], 2),
                             "native": {"fusedInliers": fz.get("inliers"), "fusedLevel": fz.get("level"), "fusedInlierFrac": fz.get("inlierFrac"),
                                        "nLifted": fz.get("nLifted"), "matchSupport": ch.get("matchSupport"), "stage1Inliers": c.get("inliers")}})
    for i, r in enumerate(rows):
        assert r["pid"] in MAN and r["pid"] in DEV
        r["rid"] = i
    json.dump(rows, open(RUNS / "candidates_raw.json", "w"), indent=0)
    import collections
    print(len(rows), collections.Counter((r["src"], r["kind"]) for r in rows))


if __name__ == "__main__":
    main()
