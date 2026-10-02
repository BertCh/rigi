#!/usr/bin/env python3
# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Producer for the browser ALIKED-n16 + LightGlue(aliked) weights (src/lib/features), and the parity fixtures.

Weights: the same checkpoints the Python matcher service loads (lightglue package, TORCH_HOME=tools/matcher/weights):
  aliked-n16.pth (Shiaoming/ALIKED, BSD-3-Clause) and aliked_lightglue_v0-1_arxiv.pth (cvg/LightGlue, Apache-2.0).
They are written as fp16 safetensors with the layout src/lib/features/{aliked,lightglue}.ts read:
  - every BatchNorm is folded into the conv before it (deformable convs included: the deform conv is linear in
    its weight), so ALIKED has no BN at run time;
  - the 1x1 score-head conv over the 128-channel concat is split into its four 32-channel blocks (the browser
    never materialises the full-resolution concat; see aliked.ts);
  - LightGlue's Wqkv rows are regrouped from (head, dim, q|k|v) to (q|k|v, head, dim);
  - SDDH's agg_weights [P, C, D] is stored as a [P*C, D] matrix.
Output names carry the first 8 hex of the file's sha256. Deterministic: same checkpoints -> same bytes.

  tools/matcher/.venv/bin/python scripts/models/aliked-lightglue.py public/models/aliked-n16.<sha8>.safetensors  (fetch.mjs contract)
  tools/matcher/.venv/bin/python scripts/models/aliked-lightglue.py export [--out public/models] [--manifest scripts/models/manifest.json]
  tools/matcher/.venv/bin/python scripts/models/aliked-lightglue.py fixtures --out out/features-parity [--images a.jpg b.jpg ...]

`fixtures` runs the PyTorch reference (the exact lightglue package code the services use) on the given images and
writes f32/u8 safetensors with the decoded pixels, per-layer intermediates and the final keypoints/matches, for
src/lib/features/__tests__/parity.check.ts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAIN_ROOT = Path(os.environ.get("RIGI_MAIN", ROOT))
os.environ.setdefault("TORCH_HOME", str(MAIN_ROOT / "tools/matcher/weights"))

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

torch.set_grad_enabled(False)

DTYPES = {np.dtype("float16"): "F16", np.dtype("float32"): "F32", np.dtype("uint8"): "U8", np.dtype("int32"): "I32"}


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
    path.write_bytes(data)
    return data


def fold_bn(w: torch.Tensor, b: torch.Tensor | None, bn) -> tuple[torch.Tensor, torch.Tensor]:
    s = bn.weight / torch.sqrt(bn.running_var + bn.eps)
    w2 = w * s.reshape(-1, *([1] * (w.dim() - 1)))
    b0 = b if b is not None else torch.zeros_like(bn.running_mean)
    return w2, (b0 - bn.running_mean) * s + bn.bias


def load_models(max_kp=4096, **lg_conf):
    from lightglue import ALIKED, LightGlue

    ext = ALIKED(max_num_keypoints=max_kp, detection_threshold=0.01).eval()
    lg = LightGlue(features="aliked", **lg_conf).eval()
    return ext, lg


