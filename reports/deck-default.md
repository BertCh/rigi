# deck.gl as the default renderer

*2026-09-30. **Decision: not flipped.** `renderer` stays `oneOf(["three","deck"], "three")` in `src/lib/flags/index.ts`; `?renderer=deck` still selects deck. The WebGPU renderer is a separate, in-progress track: see `src/lib/deck-webgpu/README.md`.*

## Decision

The flip gate (run C) **failed**, and the shortfall is not a near miss. What passes and what does not:

- **Photo view: passes.** Every photo-view interaction on deck is 59–60 fps on all three bench photos: pose drag, mouse drag, Blend lens, overlay slider and reveal. At the baseline these were 10–26 fps.
- **Accuracy: passes.** eval-app gives 12/14 within 1° on deck, the same as three (median 6.2 px against 6.5 px).
- **World view: fails.**
  - World orbit is **38.5 / 31.6 / 29.1 fps**, against a gate of ≥ 45 fps. That is 15–35% short, outside the "within ~15%" band that would count as a perf-only near miss.
  - Fly-in is 37–41 fps. Three runs both at 59–60.
- **style-baseline: 0/16, but not a deck regression.** The check is pinned to three, and it fails with identical pixel counts at a7287da, before any deck work. Trails were turned off by default in 71e846e and the baseline was never re-captured.
- **Firefox smoke: not run.** Playwright Firefox is not installed, and the installed WebKit build does not launch on this OS.

The world-view blocker has a measured cause and a candidate one-line fix (next-fix list, item 1). It was not applied in this round, because this round only measured.

## Perf: baseline → final

