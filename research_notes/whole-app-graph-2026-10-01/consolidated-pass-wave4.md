# WAG wave 4: consolidated browser pass (checklist)

Wave 4 (2026-10-01) landed without browser runs, at the user's request. Run these through `node scripts/gpu/with-render-lock.mjs -- …`, engine pinned, and revert any default that regresses quality (wild-set accepts vs verified poses, GT-12, eval-app), is clearly slower, or breaks the VRAM budget. Written by each stream's implementer; kept verbatim.

## haze-graph

The consolidated browser pass must cover these, all under the render lock with the engine pinned to ?renderer=webgpu:
(a) src/lib/deck-webgpu/compute-bridge.check.ts on several photos, ideally the 4 wave-2 photos plus a few of the 19 dev photos. It now reports bandExact, cpuBandExact, band (expect 'gpu'), oldDefaultExact (the default GPU band plus arg-min program against the old CPU band plus whole-grid read; expect true), argmin.last (expect 'pick') with its count and no 'failed' entry, and fit stagesMs for the gpuBand and cpuBand paths.
(b) scripts/gpu/look-bench.mjs on the 19 dev photos (ids in scratchpad/wag4/dev-ids.txt), checking the haze fit is exact and the look is visually the same as before.
(c) Real-device runtime of the GPUProgram compile, which is the first time luma's program compiler and the custom lowering meet real WGSL, in both cases: the conditional select taken (more than 256 cells within the tolerance) and not taken. Look for any '[haze-graph] GPU grid arg-min off' or 'airlight band failed its spot check' console warnings.
(d) eval-app and eval-app-deck, expected unaffected (the haze fit is look-only).
(e) Stage timing and VRAM: the band graph adds the outRange (3·N·4 B), bandIdx and bandLin pooled buffers per shape (up to MAX_SHAPES of them), so VRAM rises somewhat. Not measured.
(f) WebGL and ?gpu=off still take the CPU band and the whole grid.
No numbers for speed, VRAM or visual parity were measured in this run.

## stats-graph

The consolidated browser pass needs to cover:
1) Run node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/stats-fold-bench.mjs --renderers deck,webgpu against a dev server, on the 19 control-point photos (the default list). Check per photo: valid and count match between the f64, f64-sg, gpu and gpu-sg variants; ColorStats max |delta| is around 1e-5 or less; the composite byte delta of gpu and gpu-sg against f64 is at most 1 on a small fraction of bytes, read against the new "drift" field (ref vs ref-again); identitySanity changes the render; ms per call.
2) Two anomalies in the earlier 1-photo smoke, which used the older composite comparison without the drift field:
   - On webgpu, every variant, including f64-sg (which is not the GPU fold), showed a composite delta of max 89 on about 2.4k bytes. This is probably scene drift between renders, not the stats.
   - On deck, gpu-sg's composite delta exactly equalled identitySanity. That looks like a bench artifact, since its stats delta was 1.2e-6.
   Rerun both with the current bench and confirm.
3) Confirm on a real device that the GPUProgram compiles and lowers, on a device with subgroups (expected webgpu-spmv:subgroup-row) and on one without (workgroup-row). That includes WGSL validity of luma's SpMV shader and BAND_FINALIZE, and no WebGPU validation errors. Also check that lastStatsGraphRun.lowering is filled in.
4) Settle fusion: encodeStats is recorded on the layer render's own encoder with the 256 B staged readback; check timing.stats and fused.statsEncoded on the WebGPU engine.
5) eval-app and eval-app-deck, plus style-baseline, both engines pinned: the harmonized look should be unchanged.
6) ?statsFold=f64 and ?statsSubgroups=off as off switches; the WebGL engine; ?gpu=off.
7) Optional: force the subgroup layout check to fail to exercise the -1e20 marker re-run on the GPU. It is only covered by emulation.

VRAM: three small constant CSR buffers per device (about 13 KB for 32 groups) plus a 208 B vector; not measured.

## flips

For the coordinator's single browser pass, all through the render lock with the engine pinned:
1) Sky: `node scripts/gpu/sky-prep-ab.mjs --url <server>` on the ComputeGraph version (the earlier 69/69 run predates the port). Expect 69/69 photos with prepOn gpu, masks byte-identical, no validation errors, segmentSky time no worse than about 78 ms median. Also confirm the runtime verification of the first 3 photos does not disable the prep.
2) unknownGpu in the browser: `unknown-gpu-gate.mjs run --set gt12 --unknown-gpu off` twice and `on` twice, the same for `--set wild`, then `compare`. Only gt12-off-a exists from the earlier run (out/gpu/unknown-gate/gt12-off-a.json). Judge against base-vs-base noise. The rule's "lost true accept" will probably fire on knife-edge photos such as IMG_6971 noheading and IMG_7018 noheading; that is noise, not a GPU regression. Revert only on a new false or unverified accept.
3) eval-app on webgpu and eval-app-deck, to catch sky or align regressions from skyGpuPrep. Sky masks feed the align.
4) VRAM and load time with skyGpuPrep on: up to 2 cached prep graphs per device, each with its tmp transient of 3·H·lw·4 bytes, about 4.7 MB at 1024×768 → 512.
5) Device-loss and ?gpu=off fallbacks for both flags in the browser: the WebGL engine runs the CPU paths, and the sky worker on WASM ORT preps on the CPU.
Not measured at all: the browser timings for unknownGpu (the node horizon numbers come from Dawn in node), and Safari/Firefox.

