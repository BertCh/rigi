# FUND E0r: rotation half of E0 with an unclipped skyline (2026-10-02)

**What.** E0's rotation predictor `-hfov/w*` was confounded by pitch-0 ring clipping (14/50 photos got w* = 360). Re-run with
the 360 degree skyline computed from Mapterhorn by horizon-fast (node, no rendering) at the stated eye
(`max(GPS alt, ground + 1.6)`), everything else as E0's analysis A (same 50 dev ids, F1 labels, floor 0.10 deg, hfov source, w* code).

**Protocol.** `tools/research/fund/e0r_rotation/PROTOCOL.txt` (committed first). Report and numbers: `REPORT.txt`, `results.json`.
Code: `scripts/research/e0r-skyline.ts` (writes `out/research/e0r/`, gitignored), `e0r_evaluate.py`.

**Verdict: KILL** (fixed rule: AUROC < 0.65). Dev, n = 16 vs 19, not a result: AUROC 0.488 [0.29, 0.69], p = 0.55.
Sanity: E0 recomputed 0.594 (reported 0.599); eye rule reproduces the one surviving cache eye (910.292 vs 910.298 m);
w* = 360 for 0/50 photos now. Median w* is 7 (SUCCESS) vs 8 (ROT): E0's wider ROT median came from the clipped 360s.
Secondary: no floor in 0.05-0.5 deg reaches 0.65 (ROT vs rest 0.58-0.62). Restricted to E0's < 30% clipped photos: 0.676
(6 vs 9, CI 0.34-0.99; not evidence). The ring-vs-horizon-fast elevation comparison was skipped (E0's ring skylines are gone).

**What survives.** The horizon-fast 360 skyline script as a way to get an unclipped skyline for any photo without rendering.
The product idea "ask for a wider view / second photo because the skyline is not unique in the FOV" has no support from this predictor.

**Follow-ups (not planned).** A blinded or finer rotation label, and a predictor that accounts for roll/focal uncertainty,
would be needed before trying again.
