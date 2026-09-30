FUND: first-principles experiments (plan: reports/fundamentals-plan.md), started 2026-09-29.
Phase 0 = E0 observability, E1 a-contrario accept, E2 date-matched appearance, E3 near-field fidelity.

HARD RULES (every agent) — inherits tools/research/tm/README.md rules:
- DEV ONLY: 50 dev ids (tools/matcher/v2/refs.py dev_ids / correct_refs / wrong_refs; tm_common.assert_dev).
  Never open/render/run a test id or anything in tools/bench/data_v3. Do not open the H1 blind pack overlays.
- Write only under tools/research/fund/<your study>/. Read-only elsewhere. No edits to src/**, tools/matcher/**,
  tools/bench/**, tools/research/tm/**, package.json, reports/**.
- Never call live services (:8765 :8766 :8767 :8768 :3000 :3100). Rendering via the stage-1 worker on a private
  port 8790-8799 ONLY while holding tm_common.render_lock(). Heavy MPS models (LoMa etc.) only under tm_common.gpu_lock().
- Python: tools/matcher/.venv/bin/python. New packages: pip install --target tools/research/fund/.pylib only.
- Disk: check df -h first; whole fund/ dir < 3 GB; delete intermediates you don't need.
- Kill criteria in reports/fundamentals-plan.md §3 are FIXED; write your rule/protocol file before scoring.
- Output: <study>/REPORT.txt (plain text; honest; label post-hoc findings) + machine-readable results json.
