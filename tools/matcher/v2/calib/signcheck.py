"""Empirical sign check: rotate / shift upright photos by known amounts and compare GeoCalib's response
with what the app projection (skyglobal.project_rel) implies for the same image change."""
import sys, math
from pathlib import Path
import numpy as np
from PIL import Image
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import calib as C  # noqa: E402
import skyglobal as SG  # noqa: E402  (stage1 on path via calib)
ROOT = HERE.parents[3]

# app: a level horizon at pitch 0 under roll +5: is the right end higher (smaller v) than the left?
u, v, _ = SG.project_rel(np.array([-10.0, 10.0]), np.array([0.0, 0.0]), 0.0, 5.0, 50.0, 1.5)
print(f"app roll +5: horizon v left {v[0]:.3f} right {v[1]:.3f} ->", "right end HIGHER = content rotated CCW" if v[1] < v[0] else "right end LOWER = content rotated CW")
u, v, _ = SG.project_rel(np.array([0.0]), np.array([0.0]), 5.0, 0.0, 50.0, 1.5)
print(f"app pitch +5: horizon v {v[0]:.3f} (<0.5 below centre? {v[0] > 0.5}) -> camera tilted", "up" if v[0] > 0.5 else "down")

for f in ["public/photos/IMG_7131.jpg", "public/photos/IMG_6958.jpg", "public/photos/IMG_7033.jpg"]:
    img = C.upright(ROOT / f); H, W = img.shape[:2]
    im = Image.fromarray(img)
    base = C.calib_array(np.array(im.crop((W//6, H//6, W - W//6, H - H//6))), "mps")
    out = [f.split("/")[-1], f"base p{base['pitch']:+.1f} r{base['roll']:+.1f}"]
    for a in (-8, 8):  # PIL rotate(+a) = content rotated CCW by a
        rot = im.rotate(a, resample=Image.BICUBIC).crop((W//6, H//6, W - W//6, H - H//6))
        r = C.calib_array(np.array(rot), "mps")
        out.append(f"CCW{a:+d}: Δroll {r['roll']-base['roll']:+.1f} Δpitch {r['pitch']-base['pitch']:+.1f}")
    # pitch: crop the lower part (camera 'looking down') vs upper part
    lo = C.calib_array(np.array(im.crop((0, H//3, W, H))), "mps"); hi = C.calib_array(np.array(im.crop((0, 0, W, H - H//3))), "mps")
    out.append(f"upper-crop pitch {hi['pitch']:+.1f} vs lower-crop {lo['pitch']:+.1f}")
    print(" | ".join(out))
