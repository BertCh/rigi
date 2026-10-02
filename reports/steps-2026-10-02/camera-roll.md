<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Step ⑮ camera-roll: review, research, plan (2026-10-02)

Gipfelbuch node `camera-roll` ("Rigi poses a set of photos and shows them on a map"). Opus step lead under
coordinator mt-image-17, cook mode: no browser, no benches. Every number below comes from dev or demo
data. These numbers are design evidence and must not be quoted as results.

## 1. Current state

| Part | Code | What it does |
|---|---|---|
| Grouping | `roll/roll.ts:207-243` `clusterPhotos` | Single-linkage clustering at 15 km, O(n²) `distanceM`. Photos without GPS are dropped. |
| Viewpoints | `roll/roll.ts:155-177` `groupViewpoints` | Greedy grouping in time order: a photo joins the first viewpoint whose first photo is within 250 m. Each viewpoint is then re-centred. |
| Pose per photo | `roll/roll.ts:90-147` `resolvePose` | Order: saved > ground truth > solved (by the aligner) > EXIF prior. Recomputed on every load. Saved and solved poses persist in localStorage. |
| Import | `roll/import/{index,interpolate,pool,provenance,save-status,stable}.ts`, `routes/roll.import.tsx` (920 lines) | Time-zone repair, GPS interpolation from anchors, bounded decode pool, save status. |
| Align roll | `roll/align/align.ts`, `align/viewpoint.ts` | Runs the frozen single-photo cascade, one worker at a time. The compass bias of a viewpoint is the median offset of the anchors within 45 min; it only changes the prior, never the accept decision. One retry pass. A leave-one-out outlier flag. |
| Propagation (R5) | `roll/propagate/**` | Pairwise suggestions only, behind `?propagate`. Pod B owns it. |
| Map + drape | `roll/map/**` (owned by a peer) | deck.gl on WebGL2. Multi-drape with up to `MAX_PHOTOS` (`drape-atlas.ts:91`). Per-photo clear-air fit (`drape-clear.ts`), a joint exposure/white-balance IRLS (`drape-gains.ts`), and the `RangeGpu` cull, which is WebGL only. |
| Mosaic + panorama | `roll/mosaic/**` | Grid, mini-map, time scrubber. `PanoramaStrip` and `panoGL.ts` use raw WebGL2. `viewpointTerrain.ts` runs ridge traces through the worker graph. |
| GPU island | `gpu/app-graph/manifest.ts:211` I12 | "WebGL2 only"; `roll-webgl` is `status: "cpu"` and has no graph groups (status.md decision 8, P3 memo). |
| Routes | `routes/roll.index.tsx`, `roll.$id.tsx`, `roll.import.tsx`, `dev.export-roll.tsx` | |
| Specs | 29 files and 312 tests under `src/lib/roll` (all pass). Check rows: `roll-propagate`, `palette-cvd`. | No specs for `map/roll-map.ts`, `multi-drape-layer.ts`, `drape-clear.ts`, `range-gpu.ts`, `mosaic/panoGL.ts` or the routes. |

## 2. Findings (ranked)

