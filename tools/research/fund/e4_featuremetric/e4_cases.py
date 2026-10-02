# Rigi
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: Copyright (c) Rigi contributors

"""E4 cases (PROTOCOL section 2): PRIMARY (GT photos, starts from start_poses.ts) and SECONDARY (wild dev photos with a
verified-correct ref, seeded perturbed starts). Each case dict: id, kind, name, lat, lon, eye, W0, H0 (full-res display
size), photo (uint8 array loader path), gt pose {yaw,pitch,roll,f}, start pose, scale index.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MAIN = Path("/Users/robertchristie/Documents/GitHub/mt-image")
for p in (MAIN / "tools/matcher/v2", MAIN / "tools/research/tm"):
    sys.path.insert(0, str(p))

SWISS = (45.82, 47.81, 5.96, 10.49)  # lat min/max, lon min/max
SCALES = (1.0, 3.0, 10.0)


def is_swiss(lat: float, lon: float) -> bool:
    return SWISS[0] <= lat <= SWISS[1] and SWISS[2] <= lon <= SWISS[3]


def primary_cases() -> list[dict]:
    S = json.load(open(HERE / "out/start_poses.json"))
    out = []
    for name in sorted(S):
        v = S[name]
        g = v["gt"]
        out.append({"id": name, "kind": "primary", "name": name, "lat": v["lat"], "lon": v["lon"], "eye": v["eye"],
                    "W0": g["width"], "H0": g["height"], "photo": str(ROOT / f".cache/jpg/1600/{name}.jpg"),
                    "gt": {k: g[k] for k in ("yaw", "pitch", "roll", "f")},
                    "start": {k: v["start"][k] for k in ("yaw", "pitch", "roll", "f")},
                    "startSolved": {k: v["solved"][k] for k in ("yaw", "pitch", "roll", "f")},
                    "accepted": v["accepted"], "scaleIndex": None})
    return out


def upright(path: Path) -> Image.Image:
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    s = 2048 / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return im


def secondary_cases() -> list[dict]:
    import refs  # noqa: E402  tools/matcher/v2 (dev ids only)
    import tm_common  # noqa: E402

    man = {e["id"]: e for e in json.load(open(MAIN / "tools/bench/data/manifest.json"))}
    out = []
    for pid in refs.dev_ids():
        tm_common.assert_dev(pid)
        cr = refs.correct_refs(pid)
        if not cr or not is_swiss(man[pid]["lat"], man[pid]["lon"]):
            continue
        e3 = json.load(open(HERE.parent / f"e3_nearfield/out/{pid}.json"))
        ref = next((r for r in cr if r["label"] == e3["ref"]), cr[0])
        photo = MAIN / "tools/bench/data" / man[pid]["file"]
        im = upright(photo)
        W0, H0 = im.size
        f = (H0 / 2) / math.tan(math.radians(ref["pose"]["vfov"]) / 2)
        gt = {"yaw": ref["pose"]["yaw"], "pitch": ref["pose"]["pitch"], "roll": ref["pose"]["roll"], "f": f}
        for si, s in enumerate(SCALES):
            rng = np.random.default_rng(int(pid[3:]) * 1000 + si)
            z = rng.uniform(-1, 1, 4)
            start = {"yaw": (gt["yaw"] + s * z[0]) % 360, "pitch": gt["pitch"] + s / 3 * z[1],
                     "roll": gt["roll"] + s / 3 * z[2], "f": gt["f"] * (1 + 0.02 * z[3])}
            out.append({"id": f"{pid}_s{int(s)}", "kind": "secondary", "name": pid, "lat": man[pid]["lat"],
                        "lon": man[pid]["lon"], "eye": float(e3["T"][2]), "W0": W0, "H0": H0, "photo": str(photo),
                        "gt": gt, "start": start, "scaleIndex": si, "scaleDeg": s, "refLabel": ref["label"]})
    return out


def load_photo(case: dict) -> np.ndarray:
    im = upright(Path(case["photo"]))
    a = np.asarray(im)
    assert abs(a.shape[1] / a.shape[0] - case["W0"] / case["H0"]) < 0.02, "photo aspect != case aspect"
    return a
