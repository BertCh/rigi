#!/usr/bin/env python3
# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Producer for the browser people-segmentation weights (src/lib/segment/tflite-net.ts, on src/lib/nn).

Sources (Apache-2.0, MediaPipe model zoo, public/models via scripts/models/fetch.mjs):
  deeplab_v3.ff36e24d.tflite                    MobileNetV2 DeepLab v3, 257x257 -> 21 VOC classes (logits)
  selfie_multiclass_256x256.c6748b12.tflite     256x256 -> 6 classes (background, hair, body skin, face skin,
                                                clothes, others; the activation is applied by the caller)
Both are float32 TFLite graphs (BatchNorm already folded by the TFLite converter; no quantisation). Convs,
depthwise convs and the transposed conv become fp16 safetensors in nn layout ([Cout, Cin/g, kh, kw];
[Cin, Cout, kh, kw] for the transposed conv); the small per-channel MUL / ADD constants stay fp32.
The op list is stored in `__metadata__.program` (JSON) so the TS runner interprets exactly the exported
topology (NHWC like TFLite; the runner moves between NHWC and NCHW lazily):
  ["conv", out, in, name, stride, [top, bottom, left, right], dilation, groups, act]
  ["tconv", out, in, name, stride, act]          (kernel == stride, no crop)
  ["add" | "mul", out, a, b, act]                (operands: tensor names `t<i>` or fp32 constants `c<i>`)
  ["reshape", out, in, shape] | ["transpose", out, in, perm] | ["softmax", out, in]
  ["sum", out, in, axis] (keepdims) | ["cat", out, [in, ...], axis] | ["gap", out, in] (global average pool)
  ["resize", out, in, [H, W], "bilinear" | "nearest", alignCorners]   (half-pixel centres unless alignCorners)
act is "" | "relu" | "relu6". SAME paddings are resolved here from the fixed shapes.

  tools/matcher/.venv/bin/python scripts/models/mediapipe-seg.py public/models/<file>.safetensors  (fetch.mjs contract)
  tools/matcher/.venv/bin/python scripts/models/mediapipe-seg.py export [--out public/models] [--manifest scripts/models/manifest.json]
  tools/matcher/.venv/bin/python scripts/models/mediapipe-seg.py reference <deeplab|selfie> <input.f32> <outdir> [t12,t40,...]
      (parity only) TFLite-interpreter outputs for a raw NHWC float32 input (already normalised): writes
      <outdir>/output.f32 and <outdir>/<tensor>.f32 for the listed intermediates (NHWC, float32)
Needs `pip install tflite ai-edge-litert` in the venv. Output names carry the first 8 hex of the file's sha256. Deterministic.
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

ROOT = Path(__file__).resolve().parents[2]
MAIN_ROOT = Path(os.environ.get("RIGI_MAIN", ROOT))
DTYPES = {np.dtype("float16"): "F16", np.dtype("float32"): "F32"}
MODELS = {
    "deeplab": {
        "tflite": "deeplab_v3.ff36e24d.tflite",
        "prefix": "deeplab-v3-nn",
        "model": "deeplab-v3",
        "source": "MediaPipe DeepLab v3 segmenter (deeplab_v3.ff36e24d.tflite, Apache-2.0) convs as fp16 safetensors + graph program",
        # MediaPipe image preprocessing for this model: (x - 127.5) / 127.5, stretched to 257x257
        "mean": 127.5,
        "std": 127.5,
    },
    "selfie": {
        "tflite": "selfie_multiclass_256x256.c6748b12.tflite",
        "prefix": "selfie-multiclass-nn",
        "model": "selfie-multiclass",
        "source": "MediaPipe selfie multiclass segmenter (selfie_multiclass_256x256.c6748b12.tflite, Apache-2.0) convs as fp16 safetensors + graph program",
        # empirically (MediaPipe python ImageSegmenter, mean abs error 5e-4 vs 2e-3 with 0..1): same as deeplab
        "mean": 127.5,
        "std": 127.5,
    },
}


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


def find_tflite(name: str) -> Path:
    for r in (ROOT, MAIN_ROOT):
        p = r / "public/models" / name
        if p.exists():
            return p
    raise SystemExit(f"{name} not found; run node scripts/models/fetch.mjs --only {name.split('.')[0]} first")


