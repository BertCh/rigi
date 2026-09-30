"""POST HOC analyses (decided after seeing out/result.json; NOT the frozen METHOD.txt result).

  P1  Occluder columns: drop columns of C_B where the photo skyline is > 25 px ABOVE every compared DEM skyline
      (GT and both propagated poses): a person/hair/fence poking above the terrain line. Refit F_B + bootstrap.
  P2  Parallax simulation with DEM hits nearer than 500 m dropped (rays from a 1.6 m DEM eye at a cliff-edge
      lookout hit the DEM plateau within metres instead of the matched far terrain).
  P3  Error vectors in B's camera frame (deg about x = pitch-like, y = yaw-like, z = roll) for rot vs GT, rot vs F,
      and parallax vs GT, so directions can be compared, not just magnitudes.
  P4  Parallax-corrected, F-anchored implied poses: R_B = Cpar^T . relR_rot . R_F_A with Cpar = R_par . relR_GT^T
      (the parallax error rotation from P2; identity where not simulated), for anchors whose F is well
      conditioned (7063, 7068). Compared with GT_B and F_B, and scored on B's skyline (same C_B, GT focal).
  The same decision rule as METHOD.txt is then applied to P1/P2 numbers, labelled POST HOC.

    tools/matcher/.venv/bin/python tools/nearfield/propagate/render_check/posthoc.py
"""
from __future__ import annotations

import json
import math

import cv2
import numpy as np

import check as c

OCC_PX = 25.0
MIN_HIT = 500.0


def rotvec_deg(R):
    return (cv2.Rodrigues(np.asarray(R, float))[0].ravel() / c.D).tolist()


