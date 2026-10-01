# Rigi next-generation roadmap: after Step Inside

Date: 2026-09-29. This document covers where the "photo → navigable 3D world" line of thinking (world models, splats, multi-view reconstruction) leaves Rigi now that Step Inside has been built and measured. It supplemented an earlier competitive roadmap that is no longer published. The evidence is in `step-inside-results.md`, and the design is in `step-inside-design.md`. For how this fits with the registration research and the launch items, see [status.md](../status.md).

## Bottom line

Rigi's asset is **geometric truth**: a verified camera pose plus the real DEM. Everything learned from a single photo (monocular depth, single-image splats, generated views) was the weak link in every experiment. So the next generation should use learned and generative models as layers **on top of** Rigi's geometry, never as a replacement for it. For world models specifically, that means Rigi supplies the geometry that generation is conditioned on. It does not run a world model of its own.

## What was built (2026-09-28/29)

- **Step Inside** runs in both renderers: near-field Gaussian splats anchored to the DEM, a step-in camera that starts exactly on the photo, a Truth tint on every surface, georeferenced `.ply` and `.splat` export, and a hover readout that works on objects.
  - Near-field service: `tools/nearfield/service` (:8767), with endpoints for depth, Gaussians, multiview and inpainting.
  - Classic view is pixel-identical and eval-app is unchanged.
- **Explorations:** camera-roll fused splats (Brush, DA3), eye refinement, pose propagation, and DEM-conditioned hole-filling with LaMa. The code has adapters for GEN3C and LingBot but they have never been run.
- **Licence survey:** `research_notes/step_inside_models_2026-09.md`. A separate object-completion survey is in `research_notes/{completion_integration,object_completion_models,human_completion_models}_2026-09.md`.

## Evidence

| Idea | Result | What it means for the roadmap |
|---|---|---|
| Single-photo near-field 3D | Works within about 150 m. MoGe-2 compresses range (DEM/model ratio about 6× at 300 m–1 km), so placement needs a per-photo DEM curve plus object grounding. That cuts terrain error from 0.34 to 0.13 (log) | The step-inside moment can ship on accepted photos |
| Depth-only object split (drape smear) | Removes **4% (three) / 15% (deck)** of non-person smear against an **80%** gate. Huts and trees at 100–300 m are classed Far | Needs semantic segmentation plus depth, not a better depth model |
| Anchor fit as a pose check | AUC 0.73 against wrong basins, 0.55 at ±2° | A trust label only, never a gate |
| Multi-view fusion at roll spots | Leave-one-out near-field coverage 0–7%. Rolls rarely share a foreground, and GPS eye error is 7–37 m | Drop as a product goal |
| **Pose propagation** (ALIKED+LightGlue, rotation-only fit) | Median 2.2° on 6 real overlapping pairs. **0 of 83 wrong pairs pass the gate.** Wild dev photo wc_0086 (unsolved by every other method) was **blind-verified correct by 3/3 verifiers**; this is post hoc and n = 1, with a borderline vertical fit | **The one new recall lever.** Recall is the measured bottleneck |
| Generative hole-filling (LaMa) | Thin disocclusions look plausible; large out-of-frame areas smear. Exports and the readout never include generated content (enforced by checks) | Generation pays off exactly where it is least trustworthy |
| DEM-prompted depth (LingBot-Depth-DC) | Interpolates terrain very well; unstable with respect to the prompt's range | Not adopted; could be revisited |

## World models: position

The original pipeline (a world model generates views, VGGT reconstructs geometry from them, splats are fitted) does not fit Rigi:
- **Licensing:**
  - LingBot-World v2 ("Infinity") is CC BY-NC-SA and needs 4–8 GPUs.
  - LingBot-World v1 is Apache-2.0 but 160 GB, and it conditions only on camera pose, so it would invent the mountains.
  - Lyra 2.0 and FlashWorld are non-commercial.
  - HunyuanWorld/Voyager licences exclude the EU.
  - WorldSplat has no released weights.
- **Mismatch:** a generated world is plausible by construction, and Rigi's product is being correct.

**The inversion.** Geometry-conditioned world models (GEN3C, Voyager) take a "3D cache": RGB-D renders along a camera path. Rigi can produce the most accurate such cache there is for a mountain photo: a verified pose, the true DEM, a correctly placed near field, and provenance masks. The cache renderer and the GEN3C request builder already exist (`src/lib/nearfield/generate/`). GEN3C-Cosmos-7B is under the NVIDIA Open Model License, which allows commercial use, and runs on Linux with an Ampere or newer GPU.

