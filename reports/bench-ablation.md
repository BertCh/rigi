# In-the-wild harness: controlled ablation (heading / gravity removed)

*2026-09-25 · harness in `tools/bench/harness/` · server extension in `tools/matcher/server/` (ad-hoc mode) · raw rows in `tools/bench/harness/out/runs/ablation/results.json` (gitignored), overlays next to them*

## TL;DR

- **Fused `/match` is the one method that survives losing both heading and gravity, and its confidence stays honest.**
  - Against the pin GT (11 photos), it is within 1° of yaw on 11/11, 11/11, 11/11 and 10/11 under full metadata, no gravity, no heading and neither.
  - Median |Δyaw| stays at 0.14–0.16° across all four conditions.
  - It made **0 false HIGHs in 48 cases.** Every miss (IMG_7130 at 2°, and at −85° without heading; IMG_7018 at +105° with neither) came back LOW.
- **The app aligner as shipped cannot handle an upload without a heading.**
  - The engine uses `heading ?? 0` as the prior, searches only ±25°, and loads terrain only in a wedge around that prior.
  - Natively, 3/11 are within 1° without a heading and 2/11 without heading or gravity. Worse, 7 and 8 of those wrong poses are *accepted* (confidence > 0.2).
  - A harness wrapper fixes most of this. It loads the full terrain, uses 9 yaw seeds × 3 pitch seeds and picks the best by the app's own score. That gives 10/11 without heading and 7/11 without either, with 1 false accept each (IMG_7086).
- **Without gravity alone, the native app loses 4/11** (7/11 within 1°, 3 false accepts). The cause is its ±6° pitch grid and σ = 2.5° pitch penalty. Pitch seeds bring it back to 8/11 with 0 false accepts.
- **the app pipeline's cascade supports everything via options, not by default.**
  - With the unknowns declared (360° yaw, free pitch/roll, no tilt gate), it gets 10, 10, 9 and 8 of 11 within 1°, with **0 false accepts in every condition**.
  - With default options, it degrades to 3/11 when both are missing. It never falsely accepts, though: it rejects instead.
- **What the upload path should do:** treat a photo without heading or gravity as a fused-service job (two-stage 360° sweep, ≈ 11–22 s). If the service isn't there, run the cascade with the unknowns declared (≈ 0.7–2.4 s). The app's own `autoAlign` should not be trusted without a heading: it accepts wrong poses.

## What each method supports natively

| unknown | app (`engine.autoAlign(true)`) | cascade (`solvePose` → `refinePose`) | fused (`/match`, before this change) |
|---|---|---|---|
| **heading (yaw)** | **No 360°.** Prior yaw = `photo.heading ?? 0`. Grid ±25° around it (engine passes `yawRange = 25`), yaw penalty σ ≈ 20°. Terrain loads only a wedge of ±(hfov/2 + 32°) around the prior yaw, so the horizon outside it is empty. | **Partial.** `solvePose` searches ±25° (σ 15°). When the local search *rejects*, it retries a full 360° search and accepts at confidence ≥ 0.75 (`fullSearchFallback`). Configurable: `yawRange: 180` + σ yaw. `refinePose` FFT init ±30°, configurable up to 180°. | **No.** It takes a prior plus ≤ 9 yaw offsets. The skyline cue is the app's ±25° search. The match cue (2-point rotation RANSAC) needs no yaw prior, but only sees the rendered fan. |
| **gravity (pitch/roll)** | **Partial.** Pitch grid ±6° (σ 2.5° penalty). Roll only in coordinate descent (σ 4°). Fine for |pitch| ≲ 5°, not beyond. | **Configurable, off by default.** `solvePose`: pitch ±3°, σ 1.5°, and **`tiltGate = 3°` rejects any solve that tilts > 3° from the prior**. `refinePose`: prior σ pitch/roll 0.7°. All of these are exposed as options. | **Match cue: yes**, because the rotation is solved freely. Skyline cue: as the app. |
| **focal** | ±~10% (σ 8% of prior vfov) | ±8% clamp in `solvePose` LM; `refinePose` focal clamp 6% | fusion prior σ 5%; legacy solve `freeFocal` ±10% |

## What the harness does about it

The wrappers sit at the harness/server level. No method's source was modified: `src/**`, `scripts/**` and `tools/matcher/*.py/*.mjs` are imported, never edited.

- **App (harness wrapper):**
  - **Ad-hoc photo:** the photo is injected with Playwright request interception.
    - The `photos.json` module (Vite serves `/public/photos/photos.json?import`) gets the ad-hoc `PhotoMeta` appended.
    - `/photos/<id>.jpg` serves the upright JPEG.
    - `/photos/<region>.json` serves OSM peaks, from the bundled region or from Overpass.
    - `/photo/<id>` then loads as for a bundled photo. The `/upload` route and IndexedDB path (`src/lib/upload/**`) exist but need a file picker and Overpass in-page, so I didn't use them.
  - **Seeds:** without a heading, the harness calls `terrain.loadPending()` and re-traces the 360° horizon, then runs `autoAlign(true)` from seeds (`engine.prior` swapped in memory, as `export_skyline.mjs` does):
    - yaw every 40° (no heading);
    - pitch −8 / 0 / +8° (no gravity);
    - hfov 40 / 50 / 65° (no focal).
  - **Best seed:** picked by the app's own re-ranked score.
  - **Confidence:** recomputed with the engine's margin formula over all seeds' hypotheses (runner-up ≥ 3° away). The app acceptance rule (confidence > 0.2, or near-compass only when the compass exists) is applied.
  - **`app, native`:** the single run the app itself would do.
  - **Command:** new render-worker command `align`.
- **Cascade:** `tools/bench/harness/cascade.ts` calls the app pipeline's functions with the photo's JPEG and metadata, using the same eye rule and Terrarium DEM. There are two variants:
  - **native:** eval.ts defaults, with unknowns set to 0;
  - **configured:** the unknowns are declared through the public options:
    - no gravity → `pitchRange 15`, σ pitch/roll 10°, `tiltGate 90`, refine init and prior σ 10°;
    - no heading → `yawRange 180`, σ yaw 1e6, refine init `yawRange 180`;
    - no focal → hfov seeds 40/50/65°, best by (accepted, confidence).
- **Fused, via the server's new ad-hoc mode:**
  - **Everything known:** one fused stage, identical to photoId mode. The service's own photoId result for IMG_7155 was 235.918°; ad-hoc gave 235.914°.
  - **Anything missing:** there are two stages.
    - **Stage 1** is a render-match sweep: 9 satellite views every 40° with full terrain when there is no heading, otherwise the usual ±20° fan at pitch 0. It uses free focal when focal is unknown.
    - **Stage 2** is the ordinary fused request, with the stage-1 pose as its prior.
    - **Fallback:** if stage 1 finds < 30 inliers and there is no heading, the stage-2 prior comes from the app's skyline score over yaw × pitch seeds.
  - **Caveat:** in two-stage mode the skyline cue is seeded by the match cue, so the HIGH rule's agreement check is less independent.
