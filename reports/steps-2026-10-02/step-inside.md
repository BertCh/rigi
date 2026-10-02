# Step ⑯ Step Inside: review, research, plan (2026-10-02)

Step lead: Opus pod `step-inside` (coordinator mt-image-17). Node `step-inside` in `src/lib/gipfelbuch/graph.ts:607`,
modules `src/lib/nearfield/controller.ts`, `scene.ts`, `src/components/nearfield/StepInsidePanel.tsx`,
`useStepInside.ts`. Already done elsewhere and not redone here: b0 pod F (3b8f215 service caps, f45db42 + 2755e41 T2
object prior, f4f9b71 cliff-lip + anchor parity, aa25eed completion P0) and the dem-anchoring pod
(`reports/steps-2026-10-02/dem-anchoring.md`, 6ad885d / 8f7f80e / 13d9fe6). No browser or GPU run in this pass
(cook mode); nothing below is measured on real photos.

## 1. Current state

- **Gate and orchestration** (`controller.ts`): `poseAccepted` (accepted / pinned / saved / manual, or auto with a
  verified / refined / matched verdict) → `available()` (client health, 800 ms timeout, cached 60 s up / 15 s down) →
  `build()`: `/depth` moge2 then `/gaussians` lift (cached per photo, 4 entries, failures not cached) → near DEM +
  `readback()` → DEM grid → optional nDSM object prior (`?tiles3dObjects=on`) → `buildNearFieldScene` (anchor curve,
  split, grounding, far objects, lift or service cloud) → measure grid → cached per pose (6 entries) → `adopt()`:
  hidden below `ANCHOR_MIN_QUALITY` 0.15 (`types.ts:94`), "low trust" chip below 0.35.
- **UX** (`useStepInside.ts`, `StepInsidePanel.tsx`): one controller per engine; dormant unless `?nearfield` is
  not `off` and (for `auto`) not under webdriver; polls health every 20 s; a pose change exits the step camera,
  invalidates and rebuilds locally after 400 ms when the depth is cached. Chip states: 3D view / pose not accepted /
  ready / low trust / anchoring too weak / failed / progress.
- **Camera** (`step-camera.ts`, `deck-map-camera.ts`, `CameraModeBar.tsx`): photo / orbit / fly / top-down; photo
  mode starts on the eye to f64 rounding (`step-camera.spec.ts` "starts exactly on the photo camera"); the FOV equals
  the photo's only when the viewport aspect matches (`fitVfov`, widened otherwise).
- **Splats**: WebGPU `deck-webgpu/layers/splats.ts` with the I11 GPU radix sort (`gpu/app-graph/manifest.ts:755`,
  default), WebGL2 `DeckSplatLayer` with the worker CPU sort (`splat-sort.worker.ts`). Covariance / projection
  math is the same in GLSL and WGSL; blending differs (sRGB bytes on the WebGL canvas pass, linear on WebGPU),
  documented in `splats.ts`. No `drawIndirect`: the draw uses `count` instances and culled splats sort last.
- **Service contract**: `client.ts` against `tools/nearfield/service/app.py` matches (fields, CORS, meta header);
  every non-OK reply becomes `null`; timeouts 60 s depth / 120 s gaussians.
- **Licences**: MoGe-2 (MIT), DA3-BASE (Apache-2.0), LaMa big-lama (Apache-2.0) on reachable paths; SHARP weights
  research-only (Apple ML Research Model License); SAM 3D / TripoSplat not referenced in code.
- **Tests before this pass**: none for `controller.ts` (511 lines) or any of `src/components/nearfield/*`.

## 2. Findings (ranked)

