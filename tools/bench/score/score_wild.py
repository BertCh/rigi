#!/usr/bin/env python3
"""Score the in-the-wild benchmark from blind visual verdicts.

Inputs (all read-only):
  tools/bench/data/manifest.json                       photo metadata + strata (positionSource, tags)
  tools/bench/gt/wild/verify/key.json                  hidden map photo -> cluster -> methods/confidence (v2: verify_v2/key_v2.json)
  tools/bench/gt/wild/verdicts/part_*.json             blind verdicts per photo/cluster (v2: verdicts_v2/)
  (tracked copies of the blind ground truth; the harness still writes the originals under harness/out/runs/wild)
  tools/bench/harness/out/runs/wild/results/<id>/given.fused.json   fused stage-1 seed source

Verdict merging: a photo judged by two verifiers keeps the verdict when they agree, otherwise "unsure".
part_4b (a rate-limit re-check) replaces part_4 for the photos it covers.

Outputs: tools/bench/score/wild_scores.json and a markdown table on stdout.
"""
import glob
import json
import os
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
RUN = os.path.join(ROOT, "tools/bench/harness/out/runs/wild")  # run results (given.fused.json)
GT = os.path.join(ROOT, "tools/bench/gt/wild")  # blind ground truth: keys + verdicts
METHODS = ["app", "cascade", "fused"]
# v1: Terrarium overlays (verify/, verdicts/); v2: Mapterhorn at each method's eye (verify_v2/, verdicts_v2/)
VERSION = os.environ.get("VERIFY_VERSION", "v2")
VERDICTS = "verdicts" if VERSION == "v1" else "verdicts_v2"
KEY = "verify/key.json" if VERSION == "v1" else "verify_v2/key_v2.json"


def load(p):
    with open(p) as f:
        return json.load(f)


def verdict_sets():
    parts = {}
    for p in sorted(glob.glob(os.path.join(GT, VERDICTS, "part_*.json"))):
        v = load(p)
        parts[str(v.get("verifier"))] = v["photos"]
    recheck = parts.pop("4b", {})
    for pid in recheck:  # re-check replaces the rate-limited original
        parts.get("4", {}).pop(pid, None)
    by_photo = defaultdict(list)
    for name, photos in parts.items():
        for pid, e in photos.items():
            by_photo[pid].append((name, e))
    for pid, e in recheck.items():
        by_photo[pid].append(("4b", e))
    return by_photo


def merge(entries):
    """-> ({cluster: verdict}, {cluster: tags}, photoTags, agreement pairs)."""
    verdicts, tags, ptags, pairs = {}, defaultdict(set), set(), []
    clusters = set().union(*(e["candidates"].keys() for _, e in entries))
    for c in clusters:
        vs = [e["candidates"][c]["verdict"] for _, e in entries if c in e["candidates"]]
        verdicts[c] = vs[0] if len(set(vs)) == 1 else "unsure"
        if len(vs) == 2:
            pairs.append(tuple(vs))
        for _, e in entries:
            if c in e["candidates"]:
                tags[c].update(e["candidates"][c].get("tags", []))
    for _, e in entries:
        ptags.update(e.get("photoTags", []))
    return verdicts, tags, ptags - {"none"}, pairs


def fused_seed(pid):
    p = os.path.join(RUN, "results", pid, "given.fused.json")
    if not os.path.exists(p):
        return None
    a = load(p).get("adhoc") or {}
    used = [s for s in a.get("stages", []) if s.get("used")]
    if not used:
        return "direct"
    return "match-sweep" if used[0].get("stage") == "match-sweep" else used[0].get("stage", "other")


def accepted(m):
    if m["method"] == "fused":
        return m.get("confidenceLevel") == "high"
    return bool(m.get("accepted"))