- **Unknown focal:** the default is a 50° hfov (vfov from the aspect), and each method frees focal as described above. This is recorded per row in `assumptions.focalSource`.
  - Smoke test on IMG_7068 with no heading, no focal and no altitude: fused and the app both recovered it. Fused found vfov 66.97° against the true 67.3° and yaw 31.86°, HIGH.
  - The cascade rejected it. Its 50° hfov seed found the right yaw (32.0°) but rejected it. All three seeds rejected, and the (accepted, confidence) pick then chose a wrong seed at 49.9°. Its ±8% focal clamp keeps each seed close to its starting focal.

## Controlled ablation: 12 app photos × 4 conditions

- **Conditions:**
  - (1) **full:** compass + gravity + EXIF focal, as `photos.json`;
  - (2) **gravity removed:** prior pitch = roll = 0;
  - (3) **heading removed:** 360° search;
  - (4) **both removed.**
- **Focal:** the EXIF focal is always kept.
- **Scoring,** as `tools/matcher` does:
  - |Δyaw| / |Δpitch| / |Δroll| of the **solved** pose;
  - success = |Δyaw| < 1°;
  - fused calibration from HIGH/LOW;
  - pin GT from the frozen control-point snapshot, as stored in `tools/matcher/out/renders/<id>/meta.json`: 11 photos with ≥ 2 pins, the same set `fusion.md` scores;
  - `data/ground-truth.json` as the secondary GT (12 photos).
- **Manifest:** `node tools/bench/harness/make_ablation_manifest.mjs` builds it from `photos.json` and both GTs.

### Headline (pin GT, 11 photos): photos within 1° of yaw · false accepts

| condition | app, native | app + wrapper | cascade, defaults | cascade, configured | fused (HIGH/LOW) |
|---|---|---|---|---|---|
| full metadata | 10/11 · 0 | 10/11 · 0 | 10/11 · 0 | 10/11 · 0 | **11/11** · 0 (9 HIGH) |
| gravity removed | 7/11 · **3** | 8/11 · 0 | 10/11 · 0 | 10/11 · 0 | **11/11** · 0 (8 HIGH) |
| heading removed | 3/11 · **7** | 10/11 · 1 | 8/11 · 0 | 9/11 · 0 | **11/11** · 0 (9 HIGH) |
| both removed | 2/11 · **8** | 7/11 · 1 | 3/11 · 0 | 8/11 · 0 | **10/11** · 0 (7 HIGH) |

Median |Δyaw| for fused is 0.14 / 0.15 / 0.16 / 0.16°. For configured cascade it is 0.18 / 0.18 / 0.22 / 0.46°, and for the app with the wrapper 0.30 / 0.26 / 0.22 / 0.36°. Full tables follow.

### Against pin GT (tools/matcher control-point GT, 11 photos: the primary scoring set)

Solved pose (whatever the method returns, accepted or not). "≤1° yaw" = |Δyaw| < 1°; "all ≤1°" also needs |Δpitch| and |Δroll| < 1°. "acc" = the method's own accept (app: confidence > 0.2 or near-compass; cascade: accepted; fused: HIGH). "false acc" = accepted but |Δyaw| ≥ 1°.

| condition | method | n | median \|Δyaw\| | median \|Δpitch\| | median \|Δroll\| | ≤1° yaw | all ≤1° | acc | false acc | worst Δyaw | median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full metadata | app (harness wrapper) | 11 | 0.30 | 0.26 | 0.34 | 10/11 | 8/11 | 10/11 | 0 | -5.9 | 149 |
| full metadata | app, native (1 autoAlign) | 11 | 0.30 | 0.26 | 0.34 | 10/11 | 8/11 | 10/11 | 0 | -5.9 | 149 |
| full metadata | cascade (unknowns via options) | 11 | 0.18 | 0.23 | 0.37 | 10/11 | 9/11 | 8/11 | 0 | 5.2 | 248 |
| full metadata | cascade, native defaults | 11 | 0.18 | 0.23 | 0.37 | 10/11 | 9/11 | 8/11 | 0 | 5.2 | 251 |
| full metadata | fused /match (ad-hoc) | 11 | 0.14 | 0.15 | 0.31 | 11/11 | 10/11 | 9/11 | 0 | -0.7 | 14286 |
| gravity removed | app (harness wrapper) | 11 | 0.26 | 0.23 | 0.30 | 8/11 | 7/11 | 8/11 | 0 | -14.8 | 461 |
| gravity removed | app, native (1 autoAlign) | 11 | 0.36 | 0.28 | 0.35 | 7/11 | 5/11 | 10/11 | 3 | 28.8 | 142 |
| gravity removed | cascade (unknowns via options) | 11 | 0.18 | 0.25 | 0.53 | 10/11 | 9/11 | 9/11 | 0 | 5.3 | 495 |
| gravity removed | cascade, native defaults | 11 | 0.18 | 0.18 | 0.36 | 10/11 | 8/11 | 9/11 | 0 | 5.0 | 738 |
| gravity removed | fused /match (ad-hoc) | 11 | 0.15 | 0.13 | 0.27 | 11/11 | 10/11 | 8/11 | 0 | -0.7 | 8628 |
| heading removed (360°) | app (harness wrapper) | 11 | 0.22 | 0.22 | 0.37 | 10/11 | 8/11 | 10/11 | 1 | -141.9 | 1367 |
| heading removed (360°) | app, native (1 autoAlign) | 11 | 56.47 | 0.40 | 0.64 | 3/11 | 3/11 | 10/11 | 7 | -168.3 | 157 |
| heading removed (360°) | cascade (unknowns via options) | 11 | 0.22 | 0.23 | 0.37 | 9/11 | 8/11 | 8/11 | 0 | 99.7 | 751 |
| heading removed (360°) | cascade, native defaults | 11 | 0.26 | 0.35 | 0.54 | 8/11 | 7/11 | 5/11 | 0 | -139.5 | 767 |
| heading removed (360°) | fused /match (ad-hoc) | 11 | 0.16 | 0.13 | 0.28 | 11/11 | 10/11 | 9/11 | 0 | -0.8 | 21403 |
| both removed | app (harness wrapper) | 11 | 0.36 | 0.23 | 0.40 | 7/11 | 6/11 | 8/11 | 1 | -152.8 | 3791 |
| both removed | app, native (1 autoAlign) | 11 | 63.89 | 3.15 | 1.13 | 2/11 | 2/11 | 10/11 | 8 | -161.7 | 142 |
| both removed | cascade (unknowns via options) | 11 | 0.46 | 0.36 | 0.61 | 8/11 | 7/11 | 6/11 | 0 | -168.1 | 2401 |
| both removed | cascade, native defaults | 11 | 56.31 | 1.78 | 2.36 | 3/11 | 2/11 | 3/11 | 0 | -156.6 | 822 |
| both removed | fused /match (ad-hoc) | 11 | 0.16 | 0.12 | 0.30 | 10/11 | 8/11 | 7/11 | 0 | 105.4 | 11056 |

