# Render-and-match escalation tier: prototype results

*2026-09-24 · code in `tools/matcher/` · raw numbers in `tools/matcher/out/results/*.json` and `tools/matcher/out/report_tables.md`*

## TL;DR

- **It works, and it's accurate.** I matched the photo with ALIKED + LightGlue against **satellite-draped** DEM renders near the prior, lifted the matches through the render's XYZ buffer and solved rotation with the camera centre fixed at the GPS eye. That solved **11/11 scorable photos within 0.8° of yaw**. Median errors were |Δyaw| 0.16°, |Δpitch| 0.07° and |Δroll| 0.23°. Skyline auto-align got 0.30° / 0.26° / 0.34° on the same photos. It also fixes priors that are off by more than 10° (IMG_7131, IMG_7155) without any yaw search of its own.
- **It does not beat skyline on the headline metric.** The median pin reprojection error is 10.5 px for render-match and 7.9 px for skyline. The pins-derived GT uses only 2–3 pins on 8 of 11 photos, and pin px is sensitive to focal length (see below). The honest reading is **"as good as skyline, with different failure modes"**, not "better".
- **It is robust to a bad compass.** I added ±15° to the heading on top of each photo's real compass error, so the effective prior errors were 4–26°. Render-match recovered **21/22** cases and skyline recovered **19/22**. They failed on different photos: render-match on IMG_7018 at +23°, skyline on IMG_7053 at −20° and on IMG_7086 at both shifts. That complementarity is the argument for keeping it as an escalation tier.
- **The 4 "low-confidence" photos (7059, 7063, 7068, 7155) are not actually hard for either method against the new pin GT.** Render-match improves on skyline for 7063, 7068 and 7155 by 0.1–0.4° of yaw. It's slightly worse on 7059, where yaw is +0.77° against skyline's −0.62° and the GT there is "approx".
- **Hillshade renders are unreliable**, and so are DISK-on-hillshade and 6-DoF / P4Pf solves. RoMa v1 runs, but at ~25–40 s per image pair on the M3 Pro GPU (MPS) it was no better than ALIKED+LightGlue on the 3 photos I could afford to run: satellite 0.13–0.73° yaw; hillshade collapsed on 7059.

## Follow-up: fusion

A joint skyline + match LM solve with agreement-based confidence is written up in [`reports/fusion.md`](fusion.md). It is within 1° in 33/33 compass-stress cases.

It also questions a failure mode listed below. For IMG_7108, the DEM horizon rendered from the EXIF GPS fix matches the photo, so the error there is the compass (off by 13.7°), not the GPS.

## Method

For each photo: `pipeline.sh` → `render.mjs` → `match.py`.

1. **Render (read-only use of the running app, `render.mjs`).** Playwright (Chromium, Metal) opens `/photo/<ID>` and waits for `[data-ready]` (DEM loaded and skyline auto-align done). It then uses `window.__engine` in memory only:
   - reads `prior`, `pose` (= skyline auto result), `eye` and `frame`;
   - builds GT exactly like `scripts/eval-app.mjs`: `controlPins(cp)` → `solvePins(pins, prior, solveFocal)`, plus `pinError` for prior/auto;
   - awaits `terrain.loadImagery('satellite')` (swisstopo SWISSIMAGE, Esri World Imagery fallback, as in `src/lib/terrain.ts`);
   - for each pose: sets `engine.pose`, calls `renderGeometry()` and **reads `geoRT` back itself** (float ENU xyz + range, 1024×768). It then renders the same camera to the canvas in the app's `imagery` style (`*_sat.jpg`) and `hillshade` style (`*_hill.jpg`), and restores all engine state.
   - The initial views are the prior yaw + {−20, −10, 0, +10, +20}° at the EXIF vfov. The DEM is Mapterhorn Terrarium, via the app.
2. **Match (`match.py`).** The photo (`public/photos/<ID>.jpg`) is resized to the render size. Matchers:
   - ALIKED-n16 (4096 kp) + LightGlue;
   - DISK (4096 kp) + LightGlue;
   - RoMa v1 outdoor on a subset (5000 sampled matches).
   Style options are `sat`, `hill` or `sat+hill`. Matches from all 5 views are pooled.
