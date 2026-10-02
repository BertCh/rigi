# Core georeferencing baseline (`src/lib/geo`)

The simple, CPU-only pipeline for placing a geotagged iPhone mountain photo against a DEM. It follows the "automatic path" in `reports/Mountain photo georeferencing SoTA.md`. GPS is held fixed, and yaw, pitch, roll and focal length are solved. Everything here is browser-safe TypeScript with no dependencies beyond `exifr`.

```
photo ─► readPhotoMeta ─► cameraFromMeta (prior: gravity → pitch/roll, compass → yaw, 35 mm → f)
                                  │
GPS ─► loadTerrain (Terrarium) ─► computeHorizon (360° skyline + ridge crests, curvature + refraction)
                                  │
pixels ─► detectSkyline ─────────► solvePose (coarse yaw/pitch grid → Cauchy LM → confidence gate
                                  │           → full-360° retry if rejected)
                                  ▼
                    accepted? solved camera : escalate → refinePose (src/lib/refine, d1)
                                  │
                    accepted? refined camera : prior + manual (drag / tap peaks → solveFromControlPoints)
                                  │
OSM peaks ─► viewPeaks ─► layoutPeakLabels
```

| Module | What it does |
|---|---|
| `photo-meta.ts` | EXIF via exifr, plus a small Apple MakerNote parser for the gravity vector (tag 0x0008) |
| `camera.ts` | Pinhole camera in the display frame, ENU world. Handles gravity → camera, `cameraFromAngles`, `project`/`unproject` |
| `terrain.ts` | `loadTerrain` + `TerrainSampler`: DEM tiles at several zoom levels (Terrarium default: z13 ≤4 km, z11 ≤40 km, z10 ≤150 km), bilinear sampling. `tileSize` is a parameter. Tile math, sources and decoding live in `src/lib/dem` (the `/baseline` worker loads tiles with its `fetchDemTile`) |
| `horizon.ts` | Ray-marches 7,200 azimuths and returns the skyline elevation angle plus visible ridge crests (~3.5 s, so run it in a Worker) |
| `skyline.ts` | Photo skyline: sky colour model plus a Viterbi boundary per column with weights (~120 ms at 800 px) |
| `lm.ts` | Small Levenberg–Marquardt with Huber or Cauchy loss and Gaussian priors that stay quadratic |
| `solve.ts` | `solvePose` and `projectSkylineRows`. Pitch/roll outside ±3° of gravity are rejected ("tilt") |
| `peaks.ts` | OSM `natural=peak` query/parse, visibility against the DEM, label layout |
| `control-points.ts` | Tap-the-peaks solver: 1 point → yaw+pitch, 2 → +roll, ≥3 → +f |
| `pipeline.ts` | Core shared by the `/baseline` and unknown-pose workers: DEM → terrain → eye → 360° horizon, and the solvePose → refinePose cascade |

## Commands

```bash
npm run baseline              # prior-only overlays      → out/baseline/
npm run baseline:eval         # full auto pipeline vs GT → out/eval/report.{md,json}, overlays
npm run baseline:synth        # solver recovery on synthetic skylines (BIG_YAW=1 for 40–120° compass errors)
npx tsx scripts/baseline-skyline.ts   # detected photo skylines → out/skyline/
npx tsx scripts/baseline-peaks.ts     # peak labels at the ground-truth pose → out/peaks/
npx tsx scripts/annotate.ts IMG_xxxx  # ground-truth annotation tool (see data/)
EYE=max|gps|ground npm run baseline:eval   # eye-height rule experiments
```

The UI is at `/baseline` (`src/routes/baseline.tsx`, `src/baseline-ui/`), with 13 samples in `public/baseline/` (regenerate with `scripts/export-baseline-samples.ts`).

## Accuracy (2026-09-24, 12 hand-registered photos in `data/ground-truth.json`)

**Recommended pipeline: `detectSkyline` → `solvePose` → on reject, `refinePose` (the cascade).** This is what `/baseline` Auto-align runs (for a photo without a compass, gravity or focal length, with the unknown-pose options and the 0.75 bar: `src/baseline-ui/align-options.ts`). Reproduce it with `SOLVER=cascade npm run baseline:eval`.

| Variant (`SKY=… SOLVER=… npm run baseline:eval`) | accepted | false accepts | worst accepted yaw | median final yaw / skyline | skyline ≤10 px |
|---|---|---|---|---|---|
| Sensor prior only | – | – | – | 4.0° / 45.2 px | 2/12 |
| classic + solve (simple core) | 8/12 | 0 | 0.47° | 0.27° / 6.7 px | 9/12 |
| **classic + cascade (recommended)** | **11/12** | **0** | **0.47°** | **0.22° / 5.0 px** | **11/12** |
| classic + refine | 9/12 | 0 | 0.38° | 0.22° / 7.0 px | 9/12 |
| ONNX sky model + solve | 9/12 | **1** (7053, 5.6°) | 5.61° | 0.18° / 5.9 px | 9/12 |
| ONNX sky model + refine | 8/12 | 0 | 0.35° | 0.30° / 7.0 px | 7/12 |
| classic + cascade2 (solve → refine with sky cross-check → refine) | 11/12 | 0 | 0.47° | 0.22° / 5.0 px | 10/12 |
| classic + skyfirst (refine with sky cross-check, else cascade) | 11/12 | 0 | **0.29°** | **0.13°** / 5.1 px | 10/12 |
| classic + cascade, `HORIZON=fast` | 10/12 | 0 | 0.47° | 0.20° / 5.0 px | 11/12 |
| ONNX sky Viterbi (`SKY=dp`) + solve | 8/12 | 0 | 0.29° | 0.18° / 6.0 px | 9/12 |
| ONNX sky Viterbi (`SKY=dp`) + cascade | 10/12 | 0 | 0.35° | 0.15° / 7.0 px | 9/12 |