**P1**
1. **Declination was inconsistent (camera-prior U4).** `priorPose` (`roll.ts:79`), `anchorOf` (`align/viewpoint.ts:60`) and the align leave-one-out check (`align.ts:356`) read the raw `meta.heading`. The workspace engines read `priorHeading(photo)`. Under `?geoDecl=on` a magnetic-ref upload therefore got a different prior in `/roll` than in the workspace, and every learnt bias was shifted by the declination. **Fixed in U1.** `propagate/plan.ts:106-109` still copies `priorPose` with the raw heading; see §6, P-1.
2. **The 45-minute bias window does not match how the compass error behaves.** Within the demo session (12 iPhone photos at one spot over 20 min), the solved-minus-compass offset goes from +9 to +11° (13:28 to 13:33), then to −6.5° (13:34), then to −19° (13:39). Photos taken seconds apart agree to about 1°. Leave-one-out on the 10 accepted photos, using the same viewpoint and the median of the anchors inside a window W:

   | W | anchored | median | max | within 5° |
   |---|---|---|---|---|
   | raw compass | – | 9.6° | 19.0° | 2/10 |
   | 15 s | 4 | 2.5° | 11.5° | 6/10 |
   | 60 s | 7 | 2.5° | 16.4° | 7/10 |
   | 180 s | 9 | 6.0° | 15.1° | 5/10 |
   | 600 s | 10 | 10.7° | 17.5° | 3/10 |
   | **2700 s (default)** | 10 | **11.6°** | 24.3° | **0/10** |

   Data: the bundled GT photos (14 with a heading: 8 in region-0, the rest single). The result is neutral there: 4.4° raw against 4.5° at 45 min, because only 5 have anchors.

   A heading-dependent deviation curve (A + B sin ψ + C cos ψ, the classic compass-deviation model) gives a leave-one-out median of 5.4° but a maximum of 28°, which is unstable at n = 10.

   This refines the camera-prior finding from "slowly varying bias" to **bias correlated over seconds to about a minute**. The default 45-minute median can make the prior worse than the raw compass. The cascade's ±25° local window absorbs most of that, but a worse prior at the 0.5 local bar is the IMG_7053 trap. Script: scratchpad `session_bias.py`, which reads `public/photos/photos.json`, `data/ground-truth.json` and `public/demo/gipfelbuch/*.json`.

   **Opt-in flag landed in U2. The default needs a bench (user/batch).**

3. **The drape is silently capped.** `roll-map.ts:416-419` drapes only the first `MAX_PHOTOS` photos and only `console.warn`s about the rest, so the user is not told. This is in the peer's map files; see §6, P-2.
4. **Photos without a compass get yaw 0.** `priorPose` returns 0 and the photo is drawn as a real wedge. `RollMiniMap.tsx:370` has a "dashed + fan" cue, but `RollPhoto` has no "yaw unknown" bit. Only `local.yawUnknown` carries it, and that exists only for uploads. See P-3.

**P2**

5. **The `viewpointTerrain` trace queue is not cancelled** (`mosaic/viewpointTerrain.ts:54-87`). Queued traces keep fetching tiles and spawning workers after `/roll` unmounts. The memo map is unbounded for the life of the session. The perf trap grows with the number of viewpoints.
6. **The panorama registers every roll photo with `PanoGL`** (`PanoramaStrip.tsx:355-360`), with textures up to 2048 px and no per-viewpoint eviction. GPU memory grows with roll size.
7. **Viewpoint grouping is greedy, not nearest** (`roll.ts:162`). A viewpoint stays open all day, so a return visit hours later joins it. The bias window keeps those apart in time; the panorama does not.
8. **`clusterPhotos` is O(n²) on the main thread** on every `uploadRolls` call (both `listUploadRolls` and `loadRoll`). This is about 5 M pairs at 3,000 photos, which is fine at today's sizes. A grid bucket at `ROLL_LINK_M` would make it O(n). It is not done yet because no roll is that large.
9. `getBuiltinRoll` rebuilds every built-in roll, including the localStorage reads, on each call (`roll.ts:296`). This is minor.
10. `export.ts:55`: the track LineString joins viewpoints with no gap break and uses the GPS `alt`, not `eyeAlt`.

**P3**
11. Ordering by `takenAt` strings is correct today, because ingest and upload both write UTC ISO with `takenAt === takenAtUtc` (checked: all 19 bundled photos, `upload/exif.ts:383-404`). A malformed `takenAt` gives `t = NaN`, and that photo then never gets a bias. This is harmless.
12. `angDiff(180, 0)` returns −180, where the doc says (−180, 180]. This is a known `it.fails` in `viewpoint.spec.ts`.
13. The roll island I12 is not in the graph. Decision 8 and the P3 memo recommend compute first (`RangeGpu` WGSL twin) and a render port later behind a flag. All of that code is in the peer's `roll/map/**`.

