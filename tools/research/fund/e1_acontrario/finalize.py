"""E1 step 5: verdict vs the FIXED kill criterion (PROTOCOL.txt KILL) + clearly-labelled POST HOC diagnostics.
Adds keys "verdict" and "postHoc" to results.json. No new decisions for the pre-registered methods."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = json.load(open(HERE / "results.json"))
H = json.load(open(HERE / "hyp_scores.json"))
M = R["metrics"]
NEG = ("NB-inh", "NB-con", "NB-dec", "NE-inh", "NE-dec")
cur_rec = M["CUR"]["photoRecall"]


def kill(m):
    mm = M[m]
    k1 = mm["wrongEyeAccepted"]
    k2 = (not mm["atZeroGross"]) or mm["photoRecall"] < cur_rec
    return {"wrongEyeAccepted": k1, "killI": bool(k1), "atZeroGross": mm["atZeroGross"], "gross": mm["gross"],
            "photoRecall": mm["photoRecall"], "curPhotoRecall": cur_rec, "killII": bool(k2), "killed": bool(k1) or k2}


v = {m: kill(m) for m in ("AC1", "AC2")}
v["E1"] = "FAIL (killed at PRIMARY and at ALTERNATIVE)" if v["AC1"]["killed"] and v["AC2"]["killed"] else (
    "PASS" if not v["AC1"]["killed"] else "passes at the pre-registered alternative eps only")
R["verdict"] = v


# POST HOC 1: oracle threshold - best photo recall at 0 gross if the NFA / T / Tfit cut were chosen with labels
def oracle(key, lower_is_better):
    lab = [h for h in H if h["label"] in NEG and h.get(key) is not None]
    pos = [h for h in H if h["label"] == "POS" and h.get(key) is not None]
    if lower_is_better:
        thr = min(h[key] for h in lab)
        ok = [h for h in pos if h[key] < thr]
    else:
        thr = max(h[key] for h in lab)
        ok = [h for h in pos if h[key] > thr]
    worst = [h["hid"] for h in lab if h[key] == thr]
    return {"threshold": thr, "setBy": worst, "photoRecallAt0Gross": len({h["pid"] for h in ok}), "photosWithPositive": len({h["pid"] for h in pos})}


ph = {"LABEL": "POST HOC - chosen after seeing the statistics; not a decision rule",
      "oracle_log10NFA": oracle("log10NFA", True), "oracle_T": oracle("T", False), "oracle_Tfit": oracle("Tfit", False),
      "oracle_log10NFAfit": oracle("log10NFAfit", True)}
# POST HOC 2: accepted NE-dec with truth-geometry misfit >= 15 px median (i.e. unambiguously wrong even by a strict reading)
for m in ("AC1", "AC2"):
    acc = [h for h in H if h["label"] == "NE-dec" and h["accept"][m]]
    ph[f"{m}_NEdec_accepted_misfit"] = [(h["hid"], round((h.get("misfit") or {}).get("medPx", float("nan")), 1)) for h in acc]
    ph[f"{m}_NEdec_accepted_misfit_ge15px"] = sum(1 for h in acc if ((h.get("misfit") or {}).get("medPx") or 0) >= 15)
# POST HOC 3: positives whose held-out T collapsed to 0 while the no-held-out Tfit is large
ph["positives_T0"] = [(h["hid"], h["nCorr"], round(h["Tfit"], 1), h["split"]) for h in H if h["label"] == "POS" and h["T"] == 0]
R["postHoc"] = ph
json.dump(R, open(HERE / "results.json", "w"), indent=1)
print(json.dumps({"verdict": v, "postHoc": ph}, indent=1))
