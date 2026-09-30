"""E0 observability: per-photo geometry predictors from the C0 cache (see PROTOCOL.txt). Writes features.json.
Run: tools/matcher/.venv/bin/python tools/research/fund/e0_observability/compute.py
"""
from __future__ import annotations
import json, math, sys
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.insert(0, str(ROOT / "tools/research/tm"))
sys.path.insert(0, str(ROOT / "tools/research/tm/c0_cache"))
import tm_common as TM  # noqa: E402
import cache_io as C  # noqa: E402

D = math.pi / 180
STEP = 0.25                       # skyline resampling (deg)
NB = int(360 / STEP)
WIDTHS = list(range(2, 61, 2)) + [70, 80, 90, 105, 120, 150, 180]
EXCL = 3.0
BANDS = [(0, 250), (250, 2000), (2000, 10000), (10000, 1e9)]
BNAMES = ["lt250", "m250_2k", "m2k_10k", "gt10k"]
N_MATCH, A0_STEP = 500, 5


def ring_samples(pid, m):
    """All ring terrain samples owned by their nearest ring view: az, el, d, omega, unit b, clipped-az list."""
    eye = np.asarray(m["eye"], float)
    out = {k: [] for k in ("az", "el", "d", "om", "b")}
    clip_az, empty_tags = [], []
    for rec in m["views"]["ring"]:
        tag = rec["tag"]
        v = C.load_view(pid, "ring", tag)
        if v.get("empty"):
            empty_tags.append(tag)
            continue
        xyz = v["xyz"].astype(np.float64)
        ok = (v["xyz"] != 0).any(-1)
        u, vv = C.xyz_pixel_coords(v)
        k = v["intrinsics"]
        x = (u - k["cx"]) / k["fx"]; y = (vv - k["cy"]) / k["fy"]
        cos3 = (1 / np.sqrt(1 + x * x + y * y)) ** 3
        om = 4 * cos3 / (k["fx"] * k["fy"])
        dv = xyz - eye
        az = (np.degrees(np.arctan2(dv[..., 0], dv[..., 1]))) % 360
        el = np.degrees(np.arctan2(dv[..., 2], np.hypot(dv[..., 0], dv[..., 1])))
        yaw = v["pose"]["yaw"]
        rel = (az - yaw + 180) % 360 - 180
        own = ok & (np.abs(rel) <= 7.5)
        # clipped skyline: owned terrain in the top xyz row (each azimuth judged only by its owning view)
        clip_az.extend(az[0][own[0]].tolist())
        dd = np.linalg.norm(dv, axis=-1)
        out["az"].append(az[own]); out["el"].append(el[own]); out["d"].append(dd[own]); out["om"].append(om[own])
        out["b"].append(dv[own] / dd[own][:, None])
        # skyline also from owned samples only (the owning view has the highest top edge at that azimuth)
        out.setdefault("az_all", []).append(az[own]); out.setdefault("el_all", []).append(el[own])
    R = {k: np.concatenate(vv) for k, vv in out.items()}
    return R, np.asarray(clip_az), empty_tags


def skyline(R, clip_az):
    fine = np.full(3600, np.nan)
    idx = (R["az_all"] * 10).astype(int) % 3600
    np.fmax.at(fine, idx, R["el_all"])
    if len(clip_az):
        fine[(clip_az * 10).astype(int) % 3600] = np.nan
    # resample to 0.25 deg: max of the 0.1 bins overlapping (nan if any invalid)
    S = np.full(NB, np.nan)
    for j in range(NB):
        a, b = j * STEP * 10, (j + 1) * STEP * 10
        seg = fine[int(math.floor(a)):int(math.ceil(b))]
        if len(seg) and np.all(np.isfinite(seg)):
            S[j] = seg.max()
    return S