| # | Sev | Where | Finding | Status |
|---|---|---|---|---|
| F1 | P1 | `panel/flags.ts:108`, `controller.ts:163` | SHARP (research-only weights, no product use) was a user-selectable Advanced-panel option and URL value in production builds. Default path was safe (lift), and the export header says NOT ALLOWED, but a product build could produce and show SHARP splats. | fixed U1: dev builds only |
| F2 | P1 | `controller.ts:232`, `useStepInside.ts:321` | A failed health probe (service gone, or busy past the 800 ms timeout while it runs inference) set phase `unavailable` even with a built scene, and the hook then hid the whole panel, including **Back to photo** while stepping. The built scene needs no service. | fixed U1 |
| F3 | P2 | `controller.ts:336-372` | With `?tiles3dObjects=on`, `buildNearFieldScene` read `host.pose` after the awaited object prior, so a pose change during it built a scene from the new camera on the old pose's DEM grid and cached it under the old key (served again if the user returned to that pose). | fixed U1: one snapshot, bail if moved |
| F4 | P3 | `controller.ts:54` vs `anchor.ts:132` | Two low-trust constants (panel vs export header); dem-anchoring F6 proposal. | fixed U1: one constant |
| F5 | P3 | `splat-sort.worker.ts:47` | An infinite distance (corrupt file) made the key span infinite and every key 0 (unsorted cloud). | fixed U1, finite input bit-identical |
| F6 | P3 | `splat-io.ts:264` | A NaN quaternion stayed NaN (the `|| 1` masked the reset branch); `pad4` used `& ~3` (wraps above 2^31 for a hostile count). | fixed U1, finite input bit-identical; zero quaternion unchanged |
| F7 | P3 | `step-camera.ts:839` | Window key bindings (1–4, WASD, Esc) fired inside contenteditable elements. | fixed U1 |
| F8 | P2 | `app.py:343` | `/health` lists moge2 / da3 / lift without checking they import, so `auto` can show the panel and every build then fails. | later U3 |
| F9 | P2 | `client.ts` post / `app.py` | A client abort or timeout does not stop service work (shared MPS lock); a retry queues behind the dead job. | later U3 |
| F10 | P2 | `service/cache.py:19` | Disk cache key has no model / code version; `/health` has no version. | later U3 |
| F11 | P2 | world view | WebGL2 vs WebGPU splat blend colour space differ in the world view; no check covers it. | later, batch pass |
| F12 | P3 | `three-splats.ts` | 462 lines used only by `/lab/splats` and `generate/cache-render.ts` (lab); comments in `splat-sort.ts:5`, `deck-splat-layer.ts:49`, `deck-step.ts:6` still cite three's engine. | later U4 (doc / keep-list decision) |
| F13 | P3 | `controller.ts:256` | `PHOTO_CACHE` captures the first caller's AbortSignal; no caller passes one today. | note |
| F14 | P3 | `splat-loaders*.ts`, `client.ts` | No byte / count caps on SPZ / KSPLAT / .splat parsing or reply bodies (not reachable from product upload today). | later |
| F15 | P3 | docs | `step-inside-design.md` P1 tables and `step-inside-results.md` engine rows still describe the removed three engine; results banner predates the I11 GPU sort default. | later U4 |

## 3. Research summary

- **Single-image 3D Gaussians.** Apple SHARP (Dec 2025) regresses a metric 3DGS scene in one forward pass; weights
  under the Apple ML Research Model License (non-commercial, no product use), which is why it stays dev-only here.
  2026 comparisons (SHARP vs TripoSplat vs TRELLIS) are object- or view-synthesis-centred; none places the result in a
  georeferenced terrain frame, which is Step Inside's point (`step-inside-design.md`: "right scale, right place,
  honest about which parts are real").
- **Web splat rendering.** WebSplatter (arXiv 2602.03207) and SuperSplat 3 (PlayCanvas, WebGPU only) run projection,
  culling, compaction, a GPU radix sort and an indirect draw every frame. Our WebGPU path already sorts on the GPU
  (I11) but draws `count` instances; compaction + `drawIndirect` only pays at hundreds of thousands of splats, and
  Step Inside clouds are ~40k (negative-results LF6). Recorded negatives not redone: luma #3340 paged RAD and deck
  #10627 (nothing to page), MoGe metric scale, depth-only split, multi-view fusion at roll spots, LaMa on large holes,
  LingBot-Depth-DC prompting, DA3 / E-matrix propagation.
- **Licences.** Segmenter for S1 v1.1 is the blocker (`research_notes/segmenter-shortlist-2026-10-02/NOTE.md`);
  SAM 3D / TripoSplat traps per `research_notes/` stay out of product code.

