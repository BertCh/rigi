"""DEM-prompted depth, exploration: LingBot-Depth-DC (Apache-2.0, robbyant/lingbot-depth-postrain-dc-vitl14) fed the DEM
z-depth on terrain pixels as the sparse metric prompt. DEV ids only; the TM dev cache supplies the DEM (correct-ref view
xyz) and the MoGe-2 depth (x2_geom, 768 wide) supplies the terrain/object split that decides where to prompt.

Prompt pixels = Terrain under the MoGe+curve split (tools/nearfield/spike/place.py) with DEM range in [15, 3000] m, on
the "prompt" half of a 32-px checkerboard (the other half is held out for evaluation, eval.py). Variants:
  terr     prompt = DEM z on held-in Terrain pixels
  terrN    same, depth prompt divided by S = median(prompt)/3 before the model and multiplied back (tests whether the
           indoor-trained model needs the indoor range)
  none     no prompt at all (the model's own monocular depth; the depth input is all zero)
Writes cache/<pid>.<variant>.npz with depth (z, 768 grid, float32, nan invalid), mask, prompt mask.

    tools/matcher/.venv/bin/python tools/nearfield/depthprompt/run_lingbot.py [--variants terr,terrN,none] [ids...]
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
NF = HERE.parent
ROOT = NF.parents[1]
sys.path.insert(0, str(NF / "service"))
import _env  # noqa: E402,F401  (paths + stubs: xformers etc.)

# the service stubs xformers with a MagicMock; LingBot's DINOv2 layers must see it as absent to use plain attention
for _m in ("xformers", "xformers.ops", "xformers.ops.fmha"):
    sys.modules[_m] = None  # type: ignore[assignment]

sys.path.insert(0, str(HERE / "lingbot-depth"))
sys.path.insert(0, str(NF / "spike"))
import place as P  # noqa: E402

C = P.C
tm_common = P.tm_common
CACHE = HERE / "cache"
WEIGHTS = HERE / "weights/lingbot-dc/model.pt"
BLOCK = 32


def checker(h, w, block=BLOCK):
    jj, ii = np.mgrid[0:h, 0:w]
    return ((jj // block + ii // block) % 2) == 0  # True = prompt half


def dem_z_on(rec, h, w):
    """DEM z-depth (m) on an h×w grid with the photo's framing (nearest xyz sample); nan where no DEM hit."""
    dem = C.depth(rec)  # xyz grid ray length
    s = rec["files"]["xyz"]["stride"]
    gh, gw = dem.shape
    jj, ii = np.mgrid[0:h, 0:w]
    u = (ii + 0.5) / w * rec["W"]
    v = (jj + 0.5) / h * rec["H"]
    xi = np.clip(np.floor(u / s).astype(int), 0, gw - 1)
    yi = np.clip(np.floor(v / s).astype(int), 0, gh - 1)
    k = rec["intrinsics"]
    rf = np.sqrt(1 + ((u - k["cx"]) / k["fx"]) ** 2 + ((v - k["cy"]) / k["fy"]) ** 2)
    return dem[yi, xi] / rf, (xi, yi)


