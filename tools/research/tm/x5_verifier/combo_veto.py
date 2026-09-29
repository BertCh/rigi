"""X5 (post hoc, labelled): OR-veto of the parallax check (pnp_rel, X5) and X2's mono-geometry score (EXTERNAL) on top of
positive evidence. Each threshold is LOPO: for photo p, tau = extreme value over OTHER photos' correct refs in the
population (so a correct ref is lost only if it is more extreme than every other photo's correct ref).

    python combo_veto.py -> combo_veto.json + printed table
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import evaluate as E

HERE = Path(__file__).resolve().parent
R = json.load(open(HERE / "features_ext.json"))
HIGHS = E.v2_highs()

# name -> (feature, direction: +1 veto if value > tau (tau = max over correct), -1 veto if value < tau (min over correct))
VETOES = {"pnp_rel": ("pnp_rel", +1), "pnp_rel10": ("pnp_rel10", +1), "pnp_up_abs": ("pnp_up_abs", +1),
          "x2": ("ext_x2_combo_int_z", -1)}
COMBOS = {"pnp_rel": ["pnp_rel"], "x2 (ext)": ["x2"], "pnp_rel OR x2": ["pnp_rel", "x2"],
          "pnp_rel10 OR x2": ["pnp_rel10", "x2"], "pnp_up_abs OR x2": ["pnp_up_abs", "x2"]}


def get(r, f):
    v = r.get(f)
    return None if v is None or (isinstance(v, float) and not math.isfinite(v)) else v


def vetoed(r, name, pop):
    f, d = VETOES[name]
    v = get(r, f)
    if v is None:
        return False
    tr = [get(q, f) for q in pop if q["label"] == "correct" and q["pid"] != r["pid"]]
    tr = [t for t in tr if t is not None]
    if not tr:
        return False
    return v > max(tr) if d > 0 else v < min(tr)


out = {}
for min_inl in (30, 100):
    pop = [r for r in R if r["group"] in ("refs", "extra") and r["label"] in ("correct", "wrong") and r["inl_hyp"] >= min_inl]
    nc = sum(r["label"] == "correct" for r in pop)
    nw = len(pop) - nc
    print(f"\npopulation inl_hyp >= {min_inl}: {nc} correct refs, {nw} wrong (incl. wc_0086 N7)")
    res = {}
    for cname, parts in COMBOS.items():
        lost, caught, missed = [], [], []
        for r in pop:
            v = any(vetoed(r, p, pop) for p in parts)
            k = f"{r['pid']}/{r['tag']}"
            if r["label"] == "correct" and v:
                lost.append(k)
            elif r["label"] == "wrong":
                (caught if v else missed).append(k)
        hv = [pid for pid, h in HIGHS.items() if h["verdict"] == "correct"
              and any(vetoed(r, p, pop) for p in parts for r in pop if r["pid"] == pid and r["tag"] == h["ref"])]
        res[cname] = {"correct_lost": lost, "wrong_caught": caught, "wrong_missed": missed, "correct_HIGH_vetoed": hv}
        print(f"  {cname:18s} correct lost {len(lost)}/{nc} {lost} | wrong caught {len(caught)}/{nw} | missed {missed} | "
              f"v2 correct HIGH vetoed {hv}")
    out[f"inl>={min_inl}"] = res
json.dump(out, open(HERE / "combo_veto.json", "w"), indent=1)
