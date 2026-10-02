# Fusion: joint skyline + render-match solve

*2026-09-25 · code in `tools/matcher/fusion.py` (library + CLI) · raw results in `tools/matcher/out/results/fusion_*.json` · per-photo tables in `tools/matcher/out/fusion_tables.md`*

## Verdict

- **On the frozen pin GT (the scoring set I was asked to use), fusion does not clearly beat both single cues.**
  - At the true compass, fused median |Δyaw| is 0.15°. That ties render-match (0.14°) and halves skyline (0.30°).
  - Fused pitch (0.12°) is worse than render-match (0.07°).
  - Fused median pin error is 7.0 px against skyline's 7.9 and render-match's 10.5. The match-only LM gets 6.8 px.
  - The differences between the two best methods are below what 2–3 pins can resolve.
- **It is the only method that never fails.** Across 33 cases (11 photos × {true compass, +15°, −15°}):
  - fused is within 1° of yaw in **33/33**, and its worst |Δyaw| is 0.66°;
  - render-match: 32/33 (one case with no matches);
  - skyline: 30/33 (misses of 3.6°, 14.6° and 15.4°);
  - prior: 3/33.
- **On the independent `data/ground-truth.json`** (12 photos, solved from all labelled points; snapshot in `tools/matcher/out/ground-truth.snapshot.json`), fused has the best median |Δyaw| in all three scenarios: **0.075° / 0.136° / 0.172°** against the next best at 0.201° / 0.218° / 0.192°. Its only miss is IMG_7130 at 1.9°, and the confidence rule flags that one LOW. I didn't tune anything on this GT; it's a secondary check.
- **Confidence:** on the pin set, every HIGH (23/23) is within 1°. The 10 LOWs are all over-cautious, but none hides a failure, because the fused pose didn't fail on this set.
- **Synthetic wrong GPS:** I moved the camera 1 km or 3 km sideways in 10 variants across 5 photos. **All 10 are flagged LOW.** In one case (IMG_7131, 1 km) both cues *agree* on a pose that is 9.4° wrong, and only the per-term residuals catch it.
- **IMG_7108 is not flagged, and I don't think it should be.** The premise that its GPS is wrong doesn't hold up. The DEM horizon rendered from the EXIF GPS fix lies exactly on the photographed Niederhorn skyline at the fused pose (figure below). The two cues agree to 0.40°, with a skyline residual of 0.8 px and 66 % match support. What's broken on 7108 is the **compass**, which is off by 13.7° (steel hull); the position looks fine. With 0 control points for this photo, I can't prove it's right, but I'm not willing to fake a LOW.

![IMG_7108](../tools/matcher/out/viz/IMG_7108_fused_horizon.jpg)
`tools/matcher/out/viz/IMG_7108_fused_horizon.jpg`: DEM horizon from the EXIF GPS at the compass prior (red) and at the fused pose (yellow). Cyan dots are the lifted satellite-render matches.

## Method

Parameters are yaw, pitch, roll and log focal length. The camera centre is fixed at the app's eye (GPS, snapped to DEM + 1.5–1.8 m). All residuals are in pixels of the 1024-px render/photo grid.

- **(a) Skyline term.** It reproduces the app's objective (`src/lib/align.ts`, read-only).
  - Inputs come from `window.__engine`: `horizonDirs` (DEM horizon ENU directions), and `edge.fine`, `edge.fg` and `edge.sky` (P(sky) after `autoAlign` refits the colour model from the prior; with ±15° this is refit from the *shifted* prior).
  - The per-pixel score is exactly `scorePose`'s integrand: 0.5·edge + (mean P(sky) in the band above − mean P(sky) in the band below), with the same band and gap sizes.
  - For each of the 512 edge-map columns, the rendered skyline row is the topmost crossing of the projected horizon polyline, which makes it a function of the pose. It is associated (ICP-style) with the score's peak row within ±24/12/6/6 rows over four outer iterations. Columns with max score < 0.15, or under the people mask, are skipped.
  - Residual = rendered row − associated row.
  - A first version used per-direction vertical residuals. That left yaw unconstrained, and the skyline-only solve drifted by tens of degrees. The per-column formulation fixed it.
