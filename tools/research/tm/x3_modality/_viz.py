"""Contact sheet of all modality configs for one photo/view (sanity check)."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1])); sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "c0_cache"))
import tm_common  # noqa
import numpy as np, cv2
import cache_io as C
import modalities as MD
pid, grp, tag = sys.argv[1], sys.argv[2], sys.argv[3]
out = sys.argv[4] if len(sys.argv) > 4 else f"/tmp/x3_{pid}.jpg"
photo = C.load_photo(pid)
ring = [C.load_view(pid, "ring", f"y{y:03d}") for y in range(0, 360, 15)]
P = MD.fit_params(photo, ring); print(P)
v = C.load_view(pid, grp, tag)
H, W = v["rgb"].shape[:2]
ph = cv2.resize(photo, (W, H), interpolation=cv2.INTER_AREA)
tiles = []
for name, (rm, pm) in MD.CONFIGS.items():
    r = MD.render_modality(rm, v, P); p = MD.photo_modality(pm, ph)
    t = np.concatenate([cv2.resize(p, (320, round(320*H/W))), cv2.resize(r, (320, round(320*H/W)))], 1)
    cv2.putText(t, name, (5, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 0), 2)
    tiles.append(t)
rows = [np.concatenate(tiles[i:i+2] + ([np.zeros_like(tiles[0])] if len(tiles[i:i+2]) < 2 else []), 1) for i in range(0, len(tiles), 2)]
cv2.imwrite(out, cv2.cvtColor(np.concatenate(rows, 0), cv2.COLOR_RGB2BGR))