def aliked_tensors(ext) -> dict[str, torch.Tensor]:
    t: dict[str, torch.Tensor] = {}

    def conv(prefix, conv_mod, bn):
        if hasattr(conv_mod, "regular_conv"):  # DeformableConv2d
            t[f"{prefix}.offset.w"] = conv_mod.offset_conv.weight
            t[f"{prefix}.offset.b"] = conv_mod.offset_conv.bias
            w, b = fold_bn(conv_mod.regular_conv.weight, conv_mod.regular_conv.bias, bn)
        else:
            w, b = fold_bn(conv_mod.weight, conv_mod.bias, bn)
        t[f"{prefix}.w"], t[f"{prefix}.b"] = w, b

    conv("block1.conv1", ext.block1.conv1, ext.block1.bn1)
    conv("block1.conv2", ext.block1.conv2, ext.block1.bn2)
    for i in (2, 3, 4):
        blk = getattr(ext, f"block{i}")
        conv(f"block{i}.conv1", blk.conv1, blk.bn1)
        conv(f"block{i}.conv2", blk.conv2, blk.bn2)
        t[f"block{i}.down.w"] = blk.downsample.weight
        t[f"block{i}.down.b"] = blk.downsample.bias
    for i in (1, 2, 3, 4):
        t[f"agg{i}.w"] = getattr(ext, f"conv{i}").weight
    w0 = ext.score_head[0].weight  # [8, 128, 1, 1] over cat(x1, x2, x3, x4)
    q = w0.shape[1] // 4
    for i in range(4):
        t[f"score.in{i + 1}.w"] = w0[:, i * q : (i + 1) * q]
    t["score.c1.w"] = ext.score_head[2].weight
    t["score.c2.w"] = ext.score_head[4].weight
    t["score.c3.w"] = ext.score_head[6].weight
    d = ext.desc_head
    t["desc.offset1.w"] = d.offset_conv[0].weight
    t["desc.offset1.b"] = d.offset_conv[0].bias
    t["desc.offset2.w"] = d.offset_conv[2].weight
    t["desc.offset2.b"] = d.offset_conv[2].bias
    t["desc.sf.w"] = d.sf_conv.weight[:, :, 0, 0]  # [C_out, C_in] (linear layout)
    P, C, D = d.agg_weights.shape
    t["desc.agg.w"] = d.agg_weights.reshape(P * C, D)  # rows p*C + c
    return t


def lightglue_tensors(lg) -> dict[str, torch.Tensor]:
    t: dict[str, torch.Tensor] = {}
    sd = lg.state_dict()
    H = lg.conf.num_heads
    D = lg.conf.descriptor_dim
    hd = D // H
    for k, v in sd.items():
        if k == "confidence_thresholds":
            continue
        if k.endswith("self_attn.Wqkv.weight") or k.endswith("self_attn.Wqkv.bias"):
            # rows r = h*(3*hd) + d*3 + j  ->  j*D + h*hd + d
            shp = v.shape
            v = v.reshape(H, hd, 3, *shp[1:]).permute(2, 0, 1, *range(3, v.dim() + 2)).reshape(shp)
        t[k] = v
    return t


def to_f16(t: dict[str, torch.Tensor]) -> dict[str, np.ndarray]:
    out = {}
    for k, v in t.items():
        a = v.detach().float().numpy()
        m = float(np.abs(a).max()) if a.size else 0.0
        if m > 60000:
            raise SystemExit(f"{k}: |max| {m} overflows fp16")
        out[k] = a.astype(np.float16)
    return out


def hashed_write(out_dir: Path, stem: str, tensors: dict[str, np.ndarray], meta: dict[str, str]) -> dict:
    tmp = out_dir / f"{stem}.tmp.safetensors"
    data = write_safetensors(tmp, tensors, meta)
    sha = hashlib.sha256(data).hexdigest()
    final = out_dir / f"{stem}.{sha[:8]}.safetensors"
    tmp.replace(final)
    return {"file": final.name, "sha256": sha, "bytes": len(data)}


def cmd_export(a) -> None:
    ext, lg = load_models()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    r = hashed_write(out, "aliked-n16", to_f16(aliked_tensors(ext)),
                     {"model": "aliked-n16", "layout": "rigi-features-1", "bn": "folded"})
    rows.append({**r, "licence": "BSD-3-Clause",
                 "source": "https://github.com/Shiaoming/ALIKED/raw/main/models/aliked-n16.pth (via lightglue ALIKED), BN folded, fp16",
                 "producer": "scripts/models/aliked-lightglue.py"})
    r = hashed_write(out, "lightglue-aliked", to_f16(lightglue_tensors(lg)),
                     {"model": "lightglue-aliked", "layout": "rigi-features-1", "qkv": "grouped"})
    rows.append({**r, "licence": "Apache-2.0",
                 "source": "https://github.com/cvg/LightGlue/releases/download/v0.1_arxiv/aliked_lightglue.pth, fp16",
                 "producer": "scripts/models/aliked-lightglue.py"})
    print(json.dumps(rows, indent="\t"))
    if a.manifest:
        mp = Path(a.manifest)
        man = json.loads(mp.read_text()) if mp.exists() else []
        stems = ("aliked-n16.", "lightglue-aliked.")
        man = [m for m in man if not m["file"].startswith(stems)] + rows
        mp.write_text(json.dumps(man, indent="\t") + "\n")


# ---------------- fixtures ----------------