### Against data/ground-truth.json (12 photos; secondary)

Solved pose (whatever the method returns, accepted or not). "≤1° yaw" = |Δyaw| < 1°; "all ≤1°" also needs |Δpitch| and |Δroll| < 1°. "acc" = the method's own accept (app: confidence > 0.2 or near-compass; cascade: accepted; fused: HIGH). "false acc" = accepted but |Δyaw| ≥ 1°.

| condition | method | n | median \|Δyaw\| | median \|Δpitch\| | median \|Δroll\| | ≤1° yaw | all ≤1° | acc | false acc | worst Δyaw | median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| full metadata | app (harness wrapper) | 12 | 0.33 | 0.28 | 0.31 | 10/12 | 9/12 | 11/12 | 1 | -5.9 | 151 |
| full metadata | app, native (1 autoAlign) | 12 | 0.33 | 0.28 | 0.31 | 10/12 | 9/12 | 11/12 | 1 | -5.9 | 151 |
| full metadata | cascade (unknowns via options) | 12 | 0.17 | 0.23 | 0.38 | 11/12 | 10/12 | 9/12 | 0 | 5.5 | 244 |
| full metadata | cascade, native defaults | 12 | 0.17 | 0.23 | 0.38 | 11/12 | 10/12 | 9/12 | 0 | 5.5 | 246 |
| full metadata | fused /match (ad-hoc) | 12 | 0.13 | 0.17 | 0.18 | 11/12 | 10/12 | 9/12 | 0 | 2.0 | 14327 |
| gravity removed | app (harness wrapper) | 12 | 0.27 | 0.23 | 0.24 | 9/12 | 7/12 | 8/12 | 0 | -14.8 | 464 |
| gravity removed | app, native (1 autoAlign) | 12 | 0.42 | 1.09 | 0.75 | 7/12 | 5/12 | 11/12 | 4 | 28.9 | 142 |
| gravity removed | cascade (unknowns via options) | 12 | 0.15 | 0.21 | 0.50 | 11/12 | 10/12 | 10/12 | 0 | 5.5 | 486 |
| gravity removed | cascade, native defaults | 12 | 0.28 | 0.15 | 0.30 | 11/12 | 10/12 | 9/12 | 0 | 5.3 | 702 |
| gravity removed | fused /match (ad-hoc) | 12 | 0.13 | 0.18 | 0.14 | 11/12 | 10/12 | 8/12 | 0 | 2.0 | 8661 |
| heading removed (360°) | app (harness wrapper) | 12 | 0.26 | 0.26 | 0.29 | 10/12 | 9/12 | 10/12 | 1 | -141.9 | 1361 |
| heading removed (360°) | app, native (1 autoAlign) | 12 | 85.69 | 0.41 | 0.67 | 3/12 | 2/12 | 10/12 | 7 | 173.7 | 157 |
| heading removed (360°) | cascade (unknowns via options) | 12 | 0.21 | 0.27 | 0.37 | 10/12 | 9/12 | 9/12 | 0 | 99.6 | 696 |
| heading removed (360°) | cascade, native defaults | 12 | 0.28 | 0.32 | 0.46 | 8/12 | 7/12 | 5/12 | 0 | 177.4 | 745 |
| heading removed (360°) | fused /match (ad-hoc) | 12 | 0.14 | 0.17 | 0.15 | 11/12 | 10/12 | 9/12 | 0 | -84.9 | 21310 |
| both removed | app (harness wrapper) | 12 | 0.45 | 0.28 | 0.41 | 7/12 | 6/12 | 8/12 | 1 | -152.8 | 3825 |
| both removed | app, native (1 autoAlign) | 12 | 83.47 | 2.76 | 1.62 | 2/12 | 1/12 | 11/12 | 9 | -173.0 | 141 |
| both removed | cascade (unknowns via options) | 12 | 0.32 | 0.29 | 0.59 | 9/12 | 7/12 | 6/12 | 0 | -168.1 | 2386 |
| both removed | cascade, native defaults | 12 | 38.03 | 1.26 | 1.51 | 4/12 | 4/12 | 3/12 | 0 | -156.6 | 804 |
| both removed | fused /match (ad-hoc) | 12 | 0.09 | 0.22 | 0.29 | 10/12 | 9/12 | 7/12 | 0 | 105.4 | 11115 |

### Fused HIGH/LOW calibration (pin GT where available, else GT json; success = |Δyaw| < 1°)

| condition | HIGH ok | HIGH fail | LOW ok | LOW fail | LOW reasons (cueAgree° / skyMed px / support) |
|---|---|---|---|---|---|
| full metadata | 9 | 0 | 2 | 1 | 7059 (0.3/7.4/0.85), 7086 (2.7/2.6/0.86), 7130 (2.8/4.9/0.49, Δyaw 2.0) |
| gravity removed | 8 | 0 | 3 | 1 | 7033 (–/0.7/–), 7059 (0.3/8.0/0.87), 7086 (2.5/3.0/0.82), 7130 (1.7/4.8/0.44, Δyaw 2.0) |
| heading removed (360°) | 9 | 0 | 2 | 1 | 7018 (0.2/1.0/0.11), 7086 (2.6/2.9/0.77), 7130 (–/4.9/0.00, Δyaw -84.9) |
| both removed | 7 | 0 | 3 | 2 | 6971 (–/1.2/0.00), 7018 (–/6.9/0.00, Δyaw 105.4), 7059 (0.5/8.6/0.89), 7086 (2.4/3.0/0.87), 7130 (1.6/4.8/0.44, Δyaw 1.9) |

### Per photo: Δyaw (°) vs pin GT (GT json in italics where there is no pin GT); "·" marks a reject / LOW

