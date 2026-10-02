# Step ⑬ DEM anchoring: review, research, plan (2026-10-02)

Step lead: Opus pod `dem-anchoring` (coordinator mt-image-17). Node `dem-anchoring` in `src/lib/gipfelbuch/graph.ts`,
modules `src/lib/nearfield/anchor.ts` and `src/lib/nearfield/geom.ts` (this pod edits them; the step-inside pod
proposes changes here). All numbers below are DEV-set numbers (tools/research/tm x2 MoGe-L depth on the TM dev
cache). They are evidence for the next change, not results.

## 1. Current state

Pipeline (one photo, accepted pose only):

1. `controller.ts:330-334` samples the shared near-camera DEM (`near-dem.ts`, z16) once per depth cell into
   `demGrid` (`geom.sampleDemGrid`), `scene.ts:285-298` hands `gridDemRange(grid)` to `fitAnchor` with the look's
   P(sky) mask (0..255) and the engine's people mask.
2. `anchor.ts:fitAnchor` (default mode `curve`): candidates on a stride grid (≤ 40k), model z → ray length with the
   PHOTO intrinsics (`geom.rayFactor`, `intrinsicsFromPose`), DEM range 15–3000 m, then `fitCurve`: a monotone
   log-log piecewise-linear map over ≤ 6 octave-weighted quantile knots, fitted by DP on a 0.02-log grid to the
   truncated-L1 loss with segment slopes in [0.75, 6], a slope-1 tie-break and a weighted-median sub-grid shift.
3. `anchorQuality` = inlierFrac · exp(−(median |log residual| over all candidates / 0.2)²); 0 below 200 candidates.
4. `controller.ts:451` hides the scene below `ANCHOR_MIN_QUALITY` = 0.15 (`types.ts:94`); `LOW_TRUST_QUALITY`
   (`controller.ts:54`, 0.35) sets the panel's "low trust" chip (`StepInsidePanel.tsx:32`).
5. Placement: `anchoredRange` / `curveRange` in `split.ts:112`, `lift.ts:96`, `ground.ts:248,289,413,530`,
   `scene.ts:209`, `object-prior.ts:108`, `complete/index.ts:179`; grounding (`ground.ts`) overrides the curve per
   object component with the DEM/model factor at its ground contacts.
6. Opt-ins: `?anchorCliff=on` (cliff-lip mask, `cliff-lip.ts`), `?tiles3dObjects=on` (nDSM object prior). Roll
   spots (`roll/spot.ts:198`) run their own `fitAnchor` per photo.

Tests before this pass: `__tests__/anchor.spec.ts` (24), `geom.spec.ts`, `anchor-parity.spec.ts`,
`cliff-lip.spec.ts`, `nearfield.check.ts` (synthetic: ramp, wall, compressed model + person). No test ran the
real TS fit on real photos; the only real-data validation is the Python port `tools/nearfield/spike/place.py`
(PLACEMENT.txt, 2026-09-28). No GPU island (the fit is ~90 ms CPU; `gpu/app-graph/manifest.ts` has no entry).