- **(b) Match term.** ALIKED + LightGlue matches between the photo and 5 satellite-draped renders at prior yaw + {−20, −10, 0, +10, +20}° (3 renders for the ±15° cases), lifted through each render's XYZ buffer.
  - Residual = 2-D reprojection error.
  - Matches are gated per outer iteration at |r| < 30/15/8/8 px.
- **Robust loss and weighting.** Documented, not tuned:
  - Huber loss (k = 1.345) on r/σ_t, using IRLS inside scipy's LM.
  - σ_t is the robust scale (1.4826·MAD) of term t's residuals at its **own single-cue solution**. Median σ_sky is 1.8 px and median σ_match is 2.1 px.
  - The σ values are then *fixed* for the joint solve, so costs from different starts are comparable.
  - Each term is divided by √N_t, so both terms carry equal total weight whatever their counts: ~500 skyline columns against ~1000–5000 matches.
  - Relative weight λ = 1, plus a weak EXIF focal prior (σ = 5 % in log f).
  - Cost = mean_sky ρ(r/σ_sky) + λ·mean_match ρ(r/σ_match) + focal prior.
- **Starts and selection.**
  - The joint solve is started from both single-cue solutions:
    - skyline: the app's `autoAlign` pose. At the true compass this is the pose `eval-app.mjs` scores. At ±15° it is re-run in-page from the shifted prior with the app's acceptance rule.
    - match: 2-point RANSAC, then the match-only LM.
  - I keep the one with the lower **fixed-σ truncated** cost, min(r²/σ², 9), averaged over *all* in-view horizon columns and *all* lifted matches, so a pose that explains fewer items can't look cheaper.
  - An earlier version compared the adaptive-σ LM costs. That picked badly wrong poses in two stress cases (7053 −15°, 7086 −15°), which is why selection now uses this fixed-σ cost.
- **Confidence.** The rule was fixed before looking at fused results and not changed after:
  - `d_agree` = rotation angle between the skyline-only and match-only solutions;
  - `sky_med` = median |skyline residual| at the fused pose;
  - `match_support` = share of all lifted matches within 6 px at the fused pose;
  - **HIGH iff d_agree < 1° and sky_med < 4 px and match_support ≥ 0.3**, otherwise LOW.
  - The continuous confidence written to the leaderboard file is exp(−d_agree/1°)·exp(−sky_med/4 px)·min(1, support/0.3). It is a monotone summary of the same three quantities. The inlier count is not used.
- **Weight tuning.** None; λ = 1 was the only value used for the headline. The sensitivity check below was run on the scoring set afterwards and is reported, not selected from. λ = 4 looks marginally better on pin px and λ = 0.25 slightly worse, but I did **not** switch to λ = 4, because that would be tuning on the test set.

## Results: true compass (shift 0°)

Cells are Δyaw / Δpitch / Δroll in degrees, then mean pin px on 1600 px width. GT = pins solved from the prior, from the frozen `tools/matcher/out/control-points.snapshot.json`. "render-match" is the plain RANSAC matcher from `reports/matcher.md`.

