# TM: terrain-matching deep research program (started 2026-09-27)

*Finished 2026-10-01. Synthesis and the strategy carried forward: `reports/terrain-matching-research.md`. The rules below are as run (2026-09-27 to 10-01): the live services they name (:8765, :8766) and `research_notes/matching_v2_research.md` were removed since (`git show 384df44:<path>` for the note); the dev server is on :3100. Later dev-only programmes (`tools/research/fund`, `tools/research/geo`) inherit these rules.*

Goal: understand *why* photo↔terrain matching fails, and test technical ideas that prior work (reports/matching-v2.md,
tools/matcher/v2/loma/REPORT.md) proposed but never measured.

## Hard rules (every agent)
- DEV ONLY: the 50 `dev` ids of tools/bench/split.json (use tools/matcher/v2/refs.py → dev_ids / correct_refs / wrong_refs).
  Never open, render or run a `test` id or anything in tools/bench/data_v3.
- Read-only on everything outside tools/research/tm/** and research_notes/tm_*.md. Do not edit tools/matcher/**,
  tools/bench/**, src/**, package.json, or any existing report.
- Never call the live services (:8765, :8766, :3000). Rendering uses the stage-1 worker (tools/matcher/stage1/s1.py Worker/
  Session/Photo) on a private port in 8790–8799, and ONLY while holding the render lock (tm_common.render_lock()).
  One render worker at a time machine-wide (machine has 36 GB RAM and swap is nearly full).
- Python: tools/matcher/.venv/bin/python (torch 2.14, lightglue, lomatch, geocalib, poselib, kornia, cv2).
  New pip installs go into a separate venv tools/research/tm/.venv created with `--system-site-packages`-free copy of
  what you need, or `pip install --target tools/research/tm/.pylib`; never pip install into tools/matcher/.venv.
  Weights under tools/research/tm/weights. Check `df -h` before downloads; keep total TM disk < 8 GB.
- Heavy MPS models (LoMa ~10 GB): at most one heavy MPS job at a time — take tm_common.gpu_lock().
- Report numbers honestly; negative results are results. Label anything post hoc.

## Layout
- tm_common.py — locks, dev ids, cache loader
- cache/ — shared dev render cache (built by C0): per photo npz/jpg
- c0_cache/, x1_yawcorr/, x2_geom/, x3_modality/, f1_autopsy/ … one dir per study, each with REPORT.md
