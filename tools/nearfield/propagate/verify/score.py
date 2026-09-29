"""Unblind + score the wc_0086 propagation pack. Run: python3 tools/nearfield/propagate/verify/score.py (repo root)."""
import json, pathlib
D = pathlib.Path(__file__).resolve().parent
key = json.load(open(D / "key.json"))["candidates"]
rows = []
for v in ["v1", "v2", "v3"]:
    for x in json.load(open(D / "raw" / f"{v}.json"))["verdicts"]:
        k = key[x["label"]]
        rows.append({"verifier": v, "label": x["label"], "pid": k["pid"], "kind": k["kind"], "verdict": x["verdict"], "tags": x["tags"]})
json.dump(rows, open(D / "verdicts_keyed.json", "w"), indent=1)
out = {}
for v in ["v1", "v2", "v3"]:
    r = [x for x in rows if x["verifier"] == v]
    ctrl = all(x["verdict"] == "correct" for x in r if x["kind"].startswith("control"))
    decoy_acc = [x["kind"] for x in r if x["kind"].startswith("decoy") and x["verdict"] == "correct"]
    prop = {x["verdict"] for x in r if x["kind"].startswith("propagated")}
    pv = prop.pop() if len(prop) == 1 else "unsure(dup-disagree)"
    out[v] = {"control_ok": ctrl, "decoys_accepted": decoy_acc, "propagated": pv, "sane": ctrl and not decoy_acc}
    print(v, out[v])
sane = [o["propagated"] for o in out.values() if o["sane"]]
final = "wrong" if "wrong" in sane else ("correct" if sane and all(p == "correct" for p in sane) else "unsure")
print("FINAL propagated wc_0086:", final, f"({len(sane)}/3 sane verifiers)")
json.dump({"per_verifier": out, "final": final}, open(D / "score.json", "w"), indent=1)
