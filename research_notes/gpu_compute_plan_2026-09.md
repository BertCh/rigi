# GPU compute plan (2026-09-28)

This plan follows a review of deck.gl 9.4.0 and luma.gl 9.4.2, the last v9 releases. deck v10 has no alpha yet; luma 10.0.0-alpha.2 is on npm's `beta` tag.

**Decision.** The renderers stay on WebGL2. deck-on-WebGPU is blocked by our GLSL log-depth hook, TerrainExtension being WebGL-only, and about 140 raw `gl` calls. Compute runs on a separate luma WebGPU device, `src/lib/gpu/device.ts`, and every kernel has a CPU fallback. The CPU stays the accuracy reference.

## Workstreams

| # | Workstream | Files | CPU twin, gate |
|---|---|---|---|
| W1 | GPU horizon: batched eyes, WGSL ray-march over ring mosaics | `src/lib/gpu/horizon/**` plus an additive worker hook | `horizon-fast/march.ts`; profile parity, `baseline:eval` unchanged |
| W2 | Pose scoring: autoAlign grid, silhouette re-rank | `src/lib/gpu/align/**` plus additive hooks | `align.ts`, `deck/engine.ts`; same winners, eval-app unchanged |
| W3 | deck P0 cleanups | `vite.config.ts`, `deck/geometry-pass.ts`, `deck/composite.ts` | style-baseline, deck smoke, eval-app |
| W4 | deck batched terrain: height-texture instancing, opt-in | new `deck/batched-terrain*.ts` plus a flag | deck smoke, ready/align timing |
| W5 | Look passes on the GPU, opt-in | `src/lib/gpu/look/**` | `look/**`; parity vs CPU, classic pixel-identical |
| W6 | Eye search on the GPU horizon, in the browser | `src/lib/gpu/eye/**` | `pose6dof/eye.ts` |