def terrain_mask_xyz(pid, rec, dem):
    """Terrain class on the xyz grid from the MoGe-2 + curve split (+ grounding drop), exactly as place.py."""
    g = P.load_depth(pid, "moge_l")
    ray, valid = P.model_on_grid(g, rec, "solved")
    cand = np.isfinite(dem) & np.isfinite(ray) & (dem >= 15) & (dem <= 3000)
    if cand.sum() < 200:
        return None, None
    cv = P.fit_curve(ray[cand], dem[cand])
    cls = P.split(dem, P.apply_curve(cv, ray), valid)
    P.ground(cls, ray, dem, cv, dict(P.GROUND, upright=2.0))  # reclassifies receding bands to Terrain
    return cls, cv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--variants", default="terr,terrN,none")
    ap.add_argument("--width", type=int, default=768)
    ap.add_argument("--res-level", type=int, default=9)
    a = ap.parse_args()
    import torch
    from mdm.model.dinov2_rgbd.layers import block as _blk
    from mdm.model.v2 import MDMModel

    # without xformers the nested-tensor path is unavailable; with batch 1 the list holds one sequence, so running the
    # plain block on it is exact
    _plain = _blk.Block.forward

    def _fwd(self, x):
        if isinstance(x, list):
            return [_plain(self, t) for t in x]
        return _plain(self, x)

    _blk.NestedTensorBlock.forward = _fwd

    CACHE.mkdir(parents=True, exist_ok=True)
    dev = set(tm_common.dev_ids())
    import json

    raw = json.load(open(ROOT / "tools/nearfield/spike/results_raw.json"))
    ids = a.ids or sorted(raw)
    variants = a.variants.split(",")
    with tm_common.gpu_lock():
        device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
        t0 = time.time()
        model = MDMModel.from_pretrained(str(WEIGHTS)).to(device).eval()
        print("loaded", device, f"{time.time() - t0:.1f}s", flush=True)
        for pid in ids:
            assert pid in dev, f"{pid} not dev"
            m = C.load_meta(pid)
            if not m["correct_refs"]:
                continue
            rec = C.load_view(pid, "refs", m["perturbBase"])
            dem = C.depth(rec)
            ph = Image.open(tm_common.CACHE / pid / "photo.jpg").convert("RGB")
            w = a.width
            h = round(w * ph.height / ph.width)
            rgb = np.asarray(ph.resize((w, h), Image.BILINEAR))
            zdem, (xi, yi) = dem_z_on(rec, h, w)
            cls_xyz, _ = terrain_mask_xyz(pid, rec, dem)
            if cls_xyz is None:
                print(pid, "no anchor fit (no DEM candidates in 15-3000 m): skipped", flush=True)
                continue
            terr = (cls_xyz[yi, xi] == P.TERRAIN) & np.isfinite(zdem)
            rng = dem[yi, xi]
            terr &= (rng >= 15) & (rng <= 3000)
            prompt = terr & checker(h, w)
            k = rec["intrinsics"]
            K = torch.tensor([[k["fx"] / rec["W"], 0, k["cx"] / rec["W"]], [0, k["fy"] / rec["H"], k["cy"] / rec["H"]],
                              [0, 0, 1]], dtype=torch.float32, device=device)[None]
            img = torch.tensor(rgb / 255, dtype=torch.float32, device=device).permute(2, 0, 1)[None]
            for var in variants:
                out = CACHE / f"{pid}.{var}.npz"
                if out.exists():
                    continue
                din = np.zeros((h, w), np.float32)
                S = 1.0
                if var in ("terr", "terrN"):
                    din[prompt] = zdem[prompt]
                    if var == "terrN" and prompt.any():
                        S = float(np.median(zdem[prompt])) / 3.0
                        din /= S
                t1 = time.time()
                with torch.no_grad():
                    o = model.infer(img, depth_in=torch.tensor(din, device=device)[None], intrinsics=K,
                                    resolution_level=a.res_level, use_fp16=False)
                d = o["depth"][0].float().cpu().numpy() * S
                msk = o["mask"][0].cpu().numpy() if "mask" in o else np.isfinite(d)
                d = np.where(np.isfinite(d) & (d > 0), d, np.nan).astype(np.float32)
                np.savez_compressed(out, depth=d, mask=msk.astype(bool), prompt=prompt, S=S,
                                    seconds=time.time() - t1)
                print(pid, var, f"{time.time() - t1:.1f}s", "prompt px", int(prompt.sum()), "S", round(S, 2),
                      "med z", float(np.nanmedian(d)), flush=True)
            if device.type == "mps":
                torch.mps.empty_cache()


if __name__ == "__main__":
    main()
