"""X2 step 1: monocular geometry on the DEV photos (MoGe-2 ViT-L/B normal, DA3-Base).

Outputs x2_geom/geom/<pid>.<model>.npz (float16): depth (H,W) [model units: MoGe metric-ish m; DA3 relative],
mask (bool, model's valid/non-sky mask), normal (H,W,3 camera frame x right, y down, z fwd; MoGe only),
conf (DA3), plus hfov_pred / vfov_pred (deg) and seconds.  Grid: photo resized to width OUT_W.

    python infer.py [--models moge_l,moge_b,da3_b] [--device mps|cpu] [ids...]
Polls the shared cache until ALL_DONE; processes photos whose photo.jpg exists and DONE exists.
"""
from __future__ import annotations
import _env  # noqa: F401
import argparse, json, math, os, sys, time
import numpy as np, torch
from PIL import Image
import tm_common

OUT = _env.HERE / "geom"
OUT_W = 768


def load_photo(pid):
    im = Image.open(tm_common.CACHE / pid / "photo.jpg")
    from PIL import ImageOps
    im = ImageOps.exif_transpose(im).convert("RGB")
    return im


class MoGe:
    def __init__(self, name, device):
        from moge.model.v2 import MoGeModel
        self.m = MoGeModel.from_pretrained(str(_env.WEIGHTS / name / "model.pt")).to(device).eval()
        self.dev = device

    @torch.no_grad()
    def __call__(self, im: Image.Image):
        w, h = im.size
        s = 1024 / max(w, h)
        im2 = im.resize((round(w * s), round(h * s)), Image.BICUBIC)
        x = torch.from_numpy(np.asarray(im2)).float().div(255).permute(2, 0, 1).to(self.dev)
        o = self.m.infer(x, use_fp16=False)
        K = o["intrinsics"].float().cpu().numpy()  # normalised
        hfov = math.degrees(2 * math.atan(0.5 / K[0, 0])); vfov = math.degrees(2 * math.atan(0.5 / K[1, 1]))
        d = o["depth"].float().cpu().numpy(); msk = o["mask"].cpu().numpy().astype(bool)
        nrm = o["normal"].float().cpu().numpy() if "normal" in o else None
        return dict(depth=d, mask=msk, normal=nrm, hfov_pred=hfov, vfov_pred=vfov)


class DA3:
    def __init__(self, name, device):
        from depth_anything_3.api import DepthAnything3
        self.m = DepthAnything3.from_pretrained(str(_env.WEIGHTS / name)).to(device).eval()
        self.dev = device

    @torch.no_grad()
    def __call__(self, im: Image.Image):
        p = self.m.inference([np.asarray(im)], process_res=756)
        d = np.asarray(p.depth[0], np.float32)
        conf = np.asarray(p.conf[0], np.float32) if getattr(p, "conf", None) is not None else None
        K = np.asarray(p.intrinsics[0]) if getattr(p, "intrinsics", None) is not None else None
        H, W = d.shape
        hfov = math.degrees(2 * math.atan(W / 2 / K[0, 0])) if K is not None else None
        vfov = math.degrees(2 * math.atan(H / 2 / K[1, 1])) if K is not None else None
        sky = getattr(p, "sky", None)
        msk = np.isfinite(d) & (d > 0)
        return dict(depth=d, mask=msk, normal=None, conf=conf, hfov_pred=hfov, vfov_pred=vfov)


MODELS = {"moge_l": (MoGe, "moge-2-vitl-normal"), "moge_b": (MoGe, "moge-2-vitb-normal"), "da3_b": (DA3, "DA3-BASE")}


def rs(a, W, H, interp):
    import cv2
    if a is None:
        return None
    return cv2.resize(a.astype(np.float32), (W, H), interpolation=interp)


def save(pid, key, r, sec, im):
    import cv2
    w, h = im.size
    W, H = OUT_W, round(OUT_W * h / w)
    d = r["depth"].astype(np.float32).copy(); d[~np.isfinite(d)] = 0
    out = {"depth": rs(d, W, H, cv2.INTER_NEAREST).astype(np.float16),
           "mask": rs(r["mask"].astype(np.float32), W, H, cv2.INTER_NEAREST) > 0.5,
           "hfov_pred": np.float32(r["hfov_pred"] or np.nan), "vfov_pred": np.float32(r["vfov_pred"] or np.nan),
           "seconds": np.float32(sec)}
    if r.get("normal") is not None:
        n = r["normal"].copy(); n[~np.isfinite(n)] = 0
        out["normal"] = rs(n, W, H, cv2.INTER_NEAREST).astype(np.float16)
    if r.get("conf") is not None:
        out["conf"] = rs(r["conf"], W, H, cv2.INTER_LINEAR).astype(np.float16)
    np.savez_compressed(OUT / f"{pid}.{key}.npz", **out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--models", default="moge_l,moge_b,da3_b")
    ap.add_argument("--device", default="mps")
    ap.add_argument("--tag", default="")
    ap.add_argument("--no-wait", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    ids = a.ids or tm_common.dev_ids()
    for pid in ids:
        tm_common.assert_dev(pid)
    keys = a.models.split(",")
    timing = []
    with tm_common.gpu_lock():
        nets = {k: MODELS[k][0](MODELS[k][1], a.device) for k in keys}
        todo = list(ids)
        while todo:
            ready = [p for p in todo if (tm_common.CACHE / p / "photo.jpg").exists() and time.time() - (tm_common.CACHE / p / "photo.jpg").stat().st_mtime > 15]
            if not ready:
                if a.no_wait or (tm_common.CACHE / "ALL_DONE").exists():
                    break
                time.sleep(20); continue
            for pid in ready:
                im = load_photo(pid)
                for k in keys:
                    f = OUT / f"{pid}.{k}{a.tag}.npz"
                    if f.exists():
                        continue
                    t0 = time.time()
                    r = nets[k](im)
                    if a.device == "mps":
                        torch.mps.synchronize()
                    sec = time.time() - t0
                    save(pid, k + a.tag, r, sec, im)
                    timing.append({"pid": pid, "model": k, "device": a.device, "s": round(sec, 3)})
                    print(pid, k, f"{sec:.2f}s", f"hfov_pred={r['hfov_pred']}", flush=True)
                todo.remove(pid)
    with open(_env.HERE / f"timing_{a.device}{a.tag}.jsonl", "a") as fh:
        for t in timing:
            fh.write(json.dumps(t) + "\n")


if __name__ == "__main__":
    main()