def main():
    manifest = {e["id"]: e for e in load(os.path.join(ROOT, "tools/bench/data/manifest.json"))}
    key = load(os.path.join(GT, KEY))
    key = key.get("photos", key)
    vsets = verdict_sets()

    rows, pairs_all = [], []
    for pid in sorted(manifest):
        if pid not in vsets:
            continue
        verdicts, ctags, ptags, pairs = merge(vsets[pid])
        pairs_all += pairs
        e = manifest[pid]
        t = e.get("tags", {})
        base = {
            "id": pid,
            "positionSource": e.get("positionSource"),
            "skylineDist": t.get("skylineDist"),
            "headingKnown": bool(t.get("headingKnown")),
            "photoTags": sorted(ptags),
            "hard": bool(t.get("hard")),
        }
        per = {}
        for c, ce in key[pid]["clusters"].items():
            if c == "P":
                continue
            for m in ce["methods"]:
                per[m["method"]] = {
                    "cluster": c,
                    "verdict": verdicts.get(c, "unjudged"),
                    "tags": sorted(ctags.get(c, [])),
                    "accepted": accepted(m),
                    "confidence": m.get("confidence"),
                }
        for m in METHODS:
            per.setdefault(m, {"cluster": None, "verdict": "no-pose", "tags": [], "accepted": False, "confidence": None})
        base["methods"] = per
        base["fusedSeed"] = fused_seed(pid)
        base["anyCorrect"] = any(v["verdict"] == "correct" for v in per.values())
        rows.append(base)

    def agg(sub):
        out = {"n": len(sub), "oracle": sum(r["anyCorrect"] for r in sub)}
        for m in METHODS:
            vs = Counter(r["methods"][m]["verdict"] for r in sub)
            acc = [r for r in sub if r["methods"][m]["accepted"]]
            av = Counter(r["methods"][m]["verdict"] for r in acc)
            dec = av["correct"] + av["wrong"] + av["no-pose"]
            rej = [r for r in sub if not r["methods"][m]["accepted"]]
            out[m] = {
                "correct": vs["correct"], "wrong": vs["wrong"] + vs["no-pose"], "unsure": vs["unsure"] + vs["unjudged"],
                "accepted": len(acc), "acceptedCorrect": av["correct"], "acceptedWrong": av["wrong"] + av["no-pose"],
                "acceptedUnsure": av["unsure"],
                "precision": round(av["correct"] / dec, 3) if dec else None,
                # lenient: a near-miss (right shape, small offset, usually a position/parallax error) is not a gross error
                "acceptedGross": sum(1 for r in acc if r["methods"][m]["verdict"] in ("wrong", "no-pose") and "near-miss" not in r["methods"][m]["tags"]),
                "nearMiss": sum(1 for r in sub if r["methods"][m]["verdict"] in ("wrong", "unsure") and "near-miss" in r["methods"][m]["tags"]),
                "rejectedCorrect": sum(r["methods"][m]["verdict"] == "correct" for r in rej),
            }
        return out

    strata = {"all": rows}
    for k in ["positionSource", "skylineDist", "headingKnown"]:
        for val in sorted({str(r[k]) for r in rows}):
            strata[f"{k}={val}"] = [r for r in rows if str(r[k]) == val]
    for val in sorted({str(r["fusedSeed"]) for r in rows}):
        strata[f"fusedSeed={val}"] = [r for r in rows if str(r["fusedSeed"]) == val]
    res = {k: agg(v) for k, v in strata.items()}

    agree = sum(a == b for a, b in pairs_all)
    cw = [(a, b) for a, b in pairs_all if {a, b} <= {"correct", "wrong"}]
    flips = sum(a != b for a, b in cw)

    # failure taxonomy: photos where no method is correct, by photo tags + candidate tags
    fail = [r for r in rows if not r["anyCorrect"]]
    tax = Counter()
    for r in fail:
        tags = set(r["photoTags"])
        for v in r["methods"].values():
            tags.update(v["tags"])
        if r["positionSource"] == "manual":
            tags.add("manual-position")
        tax.update(tags)

    out = {"strata": res, "interRater": {"pairs": len(pairs_all), "agree": agree, "correctWrongFlips": flips},
           "failureTaxonomy": dict(tax.most_common()), "nFail": len(fail), "rows": rows}
    with open(os.path.join(os.path.dirname(__file__), f"wild_scores_{VERSION}.json"), "w") as f:
        json.dump(out, f, indent=1)

    print(f"inter-rater: {agree}/{len(pairs_all)} candidate verdicts agree; correct<->wrong flips {flips}")
    print("| stratum | n | oracle | " + " | ".join(f"{m} ok (+near≈) / acc / prec (acc ✓·✗·?; gross ✗)" for m in METHODS) + " |")
    print("|---" * (3 + len(METHODS)) + "|")
    for k, a in res.items():
        cells = []
        for m in METHODS:
            s = a[m]
            p = "–" if s["precision"] is None else f"{s['precision']:.2f}"
            cells.append(f"{s['correct']} (+{s['nearMiss']}≈) / {s['accepted']} / {p} ({s['acceptedCorrect']}·{s['acceptedWrong']}·{s['acceptedUnsure']}; gross {s['acceptedGross']})")
        print(f"| {k} | {a['n']} | {a['oracle']} | " + " | ".join(cells) + " |")
    print("\nfailure taxonomy (no method correct, n=%d):" % len(fail), dict(tax.most_common(14)))


if __name__ == "__main__":
    main()