| photo | full app | full app(n) | full cascade | full fused | nogravity app | nogravity app(n) | nogravity cascade | nogravity fused | noheading app | noheading app(n) | noheading cascade | noheading fused | none app | none app(n) | none cascade | none fused |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| IMG_6958 | -0.03 | -0.03 | 0.10 | -0.04 | -0.03 | -0.03 | 0.11 | -0.03 | -0.05 | -21.44 | 0.10 | -0.05 | -0.04 | -21.19 | 0.11 | -0.03 |
| IMG_6971 | -0.01 | -0.01 | 0.51 | 0.05 | 0.04 | 0.04 | 0.45 | 0.05 | 0.17 | -54.36 | 0.51 | 0.05 | -152.78· | -63.89 | 0.46 | 0.05· |
| IMG_7018 | -0.30 | -0.30 | 0.23 | -0.21 | 5.15· | -0.28 | 0.18 | -0.21 | -0.28 | -168.30 | 0.22 | -0.19· | 107.43· | -135.65 | -168.10· | 105.41· |
| IMG_7033 | 0.22 | 0.22 | 0.02 | 0.14 | 0.26 | 3.49 | -0.03 | 0.15· | 0.19 | 127.70· | 0.02 | 0.16 | 0.24 | 118.43 | -0.03 | 0.16 |
| IMG_7053 | 0.37 | 0.37 | -0.09 | -0.01 | -0.13 | -0.13 | -0.09 | -0.01 | 0.02 | 115.12 | 99.67· | -0.02 | -0.06 | 103.06 | 99.66· | -0.02 |
| IMG_7059 | -0.62 | -0.62 | 5.21· | -0.41· | -3.10· | -5.74· | 5.27· | -0.41· | -0.60· | -0.60 | 5.68· | -0.79 | 54.10· | -11.27 | 5.41· | -0.34· |
| IMG_7063 | -0.59 | -0.59 | -0.56· | -0.66 | -0.62 | -0.62 | -0.55 | -0.66 | -0.59 | -0.60 | -0.56 | -0.66 | -0.66 | -0.64 | -0.55· | -0.66 |
| IMG_7068 | -0.25 | -0.25 | 0.00· | -0.24 | -0.22 | 28.75 | -0.02· | -0.22 | -0.22 | -56.47 | 0.06· | -0.21 | -0.20 | -32.69 | -0.02· | -0.22 |
| IMG_7086 | -5.90· | -5.90· | 0.18 | 0.05· | -14.78· | -14.78 | 0.18 | 0.04· | -141.92 | -147.25 | 0.18 | 0.07· | 56.99 | -161.73· | 0.18 | 0.08· |
| IMG_7130 | *2.98* | *2.98* | *0.03* | *1.96*· | *0.27*· | *-14.42* | *0.04* | *2.04*· | *-84.81*· | *173.69*· | *0.03* | *-84.89*· | *135.39*· | *-173.04* | *0.36*· | *1.87*· |
| IMG_7131 | 0.02 | 0.02 | 0.06 | -0.08 | 0.03 | 0.03 | 0.05 | -0.08 | 0.02 | 0.02 | 0.06 | -0.07 | 0.02 | 0.02 | 0.04 | -0.07 |
| IMG_7155 | -0.36 | -0.36 | -0.46 | -0.30 | -0.37 | -0.36 | -0.48 | -0.30 | -0.31 | 134.26 | -0.46 | -0.30 | -0.36 | 136.78 | -0.46 | -0.30 |

### Runtime per photo (median / max ms)

app = in-page autoAlign compute summed over seeds (page load excluded); cascade = skyline detection + solve (terrain/horizon load excluded, cached); fused = whole HTTP request incl. renders, matching and fusion (warm page; cold pages add 5–20 s).

| method | full metadata | gravity removed | heading removed (360°) | both removed |
|---|---|---|---|---|
| app (harness wrapper) | 151 / 200 | 464 / 561 | 1361 / 1601 | 3825 / 4548 |
| app, native (1 autoAlign) | 151 / 200 | 142 / 161 | 157 / 187 | 141 / 158 |
| cascade (unknowns via options) | 244 / 1310 | 486 / 4848 | 696 / 1435 | 2386 / 5080 |
| cascade, native defaults | 246 / 1313 | 702 / 1276 | 745 / 1539 | 804 / 1459 |
| fused /match (ad-hoc) | 14327 / 17543 | 8661 / 11188 | 21310 / 23684 | 11115 / 22074 |

### Cross-check: condition "full" against existing results (|Δyaw| between this run and the reference, °)

| photo | app vs leaderboard `app-raw` | cascade vs leaderboard `cpu:classic-cascade` | fused vs fusion_default.json (shift 0) |
|---|---|---|---|
| IMG_6958 | 0.000 | 0.001 | 0.014 |
| IMG_6971 | 0.000 | 0.015 | 0.017 |
| IMG_7018 | 0.000 | 0.022 | 0.029 |
| IMG_7033 | 0.000 | 0.002 | 0.005 |
| IMG_7053 | 0.000 | 0.002 | 0.013 |
| IMG_7059 | 0.000 | 4.853 | 0.124 |
| IMG_7063 | 0.000 | 0.002 | 0.000 |
| IMG_7068 | 0.000 | 0.059 | 0.039 |
| IMG_7086 | 0.000 | 0.003 | 0.002 |
| IMG_7130 | 0.000 | 0.044 | 0.038 |
| IMG_7131 | 0.000 | 0.007 | 0.002 |
| IMG_7155 | 0.000 | 0.002 | 0.005 |
| **median** | 0.000 | 0.005 | 0.014 |


### Notes on the numbers

- **Cross-check (condition full).**
  - The app matches the leaderboard's `app-raw` exactly (Δ 0.000°).
  - Fused matches `fusion_default.json` to a median of 0.014°, max 0.12° on IMG_7059, a render-to-render match variation.
  - The cascade matches `cpu:classic-cascade` to a median of 0.005°. The exception is IMG_7059 at 4.85°, which both runs *reject*. The harness feeds the app's 2048-px JPEG where eval.ts uses its HEIC→1600-px JPEG, and the rejected raw pose differs.
- **The recurring hard photos** are the ones already known from `fusion.md` and the leaderboard:
  - IMG_7086: a skyline confuser, where the app is wrong even with full metadata but rejects;
  - IMG_7059: a ridge-top photo;
  - IMG_7130: no pin GT, 2° off for fused and always LOW.
- **The app wrapper's false accepts** are both IMG_7086: −142° without a heading (confidence 0.23) and +57° with neither (confidence 0.66). IMG_7086 is the photo whose skyline the app gets wrong even with full metadata. Over 9–27 seeds, the margin-based confidence meets many more wrong candidates. An accept rule for 360° mode would need its own calibration; the 0.2 threshold is not safe there.
- **Runtime caveats.**
  - Fused "full" and "heading removed" include the cold page load for the page they open first. Without heading, that's a new page because the terrain wedge differs, plus loading all tiles (≈ 1–3 s) and draping imagery.
  - Warm fused requests are ≈ 7–9 s single-stage and ≈ 10–12 s two-stage.
  - App times are in-page compute only. Page load (≈ 4–15 s) is excluded, as in the leaderboard.
