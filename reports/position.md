# T5: camera-position (6-DoF) refinement

*2026-09-25 · code in `tools/matcher/{pose6.py, dem.py, pose6_inputs.py, worker_client.py, pose6_run.sh}` · per-photo outputs in `tools/bench/t5/`*

Scope: development used only the 50 dev photos in `tools/bench/split.json` and the 12 app ground-truth photos. No test photo was run, opened or scored.

## Verdict

- **The machinery works and is safe on the ground-truth set.**
  - On the 12 GT photos the HIGH set is unchanged (9/9) and so are the median errors: 0.15° / 0.12° / 0.27° (yaw / pitch / roll) and 7.0 px.
  - On the dev set, none of the 15 verified-correct poses moved in image space by more than 0.46 % of the image height.
  - On EXIF-GPS photos the HIGH set is identical (5 → 5, the same poses), so EXIF-GPS precision is not lost.
- **It does not reach the targets.**
  - I have no evidence that any near-miss became correct. Only 4 of the 17 dev photos tagged near-miss or parallax-mismatch moved their skyline in the image by more than 0.5 % of the height, and every HIGH near-miss stayed where it was.
  - Hand-placed HIGH precision on dev is about **0.56** if each unmoved pose inherits its verdict: 5 correct, 4 wrong, 1 unsure, 1 unjudged. The target was ≥ 0.85, and fused had about 0.60.
  - Gross errors: 1, the same count as fused but a different photo. The known gross HIGH (wc_0063) drops to LOW, and a verified-wrong pose (wc_0019) rises to HIGH.
