"""Photo | sat render | hillshade render at the first verified-correct ref (from cache); rows = photos."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
H = Path(__file__).parent; CACHE = H.parent/"cache"
M = json.load(open(H/"master.json"))
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)
out = sys.argv[1]; ids = sys.argv[2:]
tw, th = 640, 440
S = Image.new("RGB", (tw*3, th*len(ids)), (20,20,20)); D = ImageDraw.Draw(S)
for i, pid in enumerate(ids):
    lab = M[pid]["correctRefs"][0]["label"]; d = CACHE/pid/"refs"/lab
    for j, im in enumerate([Image.open(CACHE/pid/"photo.jpg"), Image.open(d/"rgb.jpg"), Image.open(d/"hill.png")]):
        im = im.convert("RGB"); im.thumbnail((tw, th-26)); S.paste(im, (j*tw, i*th+26))
    D.text((4, i*th+2), f"{pid} ref {lab}  T6 {M[pid]['t6']['level']}/{M[pid]['t6']['verdict']} inl={M[pid]['t6']['checks'].get('inliers')}", fill=(255,255,0), font=font)
S.save(H/f"sheets/{out}.jpg", quality=78)