| photo | prior | skyline (app) | render-match | fused | d_agree ° | sky med px | match support | conf |
|---|---|---|---|---|---|---|---|---|
| IMG_6958 | +2.97 / +0.64 / −3.47 · 97.4 | −0.03 / +0.13 / −3.15 · 24.4 | −0.05 / +0.02 / −2.82 · 21.7 | −0.03 / +0.12 / −2.98 · 22.7 | 0.26 | 2.5 | 0.82 | HIGH |
| IMG_6971 | −9.10 / −0.22 / −0.99 · 252.4 | −0.01 / +0.28 / −0.17 · 3.1 | +0.41 / +0.27 / −0.32 · 15.4 | +0.03 / +0.28 / −0.12 · 4.2 | 0.41 | 1.1 | 0.90 | HIGH |
| IMG_7018 | +8.30 / +2.05 / −0.22 · 208.5 | −0.30 / +0.30 / +0.08 · 9.1 | −0.36 / +0.06 / +0.00 · 9.6 | −0.24 / +0.16 / +0.09 · 7.0 | 0.23 | 0.8 | 0.56 | HIGH |
| IMG_7033 | +0.69 / +1.62 / −1.10 · 57.7 | +0.22 / +0.05 / −0.20 · 5.8 | −0.02 / −0.22 / +0.04 · 12.6 | +0.15 / −0.05 / −0.20 · 5.6 | 0.27 | 0.7 | 0.90 | HIGH |
| IMG_7053 | −4.75 / +0.61 / −3.55 · 123.6 | +0.37 / +0.37 / −1.00 · 7.9 | +0.05 / +0.07 / −0.26 · 6.7 | +0.00 / +0.13 / −0.45 · 7.4 | 0.89 | 2.1 | 0.74 | HIGH |
| **IMG_7059** | +0.36 / −0.15 / +1.16 · 9.8 | −0.62 / −0.05 / +0.76 · 11.9 | +0.76 / −0.01 / +1.15 · 11.2 | −0.29 / +0.12 / +0.96 · 14.9 | 0.48 | 6.2 | 0.88 | LOW |
| **IMG_7063** | −1.14 / −0.01 / +1.23 · 27.4 | −0.59 / +0.26 / −0.54 · 10.1 | −0.38 / +0.29 / −0.09 · 10.5 | −0.66 / +0.23 / −0.48 · 11.6 | 0.49 | 0.9 | 0.91 | HIGH |
| **IMG_7068** | +1.50 / +2.43 / −0.71 · 77.9 | −0.25 / +0.09 / +0.34 · 4.1 | −0.14 / −0.05 / +0.35 · 2.6 | −0.20 / +0.02 / +0.27 · 3.8 | 0.14 | 1.2 | 0.95 | HIGH |
| IMG_7086 | −0.38 / +0.33 / −0.27 · 19.5 | −0.38 / +0.33 / −0.27 · 19.5 (skyline rejected) | +0.10 / −0.06 / +0.09 · 10.7 | +0.05 / −0.04 / +0.04 · 3.2 | 0.70 | 11.5 | 0.85 | LOW |
| IMG_7108 | no GT | no GT | yaw 62.99 | yaw 62.79 (prior 49.11) | 0.40 | 0.8 | 0.66 | HIGH |
| IMG_7130 | 1 pin | 1 pin | yaw 177.72 | – | 3.12 | 4.6 | 0.48 | LOW |
| IMG_7131 | +10.09 / +0.75 / −1.04 · 224.3 | +0.02 / −0.37 / −0.24 · 6.9 | −0.17 / −0.41 / −0.22 · 7.0 | −0.08 / −0.36 / −0.25 · 7.7 | 0.13 | 0.9 | 0.96 | HIGH |
| **IMG_7155** | −10.61 / +0.60 / +2.87 · 224.2 | −0.36 / +0.09 / +0.40 · 1.7 | −0.14 / −0.11 / +0.41 · 1.5 | −0.29 / +0.05 / +0.30 · 1.7 | 0.18 | 0.7 | 0.91 | HIGH |

## Medians over the 11 scorable photos (pin GT)

