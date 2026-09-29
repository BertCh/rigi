"""Leave-one-out novel-view comparison for a roll spot (Step Inside P2).

For every photo h of the spot, splats built WITHOUT h are rendered from h's pose (tools/nearfield/roll/splatrender.py)
and compared with the photo on its near field:
    eval mask = DEM range (the map's own range buffer through h's pose) in (0, --near] m, minus people (dilated).
Methods (whatever exists in out/<spot>/):
    fast          fold_h/fast.ply              DA3 /multiview with the Rigi poses -> DEM-anchored lifts -> voxel merge
    fast-moge2    fold_h/fast-moge2.ply        same fusion, per-photo MoGe-2 depth
    brush         fold_h/brush_out/brush.ply   Brush, init = fast, trained on the other photos
    brush-moge2   fold_h/brush_out/brush-moge2.ply
    fast-joint    fold_h/fast-multiview-joint.ply  DA3 /multiview WITHOUT poses, one rigid reconstruction placed in ENU
    brush-joint   fold_h/brush_out/brush-multiview-joint.ply
    single-best   single_<o>.ply, o != h       single-photo MoGe-2 lift of ONE other photo; the best o by PSNR (an
                                               oracle choice, so optimistic), also reported: single-mean
Metrics on the mask: PSNR (uncovered pixels show the grey background, so they count against a method), SSIM (mean
of the SSIM map over the mask), coverage (rendered alpha > 0.5), and PSNR on covered-by-all pixels.

    tools/matcher/.venv/bin/python tools/nearfield/roll/loo.py [--spot region-0-vp4] [--near 150]
Writes out/<spot>/loo.json and tools/nearfield/shots/roll-loo-<h>.png panels.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage  # noqa: F401  (optional; falls back below)

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from splatrender import load_ply, read_colmap_text, render  # noqa: E402

BG = (0.5, 0.5, 0.5)


def ssim_map(a: np.ndarray, b: np.ndarray, sigma: float = 1.5) -> np.ndarray:
    """Per-pixel SSIM on luma (Gaussian window, standard constants, data range 1)."""
    from scipy.ndimage import gaussian_filter as gf

    ya = a @ np.array([0.299, 0.587, 0.114])
    yb = b @ np.array([0.299, 0.587, 0.114])
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    ma, mb = gf(ya, sigma), gf(yb, sigma)
    va = gf(ya * ya, sigma) - ma * ma
    vb = gf(yb * yb, sigma) - mb * mb
    cov = gf(ya * yb, sigma) - ma * mb
    return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))


def psnr(a, b, m):
    if not m.any():
        return None
    mse = float(((a[m] - b[m]) ** 2).mean())
    return round(10 * np.log10(1 / max(mse, 1e-10)), 2)


def dilate(m: np.ndarray, r: int) -> np.ndarray:
    from scipy.ndimage import binary_dilation

    return binary_dilation(m, iterations=r) if r > 0 else m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spot", default="region-0-vp4")
    ap.add_argument("--near", type=float, default=150.0)
    a = ap.parse_args()
    spot = HERE / "out" / a.spot
    shots = HERE.parent / "shots"
    meta = json.loads((spot / "meta.json").read_text())
    ids = meta["ids"]
    singles = {i: load_ply(str(spot / f"single_{i}.ply")) for i in ids if (spot / f"single_{i}.ply").exists()}
    res = {"spot": a.spot, "near": a.near, "ids": ids, "folds": {}}
    for h in ids:
        ej = json.loads((spot / "eval" / f"{h}.json").read_text())
        W, H = ej["width"], ej["height"]
        cam = read_colmap_text(ej["cameras"], ej["images"])[0]
        photo = np.asarray(Image.open(spot / "eval" / f"{h}.png").convert("RGB"), np.float64) / 255
        rng = np.fromfile(spot / "eval" / f"{h}.range.f32", np.float32).reshape(H, W)
        mask = (rng > 0) & (rng <= a.near)
        ppl = np.zeros((H, W), bool)
        if ej.get("people"):
            pm = np.fromfile(spot / "eval" / f"{h}.people.u8", np.uint8).reshape(ej["people"]["height"], ej["people"]["width"])
            ppl = np.asarray(Image.fromarray(pm).resize((W, H), Image.NEAREST)) >= 128
            ppl = dilate(ppl, 4)
        mask &= ~ppl
        fold = spot / f"fold_{h}"
        methods = {}
        for name, p in (("fast", fold / "fast.ply"), ("fast-moge2", fold / "fast-moge2.ply"),
                        ("fast-joint", fold / "fast-multiview-joint.ply"),
                        ("brush", fold / "brush_out/brush.ply"), ("brush-moge2", fold / "brush_out/brush-moge2.ply"),
                        ("brush-joint", fold / "brush_out/brush-multiview-joint.ply")):
            if p.exists():
                methods[name] = load_ply(str(p))
        per_single = {}
        for o, c in singles.items():
            if o != h and len(c["means"]):
                per_single[o] = c
        renders, rows = {}, {}
        for name, c in [*methods.items(), *[(f"single:{o}", c) for o, c in per_single.items()]]:
            if not len(c["means"]):
                continue
            rgb, al, _ = render(c, cam, bg=BG)
            renders[name] = (rgb, al)
        sm_cache = {}
        for name, (rgb, al) in renders.items():
            cov = al > 0.5
            sm = ssim_map(rgb, photo)
            sm_cache[name] = sm
            rows[name] = {"psnr": psnr(rgb, photo, mask), "ssim": round(float(sm[mask].mean()), 4) if mask.any() else None,
                          "coverage": round(float(cov[mask].mean()), 4) if mask.any() else None,
                          "splats": int(len((methods.get(name) or per_single.get(name.split(":")[-1]) or {"means": []})["means"]))}
        # single-best (oracle) and single-mean
        sn = [n for n in rows if n.startswith("single:") and rows[n]["psnr"] is not None]
        if sn:
            best = max(sn, key=lambda n: rows[n]["psnr"])
            rows["single-best"] = {**rows[best], "photo": best.split(":")[1]}
            rows["single-mean"] = {k: round(float(np.mean([rows[n][k] for n in sn])), 4) for k in ("psnr", "ssim", "coverage")}
        # PSNR / SSIM on the pixels every fused method covers (fair on content, ignores coverage)
        fused = [n for n in renders if not n.startswith("single:")]
        if sn:
            fused.append(rows["single-best"]["photo"] and f"single:{rows['single-best']['photo']}")
        common = mask.copy()
        for n in fused:
            common &= renders[n][1] > 0.5
        for n in fused:
            key = "single-best" if n.startswith("single:") else n
            rows[key]["psnr_common"] = psnr(renders[n][0], photo, common)
            rows[key]["ssim_common"] = round(float(sm_cache[n][common].mean()), 4) if common.any() else None
        res["folds"][h] = {"maskFrac": round(float(mask.mean()), 4), "commonFrac": round(float(common.mean()), 4),
                           "methods": {k: v for k, v in rows.items() if not k.startswith("single:")},
                           "singles": {k.split(":")[1]: v for k, v in rows.items() if k.startswith("single:")}}
        # panel: photo (mask outlined) | methods
        tiles = [("photo + eval mask", np.where(mask[..., None], photo, photo * 0.35))]
        for n in fused:
            tiles.append((n if not n.startswith("single:") else f"single-best ({n.split(':')[1]})", renders[n][0]))
        th = 240
        tw = int(th * W / H)
        canvas = Image.new("RGB", (tw * len(tiles), th + 18), (20, 20, 20))
        d = ImageDraw.Draw(canvas)
        for k, (label, img) in enumerate(tiles):
            canvas.paste(Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).resize((tw, th)), (k * tw, 18))
            r = rows.get("single-best" if label.startswith("single-best") else label)
            extra = f"  {r['psnr']} dB / {r['ssim']} / cov {r['coverage']}" if r and r.get("psnr") is not None else ""
            d.text((k * tw + 4, 3), label + extra, fill=(230, 230, 230))
        canvas.save(shots / f"roll-loo-{h}.png")
        print(h, json.dumps(res["folds"][h]["methods"]))
    (spot / "loo.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
