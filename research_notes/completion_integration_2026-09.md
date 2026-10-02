# Step Inside: object and background completion, integration study

Date: 2026-09-29. Scope: how near-field objects are represented today, where a "completion" step plugs in, cheap (non-learned) completion strategies, and a phased plan with evaluation. This is a codebase study plus design research. No code outside this file was changed.

Trigger: a screenshot from a moved Step Inside camera showed three problems:
- a posing woman rendered as a thin front shell, with no back and a smeared hair edge;
- a large hole in the grass behind and under her;
- meadow "slabs" with gaps between them.

Sources read: `reports/step-inside-{design,results}.md`, `src/lib/nearfield/{types,split,lift,ground,scene,provenance,measure,controller,deck-step,three-splats,deck-splat-layer}.ts`, `src/lib/nearfield/generate/**`, `src/lib/segment.ts`, `tools/nearfield/service/{app,splat,inpaint}.py`, and the drape masking code in `engine.ts` and `deck/engine.ts`.

> **Update (2026-10-01):**
> - Built 2026-10-02 (pod F f3, `?nearfield=complete`, display-only, browser-unverified): `src/lib/nearfield/complete/` with slab diagnosis + Object-to-Terrain reclassification (§1.4/§2.6a), mixed-depth edge snap and soft rim alpha applied in the client `liftToGaussians` (§2.1 bullet 1), `completeScene` called from `controller.build()`, and `assertCompletionNotMeasurable`/`appendCompletionSplats` guards with specs. Not built: identity plumbing (`group`), behind layer (stub throws; blocked on status.md decision 6), shell thickening, and edge snap for the service `/gaussians` cloud.
> - (Earlier, before that:) Nothing here is built: there is no `src/lib/nearfield/complete/`, and `?nearfield=` accepts only `auto|on|sharp|off` (`src/lib/flags/index.ts`). Status: roadmap S2.
> - The three.js engine was removed (583e2b7), so `engine.ts` and `materials.ts` are gone. Drape-side work (§2.5 option ii) would now touch `deck/terrain-layer.ts` and `deck-webgpu/layers/drape.ts`. Option B's tint-table edits apply to `deck-splat-shaders.ts`/`deck-splat-layer.ts` and to the WebGPU `SPLAT_TINTS` in `deck-webgpu/layers/splats.ts` (also hard-sized to 4); `three-splats.ts` remains only for `/lab/splats` and the P3 cache renderer. `isMeasurable` is still a deny-list and `measure.ts` still tests `=== generated`.
> - The sibling surveys disagree with this note on gates: the completion-hide threshold here is IoU < 0.8 or depthResLog > 0.15; `object_completion_models_2026-09.md` §4.1 and `human_completion_models_2026-09.md` §4 use IoU < ~0.6 (uncalibrated), with minimum sizes of 96–128 px (objects) and 60 px (people). The human note also proposes a separate "3D person" Truth class, which is option B here. Settle both in the P0 prereg.
> - Of the §3 P1 candidates, `object_completion_models_2026-09.md` found Amodal3R non-commercial (S-Lab License); SAM 3D Objects and SAM 3D Body are commercial-OK under the SAM License but gated.

---

## 1. How objects are represented today

### 1.1 No instance segmentation, only a semantic person mask plus depth components

| Signal | Where | What it is |
|---|---|---|
| People mask | `src/lib/segment.ts` → `engine.foregroundMask` / `DeckEngine.foregroundMask` | MediaPipe ImageSegmenter, `selfie_multiclass_256x256` (default) or `deeplab_v3` (VOC class 15). Soft 0..255, long side 512. **Semantic, not instance**: all people share one mask. |
| Sky mask | `src/lib/sky` (U²-Net) → `skyMaskData` | P(sky) |
| Depth split | `split.ts splitPixels / classifyRange` | Per-cell `PixelClass` (Sky/Terrain/Object/Far/Unknown), computed by comparing the anchored MoGe-2 range with the DEM range. The people mask forces Object. |
| "Objects" | `ground.ts groundObjects` | **4-connected components of Object cells** on the depth grid, split wherever model depth jumps by more than `maxLogStep` = 0.5 (log). Each `GroundedComponent` has an id, cell count, bbox, contacts, a grounding `factor` (DEM metres per model unit), `recede`, and `dropped: "notUpright"`. `promoteFarObjects` appends Far components (skyline trees, huts up to 600 m) with `far: true`. |

