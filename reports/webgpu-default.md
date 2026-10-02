# WebGPU as the default renderer (decision record)

**Decision (2026-10-01, b520b1d): flipped.** deck.gl on WebGPU (`src/lib/deck-webgpu`, `WebGpuEngine`) is the default; deck.gl on WebGL2 (`src/lib/deck`, `DeckEngine`) is the fallback. The user's direction: "we should be on GPU unless strictly necessary", then "push to flip now", accepting that parity regressions are fixed after the flip. **The flip was made without a browser gate** (testing was on hold). On 2026-10-02 the user added that the non-WebGPU path is a secondary test/fallback path only, with no perf work on it. The previous flip (three.js → deck WebGL, 2026-09-30, gated) is recorded in [archive/deck-default.md](archive/deck-default.md); the three.js renderer was removed in 583e2b7 / dd05828.

## What `auto` does

Flag: `renderer: oneOf(["auto","webgpu","deck"], "auto")` (`src/lib/flags/index.ts`), resolved in `src/lib/renderer-select.ts`.

1. **WebGPU** when `navigator.gpu` exists, the adapter has `float32-filterable` and the required limits, and a probe device can be created.
2. Otherwise **WebGL2 deck**. A `WebGpuEngine` that fails during start-up also falls back: the workspace re-mounts a fresh canvas (one that held a WebGPU context cannot give WebGL2).
3. The workspace root reports `data-renderer` and `data-renderer-reason`.

Overrides: `?renderer=webgpu|deck` pins an engine (`webgpu` still falls back, with a console warning); `?webgpu=off` makes `auto`/`webgpu` act as if `navigator.gpu` were missing; `?gpu=off` is the compute kill switch. Harnesses take `--renderer webgpu|deck|auto` and fail when the pinned engine did not run.

Under WebGPU the render device is also the compute device, so look passes (masks, band stats, haze prep and fit, relief) run on the render targets with no CPU round trip (`deck-webgpu/compute-bridge.ts`). `/roll`'s map follows the same `auto` selection since 0fbcab2a (browser-unverified).

## Evidence at the time of the flip

| Check | Result |
|---|---|
| Fallback `auto&webgpu=off` | WebGL deck on 4/4 photos, no errors |
| Load under `auto` | WebGPU on 6/7 photos, render device == compute device; IMG_7033 hit the 180 s ready timeout under contention |
| deck-engine-smoke on WebGPU | IMG_6958 and IMG_7063 pass (Δyaw ≤ 0.04°); two photos timed out under load |
| Later (2026-10-01, waves 3–4 browser pass) | eval-app 12/14 on both engines, no revert candidate ([results](../research_notes/whole-app-graph-2026-10-01/consolidated-pass-results.md)); photo-view VRAM 371 → 241 MiB on WebGPU (dc4fa28) vs 175–188 MiB on WebGL |

## Known gaps on WebGPU

Still open (tracked in [gpu-renderer.md](gpu-renderer.md)):
- Only Chrome on Apple Metal has been run; Safari, Firefox, Windows, Linux and mobile GPUs are untested.
- Device loss: the engine rebuilds host and cores on the same canvas (`onDeviceLost`, cap `MAX_DEVICE_LOSSES` = 3); there is no mid-session switch to WebGL.
- Full-resolution export needs tiling; no cheaper drag mode for the interactive composite.
- Step Inside (splats on luma's splat stack, photo sky, 3D tiles) and the roll map on WebGPU have not run end to end in a browser.

Closed since the flip: terroir ported to WGSL (366ab83); band-stats kernels compile on the adopted device; the matcher's render views (`loadFullTerrain`, `loadSatellite`, `renderPoseView`) exist on `WebGpuEngine`.

## Batch pass for the flip

Run once per renderer (webgpu/auto, deck, forced fallback `?webgpu=off`) through `node scripts/gpu/with-render-lock.mjs -- <cmd>`. Not regressions: deck masks and band stats vary run to run even at HEAD.