def dense_intermediates(ext, image: torch.Tensor) -> dict[str, torch.Tensor]:
    """ALIKED.extract_dense_map with the intermediates kept (same ops, same order)."""
    from lightglue.aliked import InputPadder

    padder = InputPadder(image.shape[-2], image.shape[-1], 32)
    img = padder.pad(image)
    x1 = ext.block1(img)
    x2 = ext.block2(ext.pool2(x1))
    x3 = ext.block3(ext.pool4(x2))
    x4 = ext.block4(ext.pool4(x3))
    out = {"padded": img, "b1": x1, "b2": x2, "b3": x3, "b4": x4}
    a1 = ext.gate(ext.conv1(x1))
    a2 = ext.gate(ext.conv2(x2))
    a3 = ext.gate(ext.conv3(x3))
    a4 = ext.gate(ext.conv4(x4))
    out.update({"x1": a1, "x2": a2, "x3": a3, "x4": a4})
    x1234 = torch.cat([a1, ext.upsample2(a2), ext.upsample8(a3), ext.upsample32(a4)], 1)
    score = torch.sigmoid(ext.score_head(x1234))
    out["score"] = padder.unpad(score)
    out["pad"] = torch.tensor(padder._pad, dtype=torch.int32)
    return out


def cmd_fixtures(a) -> None:
    from PIL import Image
    from lightglue.utils import ImagePreprocessor

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    images = a.images or [str(MAIN_ROOT / f"public/demo/photos/demo-0{i}.jpg") for i in (1, 2)]
    index = {"images": [], "pairs": []}
    feats = {}
    for kp in a.max_kp:
        ext, _ = load_models(max_kp=kp)
        for path in images:
            name = Path(path).stem
            im = Image.open(path).convert("RGB")
            if a.long_side_in and max(im.size) > a.long_side_in:  # keep fixtures small: a pre-shrunk input
                s = a.long_side_in / max(im.size)
                im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
            rgb = np.asarray(im)
            t = torch.from_numpy(rgb).permute(2, 0, 1).float()[None] / 255
            tag = f"{name}.k{kp}"
            f = ext.extract(t[0])
            feats[tag] = f
            tensors = {
                "rgb": rgb,
                "keypoints": f["keypoints"][0].numpy().astype(np.float32),
                "scores": f["keypoint_scores"][0].numpy().astype(np.float32),
                "descriptors": f["descriptors"][0].numpy().astype(np.float32),
            }
            if kp == a.max_kp[0]:
                pre, _ = ImagePreprocessor(**ext.preprocess_conf)(t)
                tensors["pre"] = pre[0].numpy()
                if a.layers:  # per-layer reference at a small working size (resize=layer_side)
                    pre_s, _ = ImagePreprocessor(resize=a.layer_side)(t)
                    d = dense_intermediates(ext, pre_s)
                    for k, v in d.items():
                        tensors[f"layer.{k}"] = v.numpy() if v.dtype == torch.int32 else v[0].numpy().astype(np.float32)
                    fs = ext.extract(t[0], resize=a.layer_side)
                    tensors["small.keypoints"] = fs["keypoints"][0].numpy().astype(np.float32)
                    tensors["small.scores"] = fs["keypoint_scores"][0].numpy().astype(np.float32)
                    tensors["small.descriptors"] = fs["descriptors"][0].numpy().astype(np.float32)
            write_safetensors(out / f"{tag}.safetensors", tensors)
            index["images"].append({"tag": tag, "name": name, "maxKeypoints": kp, "width": rgb.shape[1], "height": rgb.shape[0],
                                    "count": int(f["keypoints"].shape[1]), "layers": bool(a.layers and kp == a.max_kp[0]), "layerSide": a.layer_side})
            print(tag, rgb.shape, int(f["keypoints"].shape[1]), file=sys.stderr)
    # pairs: every consecutive image pair, at each max_kp, adaptive (service default) and full depth
    for kp in a.max_kp:
        tags = [f"{Path(p).stem}.k{kp}" for p in images]
        for i in range(len(tags) - 1):
            f0, f1 = feats[tags[i]], feats[tags[i + 1]]
            res = {}
            for mode, conf in (("adaptive", {}), ("full", {"depth_confidence": -1, "width_confidence": -1})):
                _, lg = load_models(max_kp=kp, **conf)
                r = lg({"image0": f0, "image1": f1})
                m = r["matches"][0].numpy().astype(np.int32)
                res[f"{mode}.matches"] = m
                res[f"{mode}.scores"] = r["scores"][0].numpy().astype(np.float32)
                res[f"{mode}.matches0"] = r["matches0"][0].numpy().astype(np.int32)
                res[f"{mode}.stop"] = np.array([int(r["stop"])], dtype=np.int32)
                if mode == "full" and a.layers:
                    res.update(lg_layer0(lg, f0, f1))
            ptag = f"{tags[i]}__{tags[i + 1]}"
            write_safetensors(out / f"{ptag}.safetensors", res)
            index["pairs"].append({"tag": ptag, "a": tags[i], "b": tags[i + 1], "maxKeypoints": kp,
                                   "adaptive": int(len(res["adaptive.matches"])), "full": int(len(res["full.matches"])),
                                   "stop": int(res["adaptive.stop"][0])})
            print(ptag, index["pairs"][-1], file=sys.stderr)
    (out / "index.json").write_text(json.dumps(index, indent=1))