So an "object" is currently a depth-connected blob, not a semantic instance:
- A person touching a fence at the same depth becomes one component.
- A person whose depth ramps into the grass can leak into it.
- The results doc (next step 1) already recommends a permissively licensed semantic/instance model. No SAM/BiRefNet/matting model is in the service today.

### 1.2 Per-object Gaussian groups are not kept

- `buildNearFieldScene` (`scene.ts`) computes the `GroundResult` (labels per cell and components), uses it to place Gaussians, and then **discards it**. `NearFieldScene` carries only `{photoId, anchor, split, splats, confidenceRadius, model}`.
- `GaussianCloud` has no per-splat object id. The only optional per-splat array is `source?: Uint16Array` (the camera-roll photo index).
- Per-object grounding exists: each component is scaled about the camera by `factor` = the median DEM range divided by the model ray at its ground contacts (`placedRange`, `placedDepth`). This happens:
  - in `anchorAndFilterCloud` for the service cloud (`cellAt` maps each Gaussian to its depth cell and so to its label);
  - in `placedDepth → liftToGaussians` for the client lift.
- That per-Gaussian → cell → label mapping is exactly where a group id could be recorded for free.

### 1.3 Provenance

- `types.ts`: `Provenance = observed | reconstructed | dem | generated`, with codes 0..3, one `Uint8` per splat.
- The service's `/gaussians` lift tags its output `reconstructed` (`splat.py`); the client `liftToGaussians` defaults to `observed`.
- P3 LaMa hole-fill splats are `generated` (`generate/holes.ts liftGenerated`).

**The rule that generated content never reaches exports or the hover readout** is enforced in four places:
1. `provenance.ts isMeasurable` (known code and not `generated`) and `filterForExport`. All exporters go through it (`src/lib/export/splat.ts`).
2. `generate/readout.ts readoutHit`: the pick ray passes through non-measurable splats.
3. `measure.ts buildMeasureGrid`: it skips `provenance === PROVENANCE_CODE.generated`. Note that this is an **equality test, not `isMeasurable`**.
4. Tests: `export-check.ts` and `generate/generate.check.ts` ("generated splats NEVER reach a measurement export").

**Caveat for any new provenance code.** `isMeasurable` is written as a deny-list: a new known code such as `completed = 4` would count as *measurable* and leak into exports. `measure.ts` would also bin it, because it only excludes code 3. Both renderers also hard-size the Truth tint table to 4 entries:
- three: `uniform vec3 truthColors[4]` in `three-splats.ts`;
- deck: `PROVENANCE_TINTS` built from `[0,1,2,3]` and `tint0..tint3` in `deck-splat-shaders.ts`.

See 1.5 for the recommendation.

### 1.4 What the screenshot artefacts map to in code (diagnosis)

**Thin front shell.** Both lifts put exactly one Gaussian per stride cell on the visible surface: the service `splat.lift_gaussians` (the default `/gaussians model=lift`) and the client `lift.liftToGaussians`. With normals, each Gaussian is a disc flattened to 0.15σ along the normal. Nothing exists behind the surface.

**Smeared hair edge.**
- The service culls flying pixels with `edge_ratio=1.5` (3×3 max/min on the stride grid). The client uses `edgeLog=0.1` against 4 neighbours.
- MoGe-2 smooths the fg/bg transition over several cells, so each step of the ramp is below the threshold and survives. You get a sheet of intermediate-depth Gaussians coloured with a hair/grass mix, and it stretches visibly when the camera moves.
- Boundary splats are also fully opaque (alpha 255) and take the block's mean colour, so there is no matting and no colour decontamination.

**Hole in the grass behind and under her.**
- While stepping, the drape masks Object pixels that splats cover: `deck-step.stepMasks().step` / `engine.ts masks.step` feeds `uPhotoFg`, and `materials.ts` sets `visible=false`.
- The DEM geometry behind her is exact, but it has **no texture** (the photo never saw it). From a moved camera you see the fallback imagery or shading there.
- Nothing fills that region today. P3's LaMa fill runs only in `/lab/generate`, per novel view.

