# Live tracker gate: preregistration DRAFT

Status: DRAFT. Not signed off. The user must approve the metrics, thresholds and clip set before any
recorded clip is scored. Until a signed-off gate passes, the tracker (`src/lib/track`) output stays a
suggestion (`TrackedPose.suggestion === true`) and the live UI says so. The frozen still-photo accept
rule (`src/lib/matcher/rule.ts`) is not touched and is not what this gate measures.

## What is validated

`createTracker` poses per video frame (sensor propagation, skyline solve, filter, LOST logic) against
a reference pose per frame obtained independently of the tracker.

## Reference pose (ground truth)

Not a phone sensor. For each clip, keyframes (every 2 s plus any frame where the view changes by more
than 5 degrees) are solved with the still-photo pipeline at full resolution, with the eye fixed by a
surveyed or map-picked position, and accepted only when the existing frozen accept rule accepts the
keyframe. Between keyframes the reference is interpolated on the rotation manifold from the clip's
integrated gyro, anchored at both keyframes. Frames more than 1 s from an accepted keyframe are
excluded from error statistics and reported as coverage.

## Clip set (proposal)

- 12 clips of 60 s, 30 fps, 720p, on three phones (two iOS, one Android) if available.
- At least 4 locations with distinct skylines (alpine ridge, rolling hills, lake shore, forest edge
  with partial sky), at least 3 in the wild-benchmark region so the DEM is certified there.
- Motions: slow pan (20 s per revolution), handheld walk-and-look, whip pan (peaks above 60 deg/s),
  tripod hold (sensor drift only), and a 3 s lens-covered / pocket interval.
- Conditions: clear, broken cloud, overcast low contrast, backlit sun, dusk.
- Recorded once with sensor logs and frozen before scoring. Dev/test split in the style of the wild
  benchmark: 4 dev clips for tuning, 8 test clips scored once.

## Metrics (per test clip, TRACK-phase poses with reference coverage)

1. Rotation error against the reference (camera-basis angle): median, p90, p99.
2. Drift: median error in the last 10 s minus the first 10 s after the first TRACK pose.
3. Time to first TRACK from a cold start, and the error 2 s later.
4. LOST handling at each staged covered-lens interval: false-track rate (TRACK poses with error above
   5 degrees) and recovery time to error under 1.5 degrees after uncovering.
5. Honesty: fraction of TRACK time with error above 3 degrees (silent failure), and rank correlation
   of `residualDeg` with error.
6. Latency: pose time versus frame time (poses arrive 1 to 2 frames late), p90 frame-to-overlay
   latency, and page frame time with the tracker on versus off.
7. Cost: median and p90 per-frame CPU and GPU time on the three phones and one desktop.

## Proposed pass thresholds (the user signs off or changes these)

| Metric | Proposed bar |
|---|---|
| Median error | 1.0 deg or better on at least 6 of 8 test clips, 1.5 deg pooled |
| p90 error | 2.5 deg pooled |
| Drift | under 0.5 deg on every clip with a skyline in view |
| Time to first TRACK | under 3 s median, under 8 s worst |
| False-track rate in covered intervals | under 2 percent of TRACK poses |
| Recovery after uncovering | under 5 s on at least 90 percent of intervals |
| Silent failure | under 1 percent of TRACK time |
| Frame cost | tracker adds under 8 ms median on desktop, under 16 ms on the mid-range phone |

Failing any row keeps the tracker suggestion-only; thresholds are not adjusted after scoring. Clips
with no usable skyline (sky only, indoors) are excluded from rows 1 to 4 and must show that the phase
never claims TRACK with a skyline-sourced pose.

## Baselines reported alongside

Raw sensor error; the tracker with the skyline solve disabled; the tracker with the full still-photo
matcher on every 10th frame as an oracle.

## Known risks the gate should surface

- The synthetic evidence (`scripts/track/synthetic.eval.ts`) has no motion blur, rolling shutter,
  lens distortion, auto-exposure or sensor-to-frame latency; its sub-degree numbers are optimistic.
- The cheap column scan is a brightness and blueness step detector, not a sky model. Haze, snow, low
  sun and dark skies are expected to break it; the robust solve and LOST logic must contain that.
- Focal length is held fixed from the reported FOV; a wrong FOV biases yaw near steep skylines. Record
  the FOV source per clip.
- The DEM horizon assumes the GPS eye position; tens of metres of error shift near ridges. Report GPS
  accuracy per clip.

## Process

1. The user signs off this document and the clip set.
2. Clips are recorded, frozen and split.
3. Tuning uses dev clips only; `DEFAULT_TUNING` in `src/lib/track/tracker.ts` is frozen before the test run.
4. The test run is scored once; results go to `reports/` with the commit hash.
