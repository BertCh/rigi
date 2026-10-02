# tools/matcher: offline Python (reference, research, model export)

The app does not use any of this: render-and-match runs in the browser (`src/lib/matcher`, behind
`src/lib/matcher-client.ts`), and there is no matcher service any more (removed 2026-10-02; its design doc
is `reports/archive/matcher-service.md`). What is here:

- `match.py`, `common.py`, `fusion.py`, `dem.py`, `pose6.py`, `pose6_inputs.py`: the matcher algorithms the
  TypeScript port was verified against, also imported by the research and frozen benchmark code
  (`tools/bench/final`, `tools/research/*`, `v2/`).
- `reference/`: the service-side modules kept as the Python reference for the browser ports and the parity
  fixtures (see `reference/README.md`).
- `stage1/`, `v2/`: study records (T6 stage-1 search, matching v2). `stage1/vendor*` and `worker_client.py`
  are frozen snapshots of the old render worker for reruns of those studies.

## Python environment

`tools/matcher/.venv` is the shared research and model-export venv: `scripts/models/*.py` (the weight
producers behind `scripts/models/fetch.mjs`), the `*.check.ts` parity scripts and the research code use it.
The weights and `.venv` are gitignored; `requirements.txt` was derived from the imports in `tools/matcher/**`
and the maintainers' venv:

- Python 3.10+ (developed on macOS Apple Silicon, MPS; CPU works, slowly).
- `torch` (MPS or CPU), `numpy`, `scipy`, `opencv-python` (`cv2`), `Pillow`.
- `lightglue` (cvg/LightGlue: ALIKED + LightGlue, weights download into `tools/matcher/weights` through
  `TORCH_HOME`), `romatch` (RoMa, only for the optional dense-match path), `poselib` (pose solver).

```
cd tools/matcher
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

`requirements.txt` pins the direct dependencies as run by the maintainers (Python 3.12, torch 2.14). On
CUDA machines install the matching torch wheel from pytorch.org first (see the comment in the file).

Weights licences are in `reports/licences.md`.
