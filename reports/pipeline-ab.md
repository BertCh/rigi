# Pose pipeline A/B (full-metadata photos): `?pipeline=current|cascade|skyfirst|wide`

> **Frozen record (2026-09-26).** The variants lost and were removed: `?pipeline=`, `pose-policy.ts` and `eval-app-pipeline.mjs` no longer exist, and `choosePreview` now lives in `src/lib/integration/second-opinion.ts`. The "Reproduce" section doesn't run any more.

Scope: photos with compass + gravity + focal, no saved pose (PhotoWorkspace's autoAlign branch and the
background second opinion). Uploads with unknowns (resolveUnknownPose) are not affected by any variant.

## Decision criteria (written 2026-09-26 ~17:45Z, BEFORE any variant was run)

Scored on every photo in `data/control-points.json` whose pins resolve (14 at the time of writing),
by `node scripts/eval-app.mjs --pipeline <name>`, all variants run sequentially under the same
harness settings (same concurrency) as a `--pipeline current` control run taken in the same session.

A variant is **acceptable** only if ALL of these hold against the `current` control run:

1. **False accepts (primary): no increase.** A false accept is a photo whose FINAL state claims a
   verified pose while the final pose is more than 1° in yaw from the pin-solved GT pose (|Δyaw| ≥ 1°,
   the same threshold as the within-1° metric). "Claims a verified pose" =
   `data-verify` ∈ {verified, refined, matched}, or `data-verify` ∈ {kept, timeout, none} while
   `data-align` ∈ {auto, accepted} (the app then shows "Auto-aligned · confidence N%" with no warning).
   `near-compass`, `prior` and `unverified` do not claim a verified pose.
2. **Within 1° yaw: count ≥ current.**
3. **Median error not worse by more than 0.05°** (median |Δyaw| over the scored photos; the px median
   the default harness prints is reported too).
4. **Time to first pose not worse** ([data-ready], ms since navigation start, median over photos;
   tolerance: +10 % or +500 ms, whichever is larger, since the runs share a loaded machine). The preview
   must stay instant: no variant may wait for the cascade / sky model before [data-ready].
5. **Time to final pose** ([data-verify] leaves "pending") is reported, not gated.

A variant that passes all five AND has more within-1° or fewer false accepts is "clearly better".
It is reported as such; the default is NOT flipped by this work (orchestrator decides).
Ties (equal within-1° and false accepts) are "no evidence to switch".

Photos that time out on [data-ready] are retried once; retries are listed.

## Wild dev set

No existing harness scores the APP's full-metadata pipeline on the wild set: tools/bench/harness/run.ts
`app` method calls `engine.autoAlign(true)` (plus a seed wrapper) in isolation, not PhotoWorkspace's
autoAlign → near-compass → second-opinion chain, and none of the 100 wild photos carries a gravity vector
(manifest: 0 with pitchDeg), so in the app they all take the unknown-pose path, which no variant changes.
The "43 % precision" figure (reports/bench-wild.md v1; 0.64 in v2) is for that isolated autoAlign accept.
So no wild run was done; data_v3 / test ids untouched.

## Setup (as run)

- 2026-09-26 18:11–19:48Z, dev server :3100 (three.js renderer), matcher v0.4.0 (policy v034) up.
  `src/lib/engine.ts` mtime 14:28:54Z at start and end (unchanged), so no baseline re-run was needed.
- Resources: per the orchestrator, ONE photo at a time (`node scripts/eval-app.mjs [--pipeline v] <id>`
  per photo), gated before each photo on ≤ 1 non-service chromium job, swap used < 10 GB, > 5 GB disk.
  The "≥ 1.5 GB swap free" rule was relaxed to "or system memory free ≥ 30 %" after it stalled the run
  for ~55 min while macOS had shrunk the swap file to 5 GB with 86 % memory free.
- Default output before vs after the edits (per photo, one at a time): **identical** on all 19 lines.
- Retries: skyfirst IMG_5495 once (page reloaded mid-run, `window.__engine` undefined: a dev-server
  reload, not a [data-ready] timeout). No [data-ready] timeouts.
- Times are ms since navigation, per photo, with only that photo loaded. "px" / medians below are over the
  14 scored photos (the default harness prints the median over all 19 rows, 6.5 px).

## Summary

