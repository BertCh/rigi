# Step Inside: results

Date: 2026-09-29. This covers the build of [step-inside-design.md](step-inside-design.md), phases P0 to P3, done by session mt-image-14 with three workflows and about 30 agents. Every workstream had its own skeptical reviewer.

## Verdict

Step Inside works end to end in both renderers. A photo with a solved pose gets near-field Gaussian splats placed on the DEM. You can step into the photo from its exact camera, and the Truth view tints every surface by where it came from. Georeferenced `.ply` and `.splat` exports carry the anchor quality and the model licence. The feature is off, and invisible, when the near-field service is down. Classic stays pixel-identical (style-baseline 16/16) and the eval-app numbers are unchanged.

The headline product gate is **not met**. On accepted photos the split removes about 4% (three) or 15% (deck) of the non-person drape smear, against a target of 80%. Monocular depth can't separate huts and trees at 100–300 m from the terrain behind them. The P2 multi-view fusion gate is also **not met**, because the only multi-photo spot has almost no shared near field. Among the explorations, pose propagation is the clearest win: blind verification judged its one wild-photo suggestion correct.

## What was built

| Area | Where | State |
|---|---|---|
| Contract | `src/lib/nearfield/types.ts` | GaussianCloud, AnchorFit (plus a range curve), split, provenance, service wire formats |
| Near-field service | `tools/nearfield/service` (`run.sh`, :8767) | `/depth` (MoGe-2 L/B, DA3-Base), `/gaussians` (depth-lift; SHARP behind a dev flag, research-only), `/multiview` (DA3 with known poses), `/inpaint` (LaMa). Disk cache, shared GPU lock, selftest 73/73 |
| Core | `anchor`, `ground`, `split`, `lift`, `scene`, `near-dem`, `splat-io`, `client`, `measure`, `provenance` | 41 checks pass |
| Renderers | `three-splats.ts` (logarithmic depth), `deck-splat-layer.ts` (terrain's log `gl_FragDepth`) | Dependency-free EWA splats with a worker sort. Details in the rendering row below |
| Engines and UI | engine.ts, materials.ts, deck/{engine,terrain-layer,composite,cpu-geometry}.ts, `src/components/nearfield/**` | Step inside (camera, masking and navigation listed below), Truth tint on all surfaces, object hover readout, gated on anchor quality |
| Export | `src/lib/export/splat.ts` | `.ply` and `.splat-v1` in ENU with a geo origin and a metadata header; `generated` content is always stripped |
| P2 roll spots | `src/lib/nearfield/roll/**`, "Spot 3D" in the roll map, `tools/nearfield/{roll,brush,eyes}` | Built. Gate missed (see below) |
| P2 propagation | `src/lib/nearfield/propagate.ts`, `tools/nearfield/propagate` | Suggestion only, gated, with a draft prereg |
| P3 generation | `src/lib/nearfield/generate/**`, `/lab/generate?nearfield=gen` | "3D cache" render, then LaMa hole-fill, then `generated` splats. Remote GEN3C and LingBot adapters are written but never run |
| Labs | `/lab/splats`, `/lab/deck-splats`, `/lab/generate` | Dev only |

- **Rendering:** 200k splats render at 60 fps. At 1M splats, three runs at about 35–45 fps with MSAA and deck at about 38 fps.
- **Step inside:** the camera starts exactly on the photo camera (offset 1e-15 m) and eases home. Object pixels are masked out of the drape.
- **Navigation:** orbit, pan and dolly are limited to the confidence radius.

## Key findings

1. **Monocular metric depth can't place splats directly.** MoGe-2 compresses range. The DEM/model ratio is about 1 at 20 m, 2.9 at 100–300 m, and 6.6 at 300–1000 m. A single scale has a median terrain error of 0.34 (log) at 15–500 m.
2. **What works instead:** a monotone log-log curve fitted per photo on DEM terrain brings that to 0.13. **Object grounding** (rescaling each object so its ground contact meets the DEM) then places trees, trains and poles at plausible heights. The details are in `tools/nearfield/spike/PLACEMENT.txt`.
3. **The fit residual is not a pose verifier.** Its AUC is 0.73 against wrong basins and 0.55 at ±2°. It is used only as a trust label: below 0.15 the scene is hidden, and below 0.35 it is marked low trust.
4. **DEM-prompted depth (LingBot-Depth-DC)** interpolates terrain very well (0.017) but is unstable depending on the prompt range. It was not adopted.
5. **Why the smear gate fails** (`tools/nearfield/smear/REPORT.txt`; 99 labels drawn before any Step Inside code ran on those photos):
   - **Far objects:** most of the leftover smear comes from objects beyond the 150 m near radius, which get classed "Far". Raising the radius causes false removals (3–18%).
   - **The quality gate hides photos:** 4 of 14 in three and 2 of 14 in deck.
   - **Measured the design doc's way** (person plus hut), removal is 8.7% (three) and 19.8% (deck).
   - **People:** classic already masks 98% of them.
6. **Engine parity:** both engines now share one near-camera DEM (`near-dem.ts`, z16). Object placements agree within 3%. The cost is that IMG_7059, taken from a cliff lip, now anchors at quality 0 in both engines, so Step Inside is hidden there. That is a real regression for a demo photo.
7. **P2 multi-view fusion:** the only spot with at least 2 posed photos (Niederhorn: 7053, 7059, 7063, 7068, 7086) has photos facing different directions, and GPS eye errors are 7–37 m. Leave-one-out near-field coverage is 0–7%. Brush makes floaters. Eye refinement (`eyes.ts`, off by default) shrinks the 7059/7063 baseline from 7.1 m to 0.23 m. The reviewer showed that the apparent registration gains track absolute eye placement, not the refinement, so there is no evidence it helps yet.
8. **Pose propagation works when views overlap.** ALIKED+LightGlue with a rotation-only fit gives a median error of 2.2° on 6 real pairs and 0.016° on synthetic pairs. The gate rejects all 83 wrong pairs. DA3 adds nothing. On the wild dev photo wc_0086, which no other method solved, **3 of 3 blind verifiers judged the propagated pose correct** and rejected every decoy. That is post hoc, a single case, with a borderline vertical fit (1.1–1.5% of image height against a 1.5% limit). This is the most promising recall lead.
9. **P3 generation:** LaMa fills thin disocclusions plausibly and smears large areas outside the frame. Generated splats never reach exports or the hover readout, which the checks prove. Monocular fallback lifting now requires local support, so generated content can't float. Real DEM-conditioned generation needs GEN3C (NVIDIA Open Model License) on a rented Linux GPU.

## Licences (details in research_notes/step_inside_models_2026-09.md)

| Commercial-safe, in use | Research-only |
|---|---|
| MoGe-2 (MIT), DA3-Base (Apache), LaMa (Apache), ALIKED (BSD-3) + LightGlue (Apache), Brush (Apache) | SHARP (dev flag, flagged in `/health` and in exports) |

Avoid LingBot-World v2 (NC), DA3 Giant with its Gaussian head (NC), MASt3R (NC), and HunyuanWorld (excludes the EU). VGGT-1B-Commercial needs a gated application.

## Regression gate (final run)

| Check | Result |
|---|---|
| tsc | 0 errors |
| Check suites | nearfield 41, spot 22, eyes 17, generate 38, export 46, propagate: all pass |
| Service selftest | pass |
| style-baseline | 16/16 exact |
| eval-app | 12/14 within 1°, median 6.5 px (unchanged) |
| deck-engine-smoke | 4/4 |
| e2e, both renderers | pass. A flaky "back to photo" hang on deck was fixed in `step-camera.ts` (finishes the return when the camera is already settled) and re-run clean |
| e2e with the service dead | pass |

Nothing over 5 MB goes into git. Weights, caches, shots and Brush binaries are all gitignored.

## Recommended next steps

1. **Smear gate:** switch from depth-only to semantic plus depth. Use a permissively licensed segmentation model to mark buildings, trees and poles as Object regardless of monocular depth, with grounding for placement. Re-measure against the existing `labels.json`.
2. **Anchoring at cliff lips and near-camera ground** (IMG_7059, 7063): a better rule for the eye-height and near-DEM conflict.
3. **Propagation:** run the `PREREG_DRAFT.txt` process on a new held-out set of camera-roll viewpoints. It needs your sign-off, since data_v3 has too few co-located pairs.
4. **P2:** capture a real test spot (several photos of the same static object) before investing more in fusion.
5. **P3:** only if you want generation: a GEN3C run on rented GPUs with the existing adapter.
