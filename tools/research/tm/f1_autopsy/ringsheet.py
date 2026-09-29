"""Contact sheet: photo (at ring angular scale + large) above a stitched 360° sat ring from the stated eye.
Ticks every 15°, markers: green = correct ref yaws, red = wrong ref yaws, cyan = T6 final yaw, magenta = LoMa final."""
import json, math, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
H = Path(__file__).parent; ROOT = H.parents[3]; CACHE = H.parent/"cache"
M = json.load(open(H/"master.json"))
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
PX_PER_DEG = 11.0

def strip(pid, kind="rgb"):
    cols = []; far = []
    for y in range(0, 360, 15):
        d = CACHE/pid/"ring"/f"y{y:03d}"; v = json.load(open(d/"view.json"))
        fx = v["intrinsics"]["fx"]; cx = v["intrinsics"]["cx"]
        im = Image.open(d/("rgb.jpg" if kind == "rgb" else "hill.png")).convert("RGB")
        a = np.array(im)
        # resample columns uniformly in angle over [-7.5, 7.5)
        angs = np.arange(-7.5, 7.5, 1/PX_PER_DEG)
        xs = np.clip((cx + fx*np.tan(np.radians(angs))).astype(int), 0, a.shape[1]-1)
        # rows: keep angular vertical scale too
        fy = v["intrinsics"]["fy"]; cy = v["intrinsics"]["cy"]
        vh = min(20.0, v["intrinsics"]["vfov"]/2 - 0.2); vang = np.arange(-vh, vh, 1/PX_PER_DEG)
        ys = np.clip((cy - fy*np.tan(np.radians(vang[::-1]))).astype(int), 0, a.shape[0]-1)
        cols.append(a[ys][:, xs])
    return np.concatenate(cols, 1)   # yaw starts at -7.5

def sheet(pid, out=None):
    r = M[pid]; meta = json.load(open(CACHE/pid/"meta.json"))
    s = strip(pid); Hs, Ws = s.shape[:2]
    half = Ws//2
    rows = [s[:, :half], s[:, half:]]
    ph = Image.open(CACHE/pid/"photo.jpg").convert("RGB")
    hf = meta["hfov0"]; vf = meta["vfov0"]
    pw = int(hf*PX_PER_DEG); phh = int(vf*PX_PER_DEG)
    small = ph.resize((max(pw, 10), max(phh, 10)))
    big = ph.copy(); big.thumbnail((1000, 560))
    W = half + 60; Htot = 30 + max(big.height, small.height) + 2*(Hs+40) + 10
    S = Image.new("RGB", (W, Htot), (25,25,25)); D = ImageDraw.Draw(S)
    tg = r["tags"]
    D.text((5, 4), f"{pid} {r['posSrc']} hfov={hf:.0f} {tg['season']} {tg['weather']} T6 {r['t6']['level']} {r['t6']['verdict']} yaw={r['t6']['pose']['yaw']:.0f}  | {r['title'][5:60]}", fill=(255,255,0), font=font)
    S.paste(big, (5, 30)); S.paste(small, (big.width+20, 30))
    D.text((big.width+20, 30+small.height+4), "photo @ ring scale", fill=(200,200,200), font=font)
    y0 = 30 + max(big.height, small.height) + 10
    marks = [(c["yaw"], (0,255,0)) for c in r["correctRefs"]] + [(c["yaw"], (255,60,60)) for c in r["wrongRefs"]] + [(r["t6"]["pose"]["yaw"], (0,255,255))]
    if r.get("loma"): marks.append((r["loma"]["pose"]["yaw"], (255,0,255)))
    for k, row in enumerate(rows):
        oy = y0 + k*(Hs+40); S.paste(Image.fromarray(row), (30, oy+20))
        base = k*180
        for deg in range(0, 181, 15):
            x = 30 + (deg + 7.5)*PX_PER_DEG
            if x > 30 + row.shape[1]: continue
            D.line([(x, oy+14), (x, oy+20)], fill=(255,255,255)); D.text((x-12, oy-4), f"{(base+deg)%360}", fill=(255,255,255), font=font)
        # horizon line
        D.line([(30, oy+20+Hs//2), (30+row.shape[1], oy+20+Hs//2)], fill=(90,90,90))
        for yaw, col in marks:
            dd = (yaw - base + 7.5) % 360
            if dd < 180 + 0.0:
                x = 30 + dd*PX_PER_DEG
                D.line([(x, oy+20), (x, oy+20+Hs)], fill=col, width=2)
                # FOV extent bar
                D.line([(x-hf/2*PX_PER_DEG, oy+20+Hs-4), (x+hf/2*PX_PER_DEG, oy+20+Hs-4)], fill=col, width=3)
    S.save(out or H/f"sheets/{pid}_ring.jpg", quality=78)
    return S.size

if __name__ == "__main__":
    for p in sys.argv[1:]: print(p, sheet(p))