- **Why it can't fix these near-misses:** under the solver's own model (Mapterhorn DEM, the app's skyline cue, matches), the near-miss poses already fit: skyline median residual 1–2 px, match support 0.7–0.95. Moving the eye buys no measurable cost reduction, so the gain gate keeps the start pose.
  - A likely large share of the "2–4 % off" verdicts comes from the **verification overlay**, not from the pose. `tools/bench/harness/overlay.ts` draws 0f's skyline from the **Terrarium** DEM, with the eye at Terrarium ground + 1.6 m. On dev, that eye sits up to 42 m below the solver's Mapterhorn eye. That gap alone predicts an overlay skyline drawn **1.3–4.9 % of height too high** on 4 of the 7 dev near-misses: wc_0006 +4.9, wc_0034 −2.6, wc_0014 +2.1, wc_0077 +1.3 (`tools/bench/t5/eyegap.md`).
  - Terrarium's far-field horizon is also visibly smoother than Mapterhorn's (figure below).
- **Useful by-products:**
  1. **Basin-gap check.** The grid search's basin gap is a cheap extra LOW trigger for hand-placed photos. Applied alone on top of fused HIGH on dev, it removes wc_0063, the only gross error, and keeps every verified-correct HIGH: hand-placed HIGH goes from 6 correct / 4 wrong to 6 correct / 3 wrong, all near-misses, and 0 gross.
  2. **Mapterhorn horizon in Python**, `dem.py`. It agrees with the app's horizon to a median of 0.01–0.02° (MAD ≤ 0.06°) and takes about 0.15 s per eye.

![wc_0014](../tools/bench/t5/overlays/wc_0014_m.jpg)

`tools/bench/t5/overlays/wc_0014_m.jpg`: a fused HIGH that the verifiers judged a near-miss, drawn with the Mapterhorn skyline. The start pose (magenta) is hidden under the pose6 result (cyan) because the pose didn't move. Compare the verifier's Terrarium overlay `tools/bench/harness/out/runs/wild/verify/wc_0014_B.jpg`, and the same overlay.ts drawing with the eye set to the solver's height, `tools/bench/t5/overlays/wc_0014_fused_solverEye.jpg`: the skyline drops by about 3 % of the height towards the photographed ridge.

## Method (`tools/matcher/pose6.py`)

- **Parameters.**
  - Yaw, pitch, roll, log focal length, and E and N in metres in the app's ENU frame of the start position.
  - a = height above ground: eye = (E, N, ground(E, N) + clip(a, 1.5, cap)).
  - Ground and horizon come **only from Mapterhorn** (`dem.py`): tiles cached in `tools/matcher/.cache/mapterhorn`, capped at 1 GB, currently 316 MB. Mosaics are z14 within 3 km, z12 within 15 km and z10 within 100 km, with curvature and refraction k = 0.13 as in `src/lib/geodesy.ts`.
- **Horizon at a moved eye: a "delta horizon".** It is the app's own horizon at the start eye plus the change the Python ray-march predicts between the start eye and the moved eye. At zero shift this is exactly the fusion model. Using the Python horizon absolutely moved IMG_7059 by 0.8°, because its near field differs from the app's mesh by up to 1.5°.
- **Data terms.** These are fusion.py's two Huber terms, re-evaluated at the moving eye:
  - skyline: ICP association with the app's skyline score map;
  - matches: the lifted 3D points held **fixed in world coordinates**, which is valid because they are world points.
  - σ per term comes from the single-cue fits at the start eye. Each term is normalised to N_eff = 60 samples, as in eye.ts.
- **Priors.**
  - Focal: σ = 5 % in log f when the focal is known, else 15 %.
  - Horizontal position: σ_H = 30 m for EXIF GPS, 400 m for hand-placed.
  - Height above ground (from the lead's eye lessons): one-sided soft prior (a − ref)/3 m with ref = max(1.6, start AGL); hard cap max(10, start AGL); floor 1.5 m.
- **Regime A (EXIF GPS, and the app photos).** Levenberg–Marquardt with an analytic-structure numeric Jacobian (absolute steps), starting from the fused pose at the start eye.
- **Regime B (hand-placed).**
  - A 9×9 grid over ±1000 m (250 m spacing), with each node at ground + ref.
  - Per node: the horizon, then a coarse yaw × pitch search on the app skyline score (±15° / ±3°).
  - The 10 best nodes get the rotation-only LM and a comparable cost (N_eff·fusion selection cost + priors).
  - Basin gap = (c₂ − c₁)/c₁, where c₂ is the best node at least 2 spacings away from the best.
  - The top 3 basins go through the 6-DoF LM, and the lowest cost wins.
- **Gain gate.** The start pose (the fused pose at the given position) is replaced only if the refined pose lowers the comparable cost by 5 below **both** the start and a rotation-only re-solve at the start eye. Only a gain that needs the position move counts.
- **Re-render confirmation.** Whenever the eye moves more than 10 m, and always for hand-placed photos, `tools/matcher/server/render_worker.mjs` (used as-is) re-renders at the new lat/lon/alt. The app's own horizon there must give a skyline median residual under 4 px.
- **Inputs for bench photos** (`pose6_inputs.py`): one worker render at the fused pose (5-view fan plus skyline export). Photo matches are re-done with ALIKED + LightGlue, and every XYZ buffer is checked against its pose (stale-buffer guard). A compact `inputs.npz` is cached per photo.

## Confidence rule (fixed before any dev outcome)

The rule was frozen with `pose6.py` at sha1 `1ad0396…` on 2026-09-25 08:26 UTC, before the dev run (`tools/bench/t5/RULE_FROZEN.sha1`). The rule and thresholds are unchanged since. Later edits for the service were refactors and speed-ups:
- `grid_search` and `basin_gap` split out;
- a vectorised `rot_search`;
- the opt-in `fast` mode;
- an interpolation fast path in `fusion.sky_curve`, identical to 1e-13 px.

They reproduce the dev basin gaps exactly in full mode (0.145, 0.212, 0.172, 0.495).

**HIGH** requires all of:
1. **Fusion checks at the final eye.** Skyline-only and match-only rotations re-solved there agree to < 1°, skyline median < 4 px, and match support ≥ 0.3. These are the thresholds from `reports/fusion.md`.
2. **Eye not pushed onto the height cap.**
3. **Horizontal shift ≤ 3σ_H.**
4. **Hand-placed only:** basin gap ≥ 0.15.
5. **If the eye moved more than 10 m:** the re-render confirmation passes (< 4 px).

Two amendments were made after the GT-12 run and **before** the dev run:
- Rule 2 originally flagged eyes whose GPS altitude already sits more than 10 m above the DEM (IMG_7130/7131, where the cap equals the start AGL). It now needs a real push onto the cap.
- The gain gate was added.

The floor went from 1.0 to 1.5 m because on IMG_7155 an eye parked at 1.0 m on a slope failed the re-render check.

## GT-12 (EXIF GPS; pins re-solved at the refined eye, frozen control-points snapshot)

`tools/matcher/out/pose6_gt/`, table from `tools/matcher/pose6_eval.py`. Cells are Δyaw / Δpitch / Δroll (°), then mean pin error (px).

| photo | fused (start eye) | pose6 | shift m | AGL m | pose6 conf | fused conf |
|---|---|---|---|---|---|---|
| IMG_6958 | −0.03 / +0.12 / −2.98 · 22.7 | same (start kept) | 0 | 1.6 | HIGH | HIGH |
| IMG_6971 | +0.03 / +0.28 / −0.12 · 4.2 | +0.00 / +0.29 / −0.12 · 3.7 | 12.3 | 1.5 | HIGH | HIGH |
| IMG_7018 | −0.24 / +0.16 / +0.09 · 7.0 | same | 0 | 1.6 | HIGH | HIGH |
| IMG_7033 | +0.15 / −0.05 / −0.20 · 5.6 | same | 0 | 1.6 | HIGH | HIGH |
| IMG_7053 | +0.00 / +0.13 / −0.45 · 7.4 | same | 0 | 1.6 | HIGH | HIGH |
| IMG_7059 | −0.29 / +0.12 / +0.96 · 14.9 | **−1.16** / +0.09 / +0.95 · 21.5 | 3.2 | 1.9 | LOW | LOW |
| IMG_7063 | −0.66 / +0.23 / −0.48 · 11.6 | −0.65 / +0.29 / −0.62 · 11.5 | 4.2 | 1.5 | HIGH | HIGH |
| IMG_7068 | −0.20 / +0.02 / +0.27 · 3.8 | same | 0 | 1.6 | HIGH | HIGH |
| IMG_7086 | +0.05 / −0.04 / +0.04 · 3.2 | same | 0 | 1.6 | LOW | LOW |
| IMG_7131 | −0.08 / −0.36 / −0.25 · 7.7 | same | 0 | 14.5 | HIGH | HIGH |
| IMG_7155 | −0.29 / +0.05 / +0.30 · 1.7 | −0.31 / +0.07 / +0.32 · 1.5 | 10.1 | 1.5 | HIGH | HIGH |
| **median (11)** | 0.15 / 0.12 / 0.27 · 7.0 · 11/11 within 1° | 0.15 / 0.12 / 0.27 · 7.0 · 10/11 within 1° | | | 9 HIGH | 9 HIGH |

- **IMG_7059 is the one regression.** It stays LOW in both runs, and it is the photo whose GT the eye study already questioned: skyline solves consistently land 1.0–1.3° from that GT.
- **IMG_7108** (no GT) moves 26 m and stays HIGH. **IMG_7130** moves 27 m and stays LOW.

## Dev set (50 photos; fused verdicts are the blinded ones; new poses have no verdicts)

The full per-photo table is in `tools/bench/t5/dev_table.md` (made by `tools/matcher/pose6_dev_eval.py`).

**How moves were measured.** An eye move plus a compensating rotation can leave the image unchanged, so "moved" is measured in the image: the median |Δrow| between the Mapterhorn skylines of (start eye, start pose) and (new eye, new pose), as a % of image height. A pose that moved less than 0.5 % of the height inherits the fused verdict; the verifier's C2 tolerance is 1.5 %.

| stratum | n | fused HIGH | pose6 HIGH | pose6 HIGH, unmoved (inherited verdicts) | pose6 HIGH, moved |
|---|---|---|---|---|---|
| EXIF GPS | 22 | 5 (4 correct, 1 near-miss) | 5, the same poses | 4 correct, 1 wrong (near-miss wc_0067) | none |
| hand-placed | 28 | 11 (6 correct, 4 wrong, 1 unsure) | 11 | 5 correct, 4 wrong (wc_0014, 0059, 0077 near-misses; **wc_0019** parallax / fov-scale), 1 unsure | wc_0006 (near-miss, 0.64 % H, unjudged) |

**Hand-placed changes:**
- Lost HIGH: wc_0063 (gross error, now LOW via the basin gap ✓) and wc_0069 (verified correct, now LOW because agreement failed at 2.05° ✗).
- Gained HIGH: wc_0006 (unjudged) and wc_0019 (verified wrong, not a near-miss ✗).

**Why wc_0019 was gained.** pose6 re-matches against renders centred on the fused pose, and that inflates match support from the service's 0.13 to 0.73. **Re-rendering around the answer makes the match check self-confirming.** Any adoption must compute the confidence checks from the service's original stage-2 matches.

**Anchors (15 verified-correct fused poses):** none moved more than 0.5 % of the height; the largest was 0.46 %. In angles alone, eye moves were compensated by up to 1.46° of yaw (wc_0027: 248 m move, same image; see `tools/bench/t5/overlays/wc_0027_m.jpg`).

**Near-miss / parallax photos (17):** moved more than 0.5 % of the height: wc_0002 (1.5 %), wc_0052 (1.9 %), wc_0070 (0.7 %), all LOW, and wc_0006 (0.6 %, HIGH). The HIGH near-misses wc_0014, wc_0059 and wc_0077 barely moved (0.00–0.13 %).

**What I inspected** (unblinded, by me; overlays in `tools/bench/t5/overlays/`):
- `*_m.jpg`, the Mapterhorn start/pose6 skylines, for wc_0002, 0006, 0014, 0015, 0017, 0019, 0027, 0047, 0048, 0054, 0059, 0067, 0071, 0076 and 0077.
- The verifier-style overlay.ts drawings for wc_0059 (start and pose6).
- wc_0014, 0077 and 0006 at the solver's eye height (`*_fused_solverEye.jpg`).
- On wc_0014 and wc_0059 the Mapterhorn skyline follows the photographed ridge closely, while the verifier's Terrarium overlay sits above it.
- I did not judge the new poses correct or wrong: I'm not blind to the method, so the numbers above use inherited verdicts only.

## v2 re-verification (Mapterhorn overlays at each method's own eye, blind)

After this report's first version, the lead rebuilt the overlays for the 17 dev photos where pose6 moved the pose. Each candidate was drawn on **Mapterhorn** at **its own method's eye** (fused at the engine eye, pose6 at its solved eye), and the candidates were re-verified blind. Files: `tools/bench/t5/verify_v2/{verdicts.json, key.json}`.

| id | fused (v2) | pose6 (v2) | pose6 conf |
|---|---|---|---|
| wc_0002 | wrong (fov-scale, yaw-shift) | **correct** | LOW |
| wc_0010 | wrong (parallax) | wrong (parallax) | LOW |
| wc_0015 | wrong | wrong | LOW |
| wc_0023 | wrong | wrong | LOW |
| wc_0027 | correct | correct | **HIGH** |
| wc_0034 | correct | correct | LOW |
| wc_0035 | unsure | wrong | LOW |
| wc_0047 | correct | correct | **HIGH** |
| wc_0052 | wrong | wrong | LOW |
| wc_0058 | unsure | wrong | LOW |
| wc_0070 | wrong (near-miss, roll) | **correct** | LOW |
| wc_0071 | correct | correct | LOW |
| wc_0072 | wrong | wrong | LOW |
| wc_0076 | correct | correct | **HIGH** |
| wc_0087 | wrong | wrong | LOW |
| wc_0095 | wrong | wrong | LOW |
| wc_0098 | wrong | wrong (now tagged near-miss) | LOW |

- **Correct:** pose6 7/17 against fused 5/17.
  - pose6 **fixes wc_0002 and wc_0070** and breaks no pose that fused had correct.
  - Two poses that were **unsure** under fused (wc_0035, wc_0058) are **wrong** under pose6. Both are LOW, both were big hand-placed grid moves (813 m and 1271 m), and wc_0058 also failed the 3σ shift check.
- **pose6 HIGH: 3/3 correct** (wc_0027, 0047, 0076). Both fixes (0002, 0070) are LOW:
  - wc_0002 on agreement and basin gap;
  - wc_0070 on agreement, skyline median and confirmation.

  So the frozen rule is conservative here.
- **The overlay effect:** the v1 near-miss wc_0034 is correct for **both** methods once drawn at the method's own eye on Mapterhorn. This confirms the eye-gap diagnosis: part of the v1 "near-miss" verdicts came from the overlay's Terrarium eye, not from the pose.
- **Default:** pose6 stays **off by default** until the lead's test run.

## Service changes (basin-gap LOW trigger shipped in matcher-service v0.3)

Full notes are in `reports/matcher-service.md`, under "v0.3".

- **The trigger:** a HIGH ad-hoc result with an untrusted position is set to LOW when the position-grid basin gap is below the threshold. It uses `pose6.basin_gap` with `fast=True`: the horizon sector is trimmed to ±(hfov/2 + 17°) and the azimuth step doubled.
  - Offline on dev, fast mode reproduces the full-mode gaps to within ±0.02.
  - Coarser distance steps did **not** reproduce them (wc_0027 0.21 → 0.12), so those stay fine.
- **Threshold: 0.20, tuned on dev (not the frozen 0.15).** On the service's own stage-2 inputs the dev gaps differ from pose6's re-rendered inputs:

  | photo | status | gap |
  |---|---|---|
  | wc_0063 | gross error | **0.175** |
  | wc_0069 | verified correct | 0.213–0.215 |
  | wc_0027 | verified correct | 0.229 |
  | other verified-correct HIGHs | | ≥ 0.48 |

  - At 0.15 the trigger would not drop wc_0063 on service inputs, so the default is 0.20 (`MATCHER_BASIN_GAP_MIN`).
  - It rests on 1 negative and 6 positives, with margins of 0.025 and 0.013. **Treat it as a dev-tuned threshold whose test performance is unknown.**
  - A skyline-only gap (no match term) separated worse: wc_0063 0.25 vs wc_0069 0.06.
- **Dev result through the service:** wc_0063 HIGH → LOW; all 6 verified-correct hand-placed HIGHs are kept; the other 4 hand-placed HIGHs (near-misses and unsure) are kept.
- **Added latency:** median about 10.6 s (9.4–35 s).
- **Other fixes:** the same work also fixed the matcher nondeterminism behind the "cold-page race" (LightGlue on MPS; it now runs on the CPU), the ENOENT worker crash, and memory growth.

## Runtime (M3 Pro; network-bound parts included)

| regime | wall per photo (median / p90) | of which solve |
|---|---|---|
| EXIF GPS | 61 s / 84 s | 31 s, ~120 horizon evaluations |
| hand-placed | 162 s / 269 s | 124 s, ~385 horizon evaluations (grid) |

Most of the rest is the worker render (page load plus satellite drape) and the confirmation re-render. A cold DEM mosaic costs 10–40 s of tile fetches per new area; the tiles are cached afterwards.

## For the test run (lead)

```bash
tools/matcher/pose6_run.sh wc_XXXX wc_YYYY ...   # → tools/bench/t5/<id>.json
```

- **Needs:** the dev server on :3100, the matcher venv, ≥ 3 GB free, and `tools/bench/harness/out/runs/wild/results/<id>/given.fused.json` for each id.
- **Each output file contains:**
  - `pose` {yaw, pitch, roll, vfov}
  - `eye` {lat, lon, h}, with h the eye height in metres in the Mapterhorn DEM height datum
  - `confidenceLevel` (HIGH/LOW)
  - `checks` (d_agree, sky_med, match_support, agl, onCap, shiftM, shiftSigma, basinGap, confirmSkyMedPx, failed[])
  - `start`, `grid`, timing
- `NO_CONFIRM=1` skips the re-render, which forces LOW whenever a confirmation is required.
- **Verification note:** to judge these poses fairly, draw the overlay at the solver's eye, `overlay.ts --lat eye.lat --lon eye.lon --alt eye.h`. Otherwise the Terrarium eye (Terrarium ground + 1.6 m) can put the skyline 1–5 % of the height off by itself. Ideally overlay.ts would draw the Mapterhorn skyline; that file is outside my ownership, so I left it alone.

## Service adoption

I do not recommend enabling the 6-DoF pose change in `/match` yet: on dev it didn't convert a single near-miss, and it added a false HIGH (wc_0019). What I do recommend:
1. **Adopt the basin-gap check** as an extra LOW trigger for photos without EXIF GPS: fused HIGH ∧ gap ≥ 0.15. (**Done in matcher-service v0.3**, with the threshold at 0.20; see "Service changes".)
   - Cost: about 81 Python horizon evaluations plus coarse rotation searches, roughly 20–40 s. Only the grid pass is needed, not the full solve.
   - Call `pose6.Problem` + `pose6.rot_search` / `node_solve` with the service's own skyline export and the service's **own stage-2 matches**. Don't re-render around the answer, since that inflates match support.
   - On dev it removes the one hand-placed gross error and keeps every verified-correct HIGH (0.15 was fixed in advance, not tuned).
2. **Return the solver's eye** (`eye.lat/lon/h`) with every pose, so overlays and clients draw the skyline from the same height the solver used.
3. **Re-score the fused near-misses** with Mapterhorn-based (or solver-eye) overlays before investing in position solving. I suspect a large share of them is overlay DEM and eye height, not pose.
4. **Keep 6-DoF as an opt-in** (`pose6.refine`) for EXIF photos with a near skyline and a poor rotation-only fit. It is safe there (no regressions on GT-12 or the EXIF dev photos) but rarely changes anything.

## Files

- `tools/matcher/`:
  - New: `pose6.py`, `dem.py`, `pose6_inputs.py`, `worker_client.py`, `pose6_run.sh`, `pose6_eval.py`, `pose6_dev_eval.py`, `pose6_overlay.py`, `pose6_eyegap.py`.
  - `fusion.py`: gains `skyline_from_arrays()`; its behaviour is unchanged (verified on IMG_7155).
- `tools/bench/t5/`: `<id>.json` for the 50 dev photos, `dev_table.md`, `dev_summary.json`, `eyegap.md`/`.json`, `overlay_eyes.jsonl` (+ `eyes_overlay.ts`), `overlays/`, `RULE_FROZEN.sha1`, `work/<id>/{photo.jpg, inputs.npz}`, about 100 MB. `tools/bench/t5` is **not gitignored**; `work/` is scratch and can be deleted.
- `tools/matcher/out/pose6_gt/`: GT-12 outputs and `pose6_gt_table.md`.