3. **Lift.** Each render keypoint looks up xyz in its view's buffer. Points are dropped if they are sky, nearer than 250 m (inside the GPS error cone), or on a depth discontinuity (5×5 range spread > 8 %).
4. **Solve.** Four solvers run on the same correspondences:
   - `rot_fixf` (primary): camera centre fixed at the app's eye, EXIF focal. 2-point rotation RANSAC (triad, 6 px threshold), then a soft-L1 Levenberg-Marquardt refit on the inliers (scipy).
   - `rot_freef`: the same, plus focal length with a 5 % EXIF prior.
   - `pnp_exif`: PoseLib LO-RANSAC 6-DoF PnP with the EXIF focal.
   - `p4pf`: the PoseLib P4Pf minimal solver in my own RANSAC (6-DoF + focal).
   Rotation is converted to yaw/pitch/roll with the inverse of `poseBasis` (`src/lib/pose.ts`). I checked the conventions numerically: render xyz reprojected with the render pose lands on its own pixels to within 0.00–0.03 px (`check_xyz.py`). My Python `pin_error` also reproduces the app's `pinError` for prior, auto and GT to 1e-12.
5. **Second pass.**
   - `it1`: one refinement render at the solved pose.
   - `s15` / `s-15`: the compass stress test. It renders prior ±15° + {−10, 0, +10}° and solves from those views only.

**Scoring** is the same as `eval-app.mjs`: Δ = pose − GT, with GT = pins solved from the prior (`data/control-points.json`, snapshot in `tools/matcher/out/control-points.snapshot.json`). Pin px is the mean pin reprojection error on a 1600-px-wide image. Photos with fewer than 2 resolvable pins are not scored: IMG_7108 has none, and IMG_7130 has 1 pin that resolves.

## Licences

| component | licence | source |
|---|---|---|
| LightGlue code + ALIKED/DISK LightGlue weights | Apache-2.0 | github.com/cvg/LightGlue (README: weights Apache-2.0) |
| ALIKED code + `aliked-n16.pth` | BSD-3-Clause | github.com/Shiaoming/ALIKED |
| DISK `depth-save.pth` | Apache-2.0 | github.com/cvlab-epfl/disk (GitHub licence API) |
| RoMa v1 code + `roma_outdoor.pth` (`romatch` 0.1.2) | MIT | github.com/Parskatt/RoMa |
| DINOv2 ViT-L/14 backbone (used by RoMa v1) | Apache-2.0 | facebookresearch/dinov2 |
| PoseLib | BSD-3-Clause | github.com/PoseLib/PoseLib |
| SuperPoint | **not used** (restrictive Magic Leap licence) | |

- RoMa **v2** (DINOv3 backbone, DINOv3 licence) was not tried.
- Imagery is fetched by the app. Check the swisstopo and Esri terms before any server-side production use.

## Results: all photos (initial pass, ALIKED + LightGlue on satellite renders, `rot_fixf`)

Cells are Δyaw / Δpitch / Δroll in degrees, then mean pin error in px. The 4 low-confidence photos are in **bold**.

