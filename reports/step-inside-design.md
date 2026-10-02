# Step Inside: a design for georeferenced 3D photos

Status: BUILT 2026-09-29. Results and the gate outcomes are in [step-inside-results.md](step-inside-results.md); the follow-on plan is in [roadmap.md](roadmap.md).

> **Corrections since this was written:** the splat renderer is dependency-free (Spark was never added); the SHARP and VGGT licence questions are resolved (`research_notes/step_inside_models_2026-09.md`); the "people/huts on 8/12" P0 gate could not be tested, because the set has no people.
>
> **Update (2026-10-01):** the three.js PhotoEngine was removed (583e2b7), so the "three.js first" P1 row, the P1b parity row and decision 2 below are moot. Step Inside now runs on the two deck.gl engines: WebGL2 (`src/lib/nearfield/deck-splat-layer.ts`) and WebGPU (`src/lib/deck-webgpu/layers/splats.ts`, the default renderer, not yet exercised end to end). `three-splats.ts`, `/lab/splats` and `/lab/generate` (the P3 cache renderer) were removed 2026-10-02.

## Thesis

Apple's Spatial Scenes and SHARP-type models taught people to expect that a photo can "become 3D". Those systems invent the geometry: they give you plausible parallax, but no true scale and no place in the world. Rigi has the opposite problem. It knows the true camera (a metric ENU pose, the intrinsics and a confidence) and the true terrain beyond about 200 m. What it lacks is everything in the near field: people, huts, trees, boulders, the ridge you are standing on. That is why the In map drape smears them across the ground (roadmap item 16).

**Step Inside fuses the two.** A learned model reconstructs the near field. The DEM provides the far field. Generation is used only to fill holes. Rigi's solved pose anchors all of it in real coordinates, and every rendered surface carries a label for where it came from.

The feature is not "yet another photo-to-splat". It is the only photo-to-3D whose output is at the right scale, in the right place, and honest about which parts are real. That extends the "geometric truth" positioning in the competitive roadmap instead of competing with Apple on eye candy.

## What Rigi already has that makes this cheap

| Need | Existing piece |
|---|---|
| Camera intrinsics and pose, metric, georeferenced | The solved pose (cascade or matcher), with a confidence gate |
| Per-pixel true range to terrain | The geometry pass range buffer; `Renderer.sampleAt()` |
| Sky and people masks | `src/lib/sky` (U²-Net), MediaPipe people mask |
| Occlusion-correct drape of photo onto DEM | In map mode, `roll/map/multi-drape-layer.ts` |
| Multi-view sets with known poses | Camera-roll viewpoints (photos within 250 m, poses already accepted) |
| COLMAP camera export | `src/lib/export/colmap.ts`, which is exactly what gsplat and VGGT tooling consume |
| Python GPU sidecar pattern | The matcher service (:8765) with a queue, health checks and silent degradation |
| Monocular depth already in use | MoGe-2 as a verifier in the TM research (`tools/research/tm`) |

## Architecture

```
photo + solved pose (accepted only)
        │
        ▼
 ┌──────────────────┐   near-field model (SHARP / TripoSplat / MoGe-2 depth-lift)
 │ nearfield service │──► camera-frame Gaussians, approximately metric
 └──────────────────┘
        │
        ▼
 DEM anchoring (browser, pure TS)
   1. transform camera frame → ENU with the solved pose
   2. scale fit: robust median of DEM range ÷ predicted depth on
      terrain pixels (not sky, not people, range < 2 km)
   3. residual → anchor quality score (a trust number and a pose verifier)
        │
        ▼
 depth split per pixel / per Gaussian
   predicted ≈ DEM range  → TERRAIN  (drop the splat; the DEM drape renders it)
   predicted ≪ DEM range  → OBJECT   (keep the splat: people, huts, trees, rocks)
   sky mask               → SKY      (photo on a far sphere)
   beyond ~300–500 m      → DEM only (depth models are worthless at range)
        │
        ▼
 renderer: DEM terrain + drape (existing) + splat layer (new) + sky shell
 provenance per surface: observed | reconstructed | DEM | generated
```

Four decisions carry the design:

1. **The DEM owns the geometry and the model owns only the residual.** Splats never replace terrain; they only add what stands on top of it. That keeps the far field exact and confines model error to the near field, where it is also visible to the user.
2. **The scale comes from the DEM, not the model.** SHARP claims metric scale, but the DEM is ground truth at every terrain pixel, so we fit the scale and treat the model's own scale as a prior. The fit residual is a free trust metric. It also acts as an extra independent pose check: a wrong pose makes the DEM range disagree with the depth model, which is the MoGe-2 verifier idea from the TM research reused.
3. **Accepted poses only.** Step Inside is offered only on photos with an accepted or user-confirmed pose, so it never produces a confident 3D scene on a wrong basin.
4. **Provenance is rendered, not hidden.** A "Truth" toggle tints surfaces by source. Generated content never enters measurement exports (XYZ readout, GeoJSON, COLMAP).

## User-facing modes

