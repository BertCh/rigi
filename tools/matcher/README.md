# tools/matcher: optional Python backend

The app runs without any of this. The matcher service (`:8765`, render-and-match escalation) and the
near-field service (`:8767`, Step Inside) are optional; `node scripts/dev.mjs --be` starts them only when
`tools/matcher/.venv/bin/python` exists and otherwise skips them with a warning. A fresh clone type-checks
(`npx tsc --noEmit -p .`), builds (`npm run build`) and passes the fast tier without any Python (checks whose
gitignored inputs `data/`, `public/photos/`, `.cache/` are missing report SKIP).

## Python environment

The weights and `.venv` are gitignored; `requirements.txt` (below) was derived from the imports in
`tools/matcher/**` and the maintainers' venv:

- Python 3.10+ (developed on macOS Apple Silicon, MPS; CPU works, slowly).
- `torch` (MPS or CPU), `numpy`, `scipy`, `opencv-python` (`cv2`), `Pillow`.
- `lightglue` (cvg/LightGlue: ALIKED + LightGlue, weights download into `tools/matcher/weights` through
  `TORCH_HOME`), `romatch` (RoMa, only for the optional dense-match path), `poselib` (pose solver).
- The render worker (`server/render_worker.mjs`) is Node and uses `playwright` (already an npm dependency;
  run `npx playwright install chromium` once). It needs `vite dev` on :3100.
- The near-field service (`tools/nearfield/service`) shares this venv and has its own weights under
  `tools/nearfield/service/weights` (`HF_HUB_OFFLINE=1`, so models must be pre-downloaded); see
  `tools/nearfield/` and `reports/` for the models it needs.

```
cd tools/matcher
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
# near-field service extras (same venv): .venv/bin/pip install -r ../nearfield/requirements.txt
```

`requirements.txt` pins the direct dependencies as run by the maintainers (Python 3.12, torch 2.14). On
CUDA machines install the matching torch wheel from pytorch.org first (see the comment in the file).
`tools/nearfield/requirements.txt` includes it and documents the vendored `.pylib` folders and weights.

Weights licences (ALIKED, LightGlue, RoMa, DepthPro-class models) are in `reports/licences.md`; check them
before shipping any of this as a hosted service.