def load(path: Path):
    import tflite
    from tflite import (
        AddOptions, BuiltinOperator as B, ConcatenationOptions, Conv2DOptions, DepthwiseConv2DOptions,
        MulOptions, Pool2DOptions, ReducerOptions, ResizeBilinearOptions, ResizeNearestNeighborOptions,
        TransposeConvOptions,
    )

    m = tflite.Model.GetRootAsModel(path.read_bytes(), 0)
    g = m.Subgraphs(0)
    names = {v: k for k, v in vars(B).items() if not k.startswith("_")}

    def shape(i):
        return [int(x) for x in g.Tensors(i).ShapeAsNumpy()]

    def const(i):
        t = g.Tensors(i)
        d = m.Buffers(t.Buffer()).DataAsNumpy()
        if isinstance(d, int) or len(d) == 0:
            return None
        dt = {0: np.float32, 2: np.int32}[t.Type()]
        return np.frombuffer(d.tobytes(), dtype=dt).reshape(shape(i))

    def opts(o, cls):
        t = o.BuiltinOptions()
        x = cls()
        x.Init(t.Bytes, t.Pos)
        return x

    ACT = {0: "", 1: "relu", 3: "relu6"}
    tens: dict[str, np.ndarray] = {}
    prog: list = []
    ops: dict[str, int] = {}

    def same_pad(n_in, n_out, k, s, d):
        total = max((n_out - 1) * s + (k - 1) * d + 1 - n_in, 0)
        return total // 2, total - total // 2

    def operand(i):
        c = const(i)
        if c is None:
            return f"t{i}"
        tens[f"c{i}"] = c.astype(np.float32)
        return f"c{i}"

    for k in range(g.OperatorsLength()):
        o = g.Operators(k)
        code = m.OperatorCodes(o.OpcodeIndex())
        bc = max(code.BuiltinCode(), code.DeprecatedBuiltinCode())
        op = names[bc]
        ops[op] = ops.get(op, 0) + 1
        ins = [int(x) for x in o.InputsAsNumpy()]
        out = f"t{int(o.OutputsAsNumpy()[0])}"
        oshape = shape(int(o.OutputsAsNumpy()[0]))
        if op in ("CONV_2D", "DEPTHWISE_CONV_2D"):
            a = opts(o, Conv2DOptions if op == "CONV_2D" else DepthwiseConv2DOptions)
            w = const(ins[1]).astype(np.float32)
            b = const(ins[2]).astype(np.float32)
            ishape = shape(ins[0])
            kh, kw = w.shape[1], w.shape[2]
            if op == "CONV_2D":
                w = w.transpose(0, 3, 1, 2)
                groups = 1
            else:
                assert a.DepthMultiplier() == 1
                w = w.transpose(3, 0, 1, 2)
                groups = w.shape[0]
            assert a.StrideH() == a.StrideW() and a.DilationHFactor() == a.DilationWFactor()
            s, d = a.StrideH(), a.DilationHFactor()
            if a.Padding() == 0:
                pt, pb = same_pad(ishape[1], oshape[1], kh, s, d)
                pl, pr = same_pad(ishape[2], oshape[2], kw, s, d)
            else:
                pt = pb = pl = pr = 0
            name = f"op{k}"
            tens[name + ".w"] = np.ascontiguousarray(w)
            tens[name + ".b"] = b
            prog.append(["conv", out, f"t{ins[0]}", name, s, [pt, pb, pl, pr], d, groups, ACT[a.FusedActivationFunction()]])
        elif op == "TRANSPOSE_CONV":
            a = opts(o, TransposeConvOptions)
            w = const(ins[1]).astype(np.float32)  # [O, kh, kw, I]
            assert w.shape[1] == w.shape[2] == a.StrideH() == a.StrideW()
            name = f"op{k}"
            tens[name + ".w"] = np.ascontiguousarray(w.transpose(3, 0, 1, 2))  # [Cin, Cout, kh, kw]
            tens[name + ".b"] = const(ins[3]).astype(np.float32)
            prog.append(["tconv", out, f"t{ins[2]}", name, a.StrideH(), ACT[a.FusedActivationFunction()]])
        elif op in ("ADD", "MUL"):
            a = opts(o, AddOptions if op == "ADD" else MulOptions)
            prog.append([op.lower(), out, operand(ins[0]), operand(ins[1]), ACT[a.FusedActivationFunction()]])
        elif op == "RESHAPE":
            prog.append(["reshape", out, f"t{ins[0]}", oshape])
        elif op == "TRANSPOSE":
            prog.append(["transpose", out, f"t{ins[0]}", [int(x) for x in const(ins[1])]])
        elif op == "SOFTMAX":
            prog.append(["softmax", out, f"t{ins[0]}"])
        elif op == "SUM":
            assert opts(o, ReducerOptions).KeepDims()
            prog.append(["sum", out, f"t{ins[0]}", int(const(ins[1]).reshape(-1)[0])])
        elif op == "CONCATENATION":
            prog.append(["cat", out, [f"t{i}" for i in ins], opts(o, ConcatenationOptions).Axis()])
        elif op == "AVERAGE_POOL_2D":
            a = opts(o, Pool2DOptions)
            ishape = shape(ins[0])
            assert a.FilterHeight() == ishape[1] and a.FilterWidth() == ishape[2] and a.Padding() == 1
            prog.append(["gap", out, f"t{ins[0]}"])
        elif op in ("RESIZE_BILINEAR", "RESIZE_NEAREST_NEIGHBOR"):
            a = opts(o, ResizeBilinearOptions if op == "RESIZE_BILINEAR" else ResizeNearestNeighborOptions)
            align = bool(a.AlignCorners())
            if op == "RESIZE_BILINEAR":
                assert align or a.HalfPixelCenters()
                mode = "bilinear"
            else:
                assert not align and a.HalfPixelCenters()
                mode = "nearest"
            prog.append(["resize", out, f"t{ins[0]}", oshape[1:3], mode, align])
        else:
            raise SystemExit(f"unsupported op {op}")
    inp = int(g.InputsAsNumpy()[0])
    outp = int(g.OutputsAsNumpy()[0])
    return tens, prog, ops, f"t{inp}", f"t{outp}", shape(inp), shape(outp)