- **Step inside (single photo).** The photo becomes a small volume: you can move ±10–30 m and orbit a little, and the near-field objects have real parallax against correctly placed mountains. Past the confidence radius the view fades to the existing DEM drape. This is the shareable moment for the share-link beta.
- **Better In map.** The same depth split removes people, huts and trees from the drape, and they stand up as splats instead of smearing across the slope. This closes roadmap item 16 as a side effect.
- **Measure anything.** The hover readout (lat, lon, elevation, distance) now works on near-field objects too: the height of a hut, the distance to a climber. That serves roadmap item 15 (monoplotting and per-pixel XYZ).
- **Roll spots (multi-view).** Several photos at one viewpoint with known poses are optimised jointly into a better splat (gsplat, initialised from Rigi's COLMAP export, with no SfM needed).
- **Georeferenced export.** `.ply` or `.spz` in ENU with a WGS84/LV95 origin in the header. Later, 3D Tiles. This is the B2B hook: a DMO's summit viewpoint as a navigable, correctly placed scene.

## Where VGGT fits: pose propagation, a recall win

VGGT's best use in Rigi is registration, not rendering. At a roll spot, **one** accepted photo plus VGGT's relative poses can anchor its **neighbours**, including photos that failed the skyline cascade because of clouds on the ridge or a skyline blocked by a person. Recall is Rigi's measured bottleneck (about 20% auto-accept in the wild), so a propagation that holds precision would matter more than any rendering feature.

This must go through the existing discipline: the frozen accept rule, blind verification packs rendered on Mapterhorn at the exact eye used, and dev data only. data_v3 needs your sign-off.

## Where LingBot-type world models fit: phase 3, research only

A generative rollout can show what lies beyond the frame, but for Rigi it is a brand risk: invented terrain inside a product whose selling point is truth. The version worth trying is **DEM-conditioned generation**:
- Render DEM plus swissimage from the novel camera trajectory and use it as the structural conditioning (depth and layout).
- The world model supplies only texture and detail, so the mountains stay where they are.
- Reconstruct the output (VGGT, then gsplat) and label every new Gaussian `generated`.

That turns the paste's "plausible world completion" into "plausible texture on true geometry", which is a defensible product. Keep it behind a flag until P0 and P1 are proven.

## Phases

| Phase | Scope | Exit gate |
|---|---|---|
| **P0 spike** (1–2 days) | Verify the candidates' licences and existence. Run 2–3 near-field models offline on the 12 GT photos plus about 5 roll spots. Implement the DEM scale fit and depth split in a notebook-grade script (`tools/nearfield/spike`) | Scale residual median < 10% on terrain pixels at < 500 m; the depth split visibly separates people and huts on ≥ 8/12 photos; at least one model is licence-OK for commercial use |
| **P1 Step inside** | `tools/nearfield` sidecar (the matcher pattern, cached per photo), `src/lib/nearfield/**` (anchoring, split, provenance), a splat layer in **three.js first** (Spark), drape masking in In map | The split removes ≥ 80% of person and hut drape smear (hand-labelled on 12 photos); 60 fps orbit on the dev Mac; classic stays pixel-identical when the feature is off; eval-app is unchanged |
| **P1b deck parity** | A GaussianSplat layer for deck that writes the same log depth as the terrain shader | deck smoke passes; the split is visually equal to three |
| **P2 Roll spots and propagation** | Multi-view gsplat from accepted poses; VGGT relative-pose propagation as a *suggestion*, then a prereg for auto-accept | Leave-one-out novel-view LPIPS beats single-photo splats; propagation precision is prereg'd and blind-verified before any accept |
| **P3 DEM-conditioned generation** | Research flag only | A qualitative review, plus zero `generated` content in any measurement export (enforced by a test) |

## Risks

- **Licences (the largest risk).** SHARP's weights may be research-only; check Apple's model licence. VGGT has a non-commercial original, and a commercial checkpoint may exist. MASt3R is CC-BY-NC and already on the roadmap's avoid list. TripoSplat's MIT claim and LingBot-World-Infinity come from the pasted text and are **unverified**. Fallback: MoGe-2 or Depth Anything V2-Small (check each) depth-lifted into per-pixel Gaussians. This is worse at disocclusions but good enough for the depth split and the drape fix.
- **Depth compositing in deck.** The terrain writes log depth to `gl_FragDepth`, so the splat shader must match it, or splats will pop through the mountains.
- **iOS.** Splat sorting and rendering on iOS WebGL2 inherits the known float-target gap.
- **Disk and GPU.** Model checkpoints are GB-scale; `df -h` shows 15 GB free right now. Follow the render-lock rule: one GPU job at a time.
- **Ownership.** New code goes in new paths (`src/lib/nearfield/**`, `tools/nearfield/**`). `renderer.ts` needs an optional `setNearField()` (a change to the app pipeline). Adding Spark to `package.json` needs your OK.

## Decisions needed

1. **Licence posture for the prototype.** Are research-only weights acceptable in P0/P1 behind a dev flag, with a commercial-safe model required before any public URL?
2. **Three-first or parity-first.** Can P1 ship on three.js only, with deck parity as a follow-up gate? This bends the "both renderers at parity" decision.
3. **Generative scope.** Is P3 in scope at all, given that the positioning is honesty?
