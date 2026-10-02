#!/usr/bin/env python3
# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Producer for public/models/vitpose-b.<sha8>.safetensors (ViTPose-B simple, COCO-17 keypoints) and its parity reference.

    python scripts/models/vitpose.py OUT                       # scripts/models/fetch.mjs: write the file to OUT
    python scripts/models/vitpose.py [--out-dir DIR] [--manifest scripts/models/manifest.json]
    python scripts/models/vitpose.py --dump-ref DIR [--safetensors FILE] [--image IMG --box x y w h]

Weights: HF usyd-community/vitpose-base-simple @ a93ac0c6 (Apache-2.0, ViTPose code Apache-2.0), model.safetensors is
downloaded from the pinned commit and its sha256 checked; only numpy + safetensors are needed for the export.
Layout written (src/lib/body/vitpose.ts reads it):
  - `pos_embed` [1, 192, 768] = position_embeddings[:, 1:] + position_embeddings[:, :1] (HF adds the cls row to every
    patch and drops the cls token);
  - per layer `layer.{i}.qkv.{weight,bias}`: query | key | value rows stacked (one linear instead of three);
  - other names shortened: `patch.{weight,bias}` (16x16 stride 16, padding 2), `layer.{i}.{proj,fc1,fc2,ln1,ln2}`,
    `norm`, `head.{weight,bias}` (3x3 conv on the ReLU'd, 4x bilinear upsampled 16x12 feature map).
All fp16. Deterministic (same input file -> same bytes).

--dump-ref needs `transformers` (>= 4.48, VitPoseForPoseEstimation) and scipy: it loads the HF model, overwrites its
weights with the fp16-rounded ones (fp32 compute), runs the HF image processor on IMG (default the Step Inside demo
photo, box = the person) and writes f32 tensors for src/lib/body/vitpose.check.ts: the decoded RGB (u8), pixel_values,
embeddings, layer 0 / 5 / 11 outputs, the normed features, heatmaps and post-processed keypoints (DARK, kernel 11).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np

REPO = "usyd-community/vitpose-base-simple"
COMMIT = "a93ac0c67e0b7e2c55287d21d4c460c8f3c54d45"
URL = f"https://huggingface.co/{REPO}/resolve/{COMMIT}/model.safetensors"
SOURCE_SHA256 = "85375373893ddd3641f3912821073e53f5435f9e966e1dca59d004454bfe4fdf"
LICENCE = "Apache-2.0"
LAYERS = 12
DEFAULT_BOX = (1130.0, 720.0, 470.0, 816.0)  # the demo photo's person (COCO x, y, w, h in pixels)


def find_main() -> Path:
    """The main checkout (owns the gitignored weights), also from a git worktree."""
    here = Path(__file__).resolve().parents[2]
    try:
        common = subprocess.check_output(
            ["git", "-C", str(here), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True
        ).strip()
        return Path(common).parent
    except Exception:
        return here


MAIN = find_main()
CACHE = MAIN / "tools/nearfield/weights" / f"vitpose-base-simple.{COMMIT[:8]}.safetensors"
DTYPES = {np.dtype("float16"): "F16", np.dtype("float32"): "F32", np.dtype("uint8"): "U8"}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch_source() -> Path:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    if not CACHE.exists():
        tmp = CACHE.with_suffix(".part")
        urllib.request.urlretrieve(URL, tmp)
        tmp.rename(CACHE)
    got = sha256_file(CACHE)
    if got != SOURCE_SHA256:
        raise SystemExit(f"sha256 mismatch for {CACHE}: {got} != {SOURCE_SHA256}")
    return CACHE


def write_safetensors(path: Path, tensors: dict[str, np.ndarray], meta: dict[str, str] | None = None) -> bytes:
    """Minimal safetensors writer (sorted keys, 8-byte aligned header) so the output is byte-reproducible."""
    header: dict = {}
    blobs = []
    off = 0
    for k in sorted(tensors):
        a = np.ascontiguousarray(tensors[k])
        b = a.tobytes()
        header[k] = {"dtype": DTYPES[a.dtype], "shape": list(a.shape), "data_offsets": [off, off + len(b)]}
        blobs.append(b)
        off += len(b)
    if meta:
        header["__metadata__"] = meta
    h = json.dumps(header, separators=(",", ":")).encode()
    h += b" " * ((8 - len(h) % 8) % 8)
    data = struct.pack("<Q", len(h)) + h + b"".join(blobs)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def rigi_tensors(sd: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """HF state_dict (numpy f32) -> the Rigi layout (see the module docstring), fp16."""
    t: dict[str, np.ndarray] = {}
    pos = sd["backbone.embeddings.position_embeddings"]
    t["pos_embed"] = pos[:, 1:] + pos[:, :1]
    t["patch.weight"] = sd["backbone.embeddings.patch_embeddings.projection.weight"]
    t["patch.bias"] = sd["backbone.embeddings.patch_embeddings.projection.bias"]
    for i in range(LAYERS):
        p = f"backbone.encoder.layer.{i}."
        a = p + "attention.attention."
        for s in ("weight", "bias"):
            t[f"layer.{i}.qkv.{s}"] = np.concatenate([sd[f"{a}query.{s}"], sd[f"{a}key.{s}"], sd[f"{a}value.{s}"]], 0)
            t[f"layer.{i}.proj.{s}"] = sd[f"{p}attention.output.dense.{s}"]
            t[f"layer.{i}.fc1.{s}"] = sd[f"{p}mlp.fc1.{s}"]
            t[f"layer.{i}.fc2.{s}"] = sd[f"{p}mlp.fc2.{s}"]
            t[f"layer.{i}.ln1.{s}"] = sd[f"{p}layernorm_before.{s}"]
            t[f"layer.{i}.ln2.{s}"] = sd[f"{p}layernorm_after.{s}"]
    for s in ("weight", "bias"):
        t[f"norm.{s}"] = sd[f"backbone.layernorm.{s}"]
        t[f"head.{s}"] = sd[f"head.conv.{s}"]
    out = {}
    for k, v in t.items():
        m = float(np.abs(v).max())
        if m > 60000:
            raise SystemExit(f"{k}: |max| {m} overflows fp16")
        out[k] = v.astype(np.float32).astype(np.float16)
    return out


def load_source() -> dict[str, np.ndarray]:
    from safetensors.numpy import load_file

    return {k: v.astype(np.float32) for k, v in load_file(str(fetch_source())).items()}


META = {"model": "vitpose-b-simple", "layout": "rigi-vitpose-1", "source": f"{REPO}@{COMMIT[:8]}", "input": "256x192"}


def produce(out: Path) -> dict:
    data = write_safetensors(out, rigi_tensors(load_source()), META)
    sha = hashlib.sha256(data).hexdigest()
    return {"sha256": sha, "bytes": len(data)}


def cmd_export(a) -> None:
    out_dir = Path(a.out_dir)
    tmp = out_dir / "vitpose-b.tmp.safetensors"
    r = produce(tmp)
    final = out_dir / f"vitpose-b.{r['sha256'][:8]}.safetensors"
    tmp.replace(final)
    row = {
        "file": final.name,
        "sha256": r["sha256"],
        "bytes": r["bytes"],
        "licence": LICENCE,
        "source": f"ViTPose-B simple (HF {REPO} @ {COMMIT[:8]}, Apache-2.0; ViTPose code Apache-2.0), qkv fused, pos embed folded, fp16",
        "producer": "scripts/models/vitpose.py",
    }
    print(json.dumps(row, indent="\t"))
    if a.manifest:
        mp = Path(a.manifest)
        man = json.loads(mp.read_text()) if mp.exists() else []
        man = [m for m in man if not m["file"].startswith("vitpose-b.")] + [row]
        mp.write_text(json.dumps(man, indent="\t") + "\n")


def cmd_dump_ref(a) -> None:
    import torch
    from PIL import Image
    from safetensors.numpy import load_file
    from transformers import VitPoseForPoseEstimation, VitPoseImageProcessor

    torch.set_grad_enabled(False)
    model = VitPoseForPoseEstimation.from_pretrained(REPO, revision=COMMIT).eval().float()
    # the fp16-rounded weights, so the reference measures the port and not the storage precision
    src = Path(a.safetensors) if a.safetensors else sorted(Path(a.out_dir).glob("vitpose-b.*.safetensors"))[-1]
    rt = {k: v.astype(np.float32) for k, v in load_file(str(src)).items()}
    sd = model.state_dict()
    new: dict[str, torch.Tensor] = {}
    pos = sd["backbone.embeddings.position_embeddings"].clone()
    pos[:, 0] = 0
    pos[:, 1:] = torch.from_numpy(rt["pos_embed"])
    new["backbone.embeddings.position_embeddings"] = pos
    new["backbone.embeddings.patch_embeddings.projection.weight"] = torch.from_numpy(rt["patch.weight"])
    new["backbone.embeddings.patch_embeddings.projection.bias"] = torch.from_numpy(rt["patch.bias"])
    C = 768
    for i in range(LAYERS):
        p = f"backbone.encoder.layer.{i}."
        a_ = p + "attention.attention."
        for s in ("weight", "bias"):
            qkv = rt[f"layer.{i}.qkv.{s}"]
            for j, n in enumerate(("query", "key", "value")):
                new[f"{a_}{n}.{s}"] = torch.from_numpy(qkv[j * C : (j + 1) * C].copy())
            new[f"{p}attention.output.dense.{s}"] = torch.from_numpy(rt[f"layer.{i}.proj.{s}"])
            new[f"{p}mlp.fc1.{s}"] = torch.from_numpy(rt[f"layer.{i}.fc1.{s}"])
            new[f"{p}mlp.fc2.{s}"] = torch.from_numpy(rt[f"layer.{i}.fc2.{s}"])
            new[f"{p}layernorm_before.{s}"] = torch.from_numpy(rt[f"layer.{i}.ln1.{s}"])
            new[f"{p}layernorm_after.{s}"] = torch.from_numpy(rt[f"layer.{i}.ln2.{s}"])
    for s in ("weight", "bias"):
        new[f"backbone.layernorm.{s}"] = torch.from_numpy(rt[f"norm.{s}"])
        new[f"head.conv.{s}"] = torch.from_numpy(rt[f"head.{s}"])
    missing = set(sd) - set(new)
    if missing:
        raise SystemExit(f"unmapped HF tensors: {sorted(missing)[:5]}")
    model.load_state_dict(new)

    image = Image.open(a.image).convert("RGB")
    rgb = np.asarray(image)
    box = [list(a.box)]
    proc = VitPoseImageProcessor.from_pretrained(REPO, revision=COMMIT)
    inputs = proc(image, boxes=[box], return_tensors="pt")
    pv = inputs["pixel_values"].float()
    out: dict[str, np.ndarray] = {"rgb": rgb, "box": np.array(a.box, dtype=np.float32), "pixel_values": pv[0].numpy()}
    caps: dict[str, torch.Tensor] = {}
    bb = model.backbone
    hooks = [bb.embeddings.register_forward_hook(lambda _m, _i, o: caps.__setitem__("embeddings", o))]
    for i in (0, 5, 11):
        hooks.append(bb.encoder.layer[i].register_forward_hook(lambda _m, _i, o, i=i: caps.__setitem__(f"layer{i}", o)))
    res = model(pixel_values=pv)
    for h in hooks:
        h.remove()
    for k, v in caps.items():
        out[k] = (v[0] if isinstance(v, tuple) else v)[0].numpy()
    feats = model.backbone(pv).feature_maps[-1]
    out["features"] = feats[0].numpy()
    out["heatmaps"] = res.heatmaps[0].numpy()
    post = proc.post_process_pose_estimation(res, boxes=[box])[0][0]
    out["keypoints"] = post["keypoints"].numpy().astype(np.float32)
    out["scores"] = post["scores"].numpy().astype(np.float32)
    out = {k: (v if v.dtype == np.uint8 else v.astype(np.float32)) for k, v in out.items()}
    d = Path(a.dump_ref)
    write_safetensors(d / "ref.safetensors", out, {"weights": src.name, "image": str(a.image)})
    print(f"wrote {d / 'ref.safetensors'}")
    for n, (x, y), s in zip(range(17), out["keypoints"], out["scores"]):
        print(f"  kp{n:2d} ({x:7.1f}, {y:7.1f}) {s:.3f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", help="write the safetensors to exactly this path (scripts/models/fetch.mjs)")
    ap.add_argument("--out-dir", default=str(MAIN / "public/models"))
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--dump-ref", metavar="DIR")
    ap.add_argument("--safetensors")
    ap.add_argument("--image", default=str(MAIN / "public/demo/step/photo.jpg"))
    ap.add_argument("--box", type=float, nargs=4, default=DEFAULT_BOX)
    a = ap.parse_args()
    if a.dump_ref:
        cmd_dump_ref(a)
    elif a.out:
        r = produce(Path(a.out))
        print(Path(a.out).name, r["sha256"], r["bytes"])
    else:
        cmd_export(a)


if __name__ == "__main__":
    sys.exit(main())