def convert(key: str):
    cfg = MODELS[key]
    tens, prog, ops, inp, outp, ishape, oshape = load(find_tflite(cfg["tflite"]))
    out = {}
    for k, v in tens.items():
        if k.endswith(".w"):
            if float(np.abs(v).max()) > 60000:
                raise SystemExit(f"{k}: overflows fp16")
            v = v.astype(np.float16)
        out[k] = v
    meta = {
        "model": cfg["model"],
        "layout": "rigi-tflite-1",
        "input": inp,
        "output": outp,
        "inputShape": json.dumps(ishape),
        "outputShape": json.dumps(oshape),
        "mean": str(cfg["mean"]),
        "std": str(cfg["std"]),
        "program": json.dumps(prog, separators=(",", ":")),
    }
    return write_safetensors(out, meta), ops


def reference(key: str, inp_f32: str, outdir: str, taps: list[str]) -> None:
    """TFLite interpreter on a raw NHWC input; writes `output.f32` and each listed intermediate."""
    from ai_edge_litert.interpreter import Interpreter

    ip = Interpreter(model_path=str(find_tflite(MODELS[key]["tflite"])), experimental_preserve_all_tensors=True)
    ip.allocate_tensors()
    det = ip.get_input_details()[0]
    x = np.fromfile(inp_f32, dtype=np.float32).reshape(det["shape"])
    ip.set_tensor(det["index"], x)
    ip.invoke()
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    ip.get_tensor(ip.get_output_details()[0]["index"]).astype(np.float32).tofile(out / "output.f32")
    for t in taps:
        ip.get_tensor(int(t[1:])).astype(np.float32).tofile(out / f"{t}.f32")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?")
    ap.add_argument("a", nargs="?")
    ap.add_argument("b", nargs="?")
    ap.add_argument("c", nargs="?")
    ap.add_argument("d", nargs="?")
    ap.add_argument("--out", default=str(MAIN_ROOT / "public/models"))
    ap.add_argument("--manifest", default=None)
    a = ap.parse_args()
    if a.target == "reference":
        reference(a.a, a.b, a.c, a.d.split(",") if a.d else [])
        return
    if a.target and a.target != "export":
        name = Path(a.target).name
        key = next(k for k, c in MODELS.items() if name.startswith(c["prefix"] + "."))
        data, _ = convert(key)
        Path(a.target).write_bytes(data)
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for key, cfg in MODELS.items():
        data, ops = convert(key)
        sha = hashlib.sha256(data).hexdigest()
        final = out / f"{cfg['prefix']}.{sha[:8]}.safetensors"
        final.write_bytes(data)
        rows.append({
            "file": final.name,
            "sha256": sha,
            "bytes": len(data),
            "licence": "Apache-2.0",
            "source": cfg["source"],
            "producer": "scripts/models/mediapipe-seg.py",
        })
        print(json.dumps({"ops": ops, **rows[-1]}, indent="\t"))
    if a.manifest:
        mp = Path(a.manifest)
        man = json.loads(mp.read_text()) if mp.exists() else []
        man = [m for m in man if not any(m["file"].startswith(c["prefix"] + ".") for c in MODELS.values())] + rows
        mp.write_text(json.dumps(man, indent="\t") + "\n")


if __name__ == "__main__":
    main()
