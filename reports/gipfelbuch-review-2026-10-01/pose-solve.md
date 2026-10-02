# Gipfelbuch review: Pose solve cluster (2026-10-01)

Pages: `pose-estimate`, `accept-rule`, `baseline-pipeline`. Code read: `src/lib/geo/solve.ts`, `src/lib/geo/lm.ts`, `src/lib/refine/confidence.ts`, `src/lib/geo/README.md`, `reports/bench-wild.md`, `src/lib/integration/second-opinion.ts`. Everything quoted below was checked against the code or the measured data, not the literature alone.

## What the solver really computes (the math the pages must match)

- Coarse stage (`solve.ts:387 coarseCost`): for each yaw offset `Δψ` and pitch offset `Δφ`, `E = Σ w·min(|ε − h(Δψ,Δφ)|, τ) / Σ w` plus a weak prior pull (`0.02·τ·((Δψ/σψ)² + (Δφ/σφ)²)`). It is a **truncated L1** on elevation angles in degrees (small-angle shortcut), `τ` = 12 px. Best pitch per yaw gives a 1-D curve; seeds are its local minima, at least 1.5° apart, up to 3.
- Fine stage (`solve.ts:481`, `lm.ts:50`): Levenberg-Marquardt on [yaw, pitch, roll, log f], **Cauchy** loss `ρ(r) = ½c² ln(1 + r²/c²)` with `c` = 4 px, residuals in pixels `(el − h(az))·f·π/180`, Gaussian priors.
- "Ambiguity" (`solve.ts:440`) is `1 − (c₂ − c₁)/(c̃ − c₁)`, where `c₁` is the best minimum, `c₂` the best minimum more than 2° away, `c̃` the median of the curve. It is a margin normalised by the typical level, **not** a Lowe ratio test (`c₁/c₂`). The code comment explains why: foreground columns add a constant truncated cost, so a plain ratio stays near 1. 0 means a clear winner, 1 a tie.
- Confidence (`solve.ts:530`): `tilt · clamp((f_in−0.3)/0.5) · clamp(coverage/0.4) · clamp((1−a)/0.4+0.1) · clamp(relief/0.5)`. The ambiguity factor is 1 until `a > 0.64`, so it rarely bites on the demo set (max 0.46 local). I recomputed it from the stored fields: demo-07 gives 0.458 (stored 0.457), demo-11 0.442 (0.443), demo-08 0.556 (0.555). Matches.
- Accepted at `>= 0.5` (local) and `>= 0.75` (full-circle retry, or heading unknown).

## Findings

### accept-rule
1. **Wrong or thin**: the old front page said "four checks multiply" but never showed the formula, and the factor labels were misleading. "ambiguity: second-best basin 0.35" reads as if 0.35 were bad; the factor only bites above 0.64. "horizon relief 0.6° of relief" omitted the 0.5° threshold. Fixed in `solveFactors` raw strings and a new live equation.
2. **Number caveat missing**: the "19 wrong of 60 app accepts" row has 39 correct + 19 wrong + **2 unsure** (`reports/bench-wild.md:49`; precision 0.64 = 39/60). The ladder drew only 58 dots. Added two grey dots and the sentence.
3. **Inconsistent recall cost**: the page said the product rule gives up 14 correct accepts (true for the first v2 run, 16 of 30), but the Mapterhorn re-run gives 20 of 30, so 10. Both stated now.
4. **Overclaim risk**: "every accepted pose is within 0.5°" rests on 14 photos, and the bar sits in a gap between 0.48 (IMG_7063, correct, rejected) and 0.51 (IMG_6971, accepted). The bar was tuned on this set. Said so in the caption.
5. Hero (`HeroReject`) pointed at two spots on demo-11 without showing what the score counts. Replaced by `ScoreFit`: the real photo with a red tick on every column where the two skylines differ by more than 4 px, next to the equation with live factor values. Tick count approximates the stored inlier fraction (demo-03 0.726 vs 0.734, demo-07 0.495 vs 0.529, demo-11 0.495 vs 0.521; the solver measures angular residuals, the ticks are row differences). For demo-12 (accepted by `refinePose`) the ticks use the refined pose, so they overstate the failure; a note says so.
6. `ConfidenceVsError` (the measured reason for the 0.5 bar) was hidden in Details; promoted to the main page.
7. Not changed: the refine confidence (six smoothstep ramps, `refine/confidence.ts`) is only described in Details, and the verdict tree stays there.

