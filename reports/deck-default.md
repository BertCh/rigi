# deck.gl as the default renderer

*2026-09-30. **Decision: flipped** (3b121ae). `renderer` is `oneOf(["three","deck"], "deck")` in `src/lib/flags/index.ts`; `?renderer=three` selects three.js. The deciding fix is 408f989 (canvas antialias off at DPR ≥ 2). Gate C, which failed earlier the same day, is kept below as history. The WebGPU renderer is a separate, in-progress track: see `src/lib/deck-webgpu/README.md`.*

## Decision

Run D passes the flip gate. Run C failed only on the world view, and run D fixes that:

- **World view: passes.** At DPR 2, world orbit is **59.3–59.9 fps** on all three bench photos, against a gate of ≥ 45 (run C: 38.5 / 31.6 / 29.1). Fly-in is 59.5 (run C: 37–41).
  - **Cause:** luma creates the canvas with `antialias: true`, and the world view draws straight into that multisampled default framebuffer.
  - **Fix (408f989):** `createDeck` sets `deviceProps.webgl.antialias` to `devicePixelRatio < 2`. At DPR 2 the pixels hide the aliasing. At DPR 1 nothing changes. The photo view renders into the compositor's own MSAA target, so it is unaffected at any DPR.
- **Photo view: passes, unchanged.** Pose drag, mouse drag, Blend lens and the overlay slider are 59–60 fps before and after the fix.
- **Pixels: pass.**
  - DPR 1, before vs after the fix: overlay, settled overlay, export, Blend, settled Blend and the world view are hash-identical on all three photos.
  - DPR 2: overlay, export and Blend are hash-identical. The world view changes only at edges (below).
- **Accuracy: passes.** eval-app with no `--renderer` runs engine deck (the app default) and gives 12/14 within 1°, median 6.2 px. That equals three's 12/14.
- **Firefox: passes (informational).** In Playwright's Firefox 155 (headless, WebGL2 on the GPU), deck and three both render `/photo/IMG_7086` and its world view, with 0 console errors. deck.gl issue #10624 (9.4 rendering nothing on Firefox) does not reproduce here. No per-browser default was needed.
- **Waived: style-baseline 0/16.** The check is pinned to three, fails with identical pixel counts at a7287da (before any deck work), and has a stale baseline: trails have been off by default since 71e846e.
- **Run C passes that still stand:** deck-engine-smoke, the CI fast tier, reveal-bench, picker-check, step-tiles-check, step-inside-e2e and /roll.

**World-view edge quality at DPR 2.** Before/after screenshots of the world view:

- **How much changes:** 13–18% of pixels differ, and only 0.6–1.1% of pixels differ by more than 8/255 (max 139–169).
- **Where:** the difference is concentrated on crest silhouettes, triangle edges in the near foreground, and the thin gizmo frustum lines.
- **How it looks:** at 1:1 device pixels, crest silhouettes show visible stair-steps and the gizmo lines are harder. At normal viewing size (2 device pixels per CSS pixel) it is subtle.
- **If it matters:** give the gizmo lines a line-AA shader, or draw the world view through an MSAA offscreen pass. The photo view already does the latter.

**Side effect: world entry improved too.** Entry went from 28–47 fps with 2 long tasks (137–213 ms) to 52–55 fps with 1 long task (62–74 ms).

## Perf: baseline → final

