# Step ⑦ Tap-a-Peak: review, research, plan, iteration (2026-10-02)

Step lead: Opus pod (mt-image-17 step pods). Graph node: `tap-a-peak` in `src/lib/gipfelbuch/graph.ts:238`
("A tap is a measurement with a name on it"). Dev numbers below are synthetic (seeded node sweeps); none is a
benchmark result.

## 1. Current state

| piece | where | what it does |
|---|---|---|
| App pin solver | `src/lib/align.ts:919-993` `solvePins` | Hand-rolled LM on pixel residuals; ladder 1 pin yaw+pitch, 2 + roll, ≥ 3 + vfov; weak priors `(roll−prior.roll)·0.5`, `(vfov−prior.vfov)·0.5`; behind-camera residual is a constant `[10, 10]` |
| GT builder | `scripts/eval-app.mjs:127`, `scripts/leaderboard.mjs:1515`, `scripts/gpu/w4b-eval-app-deck.mjs:63`, `scripts/geocam/eval-app-flags.mjs:151` | The same `engine.solvePins` from the compass prior builds GT from `data/control-points.json`. **Any change to `solvePins` changes GT**, so it stays frozen |
| Engines | `src/lib/deck/engine.ts:2500`, `src/lib/deck-webgpu/engine.ts:3532` | `Renderer.solvePins(pins, from = this.pose, solveFov)` |
| Workspace pin tool | `src/components/PhotoWorkspace.tsx:957-970` (tap), `:1501-1507` (pin dots), `:2079` (Clear) | Choose a peak label, tap: re-solve from the **current** pose, state `pinned`, note "Solved from N pinned peaks" |
| Picker tap-a-peak | `src/lib/picker/PickerPanel.tsx:452-526`, `candidates.ts:88-204` | Behind `?picker=on`. Tap → `nearbyPeaks` (15° window, under every candidate pose) → menu → `rerankWithTaps` solves from every candidate start, `TAP_MAX_PX = 12` on 1000 px |
| Geo-level twin | `src/lib/geo/control-points.ts:61` `solveFromControlPoints` (via `geo/lm.ts`) | Same ladder in az/el, 10 % focal prior, yaw wrap, level points; used only by `src/baseline-ui/BaselinePage.tsx:358` |
| Provenance | `ontology/crosswalk/pose.ts:179` (`pinned` = endorsed, agent user), `nearfield/controller.ts:70` | Never an automatic HIGH (`picker/candidates.ts isAutoHigh`; `candidates.check.ts:158`) |

## 2. Findings (ranked)

Sweeper evidence: synthetic 4000×3000 camera, 200–300 seeded trials per row (`scratchpad/exp/e1–e4.ts`, `sweep.ts`).

**P1-1 Far starts fail, silently.** `align.ts:923-932, 966-991`. Past ~90° of yaw the summits are behind the
start camera; `[10, 10]` is a flat plateau with zero gradient, and `solvePins` returns the prior unchanged (0/200
success at 120° and 180° for every pin count). With ≥ 3 pins and vfov free, starts 50–70° off run vfov away
(−180…675° seen; success 118/200 at 50°, 35/200 at 70°). The picker hides this by solving from every candidate,
the workspace tool does not (it solves from the shown pose).

**P1-2 A mis-named peak is absorbed and not shown.** With one wrong name among three pins: RMS median 409 px, yaw
error median 6.3° (p90 29°), vfov 36–124°; yet `PhotoWorkspace.tsx:967` sets `pinned` (endorsed) regardless. One
pin can never reveal a wrong name (redundancy 0, residual ≈ 0 whatever was named), so the picker's
"tap-consistent" test (`TAP_MAX_PX`) is vacuous for one tap.

**P2-1 Workspace pin tool state.** `:2079` Clear only empties pins: the pose stays and `alignState` stays `pinned`
with zero pins; no single-pin removal or undo; each tap re-solves from the previous solution, so the weak
roll/vfov anchors drift cumulatively (`deck/engine.ts:2500` default `from = this.pose`); pin dots are drawn at the
tap, not at the projected summit, so no residual is visible. After reload the state is `saved` (pin provenance
lost). Same "solve from the solved camera" drift in `BaselinePage.tsx:358`.

**P2-2 Weak priors in mixed units.** `align.ts:960`: degrees × 0.5 against full-resolution pixels, so the anchor is
negligible on a 4032-px photo and matters on a 1000-px one (2 close pins, 3 px noise, roll error median 1.10° at
1000 px vs 0.24° at 4000 px). The vfov prior row is present even when vfov is fixed (harmless).

**P2-3 Picker UX (pod B owns `src/lib/picker/**`; proposals only).**
- Taps are keyed by name (`PickerPanel.tsx:487`): two summits with the same name (common: Schwarzhorn, Rothorn)
  replace each other. Key by `world`.
- The peak menu opens at `top-2 left-2` of the tap (`:567`) with `w-52`: off-screen near the right/bottom edge on a
  phone. Rows are `py-0.5` at 11 px (~20 px tall), under the 44 pt / 48 dp touch minimum.
