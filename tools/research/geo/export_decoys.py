"""Export FUND E1 hypotheses (true / wrong-basin / displaced-eye decoys + their LoMa correspondences) to JSON for the
TS GEO evals (GA2 observability, GA5 integrity). Read-only over tools/research/fund/e1_acontrario; dev ids only.

    tools/matcher/.venv/bin/python tools/research/geo/export_decoys.py [--max 400]

FORMAT  out/geocam/decoys/<pid>.json   (also documented in README.txt)
  {
    "format": "geocam-decoys/1", "pid", "source": "tools/research/fund/e1_acontrario",
    "stated": {"lat", "lon", "h"},       // stated eye; ENU frame origin = (stated.lat, stated.lon, height 0)
    "positionSource": "manual"|"exif-gps"|...,
    "W", "H",                             // pixel frame of every uv (render size, photo aspect)
    "vfov0", "focalKnown", "f0Px",        // prior focal: f0Px = (H/2)/tan(vfov0/2)
    "refs": [{"pose": {yaw,pitch,roll,vfov}, "eye": {lat,lon,h}, "eyeEnu": [e,n,u], "from"}],   // verified correct
    "hyps": [{
      "id", "kind": "POOL|REF|RING|YAW|DISP", "label": "POS|NB-inh|NB-con|NB-dec|NE-inh|NE-dec|AMB|UNL",
      "secondary": bool,                  // true = only in E1's pre-declared dispfull run (extra displaced eyes)
      "eye": {lat,lon,h}, "eyeEnu": [e,n,u], "eyeOffsetM": [de,dn,du],   // vs the stated eye
      "dispDistM": number|null, "pose": {yaw,pitch,roll,vfov},
      "nCorr", "nKept",
      "uv": [[u,v]...],                   // photo px at W x H; 0 = image edge (pixel centres at i + 0.5)
      "xyz": [[e,n,u]...],                // world points in the stated-eye ENU frame (m, DEM heights)
      "dist": [m...],                     // |xyz - eyeEnu|
      "e1": {"log10NFA","T","Tfit","accept": {...},"misfitMedPx"}
    }]
  }
  Pose: yaw clockwise from north, pitch up, roll (tools/matcher/common.py pose_to_R; = src/lib/pose.ts).
  Frames: E1 npz points are in a frame centred on each hypothesis eye's lat/lon; they are shifted into the stated
  frame by the local equirectangular offset (e1lib.enu_offset; << 1 m error at <= 400 m); the hypothesis eye height
  is the npz eye z (the height actually rendered, after any worker clamp).
  Labels (E1 PROTOCOL.txt): POS = verified-correct pose at the stated eye; NB-* wrong basin (eye right, rotation
  > 3 deg off); NE-dec displaced eye >= 150 m (wrong by construction); NE-inh inherited wrong eye; AMB displaced
  50 m (secondary only); UNL unlabelled - exclude from metrics.
  Thinning: 16 x 12 grid over W x H; <= --max points taken round-robin over cells in original order (deterministic).
"""
from __future__ import annotations

import argparse
import math

import geo_common as G
import numpy as np

GX, GY = 16, 12


def thin(uv, W, H, cap):
    n = len(uv)
    if n <= cap:
        return np.arange(n)
    cx = np.clip((uv[:, 0] / W * GX).astype(int), 0, GX - 1)
    cy = np.clip((uv[:, 1] / H * GY).astype(int), 0, GY - 1)
    cell = cy * GX + cx
    buckets = [list(np.nonzero(cell == c)[0]) for c in range(GX * GY)]
    out, k = [], 0
    while len(out) < cap:
        took = False
        for b in buckets:
            if k < len(b):
                out.append(b[k])
                took = True
                if len(out) == cap:
                    break
        if not took:
            break
        k += 1
    return np.array(sorted(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=400)
    a = ap.parse_args()
    photos = G.e1_photos()
    prim = {h["hid"]: h for h in G.e1_hyps(False)}
    full = {h["hid"]: h for h in G.e1_hyps(True)}
    allh = list(prim.values()) + [h for k, h in full.items() if k not in prim]
    by = {}
    for h in allh:
        by.setdefault(h["pid"], []).append(h)
    G.OUT.joinpath("decoys").mkdir(parents=True, exist_ok=True)
    tot = {}
    for pid in sorted(by):
        G.assert_dev(pid)
        ph = photos[pid]
        st = G.e1_state(pid)
        s = ph["stated"]
        doc = {"format": "geocam-decoys/1", "pid": pid, "source": "tools/research/fund/e1_acontrario",
               "stated": s, "positionSource": ph.get("positionSource"), "vfov0": st["vfov0"],
               "focalKnown": st.get("focalKnown"), "refs": [], "hyps": []}
        for v in ph.get("V") or []:
            e, n = G.enu_offset(s["lat"], s["lon"], v["eye"]["lat"], v["eye"]["lon"])
            doc["refs"].append({"pose": v["pose"], "eye": v["eye"], "eyeEnu": [e, n, v["eye"]["h"]], "from": v.get("from")})
        WH = None
        for h in by[pid]:
            z = G.load_corr(h["corrPath"])
            if WH is None:
                WH = (z["W"], z["H"])
            assert (z["W"], z["H"]) == WH, f"{h['hid']}: pixel frame differs"
            e, n = G.enu_offset(s["lat"], s["lon"], h["eye"]["lat"], h["eye"]["lon"])
            eye = np.array([e, n, z["eye"][2]])
            X = z["X"] + np.array([e, n, 0.0])
            keep = thin(z["x2d"], z["W"], z["H"], a.max)
            label = h["label"]
            sec = h["hid"] not in prim
            if sec and label == "UNL" and h["kind"] == "DISP" and h.get("dist") == 50 and ph.get("Pref"):
                label = "AMB"
            mis = h.get("misfit") or {}
            doc["hyps"].append({
                "id": h["hid"], "kind": h["kind"], "label": label, "secondary": sec, "eye": h["eye"],
                "eyeEnu": [round(float(x), 3) for x in eye],
                "eyeOffsetM": [round(float(e), 3), round(float(n), 3), round(float(z["eye"][2] - s["h"]), 3)],
                "dispDistM": h.get("dist"), "pose": h["pose"], "nCorr": int(len(z["x2d"])), "nKept": int(len(keep)),
                "uv": np.round(z["x2d"][keep], 2).tolist(), "xyz": np.round(X[keep], 2).tolist(),
                "dist": np.round(np.linalg.norm(X[keep] - eye, axis=1), 1).tolist(),
                "e1": {"log10NFA": h.get("log10NFA"), "T": h.get("T"), "Tfit": h.get("Tfit"), "accept": h.get("accept"),
                       "misfitMedPx": mis.get("medPx")}})
            tot[label] = tot.get(label, 0) + 1
        doc["W"], doc["H"] = WH
        doc["f0Px"] = (WH[1] / 2) / math.tan(math.radians(st["vfov0"]) / 2)
        G.jdump(doc, G.OUT / "decoys" / f"{pid}.json")
    print(f"wrote {len(by)} photos to {G.OUT / 'decoys'}; hypotheses by label: {tot}")


if __name__ == "__main__":
    main()