**Meadow slabs with gaps.** Most likely near-camera ground cells classed **Object**:
- The rule `range < dem·0.5` with a gap of at least 3 m trips at terraces and cliff lips (compare the IMG_7059 regression). It also trips where the z16 near DEM puts the ground lower than MoGe does.
- Those cells are lifted as flattened discs. At grazing incidence the in-plane stretch is capped (client `min(2, sqrt(1/cos))`, service `max_stretch=4`), which is far short of 1/cos ≈ 10–20 for ground a few metres below a 1.6 m eye. Rows of discs therefore separate into slabs once you leave the photo camera.
- Stride-2 edge culling on steep depth gradients removes whole rows.

**To confirm:** check the scene in the Truth view and dump `split.cls` for that photo. If the meadow is Object, the fix is in split/ground (reclassify near ground as Terrain so the exact DEM drape renders it), not in completion.

### 1.5 Where completion plugs in (exact points)

| Step | File / function | Why there |
|---|---|---|
| **A. Keep object identity** | `scene.ts anchorAndFilterCloud`: record `g.labels[cell]` for each kept index into a new optional `group?: Uint16Array` (component id + 1, 0 = none). `lift.ts liftToGaussians`: the same from the `GroundResult` labels. `buildNearFieldScene`: return `ground` (labels + components) on the scene. | The mapping from Gaussian → cell → component already exists at these points and is thrown away. |
| Carry `group` through | `provenance.ts selectSplats`, `lift.ts toEnu`, `generate/holes.ts mergeClouds`, `splat-io.ts` (flag bit 2, as `source` uses bit 1) | These are the copy paths that already carry `source`. |
| **B. Cheap edge cleanup (P0)** | Service `splat.lift_gaussians` (it produces the default cloud) plus the client `liftToGaussians`, **before** Gaussians are created | Mixed-depth snapping, alpha and decontamination must happen per pixel. |
| **C. Completion step** | New module `src/lib/nearfield/complete/` with `completeScene(scene, ctx, photo, opts): Promise<CompletedScene>`. Call it from **`controller.ts build()` right after `buildNearFieldScene(...)` and before `buildMeasureGrid`**. | `buildNearFieldScene` is synchronous and deterministic, which the checks rely on. Completion needs the service (inpaint / learned models), so it belongs in the async controller. Cheap heuristics can also be a pure sync helper called from there. Put it behind a flag (`?nearfield=complete`), as `GENERATE_FLAG` is. |
| **D. Background layer** | Same place (controller), using the existing `/inpaint` (`generate/inpaint-client.ts inpaint`). The result either (i) becomes DEM-backed `generated` splats via a photo-space variant of `holes.ts liftGenerated`, or (ii) becomes a "behind" photo texture sampled by the drape where `uPhotoFg` is set. | (i) needs no renderer change. (ii) is cleaner but touches `materials.ts` and `deck/terrain-layer`, which are lead-owned. |
| **E. Learned per-object completion (P1)** | A new service endpoint `/complete` (multipart: image, instance mask, optional depth crop) returning `.splat-v1` in an object frame plus metadata. Client alignment lives in `complete/align.ts`. | This follows the service pattern and uses the shared GPU lock. |
| Guards | `provenance.ts`, `measure.ts`, `readout.ts`, `export-check.ts`, `generate.check.ts` | See the contract below. |

### 1.6 Contract (types.ts) additions, additive only