## gate-infra

The consolidated browser pass must run all of these through with-render-lock.mjs (none ran here):
1. Precision gate on the dev split, both renderers, with the new defaults: MATCHER_GPU_COMPUTE is set by the script; APP_URL=<dev server> node scripts/gpu/precision-gate.mjs --stage both --renderer both --out out/gpu/precision-gate/wag4. Smoke first: --limit 2 --no-eval. Needs tools/bench/data (manifest and photos), tools/matcher/.venv and data/control-points.json. Report the verdict, base vs base2 noise per photo (expected identical after the redraw fix), cand quality vs base, and the GT-12 arm.
2. Blank-first-draw fix: on a fresh page, run autoAlign 3 times on wc_0005 and wc_0009 (deck and webgpu) and check the first call's sils equal the later ones. The gate's base2 arm covers this. Also report how often silTiming.redraws is above 0.
3. loadFullTerrain: no "loadFullTerrain: timed out" across the dev-split full-terrain photos on both engines. Look for "[terrain-stream] … stood in for" warnings, stats.failed and tile-cache network.timeouts. Check that wc_0052 deck now loads full terrain (fullTerrainMs > 0) and what it accepts.
4. eval-app on deck with certified-f32 now gets the WebGPU flags: check alignCertified > 0 on deck.
5. Full tier (deck-smoke, eval-app, eval-app-deck, style-baseline) for regressions from the redraw and the streamer changes.
6. Load time and VRAM: not measured; the changes are not expected to move them.
Not addressed: the root cause inside luma or deck of the blank first draw. It may also affect the first geometry-buffer refresh (haze fit, labels), which I did not change.

## perf-vram

The consolidated browser pass (WebGPU engine, exclusive lock unless noted) must cover:
1. Load time: `RENDER_LOCK_EXCLUSIVE=1 node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/decode-load-probe.mjs --url <dev> --runs 3 IMG_7086 IMG_6958 IMG_7018`. Compare with out/decode-load/before.json in the sandbox (ready median on 4006 / off 4019 ms). Check that `tiles.resident` ≈ `tiles.gpu` and `statsOnlyBytes` ≈ 0. Atlas MB at ready should be at or below the before value, and the growth after the pan should be close to zero. If decode-on is clearly slower than off, flip terrainGpuDecode back.
2. Frames for the decode change: `scripts/deck-webgpu/atlas-frames-check.mjs --query terrainGpuDecode=on` (byte-identical) and the height-gather parity (`scripts/gpu/terrarium-ingest-check.mjs` and the height-gather certificate counters must stay at 0 misses), including after a pan in which spare tiles lose their lease and re-decode at draw time.
3. Imagery VRAM: `node scripts/gpu/with-render-lock.mjs -- node scripts/gpu/imagery-vram-probe.mjs --url <dev>` (idle default is now 14 s). Compare with out/vram/imagery-before.json in the sandbox (drape 905–946 MiB, drape then idle 1076–1117, world 789–805). Also `scripts/gpu/vram-probe.mjs` and `scripts/gpu/vram-attribution.mjs` for the matcher drape, deck (726–783) vs webgpu.
4. Visual parity of the tiered imagery: `scripts/gpu/w4b-imagery-parity.mjs`, `scripts/deck-engine-smoke.mjs` and `scripts/gpu/drape-identity.mjs`. These are not byte-identical for 256 px tiles by design, so judge them visually, against deck too. A world-mode imagery check after an idle compaction should show no tile on the wrong layer.
5. The matcher end to end (renderPoseView, satellite look, then back to the photo look): eval-app and eval-app-deck, with no new false accepts on the wild set. Watch for drape re-upload cost when pose views are more than 10 s apart.
6. Device loss while leases are live; `?gpu=off`; the WebGL engine (unchanged code path).
7. A shader validation error with both imagery arrays bound on a core-limits device (16 sampled textures per stage). The engine's terrain program with drape + relief uses about 9; only lab or roll paths that combine drape with multi-drape could come close.