| photo | GT pins (quality) | prior | skyline auto (app) | render-match | inliers / lifted | match+solve s |
|---|---|---|---|---|---|---|
| IMG_6958 | 3 (approx) | +2.97 / +0.64 / −3.47 · 97.4 | −0.03 / +0.13 / −3.15 · 24.4 | −0.08 / +0.02 / −2.80 · 22.5 | 1875 / 2825 | 8.4 |
| IMG_6971 | 2 (good) | −9.10 / −0.22 / −0.99 · 252.4 | −0.01 / +0.28 / −0.17 · **3.1** | +0.48 / +0.47 / −0.73 · 18.2 | 1174 / 1292 | 20.5 |
| IMG_7018 | 7 (good) | +8.30 / +2.05 / −0.22 · 208.5 | −0.30 / +0.30 / +0.08 · 9.1 | −0.32 / +0.06 / +0.11 · **8.5** | 211 / 377 | 21.1 |
| IMG_7033 | 5 (good) | +0.69 / +1.62 / −1.10 · 57.7 | +0.22 / +0.05 / −0.20 · **5.8** | −0.00 / −0.23 / −0.02 · 12.7 | 351 / 412 | 34.3 |
| IMG_7053 | 3 (good) | −4.75 / +0.61 / −3.55 · 123.6 | +0.37 / +0.37 / −1.00 · 7.9 | +0.06 / +0.06 / −0.18 · **6.4** | 430 / 520 | 32.3 |
| **IMG_7059** | 2 (approx) | +0.36 / −0.15 / +1.16 · **9.8** | −0.62 / −0.05 / +0.76 · 11.9 | +0.77 / −0.02 / +1.16 · 11.3 | 798 / 1019 | 12.4 |
| **IMG_7063** | 2 (approx) | −1.14 / −0.01 / +1.23 · 27.4 | −0.59 / +0.26 / −0.54 · **10.1** | −0.38 / +0.29 / −0.10 · 10.5 | 5025 / 5656 | 20.7 |
| **IMG_7068** | 2 (approx) | +1.50 / +2.43 / −0.71 · 77.9 | −0.25 / +0.09 / +0.34 · 4.1 | −0.15 / −0.04 / +0.32 · **2.8** | 3829 / 4122 | 32.0 |
| IMG_7086 | 4 (good) | −0.38 / +0.33 / −0.27 · 19.5 | = prior (skyline rejected) · 19.5 | +0.07 / −0.07 / +0.12 · **10.7** | 509 / 663 | 11.2 |
| IMG_7108 | 0 | – | – | yaw 62.99 (skyline differs by 0.29°); GPS fix believed stale, see failure modes | 1553 / 2213 | 8.6 |
| IMG_7130 | 1 | – | – | yaw 177.72 (skyline differs by 1.10°) | 267 / 644 | 18.2 |
| IMG_7131 | 3 (good) | +10.09 / +0.75 / −1.04 · 224.3 | +0.02 / −0.37 / −0.24 · **6.9** | −0.18 / −0.41 / −0.23 · 7.0 | 1927 / 2263 | 11.6 |
| **IMG_7155** | 2 (good) | −10.61 / +0.60 / +2.87 · 224.2 | −0.36 / +0.09 / +0.40 · **1.7** | −0.16 / −0.09 / +0.34 · 2.2 | 3022 / 3256 | 11.8 |

Summary over the 11 scorable photos:

| | median abs Δyaw | median abs Δpitch | median abs Δroll | median pin px | within 1° yaw |
|---|---|---|---|---|---|
| prior (compass + gravity) | 2.97° | 0.61° | 1.10° | 97.4 | 3/11 |
| skyline auto (app) | 0.30° | 0.26° | 0.34° | **7.9** | 11/11 |
| render-match, `rot_fixf` (EXIF focal) | **0.16°** | **0.07°** | **0.23°** | 10.5 | 11/11 |
| render-match, `rot_freef` (focal refined) | 0.18° | 0.07° | 0.24° | **6.1** | 11/11 |

- The skyline column matches `node scripts/eval-app.mjs`, re-run read-only during this session; its output is in `tools/matcher/out/eval-app.txt`.
- The prior and skyline pin px come from the app's own `pinError`.

**Why angles are better but pin px isn't.** The GT solves focal from the pins (`solveFocal: true` on most photos). `rot_fixf` keeps the EXIF focal, so pins near the frame edges pick up a scale error even when the rotation is right. With focal refined (`rot_freef`) the median pin error drops to 6.1 px, below skyline, while the angles are unchanged. With only 2 pins on 6 of the 11 photos, neither pin px nor the angle deltas separate methods reliably below ~0.3°.

### Compass-error stress test (heading offset by ±15° on top of the real error)

The skyline column comes from `stress_skyline.mjs`: it overrides `engine.prior` in memory, runs `autoAlign(true)` and applies the app's acceptance rule.

