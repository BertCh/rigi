"""X3: photo-level metrics + markdown tables from evaluate.py output.

    python analyze.py results_prune.json [--ids ...] [--md tables_prune.md]

Definitions (fixed before the pruning results were looked at, except where marked post hoc in REPORT.md):
  base            the photo's first correct ref (the perturb base); photos without one are "no-correct" photos
  true support Sc inliers of the solve on the base-ref render if that solve lands < 2° from the base ref, else 0
  success         base-ref solve: inliers >= 30 and rot err < 2°
  wrong-basin W   max inliers over the photo's wrong-ref, perturb and ring renders of solves that land >= 3° from EVERY correct
                  ref (i.e. matches that support a pose other than a verified one). Solves that return to the true
                  pose from an offset/wrong render do not count against the matcher.
  D               log2((Sc + 1) / (W + 1)); "separated" = Sc >= 30 and Sc >= 2 W
  cons6           lifted matches within 6 px of the rendered view's OWN pose (no solve); pose sharpness:
                  cons6 at base vs max cons6 over wrong refs
  pull-back       share of wrong-ref / perturb solves that land < 1° from the base ref (basin of convergence)
  no-correct      photos without any correct ref: per photo, max inliers of wrong-ref solves that stay < 2° from that
                  wrong ref (support for a known-wrong pose; lower is better, but only meaningful next to Sc);
                  ringNearWrong = max inliers of ring solves landing < 3° from a wrong ref
  ring (sweep)    12 ring views (30° step, hfov 40°, pitch 0, default eye): ringTrue = best ring solve landing < 2° of
                  the base ref; ringWrong = best ring solve landing >= 3°; ringTop1 = the max-inlier ring solve is true
                  and has >= 30 inliers; ringSep = ringTrue >= 30 and >= 2 ringWrong
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent


def tagset(t):
    s = []
    if (t.get("season") or "") == "winter" or "snow" in str(t.get("season", "")):
        s.append("winter")
    if "haz" in str(t.get("weather", "")).lower():
        s.append("haze")
    if str(t.get("skylineDist", "")).startswith("near") or t.get("foreground"):
        s.append("near")
    return s


D2R = math.pi / 180


def _R(p):
    y, pt, r = p["yaw"] * D2R, p["pitch"] * D2R, p["roll"] * D2R
    f = np.array([math.sin(y) * math.cos(pt), math.cos(y) * math.cos(pt), math.sin(pt)])
    r0 = np.array([math.cos(y), -math.sin(y), 0.0])
    u0 = np.cross(r0, f)
    right = r0 * math.cos(r) - u0 * math.sin(r)
    up = u0 * math.cos(r) + r0 * math.sin(r)
    return np.stack([right, -up, f])


def rot_err(p, q):
    R = _R(p) @ _R(q).T
    return math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(R) - 1) / 2))))


WRONG_DEG = 3.0  # a solve >= 3° from the base ref supports a wrong pose (2-3° = ambiguous, counted as neither)
TRUE_DEG = 2.0


def photo_metrics(views: dict, info: dict, groups=("refs", "perturb", "ring")) -> dict:
    views = {k: r for k, r in views.items() if k.split("/")[0] in groups}
    base = info["base"]
    out = {}
    ms = [r["ms"] for r in views.values() if "ms" in r]
    out["msMed"] = float(np.median(ms)) if ms else None
    ring = {k: r for k, r in views.items() if k.startswith("ring/")}
    if base:
        b = views.get(f"refs/{base}")
        if b is None:
            return out
        err = b.get("errRef")
        out.update({"inl": b["inliers"], "lifted": b["lifted"], "inlFrac": b["inlFrac"], "err": err,
                    "inlAtRef6": b.get("inlAtRef6", 0), "cons6": b["cons6"],
                    "success": bool(b["inliers"] >= 30 and err is not None and err < TRUE_DEG)})
        sc = b["inliers"] if (err is not None and err < TRUE_DEG) else 0
        out["ScFrac"] = b["inlFrac"] if sc else 0.0
        W, Wref, Wring, pull, n_off, cw = 0, 0, 0, 0, 0, 0
        for k, r in views.items():
            grp, tag = k.split("/")
            if grp == "refs" and tag in info["correct"]:
                continue
            e = r.get("errRef")
            if e is not None and r.get("pose") and len(info["correct"]) > 1 and "poses" in info:
                # distance to the NEAREST correct ref (photos with several verified-correct refs)
                e = min(rot_err(r["pose"], info["poses"][lab]) for lab in info["correct"])
            if grp != "ring":
                n_off += 1
                pull += bool(e is not None and e < 1)
            if e is not None and e >= WRONG_DEG:
                W = max(W, r["inliers"])
                if grp == "refs":
                    Wref = max(Wref, r["inliers"])
                if grp == "ring":
                    Wring = max(Wring, r["inliers"])
            if grp == "refs":
                cw = max(cw, r["cons6"])
        out.update({"Sc": sc, "W": W, "Wref": Wref, "Wring": Wring, "D": math.log2((sc + 1) / (W + 1)),
                    "separated": bool(sc >= 30 and sc >= 2 * W), "pull": pull / n_off if n_off else None,
                    "consW": cw, "consRatio": math.log2((b["cons6"] + 1) / (cw + 1)) if info["wrong"] else None})
        if ring:
            tr = max([r["inliers"] for r in ring.values() if r.get("errRef") is not None and r["errRef"] < TRUE_DEG], default=0)
            top = max(ring.values(), key=lambda r: r["inliers"])
            out.update({"ringTrue": tr, "ringWrong": Wring,
                        "ringTop1": bool(top["inliers"] >= 30 and top.get("errRef") is not None and top["errRef"] < TRUE_DEG),
                        "ringD": math.log2((tr + 1) / (Wring + 1)),
                        "ringSep": bool(tr >= 30 and tr >= 2 * Wring)})
        pert = {}
        for k, r in views.items():
            if k.startswith("perturb/"):
                pert[k.split("/")[1]] = {"inlRel": r["inliers"] / max(1, b["inliers"]), "cons6": r["cons6"],
                                         "errRef": r.get("errRef")}
        out["perturb"] = pert
    else:
        wp = [info["poses"][lab] for lab in info["wrong"]] if "poses" in info else []
        w, wf = 0, 0.0
        for k, r in views.items():
            if k.startswith("refs/") and r.get("errView") is not None and r["errView"] < TRUE_DEG:
                if r["inliers"] > w:
                    w, wf = r["inliers"], r["inlFrac"]
        out["wrongStay"] = w
        out["wrongStayFrac"] = wf
        if ring:
            near = [r["inliers"] for r in ring.values() if r.get("pose") and wp and min(rot_err(r["pose"], q) for q in wp) < WRONG_DEG]
            out["ringNearWrong"] = max(near, default=0)
            out["ringMax"] = max(r["inliers"] for r in ring.values())
    return out


def auc(pos, neg):
    """P(pos > neg) + 0.5 P(tie) (Mann-Whitney)."""
    if not pos or not neg:
        return float("nan")
    p = np.asarray(pos, float)[:, None]
    n = np.asarray(neg, float)[None, :]
    return float(((p > n).sum() + 0.5 * (p == n).sum()) / (p.size * n.size))


def med(x):
    x = [v for v in x if v is not None]
    return float(np.median(x)) if x else float("nan")


PRUNE_VIEWS = lambda k: k.startswith("refs/") or k in ("perturb/yaw-8", "perturb/yaw-2", "perturb/yaw+2", "perturb/yaw+8")  # noqa: E731


def summarise(res, ids=None, view_filter=None):
    rows = []
    for m, cfgs in res["views"].items():
        for cfg, per in cfgs.items():
            P = {pid: photo_metrics({k: r for k, r in v.items() if view_filter is None or view_filter(k)}, res["photos"][pid])
                 for pid, v in per.items() if not ids or pid in ids}
            cor = {p: x for p, x in P.items() if "inl" in x}
            noc = {p: x for p, x in P.items() if "wrongStay" in x}
            pert_rel = {t: med([x["perturb"].get(t, {}).get("inlRel") for x in cor.values()]) for t in ("yaw-2", "yaw+2", "yaw-8", "yaw+8")}
            rows.append({
                "matcher": m, "config": cfg, "nCorrect": len(cor), "nNoCorrect": len(noc),
                "success": sum(x["success"] for x in cor.values()),
                "medInl": med([x["inl"] for x in cor.values()]), "medFrac": med([x["inlFrac"] for x in cor.values()]),
                "medErr": med([x["err"] for x in cor.values()]),
                "medD": med([x["D"] for x in cor.values()]), "separated": sum(x["separated"] for x in cor.values()),
                "wBasin30": sum(x["W"] >= 30 for x in cor.values()), "medW": med([x["W"] for x in cor.values()]),
                "medConsRatio": med([x["consRatio"] for x in cor.values()]),
                "pull": med([x["pull"] for x in cor.values()]),
                "pert2": med([pert_rel["yaw-2"], pert_rel["yaw+2"]]), "pert8": med([pert_rel["yaw-8"], pert_rel["yaw+8"]]),
                "noCorrectStay30": sum(x["wrongStay"] >= 30 for x in noc.values()),
                "noCorrectStay100": sum(x["wrongStay"] >= 100 for x in noc.values()),
                "msMed": med([x["msMed"] for x in P.values()]),
                "aucInl": auc([x["Sc"] for x in cor.values()], [x["wrongStay"] for x in noc.values()]),
                "aucFrac": auc([x["ScFrac"] for x in cor.values()], [x["wrongStayFrac"] for x in noc.values()]),
                "tpr0fp": (sum(x["Sc"] > max([y["wrongStay"] for y in noc.values()], default=0) for x in cor.values())
                           if noc else float("nan")),
                "maxWrongStay": max([y["wrongStay"] for y in noc.values()], default=float("nan")),
                "nRing": sum("ringTrue" in x for x in cor.values()),
                "ringTop1": sum(x.get("ringTop1", False) for x in cor.values()),
                "ringSep": sum(x.get("ringSep", False) for x in cor.values()),
                "ringWrong30": sum(x.get("ringWrong", 0) >= 30 for x in cor.values()),
                "ringWrong100": sum(x.get("ringWrong", 0) >= 100 for x in cor.values()),
                "medRingD": med([x.get("ringD") for x in cor.values()]),
                "medRingTrue": med([x.get("ringTrue") for x in cor.values()]),
                "nocRingNearWrong30": sum(x.get("ringNearWrong", 0) >= 30 for x in noc.values()),
                "nocRingMax100": sum(x.get("ringMax", 0) >= 100 for x in noc.values()),
                "photos": P,
            })
    return rows


def md_table(rows, sort_key="separated"):
    rows = sorted(rows, key=lambda r: (-r[sort_key], -r["success"], -r["medD"]))
    h = ("| matcher | config | n | success (≥30 & <2°) | separated (Sc≥30 & Sc≥2W) | median D=log2((Sc+1)/(W+1)) | photos W≥30 | "
         "median inl | median inl frac | median err ° | median cons6 ratio (log2) | pull-back | inl@±2° / base | inl@±8° / base | "
         "no-correct: stay≥30 / ≥100 | max wrong-stay inl | AUC Sc vs wrong-stay (inl) | AUC (inl frac) | correct photos with Sc > max wrong-stay | ms/pair |")
    out = [h, "|" + "|".join(["---"] * (h.count("|") - 1)) + "|"]
    for r in rows:
        out.append(f"| {r['matcher']} | {r['config']} | {r['nCorrect']} | {r['success']} | {r['separated']} | {r['medD']:.2f} | "
                   f"{r['wBasin30']} | {r['medInl']:.0f} | {r['medFrac']:.2f} | {r['medErr']:.2f} | {r['medConsRatio']:.2f} | "
                   f"{r['pull']:.2f} | {r['pert2']:.2f} | {r['pert8']:.2f} | "
                   f"{r['noCorrectStay30']}/{r['noCorrectStay100']} (of {r['nNoCorrect']}) | {r['maxWrongStay']:.0f} | {r['aucInl']:.2f} | "
                   f"{r['aucFrac']:.2f} | {r['tpr0fp']} | {r['msMed']:.0f} |")
    return "\n".join(out)


def ring_table(rows):
    rows = [r for r in rows if r["nRing"]]
    rows = sorted(rows, key=lambda r: (-r["ringSep"], -r["ringTop1"], -r["medRingD"]))
    h = ("| matcher | config | n (correct) | ring top-1 true | ring separated (true≥30 & ≥2×wrong) | median ring D | "
         "photos wrong-ring ≥30 / ≥100 | median best true ring inl | no-correct: ring near wrong ref ≥30 | no-correct: ring max ≥100 |")
    out = [h, "|" + "|".join(["---"] * (h.count("|") - 1)) + "|"]
    for r in rows:
        out.append(f"| {r['matcher']} | {r['config']} | {r['nRing']} | {r['ringTop1']} | {r['ringSep']} | {r['medRingD']:.2f} | "
                   f"{r['ringWrong30']} / {r['ringWrong100']} | {r['medRingTrue']:.0f} | {r['nocRingNearWrong30']} (of {r['nNoCorrect']}) | "
                   f"{r['nocRingMax100']} |")
    return "\n".join(out)


def per_photo_table(rows, pids, combos):
    by = {(r["matcher"], r["config"]): r for r in rows}
    h = "| photo | " + " | ".join(f"{m}:{c} Sc / W" for m, c in combos) + " |"
    out = [h, "|" + "|".join(["---"] * (len(combos) + 1)) + "|"]
    for p in pids:
        cells = []
        for k in combos:
            x = by.get(k, {}).get("photos", {}).get(p)
            if not x:
                cells.append("–")
            elif "Sc" in x:
                cells.append(f"{x['Sc']} / {x['W']}" + ("" if x["success"] else " ✗"))
            else:
                cells.append(f"stay {x['wrongStay']}")
        out.append(f"| {p} | " + " | ".join(cells) + " |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("res")
    ap.add_argument("--ids", default=None)
    ap.add_argument("--md", default=None)
    ap.add_argument("--summary", default=None)
    ap.add_argument("--prune-views", action="store_true", help="only refs + perturb yaw±2/±8 (the pruning view set)")
    a = ap.parse_args()
    res = json.load(open(HERE / a.res))
    ids = set(a.ids.split(",")) if a.ids else None
    rows = summarise(res, ids, PRUNE_VIEWS if a.prune_views else None)
    t = md_table(rows)
    if any(r["nRing"] for r in rows):
        t += "\n\n" + ring_table(rows)
    print(t)
    if a.md:
        open(HERE / a.md, "w").write(t + "\n")
    if a.summary:
        json.dump(rows, open(HERE / a.summary, "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
