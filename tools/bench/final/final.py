"""Single-test-run runner: three arms, one photo per child process, hard wall cap, code stamps.

  arms   A  CPU replay of the v0.3.4 service logic (T6's baseline candidate: stage-1 sweep40 → app seeds /
            narrow_stage1, then the service's stage 2; v0.3.4 HIGH = a-priori ∧ (EXIF ∨ basin gap ≥ 0.20)).
            Same code path as the dev "replay": tools/matcher/stage1/pipeline.run_photo with the T6-only
            generators switched off (sky search, fine sweep) and only the baseline hypothesis verified.
         B  T6 frozen: pipeline.run_photo unchanged + stage1/finalize.final_record (rule sha1 checked).
         C  T5 pose6 (frozen rule, tools/bench/t5/RULE_FROZEN.sha1) started from B's final pose for that id
            (pose6_inputs.problem_bench with its start pose / focal flag taken from out/B/<id>.json and its
            work dir under out/C/work; nothing in pose6*.py is modified).

  python final.py --arm A|B|C <ids...>          (run_arm.sh wraps this; FINAL_ALLOW_TEST=1 for test ids)

Per photo a child process (own session: node + Chromium die with it) runs the arm; the parent enforces the
wall cap (FINAL_WALL_S, 600 s), classifies failures and writes out/<arm>/<id>.json. Resumable: an existing
record is kept unless it is an infrastructure failure, which is re-run (same code stamp required; logged).
Records with a different code stamp are never mixed: the run refuses.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
MATCHER = ROOT / "tools/matcher"
STAGE1 = MATCHER / "stage1"
WALL_S = int(os.environ.get("FINAL_WALL_S", 600))
MIN_FREE_GB = 3.0
T6_RULE_SHA1 = "292fb74f35f6f402b5e81f1b832bac565edd6807"
T5_RULE_SHA1 = "1ad03962d54363bab16a693e467619bcff45302d"  # pose6.py at freeze; rule text re-checked below
MAX_INFRA_RERUNS = 2

# ---------------------------------------------------------------- stamps

ARM_FILES = {
    "common": [HERE / "final.py", HERE / "run_arm.sh", MATCHER / "match.py", MATCHER / "common.py", MATCHER / "fusion.py"],
    "A": [STAGE1 / f for f in ("pipeline.py", "s1.py", "skyglobal.py")] + [MATCHER / "pose6.py", MATCHER / "dem.py"],
    "B": [STAGE1 / f for f in ("pipeline.py", "s1.py", "skyglobal.py", "rule.py", "policy.py", "finalize.py")] + [MATCHER / "pose6.py", MATCHER / "dem.py"],
    "C": [MATCHER / f for f in ("pose6.py", "pose6_inputs.py", "dem.py", "worker_client.py")] + [STAGE1 / "vendor_v03" / "render_worker.mjs"],
}
ENV_KEYS = ["MATCHER_LG_DEVICE", "MATCHER_SWEEP_KP", "MATCHER_BASIN_GAP_MIN", "STAGE1_LG_PRUNE", "FINAL_WALL_S", "FINAL_C_LG"]


def code_stamp(arm: str) -> dict:
    files = ARM_FILES["common"] + ARM_FILES[arm]
    if arm in ("A", "B"):
        files += sorted(p for p in (STAGE1 / "vendor").iterdir() if p.suffix in (".py", ".mjs", ".sha1"))
    h = hashlib.sha1()
    per = {}
    for f in files:
        b = f.read_bytes()
        per[str(f.relative_to(ROOT))] = hashlib.sha1(b).hexdigest()[:12]
        h.update(str(f.relative_to(ROOT)).encode())
        h.update(b)
    env = {k: os.environ.get(k) for k in ENV_KEYS}
    env["FINAL_WALL_S"] = str(WALL_S)
    h.update(json.dumps(env, sort_keys=True).encode())
    return {"sha1": h.hexdigest()[:16], "env": env, "files": per}


def t5_rule_ok() -> dict:
    s = (MATCHER / "pose6.py").read_text()
    f = (ROOT / "tools/bench/t5/RULE_FROZEN.sha1").read_text()
    a = s.index("CONFIDENCE RULE")
    blk = s[a:s.index('"""', a)].strip()
    fb = f[f.index("CONFIDENCE RULE"):].strip().rstrip('"').strip()
    consts = {k: v for k, v in (l.split(" = ", 1) for l in s.splitlines() if l.startswith(("BASIN_GAP =", "CONFIRM_PX =", "MIN_GAIN =")))}
    return {"ruleTextIdentical": blk == fb, "frozenFileSha1": T5_RULE_SHA1,
            "currentFileSha1": hashlib.sha1(s.encode()).hexdigest(), "constants": consts}