| photo | effective prior Δyaw (+15 / −15) | render-match Δyaw | skyline Δyaw |
|---|---|---|---|
| IMG_6958 | +18.0 / −12.0 | −0.14 / +0.03 | −0.02 / −0.03 |
| IMG_6971 | +5.9 / −24.1 | +0.41 / +0.48 | +0.23 / +0.08 |
| IMG_7018 | +23.3 / −6.7 | **−4.75** / −0.32 | −0.25 / −0.35 |
| IMG_7033 | +15.7 / −14.3 | −0.03 / −0.03 | +0.22 / +0.17 |
| IMG_7053 | +10.2 / −19.8 | +0.08 / +0.05 | +0.37 / **−3.63** (conf 0.28) |
| IMG_7059 | +15.4 / −14.6 | +0.67 / +0.81 | −0.39 / −0.57 |
| IMG_7063 | +13.9 / −16.1 | −0.48 / −0.34 | −0.62 / −0.59 |
| IMG_7068 | +16.5 / −13.5 | −0.21 / −0.14 | −0.21 / −0.21 |
| IMG_7086 | +14.6 / −15.4 | −0.00 / +0.20 | **+14.62 / −15.38** (conf 0.00 / 0.02: falls back to the prior) |
| IMG_7131 | +25.1 / −4.9 | −0.21 / −0.15 | +0.03 / −0.01 |
| IMG_7155 | +4.4 / −25.6 | −0.19 / −0.14 | −0.34 / −0.36 |

Render-match recovered 21/22 cases within 1° and skyline 19/22. Their failures don't overlap. IMG_7086 is the clearest case for escalation: its skyline is weak (confidence 0), but the satellite texture of the lake and valley matches well.

### Matcher / style / solver ablation (medians over the 11 scorable photos)

| config | solver | solved | median abs Δyaw | median abs Δpitch | median abs Δroll | median pin px | worst abs Δyaw |
|---|---|---|---|---|---|---|---|
| **aliked:sat** | **rot_fixf** | 11/11 | 0.16 | 0.07 | 0.23 | 10.5 | 0.77 |
| aliked:sat | rot_freef | 11/11 | 0.18 | 0.07 | 0.24 | 6.1 | 1.17 |
| aliked:sat | pnp_exif (6-DoF) | 11/11 | 0.26 | 0.22 | 0.17 | 9.2 | 1.44 |
| aliked:sat | p4pf | 11/11 | 0.25 | 0.42 | 0.31 | 13.1 | 2.70 |
| aliked:sat+hill | rot_fixf | 11/11 | 0.16 | 0.07 | 0.23 | 10.3 | 0.75 |
| aliked:hill | rot_fixf | 8/11 | 0.19 | 0.15 | 0.72 | 8.1 | 3.74 |
| aliked:hill | pnp_exif | 10/11 | 2.73 | 0.59 | 1.88 | 49.3 | 145 |
| disk:sat | rot_fixf | 11/11 | 0.31 | 0.11 | 0.28 | 10.3 | 10.40 |
| disk:hill | rot_fixf | 5/11 | 0.62 | 0.53 | 0.74 | 13.1 | 6.32 |
| aliked:sat, refine pass (1 view at solution) | rot_fixf | 11/11 | 0.15 | 0.08 | 0.31 | 10.1 | 0.77 |
| roma:sat (7059, 7063, 7068 only) | rot_fixf | 3/3 | 0.35 | 0.03 | 0.40 | 10.9 | 0.73 |
| roma:hill (7059, 7063, 7068 only) | rot_fixf | 3/3 | 0.36 | 0.37 | 0.49 | 9.9 | 29.6 (7059: collapsed) |

The full table (every config × solver, including the stress passes) is in `tools/matcher/out/report_tables.md`.

**Caveat on selection.** I chose "aliked:sat + rot_fixf" as the headline after seeing the 6 initial configs. `aliked:sat+hill` is identical, and `disk:sat` is close except for one 10° miss (IMG_7053, where DISK lifted only 43 matches). So the headline isn't a lucky pick, but it isn't a pre-registered one either.

## Runtime per photo (M3 Pro, torch 2.14 MPS, while other sessions shared the GPU)