| variant | within 1° | false accepts | claimed | median abs Δyaw ° | median px | median t-ready s | median t-final s | max t-final s | retries |
|---|---|---|---|---|---|---|---|---|---|
| current | 12/14 | 0 | 12 | 0.228 | 7.5 | 3.7 | 4.0 | 27.5 | – |
| cascade | 12/14 | 0 | 11 | 0.376 | 11.7 | 3.6 | 4.0 | 23.7 | – |
| skyfirst | 12/14 | 0 | 11 | 0.312 | 8.0 | 3.6 | 11.2 | 30.5 | IMG_5495 |
| wide | 12/14 | 0 | 12 | 0.228 | 7.5 | 3.5 | 3.9 | 24.4 | – |

Against the criteria:

| variant | 1. false accepts | 2. within 1° | 3. median abs Δyaw (≤ +0.05°) | 4. t-ready | 5. t-final | verdict |
|---|---|---|---|---|---|---|
| cascade | 0 = 0 ✓ | 12 = 12 ✓ | 0.376 vs 0.228: **+0.148 ✗** | 3.6 vs 3.7 s ✓ | 4.0 s (IMG_7059 now 20 s via matcher) | **fails** |
| skyfirst | 0 = 0 ✓ | 12 = 12 ✓ | 0.312 vs 0.228: **+0.084 ✗** | 3.6 vs 3.7 s ✓ | **11.2 s** (U²-Net load; 2.8× current) | **fails** |
| wide | 0 = 0 ✓ | 12 = 12 ✓ | 0.228 = 0.228 ✓ | 3.5 vs 3.7 s ✓ | 3.9 s | passes, but no gain |

Findings:
- **The hypothesis "the cascade should be authoritative" is not supported here.** Where autoAlign and
  the cascade agree within 1° (the 9 "verified" photos), taking the cascade pose instead of the autoAlign pose makes
  the pose slightly *worse* (median |Δyaw| 0.23° → 0.38°, px 7.5 → 11.7; e.g. IMG_6971 0.03° → 0.49°,
  15.6 px worse). The current rule (keep autoAlign when verified) is the better one.
- Making a cascade reject always escalate (cascade / skyfirst) turns IMG_7059 (correct, 0.92°) from a
  kept auto-align into "unverified" after a 20 s matcher round-trip (matcher answered LOW). It buys no
  caught error: the only two misses (IMG_5495, IMG_6019) are already "unverified" under current.
- skyfirst: the sky cross-check stage accepts on 8/14 and is more accurate than the plain cascade
  (0.31° vs 0.38°) but still worse than current, and waits ~7 s for the sky model.
- wide: the ±12° / ±5° window fired on 2 photos. IMG_6019: the wide candidate was shown as the preview,
  the cascade disagreed, so the pose fell back to the prior; the result is the same as current (unverified,
  13.6° off). IMG_7086: the cascade accepted and refined it, as under current. **Final poses are
  identical to current on all 14**, so this set has no evidence either way for the wild-prior case it
  targets. The wild set can't test it, because it has no gravity (see above). Note the preview risk: for
  about 3 s after [data-ready], IMG_6019 showed a wrong near-compass candidate where current shows the prior.
- False accepts are 0 for every variant: no photo ends in a "claimed" state more than 1° off. IMG_7130 (0.95°,
  pitch 1.63°) is the closest call and is the same in all variants.

## Recommendation

Keep `current` as the default. No variant is clearly better: none adds a within-1° photo or removes a
false accept (there are none to remove). cascade and skyfirst fail criterion 3, and skyfirst nearly triples
the time to the final pose. wide is harmless here but unproven. It is worth re-testing only if
full-metadata photos with 9–14° compass errors (and GT) are added. The flag stays in place for that.

## Per-photo tables

### current

| photo | Δyaw ° | Δpitch ° | px | preview | final align | verify | claims | FALSE | cascade (acc/conf/stage) | matcher | t-ready s | t-final s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| IMG_5495 | -6.92 | -2.24 | 205.9 | auto | unverified | unverified | no |  | rej 0.28 solve | low | 3.1 | 24.4 |
| IMG_6019 | 13.61 | -1.29 | 335.4 | prior | unverified | unverified | no |  | rej 0.00 solve | low | 2.7 | 27.5 |
| IMG_6958 | -0.03 | 0.19 | 24.8 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.6 | 4.0 |
| IMG_6971 | 0.03 | 0.28 | 4.4 | auto | auto | verified | yes |  | acc 0.53 solve | – | 3.4 | 3.6 |
| IMG_7018 | -0.25 | 0.28 | 8.1 | auto | auto | verified | yes |  | acc 0.81 solve | – | 3.6 | 3.8 |
| IMG_7033 | 0.14 | -0.03 | 6.6 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.7 | 3.9 |
| IMG_7053 | 0.13 | 0.35 | 6.9 | auto | auto | verified | yes |  | acc 0.72 solve | – | 3.6 | 3.8 |
| IMG_7059 | -0.92 | 0.09 | 16.8 | auto | auto | kept | yes |  | rej 0.42 solve | – | 3.5 | 4.0 |
| IMG_7063 | -0.57 | 0.25 | 10.1 | auto | auto | verified | yes |  | acc 0.68 solve | – | 3.7 | 3.9 |
| IMG_7068 | -0.21 | 0.10 | 3.9 | auto | auto | verified | yes |  | acc 0.99 solve | – | 3.7 | 4.1 |
| IMG_7086 | 0.08 | 0.12 | 3.5 | prior | accepted | refined | yes |  | acc 0.96 solve | – | 3.7 | 3.9 |
| IMG_7130 | 0.95 | 1.63 | 25.4 | auto | accepted | refined | yes |  | acc 0.76 solve | – | 4.4 | 4.6 |
| IMG_7131 | 0.02 | -0.35 | 6.5 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.9 | 4.2 |
| IMG_7155 | -0.34 | 0.07 | 2.9 | auto | auto | verified | yes |  | acc 1.00 refine | – | 3.8 | 4.8 |

