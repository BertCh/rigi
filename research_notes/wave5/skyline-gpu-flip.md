# skylineGpu accept flip (GT-12 IMG_6958, none+nofocal): root cause

Result: skylineGpu stays default OFF. The flip is not GPU cost-image error that could be reduced; it is chaotic
sensitivity of `refinePose` on a wrong focal seed. Browser-unverified, node/Dawn only.

## Reproduction

    DAWN_DIR=<dawn> npx tsx scripts/gpu/unknown-gpu-node.ts --set gt12 --unknown-gpu on --skyline-gpu on|off --ids IMG_6958

none+nofocal: skyline off -> 43.26 deg, confidence 0.9919, accepted; skyline on -> same pose, 0.9919, REJECTED.
The best seed (30.5 deg vfov) is identical and accepted in both arms (confidences differ at 7e-7).

## Where the decision diverges

`solveUnknownPose` tries three focal seeds and sets `ambiguous` when another seed also accepts at a yaw more than 1 deg
away. Per-seed output (new `seeds` field in the node script rows):

| seed vfov | CPU skyline | GPU skyline |
|---|---|---|
| 30.5 | solve, 0.992, accept | solve, 0.992, accept |
| 38.6 | solve, 0.070, reject | solve, 0.070, reject |
| 51.1 | solve 0.065 reject, then refine: score 0, reject (25% inliers, mode ratio 1.14) | solve 0.065 reject, then refine: score 0.698 ACCEPT at yaw 47.5 (mode ratio 0.76) |

The solve stage of seed 3 is unchanged (0.0648 both). `refinePose` from the same prior camera lands in a different
basin (scale 10.4 vs 3.3, focal 1633 vs 1699), and the GPU arm's wrong 0.70 accept at 47.5 deg trips `ambiguous`.
So the GPU reject comes from a spurious accept of a wrong-focal seed; the CPU accept is the lucky side.

## Input difference is tiny

Skyline rows CPU vs GPU on this photo: finite columns identical (765/800), median row difference 0, max 1.5e-5 px,
max weight difference 4e-6 (`scripts/gpu/skyline-dawn.ts`, now printed in exponent form).

## Proof it is chaos, not GPU error

CPU only, no GPU: add seeded uniform noise of +-a px to `sky.rows` before `refinePose` (temporary hook, reverted):

| a (px) | seed-3 refine |
|---|---|
| 0, 1e-6, 1e-5 | reject |
| 1e-4 | ACCEPT 0.700 |
| 1e-3 | ACCEPT 0.699 |

The decision flips between 1e-5 and 1e-4 px of row noise, the f32 rounding scale of the sub-pixel parabola. Matching
the CPU's rows bit for bit on GPU (blur summation order, edge parabola) is not achievable in general, so no GPU change
can guarantee an identical accept set. Full 77-decision and wild A/B were not re-run: the mechanism makes it moot.

## What would fix it (done below as Fix)

Make the cascade less brittle on wrong-focal seeds, e.g. ignore non-best seeds whose solve confidence is under ~0.1 in
the `ambiguous` test, or demand a higher refine score for them. That changes CPU behaviour and needs the wild dev A/B.

## Fix (2026-10-02, pod B unit g2)

`isAmbiguousFocal` (`src/lib/integration/unknown-pose-core.ts`) now ignores a non-best focal seed as an
"alternative accepted fit" when its accept came only from `refinePose` and its solve stage was under
`SEED_REFINE_MIN_SOLVE_CONFIDENCE` = 0.25 (half of solvePose's 0.5 accept). Seeds expose `solveConfidence` for it.
A solve-stage accept, a refine accept whose solve reached 0.25, the best seed itself, and the
`best.confidence < 0.75` rule are untouched. The change can only remove vetoes (from refine-only seeds with no
solve support), never add one; precision-wise that is the direction to check, see below.

Evidence (dev, GT-12, CPU path, node):
- `src/lib/integration/focal-seed-noise.check.ts` (row noise 0, 1e-6, 1e-5, 1e-4, 1e-3 px on IMG_6958 none+nofocal):
  with 4 noise realisations per level (`... IMG_6958 4`, 17 CPU solves): the post-fix decision is accept in all 17; the
  pre-fix rule (`isAmbiguousFocal(..., false)`, computed from the same seeds) flips to reject in 3 of 17 (1e-5 #3, 1e-4 #2,
  1e-3 #2: seed 3 solve 0.063..0.064 -> refine accept 0.69..0.70 at yaw 47.5) and is accept in the other 14. The default
  run (1 realisation per level, CI row `focal-seed-noise`, SKIPs without the gitignored inputs) does not hit a flipping
  realisation; the 4-realisation run does. Flipping is by realisation, not monotone in amplitude.
- `scripts/gpu/unknown-gpu-node.ts --set gt12 --unknown-gpu off --skyline-gpu off`, before vs after: 60 decisions
  (12 photos x 5 conditions; the harness's GT-12 set), 0 changed (accept, pose and confidence all identical), 34 accepts
  before and after, no new accept. The wild set was not run (sealed / out of scope), so a refine-only veto that
  mattered there is unmeasured: the batch pass should re-run the A/B.
