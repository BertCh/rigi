# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Producer for public/models/moge2-vits-normal.<sha8>.safetensors (MoGe-2 ViT-S normal weights as fp16 safetensors).

    python scripts/models/moge2-vits.py OUT                        # scripts/models/fetch.mjs: write the file to OUT
    python scripts/models/moge2-vits.py [--out-dir DIR]            # download, verify, write the safetensors, print the manifest row
    python scripts/models/moge2-vits.py --dump-ref DIR [--safetensors FILE]   # per-layer fp32 reference for the TS port

Runs with tools/matcher/.venv/bin/python (torch, safetensors) and the MoGe source in tools/research/tm/.pylib_x2.
The pinned public checkpoint (MIT) is downloaded to tools/nearfield/service/weights/ and its sha256 is checked.

Tensor names are exactly the PyTorch state_dict keys; nothing is folded. Floating tensors are stored fp16, except the
encoder's ImageNet mean/std buffers (fp32, so the normalisation is exact). Compute in the runtime is fp32.

Post-processing (numpy reference, see postprocess()): mask_b = mask > 0.5; (focal, shift) from moge's recover_focal_shift;
fx = focal/2*sqrt(1+a^2)/a, fy = focal/2*sqrt(1+a^2), a = W/H, cx=cy=0.5; depth = (z+shift)*metric_scale, invalid where
!mask_b or depth <= 0.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np

URL_COMMIT = "26b477f41595707c5db6770294c0d1721e8ed4ed"
URL = f"https://huggingface.co/Ruicheng/moge-2-vits-normal/resolve/{URL_COMMIT}/model.pt"
SHA256 = "79a16621928c2bf0ed04659218c55c01075e950507f40bb3332fb4c873d3e1dc"
LICENCE = "MIT (Ruicheng/moge-2-vits-normal; DINOv2-S backbone Apache-2.0)"
FP32_KEEP = ("encoder.image_mean", "encoder.image_std")