| scenario | method | median abs Δyaw | median abs Δpitch | median abs Δroll | median pin px | within 1° yaw | worst abs Δyaw |
|---|---|---|---|---|---|---|---|
| true compass | prior | 2.97 | 0.61 | 1.10 | 97.4 | 3/11 | 10.61 |
| | skyline (app) | 0.30 | 0.26 | 0.34 | 7.9 | 11/11 | 0.62 |
| | render-match | **0.14** | **0.07** | **0.26** | 10.5 | 11/11 | 0.76 |
| | match-only LM | 0.21 | 0.09 | 0.27 | **6.8** | 11/11 | 0.61 |
| | **fused** | 0.15 | 0.12 | 0.27 | 7.0 | 11/11 | 0.66 |
| prior yaw +15° | prior | 15.36 | 0.61 | 1.10 | 383.4 | 0/11 | 25.09 |
| | skyline (app) | 0.25 | 0.21 | 0.34 | 7.9 | 10/11 | **14.62** |
| | render-match | 0.18 | **0.08** | 0.31 | 10.2 | 11/11 | 0.67 |
| | match-only LM | 0.21 | 0.07 | 0.31 | 7.8 | 11/11 | 0.61 |
| | **fused** | **0.14** | 0.12 | **0.30** | **6.4** | 11/11 | 0.66 |
| prior yaw −15° | prior | 14.64 | 0.61 | 1.10 | 400.2 | 0/11 | 25.61 |
| | skyline (app) | 0.35 | 0.19 | 0.34 | 9.1 | 9/11 | **15.38** |
| | render-match | **0.14** (10 solved) | **0.09** | 0.30 | 9.2 | 10/11 | 0.80 |
| | match-only LM | 0.12 (10 solved) | 0.09 | 0.30 | 7.7 | 10/11 | 0.60 |
| | **fused** | 0.16 | 0.12 | **0.29** | **6.9** | **11/11** | 0.66 |

The per-photo tables for the ±15° cases are in `tools/matcher/out/fusion_tables.md`. The fusion wins in the stress cases where one cue collapses:

| case | skyline (app) | render-match | fused |
|---|---|---|---|
| IMG_7086 ±15° | +14.6 / −15.4 (conf 0.00 / 0.02, fell back to the prior) | – | +0.02 / +0.18 |
| IMG_7053 −15° | −3.63 | – | −0.04 |
| IMG_6971 −15° | – | 0 matches | +0.05 (pin 4.7 px) |

## Secondary check against `data/ground-truth.json` (angles only)

This GT covers 12 photos, is solved from all labelled points, and is the leaderboard's primary GT. It was not used for anything else. Output is in `tools/matcher/out/gtjson_check.txt`.

| scenario | prior | skyline | render-match | fused |
|---|---|---|---|---|
| 0°: median abs Δyaw / within 1° | 3.31 / 4/12 | 0.33 / 11/12 | 0.20 / 10/12 | **0.075 / 11/12** |
| +15° | 15.12 / 0/12 | 0.25 / 10/12 | 0.22 / 11/12 | **0.136 / 11/12** |
| −15° | 14.89 / 0/12 | 0.34 / 9/12 | 0.19 / 9/12 | **0.172 / 11/12** |

- Fused's only miss is IMG_7130 at 1.8–1.95° in all three scenarios, and it is LOW in all three.
- IMG_7130 is also the worst photo for skyline and render-match.
- Fused median |Δroll| (0.21–0.27°) is the best in every scenario.
- Fused median |Δpitch| (0.19° / 0.165°) is the best at 0° and +15°. At −15°, render-match is slightly better on pitch (0.181° against 0.195°).

## Confidence

**Pin set, all 3 scenarios (33 scored cases):**

| | fused within 1° | fused off by ≥ 1° |
|---|---|---|
| HIGH | 23 | 0 |
| LOW | 10 | 0 |

- None of the LOWs is a fused failure.
- What they flag:
  - a failed or rejected skyline: 7086 at all shifts, 7053 −15°;
  - no matches: 6971 −15°;
  - weak match support: 7018 +15°, 9 %;
  - d_agree just over 1°: 6958 +15°;
  - the skyline residual on 7059 (6 px). That's the ridge-top photo whose near crest hides the valley; see `reports/matcher.md` (removed; `git show 384df44:reports/matcher.md`).

