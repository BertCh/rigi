"""H1 pool (PROTOCOL.txt POOL RULE): keep / inherit / wrong-by-construction / cap -> pool.json (+ runs/kept_cids.json)."""
from __future__ import annotations

import collections
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tm_common  # noqa: E402
import refs  # noqa: E402  (tools/matcher/v2/refs.py, via tm_common's sys.path)

ROOT = tm_common.ROOT
RUNS = HERE / "runs"
MAN = {e["id"]: e for e in json.load(open(ROOT / "tools/bench/data/manifest.json"))}
VERIFY = ROOT / "tools/matcher/v2/verify"
DEG = math.pi / 180


def dang(a, b):
    return (a - b + 540.0) % 360.0 - 180.0


def enu(lat0, lon0, lat, lon):
    R = 6371008.8
    return ((lon - lon0) * DEG * R * math.cos(lat0 * DEG), (lat - lat0) * DEG * R)


def eye_d(a, b):
    e, n = enu(a["lat"], a["lon"], b["lat"], b["lon"])
    if a.get("h") is None or b.get("h") is None:
        return math.hypot(e, n) if (a.get("h") is None and b.get("h") is None) else float("inf")
    return math.sqrt(e * e + n * n + (a["h"] - b["h"]) ** 2)


def stated_eye(pid):
    z = json.load(open(tm_common.CACHE / pid / "meta.json"))["eye"][2]
    return {"lat": MAN[pid]["lat"], "lon": MAN[pid]["lon"], "h": float(z)}


def verdicts(pid):
    """Existing blind verdicts (correct / wrong only) with their eyes."""
    out = []
    for r in refs.correct_refs(pid) + refs.wrong_refs(pid):
        out.append({"src": f"refs:{r['label']}", "verdict": r["verdict"], "pose": r["pose"],
                    "eye": {"lat": MAN[pid]["lat"], "lon": MAN[pid]["lon"], "h": float(r["eyeH"])}})
    vj = json.load(open(VERIFY / "verdicts.json"))
    for i, v in enumerate(vj.get(pid, [])):
        if v["verdict"] in ("correct", "wrong"):
            out.append({"src": f"v2verify:{i}", "verdict": v["verdict"], "pose": v["pose"], "eye": v["eye"]})
    # round-1/2 stated-eye pose of wc_0086 (T8 / D4): every verifier said wrong
    if pid == "wc_0086":
        k = json.load(open(VERIFY / "key.json"))["candidates"]["T8"]
        out.append({"src": "v2verify:T8/D4", "verdict": "wrong", "pose": k["pose"], "eye": k["eye"]})
    return out


