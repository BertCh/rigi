#!/usr/bin/env python3
# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors
"""Producer for public/models/anny-lod10.<sha8>.safetensors: a coarse, linearised Anny body for src/lib/body/anny.ts.

    python scripts/models/anny.py OUT                        # scripts/models/fetch.mjs: write the file to OUT
    python scripts/models/anny.py [--out-dir DIR] [--manifest scripts/models/manifest.json]
    python scripts/models/anny.py --dump-ref DIR             # a posed reference for src/lib/body/anny.check.ts

Needs `pip install anny==0.6.1` (naver/anny: code Apache-2.0, MakeHuman/MPFB2 assets CC0; the NC "smplx" topology is
never touched). What is baked (all float tensors fp16, faces/indices int32):
  - topology "notoes_collapse10pc" (Anny's own 10 % decimation of the toe-less MakeHuman mesh, 1229 vertices, closed),
    Anny rig "anny", body frame of Anny: x = the person's left, y = backwards, z = up, metres, origin at the root;
  - the rest mesh at the base phenotype (gender, age, muscle, weight, height, proportions all 0.5 = adult) and a linear
    shape basis: central differences (+-0.25) of the rest vertices / joints / keypoints / stature w.r.t. the phenotypes
    in SHAPES (`shape.dirs` [S, V, 3], per unit phenotype);
  - a reduced skeleton: the 13 bones in KEEP (root + the joints a fit articulates); every other bone's skin weight goes
    to its nearest kept ancestor (a bone with an identity local rotation moves exactly with its parent, so this is exact
    for poses that only rotate kept bones), then top-4 renormalised (`skin.index`, `skin.weight` [V, 4]);
  - COCO-17 keypoints from Anny's own regressor (data/keypoints/coco.pth, on the full "anny" topology), as skinned
    points: rest position + shape directions + top-4 skin weights (the regressor-weighted vertex skin weights).
Pose model of anny.ts (and of --dump-ref): world-aligned joint frames, G_root = [I | J_root], G_j = G_parent [R_j | J_j -
J_parent], vertex = sum_j w_j G_j [I | -J_j] v, R_j from an axis-angle in the rest (body) axes.
Deterministic (float64 CPU evaluation).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np

# this file is itself named anny.py: drop its directory from the import path so `import anny` finds the package
sys.path = [p for p in sys.path if Path(p or ".").resolve() != Path(__file__).resolve().parent]

LOD = "notoes_collapse10pc"
ANNY_VERSION = "0.6.1"
SHAPES = ["height", "gender", "weight", "proportions"]
DELTA = 0.25
BASE = {"gender": 0.5, "age": 0.5, "muscle": 0.5, "weight": 0.5, "height": 0.5, "proportions": 0.5}
KEEP = [
    "root",
    "upperleg01.L",
    "lowerleg01.L",
    "upperleg01.R",
    "lowerleg01.R",
    "spine03",
    "spine01",
    "upperarm01.L",
    "lowerarm01.L",
    "upperarm01.R",
    "lowerarm01.R",
    "neck01",
    "head",
]
COCO17 = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow",
    "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle",
    "right_ankle",
]
DTYPES = {np.dtype("float16"): "F16", np.dtype("float32"): "F32", np.dtype("int32"): "I32"}


def find_main() -> Path:
    here = Path(__file__).resolve().parents[2]
    try:
        common = subprocess.check_output(
            ["git", "-C", str(here), "rev-parse", "--path-format=absolute", "--git-common-dir"], text=True
        ).strip()
        return Path(common).parent
    except Exception:
        return here


MAIN = find_main()


def write_safetensors(path: Path, tensors: dict[str, np.ndarray], meta: dict[str, str] | None = None) -> bytes:
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


def load_models():
    import anny
    import torch

    torch.set_grad_enabled(False)
    from importlib.metadata import version

    if version("anny") != ANNY_VERSION:
        print(f"warning: anny {version('anny')}, baked against {ANNY_VERSION}", file=sys.stderr)
    coarse = anny.Anny(topology=LOD, skinning_method="lbs")
    full = anny.Anny(skinning_method="lbs")
    reg = anny.KeypointsRegressor.coco(full, labels=COCO17)
    return coarse, full, reg


def rest(model, ph: dict[str, float]):
    out = model.get_rest_model(model._get_phenotype_blendshape_coefficients(*phenotype_inputs(model, ph)))
    return out["rest_vertices"][0].numpy(), out["rest_bone_heads"][0].numpy()


def phenotype_inputs(model, ph):
    pose, phen, local, face = model.get_tensor_inputs(None, ph, None, None)
    return phen, local, face


def groups(model) -> np.ndarray:
    """Original bone index -> index into KEEP (nearest kept ancestor or self)."""
    labels = list(model.bone_labels)
    keep = {labels.index(n): i for i, n in enumerate(KEEP)}
    g = np.zeros(len(labels), dtype=np.int64)
    for b in range(len(labels)):
        a = b
        while a not in keep:
            a = model.bone_parents[a]
        g[b] = keep[a]
    return g


def dense_skin(model) -> np.ndarray:
    """[V, len(KEEP)] skin weights with every bone folded into its group."""
    g = groups(model)
    idx = model.vertex_bone_indices.numpy()
    w = model.vertex_bone_weights.numpy()
    out = np.zeros((idx.shape[0], len(KEEP)))
    for c in range(idx.shape[1]):
        np.add.at(out, (np.arange(idx.shape[0]), g[idx[:, c]]), w[:, c])
    return out


def top4(dense: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    order = np.argsort(-dense, axis=1, kind="stable")[:, :4]
    w = np.take_along_axis(dense, order, 1)
    w = w / w.sum(1, keepdims=True)
    return order.astype(np.int32), w


def bake() -> dict[str, np.ndarray]:
    coarse, full, reg = load_models()
    labels = list(coarse.bone_labels)
    keep_idx = [labels.index(n) for n in KEEP]
    R = reg.regression_weights.numpy()  # [17, Vfull]

    def sample(ph):
        v, heads = rest(coarse, ph)
        vf, _ = rest(full, ph)
        kp = R @ vf
        stature = v[:, 2].max() - v[:, 2].min()
        return v, heads[keep_idx], kp, stature

    v0, j0, k0, s0 = sample(BASE)
    dv, dj, dk, ds = [], [], [], []
    for name in SHAPES:
        hi = sample({**BASE, name: BASE[name] + DELTA})
        lo = sample({**BASE, name: BASE[name] - DELTA})
        dv.append((hi[0] - lo[0]) / (2 * DELTA))
        dj.append((hi[1] - lo[1]) / (2 * DELTA))
        dk.append((hi[2] - lo[2]) / (2 * DELTA))
        ds.append((hi[3] - lo[3]) / (2 * DELTA))
    si, sw = top4(dense_skin(coarse))
    kd = R @ dense_skin(full)
    ki, kw = top4(kd)
    parents = []
    for n in KEEP:
        b = labels.index(n)
        p = coarse.bone_parents[b]
        while p >= 0 and labels[p] not in KEEP:
            p = coarse.bone_parents[p]
        parents.append(KEEP.index(labels[p]) if p >= 0 else -1)
    faces = coarse.get_triangular_faces().numpy().astype(np.int32)
    f16 = lambda a: np.asarray(a, dtype=np.float64).astype(np.float32).astype(np.float16)  # noqa: E731
    return {
        "template.vertices": f16(v0),
        "template.joints": f16(j0),
        "template.keypoints": f16(k0),
        "template.stature": np.array([s0], dtype=np.float32),
        "shape.dirs": f16(np.stack(dv)),
        "shape.joints": f16(np.stack(dj)),
        "shape.keypoints": f16(np.stack(dk)),
        "shape.stature": np.array(ds, dtype=np.float32),
        "faces": faces,
        "joints.parent": np.array(parents, dtype=np.int32),
        "skin.index": si,
        "skin.weight": f16(sw),
        "keypoints.index": ki,
        "keypoints.weight": f16(kw),
    }


META = {
    "model": f"anny-{ANNY_VERSION}-{LOD}",
    "layout": "rigi-anny-1",
    "frame": "x left, y back, z up (m)",
    "shapes": ",".join(SHAPES),
    "joints": ",".join(KEEP),
    "keypoints": ",".join(COCO17),
    "base": json.dumps(BASE, separators=(",", ":")),
}


def produce(out: Path) -> dict:
    data = write_safetensors(out, bake(), META)
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def cmd_export(a) -> None:
    out_dir = Path(a.out_dir)
    tmp = out_dir / "anny-lod10.tmp.safetensors"
    r = produce(tmp)
    final = out_dir / f"anny-lod10.{r['sha256'][:8]}.safetensors"
    tmp.replace(final)
    row = {
        "file": final.name,
        "sha256": r["sha256"],
        "bytes": r["bytes"],
        "licence": "Apache-2.0 AND CC0-1.0",
        "source": f"Anny {ANNY_VERSION} (pypi anny, naver/anny: code Apache-2.0, MakeHuman/MPFB2 assets CC0), topology {LOD}, "
        f"linear phenotype basis ({', '.join(SHAPES)}), 13-bone reduced rig, top-4 skin, COCO-17 keypoint regressor, fp16",
        "producer": "scripts/models/anny.py",
    }
    print(json.dumps(row, indent="\t"))
    if a.manifest:
        mp = Path(a.manifest)
        man = json.loads(mp.read_text()) if mp.exists() else []
        man = [m for m in man if not m["file"].startswith("anny-lod10.")] + [row]
        mp.write_text(json.dumps(man, indent="\t") + "\n")


# ---------------- reference ----------------


def rodrigues(r: np.ndarray) -> np.ndarray:
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def pose_full(coarse, heads: np.ndarray, rot: dict[int, np.ndarray]) -> np.ndarray:
    """World-aligned FK on the FULL rig ([B, 4, 4] skinning transforms), identity for bones not in `rot`."""
    n = len(coarse.bone_labels)
    G = np.zeros((n, 4, 4))
    for b in range(n):  # parents precede children in Anny's bone order
        p = coarse.bone_parents[b]
        L = np.eye(4)
        L[:3, :3] = rot.get(b, np.eye(3))
        L[:3, 3] = heads[b] - (heads[p] if p >= 0 else 0)
        G[b] = (G[p] @ L) if p >= 0 else L
    A = G.copy()
    for b in range(n):
        A[b, :3, 3] = G[b, :3, 3] - G[b, :3, :3] @ heads[b]
    return A


def cmd_dump_ref(a) -> None:
    import torch

    coarse, _full, _reg = load_models()
    labels = list(coarse.bone_labels)
    rng = np.random.default_rng(7)
    beta = np.array([0.15, 0.4, -0.2, 0.1])
    ph = {**BASE, **{n: BASE[n] + b for n, b in zip(SHAPES, beta)}}
    rv, heads = rest(coarse, ph)
    pose = rng.normal(0, 0.35, size=(len(KEEP), 3))
    pose[0] = 0  # root rotation is the fit's global rotation, not a joint
    rot = {labels.index(n): rodrigues(pose[i]) for i, n in enumerate(KEEP)}
    A = pose_full(coarse, heads, rot)
    full_posed = coarse.get_skinned_vertices(
        rest_vertices=torch.from_numpy(rv)[None], bone_transforms=torch.from_numpy(A)[None]
    )[0].numpy()
    # the reduced model evaluated here in numpy (what anny.ts does), on the baked fp16 data
    from safetensors.numpy import load_file

    src = sorted(Path(a.out_dir).glob("anny-lod10.*.safetensors"))[-1]
    t = {k: v.astype(np.float64) if v.dtype == np.float16 else v for k, v in load_file(str(src)).items()}
    vr = t["template.vertices"] + np.einsum("s,svc->vc", beta, t["shape.dirs"])
    jr = t["template.joints"] + np.einsum("s,sjc->jc", beta, t["shape.joints"])
    par = t["joints.parent"]
    G = np.zeros((len(KEEP), 4, 4))
    for j in range(len(KEEP)):
        L = np.eye(4)
        L[:3, :3] = rodrigues(pose[j])
        L[:3, 3] = jr[j] - (jr[par[j]] if par[j] >= 0 else 0)
        G[j] = G[par[j]] @ L if par[j] >= 0 else L
    Ar = G.copy()
    for j in range(len(KEEP)):
        Ar[j, :3, 3] = G[j, :3, 3] - G[j, :3, :3] @ jr[j]
    si, sw = t["skin.index"], t["skin.weight"]
    vh = np.concatenate([vr, np.ones((len(vr), 1))], 1)
    red = np.zeros_like(vr)
    for c in range(4):
        red += sw[:, c, None] * np.einsum("vij,vj->vi", Ar[si[:, c]], vh)[:, :3]
    err = np.linalg.norm(red - full_posed, axis=1)
    lin = np.linalg.norm(vr - rv, axis=1)
    # the same reduced skinning on Anny's exact rest mesh: what the rig reduction + top-4 + fp16 alone cost
    vh2 = np.concatenate([rv, np.ones((len(rv), 1))], 1)
    red2 = np.zeros_like(rv)
    for c in range(4):
        red2 += sw[:, c, None] * np.einsum("vij,vj->vi", Ar[si[:, c]], vh2)[:, :3]
    rig = np.linalg.norm(red2 - full_posed, axis=1)
    mm = lambda e: f"max {e.max() * 1000:.2f} mm, mean {e.mean() * 1000:.2f} mm"  # noqa: E731
    print(f"linear phenotype basis vs Anny rest mesh at beta {beta.tolist()}: {mm(lin)}")
    print(f"reduced rig (13 bones, top-4, fp16) vs Anny full-rig LBS, same rest mesh: {mm(rig)}")
    print(f"both (what anny.ts evaluates) vs Anny: {mm(err)}")
    out = {
        "beta": beta.astype(np.float32),
        "pose": pose.astype(np.float32),
        "anny.vertices": full_posed.astype(np.float32),
        "reduced.vertices": red.astype(np.float32),
    }
    d = Path(a.dump_ref)
    write_safetensors(d / "ref.safetensors", out, {"weights": src.name})
    print(f"wrote {d / 'ref.safetensors'}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", nargs="?", help="write the safetensors to exactly this path (scripts/models/fetch.mjs)")
    ap.add_argument("--out-dir", default=str(MAIN / "public/models"))
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--dump-ref", metavar="DIR")
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