# ---------------------------------------------------------------- helpers

def free_gb() -> float:
    st = os.statvfs(str(ROOT))
    return st.f_bavail * st.f_frsize / 1e9


INFRA_MARKERS = ("worker", "renderer", "page for", "not ready", "ENOSPC", "No space", "MemoryError", "Killed", "BrokenPipe",
                 "Execution context was destroyed", "Target page, context or browser has been closed", "empty horizon",
                 "disk", "timed out after", "ConnectionRefused")


def classify(err: str | None) -> str | None:
    if not err:
        return None
    return "infra" if any(m.lower() in err.lower() for m in INFRA_MARKERS) else "method"


def manifest():
    return {e["id"]: e for e in json.load(open(ROOT / "tools/bench/data/manifest.json"))}


# ---------------------------------------------------------------- child: one photo, one arm

def child(arm: str, pid: str, out_tmp: Path):
    os.environ.setdefault("MATCHER_LG_DEVICE", "cpu")
    os.environ.setdefault("TORCH_HOME", str(MATCHER / "weights"))
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    sys.dont_write_bytecode = True
    res = {}
    try:
        if arm in ("A", "B"):
            res = child_ab(arm, pid)
        else:
            res = child_c(pid)
    except Exception as e:  # noqa: BLE001
        res = {"error": f"{type(e).__name__}: {e}"[:600], "trace": traceback.format_exc()[-1500:]}
    json.dump(res, open(out_tmp, "w"), indent=1, default=float)


