# picker: top-3 candidates + tap-a-peak (roadmap R4)

Opt-in behind `?picker=on` on `/photo/<id>` (both deck engines: WebGPU, the default, and WebGL `?renderer=deck`). Without the flag nothing is
rendered and the panel chunk is never loaded, so the default view, classic included, is unchanged.

Why: the matcher's top-4 contains the right pose 27/30 times, while only ~20/50 photos are a safe HIGH
(`reports/terrain-matching-research.md`, "Strategy carried forward"). Ranking is easier than verification, and a person easily rejects a
wrong skyline once they can compare.

## Flags

| URL | behaviour |
|---|---|
| (none) | off: `PickerMount` returns null |
| `?picker=on` | after the load settles, the panel opens by itself when the result is **not** an automatic HIGH; on a HIGH (or after a user pick / pin / saved pose) it is a collapsed "Other candidates · tap a peak" chip |
| `?picker=always` | always opens expanded |

"Automatic HIGH" (`isAutoHigh`) = align state `accepted`, or `auto` with the second opinion `verified` /
`refined` / `matched`, the same accept states as concord and Step Inside, minus the user states.

## What it does

1. **Candidates.** Once `[data-ready]` is set and the second opinion is not pending, it asks the app's own
   solver for its ranked hypotheses. With full metadata that is `engine.autoAlign(true)` alternatives
   (skyline search + silhouette re-rank, up to 5, the same call the load makes; the GPU grid is the
   engine's own; `autoAlignAsync` went with the three.js engine, removed 2026-10-01). With a missing compass / gravity / lens it is the unknown-pose
   cascade's `candidates` (a re-run of the solver PhotoWorkspace already holds). `topDistinct` keeps the
   first 3 that are more than 0.5° apart (`poseSepDeg` = max of optical-axis angle, |Δroll| and |Δvfov|).
   If the pose on screen is not among them (e.g. the second opinion refined it), it gets its own "shown" tile.
2. **Thumbnails.** Each tile draws the photo with that pose's predicted skyline (the traced horizon
   projected on the CPU, the same projection as `align.ts skylineRows`), so both renderers draw identical tiles.
   Clicking a tile previews the pose (not saved); **Use this** confirms it; **Back** restores the pose from
   before the preview.
3. **Tap a peak.** Tap a summit in the photo. The tap is a ray under every candidate pose (the shown one may be
   tens of degrees off), and `nearbyPeaks` offers the named OSM summits within 15° of any of those rays,
   nearest first. Choosing one adds a pin; the pose is re-solved from every candidate with the engine's pin
   solver (`Renderer.solvePins`: one tap = yaw + pitch, two = + roll, three = + vfov) and `rerankWithTaps`
   ranks the results: tap-consistent (≤ 12 px on a 1000-px image) first, then by skyline score
   (`align.ts scorePose`, fine). The best is previewed; the user confirms it.
4. **Provenance.** A confirmed pick goes through PhotoWorkspace's `setPose(p)` (saved, align state `manual`,
   background second opinion / deferred match aborted) with a note saying it is user-confirmed. It is never
   `accepted`/`pinned`, so it never becomes an automatic HIGH, and concord / Step Inside treat it as they treat
   a manual drag.

## Correction log (`log.ts`)

Every event is appended to `localStorage["rigi.picker.log.v1"]` (a bare array, ring of 2000, in memory if storage
throws or is corrupt); the panel's "Export log (n)" button downloads it as `rigi-picker-log-<date>.json`
(`{schema: "rigi/picker-log.v1", version, exportedAt, app, count, events}`), "Clear log" empties it.
The event types, the version rules and the tolerant parser (corrupt or other-version entries are dropped) are in `schema.ts`. Events: `shown` (the 3 candidates
with source, source rank, score, pose, separation from the shown pose, and which one was shown), `preview`,
`pick` (rank, source, before / after pose, taps), `revert`, `tap` (u, v, peaks offered with angular distance,
which was chosen), `tap-solve` (taps, start pose, re-ranked results with residual and skyline score),
`dismiss`. Each carries photo id, renderer, align state, verify verdict and a per-engine session id.
The log holds poses only (no pixels). A pick is a user's choice between suggestions, not ground truth: it has
to be blind-verified before it enters any benchmark.

## Files

| file | |
|---|---|
| `flags.ts` | `?picker=` via `src/lib/flags` (`flagFrom`) |
| `candidates.ts` | pure maths: `poseSepDeg`, `topDistinct`, `nearbyPeaks`, `rerankWithTaps`, `isAutoHigh` |
| `engine-access.ts` | read-only access to both engines' `horizonDirs`, `edge` and peaks (`snapped(pose)`), without widening `Renderer`; missing fields turn features off |
| `schema.ts` | log event types, version, `parsePickerLog` (pure) |
| `log.ts` | the correction log: storage ring, export, clear |
| `summary.ts` | `summarizeLog` / `formatSummary`: the owner-trial counts (pure) |
| `PickerPanel.tsx` | UI (lazy chunk) |
| `PickerMount.tsx` | the one PhotoWorkspace call site; null without the flag |
| `candidates.check.ts` | `npx tsx src/lib/picker/candidates.check.ts` |

Browser check: `node scripts/gpu/with-render-lock.mjs -- node scripts/picker-check.mjs IMG_6958 out/picker/6958 [deck|webgpu]` (default `deck`)
(previews a wrong candidate, taps a visible labelled peak where it is under the shown pose, picks its name,
checks the re-solve returns to the shown pose, confirms, prints the log).

## Owner trial

1. Open a photo with the flag on: `/photo/<id>?picker=on` (`?picker=always` also expands it on HIGH results).
   Default is off and stays off; without the flag nothing loads.
2. On a photo whose result is not an auto-verified HIGH the panel opens. Click a thumbnail to preview a
   candidate, **Use this** to keep it (**Back** or Esc undoes a preview), or **Tap a peak**, tap a summit you
   know and choose its name; the pose is re-solved and previewed. Esc steps back one level (peak menu, tap
   mode, preview, then closes the panel). Keeping the shown pose also counts, so do that when it was right.
3. A confirmed pick is saved as your manual choice. It is not verified and never becomes an automatic HIGH.
4. **Export log (n)** downloads `rigi-picker-log-<date>.json`; **Clear log** (two clicks) empties it.
   Nothing leaves the browser.
5. Summarise: `npx tsx scripts/picker/summarize-log.ts rigi-picker-log-<date>.json [--json]` prints sessions,
   photos, how often the shown pose was kept vs a different rank vs tap-a-peak vs dismissed, the pick-rank
   histogram and the tap-solve outcomes.

Picks are your choice between suggestions, not ground truth: they have to be blind-verified before they
count as anything in a benchmark, and the summary says how the picker was used, not how often it was right.

## Limits / next

- Candidate sources: the app's `autoAlign` alternatives or the cascade's. The matcher's ranked views (where
  the 27/30 top-4 number comes from) are not exposed by the match service yet; adding them needs a service
  field (top-k fused poses) and a `source: "matcher"`.
- The recall@3-with-one-tap metric from the archived tm-strategy is not measured yet; the log is the data source for it.
- Tap-a-peak solves rotation only (eye fixed). An eye error shows up as a large residual on a second tap;
  `pose6dof` could solve position from 3+ taps later.
- The unknown-pose (upload) path is type-checked but was not browser-tested: every bundled photo has a compass.