```ts
// Provenance: two options.
// (A, recommended for P0/P1) completion output uses the EXISTING code `generated` (3). All four guards and
//     both shader tint tables hold with zero edits. The finer "kind" rides in CompletedObject.method and in
//     an optional per-splat array.
// (B) add `completed` (4): "model/heuristic-completed, not observed". This needs (1) isMeasurable changed to
//     an ALLOW-list {observed, reconstructed, dem}, (2) measure.ts switched to !isMeasurable, (3) truthColors[5]
//     in three-splats.ts and tint4 in deck-splat-shaders/deck-splat-layer, (4) a PROVENANCE_COLORS entry,
//     (5) export-check cases. Worth it only if the Truth view must tell "invented background" apart from
//     "completed back of an observed object".

export type GaussianCloud = {
  // ...existing...
  /** Optional per-splat object group: 0 = none, else SceneObject.id + 1. */
  group?: Uint16Array;
};

export type CompletionMethod =
  | "shell-thicken"     // inflated back from the silhouette distance transform
  | "revolve"           // surface of revolution (trees)
  | "proxy-hut" | "proxy-template"
  | "behind-fill"      // LaMa on the photo, lifted on the DEM
  | "learned";         // P1 model (name in `model`)

export type SceneObject = {
  id: number;                    // = GroundedComponent.id
  bbox: [number, number, number, number]; // depth-grid cells
  cls?: "person" | "building" | "tree" | "animal" | "rock" | "vehicle" | "unknown";
  grounded: boolean;             // factor != null
  contactEnu?: [number, number, number]; // median ground contact
};

export type CompletedObject = {
  objectId: number;              // SceneObject.id
  method: CompletionMethod;
  model?: string;                // "sam3d-objects", "trellis", … (export licence)
  provenance: "generated";       // (or "completed" under option B); never measurable
  /** Object frame → ENU similarity: p_enu = s·R·p_obj + t. Identity for heuristics built in ENU. */
  align: { s: number; R: number[]; t: [number, number, number]; dof: "sim3" | "yaw+s+t" };
  /** 0..1 overall; the UI hides completions below a threshold. */
  confidence: number;
  diag: {
    maskIoU?: number;            // render-and-compare IoU in the photo view
    depthResLog?: number;        // median |log(obj depth / observed depth)| on visible pixels
    groundGapM?: number;         // lowest point vs DEM at the footprint
    yawAmbiguity?: number;       // best / second-best alignment cost
  };
  /** Index range of its splats in the scene cloud (appended after the observed ones). */
  splats: { start: number; count: number };
};

export type NearFieldScene = {
  // ...existing...
  objects?: SceneObject[];
  completions?: CompletedObject[];
};
```

Invariants for tests (extend `generate.check.ts` / `export-check.ts`):
1. Every splat with `group` whose index lies in a `CompletedObject.splats` range has a non-measurable provenance.
2. `filterForExport(scene.splats)` removes all completion splats.
3. `buildMeasureGrid` / `readoutHit` never return one.
4. **Source-view invisibility:** no completion splat is visible from the photo camera, meaning its z is at least the observed z plus a margin at its pixel, or it falls outside any Object cell. The photo view and the step start frame therefore stay identical.
5. No completion splat is below the DEM by more than ε.

---

## 2. Cheap completion strategies (non-learned or small-model)

Quality is judged at Step Inside's actual operating point. The confidence radius is `min(60, 0.5·median range)+10` m. A subject at 5–20 m can therefore be orbited by roughly 30–120°, so backs and sides **will** be seen; completion is not optional for near subjects.

### 2.1 Edge-halo cleanup (hair, depth discontinuities): P0, highest value per effort

- **Mixed-depth snapping rather than culling.** In a 5×5 window around each depth edge (|∇log z| above a threshold), fit two modes (fg = low percentile, bg = high percentile). Snap every cell to its nearer mode, or drop it if it lies in the middle third of the ramp. This is the "depth edge sharpening" step that 3D Photo Inpainting applies before layering (Shih et al. 2020, bilateral-median depth plus discontinuity linking). It removes the stretched sheet between hair and grass.
- **Soft alpha on the boundary.** Use a soft mask as Gaussian opacity on the one-to-two-cell rim. That can be the MediaPipe mask (already soft 0..255) or, better, a matting pass: BiRefNet, ViTMatte or MatAnyone (licences to verify). Shrink the rim splats' σ to about 0.3 of a block. SLIDE (Jampani et al., ICCV 2021) shows that soft layering with a matte keeps hair detail that hard depth layering destroys.
- **Colour decontamination.** For rim splats set F = (I − (1−α)·B) / α, with B taken from the inpainted background layer (2.4), so hair no longer carries grass colour.
- HairGuard ("Guardians of the Hair", arXiv 2601.03362) is a learned depth-fixer for exactly these soft boundaries. Evaluate it in P1 if the heuristic is not enough.
- **Expected:** the smear disappears; hair reads as a slightly soft silhouette. It is nearly free (pure numpy/TS), and the photo view is unchanged if rim alpha matches the source.