def child_ab(arm: str, pid: str) -> dict:
    sys.path.insert(0, str(STAGE1))
    import pipeline as PL
    import s1
    import skyglobal as SG
    if arm == "A":
        # service logic only: no skyline global search, no fine sweep, verify only the baseline hypothesis
        SG.SkyGlobal.search = lambda self, *a, **k: {"hyps": [], "gridMs": 0, "refineMs": 0, "grid": None}
        PL.fine_sweep = lambda se, ph, eye: ([], [], {"views": 0, "ms": 0, "vfovs": [], "disabled": "arm A"})
        PL.MAX_VERIFY = 1
    w = s1.Worker()
    try:
        rec = None
        for attempt in range(2):  # pipeline.main's policy: one retry on error or a dev-server reload mid-photo
            rec = PL.run_photo(w, pid)
            rec["attempt"] = attempt + 1
            if "error" not in rec and rec.get("hmrReopens", 0) == 0:
                break
            if "worker" in str(rec.get("error", "")) or rec.get("timeout"):
                w.close()
                w = s1.Worker()
    finally:
        w.close()
    raw = rec
    t6stamp = (rec.get("codeStamp") or {}).get("sha1")
    if rec.get("error") and not rec.get("candidates"):
        return {"error": rec["error"], "raw": raw, "t6CodeStamp": t6stamp, "photoTimeout": bool(rec.get("timeout"))}
    import rule as R
    if arm == "B":
        import finalize as FZ
        if R.rule_sha1() != T6_RULE_SHA1:
            raise RuntimeError(f"T6 rule sha1 {R.rule_sha1()} != frozen {T6_RULE_SHA1}")
        fr = FZ.final_record(rec)
        if not fr.get("ok"):
            return {"error": fr.get("error"), "methodFailure": True, "raw": raw, "t6CodeStamp": t6stamp}
        c = R.select(rec)
        return {"pose": fr["pose"], "eye": fr["eye"], "confidenceLevel": fr["confidenceLevel"], "checks": fr["checks"],
                "basinGap": fr["checks"].get("basinGap"), "source": fr["source"], "baseline": fr["baseline"],
                "fusedLevelApriori": fr["fusedLevelApriori"], "stage1": fr["stage1"], "timingMs": rec.get("timingMs"),
                "ruleSha1": R.rule_sha1(), "t6CodeStamp": t6stamp, "raw": raw, "fusedChecks": c["fused"].get("checks")}
    # arm A: the baseline candidate = what the v0.3.4 service returns
    c = R.baseline(rec)
    if c is None:
        return {"error": rec.get("error") or "no verified baseline hypothesis", "methodFailure": True, "raw": raw, "t6CodeStamp": t6stamp}
    fu = c["fused"]
    exif = rec.get("positionSource") == "exif-gps"
    gap = (fu.get("basinGap") or {}).get("gap")
    apri = fu.get("level") == "high"
    gap_min = float(os.environ.get("MATCHER_BASIN_GAP_MIN", 0.20))
    level = "HIGH" if apri and (exif or (gap is not None and gap >= gap_min)) else "LOW"
    eye = fu.get("eye") or rec.get("eye")
    return {"pose": fu["pose"], "eye": {"lat": rec["lat"], "lon": rec["lon"], "h": eye[2]}, "eyeEnu": eye,
            "confidenceLevel": level, "confidenceLevelApriori": "HIGH" if apri else "LOW", "checks": fu.get("checks"),
            "basinGap": gap, "basinGapMin": gap_min, "source": c["source"], "stage1Seed": rec.get("baselineSeed"),
            "stage1": {"sweep40Inliers": (rec.get("sweep40") or {}).get("inliers"), "narrow": rec.get("narrow") is not None,
                       "focalKnown": rec.get("focalKnown"), "hfov0": rec.get("hfov0")},
            "timingMs": rec.get("timingMs"), "t6CodeStamp": t6stamp, "raw": raw}


