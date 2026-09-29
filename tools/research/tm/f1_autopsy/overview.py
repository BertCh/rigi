import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
H = Path(__file__).parent; ROOT = H.parents[3]
M = json.load(open(H/"master.json"))
bad = [p for p, r in M.items() if not (r["t6"]["level"] == "HIGH" and r["t6"]["verdict"] == "correct")]
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
def tile(pid, w=760, h=520):
    im = Image.open(ROOT/f"tools/bench/data/photos/{pid}.jpg").convert("RGB"); im.thumbnail((w, h-30))
    t = Image.new("RGB", (w, h), (30,30,30)); t.paste(im, ((w-im.width)//2, 30))
    r = M[pid]; tg = r["tags"]
    ImageDraw.Draw(t).text((5,3), f"{pid} {r['posSrc']} f35={r['focal35']} {tg['season']} {tg['weather']} T6={r['t6']['verdict']}", fill=(255,255,0), font=font)
    return t
for i in range(0, len(bad), 6):
    ids = bad[i:i+6]; S = Image.new("RGB", (760*3, 520*2))
    for j, p in enumerate(ids): S.paste(tile(p), ((j%3)*760, (j//3)*520))
    S.save(H/f"sheets/overview_{i//6}.jpg", quality=80); print(ids)