- **Shared dev server.** One request (IMG_7130, heading removed, fused) died on an HMR reload triggered by other work on the shared dev server. It was re-run on resume, and the harness now retries once.

## CLI

```bash
# dev server on :3100; fused uses :8765 if it has ad-hoc support, else starts a private service on :8766
tools/bench/harness/run.sh tools/bench/data/manifest.json                       # all methods, condition "given"
tools/bench/harness/run.sh <manifest.json> --methods app,cascade,fused --ids a,b \
    [--conditions given|full,nogravity,noheading,none] [--out DIR] [--matcher-url URL] \
    [--no-overlay] [--overlay-methods app,cascade,fused] [--force]
node tools/bench/harness/make_ablation_manifest.mjs            # → out/ablation/manifest.json
node tools/bench/harness/ablation_report.mjs <results.json>    # → the tables in this report
npx tsx tools/bench/harness/overlay.ts --photo p.jpg --lat L --lon L [--alt m] --pose yaw,pitch,roll,vfov \
    [--gt …] [--prior …] [--method m] [--conf "HIGH 0.9"] [--region region.json] --out o.jpg
```

- **Manifest fields:**
  - `{id, file, lat, lon, altitudeM?, headingDeg?, focalMm?, focal35mm?, width, height, tags}`;
  - `file` is relative to the manifest;
  - `focalMm` alone is ignored (no sensor size), so a 50° hfov is used and focal is freed.
- **Optional extensions:**
  - `pitchDeg`/`rollDeg` (gravity);
  - `vfovDeg`/`hfovDeg`;
  - `gpsErrorM`;
  - `regionFile`;
  - `gt`/`gtPin` for scoring.
- **Output** goes to `tools/bench/harness/out/runs/<name>/`:
  - `results/<id>/<cond>.<method>.json`, one per photo, condition and method. Each has the solved pose, the shown pose, accept, confidence, assumptions, timing, and errors when GT exists;
  - `overlays/<id>__<cond>__<method>.jpg`, with the DEM skyline at the pose, the top 8 occlusion-tested OSM peak labels, and a header with method, condition, pose, confidence and Δ vs GT;
  - `results.json` and `summary.md`.
- **Photos** are normalised to an upright JPEG ≤ 2048 px (EXIF orientation applied). Re-runs resume and skip finished rows, but always re-run failed ones.
- **Caches:** Overpass is cached in `out/cache/overpass`, with 2 s between queries, a UA string and back-off. DEM tiles come from the repo's `.cache/terrarium` read-only, else `out/cache/terrarium`.

## Server extension (`tools/matcher/server`, backward compatible)

- **`POST /match` JSON** `{photoPath | photoUrl, meta:{lat, lon, altitudeM?}, prior?:{yaw?, pitch?, roll?, vfov? | hfov?}, region?, offsets?, fused?, timeoutMs?}`.
  - Multipart works too: parts `request` (the same JSON with `meta` and no `views`) and `photo`.
  - Missing fields mean unknown. The response carries `adhoc:{yawKnown, gravityKnown, focalKnown, priorUsed, yaw360, twoStage, stage2Prior, stages[]}`.
- **Existing modes are unchanged** apart from these:
  - `offsets` now allows up to 12;
  - `/health` lists `capabilities: ["photoId","multipart","adhoc"]`;
  - the render worker's warm-page check now also requires `terrain` and `horizonDirs`.
- **`render_worker.mjs`** gains the `adhoc` and `fullTerrain` request fields and an `align` command.
- **Parity:** photoId-mode parity is unaffected; the cross-check above is within 0.014° median.


## Phase 3: wild set run (100 photos, `tools/bench/data/manifest.json`)

```bash
BENCH_TILE_DIR=$TMPDIR/terrarium HARNESS_HORIZON_CACHE=memory \
  tools/bench/harness/run.sh tools/bench/data/manifest.json --weak-heading --no-overlay --out tools/bench/harness/out/runs/wild
npx tsx tools/bench/harness/verify_pack.ts tools/bench/data/manifest.json tools/bench/harness/out/runs/wild   # blinded pack
node tools/bench/harness/export_results.mjs tools/bench/harness/out/runs/wild      # → tools/bench/results.json (wild:app|cascade|fused)
```

- **`--weak-heading`:** the manifest heading is only a hint. Headings there are coarse compass letters or an uploader's guess.
  - app: 360° seeds plus a seed at the heading;
  - cascade: 360° search with a yaw prior σ of 45°;
  - fused: 360° sweep, heading unused.
  - There is no gravity for any photo, so pitch and roll are free everywhere. The 17 photos with only `focalMm` get a 50° hfov and free focal.
- **Scale knobs:**
  - peaks come from one Overpass bbox query for the whole set (25 417 named peaks, cached);
  - DEM tiles can be cached outside `out/` (`BENCH_TILE_DIR`) and horizons kept in memory (`HARNESS_HORIZON_CACHE=memory`), so `out/` stays under 300 MB.
- **Server change:** 360° (full-terrain) pages drape satellite imagery only within 40 km (`MATCHER_DRAPE_FULL_M`). Draping every tile out to 120 km took ~90 s per cold page. On wc_0001 the result was unchanged (101.83° vs 101.80°), and the time went from 103 s to 17 s.
- **Completion:**
  - app 100/100 and cascade 100/100 (wc_0073 had a transient tile-fetch failure and succeeded on retry);
  - fused 99/100. wc_0029 is a 600 mm telephoto shot (vfov 2.3°), below the service's 5° vfov minimum, which a 40°-spaced sweep couldn't cover anyway. It is recorded as unsupported.
- **Verification pack** (`out/runs/wild/verify/`):
  - Each method's solved pose is clustered (within 0.5° of yaw and pitch) and one overlay is rendered per cluster.
  - Clusters are labelled A/B/C in a seeded random order, with no method or confidence shown. P is the manifest heading with a level camera.
  - `index.json` is for the verifiers; `key.json` (for scoring only) maps the labels to methods, confidences and accept flags.
- **Correctness is deliberately not assessed here;** the verifier agents score it.

### Narrow FOV (tele) follow-up: `runs/wild-narrow`, a known limit

