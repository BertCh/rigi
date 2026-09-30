"""E1 step 1: POOL + REF hypotheses, verified-correct poses V_p, mechanical labels, current-rule (CUR / CUR-all) HIGH poses.
No rendering, no statistic. -> hyps_pool.json"""
from __future__ import annotations

import json
from pathlib import Path

import e1lib as E
from e1lib import dang, eye_dist, same_pose, rot_far

import refs  # tools/matcher/v2/refs.py
import rule as R  # frozen T6 rule

V2OUT = E.ROOT / "tools/matcher/v2/out"


def rule_sha_ok():
    f = E.ROOT / "tools/bench/t6/RULE_FROZEN.sha1"
    want = f.read_text().split()[0] if f.exists() else None
    return {"sha1": R.rule_sha1(), "frozen": want, "match": want == R.rule_sha1()}


def rec_high(rec):
    """rule.py HIGH pose of one full-T6 record (or None)."""
    if not rec or not rec.get("candidates") or rec.get("error"):
        return None
    c = R.select(rec)
    if c is None:
        return None
    lvl, _ = R.confidence(rec, c)
    if lvl != "HIGH":
        return None
    f = c["fused"]
    return {"pose": {k: float(f["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")},
            "eye": {"lat": rec["lat"], "lon": rec["lon"], "h": float((f.get("eye") or rec["eye"])[2])}}


def cur_records(pid):
    """-> (CUR high list, CUR-all high list) with provenance."""
    cur, allh = [], []
    f = V2OUT / "dev/raw" / f"{pid}.json"
    if f.exists():
        for k, rec in json.load(open(f)).items():
            h = rec_high(rec)
            if h:
                h["src"] = f"v2dev:{k}"
                allh.append(h)
                if k == "stated":
                    cur.append(h)
    f = V2OUT / "dev_loma/raw" / f"{pid}.json"
    rec = json.load(open(f)).get("stated") if f.exists() else None
    if not rec or rec.get("error"):
        g = E.H1 / "runs/S1" / f"{pid}.json"
        rec = json.load(open(g)) if g.exists() else None
    h = rec_high(rec)
    if h:
        h["src"] = "dev_loma:stated"
        allh.append(h)
    g = E.H1 / "runs/S5" / f"{pid}.json"
    if g.exists():
        h = rec_high(json.load(open(g)))
        if h:
            h["src"] = "h1:S5"
            allh.append(h)
    g = E.H1 / "runs/S3a" / f"{pid}.json"
    if g.exists():
        for k, rec in (json.load(open(g)).get("eyeRecs") or {}).items():
            h = rec_high(rec)
            if h:
                h["src"] = f"h1:S3a:{k}"
                allh.append(h)
    return cur, allh


def main():
    man = E.manifest()
    pool = json.load(open(E.H1 / "pool.json"))
    out = {"ruleSha": rule_sha_ok(), "photos": {}}
    for pid in E.analysed():
        E.tm_common.assert_dev(pid)
        e = man[pid]
        zs = E.stated_z(pid)
        # verified-correct poses V_p
        V = [{"pose": r["pose"], "eye": {"lat": e["lat"], "lon": e["lon"], "h": float(r["eyeH"])}, "from": f"refs:{r['label']}"}
             for r in refs.correct_refs(pid)]
        pc = [c for c in pool if c["pid"] == pid]
        for c in pc:
            inh = c.get("inherit") or {}
            if inh.get("verdict") == "correct" and not any(same_pose(c["pose"], v["pose"]) and eye_dist(c["eye"], v["eye"]) <= 2 for v in V):
                V.append({"pose": c["pose"], "eye": c["eye"], "from": f"h1inherit:{c['cid']}:{inh.get('from')}"})
        hyps = []
        for c in pc:
            cs = (c.get("common") or {}).get("corrSingle")
            if not cs:
                continue
            h = {"hid": c["cid"], "kind": "POOL", "pose": c["pose"], "eye": c["eye"], "corr": str(E.H1 / cs),
                 "status": c["status"], "sources": c["sources"], "common_inl": c.get("common_inl"),
                 "nativeFusedMax": c.get("nativeFusedMax"), "inherit": c.get("inherit"), "eyeDisplacementM": c.get("eyeDisplacementM")}
            hyps.append(h)
        # REF hypotheses to render
        need = []
        for r in refs.correct_refs(pid):
            ve = {"lat": e["lat"], "lon": e["lon"], "h": float(r["eyeH"])}
            if not any(same_pose(h["pose"], r["pose"]) and eye_dist(h["eye"], ve) <= 2 for h in hyps):
                need.append({"hid": f"{pid}_ref{r['label']}", "kind": "REF", "pose": {k: float(r["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")},
                             "eye": ve, "pageAlt": "manifest" if abs(r["eyeH"] - zs) <= 0.05 else round(float(r["eyeH"]), 2)})
        # labels for POOL / REF
        for h in hyps + need:
            h["label"], h["labelWhy"] = label(h, V)
        cur, allh = cur_records(pid)
        out["photos"][pid] = {"pid": pid, "Pref": pid not in E.P_LAB, "positionSource": e.get("positionSource"),
                              "stated": {"lat": e["lat"], "lon": e["lon"], "h": zs}, "V": V, "hyps": hyps, "refsToRender": need,
                              "CUR": cur, "CURall": allh}
    E.jdump(out, E.HERE / "hyps_pool.json")
    # summary
    import collections
    cnt = collections.Counter()
    for p in out["photos"].values():
        for h in p["hyps"] + p["refsToRender"]:
            cnt[(h["kind"], h["label"])] += 1
    print("rule", out["ruleSha"])
    for k, v in sorted(cnt.items()):
        print(k, v)
    print("refs to render", sum(len(p["refsToRender"]) for p in out["photos"].values()))
    print("CUR highs", sum(len(p["CUR"]) for p in out["photos"].values()), "CUR-all highs", sum(len(p["CURall"]) for p in out["photos"].values()))


def label(h, V):
    inh = h.get("inherit") or {}
    if any(same_pose(h["pose"], v["pose"]) and eye_dist(h["eye"], v["eye"]) <= 2 for v in V):
        return "POS", "within 0.5deg/2m of a verified-correct pose"
    if inh.get("verdict") == "wrong":
        if any(eye_dist(h["eye"], v["eye"]) <= 2 for v in V):
            return "NB-inh", f"inherited wrong {inh.get('from')}, eye within 2 m of a correct pose"
        return "NE-inh", f"inherited wrong {inh.get('from')}, no verified-correct pose at its eye"
    same = [v for v in V if eye_dist(h["eye"], v["eye"]) <= 2]
    if h["kind"] == "POOL" and same and all(rot_far(h["pose"], v["pose"]) for v in same):
        hard = (h.get("common_inl") or 0) >= 100 or (h.get("nativeFusedMax") or 0) >= 100
        return "NB-con", ("hard" if hard else "easy") + (";S5" if "S5" in (h.get("sources") or []) else "")
    if h.get("status") == "blind":
        return "UNL", "H1 blind-to-verify"
    return "UNL", "no mechanical label"


if __name__ == "__main__":
    main()
