"""Diagnostic: 360° satellite-render strip at the manifest eye, stacked under the photo.
Usage: pano.py OUTDIR id [id ...]   (dev ids only unless V2_ALLOW_TEST=1)"""
import os, sys, math, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "stage1"))
import numpy as np
from PIL import Image, ImageDraw
import s1

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
ids = sys.argv[2:]
if os.environ.get("V2_ALLOW_TEST") != "1":
    bad = set(ids) & s1.test_ids()
    assert not bad, f"test ids refused: {bad}"
w = s1.Worker(port=int(os.environ.get("V2_PORT", 8769)))
try:
    for pid in ids:
        ph = s1.Photo(pid)
        ss = s1.Session(w, ph)
        vf = 40.0
        poses = [{"yaw": float(y), "pitch": 2.0, "roll": 0.0, "vfov": vf} for y in range(0, 360, 36)]
        # render at aspect of photo; use square-ish tiles
        for att in range(3):
            try:
                views, _, meta, _ = ss.render(poses=poses, prior={"yaw": 0, "pitch": 0, "roll": 0, "vfov": vf}); break
            except RuntimeError as ex:
                print(pid, "retry", ex, flush=True)
        else:
            continue
        tiles = []
        for v in views:
            im = Image.fromarray(v.rgb); h = 200; im = im.resize((round(im.width * h / im.height), h))
            d = ImageDraw.Draw(im); d.text((4, 4), f"{v.pose['yaw']:.0f}", fill="red")
            tiles.append(im)
        strip = Image.new("RGB", (sum(t.width for t in tiles), 200))
        x = 0
        for t in tiles: strip.paste(t, (x, 0)); x += t.width
        ph_im = Image.fromarray(ph.img); ph_im.thumbnail((strip.width // 3, 320))
        sheet = Image.new("RGB", (strip.width, 200 + ph_im.height + 20), "white")
        sheet.paste(ph_im, (0, 20)); sheet.paste(strip, (0, ph_im.height + 20))
        e = ph.e
        ImageDraw.Draw(sheet).text((ph_im.width + 10, 30), f"{pid} {e['positionSource']} heading={e.get('headingDeg')} hfov0={ph.hfov0:.1f} fk={ph.focal_known}\neye={json.dumps(meta.get('eye'))[:200]}\n{e['title'][:80]}", fill="black")
        sheet.thumbnail((2400, 2400)); sheet.save(out / f"{pid}.jpg", quality=80)
        print(pid, meta.get("eye"), flush=True)
        ph.cleanup()
finally:
    w.close()