- **Machine and browser:** Apple M3 Pro, headless Chromium with ANGLE Metal, 1400×900 at DPR 2.
- **Photos:** IMG_6958 / 7086 / 7155.
- **Builds:** each column is a frozen `git archive` snapshot on its own port.
  - Baseline: `b950820` ([deck-perf baseline](#sources)).
  - B1: `b5674d5`'s streams on a7287da.
  - Final: gate C, `3868f30` plus the working tree. Run D is `d121f09` with and without 408f989, benched before/after/after/before (ABBA).
- **Three:** the three column comes from the same gate-C run.
- **Cells:** each cell is three numbers, one per photo in the order above.

| scenario | deck baseline | deck after B1 (b5674d5) | deck gate C | **deck run D (408f989)** | three (gate C) |
|---|---|---|---|---|---|
| photo drag (setPose/rAF), fps | 14 / 10 / 10 | 47 / 48 / 47 | 59.4 / 59.0 / 59.3 | **59.5 / 59.1 / 59.5** | 59.8 / 59.0 / 59.2 |
| mouse drag (Drag tool), fps | 23 / 25 / 26 (p95 81–114 ms, up to 38 long tasks) | 60 / 60 / 60 | 59.6 / 59.6 / 59.5 | **59.6 / 59.8 / 59.5** | 60 |
| Blend lens, fps | 15 / 10 / 12 | 58 / 60 / 58 | 59.8 / 59.8 / 59.8 | **59.7 / 59.7 / 59.6–59.9** | 59.5–59.9 |
| overlay slider / reveal, fps | 59–60 | 60 | 60 / 59 | **59.8** | 60 / 59 |
| world orbit, fps | 13 / 10 / 9 | 38 / 32 / 29 | 38.5 / 31.6 / 29.1 | **59.4–59.7 / 59.7–59.9 / 59.3–59.6** | 59–60 |
| world fly-in, fps | 17 / 10 / 9 | 40 / 38 / 39 | 40.7 / 37.2 / 38.8 | **59.5 / 59.5 / 59.5** | 60 |
| world re-entry uploads, MB | 835–929 (measured before 51acd70) | — | 133 / 151 / 101 | 133 / 151 / 101 (unchanged) | 0 |
| export ms, cold / warm | 254,234 / 305,263 / 314,258 | 130,90 / 119,86 / 132,91 | 116,91 / 119,88 / 117,87 | 103–131, 76–87 | 123,118 / 132,112 / 133,122 |
| first terrain frame, ms | 2660 / 3161 / 3278 | 2672 / 3076 / 3267 | 2534 / 2952 / 3098 | — | 3013 / 3055 / 3086 |
| data-ready, ms | 3304 / 3557 / 3762 | 3407 / 3520 / 3552 | 3326 / 3404 / 3502 | — | 3235 / 3325 / 3345 |
| auto-align, warm, ms | 83–113 | 76–108 | 81–111 | — | 79–101 |
| JS heap, MB | 350 / 353 / 432 | 341 / 357 / 425 | 333 / 337 / 390 | — | 443 / 489 / 531 |
| luma GPU memory, world view, MB | 752 / 729 / 713 | 746 / 723 / 708 | 732 / 744 / 746 | — | — |
| GPU ms per photo-drag frame (colour pass) | 76–114 (MSAA 4×) | 16–18 | 6.5 / 8.0 / 8.9 (MSAA off while interacting) | — | 5.6–9.0 |

Run D bench errors: 0 page, 0 console and 0 GL errors on all 12 deck visits. A cell of — in the run D column means that row was not compared: the fix only changes how the world view's canvas is multisampled.

Other gate-C numbers:

- **Errors:** 0 GL errors, 0 console errors and 0 page errors on both engines. Before a19179f, deck logged 257 `GL_INVALID_ENUM` per visit.
- **Draw calls per frame:** deck issues 5–6, three 119–178.
- **Production bundle for /photo:**
  - Three loads 2.35 MB raw (0.72 MB gzip); deck loads 2.64 MB raw (0.83 MB gzip).
  - Production data-ready is about 0.35–0.45 s later on deck. That comes from one photo and 2 loads, so it is only indicative.

## What changed

| commit | change | effect |
|---|---|---|
| 63efa35 | Every harness that opens /photo pins `renderer` explicitly. Three-internals checks (style-baseline, the matcher render worker) pin `three` | A default flip cannot silently change what a check measures |
| 1917e48 | The three engine loads lazily. `Settings`/`defaultSettings` move to `src/lib/settings.ts` | The deck path no longer pulls in `three.module`/`PhotoEngine`. DPR 1 frames are pixel-identical |
| 4445e0e | `PhotoCompositor.setInteractive`: no MSAA while input is active, full quality on settle, 2× MSAA at DPR ≥ 2. Composite-only settings route to `updateComposite`. Layer and imagery Map reuse. Geometry readback waits for input idle. Context-loss recovery (`deck/device-lost.ts`). `__engine.metrics()` | Photo drag 20–26 → ~59 fps. Blend lens → ~60 fps. Settled DPR 1 frames identical (18/18) |
| b5674d5 | Terrain back-face culling, per-vertex log depth (early-Z works), `matrixCuller` for world/fly/step cameras, 16-bit indices where they fit, fenced non-blocking geometry readback, opt-in coarse-first set in `terrain-stream.ts` (not wired) | MSAA colour pass 76–114 → 16–18 ms. World orbit 9–13 → 29–38 fps. Export at parity. DPR 1: ≤ 0.17% of pixels change by > 8/255 (crest and tie pixels) |
| b46f617 | Log-depth comments corrected | Comments only |
| a19179f | `frontFace` dropped from `TERRAIN_PARAMETERS` | 257 → 0 `GL_INVALID_ENUM: glFrontFace` per visit |
| 0e206b1 | Flight frames swap only the gizmo layer | No layer rebuild per flight frame. Fly-in fps unchanged, because it is GPU-bound |
| 51acd70 | Imagery in fixed ~96 MB pages, kept across world exits (300 MB budget, LRU, at most 32 MB uploaded per frame) | World re-entry uploads 835–929 → 76–151 MB. Re-entry long tasks 614 → 136–156 ms |
| 3868f30, d121f09 | This report: first draft, then gate C (not flipped) | — |
| 408f989 | `createDeck`: canvas `antialias` only below DPR 2 | DPR 2 world orbit 29–38 → 59.3–59.9 fps, fly-in 37–41 → 59.5, world entry 28–47 → 52–55 fps. DPR 1 frames identical (18/18) |
| 3b121ae | Default `renderer` → `deck`. `eval-app-deck` joins the CI full tier with an `evalAppDeck` baseline (min 11). Panel help and stale comments updated | eval-app (app default) runs deck, 12/14 |
| this commit | This report: run D, the flip | — |

## Gate results (run C, then run D)

Run D re-ran only the rows it could change. The other rows are run C's results, carried forward.

| gate | threshold | run C (3868f30 + tree) | run D (d121f09 ± 408f989; flip snapshot 408f989 + flip) |
|---|---|---|---|
| photo drag, mouse drag, Blend lens (deck, 3 photos) | ≥ 55 fps | **pass**: 59.0–59.8 | **pass**: 58.9–59.9 |
| world orbit (deck, 3 photos, DPR 2) | ≥ 45 fps | **fail**: 38.5 / 31.6 / 29.1 | **pass**: 59.3–59.9 (two runs each) |
| DPR 1 pixels, before/after the fix | overlay, export, Blend, world identical | — | **pass**: 18/18 hashes identical |
| eval-app, deck ≥ three | within-1° count | **pass**: 12/14 vs 12/14 | **pass**: no `--renderer`, engine deck, 12/14, median 6.2 px |
| deck-engine-smoke | 4/4 | **pass**. \|Δyaw\| ≤ 0.04°. Label J = 1.00 / 1.00 / 0.75 / 1.00 | **pass**, same numbers |
| page loads, no `?renderer` (/, /photo/IMG_7086, /roll, /upload) and `?renderer=three` | 0 console errors | — | **pass**: 0 on every page; /photo runs deck, `?renderer=three` runs three |
| CI fast tier | all | **pass**: 27/27 | **pass**: 26 pass, 1 known (biome ratchet, none above baseline) |
| tsc, biome | clean | **pass** | **pass** |
| reveal-bench, picker-check, step-tiles-check (swisstopo), step-inside-e2e, /roll console | all | **pass** on deck | not re-run |
| style-baseline (three-pinned) | 16/16 | **fail, pre-existing**: 0/16 with identical pixel counts at a7287da, 0e206b1 and 3868f30. Geometry hashes match | **waived**: pinned to three and stale (below) |
| Firefox smoke | runs | **not run**: no Playwright Firefox, and the WebKit substitute does not launch on this OS | **pass** (informational): see below |

**Firefox (Playwright Firefox 155, headless, macOS, M3 Pro).**

- **WebGL2:** available in headless mode, on the GPU. The renderer string reads "Apple M1, or similar" (Firefox masks it). `EXT_color_buffer_float` is present.
- **deck:** `/photo/IMG_7086?renderer=deck` reaches data-ready in 4.8 s with verify "refined". The canvas is not empty (1080×810, luminance SD 40.6, about 35k distinct colours sampled). The overlay contours and labels draw, and In map draws the world. 0 console errors and 0 page errors.
- **three:** `?renderer=three` gives the same result (data-ready in 4.0 s, luminance SD 39.9).
- **Warnings only:**
  - WebGPU is blocklisted, so the GPU sidecar falls back to the CPU as designed.
  - `validateProgram` is a no-op on Mac.
  - deck logs "destination rect smaller than the viewport rect" once.
- **So:** deck.gl #10624 does not reproduce. No UA-based default was needed.
- **Not tested:** headed Firefox, Firefox on Windows or Linux, and Safari.

## Next fixes

The flip blockers are closed. Item 1 of run C's list, the canvas antialias, is 408f989. The Firefox smoke and the flip itself (3b121ae) are also done. What remains:

1. **style-baseline:** whoever owns `out/lead/style-baseline` re-captures it at the trails-off default (71e846e). It stays pinned to three.
2. **World-view edges at DPR 2:** if the harder gizmo lines or crest steps matter, add a line-AA shader for the gizmo, or render the world view through an MSAA offscreen pass as the photo view does.
3. **More browsers:** a Windows/ANGLE-D3D11 run, headed Firefox and Safari.

**Not blocking, worth doing:**

- **Coarse-first loading, render-only.**
  - Terrain appears 0.46–0.70 s sooner.
  - The full-terrain frame costs about +0.1 s, and data-ready +16–80 ms.
  - Accuracy is identical in 9/9 runs (poses, geometry hashes, eye altitude, tile set).
  - It is about 20 lines in `engine.ts`. The scratch wiring shows the z ≤ 14 set with a provisional eye; `this.terrain`, the horizon, readback and auto-align wait for the full set.
  - **Not checked:** a pixel diff of the settled view, and how the coarse-to-full pop looks.
  - Never align on the preview (see [negative-results.md](negative-results.md#gpu-and-performance)).
- **World re-entry:**
  - After 408f989, entry runs 52–55 fps with 1 long task of 62–80 ms. Re-entry takes 556–731 ms, against 602–606 ms on three: up to about 130 ms longer.
  - The remaining cost is the canvas resize plus the imagery page upload (101–151 MB).
  - Run C's suggested fix, caching the full-resolution photo texture across mode switches, is stale. That cache has existed since 4445e0e: `warmPhotoTexture` in `deck/engine.ts` uploads the drape texture once when the browser is idle, and the photo-view terrain layer carries it from then on.
- **World-view memory:** luma memory is about +520 MB, from the imagery pages. The photo view after a world visit holds 510–524 MB (3 retained pages, by design).

## Known gaps

- **Browsers:**
  - Two combinations are measured: Chromium with ANGLE Metal (perf and pixels) and Playwright Firefox headless (smoke only), both on one M3 Pro.
  - Safari/WebKit, Windows (D3D11), Linux, integrated or older GPUs and iOS are untested.
- **Context-loss recovery** (`deck/device-lost.ts`) was exercised only in Chromium on Metal.
- **Perf coverage:**
  - Perf was measured at DPR 2 only. DPR 1 keeps the canvas antialias, and one run-C probe gave world orbit 50–58 fps there. It was not re-timed.
  - Only three bench photos were timed.
  - A DPR change after the engine starts (a window moved between screens) keeps the antialias choice made at creation.
- **Memory:** GPU memory as Chrome reports it was not measured. The figures are luma's counter plus a GL allocation tracker.
- **Commits after 3868f30 that gate C did not measure:**
  - The list: 71691e6 (vite pre-bundle), 78ff061 (tile cache), 96c5d1c (GPU core), 57037a1 (sky worker), 966c960 (peak-label fonts, touches `PhotoWorkspace.tsx`), b30b0ee (three WebGPU spike), f610986 (research note), c60e8e7 (deck-webgpu, a separate lab route), 4f45d66 (harness fixes), 2af1daf (colour stats), d121f09 (reports) and 6ff1797 (GPU readback).
  - None touches `src/lib/deck/**`. Some may already have been in the working tree that gate C copied at 13:25.
  - Run D's snapshots include all of them except 6ff1797, so run D's perf, pixel, smoke, eval-app and page-load results cover them.
  - Gate C's other checks (reveal, picker, 3D Tiles, Step Inside e2e, /roll views) were not re-run on them.

## Round B2 fixes (51acd70, 0e206b1, a19179f, b46f617)

**Method.**

- Frozen snapshots:
  - base = b5674d5 (:3191)
  - after = base plus these fixes (:3192)
  - old = 4445e0e, before vertex log depth (:3193)
- Perf at DPR 2, pixels at DPR 1, one job at a time under `with-render-lock.mjs`.
- `?lookgpu=off` in every run. At that time, the GPU look pass (`look-band-stats-sg`, f1b6168) failed WGSL parsing, and luma's error overlay covered the sidebar. It no longer occurs at 3868f30.

**Imagery pages** (`batched-terrain-layer.ts`):

- Each page is a ~96 MB rgba8 2d-array that holds one image size.
- Tiles that leave `props.imagery` stay uploaded, least recently used first out, up to `imageryBudget.retainBytes` (300 MB).
- The store dies with the layer, which covers engine dispose and context loss.
- Counters are in `globalThis.__rigiTerrainMaps`.
- World orbit issues 11–12 draws per frame (per page) instead of 9–10. Orbit fps is unchanged within noise.

**Correctness.**

- **DPR 1, base vs after, IMG_6958 / 7086 / 7155:** overlay, overlay after settle, export, Blend and Blend after settle are all hash-identical. World views are identical, apart from one pixel off by 3/255 on 6958.
- **Near-ground views, old vs after:**
  - Views checked: Step Inside splats on IMG_7086 and IMG_7018 (photo, orbit, fly, top-down), In map (all modes) and `?tiles3d=swisstopo` with Step Inside.
  - None of them shows near-plane clipping or terrain punching through splats or tiles.
  - Tiles views differ on ≤ 0.21% of pixels by > 8/255, and `sampleSame` holds.
  - `TERRAIN_DEPTH` stays `"vertex"`.

## Sources

The raw runs are session scratch and are not in the repo:

- `deck-perf.md`: the baseline, with per-pass GPU timings and GL-level A/B tests
- `deck-perf-B1.md`
- `deck-gate-C.md` and `gc/`: the gate, the antialias probe and coarse-first
- `aa/`: run D. Snapshots, `pix.mjs` (DPR 1 and 2 hashes and stills, `pix/{before,after}-dpr{1,2}/`), `job2.log` and `perf-{b1,a1,a2,b2}.json` (ABBA bench), `ff.mjs` and `ff.log` (Firefox) and `job3.log` (smoke, eval-app and page loads on the flip snapshot)
- `cull/out/log.txt`, `wc/perf-*.json` and `rb/load-*.log`: the negative-result numbers

The commit messages above carry the headline numbers.
