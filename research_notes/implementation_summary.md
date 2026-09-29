# SoTA pass: what was built and measured (2026-09-24/25)

This pass had three inputs: `rendering_aesthetics_sota.md`, `analysis_algorithms_sota_2026.md` and
`current_state_audit.md`. Every module lives in its own directory so it could be built in parallel with
the other sessions (baseline = `src/lib/geo`, app = `engine.ts`/`materials.ts`), and each owner wires the
modules in when they choose.

## Analysis / algorithms

| Module | What | Measured (12 GT photos) |
|---|---|---|
| `src/lib/refine/` | `refinePose({camera, horizon, skyline, crossCheck?})`. FFT multi-mode yaw init, then IRLS (Huber→Tukey) on per-column skyline rows with a per-column DEM/refraction/GPS error model, one-sided occluder rejection, gated eye-height Δh and refraction k, RANSAC fallback, and a confidence gate (PSR, mode ratio, inflated covariance, yaw observability) | Mean/max yaw error 0.63/5.65° vs baseline 0.84/5.77°. With the sky skyline plus cross-check: **0.26/1.33°** (the max is only IMG_7059, which every method rejects). Converges from ±5–15° yaw perturbations in 66/72 cases vs 56/72. Fits Δh −28/−40 m on the cliff photos. **The /baseline cascade uses it: 11/12 accepted, 0 false accepts, median 0.13° in sky-first mode.** Signature frozen. |
| `src/lib/horizon-fast/` | Drop-in `computeHorizonFastCompat` (same `HorizonProfile`). Ring mosaics in Mercator space, max-mipmap skip, exact great-circle re-anchoring, validation that repairs ±256 m tile corruption, worker pool, in-march peak snap and visibility | Median **240 ms vs 5.3 s (22×)**. p95 error vs a brute-force reference is 0.004–0.029°, against the baseline's 0.009–0.36°. Used by /baseline (0.3 s vs 5–8 s in the browser). Signature frozen. |
| `src/lib/sky/` | `segmentSky(img)` → P(sky): a U²-NetP sky model (**MIT, 4.5 MB ONNX**, onnxruntime-web in a module worker, WebGPU→WASM), a band-limited guided-filter refine, and a classical fallback. `skylineFromSky`, `skylineFromSkyDP` (Viterbi with a continuity prior) | 0.3–0.7 s with WebGPU. Skyline error vs the DEM at GT poses, bias-removed: **2.2 px vs detectSkyline 2.9 px**, with near-full column coverage. DP ≈ argmax on raw error, but in 0f's eval DP+solvePose removes the IMG_7053 false accept (8 accepted, 0 false, worst 0.29°). Classic+cascade remains the default (11/0). DEM noise now dominates, so a finer DEM is the next real gain. |
| ~~`src/lib/render/horizon-gpu.ts`~~ | Edge-rasterised cylindrical horizon (~20 ms vs 100–330 ms). **Deleted in P4 (2026-09-26)**: horizon-fast is the one horizon path. | — |
| ~~`src/lib/render/readback.ts`~~ | PBO + fence async readback. **Dropped in P4 (2026-09-26)**: measured on an M3 Pro (Metal), three's pose drag does no geometry readback while the pose changes (it is debounced 90 ms): 0 readbacks and 0 frames over 20 ms during a 60 Hz drag. The one settle readback costs 7.6 ms median / 12 ms max, outside any drag frame. deck keeps its own async path. | — |

## Rendering / aesthetics (originally `src/lib/render/`; since P4, 2026-09-26, folded into `src/lib/look/` and both renderers)

The modules below were built in `src/lib/render/` and shown in `/studio` and `/lab/*`. P4 moved them into
`src/lib/look/` (engine-neutral TS and shared GLSL) and into both the three.js and deck.gl engines as opt-in
ViewStyle features, then deleted `src/lib/render/`, `/studio` and `/lab/*`. The looks are app presets now
(style/presets.ts): Photo-matched, Swiss relief, Berann, Topo ink and Slope angle.

- **sun.ts** (now look/sun.ts): NOAA solar position from `takenAtUtc`. This pass also found the ingest timezone bug (times were off by +6 h); 9e fixed it.
- **atmosphere.ts + haze-fit.ts** (now look/atmosphere.ts, look/glsl/atmosphere.ts, look/haze-fit.ts): chromatic, altitude-aware Rayleigh+Mie aerial perspective with sun phase, and a Koschmieder fit of airlight and β per channel from dark objects in the photo vs rendered range. The render's haze now follows the photo's (IMG_7053: V≈119 km, quality 0.83).
- **relief.ts, relief-field.ts, ramps.ts** (now look/relief/*, look/glsl/{relief,ramps}.ts; the field is CPU-built): a GPU heightfield giving soft cast shadows (real sun), sky-view factor and curvature in ~90 ms at 2048². Swiss multi-directional shading, an absolute-elevation alpine albedo with lake detection, Tanaka contours, and FATMAP slope classes.
- **composite.ts, guided-filter.ts, color-stats.ts** (now look/glsl/composite.ts, look/{composite,guided-filter,color-stats}.ts): a superset of the engine composite. It adds guided-filter-refined masks, per-distance-band Oklab harmonisation, distance-scaled anti-aliased ink, a log-range cut, the photo's real sky (P(sky)) for keepSky, and dithering.
- **labels.ts + PeakLabels.tsx** (now look/labels/*): PeakFinder-style leader labels with text-width-aware declutter and hysteresis; ~1 ms per layout.
- **`/studio/$id`** (deleted in P4; its presets are app presets now): assembled all of the above into Overlay, Blend and In map with the presets Photo-matched, Swiss relief, Berann, Topo ink and Slope angle, plus an auto-align button (refinePose + confidence, with a tap-peaks hint on reject). **First frame 5.1 s cold, pose drag ~12 ms per frame.**
- `src/routes/lab.*.tsx`: per-module test benches (deleted in P4, with `scripts/render-horizon-bench.mjs`).

## Scripts
`scripts/refine-eval.ts` (writes out/refine/results.json with rows per method), `refine-test.ts`,
`horizon-fast-bench.ts`, `horizon-fast-browser.ts`, `sky-eval.ts`, `sky-browser.mjs`, `sky-bench.ts`,
`src/lib/look/__tests__/{haze-fit.test,labels.check}.ts`.

## Open issues
- Near-field objects missing from the DEM (huts, signs, cables) are still draped and drawn over in the In map view. This needs depth or object segmentation.
- IMG_7059 fails for every method: ridges 2–5 km away, GPS ±37 m. It needs horizontal position offsets as well as Δh.
- Ground truth is "approx" for most photos. At ~0.15° the reference itself is the limit, so a Mapterhorn-based re-annotation is needed.
- ~~engine.ts has not yet adopted the render modules~~: done in P4 (look/**, both engines); the GPU horizon and async readback were dropped.
- iOS: WebGL2 has no float32 colour targets. The geometry buffer and relief field need half-float or WebGPU paths.