def main():
    rows = {r["rid"]: r for r in json.load(open(RUNS / "candidates_raw.json"))}
    clusters = json.load(open(RUNS / "clusters.json"))
    common = {}
    for f in (RUNS / "common").glob("wc_*.json"):
        for k, v in json.load(open(f)).items():
            common[(f.stem, k)] = v
    replay = {}
    for f in (RUNS / "replay").glob("wc_*.json"):
        replay.update(json.load(open(f)))
    pool = []
    for c in clusters:
        pid = c["pid"]
        cm = common.get((pid, c["key"])) if c["screen"] else None
        ms = [rows[m] for m in c["members"]]
        e = dict(c["eye"])
        if e["h"] is None and cm and cm.get("eyeAchieved"):
            e["h"] = cm["eyeAchieved"][2]
        st = stated_eye(pid)
        rec = {"pid": pid, "cid": c["cid"], "sources": c["sources"], "pose": c["pose"], "eye": e,
               "eyeDisplacementM": round(eye_d(e, st), 2) if e["h"] is not None else None,
               "common_inl": cm.get("common_inl") if cm else None,
               "common": ({k: v for k, v in cm.items() if k not in ("cid",)} if cm else None),
               "nativeFusedMax": c["nativeFusedMax"],
               "native": [{"src": m["src"], "detail": m["detail"], "kind": m["kind"], "matcher": m["matcher"], "pose": m["pose"],
                           "eyeH": m["eye"]["h"], **m["native"], **({"stage1Source": m["stage1Source"]} if m.get("stage1Source") else {}),
                           **({"corrFused": m["corrFused"]} if m.get("corrFused") else {}),
                           **({"pilot": m["pilot"]} if m.get("pilot") else {})} for m in ms],
               "corrFused": next((m["corrFused"] for m in ms if m.get("corrFused")), None) or (replay.get(c["cid"]) or {}).get("corrFused"),
               "corrSingle": cm.get("corrSingle") if cm else None,
               "replay": replay.get(c["cid"]),
               "screened": c["screen"], "inherit": None, "label": None, "status": None}
        if not c["screen"]:
            rec["status"] = "not-screened"
        elif cm is None or cm.get("error"):
            rec["status"] = "score-failed" if cm else "not-scored"
        pool.append(rec)
    # keep rule
    for r in pool:
        if r["status"]:
            # unscored candidates can still qualify on native T6 fused support
            if (r["nativeFusedMax"] or 0) >= 100:
                r["keep"] = True
            else:
                r["keep"] = False
                continue
        r["keep"] = (r["common_inl"] or 0) >= 100 or (r["nativeFusedMax"] or 0) >= 100
        if not r["keep"]:
            r["status"] = "below-threshold"
    # inherit / construct
    by_pid = collections.defaultdict(list)
    for r in pool:
        by_pid[r["pid"]].append(r)
    for pid, rs in by_pid.items():
        vs = verdicts(pid)
        corr_refs = [v for v in vs if v["verdict"] == "correct"]
        for r in rs:
            if not r["keep"] or r["eye"]["h"] is None:
                continue
            hit = [v for v in vs if abs(dang(r["pose"]["yaw"], v["pose"]["yaw"])) <= 0.5 and abs(r["pose"]["pitch"] - v["pose"]["pitch"]) <= 0.5
                   and eye_d(r["eye"], v["eye"]) <= 2.0]
            if hit:
                vv = {h["verdict"] for h in hit}
                r["inherit"] = {"verdict": hit[0]["verdict"] if len(vv) == 1 else "conflict", "from": [h["src"] for h in hit]}
                r["status"] = "inherited"
                continue
            near = [v for v in corr_refs if eye_d(r["eye"], v["eye"]) <= 2.0]
            if near and all(abs(dang(r["pose"]["yaw"], v["pose"]["yaw"])) > 3 or abs(r["pose"]["pitch"] - v["pose"]["pitch"]) > 3 for v in near):
                r["label"] = "wrong-construct"
                r["status"] = "wrong-construct"
                r["constructFrom"] = [v["src"] for v in near]
        # cap (new = kept, not inherited, not construct); pilot (S4-only) separately
        for pilot, cap in ((False, 6), (True, 3)):
            cand = [r for r in rs if r["keep"] and r["status"] is None and ((r["sources"] == ["S4"]) == pilot)]
            cand.sort(key=lambda r: (-(r["common_inl"] or 0), -(r["nativeFusedMax"] or 0), r["cid"]))
            kept = []
            for r in cand:
                if pilot:
                    r["label"] = "pilot"
                sup = next((k for k in kept if abs(dang(k["pose"]["yaw"], r["pose"]["yaw"])) <= 3.0 and eye_d(k["eye"], r["eye"]) <= 2.0), None)
                if sup is not None:
                    r["status"], r["capReason"] = "capped", f"nms<{sup['cid']}"
                    continue
                if len(kept) >= cap:
                    r["status"], r["capReason"] = "capped", "per-photo cap"
                    continue
                kept.append(r)
                r["status"] = "blind"
    json.dump(pool, open(HERE / "pool.json", "w"), indent=1)
    json.dump(sorted(r["cid"] for r in pool if r["keep"]), open(RUNS / "kept_cids.json", "w"))
    cnt = collections.Counter((r["status"], r["label"]) for r in pool)
    print(len(pool), "candidates;", dict(cnt))
    print("kept", sum(r["keep"] for r in pool), "blind", sum(r["status"] == "blind" for r in pool))


if __name__ == "__main__":
    main()
