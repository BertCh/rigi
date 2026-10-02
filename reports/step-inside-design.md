# Step Inside: a design for georeferenced 3D photos

*Design of record, written 2026-09-27, built 2026-09-29, updated 2026-10-02 to the in-browser pipeline. Results and gate outcomes: [step-inside-results.md](step-inside-results.md). Plan: roadmap S1–S3 in [roadmap.md](roadmap.md). 3D Tiles: [step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md).*

## Thesis

Apple's Spatial Scenes and SHARP-type models taught people to expect that a photo can "become 3D". Those systems invent the geometry: plausible parallax, but no true scale and no place in the world. Rigi has the opposite problem. It knows the true camera (metric ENU pose, intrinsics, confidence) and the true terrain beyond about 200 m, and lacks the near field: people, huts, trees, boulders, the ridge you stand on. That is why the In map drape smears them across the ground.

**Step Inside fuses the two.** A monocular depth model reconstructs the near field, the DEM provides the far field, and Rigi's solved pose anchors both in real coordinates. Every rendered surface carries a label for where it came from. It is the only photo-to-3D whose output is at the right scale, in the right place, and honest about which parts are real.

## Architecture (current)

Everything runs in the browser; there is no near-field service (removed 8bb109d0).

```
photo + solved pose (accepted only)
        │
        ▼
 nearfield/local/client.ts (LocalNearFieldClient, the default nearField source)
   decode + resize in the page
   MoGe-2 ViT-S on src/lib/nn (WebGPU)  ── nearfield/local/depth-net.ts, weights MOGE2_WEIGHTS
   compose (focal/shift, normals)       ── local/compose.ts, focal-shift.ts
   depth lift as a ComputeGraph kernel  ── local/lift-gpu.ts
        │  camera-frame Gaussians, approximately metric
        ▼
 DEM anchoring (anchor.ts, ground.ts, near-dem.ts; opt-in cliff-lip.ts)
   1. camera frame → ENU with the solved pose
   2. monotone log-log range curve fitted per photo on DEM terrain pixels
      (not sky, not people, range < 2 km); objects re-grounded on the DEM
   3. residual → anchor quality (trust label only, not a pose verifier)
        │
        ▼
 depth split per pixel / per Gaussian (split.ts, scene.ts)
   predicted ≈ DEM range  → TERRAIN  (dropped; the DEM drape renders it)
   predicted ≪ DEM range  → OBJECT   (kept: people, huts, trees, rocks)
   sky mask               → SKY      (photo on a far sphere)
   beyond the near radius → FAR / DEM only
   optional: ?tiles3dObjects=on nDSM object prior (object-prior.ts)
        │
        ▼
 renderers: DEM terrain + drape + splats + sky shell
   WebGPU: luma.gl splat stack (deck-webgpu/layers/splats-luma.ts: LoD tree from
           nearfield/splat-lod.ts, RAD selection, GPUPagedSplatRenderer; 30bb006a),
           Rigi shader (splats.ts) as fallback and via ?splatRenderer=rigi
   WebGL2: nearfield/deck-splat-layer.ts (terrain's log gl_FragDepth)
 provenance per surface: observed | reconstructed | DEM | generated
```

Availability: `available()` needs WebGPU compute and reachable weights; otherwise the panel says "Step Inside needs WebGPU and its depth model" (`controller.ts`). There is no CPU depth path (accepted under "WebGPU primary"). Weights download as int8 by default (`?nearfieldWeights=q8|q8lite|fp16`), are prefetched after a pose is accepted, and a terrain-only preview opens while they load ([step-inside-download.md](step-inside-download.md)). A live variant (`nearfield/live`, 23bfebf1/fb6d5e13) runs depth → splats on the GPU with no readback for the /live route.

Four decisions carry the design:

1. **The DEM owns the geometry; the model owns only the residual.** Splats never replace terrain, they add what stands on it, so model error stays in the near field where the user can see it.
2. **The scale comes from the DEM, not the model.** The DEM is ground truth at every terrain pixel; the model's own scale is a prior. (The fit residual turned out not to work as a pose verifier: results finding 3.)
3. **Accepted poses only.** Step Inside is offered only on photos with an accepted or user-confirmed pose.
4. **Provenance is rendered, not hidden.** The Truth view tints surfaces by source. `generated` content never enters measurement exports (XYZ readout, GeoJSON, COLMAP, `.ply`/`.splat`).

## User-facing modes

- **Step inside (single photo).** The camera starts exactly on the photo camera; you can move about ±10–30 m and orbit within the confidence radius, with real parallax against correctly placed mountains. Camera modes photo / orbit / fly / map (`step-camera.ts`).
- **Better In map.** Object pixels are masked out of the drape, so people and huts stand up as splats instead of smearing (gate not met: results finding 5).
- **Measure anything.** The hover readout (lat, lon, elevation, distance) works on near-field objects (`measure.ts`).
- **Roll spots (multi-view).** Several posed photos at one viewpoint fused into one scene (`nearfield/roll/spot.ts`). Per-photo depth only since DA3 multiview has no browser port; the fusion gate failed (results finding 7).
- **Georeferenced export.** `.ply` and `.splat-v1` in ENU with a geo origin and a metadata header (`src/lib/export/splat.ts`).
- **Completion** (`?nearfield=complete`, display-only): slab reclassification, edge snap, people volumes (optionally a ViTPose + Anny body fit, `src/lib/body`). LaMa hole-fill is not implemented in the browser.

## Where VGGT and world models fit

- **Pose propagation, a recall lead.** At a roll spot, one accepted photo plus relative poses can anchor its neighbours. Built in the browser: ALIKED + LightGlue (`src/lib/features`) and a pure-rotation RANSAC (`src/lib/roll/propagate/estimator.ts`), pose composition and gate in `nearfield/propagate.ts` and `roll/propagate/plan.ts`; suggestion only until the prereg `tools/nearfield/propagate/PREREG_DRAFT.txt` is run and signed off (roadmap R5).
- **DEM-conditioned generation: research only.** Render DEM + imagery along a novel trajectory as conditioning so a world model adds texture, not terrain, and label every new Gaussian `generated`. Never run; the in-app generate path was removed with three.js (roadmap L8 needs a GEN3C run on a rented GPU).

## Phases (outcome)

| Phase | Gate | Outcome |
|---|---|---|
| P0 spike | Scale residual < 10 % at < 500 m; split separates people/huts on ≥ 8/12; one commercial-safe model | Single scale fails (0.34 log error); per-photo curve 0.13. People gate untestable (no people in the set). MoGe-2 (MIT) commercial-safe |
| P1 Step inside | Split removes ≥ 80 % of person/hut drape smear; 60 fps orbit; classic pixel-identical off | Built. **Smear gate not met** (15 % deck). 200k splats at 60 fps |
| P1b deck parity | Splat layer writes the terrain's log depth | Built (`deck-splat-layer.ts`); WebGPU added later (`splats.ts`, then luma's stack) |
| P2 roll spots, propagation | LOO novel-view gain; propagation prereg'd before any accept | Fusion **not met** (0–7 % coverage); propagation 0/83 wrong pairs pass, suggestion only |
| P3 generation | Zero `generated` content in measurement exports | Export guard holds; generation never run, path removed |

## Risks

- **Licences.** Only commercial-safe weights ship (MoGe-2 ViT-S MIT; ALIKED BSD-3; LightGlue Apache-2.0); SHARP (research-only) was dropped (d8e99834). See [licences.md](licences.md).
- **WebGPU only.** No Step Inside without WebGPU compute.
- **Depth compositing.** The splat shaders must match the terrain depth convention on each engine (log depth on WebGL2, reversed-Z on WebGPU) or splats pop through mountains.
- **Download size.** About 36 MB int8 (70 MB fp16) per first use; prefetch skips Save-Data and 2G/3G.
- **Browser evidence.** The in-browser pipeline (d8e99834, ab4485bf), luma splats (30bb006a) and the download work are browser-unverified ([batch-ledger.md](batch-ledger.md)).