**Synthetic wrong GPS:**
- Setup: the eye is moved 1 km or 3 km to the right of the prior heading, in memory, via `gps_offset.mjs`, then snapped to DEM + 1.8 m, with the horizon recomputed. Everything is re-rendered and re-matched from the wrong position.
- **10/10 flagged LOW** (`out/results/fusion_gps.json`):

| variant | d_agree | sky med px | match support | fused Δyaw vs true GT | conf |
|---|---|---|---|---|---|
| 7155 @1 km / @3 km | – (≤ 7 matches) | – | – | skyline alone −12.0 / −7.1 | LOW / LOW |
| 7063 @1 km / @3 km | – | 5.9 / 6.1 | – / 0.00 | −2.38 / −0.10 | LOW / LOW |
| 7068 @1 km / @3 km | – | 7.5 / 2.4 | 0.00 / 0.00 | +37.5 / +9.3 | LOW / LOW |
| 7059 @1 km / @3 km | – | 5.9 / 8.3 | 0.00 / 0.00 | −2.86 / +0.24 | LOW / LOW |
| **7131 @1 km** | **0.70 (agree!)** | **5.5** | **0.24** | **−9.36** | **LOW** |
| 7131 @3 km | – | 8.3 | 0.00 | +17.2 | LOW |

- IMG_7131 at 1 km is the instructive case. Skyline and matches agree to 0.7° on a pose 9.4° wrong, so agreement alone would pass it. What exposes it is the per-term fit at the fused pose: a skyline residual of 5.5 px against < 1 px when the GPS is right, and 24 % match support against 96 %.
- For the other variants, the camera ends up below a ridge or in a valley and the renders barely overlap the photo, so the rule fails safe.

**IMG_7108 (real photo, suspected stale GPS):**
- HIGH at 0° and +15°: d_agree 0.40° / 0.51°, sky med 0.8 px, support 0.66 / 0.68.
- LOW at −15°: d_agree 1.06°.
- The fused yaw is 62.79–62.90° in all three scenarios, against a compass of 49.1°.
- The overlay shows the DEM horizon from the EXIF GPS fits the photographed ridge along its whole length.
- I'm reporting this as a **disagreement with the premise**, not as a failure of the confidence rule. If someone has independent evidence of where the boat was, it's cheap to check: add the variant to `gps_offset.mjs`.

## Weight sensitivity (run on the scoring set after the fact; reported, not used to choose)

Medians over 11 photos: |Δyaw|, |Δpitch|, pin px, within 1°.

| λ | true compass | +15° | −15° |
|---|---|---|---|
| 0.25 | 0.15°, 0.12°, 7.3 px, 11/11 | 0.14°, 0.10°, 6.7 px, 11/11 | 0.20°, 0.17°, 7.2 px, **10/11** (7086: 15.2°, flagged LOW) |
| **1 (used)** | 0.15°, 0.12°, 7.0 px, 11/11 | 0.14°, 0.12°, 6.4 px, 11/11 | 0.16°, 0.12°, 6.9 px, 11/11 |
| 4 | 0.14°, 0.12°, 6.1 px, 11/11 | 0.13°, 0.10°, 6.0 px, **10/11** (7059: 1.06°, flagged LOW) | 0.17°, 0.14°, 6.6 px, 11/11 |

The result is flat across a 16× range of λ. No setting beats λ = 1 on robustness.

## Runtime

- Fusion itself (skyline-only LM, match RANSAC + LM, and two joint solves) takes a median of **2.5 s** per photo per scenario, 4.6 s at most, on the CPU with numeric Jacobians. The dominant cost is the horizon-polyline crossing test.
- It needs, on top:
  - the render-match inputs: 5 renders plus matching, ~10–30 s on the M3 Pro GPU (MPS), see `reports/matcher.md` (removed; `git show 384df44:reports/matcher.md`);
  - the app's skyline evidence, which the app computes anyway at load.

## Leaderboard files

Both are in the format documented at the top of `scripts/leaderboard.mjs`.

