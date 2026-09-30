"""POST-HOC checks (not in PROTOCOL): clipping confound of the rotation predictor; reverse-direction I_tot."""
import json, numpy as np
from scipy.stats import spearmanr
from evaluate import F, label, feats, auc_ci
ids = sorted(F); lab = {p: label(p) for p in ids}
inv = {p: F[p]["sky_invalid_frac"] for p in ids}
A = {p: feats(p, "A") for p in ids}
out = {}
out["spearman_R_vs_skyInvalid"] = round(float(spearmanr([A[p]["R"] for p in ids], [inv[p] for p in ids])[0]), 3)
out["wstar360_share_by_invalid"] = {"inv>=0.5": [A[p]["wstar"] == 360 for p in ids if inv[p] >= .5].count(True),
                                    "n_inv>=0.5": sum(inv[p] >= .5 for p in ids),
                                    "inv<0.5": [A[p]["wstar"] == 360 for p in ids if inv[p] < .5].count(True)}
out["AUROC_ROT_vs_SUCCESS_skyInvalid"] = auc_ci([inv[p] for p in ids if lab[p] == "ROT"], [inv[p] for p in ids if lab[p] == "SUCCESS"], 2000)
low = [p for p in ids if inv[p] < 0.3]
out["AUROC_ROT_vs_SUCCESS_-R_invalid<0.3"] = auc_ci([-A[p]["R"] for p in low if lab[p] == "ROT"], [-A[p]["R"] for p in low if lab[p] == "SUCCESS"], 2000)
for an in ("A", "B"):
    ft = {p: feats(p, an) for p in ids}; ok = [p for p in ids if ft[p]]
    out[f"{an}_POS_vs_SUCCESS_+I_tot(reverse)"] = auc_ci([ft[p]["I_tot"] for p in ok if lab[p] == "POS"], [ft[p]["I_tot"] for p in ok if lab[p] == "SUCCESS"], 2000)
    out[f"{an}_POSc_vs_SUCCESS_+I_tot(reverse)"] = auc_ci([ft[p]["I_tot"] for p in ok if lab[p] != "SUCCESS" and F[p] and p in ok and __import__('evaluate').posc(p)], [ft[p]["I_tot"] for p in ok if lab[p] == "SUCCESS"], 2000)
# ring-at-ref vs ref-view f250 on ref holders (does the ring under-see the near field?)
rr = [(F[p]["ring_at_ref"]["f250"], F[p]["C"]["f250"]) for p in ids if F[p].get("C")]
out["f250_ringAtRef_vs_refView_medians"] = [round(float(np.median([a for a, b in rr])), 4), round(float(np.median([b for a, b in rr])), 4)]
print(json.dumps(out, indent=1))
# merged into results.json["posthoc_LABELLED_POST_HOC"]