## 3. Research summary
- **Grouping photos into a trip or place.** Photo libraries cluster by space and time. The standard is spatio-temporal density clustering: ST-DBSCAN (Birant and Kut, *Data & Knowledge Eng.* 2007), and time-gap event segmentation as in PhotoTOC (Platt et al., 2003). Our single-linkage on space alone is the degenerate case. Adding time (a gap above several hours splits a roll) would match "a day is a place" better. It would also change roll ids, which needs a migration, so it is listed for later (L-3).
- **Joint pose across a roll.** Photos taken from one spot share a camera centre, so their relative rotations follow from image overlap. Rotation averaging (Hartley, Trumpf, Dai and Li, *IJCV* 2013) and panorama bundle adjustment (Brown and Lowe, *IJCV* 2007) are the textbook route. Our R5 propagation is the pairwise version of this, and pod B owns it. The recorded negatives cover multi-view fusion at roll spots, eye refinement for roll spots and the concord joint solve (`negative-results.md:75-76`), so a shared-eye joint solve is not proposed again.
- **Compass error model.** A magnetometer heading error is a deviation curve in heading (hard iron: A + B sin ψ + C cos ψ; soft iron adds the 2ψ terms; Bowditch, *American Practical Navigator*, ch. 6) plus a drifting calibration state. The demo data fit "correlated over a minute" better than either a fixed session bias or a deviation curve. That is consistent with handheld phones, which change pose and recalibrate between bursts.
- **Mountain geo-localisation from skylines** (Baatz et al., ECCV 2012; Brejcha and Čadík, GeoPose3K, 2017). These systems work photo by photo. No public system we know of jointly poses a camera roll against a DEM, so the roll's added value is consistency between photos, not a new matcher.

## 4. Plan

| Unit | What | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| U1 | `priorHeading` in `priorPose`, `anchorOf` and the align leave-one-out check (`compassHeading`) | S | low; bit-identical with `geoDecl` off | roll and flags specs, fast tier | **now** |
| U2 | `?rollBiasWindow=<s>` opt-in anchor window, plus the `alignRoll` option `biasWindowS` | S | none by default | specs | **now** |
| U3 | `viewpointTerrain` queue cancellation: an abort signal per caller, skip queued traces whose callers all aborted, bound the memo (LRU) | M | low; the CPU path only changes on route leave | spec with a fake worker (the existing `viewpointTerrain.spec`) | next |
| U4 | `RollPhoto.yawKnown` (heading non-null and not `yawUnknown`), so the mosaic, mini-map and map stop treating a yaw of 0 as a real heading | S–M | display only | specs and a browser batch row | next; needs the map peer for the map part |
| U5 | Make the bias window default 60 s (or the nearest anchor within 60 s) | XS | accept path | a roll-align bench on the dev roll (browser), plus the blind pack under the frozen rule | **user/batch decision** |
| U6 | Grid-bucket `clusterPhotos` at `ROLL_LINK_M` (bit-identical clusters) | S | low | spec comparing against the O(n²) reference | later, at more than about 2k uploads |
| L-3 | Time-gap split of rolls (ST-DBSCAN-like) | M | changes roll ids | migration of `uploadRollId`, spec | later, product decision |
| L-4 | P3: a WGSL twin for `RangeGpu`, then the drape port behind `?rollRenderer` | M–L | look and VRAM | roll A/B and fps/VRAM batch (P3 memo) | after the G1 browser pass; the map peer owns it |