def find_main() -> Path:
    """The main checkout (owns the gitignored weights and the MoGe source), also from a git worktree."""
    here = Path(__file__).resolve().parents[2]
    try:
        common = subprocess.check_output(
            ["git", "-C", str(here), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True
        ).strip()
        return Path(common).parent
    except Exception:
        return here


MAIN = find_main()
MOGE_LIB = MAIN / "tools/research/tm/.pylib_x2"
WEIGHTS_DIR = MAIN / "tools/nearfield/service/weights"
WEIGHTS = WEIGHTS_DIR / f"moge-2-vits-normal.{URL_COMMIT[:8]}.pt"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_weights() -> Path:
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
    if not WEIGHTS.exists():
        tmp = WEIGHTS.with_suffix(".part")
        urllib.request.urlretrieve(URL, tmp)
        tmp.rename(WEIGHTS)
    got = sha256_file(WEIGHTS)
    assert got == SHA256, f"sha256 mismatch for {WEIGHTS}: {got} != {SHA256}"
    return WEIGHTS


def import_moge():
    """MoGe imports a few heavy deps inference never touches; stub the missing ones."""
    from unittest.mock import MagicMock

    if str(MOGE_LIB) not in sys.path:
        sys.path.append(str(MOGE_LIB))
    for name in ("moviepy", "trimesh", "open3d", "gsplat", "evo", "pycolmap", "xformers"):
        try:
            __import__(name)
        except Exception:
            sys.modules[name] = MagicMock()
    from moge.model.v2 import MoGeModel

    return MoGeModel


def load_checkpoint():
    import torch

    return torch.load(str(fetch_weights()), map_location="cpu", weights_only=True)


def write_safetensors(out_dir: Path, out_file: Path | None = None) -> dict:
    import torch
    from safetensors.torch import save_file

    ck = load_checkpoint()
    sd = {}
    for k, v in ck["model"].items():
        sd[k] = (v.float() if k in FP32_KEEP else v.to(torch.float16)).contiguous()
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp = out_file or out_dir / "moge2-vits-normal.tmp.safetensors"
    save_file(sd, str(tmp), metadata={"format": "pt", "source": f"{URL}", "licence": LICENCE})
    sha = sha256_file(tmp)
    final = out_file or out_dir / f"moge2-vits-normal.{sha[:8]}.safetensors"
    if not out_file:
        tmp.replace(final)
    print("model_config:", json.dumps(ck["model_config"]))
    print(f"{len(sd)} tensors, {sum(v.numel() for v in sd.values())} params")
    return {
        "file": f"moge2-vits-normal.{sha[:8]}.safetensors", "sha256": sha, "bytes": final.stat().st_size, "licence": LICENCE,
        "source": f"{URL}", "producer": "scripts/models/moge2-vits.py",
    }  # fmt: skip


def load_model(safetensors: Path | None = None, checkpoint: Path | None = None):
    """MoGeModel in fp32. With `safetensors`, the fp16-rounded weights the runtime will load (rounding error only)."""
    import torch

    MoGeModel = import_moge()
    ck = torch.load(str(checkpoint or fetch_weights()), map_location="cpu", weights_only=True)
    m = MoGeModel(**ck["model_config"])
    if safetensors is None:
        m.load_state_dict(ck["model"], strict=True)
    else:
        from safetensors.torch import load_file

        sd = {k: v.float() for k, v in load_file(str(safetensors)).items()}
        m.load_state_dict(sd, strict=True)
    return m.eval()


# ------------------------------------------------------------------ post-processing (numpy reference)
def postprocess(points, mask, metric_scale):
    """points (H,W,3), mask (H,W) probability, metric_scale float -> dict(depth (0 invalid), mask, fx, fy, focal, shift).
    Mirrors MoGeModel.infer with fov_x=None (recover_focal_shift on a 64x64 nearest subsample, LM on shift)."""
    import torch

    import_moge()
    from moge.utils.geometry_torch import recover_focal_shift

    mask_b = mask > 0.5
    pts = torch.from_numpy(np.ascontiguousarray(points, dtype=np.float32))[None]
    focal, shift = recover_focal_shift(pts, torch.from_numpy(mask_b)[None])
    focal, shift = float(focal[0]), float(shift[0])
    h, w = mask.shape
    a = w / h
    fx = focal / 2 * math.sqrt(1 + a * a) / a
    fy = focal / 2 * math.sqrt(1 + a * a)
    z = (points[..., 2].astype(np.float32) + shift) * float(metric_scale)
    ok = mask_b & (z > 0) & np.isfinite(z)
    return {"depth": np.where(ok, z, 0).astype(np.float32), "mask": ok, "fx": fx, "fy": fy, "focal": focal, "shift": shift}


def token_grid(width: int, height: int, num_tokens: int) -> tuple[int, int]:
    """(H, W) multiples of 14 with H*W/196 ~ num_tokens at the photo's aspect (same rounding as MoGeModel.forward)."""
    aspect = width / height
    bh, bw = round((num_tokens / aspect) ** 0.5), round((num_tokens * aspect) ** 0.5)
    return bh * 14, bw * 14


def forward_numpy(model, rgb_chw01: np.ndarray):
    """rgb [3,H,W] float32 in [0,1], H,W multiples of 14 -> points (H,W,3), normal (H,W,3), mask (H,W), scale"""
    import torch

    h, w = rgb_chw01.shape[1:]
    with torch.no_grad():
        o = model.forward(torch.from_numpy(rgb_chw01)[None], num_tokens=(h // 14) * (w // 14))
    return o["points"][0].numpy(), o["normal"][0].numpy(), o["mask"][0].numpy(), float(o["metric_scale"][0])


# ------------------------------------------------------------------ per-layer reference
def dump_ref(model, out_dir: Path):
    import torch
    from PIL import Image, ImageOps
    from safetensors.torch import save_file

    out_dir.mkdir(parents=True, exist_ok=True)
    H, W = 14 * 24, 14 * 32
    im = ImageOps.exif_transpose(Image.open(MAIN / "public/demo/photos/demo-01.jpg")).convert("RGB")
    x = torch.from_numpy(np.asarray(im.resize((W, H), Image.BILINEAR), np.float32).transpose(2, 0, 1) / 255)[None].contiguous()
    rec: dict[str, torch.Tensor] = {}
    where: dict[str, str] = {}

    def put(name, t, src):
        rec[name] = t.detach().float().contiguous().clone()
        where[name] = src

    def hook(name, path, idx=None, count=False):
        mod = model.get_submodule(path) if path else model
        n = [0]

        def f(_m, _i, out):
            o = out if idx is None else out[idx]
            key = f"{name}#{n[0]}" if count else name
            n[0] += 1
            put(key, o, path)

        return mod.register_forward_hook(f)

    hs = []
    enc, bb = model.encoder, model.encoder.backbone
    hs.append(hook("enc.patch_embed", "encoder.backbone.patch_embed"))
    for i in (0, 5, 11):
        hs.append(hook(f"enc.block{i}", f"encoder.backbone.blocks.{i}"))
    hs.append(hook("enc.backbone_norm", "encoder.backbone.norm", count=True))  # called once per intermediate layer [5, 11]
    for i in range(len(enc.output_projections)):
        hs.append(hook(f"enc.proj{i}", f"encoder.output_projections.{i}"))
    hs.append(hook("enc.out", "encoder", idx=0))  # summed projections, [1,384,bh,bw]
    hs.append(hook("enc.cls_token", "encoder", idx=1))
    for nm in ("neck", "points_head", "normal_head", "mask_head"):
        mod = getattr(model, nm)
        for i, b in enumerate(mod.input_blocks):
            hs.append(hook(f"{nm}.input{i}", f"{nm}.input_blocks.{i}"))
        for i, b in enumerate(mod.res_blocks):
            hs.append(hook(f"{nm}.res{i}", f"{nm}.res_blocks.{i}"))
        for i, b in enumerate(mod.resamplers):
            hs.append(hook(f"{nm}.resample{i}", f"{nm}.resamplers.{i}"))
        for i, b in enumerate(mod.output_blocks):
            hs.append(hook(f"{nm}.out{i}", f"{nm}.output_blocks.{i}"))
    hs.append(hook("scale_head", "scale_head"))

    def neck_in(_m, args):
        for i, t in enumerate(args[0]):
            put(f"neck.in{i}", t, "neck (forward input, level features incl. uv)")

    hs.append(model.neck.register_forward_pre_hook(neck_in))

    with torch.no_grad():
        put("input", x, "image resized (bilinear, PIL) from public/demo/photos/demo-01.jpg")
        xn = (x - enc.image_mean) / enc.image_std
        put("enc.normalised", xn, "encoder.forward: (image - image_mean) / image_std")
        tok = bb.patch_embed(xn)
        tokc = torch.cat((bb.cls_token.expand(1, -1, -1), tok), dim=1)
        put("enc.pos_embed", bb.interpolate_pos_encoding(tokc, H, W), "encoder.backbone.interpolate_pos_encoding (cls + patch rows, [1,1+bh*bw,384])")
        put("enc.tokens_in", tokc + bb.interpolate_pos_encoding(tokc, H, W), "prepare_tokens_with_masks output")
        o = model.forward(x, num_tokens=24 * 32)
    for h in hs:
        h.remove()
    for k, v in o.items():
        put(f"final.{k}", v, "MoGeModel.forward")
    pts, mask, scale = o["points"][0].numpy(), o["mask"][0].numpy(), float(o["metric_scale"][0])
    pp = postprocess(pts, mask, scale)
    put("post.depth", torch.from_numpy(pp["depth"]), "postprocess() numpy reference, 0 = invalid")
    put("post.intrinsics", torch.tensor([pp["fx"], pp["fy"], 0.5, 0.5, pp["focal"], pp["shift"]]), "[fx, fy, cx, cy, focal, shift]")
    inf = model.infer(x[0], num_tokens=24 * 32, use_fp16=False)
    d = inf["depth"].numpy()
    put("infer.depth", torch.from_numpy(np.where(np.isfinite(d), d, 0)), "MoGeModel.infer depth (inf = invalid -> 0)")
    put("infer.intrinsics", inf["intrinsics"], "MoGeModel.infer normalised K")
    save_file(rec, str(out_dir / "ref.safetensors"))
    json.dump({k: {"shape": list(v.shape), "from": where[k]} for k, v in rec.items()}, open(out_dir / "ref.json", "w"), indent=1)
    print(f"{len(rec)} tensors -> {out_dir}; infer-vs-post depth max rel diff:",
          float(np.abs(d[np.isfinite(d)] - pp["depth"][np.isfinite(d)]).max()))  # fmt: skip


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", help="write the safetensors to exactly this path (scripts/models/fetch.mjs)")
    ap.add_argument("--out-dir", default=str(MAIN / "public/models"))
    ap.add_argument("--dump-ref", metavar="DIR")
    ap.add_argument("--safetensors", help="fp16 file to load for --dump-ref (default: newest in --out-dir)")
    a = ap.parse_args()
    if a.dump_ref:
        st = Path(a.safetensors) if a.safetensors else sorted(Path(a.out_dir).glob("moge2-vits-normal.*.safetensors"))[-1]
        dump_ref(load_model(st), Path(a.dump_ref))
        return
    print(json.dumps(write_safetensors(Path(a.out_dir), Path(a.out) if a.out else None)))


if __name__ == "__main__":
    main()
