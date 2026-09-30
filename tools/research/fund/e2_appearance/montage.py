"""Side-by-side example: photo | v0 | v1 | v2 | v3 | v4 at a view (small JPEG into examples/)."""
import sys
import cv2, numpy as np
from common import C, OUT

def montage(pid, key, w=320):
    g, tag = key.split("__")
    v = C.load_view(pid, g, tag)
    H, W = v["rgb"].shape[:2]
    ph = cv2.resize(C.load_photo(pid), (W, H), interpolation=cv2.INTER_AREA)
    ims = [ph, v["rgb"]] + [cv2.cvtColor(cv2.imread(str(OUT / "variants" / pid / f"{key}__v{i}.jpg")), cv2.COLOR_BGR2RGB) for i in range(1, 6)]
    labs = ["photo", "v0 current", "v1 sun-relit", "v2 +snow", "v3 +haze fit", "v4 v0+haze fit", "v5 (iv) +S2"]
    h = round(w * H / W)
    tiles = []
    for im, lab in zip(ims, labs):
        t = cv2.resize(im, (w, h), interpolation=cv2.INTER_AREA).copy()
        cv2.putText(t, lab, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 0), 1, cv2.LINE_AA)
        tiles.append(t)
    grid = np.vstack([np.hstack(tiles[:4]), np.hstack(tiles[4:8] + [np.zeros_like(tiles[0])] * (8 - len(tiles)))])
    (OUT / "examples").mkdir(exist_ok=True)
    f = OUT / "examples" / f"{pid}__{key}.jpg"
    cv2.imwrite(str(f), cv2.cvtColor(grid, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
    return f

if __name__ == "__main__":
    print(montage(sys.argv[1], sys.argv[2]))