### baseline-pipeline
1. **Main phenomenon missing**: the page said "slide to match" and showed overlays but not the search. New Fig. 2 draws the real coarse cost against yaw offset on the photo (best, runner-up, compass guess, typical level, ambiguity), with a toggle to the full-circle search. Data: `scripts/gipfelbuch/data-pose-solve.ts` (calls `planCoarse`/`coarseCost`; reproduces the stored ambiguity for 11 of 12 photos, demo-12 differs because its stored solve is the full-circle retry).
2. **Aliasing is real in the data**: on demo-04 the full-circle search ranks −34.0° first (cost 0.570) with the local winner +5.0° (0.600) behind it, which is why the unknown-heading search needs the 0.75 bar. Coarse stage only; the fine stage was not run on that alternative, so the page says "rival dips appear", not "would be accepted".
3. **Qualified number**: "0 false accepts on 12 hand-registered photos" holds for Terrarium only; on Mapterhorn `src/lib/geo/README.md:80` lists one accept over 1° (IMG_7130, 1.05°, GT fitted on Terrarium notches). Added to the label and source.
4. "no network model" read as "no network access" (DEM tiles are fetched); now "no neural network".
5. Details still says the fast horizon marcher takes 0.3 s; the measured demo run (classic `computeHorizon`) is 3.5-5.3 s. The pipeline prefers `horizon-fast` (`pipeline.ts:53`); the 4.4 s on the page is the classic one. Left, flagged here.
6. Details mention "7,200 azimuths": correct (0.05° step).

### pose-estimate
1. **The compass-error claim had no visual**: "every peak name lands on the wrong summit". New figure on demo-09: the same labels at the phone's heading (magenta) and at the solved one, with `Δx ≈ f·Δψ·π/180`. At the centre that is 195 px for 18.6° at f = 601; measured label shifts are 203 to 239 px because the approximation `x = f·tan` is linear only near the centre and the focal also changed (1.02). Both numbers are shown.
2. Insight worth keeping in mind: a **row residual hides yaw error**. Fig. "median skyline error" in Details is vertical only, so prior vs solved residual looks small (demo-03: 13 px prior, 1.8 px solved) even with an 11.5° heading error. The yaw cost curve (baseline-pipeline) is the right visual for yaw.
3. Stale: "three.js renderer" removed from Details (the three PhotoEngine is gone). `src/lib/pose.ts` `applyPose` still exists and is described as an adapter.
4. Kept: hero with the four numbers on demo-01, compass dials (colours switched to CSS variables), rejected pair.
5. Not verified: the `pose6dof` numbers (99.3 %, 0.008°, 1.1 m) come from `src/lib/pose6dof/README.md`, a synthetic sweep; I did not rerun it. They are labelled synthetic.

## Literature check (from background knowledge; no live web fetches were made)
- Baatz et al. 2012 (ECCV, "Large scale visual geo-localization of images in mountainous terrain") and Brejcha and Čadík 2017 (survey) match skylines against DEM-derived horizon profiles with a robust cost; truncated/robust costs for occluders are standard. Truncated L1 for the grid and Cauchy for refinement are legitimate choices (Cauchy is a standard redescending M-estimator, scale `c` = 4 px here is hand-set, not the 2.385 "95 % efficiency" constant).
- Fixed thresholds (0.5, 0.75, 0.3 inlier floor) are not likelihoods; the page already says so. The a-contrario alternative (NFA) is on the roadmap in `reports/fundamentals-plan.md` (E1).
- Not independently verified online in this pass; if exact citations are wanted, fetch before publishing.

## Kit requests
- `Eq` overflows sideways on a 390 px screen for the longest equations (the coarse cost); a `small` prop or `text-[1rem]` on phones would keep it on one screen.
- `Figure` labels: HeroStages ("Fig. 1") and my new figures use fixed numbers; a counter would avoid hand-renumbering.
- `RealPhoto` could take a `hypotheses` prop (named extra rows paths) so "runner-up" lines do not need children SVG.

## Sources
- `src/lib/geo/solve.ts`, `src/lib/geo/lm.ts`, `src/lib/refine/confidence.ts`
- `reports/bench-wild.md`, `src/lib/geo/README.md`, `reports/fundamentals-plan.md`
- Baatz, Saurer, Köser, Pollefeys, ECCV 2012; Brejcha and Čadík, "State-of-the-art in visual geo-localization", Pattern Analysis and Applications 2017 (from memory, not re-fetched)