### 2.2 Shell thickening / silhouette inflation (backs of people, animals, rocks, bushes)

1. Take the object's instance mask. Today that is a component of `ground.labels` intersected with the people mask; later it comes from an instance model.
2. Compute the 2D distance transform `d(u,v)` to the silhouette and its maximum `d_max`, which is roughly the half-width.
3. Define a local thickness from a circular cross-section (Teddy / Repoussé / Monster Mash style inflation): `t(u,v) = 2·sqrt(d·(2r − d))`, with r = the local half-width in metres (the pixel width at the placed depth). Clamp it with a class prior; for a person, torso depth ≈ 0.55 × shoulder width.
4. Place the back surface at `z_back = z_front + t`. Along the rim (`d` → 0) front and back meet, and side splats fill the rim so the silhouette closes.
5. **Back texture:** do not mirror the front, which would put a face on the back of a head. Use the per-row median colour of the object's pixels, darkened 15–25% and blurred. For people, optionally split into hair and clothes by the multiclass mask classes; `selfie_multiclass` has hair, body-skin, face-skin and clothes classes.
6. Label every added splat `generated`, `method: "shell-thicken"`.
7. **Expected:** plausible up to about 60–90° of orbit. At 180° it looks like a "puppet": the right volume and silhouette with no detail. That is a big step up from a paper cut-out. Photo Wake-Up (Weng, Curless, Kemelmacher-Shlizerman, CVPR 2019) used the same idea for people: a template body warped to the silhouette, with a back texture synthesised from the front.

### 2.3 Silhouette extrusion / "visual hull" from one view

With one view, the visual hull is the silhouette cone, which is unbounded along the ray. The only single-view version is **extrusion to an assumed extent**: a generalised cylinder of depth ≈ width × class aspect.
- It is worse than 2.2 for organic shapes (flat back, hard edges) and fine for boards, signs and walls.
- Multi-view visual hulls (Laurentini 1994) become useful only at real roll spots, where the P2 findings show near-field overlap is currently 0–7%.

### 2.4 Per-class procedural proxies

These are cheap once the class is known, and the class is the missing piece (see 3).

- **Trees (conifers): surface of revolution.**
  - Axis = vertical (ENU up) through the trunk base, which is the ground contact from `ground.ts`.
  - Radius per height row = half the silhouette width; colour per row from the visible pixels.
  - Near-perfect for spruce and larch, the dominant Alpine trees. Broadleaf trees are fine with an ellipsoid.
- **Huts and buildings.**
  - Footprint front edge = the ground-contact line (`ground.ts` contacts, already in ENU through placement).
  - Depth = width × a prior (0.8–1.2, or from swisstopo / OSM building footprints if you want truth; the repo already caches Overpass data under `tools/bench/harness/out/cache/overpass`).
  - Walls as a box from the DEM at the footprint up to the eave line seen in the photo; a gable roof from the visible roofline, mirrored about the ridge.
  - Facades: repeat the visible facade texture on the hidden walls (darkened).
  - **An OSM/swisstopo footprint makes the geometry mostly real**: the vertices are measured, not guessed. It could then earn `reconstructed` rather than `generated` for the walls only, as a separate decision.