def child_c(pid: str) -> dict:
    fb = HERE / "out" / "B" / f"{pid}.json"
    if not fb.exists():
        return {"skipped": "no arm-B record", "methodFailure": True}
    b = json.load(open(fb))
    if not b.get("pose"):
        return {"skipped": "arm B has no pose", "methodFailure": True, "bStatus": b.get("status")}
    sys.path.insert(0, str(MATCHER))
    os.chdir(MATCHER)
    import match as M
    if os.environ.get("FINAL_C_LG", "cpu") == "cpu":
        # the MPS LightGlue point-pruning dropout (reports/stage1.md): run pose6's re-matching on CPU LightGlue,
        # as the v0.3.x service does. Matching device only; pose6's rule and parameters are untouched.
        import torch
        from lightglue import LightGlue
        _lg = {}

        def match_cpu(kind, f0, f1):
            if kind not in _lg:
                _lg[kind] = LightGlue(features=kind).eval()
            cpu = lambda f: {k: (t.to("cpu") if hasattr(t, "to") else t) for k, t in f.items()}  # noqa: E731
            with torch.inference_mode():
                out = _lg[kind]({"image0": cpu(f0), "image1": cpu(f1)})
            m = out["matches"][0].numpy()
            sc = out["scores"][0].numpy()
            return f0["keypoints"][0].cpu().numpy()[m[:, 0]], f1["keypoints"][0].cpu().numpy()[m[:, 1]], sc
        M.match = match_cpu
    import worker_client as WC
    WC.WORKER = STAGE1 / "vendor_v03" / "render_worker.mjs"  # pinned v0.3.4 worker (+ fixes), never the live server file
    import pose6 as P6
    import pose6_inputs as PI
    work = HERE / "out" / "C" / "work"
    PI.WORK = work
    start = {k: float(b["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")}
    PI.fused_result = lambda bid: {"pose": start, "assumptions": {"focalKnown": bool((b.get("stage1") or {}).get("focalKnown"))}}
    worker = PI.start_worker()
    try:
        prob = PI.problem_bench(pid, worker)
        eye_diff = abs(float(prob.eye0[2]) - float(b["eye"]["h"]))
        confirm = PI.make_confirm(pid, prob, worker)
        res = P6.refine(prob, confirm)
    finally:
        worker.close()
        ph = work / pid / "photo.jpg"
        if ph.exists():
            ph.unlink()
    c = res.get("checks") or {}
    return {"pose": res.get("pose"), "eye": res.get("eye"), "confidenceLevel": res.get("confidenceLevel"), "checks": c,
            "basinGap": c.get("basinGap"), "start": {"arm": "B", "pose": start, "eyeH": b["eye"]["h"], "confidenceLevel": b.get("confidenceLevel"),
                                                     "codeStamp": b.get("codeStamp", {}).get("sha1")},
            "startEyeDiffM": eye_diff, "keptStart": res.get("keptStart"), "regime": res.get("regime"), "t5Rule": t5_rule_ok(),
            "raw": {k: v for k, v in res.items() if k not in ("grid",)}, "gridSummary": {k: (res.get("grid") or {}).get(k) for k in ("step", "gap", "best", "second")}}


# ---------------------------------------------------------------- parent

def log(arm, msg):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [{arm}] {msg}"
    print(line, flush=True)
    with open(HERE / "out" / arm / "run.log", "a") as f:
        f.write(line + "\n")


def kill_tree(p: subprocess.Popen):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(5)
            return
        except subprocess.TimeoutExpired:
            continue


def run_one(arm: str, pid: str, stamp: dict, prev: dict | None) -> dict:
    tmp = HERE / "out" / arm / f".{pid}.child.json"
    tmp.unlink(missing_ok=True)
    t0 = time.time()
    env = {**os.environ, "MATCHER_LG_DEVICE": os.environ.get("MATCHER_LG_DEVICE", "cpu"), "PYTHONDONTWRITEBYTECODE": "1",
           "STAGE1_PHOTO_WALL_S": str(WALL_S + 60)}  # the parent's cap is the binding one
    with open(HERE / "out" / arm / "child.log", "a") as lf:
        p = subprocess.Popen([str(MATCHER / ".venv/bin/python"), str(HERE / "final.py"), "--child", arm, pid, str(tmp)],
                             cwd=ROOT, env=env, stdout=lf, stderr=lf, start_new_session=True)
        timeout = False
        try:
            rc = p.wait(WALL_S)
        except subprocess.TimeoutExpired:
            timeout = True
            kill_tree(p)
            rc = None
        else:
            kill_tree(p)  # leftover node / Chromium in the child's session
    wall = time.time() - t0
    res = {}
    if tmp.exists():
        try:
            res = json.load(open(tmp))
        except json.JSONDecodeError:
            res = {"error": "child wrote an unreadable record"}
        tmp.unlink(missing_ok=True)
    rec = {"id": pid, "arm": arm, "codeStamp": stamp, "wallSec": round(wall, 1), "wallCapSec": WALL_S, "timeout": timeout, "exitCode": rc}
    if timeout:
        rec.update(status="timeout", failureClass="method", error=f"wall cap {WALL_S} s exceeded")
    elif rc not in (0, None) and not res:
        rec.update(status="infra", failureClass="infra", error=f"child exited with code {rc} (crash/OOM kill) and no record")
    elif res.get("skipped"):
        rec.update(status="skipped", failureClass="method", error=res["skipped"])
    elif res.get("pose") is None:
        cls = "method" if res.get("methodFailure") else classify(res.get("error")) or "method"
        if res.get("photoTimeout"):
            cls = "method"
        rec.update(status="infra" if cls == "infra" else "noPose", failureClass=cls, error=res.get("error"))
    else:
        rec.update(status="ok", failureClass=None)
    rec.update({k: v for k, v in res.items() if k not in rec})
    rec["ruleSha1"] = {"A": {"service": "v0.3.4 a-priori + basin gap ≥ MATCHER_BASIN_GAP_MIN"}, "B": {"t6": T6_RULE_SHA1},
                       "C": {"t5": T5_RULE_SHA1, "t6Start": T6_RULE_SHA1}}[arm]
    e = manifest()[pid]
    rec["cascadeAgreementInputs"] = {"pose": rec.get("pose"), "eyeH": (rec.get("eye") or {}).get("h") if isinstance(rec.get("eye"), dict) else None,
                                     "positionSource": e.get("positionSource"), "exif": e.get("positionSource") == "exif-gps",
                                     "tolerance": {"yawPitchDeg": 0.5, "eyeM": 2.0, "cascadeGate": "accepted ∧ confidence ≥ 0.75 (acc75)"}}
    hist = (prev or {}).get("history", [])
    if prev:
        hist = hist + [{k: prev.get(k) for k in ("status", "failureClass", "error", "wallSec", "finishedAt")}]
    rec["history"] = hist
    rec["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    return rec


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        return child(sys.argv[2], sys.argv[3], Path(sys.argv[4]))
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, choices=["A", "B", "C"])
    ap.add_argument("ids", nargs="+")
    a = ap.parse_args()
    split = json.load(open(ROOT / "tools/bench/split.json"))
    dev, test = set(split["dev"]), set(split["test"])
    allow_test = os.environ.get("FINAL_ALLOW_TEST") == "1"
    out = HERE / "out" / a.arm
    out.mkdir(parents=True, exist_ok=True)
    stamp = code_stamp(a.arm)
    if a.arm == "C" and not t5_rule_ok()["ruleTextIdentical"]:
        raise SystemExit("pose6.py CONFIDENCE RULE text differs from tools/bench/t5/RULE_FROZEN.sha1: refusing")
    log(a.arm, f"start: {len(a.ids)} ids, code stamp {stamp['sha1']}, wall cap {WALL_S} s, allowTest={allow_test}")
    for pid in a.ids:
        if pid not in dev and pid not in test:
            log(a.arm, f"{pid}: unknown id, skipped")
            continue
        if pid in test and not allow_test:
            log(a.arm, f"{pid}: TEST id refused (set FINAL_ALLOW_TEST=1 only for the approved test run)")
            continue
        f = out / f"{pid}.json"
        prev = json.load(open(f)) if f.exists() else None
        if prev:
            if prev["codeStamp"]["sha1"] != stamp["sha1"]:
                raise SystemExit(f"{pid}: existing record has code stamp {prev['codeStamp']['sha1']} != {stamp['sha1']}: refusing to mix")
            if prev.get("failureClass") != "infra":
                log(a.arm, f"{pid}: kept ({prev.get('status')})")
                continue
            if len(prev.get("history", [])) >= MAX_INFRA_RERUNS:
                log(a.arm, f"{pid}: infra failure, re-run budget used up; kept")
                continue
            log(a.arm, f"{pid}: RE-RUN after infrastructure failure ({prev.get('error')})")
        t0 = time.time()
        while free_gb() < MIN_FREE_GB:
            if time.time() - t0 > 900:
                log(a.arm, f"disk below {MIN_FREE_GB} GB for 15 min: stopping (infra)")
                return 2
            time.sleep(30)
        rec = run_one(a.arm, pid, stamp, prev)
        json.dump(rec, open(f, "w"), indent=1, default=float)
        log(a.arm, f"{pid}: {rec['status']} {rec.get('confidenceLevel') or ''} wall {rec['wallSec']} s"
                   f"{' error: ' + str(rec.get('error'))[:160] if rec.get('error') else ''}")
    log(a.arm, "done")


if __name__ == "__main__":
    sys.exit(main() or 0)