- `tools/matcher/results.json`: method `render-match`.
  - Poses: the plain matcher (aliked:sat, rot_fixf, initial stage) for all 13 photos.
  - `ms`: matching + solve time.
  - `confidence`: inlier share × min(1, inliers/200). There's no second cue.
  - `accepted`: ≥ 100 inliers and ≥ 50 % share.
- `tools/matcher/results-fusion.json`: method `fusion`.
  - Poses: the fused pose at the true compass for all 13 photos.
  - `confidence`: agreement-based, as above.
  - `accepted`: the HIGH rule.
  - `ms`: matching time + fusion time.
- Validation: `node scripts/leaderboard.mjs --only matcher --no-carry --out <scratch dir>` (read-only, written to a scratch directory) picks up both files, as `matcher:render-match` (13) and `matcher:fusion` (13).
- **Name collision:** the leaderboard also parses `tools/matcher/out/results/<id>_initial.json` into a method with the same `matcher:render-match` key, and that one shows 0 accepted. Whoever owns the leaderboard may want to dedupe.
- In that run, `matcher:fusion` scored median |yaw| 0.075°, 11/12 within 1° and 9 accepted, with no false accepts, against `ground-truth.json`.

## Reproduce

> **Update (2026-10-01):** only `fusion.py`, `match.py`, `results.json` and `results-fusion.json` of the scripts below are in the repository; `export_skyline.mjs`, `render.mjs`, `fusion_prep.sh`, `fusion_report.py`, `gtjson_check.py`, `write_leaderboard.py`, `gps_offset.mjs` and `collect_corr.py` were never committed. They also drove the three.js PhotoEngine, removed 583e2b7. The live equivalent is the matcher service's `render_worker.mjs` + `server/fuse.py` ([archive/matcher-service.md](archive/matcher-service.md)).

```bash
# prerequisites: tools/matcher/.venv and weights as in reports/matcher.md (removed; `git show 384df44:reports/matcher.md`); dev server on :3100; ≥ 3 GB free
node tools/matcher/export_skyline.mjs                  # app skyline evidence + autoAlign at shifts 0/±15 → out/skyline/
tools/matcher/fusion_prep.sh                           # per photo: render 11 views, check_xyz, match, save out/corr/*.npz, delete renders
cd tools/matcher
.venv/bin/python fusion.py                             # → out/results/fusion_default.json (λ = 1)
.venv/bin/python fusion.py --lam 0.25 --tag lam0.25    # sensitivity (reported only)
.venv/bin/python fusion.py --lam 4 --tag lam4
.venv/bin/python fusion_report.py > out/fusion_tables.md
.venv/bin/python gtjson_check.py                       # secondary GT
# synthetic wrong GPS (ids "IMG_x@r1000" = eye moved 1000 m right of the prior heading)
for v in IMG_7155@r1000 IMG_7131@r1000; do (cd ../.. && node tools/matcher/export_skyline.mjs $v && tools/matcher/fusion_prep.sh $v); done
.venv/bin/python fusion.py IMG_7155@r1000 IMG_7131@r1000 --tag gps
.venv/bin/python write_leaderboard.py                  # results.json, results-fusion.json
```

- `render.mjs` checks every XYZ buffer against its pose (`check_xyz.py`), and every buffer behind these numbers passed.
- Renders are deleted after each photo. `tools/matcher/out` is ~104 MB, mostly `out/skyline/*.f32` (the app's edge and sky maps).

## Files added or changed

All paths are relative to the repository root.

- `tools/matcher/`:
  - New: `fusion.py`, `fusion_report.py`, `gtjson_check.py`, `export_skyline.mjs`, `gps_offset.mjs`, `collect_corr.py`, `fusion_prep.sh`, `write_leaderboard.py`, `results.json`, `results-fusion.json`.
  - `match.py`: now exposes a `correspondences()` library function, and its thresholds are parameters.
  - `render.mjs`: supports `@r<m>` GPS-offset ids and has a `--meta-only` mode.
- `reports/fusion.md` (this file); `reports/matcher.md` (removed) had a pointer here.
