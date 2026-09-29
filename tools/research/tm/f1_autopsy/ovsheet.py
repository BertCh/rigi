"""Sheet of existing blind-verification overlays (DEV ids only) from verify_v2: args pid_label ..."""
import sys, json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
H = Path(__file__).parent; ROOT = H.parents[3]
DEV = set(json.load(open(ROOT/"tools/bench/split.json"))["dev"])
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
out = sys.argv[1]; items = sys.argv[2:]
tw, th = 760, 560; cols = 3; rows = (len(items)+cols-1)//cols
S = Image.new("RGB", (tw*cols, th*rows), (20,20,20))
for k, it in enumerate(items):
    pid = it.rsplit("_", 1)[0]; assert pid in DEV, pid
    im = Image.open(ROOT/f"tools/bench/harness/out/runs/wild/verify_v2/{it}.jpg").convert("RGB"); im.thumbnail((tw, th-28))
    x, y = (k%cols)*tw, (k//cols)*th; S.paste(im, (x, y+28)); ImageDraw.Draw(S).text((x+4, y+2), it, fill=(255,255,0), font=font)
S.save(H/f"sheets/{out}.jpg", quality=78)