| step | time |
|---|---|
| App page load (DEM tiles + the app's own segmentation and skyline align) | 12–34 s. The app already pays this; it's not specific to render-match. |
| Satellite drape of the loaded wedge | 1.4–4.4 s |
| 5 views × (xyz + sat + hill) render and readback | 1.2–1.9 s |
| ALIKED+LightGlue, 1 photo × 5 sat views, + solve | 8–34 s (median ~18 s). This includes the first-call MPS warm-up and GPU contention. Refine pass with 1 view: 1–7 s. |
| RoMa v1, per image pair | ~25–40 s (110–370 s per photo per style). Too slow for this role on a laptop. |
| Solvers: `rot_fixf` | < 0.3 s |
| Solvers: `p4pf` (Python RANSAC loop) | 1–3 s |

End to end, a photo takes about 30–60 s on this laptop. Most of that is page and DEM loading and cold-start matching. On a server GPU with a warm model it would be a few seconds.

## Failure modes (with visualisations)

- **Hillshade and relief renders don't carry enough texture.** ALIKED gets 2/350 inliers on IMG_7086's hillshade (`tools/matcher/out/viz/IMG_7086_initial_aliked_hill.jpg`: red = outliers, all over the lake and sky edge). With `rot_fixf`, hillshade solved only 8/11 photos with ALIKED and 5/11 with DISK. With 6-DoF solvers it gives wild poses (Δyaw up to 145°). The app's hillshade style is also hypsometric-tinted with a single sun direction, which never matches the photo's lighting. Satellite drape is what makes this approach work.
- **A position/altitude error hides the foreground** (`tools/matcher/out/viz/IMG_7059_initial_aliked_sat.jpg`).
  - IMG_7059's GPS is ±37 m on a ridge. The app puts the eye at DEM + 1.5 m at that fix, so a nearby grassy crest in the render hides the valley the photo looks down into.
  - Only the distant band matches, and because the inliers form a thin horizontal strip, roll is weakly constrained (Δroll +1.16°, the same as the prior's).
  - Fixing this needs a position/altitude update (LandscapeAR-style, or snapping the eye up to the nearest viewpoint), which the rotation-only solver deliberately doesn't do.
- **Translation is not observable.**
  - `pnp_exif` / `p4pf` recover camera-centre shifts of 10–300 m, and on sparse matches up to tens of km. Their rotations are consistently worse than the fixed-centre solve (median |Δpitch| 0.22–0.42° against 0.07°).
  - This agrees with the SoTA report: keep GPS fixed and solve rotation (and optionally focal).
- **A wrong GPS fix can't be fixed from the render side.**
  - IMG_7108 was taken from a steel-hulled lake steamer, which makes the compass unreliable, and its GPS fix is believed stale (control-points notes).
  - Render-match still returns a confident-looking pose (1553 inliers), 0.29° from skyline. Both are probably wrong, because both render from the wrong position.
  - The inlier count is not a sufficient confidence signal on its own. It needs a residual/coverage check, or a position-search tier.
- **When the prior is ≥ ~23° off, render-match can fail.** The prior render then barely overlaps the photo. That happened on IMG_7018 at +15°, which becomes −4.75° after the solve. It then locks onto a partially overlapping neighbour view. Widening the yaw fan of renders (or taking skyline's yaw as the render centre) would cover this.
- **Success from a 10.6° compass error:** `tools/matcher/out/viz/IMG_7155_initial_aliked_sat.jpg`. There are 3022 of 3256 inliers across the whole distant range, and the result is Δyaw −0.16°.
- **Engineering pitfall found during the run.**
  - Mid-session, `src/lib/engine.ts` moved the `geoBuf` CPU readback onto a timer. My first refine and stress renders therefore paired new colour images with the *previous* pose's XYZ, which produced silently wrong solves.
  - `render.mjs` now reads `geoRT` back itself.
  - `check_xyz.py` checks every buffer by reprojection, and `pipeline.sh` aborts if any buffer fails. I deleted and re-ran all affected results. Every buffer behind the numbers above passes (0.00–0.03 px).

## Verdict

- **Does it help?**
  - It matches skyline accuracy and beats it on angles: median 0.16° against 0.30° yaw, and 0.07° against 0.26° pitch.
  - It is **not** clearly better on pin px: 10.5 against 7.9 px with the EXIF focal, and 6.1 px with the focal refined.
  - For photos where skyline already has confidence ≥ 0.5, it adds little.
- **Where it helps:**
  1. **Weak or ambiguous skylines with textured terrain.** IMG_7086: the skyline was rejected, and render-match went from 19.5 to 10.7 px, Δyaw −0.38 → +0.07. It also held under ±15° compass error, where skyline fell back to the prior.
  2. **As an independent second opinion.** The two methods fail on different photos in the stress test (7018 against 7053/7086). Agreement between them within ~0.5° would be a much better confidence signal than either score alone.
  3. **Pitch and roll refinement.** The dense texture matches pin pitch much better than a skyline edge does: median 0.07° against 0.26°.
- **The 4 "low-confidence" photos** are within 1° for *both* methods against the current pin GT.
  - Render-match is slightly better on 7063, 7068 and 7155, and slightly worse on 7059 (whose near field is occluded because of the GPS/altitude problem).
  - So the escalation trigger shouldn't be "skyline confidence < 0.5" alone. Use it when skyline confidence is low **and** the terrain is textured/visible, or when the two methods disagree.
- **What to build:**
  - Satellite renders only (drop hillshade), ALIKED+LightGlue, rotation-only solve with the focal refined behind a prior.
  - A 5-view yaw fan, centred on skyline's yaw when skyline has any confidence.
  - Server-side, or client WASM later; ORT-WebGPU LightGlue is still broken per the SoTA report.
  - Don't adopt RoMa v1 for this role, and don't use 6-DoF solvers.
  - Position/altitude errors (7059, 7108) need their own tier.

## Reproduce

```bash
# once: Python 3.12 venv (torch has no 3.14 wheels needed here), weights land in tools/matcher/weights
cd tools/matcher
python3.12 -m venv .venv
.venv/bin/pip install torch torchvision opencv-python-headless numpy pillow kornia scipy poselib \
    "git+https://github.com/cvg/LightGlue.git"
.venv/bin/pip install --no-deps romatch && .venv/bin/pip install loguru einops      # optional (RoMa; ~1.7 GB weights)

# dev server must be running on http://localhost:3100 (npm run dev -- --port 3100)
cd ../..
tools/matcher/pipeline.sh                      # all 13 photos, one at a time; renders deleted after scoring
tools/matcher/pipeline.sh IMG_7059 IMG_7063 IMG_7068 IMG_7155   # just the hard ones
node tools/matcher/stress_skyline.mjs          # skyline side of the ±15° stress test
node scripts/eval-app.mjs                      # app skyline numbers (read-only)
node tools/matcher/render.mjs --meta-only      # refresh GT from the current control points before scoring
tools/matcher/.venv/bin/python tools/matcher/report_table.py > tools/matcher/out/report_tables.md

# optional: RoMa (keep renders: KEEP_RENDERS=1 tools/matcher/pipeline.sh IMG_7063)
cd tools/matcher && .venv/bin/python match.py IMG_7063 --configs roma:sat,roma:hill --suffix _roma
```

- `pipeline.sh` stops if less than 3 GB is free on `/System/Volumes/Data`.
- Colour renders are JPEG. XYZ buffers are float32 (9.4 MB per view) and are deleted per photo unless `KEEP_RENDERS=1`.

## Files

- Code (all in `tools/matcher/`):
  - `render.mjs`: app-driven renderer and GT/meta export.
  - `match.py`: matching, lifting and the four solvers.
  - `common.py`: pose conventions and scoring.
  - `check_xyz.py`: XYZ-vs-pose integrity check.
  - `make_poses.py`: second-pass poses.
  - `pipeline.sh`: the driver.
  - `stress_skyline.mjs`: skyline side of the stress test.
  - `report_table.py`: tables for this report.
  - `summarize.py`: per-photo dump of every config and solver.
- Outputs (gitignored, ~2 MB, in `tools/matcher/out/`):
  - `results/*.json`: per photo, stage, config and solver.
  - `results/skyline_stress.json`
  - `renders/*/meta.json`: prior, auto, eye, pins and GT.
  - `viz/*.jpg`: the 3 figures above.
  - `report_tables.md`, `eval-app.txt`, `control-points.snapshot.json`
- Weights (gitignored, 1.6 GB, in `tools/matcher/weights/hub/checkpoints/`). DINOv2 ViT-L (1.2 GB) and `roma_outdoor.pth` (0.45 GB) are only needed for RoMa and can be deleted to free disk.