Sources: [SHARP model card](https://huggingface.co/apple/Sharp), [SHARP paper](https://arxiv.org/pdf/2512.10685v2),
[Single-image GS in 2026](https://radiancefields.com/single-image-gaussian-splatting-in-2026-—-triposplat-vs-sharp-vs-trellis),
[WebSplatter](https://arxiv.org/abs/2602.03207v1), [SuperSplat 3](https://radiancefields.com/playcanvas-releases-supersplat-3.0).

## 4. Plan

| Unit | What | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| U1 | F1–F7 + `controller.spec.ts` (first controller tests: gate, caches, low-quality, error, down, pose moves, dispose, probe, SHARP gate) and `step-camera-keys.spec.tsx` | S | low (UI-only behaviour changes; default build bit-identical) | vitest, tsc, fast tier | now |
| U2 | `StepInsidePanel` / `useStepInside` DOM specs (chip mapping, disabled reasons, visible rules, Back while service down) | S | low | vitest | now / next |
| U3 | Service: `/health` probes MoGe import + weights and reports a `version`; cache key includes model + code version; skip queued work whose client hung up | M | low–medium (Python, service) | `tools/nearfield/service/tests` | later (no service start in cook mode) |
| U4 | Docs and dead-code: three-splats keep-list entry or removal with the two labs; comment drift; results banner (I11 default) | S | low | doc review | later, needs cleanup owner |
| U5 | World-view blend parity between WebGL2 and WebGPU splats | M | medium (look) | batch-pass screenshot pair | next browser batch |
| U6 | Anchor confidence span in the panel tooltip (dem-anchoring U4) | S–M | low | spec | after dem-anchoring U3 data |

## 5. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts not edited)

- Summary "Shown only for an accepted pose and a good anchor, and hidden when the service is down" → "Shown only for
  an accepted pose and a good anchor; it needs the near-field service to build, and a built scene stays usable if the
  service goes away."
- "The camera starts exactly at the photo's eye" is true for position and orientation; the field of view matches the
  photo only when the window has the photo's aspect (wider windows widen it).

## 6. Proposals for other owners

- dem-anchoring: none new; F6 merged here.
- Cleanup: add `three-splats.ts` (labs + cache renderer) to the kept-on-purpose list, or remove it with `/lab/splats`
  and the cache renderer (user decision).

## 7. Log

- **U1 committed 690ca62** (`nearfield: Step Inside keeps a built scene and its Back button when the health probe
  fails; …`): F1–F7. Specs: `src/lib/nearfield/__tests__/controller.spec.ts` (15: gate, per-pose cache, shared
  in-flight build, low-quality hide, error not cached, service down, pose moved during the call vs during the
  object prior, dispose, probe vs ready, unsupported engine, view options, poseKey, SHARP dev gate),
  `step-camera-keys.spec.tsx` (2), `src/components/nearfield/__tests__/StepInside.spec.tsx` (6: hidden when down or
  `?nearfield=off`, accepted-pose gate, enter → service stops → panel and Back stay, chip states), shared fixture
  `__tests__/step-fixture.ts`, +1 sort and +1 PLY spec. The panel, mixed-pose, probe, key and visibility specs were
  checked to fail without their fix. Default render path bit-identical; the visibility rule is a UI change, so one
  ledger row.
- **Review iteration 1** (Sonnet adversarial reviewer): no blocker. Fixed from it: a superseded run's bail could reset
  a newer run's `loading` phase (run token `runSeq`); the sort guard tests `Math.fround(dist)` (a double beyond
  float32 max becomes Infinity in the depth buffer); `?nearfield=sharp` in production warns; the object-prior mock
  resets per test. Checked and fine: `import.meta.env?.DEV` under Vite, Vitest and tsx scripts (undefined → lift);
  `visible` cannot show the panel for `?nearfield=off`, unsupported engines or after dispose (no controller).
- **Review iteration 2** (lead, on the hook spec): the first hook spec passed without the visibility fix because it
  called the controller's probe directly (the hook's own `available` state never changed); rewritten to drive the
  hook's 20 s poll with a fake interval, and it now fails without the fix.

## 8. Decisions for the user

- Keep or remove the three.js splat stack used only by `/lab/splats` and `/lab/generate`.
- Whether Step Inside v1.1 ships as an opt-in beta before the smear gate (status.md question 5) — unchanged.
