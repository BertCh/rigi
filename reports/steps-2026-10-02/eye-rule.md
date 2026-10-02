<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Step ⑩ eye-rule ("Camera height"): review, research, plan

*2026-10-02, step lead for Gipfelbuch node `eye-rule` (`src/lib/gipfelbuch/graph.ts:365`). Claim: "The camera never stands inside the mountain." Read with [status.md](../status.md), [negative-results.md](../negative-results.md) and [matching-v2.md](../matching-v2.md).*

## 1. Current state

Before any solve, the eye (m, in the DEM's datum ≈ MSL) is set by one rule:

```
eye = max(GPS altitude, ground + 1.6 m)      with an altitude
eye = ground + 1.8 m                         without one (engines, roll, eye search)
eye = ground + 1.6 m                         without one (geo/pipeline.ts loadScene: /baseline, unknown-pose)
```

Before this pass the rule was copied five times. It now lives in one place, **`src/lib/geo/eye-rule.ts`** (`eyeAltitude`, `EYE_ABOVE_GROUND`, `EYE_NO_ALTITUDE_ABOVE_GROUND`, plus the diagnostic `checkAltitude`). The consumers:

| Consumer | Where | Ground sample used | Note |
|---|---|---|---|
| deck (WebGL2) engine | `src/lib/deck/engine.ts:922-927` | streamed TerrainSet `heightAt` (up to z17 near the camera) | `?? photo.alt ?? 0`: no DEM and no altitude gives an eye at 1.8 m MSL |
| deck-webgpu engine | `src/lib/deck-webgpu/engine.ts:1319-1326` | GPU height gather on the streamed set (`cameraDemHeight`, :1564) | the same `?? 0` fallback; lake floor can raise the eye (:1351, `?geoLakeFloor`, off) |
| fast horizon (both engines) | `deck-webgpu/engine.ts:1286-1295`, `deck/engine.ts:886-891` | z14 `heightFromTile`, then re-set to the engine eye | results are keyed by eye (`take(this.eyeAlt)`), so a stale z14 eye is discarded |
| /baseline + unknown-pose workers | `src/lib/geo/pipeline.ts:46-50` (`loadScene`), `src/lib/integration/unknown-pose-core.ts:118` | `terrain.sample` at `dem.levels[0].z` (Mapterhorn z15, `src/lib/dem/sources.ts:81`) | null altitude → 1.6 m (the engine renders the same pose at 1.8 m) |
| eye search (suggestion) | `src/lib/gpu/eye/suggest.ts:137` | Mapterhorn mosaic | solver floor `clearance` 1.5 m (`suggest.ts:155`, `pose6dof/eye.ts:349`), not 1.6 |
| roll map / ridgelines | `src/lib/roll/map/roll-map.ts:510-513`, `src/lib/roll/mosaic/ridgelines.worker.ts:106-110` | z17 set / mosaic | roll-map `heightAt ?? 0` |
| near field (Step Inside) | `src/lib/nearfield/near-dem.ts:104` | its own z16 NearDem | own `eyeZ`; ignores the lake-floor raise |
| lab | `src/lib/deck-webgpu/lab.ts:233` | | |

`alt` comes from EXIF (`src/lib/upload/exif.ts:273-279`, GPSAltitudeRef honoured; pins null it at :359) or photos.json (iPhones). No datum handling exists: `PhotoMeta.alt` is typed `Height<"msl">` (`src/lib/photos.ts:26`) on trust.

The altitude-contour prior (`src/lib/concord/priors/altitude.ts`) is **not wired into the app**. `?concord=eye` only switches the focal table (`src/lib/photos.ts:72`, `src/lib/geo/camera.ts:115`). As an eye rule it was worse on holdout (median 12.0 → 13.4 px, p90 18 → 36; negative-results row "Altitude-contour eye rule"). The geocam priors import only `EYE_PRIOR_DEFAULTS` from it, and their flags are off.

Solvers keep their own floors: pose6dof `aboveGround` {1.6, σ 3, cap 10} plus clearance 1.5 (`pose6dof/eye.ts:405-417`); the geocam standing factor (σ 2 m above, 0.5 m below; `geocam/map/factors.ts:116`); nearfield roll eyes z = DEM + 1.6 ± 2 (`nearfield/roll/eyes.ts:555`). No path re-clamps a solved eye to ≥ ground + 1.6 except the engines re-applying `eyeAltitude` after an eye-suggestion Apply. `photoAtEye` writes `alt = r.eye.h` (`gpu/eye/client.ts:119-129`).

## 2. Findings (ranked)

**P1**
1. **Two no-altitude heights.** Engines, roll and eye search use ground + 1.8 m. `loadScene` uses ground + 1.6 m. For a pinned or no-fix photo, unknown-pose solves rotation at g₁₅ + 1.6, and the engine then shows that pose from g₁₇ + 1.8. Known since the ontology pass (`src/lib/ontology/catalogue/findings.ts:42`) but never decided. Now explicit in `eye-rule.ts`; see decision D1.
2. **Android altitude datum (unhandled, unmeasured).** Android's `Location.getAltitude()` is height above the WGS84 ellipsoid [1][2]. Stock camera paths write it to GPSAltitude as "above sea level" [3]. In Switzerland the EGM2008 N is 47–55 m (`src/lib/tiles3d/geoid.ts`). Under `max()` such a photo's eye floats about 50 m: about 43 px of near-ridge shift at 2 km and hundreds of px at 200 m (§3). We have no Android photos with ground truth, so the size of this in practice is unknown. `checkAltitude` now flags the signature (`ellipsoid-suspect`), and the info panel shows it. Changing the eye waits on D2.
3. **The Gipfelbuch page presents the altitude contour as a live optional check.** "A second, optional check treats the altitude as a measurement…" (`src/lib/gipfelbuch/pages/eye-rule.tsx`, "Where it fails" beat). It is unwired and recorded negative. Corrected text is in §6.

**P2**
4. **The ground differs per consumer**: worker z15, engine z17 or GPU gather, near field z16, eye-search mosaic, roll z17. On slopes these give different eyes for one photo, by decimetres to metres. The difference has not been measured (unit U5).
5. **The near-field eye ignores the lake floor.** Under `?geoLakeFloor=on` the engine raises the eye to the lake level, but `NearDem.eyeZ` stays at DEM + 1.6 (`near-dem.ts:104`), so Step Inside renders from a lower eye. The flag is off by default (U6).
6. **The no-DEM fallbacks give an eye near sea level.** Engines use `demHere ?? photo.alt ?? 0` and roll-map uses `heightAt ?? 0`. With neither a DEM nor an altitude the eye sits at 1.8 m MSL. This is rare (DEM outage plus pin). Harmless for display, but the solve then runs on nonsense, and nothing says so.
7. **`max()` is biased upward by GPS noise**: positive errors are always kept [research §5]. The fix that was tried (contour prior) is negative, and nothing new is proposed without a new reason.
8. **The info panel's "Eye (DEM-snapped)" label was wrong** (`PhotoWorkspace.tsx:2139`). The eye is DEM-snapped only when the GPS altitude is underground. Fixed by U2.

**P3**
9. More copies remain in scripts. `scripts/demo/bake-surround.ts:147` and `bake-live-lines.ts:79` give 1.6 m when there is no altitude. `scripts/test-export.ts:460` uses 1.5 m. `scripts/gpu/ridges-check.mjs:101` uses g + 1.8. `pipeline.ts:23` still exports its own `EYE_ABOVE_GROUND`, which 8 scripts import. `scripts/demo/bake-pano-terrain.ts` now imports the rule.
10. The eye-search floor `clearance` is 1.5 m where the rule uses 1.6 m. Only a suggestion can land 0.1 m under the rule, and the engine lifts it on Apply.
11. `photoAtEye` keeps an altitude on a `positionSource: "pin"` photo, while the upload importer nulls the altitude for pins. This is intentional (it carries the suggested eye), but the altitude.ts `fromPin` comment assumes pins have no altitude.
12. Doc drift fixed in U1: scene.ts referenced the removed three.js `engine.ts`; the altitude.ts header claimed `?concord=eye` wires `concordEye`.

**Wrong-eye rejection (state, not this step's experiment).** Everything tried is negative: E1 a-contrario (accepts 10/56 displaced-eye decoys), GA2 CRLB, GA3 T-junctions, GA4 lake waterline, PnP free eye, skyline score, SKYPAR skyline parallax (killed 2026-10-02, 31752b8). GA5 integrity remains as an R2 veto-panel candidate (wrong-eye AUROC 0.83). Pod C (E4/E5) and the R2 prereg own this. The eye fallback stays **suggestion only**: `EyeSuggestion.tsx` runs only behind `?eyesearch=on|auto`, applies only on the Apply button, marks the photo `positionSource: "pin"` and never raises confidence. Verified in this review. Candidate feature for the R2 panel, not tried: the GPS-altitude residual of a moved eye (|eye − GPS alt| against the phone's vertical σ), which is free and independent of the skyline. For the R2 owners to pre-register, not built here.

## 3. Research summary

- **Datum.** Android `Location.getAltitude()` is ellipsoidal. API 34 adds `getMslAltitudeMeters()` / `AltitudeConverter` [1][2]. Camera HALs have written the ellipsoid value with AltitudeRef 0 [3]. Whether current Pixel or Samsung camera apps write MSL on API 34+ is **unverified**. iPhone `CLLocation.altitude` is MSL, barometer-aided, and the bundled photos agree with the DEM to a few metres where the fix is good (tools/concord/priors/RESULT.txt). DJI writes absolute (barometric) plus XMP `RelativeAltitude`, inconsistent across models [4]. `GPSMapDatum` says nothing about the vertical datum. Make/Model and per-roll statistics (median `alt − DEM − 1.6 ≈ N`) are the practical detectors.
- **Accuracy.** Phone vertical error is about 3–10 m (1σ) in open sky and 15–30 m with multipath [5]. EXIF has no vertical accuracy tag (`GPSHPositioningError` is horizontal).
- **Sensitivity.** Horizon shift ≈ Δh/d. At 1500 px / 50° vfov (1 rad ≈ 1719 px):

  | Δh | 200 m | 2 km | 20 km |
  |---|---|---|---|
  | 0.2 m (1.6 vs 1.8) | 1.7 px | 0.17 px | 0.02 px |
  | 10 m | ~86 px | 8.6 px | 0.9 px |
  | 50 m (datum) | several hundred px | 43 px | 4.3 px |

  5–20 m of horizontal error on a 30° slope moves the ground 3–12 m: the DEM-at-fix error is as large as GPS vertical noise.
- **Literature and products.** Mountain geo-localisation (Baatz et al. ECCV 2012 [7]; Saurer et al. IJCV 2016 [8]) places the camera on the DEM plus a small constant and relies on skyline robustness. Our recollection of PeakFinder, PeakVisor and LandscapeAR is the same (DEM + human height, manual override), but this is **unverified**.
- **Our own record.** Six eye-locating cues have been killed (above). The altitude-contour rule is negative. Eye refinement for roll spots is negative. Don't redo any of these.

Sources: [1] developer.android.com/reference/android/location/altitude/AltitudeConverter · [2] developer.android.com/reference/androidx/core/location/altitude/AltitudeConverterCompat · [3] lists.libcamera.org/pipermail/libcamera-devel/2021-March/018040.html, josm.openstreetmap.de/ticket/7710 · [4] phantompilots.com/threads/go-app-altitude-vs-metadata.77268 · [5] developer.apple.com/forums/thread/669624 · [7] mlanthology.org/eccv/2012/baatz2012eccv-large · [8] Saurer et al., IJCV 116 (2016).

## 4. Plan

| Unit | What | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| U1 | One rule module `geo/eye-rule.ts`. Engines (via the scene.ts re-export), eye search, ridgelines worker, pano bake and concord import it. `checkAltitude` diagnostic. Doc drift. Bit-identical | S | low | spec proves equality with the old copies and with loadScene; tsc; unit | **now** |
| U2 | Camera panel: "Eye" row says which branch set it (GPS / ground + 1.6 underground / ground + 1.8 none / lake level) and warns on `ellipsoid-suspect` and `high`. Loads the EGM2008 grid lazily, only for a raised non-Apple altitude | S | low (display) | happy-dom spec; browser-unverified ledger row | **now** |
| U3 | `pipeline.ts`: `eye: eyeAltitude(alt, ground, EYE_ABOVE_GROUND)` and `export { EYE_ABOVE_GROUND } from "./eye-rule"`. Bit-identical | XS | low | spec already proves equality | proposal to the **baseline-pipeline** pod (it owns pipeline.ts) |
| U4 | Unify the no-altitude height after D1. Gate: dev split, node, altitude nulled on the dev photos, baseline eval at 1.6 vs 1.8; no new wrong accepts | S | med (solve path) | precision rule | after D1 |
| U5 | Measure the ground-at-fix spread across z14/z15/z16/z17 and the GPU gather for the 12 demo + dev photos (node over the tile cache) | S | none | report only | later |
| U6 | Near field takes the engine's eye (or applies the lake floor) | S | low (display) | spec + ledger | later (nearfield/** is free now) |
| U7 | `?eyeDatum=geoid` (off): subtract EGM2008 N when `ellipsoid-suspect` | S | med | needs Android photos with known positions (D2) | after D2 |
| U8 | Gipfelbuch text corrections (§6) | XS | none | gipfelbuch checks | handed to the Gipfelbuch owner |
| U9 | Replace the remaining script copies (P3 #9) | XS | none (bakes) | re-bake diff empty | later |

## 5. Decisions for the user

- **D1:** one no-altitude height. Recommendation: **1.6 m everywhere**, the standing height the claim and the page state. This changes the engine eye of pinned / no-fix photos by −0.2 m (≤ 1.7 px at 200 m). Alternative: 1.8 m everywhere, which changes the unknown-pose worker instead. Either touches the solve path, so it ships after the U4 gate.
- **D2:** Android datum. To size the problem we need a handful of Pixel or Samsung photos taken at known spots (summit crosses, lake shores). Until then the app only warns (U2).

## 6. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts and pages not edited here)

- `graph.ts` eye-rule `modules`: `["src/lib/geo/eye-rule.ts", "src/lib/deck/scene.ts", "src/lib/geo/pipeline.ts"]`. Move `concord/priors/altitude.ts` out: it is the negative altitude-contour experiment, not the live rule. `reports`: add `reports/steps-2026-10-02/eye-rule.md` and `reports/negative-results.md`.
- `summary`: "Without a solve, the eye sits at the GPS altitude but at least 1.6 m above the ground; with no altitude at all, 1.8 m above it (1.6 m in the /baseline worker)."
- Page "Where it fails" beat: replace "A second, optional check treats the altitude as a measurement and looks for where it matches the ground. If it finds nothing, it steps aside." with "We tried treating the altitude as a measurement, sliding the eye to where the ground plus 1.6 m matches it. It made held-out poses worse (median 12.0 → 13.4 px), so it stays in the code, switched off."
- Fig. 1 label "no altitude: DEM + 1.6 m" and the "Pins carry no altitude… always use ground + 1.6 m" callout: the app uses **ground + 1.8 m** (1.6 m only in the /baseline and unknown-pose workers).
- Details "Phone altitude is reported above mean sea level (we did not check this per device)": add "Android phones may write height above the ellipsoid, about 50 m higher here. The camera panel flags that signature."
- The Callout "Altitude is evidence, not a floor" reads as a live lesson. Add "…but as an eye rule it lost on holdout (negative-results)."

## 7. Landed

- **U1** `d5cccc1` + `88a7c2a`: `src/lib/geo/eye-rule.ts` + `__tests__/eye-rule.spec.ts`; scene.ts re-export; suggest.ts, ridgelines.worker.ts, bake-pano-terrain.ts and concord altitude.ts import it; altitude.ts header and geo/README corrected; this plan. Bit-identical: the spec checks the rule against the old inline formula and against `loadScene`. Review iteration 1 (an independent reviewer) found three things, all fixed in 88a7c2a: `checkAltitude` gave "raised" for a NaN ground (now `no-ground`), a NaN altitude gave a NaN eye, and the pano bake still had its own copy. It also flagged that `pipeline.ts` still keeps its own constant, which is U3 and belongs to the baseline-pipeline pod.
- **U2** (this commit series, browser-unverified; one batch-ledger row): `src/components/EyeHeightRow.tsx` + spec. The panel row now says which branch of the rule set the eye. Engines expose `demKnown` (`renderer.ts`, both engines; bit-identical). Review iteration 2 found and fixed:
  - the no-DEM fallback (`demAtCamera = alt ?? 0`) gave a false "0 m below" note;
  - the lazy EGM2008 import did not split, because `ExportMenu` → `engine-export.ts` already imports it statically;
  - a `<dd>` had no `<dt>`;
  - the warning had no light-theme colour.
  
  Known and accepted: the row reads `engineRef` during render, as the old row did. For one render after an eye-suggestion Apply it can pair the new altitude with the old engine.
- **Fast tier** in the U2 worktree: 107 pass, 6 fail. None of the six touch these files:
  - `biome`: new errors in peers' files (gipfelbuch shell.spec, camera-roll page, roll save-status.spec);
  - `unit`: the libheif `?url` import is denied through the symlinked node_modules (the same specs pass in the main tree), plus 3 python tool specs;
  - `labels`, `flow`, `align-cert`: timing under machine load;
  - `roll-propagate`: `public/photos/photos.json` was not copied into the worktree.
  
  tsc passed, and the spec-touched dirs pass.
- **Negative:** none new. No wrong-eye experiment was run; it is owned elsewhere (§2).
- **Next:** U3 (pipeline pod), D1 → U4, U5 measurement, U6 near-field eye.