- No loupe: the finger hides the summit being tapped. Touch error is ~1.6–4 mm (Holz & Baudisch 2010/2011), about
  10–25 CSS px, which on a 4000-px photo shown 390 px wide is 100–250 photo px (≈ 2–4° at f ≈ 3500 px).
- `nearbyPeaks` offers summits hidden behind terrain (no visibility test), sorted by angle only. From the second
  tap on, the menu can be ranked by `pins/diagnostics.ts pairFitDeg` (rotation-free), which puts the right name
  first and marks names that cannot fit.
- Single-tap removal and per-tap residual are missing.

**P3** `solvePins` yaw is not wrapped (consumers wrap); 50 iterations count rejected steps; two pins on one pixel give
a perfect fit with roll from the prior and no warning; `solvePins` and `solveFromControlPoints` duplicate the
ladder (unify only as a new function, GT is frozen).

### Gipfelbuch corrections (node text; graph.ts is not edited by this pod)

- `summary` says "A pinned pose is user-confirmed, never auto-accepted." True, but `pinned` is *endorsed*:
  Step Inside treats it as accepted (`nearfield/controller.ts:70`) with no residual gate. Suggested:
  "Taps solve the rotation (the eye stays at the GPS fix): one sets direction and tilt, two add roll, three or more
  add the lens. One tap cannot be checked; from two on, a wrong name shows as a misfit. A pinned pose is the
  user's, never an automatic accept."
- `modules` should add `src/lib/pins/diagnostics.ts`, `src/lib/pins/seed.ts` once landed.
- `lede` "tap three to set the lens too" is right; worth adding "tap two to check each other".

## 3. Research summary

- **Closed form first.** Rotation from two directions: TRIAD (Black 1964), Wahba (1965), Horn (1987), Kabsch
  (1976). Known centre + unknown focal from **two** points is the minimal case, solved by the angle constraint
  (Guo et al., *Sensors* 2021, https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8512203/). The angle between two
  summits seen from the eye is rotation-free; it fixes the lens, then TRIAD fixes the rotation. LM only polishes.
- **Few correspondences: detect vs identify.** Redundancy r = 2n − k: 1 pin r = 0 (no check), 2 pins r = 1
  (detectable, not attributable), 3 pins with lens free r = 2 (weakly identifiable), 4 pins r = 4. Baarda's
  redundancy numbers rᵢ = diag(I − H) give each tap's minimal detectable error σ·4.1/√rᵢ; below rᵢ ≈ 0.3 a tap
  "cannot be checked".