### cascade

| photo | Δyaw ° | Δpitch ° | px | preview | final align | verify | claims | FALSE | cascade (acc/conf/stage) | matcher | t-ready s | t-final s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| IMG_5495 | -6.92 | -2.24 | 205.9 | auto | unverified | unverified | no |  | rej 0.28 solve | low | 2.9 | 23.3 |
| IMG_6019 | 13.61 | -1.29 | 335.4 | prior | unverified | unverified | no |  | rej 0.00 solve | low | 2.9 | 23.7 |
| IMG_6958 | -0.09 | 0.17 | 27.5 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.4 | 3.7 |
| IMG_6971 | 0.49 | 0.29 | 20.0 | auto | auto | verified | yes |  | acc 0.53 solve | – | 3.5 | 3.7 |
| IMG_7018 | 0.16 | 0.16 | 12.0 | auto | auto | verified | yes |  | acc 0.81 solve | – | 3.4 | 3.6 |
| IMG_7033 | 0.09 | -0.13 | 6.4 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.6 | 3.9 |
| IMG_7053 | 0.01 | 0.33 | 6.4 | auto | auto | verified | yes |  | acc 0.72 solve | – | 3.4 | 3.6 |
| IMG_7059 | -0.92 | 0.09 | 16.8 | auto | unverified | unverified | no |  | rej 0.42 solve | low | 4.1 | 20.4 |
| IMG_7063 | -0.76 | 0.13 | 11.3 | auto | auto | verified | yes |  | acc 0.68 solve | – | 3.8 | 4.0 |
| IMG_7068 | -0.34 | 0.12 | 6.1 | auto | auto | verified | yes |  | acc 0.99 solve | – | 4.0 | 4.4 |
| IMG_7086 | 0.08 | 0.12 | 3.5 | prior | accepted | refined | yes |  | acc 0.96 solve | – | 3.6 | 3.8 |
| IMG_7130 | 0.95 | 1.63 | 25.4 | auto | accepted | refined | yes |  | acc 0.76 solve | – | 3.7 | 4.0 |
| IMG_7131 | -0.07 | -0.35 | 7.7 | auto | auto | verified | yes |  | acc 1.00 solve | – | 5.3 | 5.5 |
| IMG_7155 | -0.42 | 0.06 | 3.8 | auto | auto | verified | yes |  | acc 1.00 refine | – | 3.5 | 4.5 |

### skyfirst

