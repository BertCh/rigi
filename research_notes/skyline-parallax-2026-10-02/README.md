# Skyline parallax wrong-eye test (SKYPAR), 2026-10-02

**Verdict: KILL** (fixed criterion). Dev, n = 787 hypotheses over 35 dev photos, not a result.

- **What:** reject a hypothesis when the photo's skyline (the app's U²-Net sky model in node) differs from the DEM
  horizon projected at the hypothesis eye by a significant 1/d-shaped residual that pitch, roll and yaw nuisances cannot absorb.
  Huber fit, chi2 of three eye terms, reject iff chi2 > 16.27 and |delta| > 50 m, abstain without depth diversity.
- **Protocol:** `tools/research/geo/skypar/PROTOCOL.txt` (committed before any score). Report and per-hypothesis
  results: `REPORT.txt`, `results.json`, `analysis.txt` in the same directory.
- **Dev numbers:** 2 of 19 positives the current gate accepts are rejected (kill if any); 21/56 NE-dec rejected
  (37.5%, passes the 30% clause); 3/10 E1-NFA-accepted NE-dec rejected (needs 5). All 33 POS: 6 lost. NB-con 39/93.
  150 m 10/29, 400 m 11/27. Abstention 220/787 overall, 19/33 POS, 17/56 NE-dec. AUROC 0.61.
- **Why:** chi2 is uncalibrated (all 14 non-abstained POS exceed the threshold, median 2404), the first-order model
  breaks at 150-400 m against a 2-4 km ridge, and most correct poses have a far-only skyline.
- **Code:** removed after the kill (cleanup rule: no killed code in `src/`). Recover the module, its specs and
  the eval script with `git show 31752b8:src/lib/geocam/integrity/skyline-parallax.ts` (and `…/__tests__/skyline-parallax.spec.ts`,
  `…:scripts/geocam/skypar-eval.ts`).
- **Follow-up (not started):** a per-photo calibrated null and a re-marched Gauss-Newton fit, under a new prereg.
