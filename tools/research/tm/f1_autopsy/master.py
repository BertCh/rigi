"""F1: build per-photo master table from existing records (read-only)."""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tm_common as T
import refs as R
ROOT = T.ROOT
man = {p["id"]: p for p in json.load(open(ROOT/"tools/bench/data/manifest.json"))}
V = json.load(open(ROOT/"tools/bench/gt/t6/dev_verdicts.json"))["photos"]
sc = json.load(open(ROOT/"tools/matcher/v2/out/dev/score.json"))
t6rows = {r["id"]: r for r in sc["rows"]["t6"]}
scl = json.load(open(ROOT/"tools/matcher/v2/out/dev_loma/score.json"))
lrows = {r["id"]: r for r in scl["rows"].get("t6", [])} if "rows" in scl else {}
def d(a, b):
    dy = abs((a["yaw"]-b["yaw"]+180) % 360-180); return dy+abs(a["pitch"]-b["pitch"])
out = {}
for pid in T.dev_ids():
    m = man[pid]; t = m["tags"]
    cr = R.correct_refs(pid); wr = R.wrong_refs(pid)
    raw = json.load(open(ROOT/f"tools/bench/t6/out/raw/{pid}.json"))
    fin = json.load(open(ROOT/f"tools/bench/t6/out/{pid}.json"))
    v2 = json.load(open(ROOT/f"tools/matcher/v2/out/dev/{pid}.json"))
    lo = ROOT/f"tools/matcher/v2/out/dev_loma/{pid}.json"
    lo = json.load(open(lo)) if lo.exists() else None
    if lo and not (lo.get("final") or {}).get("pose"): lo = None
    cands = []
    for c in raw.get("candidates", []):
        f = c.get("fused") or {}
        fp = f.get("pose") or c.get("pose")
        dc = min([d(fp, r["pose"]) for r in cr], default=None)
        dw = min([d(fp, r["pose"]) for r in wr], default=None)
        ck = f.get("checks") or {}
        cands.append(dict(src=c.get("source"), yaw=round(fp["yaw"],1), pitch=round(fp["pitch"],1),
            dCorrect=None if dc is None else round(dc,1), dWrong=None if dw is None else round(dw,1),
            inl=f.get("inliers"), sup=ck.get("matchSupport"), agree=ck.get("cueAgreeDeg"), skyPx=ck.get("skylineMedPx"),
            s1inl=c.get("inliers")))
    ep = [e.get("best") for e in v2.get("eyeProbe") or []]
    row = dict(id=pid, title=m["title"], posSrc=m.get("positionSource"), coordType=m.get("coordType"),
        focal35=m.get("focal35mm"), heading=m.get("headingDeg"), date=m.get("dateTaken"), camera=m.get("camera"),
        tags=t, verdictTags=V[pid].get("photoTags"), anyCorrectWild=V[pid].get("anyCorrect"),
        nCorrectRefs=len(cr), nWrongRefs=len(wr),
        correctRefs=[dict(label=r["label"], yaw=round(r["pose"]["yaw"],1), pitch=round(r["pose"]["pitch"],1), vfov=round(r["pose"]["vfov"],1)) for r in cr],
        wrongRefs=[dict(label=r["label"], yaw=round(r["pose"]["yaw"],1), pitch=round(r["pose"]["pitch"],1)) for r in wr],
        t6=dict(level=fin["confidenceLevel"], verdict=t6rows[pid]["verdict"], source=fin["source"], checks=fin["checks"],
                pose={k: round(v,2) for k,v in fin["pose"].items()}, sweepBest=v2["stated"].get("sweepBest"),
                vfov0=raw.get("vfov0"), hfov0=raw.get("hfov0"), focalKnown=raw.get("focalKnown"), stage=raw.get("stage")),
        cands=cands, eyeProbeBest=ep, eyeMovedRuns=len(v2.get("eyeResults") or []),
        loma=None if not lo else dict(level=lo["final"]["level"], inl=lo["final"].get("inliers", (lo["final"].get("checks") or {}).get("inliers")), sup=lo["final"].get("support"),
                 pose={k: round(v,2) for k,v in lo["final"]["pose"].items()},
                 dCorrect=min([d(lo["final"]["pose"], r["pose"]) for r in cr], default=None),
                 dWrong=min([d(lo["final"]["pose"], r["pose"]) for r in wr], default=None),
                 verdict=lrows.get(pid, {}).get("verdict")))
    out[pid] = row
json.dump(out, open(Path(__file__).parent/"master.json", "w"), indent=1)
bad = [p for p, r in out.items() if not (r["t6"]["level"] == "HIGH" and r["t6"]["verdict"] == "correct")]
print(len(bad), "non-correct-HIGH:", bad)
for p in bad:
    r = out[p]; t = r["tags"]
    print(f"{p} {r['posSrc'][:5]} f35={r['focal35']} hf={r['t6']['hfov0'] and round(r['t6']['hfov0'])} {t.get('focalClass')} {t.get('skylineDist')} {t.get('season')} {t.get('weather')} fg={t.get('foreground')} vt={r['verdictTags']} | T6 {r['t6']['level']} {r['t6']['verdict']} inl={r['t6']['checks'].get('inliers')} sup={r['t6']['checks'].get('matchSupport')} | cref={[(c['yaw'],c['pitch']) for c in r['correctRefs']]} | ep={r['eyeProbeBest']} | loma={r['loma'] and (r['loma']['level'], r['loma']['inl'], r['loma']['verdict'], r['loma']['dCorrect'] and round(r['loma']['dCorrect'],1))}")
    for c in r["cands"]:
        print("    ", c)
    print("   notes:", t.get("notes"), "| title:", r["title"])