def minres_table(S, a0_list):
    """min over wrong azimuths of the offset-removed RMS residual, for each (a0, width). nan = undefined."""
    ext = np.concatenate([S, S])
    out = np.full((len(a0_list), len(WIDTHS)), np.nan)
    cand = np.arange(NB)
    for wi, w in enumerate(WIDTHS):
        n = int(round(w / STEP)) + 1
        half = (n - 1) // 2
        # M[a, t] = S[a - half + t]
        starts = (cand - half) % NB
        M = ext[(starts[:, None] + np.arange(n)[None, :])]
        Mv = np.isfinite(M)
        for ai, a0 in enumerate(a0_list):
            j0 = int(round(a0 / STEP)) % NB
            P = M[j0]
            pv = np.isfinite(P)
            if pv.mean() < 0.7:
                continue
            both = Mv & pv[None, :]
            cnt = both.sum(1)
            dif = np.where(both, M - np.where(pv, P, 0)[None, :], 0.0)
            mu = dif.sum(1) / np.maximum(cnt, 1)
            var = (np.where(both, (dif - mu[:, None]) ** 2, 0).sum(1)) / np.maximum(cnt, 1)
            r = np.sqrt(var)
            circ = np.abs(((cand - j0) * STEP + 180) % 360 - 180)
            use = (circ > EXCL) & (cnt >= 0.7 * n)
            out[ai, wi] = r[use].min() if use.any() else np.inf
    return out


def wstar(row, floor):
    if np.all(np.isnan(row)):
        return np.nan
    for w, r in zip(WIDTHS, row):
        if np.isfinite(r) and r > floor or r == np.inf:
            return float(w)
    return 360.0


def fisher_rows(b, d):
    """per-sample 6x6 J^T J summed over the 2 tangent directions (rotation first, then eye)."""
    z = np.array([0, 0, 1.0])
    t1 = np.cross(b, z); t1 /= np.linalg.norm(t1, axis=1, keepdims=True) + 1e-12
    t2 = np.cross(b, t1)
    F = np.zeros((len(b), 6, 6))
    for t in (t1, t2):
        J = np.concatenate([np.cross(b, t), -t / d[:, None]], 1)
        F += J[:, :, None] * J[:, None, :]
    return F


def binned(R, vb):
    """Per 1-deg azimuth bin sums: I per band, omega (all, >=250), Fisher (all, >=250)."""
    keep = np.abs(R["el"]) <= vb
    az, d, om, b = R["az"][keep], R["d"][keep], R["om"][keep], R["b"][keep]
    k = az.astype(int) % 360
    I = np.zeros((360, 4))
    for bi, (lo, hi) in enumerate(BANDS):
        s = (d >= lo) & (d < hi)
        np.add.at(I[:, bi], k[s], om[s] / d[s] ** 2)
    Om = np.zeros((360, 2)); Fi = np.zeros((360, 2, 6, 6))
    far = d >= 250
    np.add.at(Om[:, 0], k, om); np.add.at(Om[:, 1], k[far], om[far])
    for c0 in range(0, len(d), 200000):
        sl = slice(c0, c0 + 200000)
        Fs = fisher_rows(b[sl], d[sl]) * om[sl, None, None]
        np.add.at(Fi[:, 0], k[sl], Fs); fr = far[sl]
        np.add.at(Fi[:, 1], k[sl][fr], Fs[fr])
    return I, Om, Fi


def crb(Fsum, omsum, om_px):
    if omsum <= 0:
        return np.nan, np.nan
    sig = math.sqrt(om_px)
    F = Fsum * (N_MATCH / omsum) / sig ** 2
    A, B, Cm = F[:3, :3], F[:3, 3:], F[3:, 3:]
    try:
        S = Cm - B.T @ np.linalg.solve(A, B)
        cov = np.linalg.inv(S)
    except np.linalg.LinAlgError:
        return np.inf, np.inf
    return float(math.sqrt(max(cov[0, 0] + cov[1, 1], 0))), float(math.sqrt(max(cov[2, 2], 0)))


def window_feats(I, Om, Fi, a0, hf, om_px):
    c = np.arange(360) + 0.5
    sel = np.abs((c - a0 + 180) % 360 - 180) <= hf / 2
    Ib = I[sel].sum(0) / om_px
    sh, su = crb(Fi[sel, 1].sum(0), Om[sel, 1].sum(), om_px)
    sha, sua = crb(Fi[sel, 0].sum(0), Om[sel, 0].sum(), om_px)
    return Ib, (sh, su, sha, sua), Om[sel, 0].sum() / om_px


