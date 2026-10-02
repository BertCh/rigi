# tools/matcher/reference: Python reference for the browser matcher

These modules are what the former matcher HTTP service (`tools/matcher/server`, removed 2026-10-02) ran
around `../match.py` and `../fusion.py`: `core.py` (matching building blocks and the legacy rotation solve),
`fuse.py` (in-memory `fusion.solve_photo`), `t6.py` (policy `t6`: the T6 stage-1 search and frozen rule) and
`sky_gpu.py` (exact numpy re-score of the GPU skyline-grid cells). They are the Python reference that the
browser ports in `src/lib/matcher` (`core.ts`, `fusion.ts`, `t6.ts`, `rule.ts`) and `src/lib/pose6dof` were
checked against, and `src/lib/matcher/__tests__/fixtures/make_fixtures.py` records its parity fixtures from
them. They are not a service and nothing in the app calls them; `t6.py` still expects the removed render
worker for a live run, so it is read as reference only. Run the fixture scripts with `tools/matcher/.venv`
(see `../README.md`).
