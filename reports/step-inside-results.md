# Step Inside: results

*Build verdict of 2026-09-29 (phases P0–P3 of [step-inside-design.md](step-inside-design.md)); "What runs now" updated 2026-10-02. Plan: roadmap S1–S3 in [roadmap.md](roadmap.md).*

## Verdict

Step Inside works end to end: a photo with an accepted pose gets near-field Gaussian splats placed on the DEM, you step into the photo from its exact camera, and the Truth view tints every surface by source. Georeferenced `.ply` / `.splat-v1` exports carry the anchor quality. Classic stayed pixel-identical and eval-app was unchanged.

The headline product gate is **not met**: on accepted photos the split removes about 15 % (deck; 4 % on the since-removed three.js engine) of the non-person drape smear, against a target of 80 %. Monocular depth cannot separate huts and trees at 100–300 m from the terrain behind them. The P2 multi-view fusion gate is also **not met**. Pose propagation is the clearest win (finding 8).

## What runs now (2026-10-02)

The 09-29 build used a Python near-field service (:8767, MoGe-2 L/B, DA3, LaMa, SHARP behind a dev flag) and three.js plus deck WebGL2 renderers. All of that is gone: three.js removed (583e2b7, dd05828f), service removed (8bb109d0), SHARP dropped (d8e99834).

| Area | Where | State |
|---|---|---|
| Depth + lift | `src/lib/nearfield/local/` | MoGe-2 ViT-S on `src/lib/nn` (WebGPU), compose, lift as a ComputeGraph kernel (ab4485bf, d8e99834). Full network vs PyTorch rel L2 ≤ 2.2e-6 per layer on Dawn (`nearfield-depth-net` check). WebGPU only. int8 weights, prefetch, terrain preview: [step-inside-download.md](step-inside-download.md) |
| Core | `anchor`, `ground`, `split`, `scene`, `near-dem`, `cliff-lip` (opt-in), `object-prior` (`?tiles3dObjects`), `measure`, `provenance`, `splat-io` | Unchanged algorithms from the 09-29 build |
| Renderers | WebGPU: luma.gl splat stack (`deck-webgpu/layers/splats-luma.ts`, 30bb006a), Rigi shader fallback (`splats.ts`); WebGL2: `nearfield/deck-splat-layer.ts` | luma vs CPU twin mean ≤ 0.00052 on Dawn; nothing run in a browser |
| Completion | `nearfield/complete/` (`?nearfield=complete`) | Slab, edge snap, people volumes (optional body fit); LaMa not implemented |
| Roll spots | `nearfield/roll/` | Per-photo depth only (DA3 multiview not ported) |
| Propagation | `roll/propagate/` (ALIKED + LightGlue in the browser, rotation RANSAC) | Suggestion only |
| Live | `nearfield/live` | GPU-only depth → splats for /live (fb6d5e13) |
| Export | `src/lib/export/splat.ts` | `generated` content always stripped |

Status of the whole pipeline: **browser-unverified** (see [batch-ledger.md](batch-ledger.md)).

## Key findings

1. **Monocular metric depth can't place splats directly.** MoGe-2 (ViT-L/B, measured via the old service; ViT-S in the browser is not re-measured) compresses range. The DEM/model ratio is about 1 at 20 m, 2.9 at 100–300 m, and 6.6 at 300–1000 m. A single scale has a median terrain error of 0.34 (log) at 15–500 m.
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

## Licences

Shipped: MoGe-2 ViT-S (MIT), ALIKED (BSD-3), LightGlue (Apache-2.0). Used in the 09-29 study only: DA3-Base (Apache), LaMa (Apache), Brush (Apache), SHARP (research-only, dropped). Avoid LingBot-World v2 (NC), DA3 Giant Gaussian head (NC), MASt3R (NC), HunyuanWorld (excludes the EU); VGGT-1B-Commercial needs a gated application. Register: [licences.md](licences.md); model notes: `research_notes/step_inside_models_2026-09.md`.

## Regression gate (final run, 2026-09-29, before the browser port)

tsc clean; check suites nearfield 41, spot 22, eyes 17, generate 38, export 46, propagate pass; style-baseline 16/16; eval-app 12/14 within 1° (median 6.5 px, unchanged); deck-engine-smoke 4/4; e2e on both renderers and with the service dead pass. None of this has been re-run on the in-browser pipeline.

## Next steps (status 2026-10-02)

1. **Smear gate:** semantic plus depth split, a permissive segmenter marking buildings, trees and poles as Object; re-measure on `tools/nearfield/smear/labels.json`. Open (roadmap S1; shortlist `research_notes/segmenter-shortlist-2026-10-02/`).
2. **Anchoring at cliff lips and near-camera ground** (IMG_7059, 7063). Opt-in rule built (`nearfield/cliff-lip.ts`, `?anchorCliff=on`), not yet evaluated as a default.
3. **Propagation:** run `tools/nearfield/propagate/PREREG_DRAFT.txt` on a held-out roll set. Needs owner sign-off (roadmap R5).
4. **P2:** capture a real test spot before investing more in fusion. Dropped as a product goal.
5. **P3:** generation only via a GEN3C run on rented GPUs (roadmap L8); the in-app adapter was removed with three.js.