## 2. Findings (ranked)

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F1 | P1 | `anchor.ts:164` (pre-fix) | `curveRange` near-relaxation weight was unclamped. A one-knot curve (narrow model range, so every quantile knot within 0.2 log) takes that branch ABOVE its knot too, so the DEM/model ratio grew without bound past the knot (knot 100 m at ×3: 1 km placed at 11 km instead of 3 km). Multi-knot curves never reach it above the first knot, so they are unaffected. | fixed (unit U1) |
| F2 | P2 | `anchor.ts:481-486` (pre-fix) | When Σ slopeMin·Δx exceeds the y grid (model spans many more octaves than the DEM, e.g. a contaminated near field over a flat-range DEM), every DP cell is infinite and the backtrack walked unset `Int32Array` entries (all 0): a flat, non-monotone-in-spirit curve at g0. | fixed: constant-ratio fallback (U1) |
| F3 | P2 | quality calibration | `ANCHOR_MIN_QUALITY` / low-trust were calibrated on the spike (scale-only R3000, then re-checked with the curve in PLACEMENT.txt: ≥ 0.15 on 20/27). Object-rich photos mostly fail (only wc_0059, wc_0076 of 7 pass 0.15). Recorded negatives: excluding Object candidates and octave-weighted quality did not change the pass count. Do not redo. | open, see plan U4 |
| F4 | P2 | fit inputs | Silhouette / mixed pixels (ridge against far terrain, object outlines, DEM holes) enter the fit; nearest-cell DEM vs smoothed model depth disagree there by construction. `cliff-lip.ts` covers DEM jumps only, opt-in, and only in the lip configuration's mask. | opt-in `edgeGuard` (U1), measured in U3 |
| F5 | P2 | `anchor.ts:345-352` | Octave weights give a sparse octave (a handful of eye-height-dominated near cells) the same total weight as a full octave. PLACEMENT.txt kept octave weights because they fix 15–50 m (0.40 → 0.21) — so the knob is a floor, not removal. | opt-in `octaveMinShare` (U1), measured in U3 |
| F6 | P3 | `controller.ts:54` vs `anchor.ts:118` | Two low-trust constants (`LOW_TRUST_QUALITY` = max(0.35, gate + 0.15), `ANCHOR_LOW_TRUST` = 0.35). Same value today; the export (`export/splat.ts:232`) uses the anchor one, the panel the controller one. | proposal for step-inside (below) |
| F7 | P3 | `geom.ts:51-54` | `maskSampler` decides 0/1 vs 0..255 from the mask max: a 0..255 mask whose max is ≤ 1 (almost no sky, P ≤ 1/255) is read as binary, so P = 1/255 counts as sky. Harmless in practice (it drops a handful of near-zero-sky cells). | note only |
| F8 | P3 | `anchor.ts:191-201` | With `cliffLip`, `fitAnchor` re-grids `demRangeAt` although every caller already passes `gridDemRange(grid)`. O(W·H) closure calls, a few ms. | note only |
| F9 | P3 | docs | Gipfelbuch and `anchor.ts:107` say a low-trust scene is "faded"; the app only labels it (panel chip). | Gipfelbuch correction below |

## 3. Research summary