- **How precise the ground truth is:** "approx" entries are good to about 0.2–0.4° in yaw. Two independent fits disagree by 0.38° on 6958 and 0.33° on 7155. So differences between variants **below ~0.3° median (e.g. cascade 0.22° vs skyfirst 0.13°) are within ground-truth noise**. Accept counts, false accepts and errors of several degrees are robust. Control points that aren't OSM peaks (DEM notches with `az`/`el`, lake waterlines as elevation-only "levels", and duplicate-named peaks as `node/<id>`) are deliberate, not unresolved.
- With the cascade, the simple solver handles 8 photos alone (~0.5 s), and refine (~3 s) runs only on its rejects: 7063, 7068 and 7155. It rescues all three, and all are within 0.4°.
- Only IMG_7059 is still unsolved: an ultra-wide shot of a near ridge where the eye position itself is off. Every method fails on it.
- Don't pair the ONNX sky model's argmax skyline with `solvePose`: it produced a false accept (7053). The Viterbi version (`SKY=dp`, `skylineFromSkyDP`) removes it and is the safe way to use the sky model, but it doesn't beat the classic cascade on accepts or on ≤10 px.
- **High-accuracy mode:** `skyfirst` roughly halves the median yaw error (0.13° vs 0.22°) and cuts the worst accepted error to 0.29°. The cost is always running the 4.5 MB ONNX model plus refine (~4 s per photo). Use it when the sky model is already loaded; the cascade stays the lean default.
- **Horizon:** `/baseline` uses d1's `src/lib/horizon-fast` drop-in (0.3 s in the browser vs 5–8 s), falling back to `computeHorizon`. Accuracy is the same in eval. The one difference is that refine declines IMG_7063, whose prior is already good (5.7 px).
- IMG_7108 (shot from a boat) has no ground truth. solvePose accepts it at yaw 62.46°. An independent skyline plus render-match fusion (tools/matcher, f0) gives 62.79°, so the two agree to 0.33°, which points to OK GPS and a compass thrown ~13.5° off by the steel hull. That is strong but not independent evidence; a ground-truth entry needs hand-picked control points.
- Synthetic test: yaw ≤0.13° and pitch/roll ≤0.26° with ±10° compass error, 20% occluders and noise. With 40–120° compass error the full-360° fallback recovers 11/13.

## Elevation source: Terrarium (default) vs Mapterhorn

`src/lib/dem` exports the `DemSource`s: `TERRARIUM_AWS` (256 px PNG, default) and `MAPTERHORN` (512 px WebP, swissALTI3D in Switzerland, user-approved). Select with `DEM=mapterhorn npm run baseline:eval`. Eye height always comes from the same source; missing high-zoom tiles fall back to coarser levels.

| `DEM=` + cascade | accepted | over 1°/15 px | median final yaw | ≤10 px |
|---|---|---|---|---|
| terrarium | 11/12 | 0 | 0.22° | 11/12 |
| mapterhorn | 11/12 | 1 (7130: 1.05°, 20 px) | 0.15° | 10/12 |

Mapterhorn is right about the ground: at IMG_7059, Terrarium is 80 m low (1,863 m against 1,945 m; GPS reads 1,933 m). With it, the simple solver alone fixes 7155 (5.8° → 0.12°) and 7068 (→ 0.12°). The only regressions are 7130 and 6958, whose ground truth was fitted partly (7130: entirely) on terrain notches read from Terrarium. **So the default stays Terrarium until the ground truth is re-annotated on Mapterhorn.** Until then the comparison is biased toward Terrarium. After re-annotation, switch the default (eval, and the `/baseline` worker, which loads Terrarium AWS tiles with `fetchDemTile(TERRARIUM_AWS, key)`).

## Known limitations

- **DEM:** Terrarium is 40–85 m low on the Niederhorn cliffs and smooths near summits. That's the main error on ridge-top photos. Mapterhorn (swissALTI3D in Switzerland) is wired in (see above) and is what the app and matcher solve on; the eval default waits on the ground-truth re-annotation (roadmap N5).
- **Eye height:** `max(GPS alt, ground+1.6 m)` (`eye-rule.ts`, shared by the engines, workers, roll and near field). Without an altitude the engines use ground + 1.8 m and `loadScene` ground + 1.6 m (open decision, `reports/steps-2026-10-02/eye-rule.md`). Neither fixed rule wins; `refinePose` (`src/lib/refine/`) fits an eye-height offset only where the near/far parallax makes it observable (`eyeFitted`, `eyeSensitivityPx`).
- **Focal length:** EXIF 26 mm (iPhone 11 Pro) reads about 2% short. The solver absorbs this within its ±8% f clamp.
- **No compass heading:** pass `solvePose(..., { headingKnown: false })` (or any `yawRange` ≥ 90°). It goes straight to the full-360° search with the stricter 0.75 bar. In the wild benchmark, a 360° first pass at 0.5 falsely accepted IMG_7053 at −123.7°. Synthetic test (`BIG_YAW=1 NO_HEADING=1 npm run baseline:synth`): 10/13 accepted, all correct.
- **Wild benchmark (f0, 100 Commons photos, Mapterhorn, blind-verified):** the cascade gets 25 correct (14 on Terrarium). At the 0.75 bar it makes 22 accepts, all correct.
- **Confidence thresholds** (0.5 local, 0.75 full-360°) are tuned on only 12 photos. On a synthetic ultra-wide shot with a 100° compass error, the local search falsely accepted at 0.57.
- **Occluders:** people and trees above the ridge read as skyline, and the Cauchy loss handles most of them.
