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

## What would fix it (not done: the CPU path must not change)

Make the cascade less brittle on wrong-focal seeds, e.g. ignore non-best seeds whose solve confidence is under ~0.1 in
the `ambiguous` test, or demand a higher refine score for them. That changes CPU behaviour and needs the wild dev A/B.