- **Global vs local alignment.** Standard practice for metric-from-relative depth is a global scale/shift (least
  squares, often in disparity) against sparse anchors; piecewise-by-depth-interval affine fits trade robustness for
  flexibility because each interval gets fewer anchors ("Learning Image-Adaptive Scale Fields for Metric Depth
  Recovery", arXiv 2605.07418, which instead learns basis maps weighted by the anchors). Our curve is the
  depth-interval variant made robust by a truncated L1 loss, a monotone slope band and DP global optimality; the
  dense DEM (≈ 10⁴ anchors per photo) is why the interval fragmentation that paper warns about does not bite here.
- **Spatially varying scale fields** (locally weighted regression, basis-map fields, DepthP+P's local affine
  transforms, Prior Depth Anything / PromptDA-style prompting) would address the one failure the curve cannot
  model (MoGe smoothing depth across a ridge silhouette, PLACEMENT.txt). The trap for Rigi: a spatial field fitted to
  terrain will also absorb the near objects the split is meant to find (objects are exactly where the DEM disagrees).
  Learned prompting models are new weights (licence + download) — user decision, not now.
- **DEM as the metric prior.** TanDepth (Florea & Nedevschi, arXiv 2409.05142) rescales relative UAV depth with a
  projected global DEM and selects ground points in the depth map first (a cloth-simulation filter) — the same
  idea as our octave-weighted terrain candidates plus the split; Finding DEM0 (ESA Φ-lab, 2025) calibrates
  foundation depth into DEMs zero-shot. Neither handles ground-level photos with near objects in front of far
  terrain, which is the one-sided contamination our truncated loss and slope floor exist for.
- **Own recorded negatives** (reports/negative-results.md:66-72): MoGe metric scale as-is; single scale / affine /
  mode-of-log anchors; anchor fit as a pose verifier (AUC 0.73); a quality gate ≥ 0.2–0.35; unifying both renderers
  on near-DEM z16 without a cliff rule (IMG_7059 0.95 → 0). PLACEMENT.txt sweeps: no octave weights, slopeMin 0.5, 8
  knots, Object-excluded quality, octave-weighted quality.

Sources: [Image-adaptive scale fields](https://arxiv.org/pdf/2605.07418), [TanDepth](https://arxiv.org/abs/2409.05142),
[Finding DEM0](https://cin.philab.esa.int/databases/projects/finding-dem0-a-zero-shot-depth-maps-calibration-framework-for-generating-digital-elevation-models),
[DepthP+P overview](https://www.emergentmind.com/topics/depthp-p).

## 4. Plan

| Unit | What | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| U1 | F1 + F2 fixes; opt-in `edgeGuard` (AnchorOpts) and `octaveMinShare` (CurveOpts), default off and bit-identical; specs | S | low | vitest, nearfield.check | now |
| U2 | Offline gate: `dump_anchor_inputs.py` (dev dumps on the spike grid) + `scripts/nearfield/anchor-eval.ts` running the REAL `fitAnchor`; parity with PLACEMENT.txt | M | low (tooling) | parity ≈ 0.131 / 20 of 27 | now |
| U3 | Measure U1 knobs with U2 (edgeGuard ln1.3–ln2, octaveMinShare 0.01–0.05, cliff); promote a knob to default only if terrain residual improves and the q ≥ 0.15 pass count does not drop | S | medium (default placement) | U2 dev table | now |
| U4 | Anchor confidence beyond one scalar: report the curve's calibrated span (metres) and the share of Object splats placed by extrapolation beyond it; export header + panel tooltip | S–M | low | spec + export check | later (touches export/splat.ts + panel: step-inside / export owners) |
| U5 | Spatial residual field on terrain cells only (far field, > nearRadius) to fix ridge-silhouette smoothing; must leave the near split unchanged | L | high | U2 + split clean/OBJ counts | later, research |
| U6 | A ground-contact check for the near end (wc_0076 pylon: curve 2× off below the first knot) using the grounded components' DEM/model factors as extra near knots | M | medium | U2 + place.py grounding table | later |

## 5. Gipfelbuch corrections (do not edit graph.ts here; for the Gipfelbuch owner)

- Summary: "cutting the median log error from 0.34 to 0.13" is right for the dev spike (median over 23 dev photos,
  terrain at DEM 15–500 m, PLACEMENT.txt); say "on 23 development photos". "A poor fit (score below 0.15) hides the
  scene" is right; the 0.15–0.35 band is labelled "low trust", not faded (pages/dem-anchoring.tsx "labelled low
  trust, faded" → "labelled low trust").

## 6. Proposals for the step-inside pod

- Use `ANCHOR_LOW_TRUST` from anchor.ts in `controller.ts:54` (or delete one of the two constants) so the panel
  chip and the export header can never disagree (F6).

## 7. Log

- **U1 landed 6ad885d** (`nearfield/anchor: one-knot curve keeps its ratio above the knot, infeasible slope DP
  falls back to a constant ratio; opt-in edgeGuard and octaveMinShare knobs`). +5 specs in
  `__tests__/anchor.spec.ts` (one-knot regression, infeasible DP, sparse-octave floor, edge guard on a model step and
  on a DEM hole). Default fit unchanged except F1/F2 (one-knot curves above the knot; infeasible DP). Pure CPU, no
  renderer change, so no ledger row. The Python mirror `place.py apply_curve` never had F1 (it has no near
  relaxation at all), so the fix brings TS back to the validated semantics above the knot.
- **U2 landed (this commit)**: `tools/nearfield/spike/dump_anchor_inputs.py` + `scripts/nearfield/anchor-eval.ts` +
  `src/lib/nearfield/anchor-metrics.ts` (spec). Variants: app, scale, affine, noOctave, cliff, edge13/15/20,
  octFloor1/3, edge15octFloor1. Defaults write/read the gitignored `out/anchor-inputs/`.
  **Blocked on data, not code**: the TM dev render cache (`tools/research/tm/cache/<pid>/refs/*/xyz.npz`, built by
  `tools/research/tm/c0_cache/build.py` through a browser render worker) is gone from disk; only
  `cache/wc_0054/meta.json` and two moved-eye views of wc_0086 remain. So PLACEMENT.txt parity on the 23/27 photos
  is NOT measured. What is measured: on the one surviving view (wc_0086 N7, a wrong eye) the TS fit and the
  Python `fit_curve` agree to 4 decimals (quality 0.2104 vs 0.2104, residualLogAll 0.1896 vs 0.1897, same knots), and
  the whole dump → TS pipeline runs for every variant. Expected TS-vs-Python difference on real photos: the app's
  stride thinning (stride 3 on 512×384; `--stride 1` matches place.py).
- **Review pass (Sonnet adversarial reviewer on 6ad885d)**: all four claims confirmed (clamp bit-identical for
  multi-knot curves over 2000 random inputs; every finite DP cell has a valid back-pointer, so the fallback test is
  exact; edgeGuard indexing and default-off; octave floor default bit-identical). Fixes from it, in this commit: the
  fallback spec now checks the ratio is proportional and sane, and an edgeGuard spec at stride 2. Noted, not
  changed: an invalid (sky) model neighbour is not an edge by itself; the DEM-hole rule catches the sky side.
- **Fast tier** (eval worktree, before landing): 109 pass, 4 fail, 5 skip. None of the failures touch nearfield:
  biome NEW errors in `src/lib/roll/import/__tests__/save-status.spec.ts` and `src/routes/roll.import.tsx` (peer work
  already on master), `unit` (python-unit spec and `upload/index.spec.tsx` libheif `?url` denied through the worktree's
  node_modules symlink), `align-cert`, `roll-propagate` (no `public/photos/photos.json` in the worktree). The
  machine also hit ENOSPC mid-run. `npx vitest run src/lib/nearfield` 352/352, biome clean on every changed file.
- **U3 not run** (needs U2's data). The knobs stay opt-in. Side observation on the single wrong-eye view: `cliff`
  raised quality 0.21 → 0.47 and `edge15` 0.21 → 0.24. Masking discontinuities raises quality on a WRONG eye too,
  which is consistent with the recorded negative "anchor fit as a pose verifier"; it is one view, so it is a reason
  to measure, not a result.

## 8. Next

1. Rebuild the dev render cache for the 27 correct-ref dev photos (`c0_cache/build.py`, browser worker) in the next
   batch pass, then run `dump_anchor_inputs.py` and `anchor-eval.ts` for every variant (≈ 60 MB of dumps). This is
   the gate for U3 and for any change to the default fit.
2. U3: promote `edgeGuard` / `octaveMinShare` only on a dev-table win (terrain residual down, q ≥ 0.15 pass count
   not down, OBJ pass count not down); also re-measure `cliff` (S1) on the same table.
3. U4 confidence span (with the step-inside / export owners), then U6 near-end grounding knots.

## 9. Decisions for the user

- Whether the next browser batch may rebuild the TM dev render cache (it is a render-worker job under the render
  lock, ~27 photos). Without it there is no real-data gate for anchoring changes.
- Any learned metric-prompting depth model (PromptDA / Prior Depth Anything class) would be a new model download
  and a licence check; not proposed now.