- **Cows / people.** A generic template (an SMPL-like body or a quadruped mesh) scaled to the silhouette height is rigid and looks wrong under pose mismatch. Prefer 2.2 in P0 and a learned body model in P1 (SAM 3D Body; see the other agents' survey).
- **Rocks / boulders.** Inflation (2.2) with a flatter prior works; so does a convex hull of front points extruded to a DEM-contact base.

### 2.5 Background disocclusion fill: the "behind" layer

This is the fix for the hole in the grass, and the best honesty/quality trade in the whole list: **the geometry is the true DEM and only the texture is generated.**

1. Mask = the Object cells covered by splats (`stepMasks().step`), dilated by 3–5% of the object size, at photo resolution.
2. Run LaMa once, **in photo space**, via the existing service `/inpaint` (`composite=1` keeps every other pixel bit-exact). This is the layered-depth-image idea (Shade et al. 1998; Shih et al. 2020, with context and synthesis regions): the background layer behind a depth edge is inpainted from its surrounding context.
3. Put it into the world in one of two ways:
   - **(i) Splats.** Lift the filled pixels at the **DEM range** (`demGrid`, which is exact) as flat discs on the local DEM plane: `generated`, `method: "behind-fill"`. This reuses the `holes.ts liftGenerated` logic, which already builds DEM-backed discs and never floats. There is no renderer change. The drape stays masked there, so nothing z-fights.
   - **(ii) Drape.** Pass the filled photo as a second drape texture sampled where `uPhotoFg` masks. It is cleaner (no stride artefacts, drape resolution), but it touches `materials.ts` and deck `terrain-layer` (app-pipeline-owned). Truth tint needs a "generated drape" colour there.
4. **Ground under objects:** already the DEM. With the fill it gets texture too. For objects whose ground contact is not DEM terrain (a person on a bench or a terrace the DEM lacks), extend the contact surface as a plane fitted to the model depth just below the object.
5. **Object behind object** (a person in front of a hut): LDI-style. Extend the *background object's* depth into the occluded region by edge-aware diffusion from its visible side, and inpaint colour. Do this only when both are Object components and the far one is grounded.
6. **Expected:** from P3, "LaMa fills thin disocclusions plausibly and smears large areas outside the frame". The behind-object regions here are thin and bounded (one person-width of grass, surrounded by context on all sides), which is LaMa's good case. Doing it once in photo space is better than P3's per-novel-view fill, because the fill is consistent across views and costs about 0.3 s on MPS.

### 2.6 Near-ground "meadow slabs"

This is not a completion problem; see 1.4. Options, in order:
- (a) reclassify near ground as Terrain (so the exact DEM drape renders it); tighten the split for cells within a few metres below the horizon line whose model normal is roughly up;
- (b) when ground must be splats, lift with an uncapped in-plane stretch derived from the DEM plane, as `liftGenerated` already does for DEM discs;
- (c) raise the service `max_stretch` for up-facing normals only.

### 2.7 Summary table

| Strategy | Cost | Fixes | Quality from a moved camera | Risk |
|---|---|---|---|---|
| Edge snap + soft alpha + decontam | hours, pure numpy/TS | hair smear, floaters | high | low (the photo view can stay exact) |
| Behind layer (LaMa on photo → DEM splats) | ~1 day, existing `/inpaint` | hole in the grass | high for thin regions, mediocre for large ones | texture only is invented |
| Shell thickening (DT inflation) | ~1–2 days | paper-thin people, rocks | good ≤ 60–90°, puppet at 180° | back colour guessed |
| Tree revolve | ~0.5 day, given the class | flat trees | high for conifers | needs a class |
| Hut box + gable (+ OSM footprint) | ~2 days | flat huts | good | needs a class; footprint prior |
| Template body | days | people | poor without pose fitting | uncanny |
| Learned (P1) | GPU service | everything | best | licence, alignment, CUDA-only models |

---

## 3. Recommended phased plan

### P0: cheap heuristics (about 1 week, flag `?nearfield=complete`)

0. **Diagnose the slabs first** (Truth view plus a `split.cls` dump for the screenshot photo). Fix them in split/lift if they are Object ground (2.6).
1. **Identity plumbing:** add `group` in `anchorAndFilterCloud` / `liftToGaussians`, carry it through `selectSplats`, `toEnu`, `mergeClouds` and `splat-io`, and put `scene.objects` on the scene. Add a class per object, cheaply: people mask overlap gives `person`; for the rest, a small semantic model the results doc already asks for (smear gate step 1). One model serves both the smear gate and completion.
2. **Edge cleanup** (2.1) in `splat.lift_gaussians` and `lift.liftToGaussians`.
3. **Behind layer** (2.5, option i) in `controller.build()` after `buildNearFieldScene`.
4. **Shell thickening** (2.2) for `person`/`animal`/`rock`/unknown upright grounded components; **revolve** (2.4) for `tree` when a class exists.
5. **Guards:** decide the provenance option (A recommended) and add the invariants in 1.6 to `generate.check.ts` / `export-check.ts`. Add a source-view identity check: step start frame vs photo view, as style-baseline does.

**P0 exit gate** (pre-registered):
- novel-view hole fraction reduced by 50% or more at 0.5× confidence radius on the dev set;
- no degradation of the source view;
- all guards pass;
- blind judges prefer P0 over baseline in 70% or more of pairs (see Evaluation).

### P1: learned per-object completion (model to be chosen from the parallel survey)

- **Candidates (placeholder):**
  - SAM 3D Objects: full geometry, texture and layout from a masked object, occlusion-robust;
  - SAM 3D Body: people;
  - TRELLIS / TRELLIS.2;
  - Amodal3R (ICCV 2025: amodal 3D reconstruction from occluded 2D images, built on a 3D generative foundation model);
  - TripoSplat (MIT, object-centric 3DGS).
- Licence and MPS/CUDA feasibility must be verified; `research_notes/step_inside_models_2026-09.md` is the ledger.
- For amodal cases (a person behind a fence), prefer models trained with occlusion (SAM 3D Objects, Amodal3R) over running 2D amodal completion and then 3D.
- **Service contract:** `/complete` takes the image, an instance mask, and optionally a depth crop and class. It returns `.splat-v1` in the model's object frame plus `{model, licence, seconds, score}`. The `generated` code is set on every splat by the service. Cache per photo + mask hash, following the `cache.py` pattern.
- **Instance masks:** SAM 2 (Apache-2.0) with point/box prompts from `ground.ts` components (bbox plus the component's centroid as a positive point) turns depth blobs into clean instances. SAM 3 (text prompts: "person", "hut", "tree", "cow") would supply class and instance at once; verify its licence.
- **Policy:** keep the observed front shell and add only the completed splats that are **not visible from the photo camera** (1.6 invariant 4). Generated content never overrides what the photo saw. The completed object's visible part serves only for alignment and is then discarded.

### Alignment (P1; also used to validate P0 proxies)

1. **Init.**
   - Translation = the object's placed centroid (grounded factor).
   - Scale = the mask's metric height at the placed depth divided by the model object's height.
   - Rotation: gravity-aligned. Up = ENU z (Alpine objects are upright), so search **yaw only** over 8–12 hypotheses; there are no pitch or roll degrees of freedom unless the class is "rock".
2. **Correspondences.** Render the completed object's front-surface depth from the photo camera. Pair each observed Object pixel's placed 3D point with the rendered surface point on the same ray, or use nearest-neighbour ICP in 3D.
3. **Solve.** Solve a similarity by **Umeyama** (1991) inside trimmed ICP, restricted to yaw + scale + translation (5 DoF) with an optional full Sim(3) refinement at the end. Use a robust (Huber / trimmed 20%) loss because the observed front has edge noise.
4. **DEM grounding term.** Penalise the gap between the object's lowest vertices at the footprint and the DEM height (`near-dem.ts` heights). Hard-constrain the object to not sink below the DEM by more than 5 cm. Grounding is Rigi's unique advantage: the scale ambiguity of object-centric models is removed by the DEM contact, exactly as `groundObjects` does for the front shell.
5. **Render-and-compare.** Measure silhouette IoU against the instance mask and depth residual `median |log(z_obj/z_obs)|` on visible pixels. Optionally refine with a differentiable silhouette loss (yaw/scale only).
6. **Confidence** = f(IoU, depth residual, yaw ambiguity, model score). Hide a completion below a threshold (proposal: IoU < 0.8 or depthResLog > 0.15), falling back to P0 shell thickening.

### Evaluation

1. **Novel-view hole fraction** (automatic, no ground truth).
   - Render with the existing `generate/cache-render.ts CacheRenderer.renderView` along `generate/trajectory.ts makeTrajectory` cameras at 0.25/0.5/1.0 × `confidenceRadius`, in pivot mode so the subject stays in frame.
   - Report `holes.ts holeStats.holeFrac` before and after completion, split into "behind-object" holes (DEM-backed) and "object-interior" holes (see-through the shell).
2. **Silhouette consistency from moved cameras.**
   - Self-consistency: the completed object's projection into the source view must equal the instance mask (IoU ≥ 0.9). From orbit views the silhouette must stay closed: no see-through pixels inside its convex hull, measured by splat coverage.
   - **Real ground truth** needs a captured test spot: several posed photos of the same static hut/tree/person. The results doc already asks for this (next step 4), and the Niederhorn spot has no shared near field. Leave-one-out: complete from photo A, render at photo B's pose, compare IoU with B's instance mask and LPIPS in the mask.
   - A synthetic proxy until then: objects with known 3D (e.g. OSM-footprint huts, or rendered assets) placed on the DEM in the lab scene.
3. **Guards:** zero completion splats in exports, the measure grid or the readout; zero visible completion splats in the source view; floater rate = the share of completion splats more than 0.5 m above any support or below the DEM.
4. **Blind visual judging**, as the repo already does for pose verification (`tools/bench/harness/verify_pack.ts`; the wild benchmark's 3-judge blind packs).
   - Pairs rendered from identical moved cameras: baseline vs P0, and P0 vs P1, in randomised left/right order with method names hidden.
   - Judges answer "which looks more like the real scene / fewer artefacts" and flag "invented content misleading".
   - Pre-register the photos (dev split only), the cameras and the accept threshold before rendering.
   - Keep test photos untouched, per the frozen dev/test rule.
5. **Performance:** P0 must add ≤ 1.5 s to a cold build (LaMa ~0.3 s on MPS, plus inflation in TS) and keep 60 fps at 200k splats. Completion must add fewer than about 30% more splats.

---

## Literature

- Shih, Su, Kopf, Huang, *3D Photography using Context-aware Layered Depth Inpainting*, CVPR 2020: https://arxiv.org/abs/2004.04727. Covers LDIs, depth-edge linking, and context and synthesis regions.
- Jampani et al., *SLIDE: Single Image 3D Photography with Soft Layering and Depth-aware Inpainting*, ICCV 2021: https://arxiv.org/abs/2109.01068. Soft layering keeps hair; modular with segmentation and matting.
- Shade, Gortler, He, Szeliski, *Layered Depth Images*, SIGGRAPH 1998.
- Niklaus et al., *3D Ken Burns Effect from a Single Image*, SIGGRAPH Asia 2019: https://arxiv.org/abs/1909.05483. Segmentation-aware depth adjustment plus context-aware inpainting.
- Weng, Curless, Kemelmacher-Shlizerman, *Photo Wake-Up*, CVPR 2019: https://arxiv.org/abs/1812.02246. Template body warped to the silhouette, with a synthesised back.
- Igarashi et al., *Teddy*, 1999; Joshi & Carr, *Repoussé*, 2008; Dvorožňák et al., *Monster Mash*, SIGGRAPH Asia 2020 (https://igl.ethz.ch/projects/monster-mash/). All silhouette inflation.
- Laurentini, *The Visual Hull Concept for Silhouette-Based Image Understanding*, TPAMI 1994.
- Umeyama, *Least-squares estimation of transformation parameters between two point patterns*, TPAMI 1991.
- PIFuHD / ICON / ECON / SiTH: front and back normal hallucination for clothed humans; the back is the hallucination-prone side (https://arxiv.org/html/2311.15855).
- Wu et al., *Amodal3R*, ICCV 2025: https://arxiv.org/abs/2503.13439.
- Meta, *SAM 3D: 3Dfy Anything in Images* (Objects + Body), Nov 2025: https://ai.meta.com/research/publications/sam-3d-3dfy-anything-in-images/.
- *Guardians of the Hair* (HairGuard), 2026: https://arxiv.org/abs/2601.03362. Soft-boundary depth fixing for novel views.
- *Complete Gaussian Splats from a Single Image with Denoising Diffusion Models*, 2025: https://arxiv.org/abs/2508.21542. Occluded-surface completion as splats.
- *PhGS: Post-hoc Pruning and Refinement of Single-View Feed-Forward 3D Gaussians*, 2026: https://arxiv.org/abs/2609.20623. Useful for splat-budget control after completion.
- Ye et al., *Gaussian Grouping*, ECCV 2024: https://arxiv.org/abs/2312.00732. Per-object identity on Gaussians, the model for the `group` array.