- **Products.** Smapshot asks for ≥ 6 GCPs and validates per-point error (Ingensand et al. 2018,
  https://peerj.com/preprints/27204); the WSL monoplotting tool ≥ 5 (Bozzini et al. 2012,
  https://www.cipaheritagedocumentation.org/wp-content/uploads/2018/12/Bozzini-e.a.-A-new-tool-for-obtaining-cartographic-georeferenced-data-from-single-oblique-photos.pdf);
  PeakVisor uses direct manipulation (drag, level) and the eye judges the fit (https://peakvisor.com/tutorial).
  They solve position too; fixing the eye from GPS is why 1–3 taps suffice here. None flags one bad point at n ≤ 3.
- **Touch.** Holz & Baudisch, *Understanding Touch*, CHI 2011 (1.6 mm with the projected-centre model vs 4 mm),
  https://www.christianholz.net/2011-chi11-holz-baudisch-understanding_touch.pdf; Parhi et al. MobileHCI 2006
  (9.2 mm targets); Apple 44 pt, Material 48 dp; Vogel & Baudisch *Shift* CHI 2007 (callout loupe, lift to commit).
  Suggested tap σ: 2 mm screen-space plain, 1 mm with a loupe, converted through the current zoom.
- **Own record.** `reports/negative-results.md:84-88`: pins as LOO evidence for the warp/joint solve (negative);
  `src/lib/pose6dof/README.md:105-111`: a 6-DoF pin solve was proposed, never wired (its inlier rule needs ≥ 5
  points, so it does not help at 1–3 taps). Nothing recorded tried a seeded or checked pin solve.

## 4. Plan

| unit | what | size / risk | gate | when |
|---|---|---|---|---|
| U1 | `src/lib/pins/diagnostics.ts`: `pinUnknowns`/`pinRedundancy`, `checkPinPairs` (+ suspect), `pinResidualsPx`, `pinSigmaDeg`, `pinReliability` (Baarda), `leaveOneOutPx`, `pairFitDeg`; read-only | S / none | specs | **now** |
| U2 | `src/lib/pins/seed.ts`: closed-form seed + lens bound, `solvePinsSeeded`; engines call `solvePinsForApp` (default = `solvePins`, unchanged); `?pinSolve=seeded` opt-in | S / low (flag off = same call) | specs + sweep; default flip needs the browser batch | **now** |
| U3 | Workspace pin tool: `pinBase` (solve all pins from the pose before the first pin), Clear/remove restores it, per-pin residual line (tap → projected summit), refuse `pinned` when `checkPinPairs` fails or RMS > 15 px (state stays `manual` with a "check the names" note) | M / UI + provenance | browser batch | proposal for the `photo-workspace` / `rigi` owners (`PhotoWorkspace.tsx` is theirs) |
| U4 | Picker: key taps by world, menu clamped to the stage, 44 px rows, `pairFitDeg` ranking + "doesn't fit with X" badge, single-tap undo, visibility-aware `nearbyPeaks`, a long-press loupe | M / UI | browser batch | proposal for pod B (R4) |
| U5 | Flip `?pinSolve` default to seeded | S | browser batch: `scripts/picker-check.mjs` both renderers, eval-app GT bit-identity with the flag on (expected: identical where plain converges) | after the batch |
| U6 | Pixel-scaled weak priors / one LM for both solvers | M / changes GT | new function only, A/B on control-points GT | later |
| U7 | Eye from ≥ 4 taps (P3P/PnP with known intrinsics) when residuals say the GPS is off | L | needs labelled near-peak photos | later, user decision on data |

## 5. Iteration log

**Round 1 (U1 + U2).** `src/lib/pins/diagnostics.ts`, `src/lib/pins/seed.ts`, specs in `src/lib/pins/__tests__/`
(31 tests); engines route `Renderer.solvePins` through `solvePinsForApp`; flag `pinSolve` in `src/lib/flags/index.ts`.
`align.ts` untouched; with the default flag the engine makes the identical `solvePins` call (adversarial review
confirmed argument order and the `from = this.pose` default), so the eval GT is bit-identical.

Synthetic sweep (`scratchpad/exp/sweep.ts`; 200 trials per row, 3 px tap noise, true vfov 30–70°; success = yaw and
pitch within 0.5°, vfov within 5 %), plain `solvePins` → seeded:

| yaw offset of the start | 1 pin | 2 pins | 3 pins | 4 pins |
|---|---|---|---|---|
| 30° | 200 → 200 | 199 → 199 | 199 → 200 | 200 → 200 |
| 50° | 200 → 200 | 198 → 198 | 118 → 200 | 111 → 200 |
| 70° | 171 → 200 | 190 → 198 | 35 → 200 | 30 → 200 |
| 90° | 112 → 200 | 138 → 199 | 19 → 199 | 11 → 199 |
| 120° | 7 → 200 | 15 → 199 | 5 → 200 | 0 → 198 |
| 180° | 0 → 200 | 0 → 197 | 0 → 200 | 0 → 200 |

Wrong name (a summit 2–10° from the true one), `checkPinPairs` with the lens known to ±15 % and 0.3° tolerance:
2 pins flagged 184/300 (never attributable), 3 pins flagged 233/300 and the culprit isolated 128/300, 4 pins
flagged 246/300 and isolated 174/300; 0/300 false flags on clean taps at every n. These are synthetic dev numbers,
not results; the misses are wrong names close to the true direction, which no rotation-free test can see.

**Round 1 review (independent Sonnet), fixed in round 2:** the one-pin seed under-converged with roll and steep
pitch (6.7 px median, 315 px p90 at pitch ≤ 85°, roll ≤ 30°): now iterates to convergence (≤ 20 turns); the
fallback could clamp the lens of a 1–2-pin solve when the prior vfov was outside 5–120°: the bound now applies
only when the lens is freed; seeded yaw is unwrapped onto the prior's branch; JᵀJ pivots use a relative tolerance
and σ > 45° is reported as undetermined (near-coincident pins gave σ 263–912°); header named the wrong flag.
Checked fine: TRIAD / handedness / roll sign over 3000 random poses (pitch to ±89.99°), selection never worse
than plain in 2400 solves, n < 3 keeps vfov and n = 1 keeps roll, 1.2 ms vs 0.8 ms per call.

**Negative / limits.** One pin is never checkable (redundancy 0), whatever the UI does. Even four pins with the lens
free can leave one pin with redundancy ≈ 0.11 (below `PIN_CHECKABLE_R`); fixing the lens lifts every pin above it.
The 2-pin TRIAD seed misses 1–3/200 under noise where the two pins are close on screen.

**Next (ordered).** 1. Browser batch for `?pinSolve=seeded` (ledger row), then flip the default (U5).
2. U3 to the photo-workspace owners: `pinBase`, per-pin residual line, gate `pinned` on `checkPinPairs` + RMS.
3. U4 to pod B: `pairFitDeg` menu ranking, world-keyed taps, 44 px rows, edge-clamped menu, loupe.

**Needs the user.** Whether a pin solve that fails `checkPinPairs` may still be saved as `pinned` (endorsed) or must
drop to `manual` with a warning (recommendation: `manual`); whether to collect a small labelled set of photos with
near peaks (< 3 km) before solving the eye from ≥ 4 taps (U7).
