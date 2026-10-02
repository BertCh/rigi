#!/usr/bin/env python3
# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Producer for the browser U²-Net-P sky weights (src/lib/sky/u2netp.ts, on src/lib/nn).

Source: public/models/skyseg-u2netp.873ea284.onnx (MIT; upstream ncnn weights converted by
src/lib/sky/tools/ncnn2onnx.py, scripts/models/skyseg.mjs). That graph has no BatchNorm left (the ncnn
export had folded every BN into its conv; the converter below would fold a BatchNormalization node if one
appeared), so the weights are the 119 Conv kernels + biases, stored as fp16 safetensors.

The ONNX op list (opset of the file): Conv 119 (3x3 with dilation 1 / 2 / 4 / 8, and 1x1 side heads), Relu 112,
MaxPool 33 (2x2 stride 2, ceil_mode 0), Resize 38 (linear, half_pixel = bilinear align_corners=False, target
size = the spatial size of a partner tensor, folded from the Shape/Concat nodes), Concat 89, Add 11 (RSU
residuals), Sigmoid 1. The data-flow graph is stored in the safetensors `__metadata__.program` (JSON) so the
TS forward pass interprets exactly the exported topology:
  ["conv", out, in, name, dilation, pad] | ["relu", out, in] | ["pool", out, in] | ["cat", out, [in, ...]]
  ["up", out, in, ref] (bilinear to ref's H, W) | ["add", out, a, b] | ["sigmoid", out, in]

  tools/matcher/.venv/bin/python scripts/models/u2netp.py public/models/skyseg-u2netp-nn.<sha8>.safetensors  (fetch.mjs contract)
  tools/matcher/.venv/bin/python scripts/models/u2netp.py export [--out public/models] [--manifest scripts/models/manifest.json]
  tools/matcher/.venv/bin/python scripts/models/u2netp.py taps-onnx <out.onnx>
      (parity only) the source ONNX with the eleven RSU stage outputs and six side maps added as graph outputs
Output names carry the first 8 hex of the file's sha256. Deterministic.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper

ROOT = Path(__file__).resolve().parents[2]
MAIN_ROOT = Path(os.environ.get("RIGI_MAIN", ROOT))
ONNX_FILE = "skyseg-u2netp.873ea284.onnx"
DTYPES = {np.dtype("float16"): "F16", np.dtype("float32"): "F32"}


def write_safetensors(tensors: dict[str, np.ndarray], meta: dict[str, str]) -> bytes:
    header: dict = {}
    blobs = []
    off = 0
    for k in sorted(tensors):
        a = np.ascontiguousarray(tensors[k])
        b = a.tobytes()
        header[k] = {"dtype": DTYPES[a.dtype], "shape": list(a.shape), "data_offsets": [off, off + len(b)]}
        blobs.append(b)
        off += len(b)
    header["__metadata__"] = meta
    h = json.dumps(header, separators=(",", ":")).encode()
    h += b" " * ((8 - len(h) % 8) % 8)
    return struct.pack("<Q", len(h)) + h + b"".join(blobs)


def find_onnx() -> Path:
    for r in (ROOT, MAIN_ROOT):
        p = r / "public/models" / ONNX_FILE
        if p.exists():
            return p
    raise SystemExit(f"{ONNX_FILE} not found; run node scripts/models/fetch.mjs --only skyseg first")


def convert(path: Path) -> tuple[dict[str, np.ndarray], dict[str, str], dict]:
    g = onnx.load(str(path)).graph
    init = {i.name: numpy_helper.to_array(i).astype(np.float32) for i in g.initializer}
    shape_src: dict[str, tuple[str, int]] = {}  # Shape node output -> (tensor, which)
    sizes: dict[str, str] = {}  # Resize size tensor -> ref tensor
    prog: list = []
    tensors: dict[str, np.ndarray] = {}
    ops: dict[str, int] = {}
    for n in g.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
        a = {x.name: helper.get_attribute_value(x) for x in n.attribute}
        if n.op_type == "Shape":
            shape_src[n.output[0]] = (n.input[0], 0 if "end" in a else 1)
        elif n.op_type == "Concat" and all(i in shape_src for i in n.input):
            # [shape(x)[:2], shape(ref)[2:]]: the Resize target takes N, C from x and H, W from ref
            sizes[n.output[0]] = shape_src[n.input[1]][0]
        elif n.op_type == "Conv":
            assert a["group"] == 1 if "group" in a else True
            d = a.get("dilations", [1, 1])
            p = a["pads"]
            assert d[0] == d[1] and p[0] == p[1] == p[2] == p[3] and a.get("strides", [1, 1]) == [1, 1]
            name = n.input[1].removesuffix("_w")
            tensors[name + ".w"] = init[n.input[1]]
            tensors[name + ".b"] = init[n.input[2]]
            prog.append(["conv", n.output[0], n.input[0], name, d[0], p[0]])
        elif n.op_type == "Relu":
            prog.append(["relu", n.output[0], n.input[0]])
        elif n.op_type == "MaxPool":
            assert a["kernel_shape"] == [2, 2] and a["strides"] == [2, 2] and a.get("ceil_mode", 0) == 0
            prog.append(["pool", n.output[0], n.input[0]])
        elif n.op_type == "Concat":
            prog.append(["cat", n.output[0], list(n.input)])
        elif n.op_type == "Resize":
            assert a["mode"] == b"linear" and a["coordinate_transformation_mode"] == b"half_pixel"
            prog.append(["up", n.output[0], n.input[0], sizes[n.input[3]]])
        elif n.op_type == "Add":
            prog.append(["add", n.output[0], n.input[0], n.input[1]])
        elif n.op_type == "Sigmoid":
            prog.append(["sigmoid", n.output[0], n.input[0]])
        else:
            raise SystemExit(f"unsupported op {n.op_type} (a BatchNormalization would be folded here)")
    out32 = tensors
    out16 = {}
    for k, v in out32.items():
        if float(np.abs(v).max()) > 60000:
            raise SystemExit(f"{k}: overflows fp16")
        out16[k] = v.astype(np.float16)
    meta = {
        "model": "skyseg-u2netp",
        "layout": "rigi-u2netp-1",
        "input": g.input[0].name,
        "output": g.output[0].name,
        "program": json.dumps(prog, separators=(",", ":")),
    }
    return out16, meta, ops


def build() -> tuple[bytes, dict]:
    t, meta, ops = convert(find_onnx())
    return write_safetensors(t, meta), ops


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?", help="output path (fetch.mjs contract) or 'export'")
    ap.add_argument("out_onnx", nargs="?", help="taps-onnx output path")
    ap.add_argument("--out", default=str(MAIN_ROOT / "public/models"))
    ap.add_argument("--manifest", default=None)
    a = ap.parse_args()
    if a.target == "taps-onnx":
        m = onnx.load(str(find_onnx()))
        names = [n.output[0] for n in m.graph.node if n.op_type == "Add"]
        names += [n.output[0] for n in m.graph.node if n.op_type == "Conv" and n.output[0].isdigit()
                  and numpy_helper.to_array(next(i for i in m.graph.initializer if i.name == n.input[1])).shape[0] == 1]
        for nm in names:
            m.graph.output.append(helper.make_tensor_value_info(nm, onnx.TensorProto.FLOAT, None))
        onnx.save(m, a.out_onnx)
        print(json.dumps(names))
        return
    data, ops = build()
    sha = hashlib.sha256(data).hexdigest()
    if a.target and a.target != "export":
        Path(a.target).write_bytes(data)
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    final = out / f"skyseg-u2netp-nn.{sha[:8]}.safetensors"
    final.write_bytes(data)
    row = {
        "file": final.name,
        "sha256": sha,
        "bytes": len(data),
        "licence": "MIT",
        "source": "skyseg-u2netp.873ea284.onnx (xiongzhu666/Sky-Segmentation-and-Post-processing, commit 1f7811b) Conv kernels as fp16 safetensors + graph program",
        "producer": "scripts/models/u2netp.py",
    }
    print(json.dumps({"ops": ops, **row}, indent="\t"))
    if a.manifest:
        mp = Path(a.manifest)
        man = json.loads(mp.read_text()) if mp.exists() else []
        man = [m for m in man if not m["file"].startswith("skyseg-u2netp-nn.")] + [row]
        mp.write_text(json.dumps(man, indent="\t") + "\n")


if __name__ == "__main__":
    main()
