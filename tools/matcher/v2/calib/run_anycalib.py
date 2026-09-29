"""AnyCalib (anycalib_pinhole, DINOv2 ViT-L) vfov on the same uprighted DEV + GT photos -> pred_anycalib.json.
Weights are cached under calib/weights (TORCH_HOME). vfov only: AnyCalib has no gravity output."""
import json, math, os, sys, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
import numpy as np, torch  # noqa: E402
sys.path.insert(0, str(HERE))
import calib as C  # noqa: E402
import run_eval as RE  # noqa: E402
from anycalib import AnyCalib  # noqa: E402

dev = "mps"
m = AnyCalib(); m.load_state_dict(torch.load(HERE / "weights/anycalib_pinhole.pt", map_location="cpu")); m = m.to(dev).eval()
out = {}
for pid, setn, src, e, truth, dist in RE.items():
    img = C.upright(src); H, W = img.shape[:2]
    x = torch.from_numpy(img).permute(2, 0, 1).float().div(255).to(dev)
    t0 = time.perf_counter(); p = m.predict(x, cam_id="simple_pinhole"); torch.mps.synchronize(); ms = (time.perf_counter() - t0) * 1000
    f = float(p["intrinsics"][0].cpu())
    out[pid] = {"vfov": 2 * math.degrees(math.atan(H / 2 / f)), "f": f, "W": W, "H": H, "ms_mps": ms}
    print(pid, f"{out[pid]['vfov']:.1f}", None if not truth else f"{truth['vfov']:.1f}", f"{ms:.0f}ms", flush=True)
img = C.upright(RE.ROOT / "public/photos/IMG_7086.jpg"); x = torch.from_numpy(img).permute(2, 0, 1).float().div(255)
tm = {}
for d in ("mps", "cpu"):
    m = m.to(d); ts = []
    for _ in range(3 if d == "cpu" else 10):
        t0 = time.perf_counter(); m.predict(x.to(d), cam_id="simple_pinhole")
        if d == "mps": torch.mps.synchronize()
        ts.append((time.perf_counter() - t0) * 1000)
    tm[d] = float(np.median(ts))
json.dump({"_meta": {"model": "AnyCalib anycalib_pinhole v1.0.0", "timing_warm_median_ms": tm}, **out}, open(HERE / "pred_anycalib.json", "w"), indent=1)
print(tm)
