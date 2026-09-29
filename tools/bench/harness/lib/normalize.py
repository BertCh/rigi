"""Upright JPEG for the harness: EXIF orientation applied, long side ≤ 2048, sRGB JPEG q92.

  normalize.py <out_dir> <id>=<file> ...  → JSON {id: {file, width, height, orientation, reencoded}}

A file that is already an upright JPEG with long side ≤ 2048 is used as is (no copy), so the
bundled public/photos/*.jpg stay byte-identical to what the app loads.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageOps

MAX = 2048
out_dir = Path(sys.argv[1])
res = {}
for arg in sys.argv[2:]:
    pid, f = arg.split("=", 1)
    im = Image.open(f)
    orient = im.getexif().get(0x0112, 1)
    if im.format == "JPEG" and orient == 1 and max(im.size) <= MAX and im.mode == "RGB":
        res[pid] = {"file": str(Path(f).resolve()), "width": im.width, "height": im.height, "orientation": orient, "reencoded": False}
        continue
    im = ImageOps.exif_transpose(im).convert("RGB")
    s = MAX / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    out_dir.mkdir(parents=True, exist_ok=True)
    o = out_dir / f"{pid}.jpg"
    im.save(o, "JPEG", quality=92)
    res[pid] = {"file": str(o.resolve()), "width": im.width, "height": im.height, "orientation": orient, "reencoded": True}
print(json.dumps(res))