def ref_feats(pid, m, label):
    v = C.load_view(pid, "refs", label)
    ok = (v["xyz"] != 0).any(-1)
    xyz = v["xyz"].astype(np.float64)[ok]
    eye = np.asarray(v["eye"], float)
    u, vv = C.xyz_pixel_coords(v)
    k = v["intrinsics"]
    x = (u[ok] - k["cx"]) / k["fx"]; y = (vv[ok] - k["cy"]) / k["fy"]
    om = 4 * (1 / np.sqrt(1 + x * x + y * y)) ** 3 / (k["fx"] * k["fy"])
    om_px = 1 / (k["fx"] * k["fy"])
    dv = xyz - eye; d = np.linalg.norm(dv, axis=1); b = dv / d[:, None]
    Ib = np.array([(om[(d >= lo) & (d < hi)] / d[(d >= lo) & (d < hi)] ** 2).sum() for lo, hi in BANDS]) / om_px
    Fs = fisher_rows(b, d) * om[:, None, None]
    far = d >= 250
    sh, su = crb(Fs[far].sum(0), om[far].sum(), om_px)
    sha, sua = crb(Fs.sum(0), om.sum(), om_px)
    return Ib, (sh, su, sha, sua), float(ok.mean())


def pack(Ib, cr):
    tot = float(Ib.sum())
    d = {n: float(x) for n, x in zip(BNAMES, Ib)}
    d.update(I_tot=tot, I_no250=tot - float(Ib[0]), f250=float(Ib[0] / tot) if tot > 0 else np.nan,
             crb_h_match=cr[0], crb_up_match=cr[1], crb_h_all=cr[2], crb_up_all=cr[3])
    return d


def main():
    tax = json.load(open(ROOT / "tools/research/tm/f1_autopsy/taxonomy.json"))["photos"]
    ids = TM.dev_ids()
    if len(sys.argv) > 1: ids = sys.argv[1:]
    res = {}
    for pid in ids:
        TM.assert_dev(pid)
        m = C.load_meta(pid)
        hf, vf0, asp = m["hfov0"], m["vfov0"], m["aspect"]
        Wl = 1024 if asp >= 1 else 1024 * asp
        om_px = (2 * math.tan(hf / 2 * D) / Wl) ** 2
        ringvf = m["ring"]["vfov"]
        vb = min(vf0 / 2, math.degrees(math.atan(math.tan(ringvf / 2 * D) * math.cos(20 * D))))
        R, clip_az, empty = ring_samples(pid, m)
        S = skyline(R, clip_az)
        ref = m.get("perturbBase")
        ref_yaw = next((r["pose"]["yaw"] for r in m["correct_refs"] if r["label"] == ref), None) if ref else None
        head = m.get("headingDeg")
        a0s = [float(a) for a in range(0, 360, A0_STEP)]
        extra = {"heading": head, "ref": ref_yaw}
        a0_all = a0s + [v % 360 for v in extra.values() if v is not None]
        tab = minres_table(S, a0_all)
        I, Om, Fi = binned(R, vb)
        rec = {"pid": pid, "hfov0": hf, "vfov0": vf0, "vb": vb, "heading": head, "ref": ref, "ref_yaw": ref_yaw,
               "sky_invalid_frac": float(np.isnan(S).mean()), "empty_ring": empty,
               "minres_A": tab[:len(a0s)].tolist(), "widths": WIDTHS}
        # A: azimuth-agnostic
        fe = [window_feats(I, Om, Fi, a, hf, om_px) for a in a0s]
        IbA = np.mean([f[0] for f in fe], 0)
        crA = tuple(float(np.nanmedian([f[1][j] for f in fe])) for j in range(4))
        rec["A"] = pack(IbA, crA)
        rec["A"]["terr_px"] = float(np.mean([f[2] for f in fe]))
        j = len(a0s)
        for key in ("heading", "ref"):
            if extra[key] is None:
                continue
            a = extra[key] % 360
            Ib, cr, tp = window_feats(I, Om, Fi, a, hf, om_px)
            rec["B_heading" if key == "heading" else "ring_at_ref"] = dict(pack(Ib, cr), minres=tab[j].tolist(), terr_px=tp)
            j += 1
        if ref:
            Ib, cr, tf = ref_feats(pid, m, ref)
            rec["C"] = dict(pack(Ib, cr), terr_frac=tf, minres=rec["ring_at_ref"]["minres"])
        res[pid] = rec
        print(pid, tax.get(pid, {}).get("stage", "SUCCESS"), "inval=%.2f" % rec["sky_invalid_frac"],
              "wmed=%s" % np.nanmedian([wstar(r, 0.1) for r in tab[:len(a0s)]]),
              "I_no250=%.3g f250=%.2f crb=%.1f" % (rec["A"]["I_no250"], rec["A"]["f250"], rec["A"]["crb_h_match"]),
              flush=True)
    json.dump(res, open(HERE / "features.json", "w"), indent=1, default=lambda o: None)


if __name__ == "__main__":
    main()