- **Machine and browser:** Apple M3 Pro, headless Chromium with ANGLE Metal, 1400×900 at DPR 2.
- **Photos:** IMG_6958 / 7086 / 7155.
- **Builds:** each column is a frozen `git archive` snapshot on its own port.
  - Baseline: `b950820` ([deck-perf baseline](#sources)).
  - B1: `b5674d5`'s streams on a7287da.
  - Final: gate C, `3868f30` plus the working tree.
- **Three:** the three column comes from the same gate-C run.
- **Cells:** each cell is three numbers, one per photo in the order above.

| scenario | deck baseline | deck after B1 (b5674d5) | **deck final** | three (gate C) |
|---|---|---|---|---|
| photo drag (setPose/rAF), fps | 14 / 10 / 10 | 47 / 48 / 47 | **59.4 / 59.0 / 59.3** | 59.8 / 59.0 / 59.2 |
| mouse drag (Drag tool), fps | 23 / 25 / 26 (p95 81–114 ms, up to 38 long tasks) | 60 / 60 / 60 | **59.6 / 59.6 / 59.5** | 60 |
| Blend lens, fps | 15 / 10 / 12 | 58 / 60 / 58 | **59.8 / 59.8 / 59.8** | 59.5–59.9 |
| overlay slider / reveal, fps | 59–60 | 60 | **60 / 59** | 60 / 59 |
| world orbit, fps | 13 / 10 / 9 | 38 / 32 / 29 | **38.5 / 31.6 / 29.1** (58.6 / 58.8 / 59.2 with canvas antialias off) | 59–60 |
| world fly-in, fps | 17 / 10 / 9 | 40 / 38 / 39 | **40.7 / 37.2 / 38.8** (59.5 / 60.0 on 7086 / 7155 with antialias off) | 60 |
| world re-entry uploads, MB | 835–929 (measured before 51acd70) | — | **133 / 151 / 101** | 0 |
| export ms, cold / warm | 254,234 / 305,263 / 314,258 | 130,90 / 119,86 / 132,91 | **116,91 / 119,88 / 117,87** | 123,118 / 132,112 / 133,122 |
| first terrain frame, ms | 2660 / 3161 / 3278 | 2672 / 3076 / 3267 | **2534 / 2952 / 3098** | 3013 / 3055 / 3086 |
| data-ready, ms | 3304 / 3557 / 3762 | 3407 / 3520 / 3552 | **3326 / 3404 / 3502** | 3235 / 3325 / 3345 |
| auto-align, warm, ms | 83–113 | 76–108 | **81–111** | 79–101 |
| JS heap, MB | 350 / 353 / 432 | 341 / 357 / 425 | **333 / 337 / 390** | 443 / 489 / 531 |
| luma GPU memory, world view, MB | 752 / 729 / 713 | 746 / 723 / 708 | **732 / 744 / 746** | — |
| GPU ms per photo-drag frame (colour pass) | 76–114 (MSAA 4×) | 16–18 | **6.5 / 8.0 / 8.9** (MSAA off while interacting) | 5.6–9.0 |

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
| 3868f30, this commit | This report | — |

## Gate results (run C)

| gate | threshold | result |
|---|---|---|
| photo drag, mouse drag, Blend lens (deck, 3 photos) | ≥ 55 fps | **pass**: 59.0–59.8 |
| world orbit (deck, 3 photos) | ≥ 45 fps | **fail**: 38.5 / 31.6 / 29.1 |
| eval-app, deck ≥ three | within-1° count | **pass**: 12/14 vs 12/14 |
| deck-engine-smoke | 4/4 | **pass**. \|Δyaw\| ≤ 0.04°. Label J = 1.00 / 1.00 / 0.75 / 1.00 |
| CI fast tier | all | **pass**: 27/27 |
| tsc, biome (28 deck-related files) | clean | **pass** |
| reveal-bench, picker-check, step-tiles-check (swisstopo), step-inside-e2e, /roll console | all | **pass** on deck |
| style-baseline (three-pinned) | 16/16 | **fail, pre-existing**: 0/16 with identical pixel counts at a7287da, 0e206b1 and 3868f30. Geometry hashes match |
| Firefox smoke | runs | **not run**: no Playwright Firefox. The WebKit substitute does not launch on this OS |

## Blockers and next-fix list

1. **World view is fill-bound on the multisampled canvas.** This is the only real blocker.
   - **Cause:** `createDeck` (`src/lib/deck/engine.ts`) leaves luma's default `antialias: true` on the canvas. The world view draws straight into that default framebuffer. The photo view is not affected, because it composites from the compositor's own MSAA target.
   - **Evidence:** with `antialias: false` forced by an init script and nothing else changed:
     - world orbit rises to 58.6 / 58.8 / 59.2 fps
     - fly-in rises to 59.5 / 60.0 fps
     - DPR 2 stills look the same, apart from harder edges on the thin gizmo lines
   - **Fix:** set `deviceProps.webgl.antialias: false`.
   - **Then:**
     - Run a DPR 1 pixel diff. Photo view, export and Blend should stay hash-identical; the world view changes only at edges.
     - If the gizmo edges matter, draw them with an MSAA offscreen pass or give them a line-AA shader.
     - Re-run gate C.
2. **style-baseline:** whoever owns `out/lead/style-baseline` re-captures it at the trails-off default (71e846e). Alternatively, the gate treats a three-pinned check as renderer-independent. This does not block deck on its own merits.
3. **Firefox:**
   - Run `npx playwright install firefox`; no package change is needed.
   - Then run the deck smoke.
   - A Windows/ANGLE-D3D11 run would be worth more still.
4. **Flip:**
   - After items 1 to 3, change the default in `src/lib/flags/index.ts`.
   - Keep `?renderer=three` as the escape hatch.
   - Update the sidebar tier in `src/components/panel/flags.ts` and roadmap rule 4.

**Not blocking, worth doing:**

- **Coarse-first loading, render-only.**
  - Terrain appears 0.46–0.70 s sooner.
  - The full-terrain frame costs about +0.1 s, and data-ready +16–80 ms.
  - Accuracy is identical in 9/9 runs (poses, geometry hashes, eye altitude, tile set).
  - It is about 20 lines in `engine.ts`. The scratch wiring shows the z ≤ 14 set with a provisional eye; `this.terrain`, the horizon, readback and auto-align wait for the full set.
  - **Not checked:** a pixel diff of the settled view, and how the coarse-to-full pop looks.
  - Never align on the preview (see [negative-results.md](negative-results.md#gpu-and-performance)).
- **World entry:**
  - Deck runs 30–49 fps during entry, with 1–2 long tasks of 63–192 ms. Re-entry takes about 100–150 ms longer than on three.
  - **Cause:** the canvas resize plus the page upload.
  - **Fix:** cache the full-resolution photo texture across mode switches instead of re-creating it in `terrain-layer.ts` `updateState`.
- **World-view memory:** luma memory is about +520 MB, from the imagery pages. The photo view after a world visit holds 510–524 MB (3 retained pages, by design).

## Known gaps

- **Browsers:**
  - Chromium with ANGLE Metal on one M3 Pro is the only browser/GPU combination measured.
  - Firefox, Safari/WebKit, Windows (D3D11), Linux, integrated or older GPUs and iOS are untested.
- **Context-loss recovery** (`deck/device-lost.ts`) was exercised only in Chromium on Metal.
- **Perf coverage:**
  - Perf was measured at DPR 2 only. DPR 1 was used for pixel diffs and one world-orbit probe (50–58 fps with antialias on).
  - Only three bench photos were timed.
- **Memory:** GPU memory as Chrome reports it was not measured. The figures are luma's counter plus a GL allocation tracker.
- **Unmeasured commits:** c60e8e7, 4f45d66 and 2af1daf landed on master after the gate-C snapshot. They belong to other sessions (deck-webgpu, harness fixes, colour stats) and touch no `src/lib/deck/**` file.

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
- `cull/out/log.txt`, `wc/perf-*.json` and `rb/load-*.log`: the negative-result numbers

The commit messages above carry the headline numbers.