## 5. What landed
- U1 96cf897: roll prior and bias use `priorHeading`; specs in `roll.spec.ts` and `viewpoint.spec.ts`. Bit-identical with `geoDecl` off.
- U2 b5a93ff: the `rollBiasWindow` flag and the `biasWindowS` option; specs in `viewpoint.spec.ts` and `align.spec.ts`. The default is unchanged.
- 6d744fd: this plan, plus a spec that the leave-one-out check uses the same window.
- U3, the `viewpointTerrain` cancellation (`signal` and an interest count per memo entry; a queued trace with nobody waiting is skipped; a started one finishes and stays memoised), and `PanoramaStrip`, which aborts on cleanup. Browser-unverified; ledger row "step camera-roll U3". The memo is still unbounded (results only; workers are freed), so that is left for later.
- W2 (from the pose-estimate step): `loadSolvedPose` rejects a record that fails `isPose` or has a non-finite confidence; spec in `roll.spec.ts`.
- Review iterations: one Sonnet review sweep, then an adversarial review of U1 and U2 (no blocking issues; nits fixed: a stale comment and a leave-one-out window spec), then my own review of the U3 diff.
- Fast tier, run in the worktree before landing U1 and U2: 109 pass and 5 fail. None of the 5 are in this step's files:
  - biome: new errors in Gipfelbuch pages.
  - unit: upload specs denied by Vite because node_modules is symlinked from the worktree, and the Python tooling tests.
  - ontology: `picker/schema.ts`.
  - flow: a timing check.
  - align-cert: timed out under load.
- Negative or not done: a heading-dependent deviation curve as a bias model (unstable; §2.2). A session-wide bias across viewpoints (camera-prior U9) is **not proposed**, because the demo data say the correlation lasts about a minute, not a session.

## 6. Proposals for files this step does not own
- **P-1 (pod B, `roll/propagate/plan.ts:106-110`).** Replace the copied prior block with `priorPose(t.meta)` from `roll.ts`, so the compass-overlap gate uses the same true-north heading. This is bit-identical with `geoDecl` off. `propagate.check.ts:53` should follow.
- **P-2 (map peer, `roll/map/roll-map.ts:416-419`).** Expose `drapedCount` / `MAX_PHOTOS` to `RollMap.tsx` and show a "draping N of M photos" chip instead of only a console warning.
- **P-3 (map peer).** Consume `RollPhoto.yawKnown` (U4) to draw no wedge, or the fan, for photos without a compass.
- **P-5 (Gipfelbuch owner, `scripts/gipfelbuch/data-camera-roll.ts:79,108`).** The page bake reads the raw `m.heading` and the default window. That is fine while `geoDecl` is off. To match the app, switch it to `priorPose` / `compassHeading`.
- **P-4 (map peer, P3).** Follow the P3 memo's option B.

## 7. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts and pages not edited)
- **summary:** "Photos within 15 km form a roll; within 250 m of a viewpoint's first photo, a viewpoint. Each photo gets the best pose on hand: saved, hand-fitted, solved by Align roll, else the sensors. The grouping is recomputed on every load; poses you save or align are kept in the browser."
- `pages/camera-roll.tsx:2244`: the callout "Computed each time, never stored" should say that saved and solved poses and propagation records persist in localStorage.
- **modules:** add `src/lib/roll/align/align.ts`, `src/lib/roll/align/viewpoint.ts`, `src/lib/roll/import/index.ts`, `src/routes/roll.import.tsx` and `src/lib/roll/map/roll-map.ts`. The page's CodeRefs already cite these.
- If the page says the compass bias is "slowly varying", change it to "correlated over about a minute" (§2.2).

## 8. Needs the user
1. U5: whether to change the 45-minute bias window default once a roll bench has run (a browser batch).
2. L-3: whether to split rolls by time gaps (this changes roll ids).

## 9. Batch-ledger row (pending: reports/batch-ledger.md had a conflicting peer edit at landing time)

| Batch | Commit | Change | Check | Risk |
|---|---|---|---|---|
| step camera-roll U3 | "roll/mosaic: viewpointTerrain takes an AbortSignal" (roll/mosaic/{viewpointTerrain,PanoramaStrip}) | Panorama strip aborts its terrain request on viewpoint change/unmount; a queued ridge trace with no caller left is skipped (no tiles, no worker); started traces finish and stay memoised | `/roll/<id>` panorama: flip quickly through 4+ viewpoints, the last one traces and shows ridgelines, no error chip; leave and return, a finished viewpoint shows without a new trace (devtools: one ridgelines worker per traced eye) | low |