- **Rigi's role:** the geometry layer for generative views of real places. The model paints texture; Rigi guarantees the ridgelines.
- **Decisive experiment:** one rented-GPU GEN3C session on 3–5 accepted photos.
  - **Pass:** ridgelines in the generated frames stay within a few pixels of the DEM's projection along the path.
  - **If it passes:** "fly beyond the frame" flyovers, labelled `generated`, as a sharing and marketing feature. Google Earth's image generation can't claim geometric fidelity.
  - **If it fails:** stop. Nothing in the core depends on it.
- **Speculative second use:** a world model as a data engine. It would turn DEM renders into photoreal synthetic photos to mine the hard negatives the terrain-matching research names as its bottleneck (`terrain-matching-research.md`). It is untested; worth one bounded study, not a programme.

## Revised sequence

| # | Item | Gate or decision | Status |
|---|---|---|---|
| 1 | **Pose propagation on camera rolls**: an accepted photo anchors its overlapping neighbours as suggestions, then escalates to accepts after validation | Your sign-off on `tools/nearfield/propagate/PREREG_DRAFT.txt`. It needs a new held-out set of your own camera-roll viewpoints, because data_v3 has too few co-located pairs. Blind protocol, frozen rule | Code and gate built (`src/lib/nearfield/propagate.ts`); suggestion only |
| 2 | **Step Inside v1.1 opt-in beta** (the share moment for the web beta) | Semantic plus depth split, re-measured against the existing blind labels (`tools/nearfield/smear/labels.json`); fix anchoring at cliff lips (IMG_7059) and near the camera (selfies); ship only at anchor quality ≥ 0.35. In Switzerland, also test swissSURFACE3D minus swissALTI3D as the object signal, a study shared with the matcher's near-field failures ([status.md](../status.md)) | v1 built; gate not met |
| 3 | **Object completion** (full 3D for people and huts, not 2.5D shells) | See the object-completion notes. Prerequisite: per-splat group ids (dropped in `scene.ts` today). Keep completed content under the `generated` provenance code so the existing export exclusion applies | Research only |
| 4 | **GEN3C geometry-fidelity experiment** | The pass criterion above, then go or no-go | Adapter ready, never run |
| 5 | **Licensing** | Esri World Imagery and Overpass reviews are still open. SHARP stays dev-only; the commercial default stack is MoGe-2, DA3-Base, LaMa, ALIKED/LightGlue and Brush | Carried over |
| 6 | **iOS rendering path** | Splats add GPU load, so the float-target gap matters more now | Carried over |
| 7 | **Pilots** | A railway or tourism-board summit viewpoint as a navigable, correctly placed scene is now a concrete demo | Carried over |

**Dropped or parked:**
- multi-photo fusion as a product goal
- hosting any world model
- VGGT beyond filing the commercial-checkpoint application
- LingBot-World v2 (non-commercial)
- DEM-prompted depth, until its range instability is solved

## Decisions needed from you

1. Sign-off on the propagation prereg, and which camera-roll viewpoints form the new held-out set.
2. Whether to fund the one-off GEN3C GPU experiment.
3. Whether Step Inside v1.1 goes into the web beta as opt-in, or waits for the smear gate.

## Index

| What | Where |
|---|---|
| Cross-thread status and open decisions | `reports/status.md` |
| Design and results | `reports/step-inside-design.md`, `reports/step-inside-results.md` |
| Model and licence survey | `research_notes/step_inside_models_2026-09.md` |
| P0 spike and placement | `tools/nearfield/spike/{SUMMARY,PLACEMENT}.txt` |
| Smear gate | `tools/nearfield/smear/REPORT.txt` |
| Roll fusion and eye refinement | `tools/nearfield/roll/`, `tools/nearfield/eyes/` |
| Propagation and blind check | `tools/nearfield/propagate/{REPORT,PREREG_DRAFT}.txt`, `verify/RESULT.txt` |
| Generation (P3) | `src/lib/nearfield/generate/`, `/lab/generate?nearfield=gen` |
| End-to-end test | `node scripts/gpu/with-render-lock.mjs -- node scripts/nearfield/step-inside-e2e.mjs [--renderer=deck] [--dead] <ids>` |
