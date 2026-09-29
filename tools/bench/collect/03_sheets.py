"""Step 3: download small thumbnails for candidates and build 4x4 contact sheets for visual screening.

Run with tools/matcher/.venv/bin/python (needs PIL).
Usage: python 03_sheets.py [start] [end]
Output: work/thumbs/<idx>.jpg, work/sheets/sheet_XXX.jpg (idx labels = index into candidates.json)
"""
import io
import os
import sys
import urllib.parse

from PIL import Image, ImageDraw, ImageFont

from common import WORK, check_disk, http_get, load

TW, TH = 400, 300


def thumb_url(url, width=330):
    # https://upload.wikimedia.org/wikipedia/commons/a/ab/Name.jpg -> .../thumb/a/ab/Name.jpg/330px-Name.jpg
    parts = url.split("/wikipedia/commons/")
    name = parts[1].split("/")[-1]
    return f"{parts[0]}/wikipedia/commons/thumb/{parts[1]}/{width}px-{name}"


def main():
    cands = load("candidates.json")
    a = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    b = int(sys.argv[2]) if len(sys.argv) > 2 else len(cands)
    check_disk()
    tdir = os.path.join(WORK, "thumbs"); os.makedirs(tdir, exist_ok=True)
    sdir = os.path.join(WORK, "sheets"); os.makedirs(sdir, exist_ok=True)
    try:
        font = ImageFont.load_default(size=26)
        small = ImageFont.load_default(size=16)
    except TypeError:
        font = small = ImageFont.load_default()
    for i in range(a, b):
        p = os.path.join(tdir, f"{i}.jpg")
        if os.path.exists(p):
            continue
        try:
            data = http_get(thumb_url(cands[i]["url"]))
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((TW, TH))
            im.save(p, quality=80)
        except Exception as e:  # noqa
            print("thumb fail", i, cands[i]["title"], e)
    for s in range(a // 16, (b + 15) // 16):
        sheet = Image.new("RGB", (4 * TW, 4 * TH), (40, 40, 40))
        d = ImageDraw.Draw(sheet)
        for k in range(16):
            i = s * 16 + k
            if i >= len(cands):
                break
            p = os.path.join(tdir, f"{i}.jpg")
            x, y = (k % 4) * TW, (k // 4) * TH
            if os.path.exists(p):
                im = Image.open(p)
                sheet.paste(im, (x + (TW - im.width) // 2, y + (TH - im.height) // 2))
            c = cands[i]
            f35 = c.get("focal35mm")
            info = f"f35={f35:.0f}" if f35 else "f35=?"
            if c.get("headingDeg") is not None:
                info += " H"
            d.rectangle([x, y, x + 60, y + 30], fill=(0, 0, 0))
            d.text((x + 4, y + 2), str(i), fill=(255, 255, 0), font=font)
            d.text((x + 4, y + TH - 20), info, fill=(0, 255, 255), font=small, stroke_width=2, stroke_fill=(0, 0, 0))
        sheet.save(os.path.join(sdir, f"sheet_{s:03d}.jpg"), quality=80)
    print("done", a, b)


if __name__ == "__main__":
    main()
