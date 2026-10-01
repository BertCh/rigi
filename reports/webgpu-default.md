# WebGPU as the default renderer

*2026-10-01. **Decision: flipped** (b520b1d). `renderer` is `oneOf(["auto","webgpu","deck"], "auto")` in `src/lib/flags/index.ts` (three.js removed 2026-10-01, 583e2b7), and `src/lib/renderer-select.ts` resolves `auto`. The user's direction was "we should be on GPU unless strictly necessary", followed by "push to flip now". They accepted that parity regressions get fixed after the flip. Unlike [deck-default.md](deck-default.md), **this flip was made without a browser gate.** The user put browser testing on hold while many sessions were landing work in parallel. The consolidated pass that will run later is described at the end.*

## What `auto` does

1. It picks **WebGPU** (the deck host of `src/lib/deck-webgpu`, `WebGpuEngine`) when:
   - `navigator.gpu` exists;
   - the adapter has `float32-filterable` and the required limits;
   - a probe device can be created.
2. Otherwise it picks **deck on WebGL2** (`src/lib/deck`, `DeckEngine`, the previous default). If `WebGpuEngine` fails during init, a fresh canvas is mounted and `DeckEngine` runs instead.
3. The workspace root reports the resolved engine as `data-renderer` and the reason as `data-renderer-reason`.

Overrides:
- `?renderer=webgpu|deck` pins an engine (`three` was a third value until its removal on 2026-10-01 and now falls back to the default).
- `?renderer=auto&webgpu=off` forces the WebGL fallback for testing.
- The harnesses accept `--renderer webgpu|auto` (eval-app, deck-engine-smoke, leaderboard, eval-app-flags), and they fail when the pinned engine did not run.

Under WebGPU the render device is also the compute device (`adoptRenderDevice`). The look passes run on the render targets with no CPU round trip: masks, band stats, haze prep and fit, and relief (`compute-bridge.ts`).

## Build

- `vite.config.ts` now resolves deck's full build. `RIGI_DECK_BUILD=webgl-only` restores the old `visgl:webgl-only` condition.
- Cost: client JS grows by +139 KB raw / +36 KB gzip, mostly in the deck layer and world-view chunks.
- The vendored deck (b7ed88a) carries luma 7d1d11e9's WebGPU deck fixes: Y-origin, pick scissor, picker flip, depth24plus, and the project.wgsl `select()` argument order.

## Partial evidence (unverified, to check)

| Check | Result |
|---|---|
| Fallback `auto&webgpu=off` | WebGL deck engine on 4/4 photos, no errors. The `--no-gpu` variant is still unrun: `--disable-features=WebGPU` leaves `navigator.gpu` in place. |
| Load under `auto` | WebGPU on 6/7 photos, render device == compute device on all of them. IMG_7033 hit the 180 s ready timeout under heavy contention. |
| deck-engine-smoke on WebGPU | IMG_6958 and IMG_7063 pass (Δyaw ≤ 0.04°). IMG_7018 and IMG_7155 timed out under load. |
| Not run | eval-app on WebGPU, 19-photo no-error check, style-baseline (it pinned three at the time; three is now removed, so it needs a deck reference), orbit fps |

## Known gaps on WebGPU (the regression list)

| Area | State |
|---|---|
| Looks | Band stats run on the GPU on the WebGPU host: the bridge's `bandStatsTex` graph (plain `BAND_STATS`, subgroups off by default) and the `BAND_STATS_SG` variant both compile on the adopted render device (checked 2026-10-01, IMG_6958, Chrome/Metal; the render device requests `subgroups` and `float32-filterable`). The earlier "doesn't compile" was `BAND_STATS_SG`'s NaN constant, a shader-creation error, fixed in 2af1daf (-1 partials). World-mode harmonize is unverified. |
| Step Inside (splats, photo sky, 3D tiles) | Code done, never run end to end |
| Export | Works, but full resolution needs tiling |
| Device loss | A failed rebuild stays dead; there is no mid-session switch to WebGL |
| Interactive composite | No cheaper drag mode |
| Terroir (mt-image-f0) | In neither engine on WebGPU yet: needs a WGSL port or a per-feature WebGL route |
| `lookSmoke` | Reads stale `compLook` stats while the look bridge is on |
| Memory | Photo-view GPU memory is about 2× WebGL's |

**Stays on WebGL:**
- `/roll`;
- browsers without `float32-filterable`;
- anything except Chrome on Apple Metal, which is the only platform tested.

`?renderer=deck` is the escape hatch for Step Inside with splats or 3D tiles, and for 12 MP export, until those are verified.

## Consolidated pass (on hold, owner mt-image-0a)

When the user asks for it, run the battery once per renderer: webgpu/auto, deck, and forced fallback (three.js was also in this list before its removal).

- **Baseline:** HEAD vs the last fully-gated commit, 85d8ca8. WebGPU has no 85d8ca8 baseline, so compare it against deck at HEAD.
- **On failure:** `git bisect run` over the fast-gated commits, reinstalling `node_modules` across b7ed88a and the vendored-luma landing.
- **Not regressions:**
  - deck masks and band stats vary from run to run, even at HEAD;
  - U1 changed the atmosphere uniform layout, but classic must stay pixel-identical.