**Watch list (don't adopt yet):**
- deck v10 / luma 10: WGSL shader plugins would unblock deck on WebGPU.
- deck PR #10740 renames `unitsPerDegree` to `unitsPerWorldUnit`, which affects PhotoViewport and WorldViewport.
- The shared terrain tileset (#10374).

**Tooling:**
- Browser tests run under `node scripts/gpu/with-render-lock.mjs -- …`, one at a time.
- Headless Chromium on this Mac has WebGPU with `timestamp-query`, `subgroups`, `shader-f16` and `float32-filterable`.

## Results (2026-09-28)

Every GPU path has a CPU fallback and honours `?gpu=off`. The typecheck is clean, and biome passes on the new files.

| # | Workstream | Default | Outcome |
|---|---|---|---|
| W1 | GPU horizon (`gpu/horizon`) | opt-in in the app (`?gpuHorizon=1`) | p99 is at most 2e-4° vs CPU. One eye takes 6–25 ms warm vs 42–133 ms CPU; 343 eyes take 0.5–1.1 s vs 25–39 s. It is opt-in because last-bit differences move IMG_6958's autoAlign by 0.01° |
| W2 | autoAlign grid (`gpu/align`) | **on** | Bit-identical results. The grid drops from 39–57 ms to 2–6.5 ms, the search from 88–118 ms to 52–76 ms. The silhouette re-rank was left on the CPU |
| W3 | deck P0 | **on** | luma fenced readbacks and async export. `visgl:webgl-only` (deck only) cuts the client bundle by 124 KB. The dev server ignores tools/ and out/. Output is byte-identical |
| W4 | batched terrain (`deck/batched-terrain-*`) | opt-in (`?terrain=batched`) | Range Δ is about 1e-7 relative and 0 pixels flip. Draws during align fall from 410–1014 to 6–14, deck align from 145–359 ms to 143–194 ms, and mesh build from ~480 ms to ~60 ms |
| W5 | look passes (`gpu/look`) | opt-in (`?lookgpu=1`) | Relief takes 32 ms vs 69 ms and haze 28 ms vs 71 ms. Parity is ≤1 byte or ~1e-6. Results arrive one frame late |
| W6 | eye search (`gpu/eye` plus the `horizonsAtEyes` option) | library only | 6 photos take 4.3 s vs 28.8 s. 5/6 give the same eye; IMG_7063 moves 0.86 m, within the LM 1σ |

**Pre-existing failure.** `style-baseline` fails 1–2/16 on peak labels, and the pre-GPU backup (kept in a local archive, not published) fails identically. The label placement also varies from run to run (IMG_7068 gave 7,870 px vs 11,251 px). This regression came before the GPU work, and nobody owns fixing it yet.

**Next steps:**
- Imagery texture array for batched terrain.
- Warm up the look kernels.
- Decide whether batched terrain becomes the default.
- Wire the GPU eye search into a UI suggestion (matching-v2 policy).
- Unknown-pose 360° on the GPU horizon.
- Matcher T6 skyline search as a WebGPU kernel.

## Follow-up (2026-09-28, later)

The user accepted small numeric drift in exchange for speed, so these paths are now **default on** wherever WebGPU exists (the CPU is still the fallback and the reference):

| Path | Switch (off) | Evidence |
|---|---|---|
| GPU horizon for autoAlign | `?gpuHorizon=0` | eval-app, GPU vs `gpu=off`: all 14 photos within 0.1 px and 0.07° yaw (12/14 within 1°, same as the CPU) |
| Look passes | `?lookgpu=0` | parity unchanged. Kernels compile when a view opens (first guided pass 24–33 ms → ~16 ms). Export waits for in-flight passes (`lookIdle`) |
| deck batched terrain, now with imagery texture arrays | `?terrain=tiles` | ≥ 99.8% identical imagery pixels (p99 Δ 0). eval-app on deck is identical to tiles. Draws 410–1159 → 6–14 during align, mesh build ~8× faster. Imagery arrays use ~470–520 MB vs ~410 MB for tiles. Tested on Metal only |

**Still opt-in:**
- **Eye suggestion** (`?eyesearch=1` shows a "Check camera position" button in the Camera panel; `=auto` also runs the check once in the background). The result is suggestion-only, with Apply and Revert. On IMG_7063 it moves the eye 6 m and the skyline error goes from 4.18 to 4.02 px, in 2.8–3.0 s on the GPU.
- **Unknown-pose GPU horizon** (`?unknownGpu=1`). The ablation gives 0 false accepts and 0 lost accepts, and gains 1 true accept (IMG_6958 with nothing known). It saves only about 120 ms per photo, and the focal-seed confidence is sensitive to the horizon, so the CPU stays the default.
- **T6 skyline grid on WebGPU** (`src/lib/gpu/skyglobal`, library only). Its top-4 is identical to the frozen Python on 50/50 dev photos when the GPU candidates are re-scored in numpy. The grid takes ~17 ms vs 3.6–7.6 s in numpy, which saves ~5 s of a median 85 s T6 request (~6%). The polish must stay in numpy: the TS port flips 3/50 because of libm last-bit differences. Wiring it in needs the matcher maintainers: an optional `skyGrid` on render_worker `edges`, plus `grid_from_cands` in t6.py behind an env flag that defaults to off (the recipe is in `tools/matcher/gpu_port/verify_gpu_cands.py`). The fixtures in `out/gpu/skyglobal/` take 264 MB.
- **T6 GPU grid wired** behind `T6_GPU_GRID=1` (off by default; files: `tools/matcher/server/{render_worker.mjs,t6.py,sky_gpu.py}`, all additive; this is the app pipeline's code, so the app-pipeline maintainer should review before flipping). Live on 4 dev photos, off vs on: selected poses are bit-identical, and so are levels and the full candidate lists. The grid drops from 3.5–8.1 s to 5–23 ms, and the sky stage is ~7 s faster per photo.
- **style-baseline re-captured** 2026-09-28 (the old one is in a local archive, not published; the diffs were only the 2026-09-27 classic-label pixels, and geometry was identical). Two checks since then both passed 16/16 exact. The harness sometimes errors on one photo under load; re-run it when that happens.