def main():
    frozen = json.loads((c.OUT / "result.json").read_text())
    R_GT = {k: c.pose_to_R(c.gt_pose(k)) for k in c.IDS}
    prop = {(r["A"], r["B"]): np.asarray(r["rot"]["relR"]) @ R_GT[r["A"]] for r in c.PAIRS}
    out = {"label": "POST HOC", "occPx": OCC_PX, "minHitM": MIN_HIT, "targets": {}, "pairs": []}
    F = {}
    CS = {}
    for B in c.IDS:
        f = c.focal_w(B)
        anchors = [A for A in c.IDS if A != B]
        C = c.eligible(B, R_GT[B], f)
        for A in anchors:
            C &= c.eligible(B, prop[(A, B)], f)
        pr = c.photo_rows(B)
        C &= np.isfinite(pr)
        C0 = C.copy()
        lines = [c.dem_rows(B, R_GT[B], f)[0]] + [c.dem_rows(B, prop[(A, B)], f)[0] for A in anchors]
        occ = np.all([pr < ln - OCC_PX for ln in lines], axis=0)
        C &= ~occ
        CS[B] = C
        t = {"C_frozen": int(C0.sum()), "C": int(C.sum()), "occDropped": int((C0 & occ).sum())}
        t["GT"] = c.residual(B, R_GT[B], f, C)
        for A in anchors:
            t[f"prop_{A}_gtf"] = c.residual(B, prop[(A, B)], f, C)
            t[f"prop_{A}_exif"] = c.residual(B, prop[(A, B)], c.focal_w(B, c.META[B]["vfov"]), C)
        starts = [c.gt_pose(B)] + [c.R_to_pose(prop[(A, B)], c.gt_pose(B)["vfov"]) for A in anchors]
        pF, _ = c.fit(B, starts, C)
        F[B] = c.pose_to_R(pF)
        t["F"] = {**pF, **c.residual(B, F[B], f, C)}
        t["F_vs_GT"] = {"geod": c.geod(F[B], R_GT[B]), "dyaw": (pF["yaw"] - c.GT[B]["yaw"] + 180) % 360 - 180,
                        "dpitch": pF["pitch"] - c.GT[B]["pitch"], "droll": pF["roll"] - c.GT[B]["roll"]}
        idx = np.nonzero(C)[0]
        rng = np.random.default_rng(0)
        nb = int(math.ceil(len(idx) / 32))
        bs = []
        for _ in range(200):
            s0 = rng.integers(0, max(1, len(idx) - 32 + 1), nb)
            cols = np.concatenate([idx[s:s + 32] for s in s0])[: len(idx)]
            pb, _ = c.fit(B, [pF], C, cols=cols)
            bs.append(c.geod(c.pose_to_R(pb), F[B]))
        t["F_boot_geodRms"] = float(np.sqrt(np.mean(np.square(bs))))
        z = c.eye_z(B) + 15.0
        pFz, _ = c.fit(B, [pF], C, z=z)
        t["Fz_geodVsF"] = c.geod(c.pose_to_R(pFz), F[B])
        out["targets"][B] = t
        print(B, "C", t["C_frozen"], "->", t["C"], "r GT", round(t["GT"]["r"], 2),
              {A: round(t[f"prop_{A}_gtf"]["r"], 2) for A in anchors}, "F r", round(t["F"]["r"], 2),
              "F-GT", {k: round(v, 2) for k, v in t["F_vs_GT"].items()}, "boot", round(t["F_boot_geodRms"], 3),
              "eye+15", round(t["Fz_geodVsF"], 2), flush=True)

    par = c.parallax_pairs(min_hit=MIN_HIT)
    for p in par:
        A, B = p["A"], p["B"]
        relRot = np.asarray([r for r in c.PAIRS if r["A"] == A and r["B"] == B][0]["rot"]["relR"])
        relGT = R_GT[B] @ R_GT[A].T
        relF = F[B] @ F[A].T
        Rpar = np.asarray(p.pop("Rpar"))
        p["dF"] = c.geod(relRot, relF)
        p["dGF"] = c.geod(relGT, relF)
        p["vec_rot_vs_GT"] = rotvec_deg(relRot @ relGT.T)
        p["vec_rot_vs_F"] = rotvec_deg(relRot @ relF.T)
        p["vec_par_vs_GT"] = rotvec_deg(Rpar @ relGT.T) if np.isfinite(Rpar).all() else None
        p["vec_F_vs_GT"] = rotvec_deg(relF @ relGT.T)
        p["residualAfterParAndF"] = (c.geod(np.asarray(Rpar) @ relGT.T @ relF, relRot) if np.isfinite(Rpar).all() else None)
        Cpar = Rpar @ relGT.T if np.isfinite(Rpar).all() else np.eye(3)
        if A != "IMG_7059":
            Rimp = Cpar.T @ relRot @ F[A]
            fB = c.focal_w(B)
            CB = CS[B]
            p["implied"] = {"parallaxCorrected": bool(np.isfinite(Rpar).all()),
                            "geodVsGT_B": c.geod(Rimp, R_GT[B]), "geodVsF_B": c.geod(Rimp, F[B]),
                            "pose": c.R_to_pose(Rimp, c.gt_pose(B)["vfov"]),
                            "r": c.residual(B, Rimp, fB, CB)["r"], "rGT": c.residual(B, R_GT[B], fB, CB)["r"],
                            "rUncorrected": c.residual(B, relRot @ F[A], fB, CB)["r"]}
        out["pairs"].append(p)
    fz = {k: round(v, 3) for k, v in frozen["medians"].items()}
    out["frozenMedians"] = fz

    def meds(ps):
        return {k: float(np.nanmedian([p[k] for p in ps])) for k in ("dGT", "dF", "dGF", "biasPar", "dRotPar")}

    out["medians_all6"] = meds(out["pairs"])
    ok = [p for p in out["pairs"] if "IMG_7059" not in (p["A"], p["B"])]
    out["medians_63_68"] = meds(ok)
    ts = out["targets"]
    m = out["medians_all6"]
    prec_ok = all(t["F_boot_geodRms"] <= 0.5 for t in ts.values()) and all(t["C"] >= 100 for t in ts.values())
    gt_err = m["dF"] <= 0.5 * m["dGT"] and m["biasPar"] <= 0.5 * m["dGT"] and all(t["F"]["r"] < t["GT"]["r"] for t in ts.values())
    parx = m["biasPar"] >= 0.5 * m["dGT"] and m["dRotPar"] <= 0.5 * m["dGT"]
    if not prec_ok:
        d = "INCONCLUSIVE (fit precision / coverage)"
    elif gt_err and parx:
        d = "MIXED"
    elif gt_err:
        d = "GT ERROR"
    elif parx:
        d = "PARALLAX"
    elif m["dF"] >= 0.8 * m["dGT"] and m["biasPar"] < 0.5 * m["dGT"]:
        d = "OTHER MATCHER BIAS"
    else:
        d = "INCONCLUSIVE"
    out["decisionPostHoc"] = d
    for p in out["pairs"]:
        print(f"{p['A']}->{p['B']} base {p['baselineM']:.0f} hits {p['hits']} near-dropped {p['nearDropped']} "
              f"par med {p['parallaxMedianDeg']:.3f} dGT {p['dGT']:.2f} dF {p['dF']:.2f} dGF {p['dGF']:.2f} "
              f"biasPar {p['biasPar']:.2f} dRotPar {p['dRotPar']:.2f} | rot-GT {np.round(p['vec_rot_vs_GT'], 2)} "
              f"par-GT {None if p['vec_par_vs_GT'] is None else np.round(p['vec_par_vs_GT'], 2)} "
              f"rot-F {np.round(p['vec_rot_vs_F'], 2)} F-GT {np.round(p['vec_F_vs_GT'], 2)}")
    for p in out["pairs"]:
        if "implied" in p:
            i = p["implied"]
            print(f"P4 {p['A']}->{p['B']} implied(corr={i['parallaxCorrected']}) vs GT {i['geodVsGT_B']:.2f} vs F {i['geodVsF_B']:.2f} "
                  f"r {i['r']:.2f} (uncorrected {i['rUncorrected']:.2f}, GT {i['rGT']:.2f}) pose {({k: round(v, 2) for k, v in i['pose'].items()})} "
                  f"resid after par+F {p['residualAfterParAndF']}")
    print("medians all6", {k: round(v, 3) for k, v in out["medians_all6"].items()})
    print("medians 63/68", {k: round(v, 3) for k, v in out["medians_63_68"].items()})
    print("POST HOC decision (same rule):", d)
    (c.OUT / "posthoc.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