- **Service changes (backward compatible):**
  - `VFOV_MIN` goes from 5° to 1.5° in all modes.
  - Ad-hoc views with hfov < 25° no longer use the 40° sweep in stage 1, since it can't overlap a 3–10° view. Instead each seed gets a 3×3 fan of renders at the photo's own FOV (yaw ±0.8·hfov, pitch ±0.8·vfov). Seeds come from:
    - request `seeds` (the harness's `--fused-seeds` passes app/cascade poses; off by default, to keep fused independent);
    - the heading, or `yawHint` (the weak manifest heading);
    - the app's top 3 skyline hypotheses over 360° yaw × pitch seeds.
  - The best seed wins by RANSAC inliers (≥ 30). All-sky fan views are skipped (`allowEmpty`).
  - Stage-2 offsets scale with the FOV (±0.5·hfov), and narrow pages drape imagery out to 150 km.
- **Result on the three narrowest shots** (wc_0029 600 mm hfov 3.4°; wc_0012 200 mm hfov 10.8°; wc_0030 210 mm hfov 9.8°):
  - All three now complete; before, wc_0029 was a 400 error. Each takes 23–35 s.
  - The **render-match cue does not work at these FOVs.** Every seed lifted 100–400 matches, yet no seed produced a rotation: 0–10 RANSAC inliers, never ≥ 30.
  - The draped imagery and DEM LOD at the distances a tele shot looks at (z ≤ 12 beyond 40 km) are far coarser than the photo's pixel footprint (≈ 2 m/px at 30 km for 600 mm). This can't be fixed from the harness or server without changing `src/lib/terrain.ts` LOD and imagery zoom.
  - The result therefore falls back to the app's skyline cue and is **always LOW**. On wc_0012 the stage-2 match cue agreed with the skyline to 0.8°, but support was 0.15 < 0.3.
- **Known limit:** fused adds nothing beyond the app's skyline for hfov ≲ 10°. Its output there is the app pose, flagged LOW.

### Overlay DEM fix (verify_v2)

- **What was wrong:** v1 overlays (`runs/wild/verify/`) drew the skyline on the Terrarium DEM (AWS, 256 px, z13/11/10) with the app pipeline's eye rule on that DEM. The app and fused solve on Mapterhorn.
- **The fix:**
  - `lib/geo.ts` now uses Mapterhorn only. Levels are z16 ≤ 0.8 km … z10 ≤ 150 km, loaded ring by ring, with a parent-tile fallback on 404. Tiles are cached in `out/cache/mapterhorn`, LRU-trimmed at 1 GB.
  - Every candidate is drawn at the eye its method used: fused and app from `row.eye[2]` (the engine eye, `max(GPS alt, DEM + 1.6)`, else DEM + 1.8).
  - The cascade solved on Terrarium, whose ground differs from Mapterhorn's by up to 114 m here, so its `max(GPS, DEM + 1.6)` rule is re-applied on Mapterhorn. Both values are recorded in `key_v2.json`.
  - Future cascade runs solve on Mapterhorn too.
- **Size of the error:** on near-field photos, v1 vs v2 differ by a median 1.0–1.5 % of image height, up to 26 % on wc_0077.
- **New packs:** `runs/wild/verify_v2/` (same clusters, new labels, `key_v2.json`) and `tools/bench/t5/verify_v2/` (dev ids only).

## Cascade on Mapterhorn (the app pipeline's loader): strip ablation and wild re-run

- **Recipe:** the app pipeline's MAPTERHORN source:
  - `demTileLoaderNode(MAPTERHORN)`, with `MAPTERHORN.levels` (z15 ≤ 1 km … z9 ≤ 150 km) and 512 px tiles;
  - eye from `eyeHeight(GPS alt, terrain.ground())` on that DEM;
  - `solvePose`, then `refinePose` on reject, exactly as `scripts/eval.ts` SOLVER=cascade.
  - Same unknowns and options as before (`tools/bench/harness/cascade.ts`, rows tagged `dem: "mapterhorn-0f"`).
  - Scored against the same frozen pin GT and `data/ground-truth.json`, next to the earlier Terrarium run.
- **Runs:**
  - `tools/bench/harness/out/runs/ablation-cascade-mt/`;
  - wild: `runs/wild-cascade-mt/`, with `inherit.json` and the blinded `verify/` for the 66 poses that match no verify_v2 cluster.
- **Answer: "0 false accepts in every condition" no longer holds on Mapterhorn.** There is **one** false accept, in the heading-removed condition.
  - IMG_7053 was accepted at Δyaw −123.7°, confidence 0.66. Its solvePose 360° search came in above the default 0.5 accept threshold.
  - The harness's configured 360° mode uses solvePose's `acceptConfidence` default (0.5). the app pipeline's own full-search fallback accepts only at `fullSearchConfidence` 0.75, which would have rejected this pose.
  - Raising the harness's 360° threshold to 0.75 is the obvious fix. It is now applied, mirroring the app; see "0.75 yaw-unknown gate" below. The tables in this section are the 0.5 run.
  - Both-removed and gravity-removed have 0 false accepts on Mapterhorn. The default-options cascade has 0 in every condition.
- **Accepts:** with full metadata the cascade accepts 10/11 on Mapterhorn against 8/11 on Terrarium (pin GT), with the same 10/11 within 1°. Within-1° counts otherwise move by −1…+1 photo per condition.
- **Median time:** 0.25 s, 0.51 s, 0.64 s and 2.46 s per photo (full / no gravity / no heading / neither). That is skyline plus solve; loading the DEM and tracing the horizon adds about 5 s per location.

#### Against pin GT (11 photos)

| condition | method | DEM | median \|Δyaw\| | ≤1° yaw | acc | false acc (≥1°) | worst Δyaw |
|---|---|---|---|---|---|---|---|
| full metadata | configured | Terrarium (earlier run) | 0.18 | 10/11 | 8/11 | 0 | 5.2 |
| full metadata | configured | Mapterhorn (app loader) | 0.21 | 10/11 | 10/11 | 0 | -1.4 |
| full metadata | native defaults | Terrarium (earlier run) | 0.18 | 10/11 | 8/11 | 0 | 5.2 |
| full metadata | native defaults | Mapterhorn (app loader) | 0.21 | 10/11 | 10/11 | 0 | -1.4 |
| gravity removed | configured | Terrarium (earlier run) | 0.18 | 10/11 | 9/11 | 0 | 5.3 |
| gravity removed | configured | Mapterhorn (app loader) | 0.09 | 10/11 | 8/11 | 0 | -11.7 |
| gravity removed | native defaults | Terrarium (earlier run) | 0.18 | 10/11 | 9/11 | 0 | 5.0 |
| gravity removed | native defaults | Mapterhorn (app loader) | 0.23 | 10/11 | 8/11 | 0 | 14.6 |
| heading removed (360°) | configured | Terrarium (earlier run) | 0.22 | 9/11 | 8/11 | 0 | 99.7 |
| heading removed (360°) | configured | Mapterhorn (app loader) | 0.29 | 9/11 | 9/11 | 1 | -123.6 |
| heading removed (360°) | native defaults | Terrarium (earlier run) | 0.26 | 8/11 | 5/11 | 0 | -139.5 |
| heading removed (360°) | native defaults | Mapterhorn (app loader) | 0.29 | 7/11 | 5/11 | 0 | -138.5 |
| both removed | configured | Terrarium (earlier run) | 0.46 | 8/11 | 6/11 | 0 | -168.1 |
| both removed | configured | Mapterhorn (app loader) | 0.49 | 7/11 | 6/11 | 0 | 151.9 |
| both removed | native defaults | Terrarium (earlier run) | 56.31 | 3/11 | 3/11 | 0 | -156.6 |
| both removed | native defaults | Mapterhorn (app loader) | 24.45 | 4/11 | 2/11 | 0 | -162.1 |

#### Against data/ground-truth.json (12 photos)

| condition | method | DEM | median \|Δyaw\| | ≤1° yaw | acc | false acc (≥1°) | worst Δyaw |
|---|---|---|---|---|---|---|---|
| full metadata | configured | Terrarium (earlier run) | 0.17 | 11/12 | 9/12 | 0 | 5.5 |
| full metadata | configured | Mapterhorn (app loader) | 0.16 | 11/12 | 11/12 | 0 | -1.2 |
| full metadata | native defaults | Terrarium (earlier run) | 0.17 | 11/12 | 9/12 | 0 | 5.5 |
| full metadata | native defaults | Mapterhorn (app loader) | 0.16 | 11/12 | 11/12 | 0 | -1.2 |
| gravity removed | configured | Terrarium (earlier run) | 0.15 | 11/12 | 10/12 | 0 | 5.5 |
| gravity removed | configured | Mapterhorn (app loader) | 0.10 | 11/12 | 9/12 | 0 | -11.5 |
| gravity removed | native defaults | Terrarium (earlier run) | 0.28 | 11/12 | 9/12 | 0 | 5.3 |
| gravity removed | native defaults | Mapterhorn (app loader) | 0.26 | 11/12 | 8/12 | 0 | 14.8 |
| heading removed (360°) | configured | Terrarium (earlier run) | 0.21 | 10/12 | 9/12 | 0 | 99.6 |
| heading removed (360°) | configured | Mapterhorn (app loader) | 0.28 | 9/12 | 9/12 | 1 | -123.7 |
| heading removed (360°) | native defaults | Terrarium (earlier run) | 0.28 | 8/12 | 5/12 | 0 | 177.4 |
| heading removed (360°) | native defaults | Mapterhorn (app loader) | 0.45 | 7/12 | 5/12 | 0 | -158.8 |
| both removed | configured | Terrarium (earlier run) | 0.32 | 9/12 | 6/12 | 0 | -168.1 |
| both removed | configured | Mapterhorn (app loader) | 0.47 | 8/12 | 6/12 | 0 | 151.9 |
| both removed | native defaults | Terrarium (earlier run) | 38.03 | 4/12 | 3/12 | 0 | -156.6 |
| both removed | native defaults | Mapterhorn (app loader) | 33.73 | 4/12 | 2/12 | 0 | -162.1 |

#### Accepts more than 1° off

- pin GT (11 photos), heading removed (360°), cascade, Mapterhorn (app loader): IMG_7053 Δyaw -123.65° (confidence 0.66)
- data/ground-truth.json (12 photos), heading removed (360°), cascade, Mapterhorn (app loader): IMG_7053 Δyaw -123.68° (confidence 0.66)

- **Wild re-run (100 photos, `--weak-heading`, no gravity):**
  - 100/100 completed; 27 accepted (17 on Terrarium).
  - Median 3.0 s skyline plus solve (p90 8.6 s), plus 5.4 s median for DEM and horizon.
  - 34 poses inherit an existing verify_v2 cluster (within 0.5° yaw and pitch, eye within 2 m).
  - 66 are in the new blinded pack.


### 0.75 yaw-unknown gate (mirrors the app)

- **The gate:** `tools/bench/harness/cascade.ts`'s configured mode now applies the app's gate from `src/lib/integration/unknown-pose.worker.ts` to the **final** result, whichever stage accepted:
  - `accepted = b.accepted && !ambiguous && !(unknown.yaw && b.confidence < 0.75)`;
  - `ambiguous` is the app's unknown-focal check: another accepting focal seed more than 1° of yaw away, or best confidence < 0.75. Focal is known in this ablation, so it never fires here.
  - Rows keep `detail.acceptedRaw` and `detail.gate`.
- **Run:** `tools/bench/harness/out/runs/ablation-cascade-mt-g75/`, Mapterhorn with the app pipeline's loader, compared with the 0.5 run above.
- **Result: false accepts are 0 in every condition, against both GTs.**
  - The cost is recall in the yaw-unknown conditions: accepts go 9 → 5 with no heading and 6 → 3 with neither (pin GT).
  - The runs with a heading are unchanged.
- **Stage breakdown:** all 7 removed accepts came from the **solve** stage (6 correct, within 0.5°, plus the IMG_7053 −123.7° false accept). None came from refine.
  - The two refine accepts in yaw-unknown conditions both scored 1.0, so the refine confidence scale did not cost recall on this set. With only 2 refine accepts that says little either way.
  - The loss comes from solvePose's 360° confidence: correct solves at 0.53–0.71 now sit below the gate next to the one wrong solve at 0.66.

Poses are identical between the two runs (max |Δyaw| 0°); only `accepted` changes.

#### pin GT, 11 photos

| condition | ≤1° yaw | accepted 0.5 → 0.75 | false accepts 0.5 → 0.75 |
|---|---|---|---|
| full metadata | 10/11 | 10 → 10 | 0 → 0 |
| gravity removed | 10/11 | 8 → 8 | 0 → 0 |
| heading removed (360°) | 9/11 | 9 → 5 | 1 → 0 |
| both removed | 7/11 | 6 → 3 | 0 → 0 |

#### data/ground-truth.json, 12 photos

| condition | ≤1° yaw | accepted 0.5 → 0.75 | false accepts 0.5 → 0.75 |
|---|---|---|---|
| full metadata | 11/12 | 11 → 11 | 0 → 0 |
| gravity removed | 11/12 | 9 → 9 | 0 → 0 |
| heading removed (360°) | 9/12 | 9 → 5 | 1 → 0 |
| both removed | 8/12 | 6 → 3 | 0 → 0 |

#### Accepts removed by the 0.75 gate

| photo | condition | stage | confidence | Δyaw vs GT (pin, else json) | correct (<1°) |
|---|---|---|---|---|---|
| IMG_6971 | heading removed (360°) | solve | 0.53 | +0.50 | yes |
| IMG_6971 | both removed | solve | 0.54 | +0.49 | yes |
| IMG_7018 | heading removed (360°) | solve | 0.71 | +0.13 | yes |
| IMG_7018 | both removed | solve | 0.61 | -0.02 | yes |
| IMG_7053 | heading removed (360°) | solve | 0.66 | -123.65 | no |
| IMG_7086 | both removed | solve | 0.55 | +0.07 | yes |
| IMG_7131 | heading removed (360°) | solve | 0.57 | -0.07 | yes |

Lost: solve stage 6 correct + 1 wrong; refine stage 0 correct + 0 wrong. For reference, yaw-unknown accepts at 0.5 by stage: solve 13, refine 2.

Confidences of yaw-unknown accepts at 0.5: [('refine', 1), ('refine', 1), ('solve', 0.53), ('solve', 0.54), ('solve', 0.55), ('solve', 0.57), ('solve', 0.61), ('solve', 0.66), ('solve', 0.71), ('solve', 0.87), ('solve', 0.96), ('solve', 0.99), ('solve', 0.99), ('solve', 1), ('solve', 1)]

### Margin rule for yaw-unknown accepts (evaluated, not adopted)

- **Rule:** accept at confidence ≥ 0.5 only when the best basin beats the best basin more than 20° away by a margin M; otherwise apply the 0.75 gate.
- **Margin:** `solvePose` does not expose its coarse basins (only `ambiguity`, with a runner-up just 2° away), so `tools/bench/harness/margin.ts` re-scores solvePose's coarse cost around the final pose:
  - truncated L1 at 12 px, pitch refit in ±3°, 0.2° yaw grid over 360°, on the app pipeline's Mapterhorn horizon;
  - margin = (alt20 − best) / (median − best).
- **Choosing M, on GT-12 only** (Mapterhorn strip ablation, no heading and neither):
  - In the 0.5–0.75 band, the one wrong raw accept (IMG_7053 no heading, Δyaw −123.7°) has the **highest** margin, 0.598.
  - The six correct band accepts sit at 0.29–0.49.
  - M = 0.62 is the smallest round value that keeps GT-12 at 0 false accepts, and it recovers none of the six. **On GT-12 the margin does not separate right from wrong:** the wrong 360° basin at IMG_7053 is a genuinely distinctive skyline match.
  - Pre-registered in `tools/bench/harness/out/margin_rule.txt` (sha1 `5030439da0274c68a1e6e6473d90f11150a00ab1`) before any dev outcome was read.
- **Dev evaluation** (dev ids only, wild-cascade-mt rows; verdicts inherited from `tools/bench/t6/dev_verdicts.json` clusters within 0.5°/0.5°/2 m):
  - All 10 dev raw accepts have confidence ≥ 0.75, so the band the rule acts on is empty on dev.
  - The 0.5 rule, the 0.75 gate and the margin rule give identical results: 10 accepted, 7 correct, 0 wrong, 3 without a verdict.
  - Accepts recovered versus the 0.75 gate: 0. Within-1° can't be measured on dev (no GT angles, only verdicts).
  - Of the 50 dev cascade-mt poses, 11 inherit a verdict and 39 are uncounted.
- **Conclusion:** no evidence for the margin rule. It recovers nothing on either set, and on GT-12 it would have to sit above the wrong accept's margin to stay safe. Keep the 0.75 gate.

| dev photo (raw accept) | confidence | margin | 0.75 gate | margin rule (M=0.62) | verdict |
|---|---|---|---|---|---|
| wc_0004 | 0.88 | 0.603 | acc | acc | – (no matching cluster) |
| wc_0011 | 0.82 | 0.648 | acc | acc | – (no matching cluster) |
| wc_0020 | 0.83 | 0.521 | acc | acc | correct |
| wc_0027 | 0.95 | 0.478 | acc | acc | correct |
| wc_0047 | 1 | 0.727 | acc | acc | correct |
| wc_0052 | 1 | 0.629 | acc | acc | – (no matching cluster) |
| wc_0054 | 0.95 | 0.269 | acc | acc | correct |
| wc_0076 | 0.89 | 0.285 | acc | acc | correct |
| wc_0082 | 0.95 | 0.645 | acc | acc | correct |
| wc_0088 | 1 | 0.772 | acc | acc | correct |

| rule | accepted | correct | wrong (false accepts) | unsure | no verdict (uncounted) |
|---|---|---|---|---|---|
| 0.5 (raw) | 10 | 7 | 0 | 0 | 3 |
| 0.75 gate | 10 | 7 | 0 | 0 | 3 |
| margin rule M=0.62 | 10 | 7 | 0 | 0 | 3 |

Dev cascade-mt rows: 50; with an inherited verdict: 11; without (uncounted): 39.

- **the app pipeline's `solvePose({headingKnown: false})`** (0.75 bar applied inside solvePose; harness gate now a no-op flag, `HARNESS_UNKNOWN_GATE=1`, default off): re-run in `tools/bench/harness/out/runs/ablation-cascade-mt-hk/`.
  - **Matches g75 on safety:** 0 false accepts in every condition against both GTs.
  - **Accepts (pin GT):** 10 / 8 / **7** / 3, against g75's 10 / 8 / 5 / 3.
  - **Why the change:** sub-0.75 360° solves now *reject inside* solvePose, so the cascade escalates them to refinePose. Before, they were accepted at 0.5 and gated after.
    - Refine rescues IMG_6971 and IMG_7131 with no heading, both correct (Δyaw +0.24° and −0.04°, confidence 0.84 and 1.0).
  - **Cost:** when nothing is known, the *returned* pose is refine's (rejected) pose instead of the rejected but right solve pose. Within-1° of the returned pose with neither heading nor gravity drops 7/11 → 4/11 (GT json 8/12 → 5/12). Accept counts and false accepts are unaffected.
- **Cascade `chain` as in scripts/eval.ts:**
  - The harness now returns the first accepted stage, else the first (solvePose) result, and each row lists `detail.candidates` (`{method, pose, confidence, accepted}` per stage).
  - Re-run in `tools/bench/harness/out/runs/ablation-cascade-mt-chain/`.
  - **Accept flags are identical to the headingKnown run:** accepts 10 / 8 / 7 / 3 and 0 false accepts in every condition, against both GTs.
  - **Within-1° of the returned pose recovers** with both removed: 4/11 → **8/11** pin GT (GT json 5/12 → 8/12), past the 7/11 of g75. With no heading only: 9/11 (GT json 10/12).
