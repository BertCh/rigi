"""X3: final tables (markdown) from an evaluate.py results json.

    python report_tables.py results_final.json --combos aliked:sat,loma:sat,... > tables_final.md
Subsets: haze = dev_verdicts photoTags 'fog-haze'; winter = manifest season 'winter'; near = skylineDist 'near';
tele = focalClass 'tele'.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import analyze as A  # noqa: E402

ROOT = HERE.parents[3]
VERD = json.load(open(ROOT / "tools/bench/gt/t6/dev_verdicts.json"))["photos"]


def subsets(pid, info):
    t = info["tags"]
    s = []
    if "fog-haze" in (VERD.get(pid, {}).get("photoTags") or []):
        s.append("haze")
    if t.get("season") == "winter":
        s.append("winter")
    if t.get("skylineDist") == "near":
        s.append("near")
    if t.get("focalClass") == "tele":
        s.append("tele")
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("res")
    ap.add_argument("--combos", required=True)
    a = ap.parse_args()
    res = json.load(open(HERE / a.res))
    combos = [tuple(c.split(":")) for c in a.combos.split(",")]
    rows = {(r["matcher"], r["config"]): r for r in A.summarise(res)}
    sel = [rows[c] for c in combos if c in rows]
    print("## Main table (all dev photos)\n")
    print(A.md_table(sel))
    print("\n" + A.ring_table(sel))
    # subsets
    print("\n## Subsets (photos with a correct ref): success / separated-from-known-wrong (Sc > max wrong-stay of ALL no-correct photos) / median Sc\n")
    names = ["all", "haze", "winter", "near", "tele"]
    h = "| combo | " + " | ".join(names) + " |"
    print(h)
    print("|" + "|".join(["---"] * (len(names) + 1)) + "|")
    for r in sel:
        P = r["photos"]
        noc_max = r["maxWrongStay"]
        cells = []
        for nm in names:
            ids = [p for p, x in P.items() if "Sc" in x and (nm == "all" or nm in subsets(p, res["photos"][p]))]
            if not ids:
                cells.append("–")
                continue
            su = sum(P[p]["success"] for p in ids)
            sp = sum(P[p]["Sc"] > noc_max for p in ids)
            cells.append(f"{su}/{len(ids)} · {sp} · {np.median([P[p]['Sc'] for p in ids]):.0f}")
        print(f"| {r['matcher']}:{r['config']} | " + " | ".join(cells) + " |")
    # perturb curve
    print("\n## Perturbation response (median over photos with a correct ref; solved inliers relative to the base-ref solve / "
          "share of solves returning < 1° of the ref / median cons6 at the rendered offset pose)\n")
    offs = ["yaw-8", "yaw-4", "yaw-2", "yaw-1", "yaw+1", "yaw+2", "yaw+4", "yaw+8", "pitch-2", "pitch-1", "pitch+1", "pitch+2"]
    print("| combo | " + " | ".join(offs) + " |")
    print("|" + "|".join(["---"] * (len(offs) + 1)) + "|")
    for r in sel:
        cells = []
        for o in offs:
            vals = [x["perturb"][o] for x in r["photos"].values() if "perturb" in x and o in x["perturb"]]
            if not vals:
                cells.append("–")
                continue
            rel = np.median([v["inlRel"] for v in vals])
            back = np.mean([v["errRef"] is not None and v["errRef"] < 1 for v in vals])
            c6 = np.median([v["cons6"] for v in vals])
            cells.append(f"{rel:.2f} / {back:.2f} / {c6:.0f}")
        print(f"| {r['matcher']}:{r['config']} | " + " | ".join(cells) + " |")
    # per photo
    print("\n## Per photo: correct-ref photos Sc (base-ref inliers if < 2°, ✗ = not success) / W (max inliers of any solve ≥ 3° "
          "from the ref: wrong refs, perturb, ring); no-correct photos: max inliers of a wrong-ref solve that stays < 2° on the wrong ref\n")
    pids = sorted(res["photos"])
    print("| photo | subsets | " + " | ".join(f"{m}:{c}" for m, c in combos) + " |")
    print("|" + "|".join(["---"] * (len(combos) + 2)) + "|")
    for p in pids:
        cells = []
        for c in combos:
            x = rows.get(c, {}).get("photos", {}).get(p)
            if not x:
                cells.append("–")
            elif "Sc" in x:
                cells.append(f"{x['Sc']} / {x['W']}" + ("" if x["success"] else " ✗"))
            else:
                cells.append(f"wrong {x['wrongStay']}")
        print(f"| {p} | {','.join(subsets(p, res['photos'][p]))} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