| photo | Δyaw ° | Δpitch ° | px | preview | final align | verify | claims | FALSE | cascade (acc/conf/stage) | matcher | t-ready s | t-final s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| IMG_5495 | -6.92 | -2.24 | 205.9 | auto | unverified | unverified | no |  | rej 0.28 solve | low | 4.5 | 29.7 |
| IMG_6019 | 13.61 | -1.29 | 335.4 | prior | unverified | unverified | no |  | rej 0.00 solve | low | 2.7 | 30.5 |
| IMG_6958 | -0.10 | 0.19 | 28.5 | auto | auto | verified | yes |  | acc 1.00 refine+sky | – | 3.5 | 10.9 |
| IMG_6971 | -0.06 | 0.31 | 4.3 | auto | auto | verified | yes |  | acc 1.00 refine+sky | – | 3.6 | 11.1 |
| IMG_7018 | -0.29 | 0.16 | 7.8 | auto | auto | verified | yes |  | acc 1.00 refine+sky | – | 3.6 | 11.0 |
| IMG_7033 | 0.10 | 0.03 | 4.6 | auto | auto | verified | yes |  | acc 1.00 refine+sky | – | 3.6 | 11.4 |
| IMG_7053 | 0.27 | 0.30 | 6.4 | auto | auto | verified | yes |  | acc 0.64 refine+sky | – | 3.7 | 11.3 |
| IMG_7059 | -0.92 | 0.09 | 16.8 | auto | unverified | unverified | no |  | rej 0.42 solve | low | 3.5 | 25.9 |
| IMG_7063 | -0.76 | 0.13 | 11.3 | auto | auto | verified | yes |  | acc 0.68 solve | – | 3.4 | 10.8 |
| IMG_7068 | -0.34 | 0.12 | 6.1 | auto | auto | verified | yes |  | acc 0.99 solve | – | 3.6 | 11.4 |
| IMG_7086 | 0.01 | 0.11 | 3.5 | prior | accepted | refined | yes |  | acc 1.00 refine+sky | – | 3.9 | 11.6 |
| IMG_7130 | 0.95 | 1.63 | 25.4 | auto | accepted | refined | yes |  | acc 0.76 solve | – | 3.6 | 11.2 |
| IMG_7131 | -0.04 | -0.35 | 8.1 | auto | auto | verified | yes |  | acc 1.00 refine+sky | – | 3.7 | 11.0 |
| IMG_7155 | -0.42 | 0.06 | 4.0 | auto | auto | verified | yes |  | acc 1.00 refine+sky | – | 3.7 | 10.8 |

### wide

| photo | Δyaw ° | Δpitch ° | px | preview | final align | verify | claims | FALSE | cascade (acc/conf/stage) | matcher | t-ready s | t-final s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| IMG_5495 | -6.92 | -2.24 | 205.9 | auto | unverified | unverified | no |  | rej 0.28 solve | low | 2.7 | 23.5 |
| IMG_6019 | 13.61 | -1.29 | 335.4 | near-compass | unverified | unverified | no |  | rej 0.00 solve | low | 2.8 | 24.4 |
| IMG_6958 | -0.03 | 0.19 | 24.8 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.6 | 3.9 |
| IMG_6971 | 0.03 | 0.28 | 4.4 | auto | auto | verified | yes |  | acc 0.53 solve | – | 3.4 | 3.6 |
| IMG_7018 | -0.25 | 0.28 | 8.1 | auto | auto | verified | yes |  | acc 0.81 solve | – | 3.5 | 3.7 |
| IMG_7033 | 0.14 | -0.03 | 6.6 | auto | auto | verified | yes |  | acc 1.00 solve | – | 3.5 | 3.7 |
| IMG_7053 | 0.13 | 0.35 | 6.9 | auto | auto | verified | yes |  | acc 0.72 solve | – | 3.9 | 4.1 |
| IMG_7059 | -0.92 | 0.09 | 16.8 | auto | auto | kept | yes |  | rej 0.42 solve | – | 4.5 | 5.0 |
| IMG_7063 | -0.57 | 0.25 | 10.1 | auto | auto | verified | yes |  | acc 0.68 solve | – | 3.5 | 3.7 |
| IMG_7068 | -0.21 | 0.10 | 3.9 | auto | auto | verified | yes |  | acc 0.99 solve | – | 3.5 | 3.8 |
| IMG_7086 | 0.08 | 0.12 | 3.5 | near-compass | accepted | refined | yes |  | acc 0.96 solve | – | 3.3 | 3.6 |
| IMG_7130 | 0.95 | 1.63 | 25.4 | auto | accepted | refined | yes |  | acc 0.76 solve | – | 3.6 | 3.8 |
| IMG_7131 | 0.02 | -0.35 | 6.5 | auto | auto | verified | yes |  | acc 1.00 solve | – | 4.1 | 4.3 |
| IMG_7155 | -0.34 | 0.07 | 2.9 | auto | auto | verified | yes |  | acc 1.00 refine | – | 3.6 | 4.6 |


## Reproduce

`node scripts/eval-app.mjs --pipeline <current|cascade|skyfirst|wide> [IMG_xxxx ...] [--concurrency N]`
(pipeline mode: scripts/eval-app-pipeline.mjs; prints a `JSON {summary, rows}` line). In the app:
`/photo/<id>?pipeline=<name>`. Code: src/lib/integration/pose-policy.ts (variants),
second-opinion.ts (solveCascade / opinionFromCascade split, `authoritative` flag), unknown-pose(.worker).ts
(optional `cross` skyline → skyfirst stage). PhotoWorkspace calls choosePreview / poseOpinion; absent
`?pipeline` is the old code path's behaviour, verified above.