def lg_layer0(lg, f0, f1) -> dict[str, np.ndarray]:
    """Per-layer reference: inputs to and outputs of transformer 0 and the final layer's assignment maxima."""
    from lightglue.lightglue import normalize_keypoints

    k0 = normalize_keypoints(f0["keypoints"], f0["image_size"])
    k1 = normalize_keypoints(f1["keypoints"], f1["image_size"])
    d0 = lg.input_proj(f0["descriptors"])
    d1 = lg.input_proj(f1["descriptors"])
    e0, e1 = lg.posenc(k0), lg.posenc(k1)
    out = {"lg.kpts0n": k0[0].numpy(), "lg.proj0": d0[0].numpy(), "lg.enc0": e0[0, 0, 0].numpy()}
    s0 = lg.transformers[0].self_attn(d0, e0)
    out["lg.self0"] = s0[0].numpy()
    a0, a1 = lg.transformers[0](d0, d1, e0, e1)
    out["lg.layer0.d0"], out["lg.layer0.d1"] = a0[0].numpy(), a1[0].numpy()
    for i in range(1, lg.conf.n_layers):
        a0, a1 = lg.transformers[i](a0, a1, e0, e1)
    scores, _ = lg.log_assignment[lg.conf.n_layers - 1](a0, a1)
    out["lg.final.d0"] = a0[0].numpy()
    out["lg.final.rowmax"] = scores[0, :-1, :-1].max(1).values.numpy()
    return {k: np.asarray(v, dtype=np.float32) for k, v in out.items()}


def produce_one(path: Path) -> None:
    """scripts/models/fetch.mjs contract: write the one file named by `path` (stem picks the model)."""
    ext, lg = load_models()
    name = path.name
    if name.startswith("aliked-n16."):
        t = to_f16(aliked_tensors(ext))
        meta = {"model": "aliked-n16", "layout": "rigi-features-1", "bn": "folded"}
    elif name.startswith("lightglue-aliked."):
        t = to_f16(lightglue_tensors(lg))
        meta = {"model": "lightglue-aliked", "layout": "rigi-features-1", "qkv": "grouped"}
    else:
        raise SystemExit(f"unknown output {name}")
    data = write_safetensors(path, t, meta)
    print(name, hashlib.sha256(data).hexdigest(), len(data))


def main() -> None:
    if len(sys.argv) == 2 and sys.argv[1].endswith(".safetensors"):
        produce_one(Path(sys.argv[1]))
        return
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--out", default=str(MAIN_ROOT / "public/models"))
    e.add_argument("--manifest", default=None)
    f = sub.add_parser("fixtures")
    f.add_argument("--out", default=str(ROOT / "out/features-parity"))
    f.add_argument("--images", nargs="*")
    f.add_argument("--max-kp", type=int, nargs="+", default=[1024])
    f.add_argument("--long-side-in", type=int, default=0, help="pre-shrink inputs (PIL Lanczos) to this long side")
    f.add_argument("--layers", action="store_true", help="also dump per-layer intermediates at --layer-side")
    f.add_argument("--layer-side", type=int, default=320)
    a = ap.parse_args()
    {"export": cmd_export, "fixtures": cmd_fixtures}[a.cmd](a)


if __name__ == "__main__":
    main()
