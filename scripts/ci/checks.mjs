// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The check registry for scripts/ci/run.mjs (roadmap N1). One entry per check:
//   id       short name used by --only / --skip and in known-failures.json
//   tier     "fast" (no browser, no dev server) or "full" (browser; needs the dev server)
//   group    free text for the table
//   cmd      argv; "{url}" is replaced by the dev-server URL in full-tier checks
//   needs    repo-relative paths the check reads that git does not track (data/, public/photos/, out/);
//            when one is missing (fresh CI checkout) the check is SKIPPED, not failed
//   browser  true → wrapped in `node scripts/gpu/with-render-lock.mjs -- …` and run one at a time
//   failIf   regexp on the output that marks a failure even when the exit code is 0
//   gate     optional (output, ctx) => null | "reason" — extra pass/fail logic on the output
//   timeoutS per-check wall clock (the render-lock wait is included for browser checks)
//
// "biome" is not a command: run.mjs handles it itself (per-file ratchet against known-failures.json).

const tsx = (file, ...args) => ["npx", "tsx", file, ...args];

// Renderer pinning: every browser check names its engine explicitly (?renderer= / --renderer), so a
// change of the app's default renderer never silently changes what a gate measures.

/** eval-app gate: the pinned engine really ran, and 'N/M within 1° yaw' ≥ the baseline for that engine. */
const evalAppGate = (renderer, baselineKey) => (out, ctx) => {
	const eng = /^engine: (\S+) \(pinned\)/m.exec(out);
	if (!eng) return "no 'engine: … (pinned)' line in the output";
	if (eng[1] !== renderer)
		return `renderer=${renderer} pinned but engine ${eng[1]} ran`;
	const m = /(\d+)\/(\d+) within 1° yaw; median auto px error ([\d.∞]+)/.exec(
		out,
	);
	if (!m) return "no summary line in the output";
	const [ok, of, med] = [Number(m[1]), Number(m[2]), m[3]];
	ctx.metrics = { renderer, within1deg: ok, of, medianAutoPx: med };
	const min = ctx.baseline?.[baselineKey]?.minWithin1deg;
	if (min == null) return null; // no baseline yet (first run / --update-baseline records it)
	return ok < min ? `${ok}/${of} within 1° < baseline ${min}` : null;
};
const lock = (argv) => [
	"node",
	"scripts/gpu/with-render-lock.mjs",
	"--",
	...argv,
];

export const CHECKS = [
	// ---- fast: static --------------------------------------------------------------------------
	{
		id: "tsc",
		tier: "fast",
		group: "static",
		cmd: ["npx", "tsc", "--noEmit", "-p", ".", "--pretty", "false"],
		note: "also enforces src/lib/renderer.check.ts (type-only: both engines satisfy Renderer)",
		timeoutS: 600,
		// Ratchet: errors listed in known-failures.json tsc.allowed (matched on "file: TSnnnn: message",
		// no line numbers) are tolerated; under CI=1 so are tsc.ciAllowed (imports of gitignored data).
		gateOwnsExit: true,
		gate(out, ctx) {
			const errs = [
				...out.matchAll(/^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/gm),
			].map((m) => `${m[1]}: ${m[2]}: ${m[3]}`);
			if (ctx.code !== 0 && !errs.length)
				return "tsc failed without parsable errors";
			const allowed = new Set([
				...(ctx.baseline.tsc?.allowed ?? []),
				...(ctx.isCI ? (ctx.baseline.tsc?.ciAllowed ?? []) : []),
			]);
			const fresh = errs.filter((e) => ctx.strict || !allowed.has(e));
			if (fresh.length)
				return `${fresh.length} new error(s): ${fresh[0].slice(0, 90)}`;
			if (errs.length) ctx.known = `${errs.length} baseline error(s) only`;
			return null;
		},
	},
	{
		id: "biome",
		tier: "fast",
		group: "static",
		builtin: "biome",
		timeoutS: 300,
	},

	// ---- fast: unit tests (Vitest) -------------------------------------------------------------
	{
		id: "unit",
		tier: "fast",
		group: "unit",
		// Every *.spec.ts / *.spec.tsx (vitest.config.ts; src/test/README.md). Pure CPU: no GPU, no
		// browser, no network, no gitignored data, so it never SKIPs.
		cmd: ["npx", "vitest", "run"],
		timeoutS: 600,
		gateOwnsExit: true,
		gate(raw, ctx) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
			const out = raw.replace(/\x1b\[[0-9;]*m/g, "");
			const files = /Test Files\s+(.*)/.exec(out)?.[1]?.trim();
			const tests = /\n\s+Tests\s+(.*)/.exec(out)?.[1]?.trim();
			if (ctx.code !== 0)
				return `vitest failed: ${tests ?? files ?? "see log"}`;
			if (!tests) return "no 'Tests' summary line in the vitest output";
			ctx.metrics = { files, tests };
			return null;
		},
	},

	// ---- fast: style / look / labels -----------------------------------------------------------
	{
		id: "style-check",
		tier: "fast",
		group: "style",
		cmd: tsx("scripts/style-check.ts"),
		timeoutS: 300,
	},
	{
		id: "spdx",
		tier: "fast",
		group: "static",
		cmd: ["node", "scripts/ci/spdx.mjs", "--strict"],
		note: "every first-party source file carries SPDX-License-Identifier + SPDX-FileCopyrightText (luma.gl convention); --strict: a file naming another licence or a port must be resolved by hand (ports carry both copyright holders)",
		timeoutS: 60,
	},
	{
		id: "examples",
		tier: "fast",
		group: "static",
		cmd: ["node", "scripts/examples.mjs", "check"],
		note: "examples/** (luma.gl-style standalone examples): tsc -p per example; the browser smoke is `node scripts/examples.mjs smoke`",
		timeoutS: 180,
	},
	{
		id: "ontology",
		tier: "fast",
		group: "static",
		cmd: tsx("src/lib/ontology/ontology.check.ts"),
		note: "Rigi ontology: catalogue integrity, id schemes vs data, storage-key registry, canonical semantics == app (picker HIGH, resolvePose order), reports/ontology.md current; crosswalk/realization exhaustiveness is enforced by tsc",
		needs: ["public/photos/photos.json"],
		timeoutS: 120,
	},
	{
		id: "matcher-rule-replay",
		tier: "fast",
		group: "static",
		cmd: tsx("src/lib/matcher/rule-replay.check.ts"),
		note: "T6 frozen rule in TypeScript replayed over the recorded runs in tools/bench/final/out/B (dev split; REPLAY_ALLOW_TEST=1 adds test, equality only): selected source, level and fused pose equal the Python service's; SKIPs without the recordings",
		needs: ["tools/bench/final/out/B"],
		timeoutS: 60,
	},
	{
		id: "gipfelbuch",
		tier: "fast",
		group: "static",
		cmd: tsx("src/lib/gipfelbuch/gipfelbuch.check.ts"),
		note: "Gipfelbuch graph integrity + ontology link (ids, uniqueness, taxonomy agreement, import boundary)",
		timeoutS: 60,
	},
	{
		id: "gipfelbuch-contrast",
		tier: "fast",
		group: "static",
		cmd: tsx("src/components/gipfelbuch/swiss/contrast.check.ts"),
		note: "Gipfelbuch ink contrast gate: text inks reach 4.5:1 on paper and paper-deep, relief (BL) and MG are never text colours",
		timeoutS: 60,
	},
	{
		id: "gipfelbuch-notebook",
		tier: "fast",
		group: "static",
		cmd: tsx("src/components/gipfelbuch/notebook/notebook.check.ts"),
		note: "Gipfelbuch field notebook covers every node once, #group anchors for every group, needs-notes resolve, seeded strokes deterministic",
		timeoutS: 60,
	},
	{
		id: "tafel",
		tier: "fast",
		group: "static",
		cmd: tsx("src/components/gipfelbuch/tafel/tafel.check.ts"),
		note: "Tafel projector lands on solvedRows (median < 0.5 px, p90 < 3 px) for accepted photos; spill bakes match aspect, band, camera and reach 3:1 on the plate",
		timeoutS: 60,
	},
	{
		id: "tafel-sheets",
		tier: "fast",
		group: "static",
		cmd: tsx("src/components/gipfelbuch/tafel/sheets.check.ts"),
		note: "Every Gipfelbuch node has sheet figures and one chapter; ledger paths resolve and format on all 12 photos; bands render without NaN",
		timeoutS: 90,
	},
	{
		id: "gpu-clear-lint",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/clear-lint.check.ts"),
		note: "ComputeGraph clear lint (gpu/core/clear-lint.ts): partial/atomic rule, GPU-condition rule (same gate, command rewrite, unaudited nodes, whole clears)",
		timeoutS: 60,
	},
	{
		id: "gpu-binding-guard",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/binding-guard.check.ts"),
		note: "storage binding guards (gpu/core/binding-guard.ts): zero-size binding and minStorageBufferOffsetAlignment rejected at encode time (pure helper)",
		timeoutS: 60,
	},
	{
		id: "gpu-uniform-block",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/uniform-block.check.ts"),
		note: "defineUniformBlock (gpu/core/uniform-block.ts) packs byte-identically to the former hand-packed uniform words (geo-query, silhouette, terrain-cull; edge values)",
		timeoutS: 60,
	},
	{
		id: "gpu-uniform-block-look",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/uniform-block-look.check.ts"),
		note: "look / precision uniform blocks (gpu/look/uniform-blocks.ts, relief-heights, ieee-probe) pack byte-identically to the former hand-packed words (edge values)",
		timeoutS: 60,
	},
	{
		id: "gpu-uniform-block-a",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/uniform-block-a.check.ts"),
		note: "align / solve-fold / horizon uniform packers (gpu/{align,solve,horizon}/uniforms.ts) are byte-identical to the former hand-packed words (certified-f32 inputs: -0, NaN, subnormals, u32 max)",
		timeoutS: 60,
	},
	{
		id: "gpu-uniform-block-b",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/uniform-block-b.check.ts"),
		note: "horizon march / skyglobal / skyline / sky prep+refine / splat-sort uniform packers (gpu/*/uniforms.ts) are byte-identical to the former hand-packed words (-0, NaN payloads, subnormals, u32 max)",
		timeoutS: 60,
	},
	{
		id: "gpu-inspect",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/inspect.check.ts"),
		note: "graph inspection (gpu/core/inspect.ts, inspector.ts): summary of stats / preflight / inspector samples, observation through the upstream GPUCommandGraphInspector, getGpuGraphProfile, device-loss cleanup (fake device)",
		timeoutS: 60,
	},
	{
		id: "app-graph",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/app-graph/app-graph.check.ts"),
		note: "app graph manifest (gpu/app-graph/manifest.ts) ↔ code: every cachedGraph group in src/lib/gpu/** and src/lib/deck-webgpu/** declared, every declared group used; islands, ids, paths",
		timeoutS: 60,
	},
	{
		id: "app-graph-table",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/app-graph-table.ts", "--check"),
		note: "research_notes/whole-app-graph-2026-10-01/islands.generated.md is current with the manifest (regenerate: npx tsx scripts/gpu/app-graph-table.ts --write)",
		timeoutS: 60,
	},
	{
		id: "gpu-raw-lint",
		tier: "fast",
		group: "gpu",
		cmd: ["node", "scripts/ci/gpu-raw-lint.mjs"],
		note: "ratchet on raw WebGPU / private-luma / raw WebGL escapes in src/lib (navigator.gpu, native handle use, casts to private members, gl.*) against scripts/ci/gpu-raw-baseline.json; fails only when a file's count rises",
		timeoutS: 30,
	},
	{
		id: "kernel-binding-use",
		tier: "fast",
		group: "gpu",
		cmd: ["node", "scripts/gpu/kernel-layout-check.mjs"],
		note: "every defineKernel spec: layout matches WGSL @binding declarations AND each declared binding is reachable from the entry point (auto layout drops unused ones; 4d92d3f); fixture of the pre-fix scan-totals WGSL must be flagged",
		timeoutS: 60,
	},
	{
		id: "terrain-cull",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/layers/terrain-cull-math.check.ts"),
		note: "batched-terrain GPU cull (WAG W1.5): f32 kernel twin ⊇ CPU sphereInView on random + on-plane spheres; compaction order = visibleRows; WGSL binding layouts",
		timeoutS: 60,
	},
	{
		id: "cpu-heights",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/dem/cpu-heights.check.ts"),
		note: "lazy CPU heights view (WAG W2.4): getCpuHeights materialises once; heightStats == the batch-grid / colour-ramp scans; batch grid from stats == from heights; lazy TerrainSet queries == eager; downsample plumbing == the old loop",
		timeoutS: 60,
	},
	{
		id: "height-gather",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/height-gather.check.ts"),
		note: "GPU height gathers (WAG W2.4, flag terrainGpuDecode): gridCorners + blendCorners == sampleGrid; plan + emulated kernel + finish == TerrainSet.heightAt bit for bit on eager / lazy / non-resident tiles; nonce and slot certificate fall back to heightAt; replayHeights(buildTrailSegments, localMaxOf) == direct",
		timeoutS: 60,
	},
	{
		id: "atlas-layout",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/atlas-layout.check.ts"),
		note: "TextureArrayAtlas math (WAG W2.2): layer order = the old HeightPool / ImageryArray free lists, grow capacities, per-mip grow copies, ancestor uv window == ancestorCrop bits; WAG perf-vram: compaction plan + emulated copies, imagery tier encoding (= terrain.ts WGSL decode), height-layer leases, spare-mesh lease budget (browser frame gate: scripts/deck-webgpu/atlas-frames-check.mjs)",
		timeoutS: 60,
	},
	{
		id: "geo-unpack",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/geo-unpack.check.ts"),
		note: "GPU unpack of the geometry target (range / xyz planes): the WGSL's logic as a TS reference is byte-equal to the CPU unpack loop on sky / NaN / Inf / denormal / -0 words, odd words are flagged for the CPU fallback, no arithmetic on texel values in the WGSL (no browser)",
		timeoutS: 60,
	},
	{
		id: "range-webgpu",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/roll/map/range-webgpu.check.ts"),
		note: "WebGPU range hand-off (RangeGpuWebGpu): the reference rule equals the old CPU path (unpack, rangeMapFrom, coarsen) on sky / NaN / Inf / negative / denormal words and odd sizes; with DAWN_DIR the copy into an r32float atlas cell (neighbours untouched) and the coarse grid are byte-equal to it on a Dawn device (GPU half SKIPs without DAWN_DIR)",
		timeoutS: 180,
	},
	{
		id: "base-slots",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/base-slots.check.ts"),
		note: "batched-terrain packed base-grid slots (WAG W1.6): no overlap, inside capacity, f32-exact offsets, 1.5x growth over random pan sequences (browser frame gate: scripts/deck-webgpu/atlas-frames-check.mjs)",
		timeoutS: 60,
	},
	{
		id: "theme",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/theme/__tests__/theme.check.ts"),
		note: "light mode: the pre-paint boot script and resolveTheme() agree in every precedence case (flag, storage, webdriver, prefers-color-scheme)",
		timeoutS: 60,
	},
	{
		id: "frame-timings",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/frame-timings-core.check.ts"),
		note: "per-pass GPU frame timings (flag gpuFrameTimings): query-set ring (4, drop when all in flight, reuse, discard on failure), 32-pass cap, per-pass sums, rolling mean (browser: not run)",
		timeoutS: 60,
	},
	// model weights (public/models, scripts/models/manifest.json): sha256 per present row + createOrtSession on the sky model in node
	{
		id: "models",
		tier: "fast",
		group: "models",
		cmd: tsx("src/lib/models/models.check.ts"),
		needs: ["public/models/skyseg-u2netp.873ea284.onnx"],
		note: "every manifest row present in public/models matches its size and sha256; createOrtSession runs the sky model on WASM in node (output shape, P in [0,1]); missing rows SKIP (node scripts/models/fetch.mjs)",
		timeoutS: 300,
	},
	{
		id: "labels",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/__tests__/labels.check.ts"),
		timeoutS: 300,
	},
	// opt-in stroke looks (LF2): ridge sketch wobble + trail pencil / glow, pure TS reference and shader text
	{
		id: "strokes",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/__tests__/strokes.check.ts"),
		timeoutS: 300,
	},
	{
		id: "flow",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/flow/__tests__/flow.check.ts"),
		note: "wind-drift field math (terrain-deflected wind), advection twin, WGSL layout (LF4; browser not run)",
		timeoutS: 120,
	},
	// terroir cartography (src/lib/terroir, reports/terroir-cartography.md): pure-node checks
	{
		id: "terroir-labels",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/terroir/labels/labels.check.ts"),
		timeoutS: 120,
	},
	{
		id: "terroir-viz",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/terroir/viz/viz.check.ts"),
		timeoutS: 120,
	},
	{
		id: "terroir-roll",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/terroir/roll/roll.check.ts"),
		timeoutS: 120,
	},
	{
		id: "terroir-pattern",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/terroir/pattern.check.ts"),
		timeoutS: 120,
	},
	{
		id: "terroir-hatch",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/terroir/hatch.check.ts"),
		timeoutS: 120,
	},
	{
		id: "water-waves",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/water/__tests__/waves.test.ts"),
		timeoutS: 120,
	},
	{
		id: "terroir-pack",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/terroir/pack.check.ts"),
		timeoutS: 120,
	},
	{
		id: "haze-fit",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/__tests__/haze-fit.test.ts"),
		timeoutS: 300,
	},
	{
		id: "haze-tail",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/gpu/look/haze-tail.check.ts", "16"),
		note: "GPU haze fit's CPU tail (hoisted atmPath exp, refine memo, typed-sort airlight) = fitHaze bit for bit on 16 synthetic scenes (no GPU)",
		timeoutS: 300,
	},
	{
		id: "haze-band",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/gpu/look/haze-band.check.ts", "8"),
		note: "GPU airlight band (default on): the WGSL's integer logic (emulated) = airlightBand on adversarial planes, the spot check's teeth, band-path tail = fitHaze (no GPU)",
		timeoutS: 300,
	},
	{
		id: "haze-argmin",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/gpu/look/haze-argmin.check.ts", "400"),
		note: "haze grid arg-min GPUProgram (default on): its integer min / candidate / rank logic (emulated) gives the whole grid's candidates on adversarial grids; per-call check teeth; the program lowers with select the only GPU-indirect-gated node (no GPU)",
		timeoutS: 300,
	},
	{
		id: "stats-fold",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/gpu/look/color-stats-fold.check.ts", "12"),
		note: "band-stats fold on the GPU (?statsFold=gpu, WAG-4): CPU emulation of BAND_STATS(_SG) partials + f32 GPUGroupAggregation fold + BAND_FINALIZE vs reduceBands f64 on 12 synthetic scenes (|Δ| ≤ 2e-5, harmonize bytes ≤ 1 LSB on < 0.5 %); fold group keys; finalize edge cases; subgroup-marker; teeth (no GPU)",
		timeoutS: 120,
	},
	{
		id: "bridge-fusion",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/deck-webgpu/compute-bridge-fusion.check.ts"),
		note: "WAG W1.2 settle fusion bookkeeping: mask texture pool, prepared-masks adoption rules (no GPU)",
		timeoutS: 120,
	},

	// ---- fast: pose / refine / export ----------------------------------------------------------
	{
		id: "annotate-selftest",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/annotate-selftest.ts"),
		failIf: /^FAIL\b/m, // prints PASS/FAIL but always exits 0
		timeoutS: 300,
	},
	{
		id: "eye-check",
		tier: "fast",
		group: "pose",
		cmd: tsx("src/lib/pose6dof/eye.check.ts"),
		timeoutS: 300,
	},
	{
		id: "pose6dof",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/test-pose6dof.ts", "--quick"),
		needs: ["data/control-points.json", "data/ground-truth.json"],
		timeoutS: 600,
	},
	{
		id: "refine-test",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/refine-test.ts"),
		timeoutS: 300,
	},
	{
		id: "photoprep",
		tier: "fast",
		group: "pose",
		cmd: tsx("src/lib/gpu/photoprep/photoprep.check.ts", "4", "100000"),
		note: "GPU photo prep (edge map + prior-sky refit): integer-f64 twin vs V8 doubles, kernel twins vs align.ts",
		timeoutS: 120,
	},
	{
		id: "ingest",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/ingest/ingest.check.ts"),
		note: "GPU Terrarium decode: f32 twin == decodeTerrarium over all 2^24 RGB, f32-exact partials, ingest layout math (browser byte/height gate: scripts/gpu/terrarium-ingest-check.mjs)",
		timeoutS: 120,
	},
	{
		id: "photoprep-resident",
		tier: "fast",
		group: "pose",
		cmd: tsx("src/lib/gpu/photoprep/resident.check.ts"),
		note: "photo prep residency (W1.1): lazy CPU read, memo, pins, LRU eviction, device-mismatch fallback (fake device)",
		timeoutS: 60,
	},
	{
		id: "ieee-probe",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/precision/ieee-probe.check.ts"),
		note: "shared certified-f32 arithmetic: df32 ops within their budgets (also with ±3 ULP div/sqrt); the strict-IEEE probe verifier accepts the emulated machine and rejects re-associated TwoSum, unfused fma, 8-ULP division",
		timeoutS: 60,
	},
	{
		id: "horizon-cert",
		tier: "fast",
		group: "pose",
		cmd: tsx("src/lib/gpu/horizon/certified.check.ts"),
		note: "certified-f32 horizon stages (tan → degrees, ENU, resample) on the f32 emulation: 0 false certifications, bit-identical to the f64 path; DEM cases when out/gpu/horizon-cert/real-cases.json exists",
		timeoutS: 120,
	},
	{
		id: "align-cert",
		tier: "fast",
		group: "pose",
		cmd: tsx("src/lib/gpu/align/cert.check.ts", "2", "1"),
		note: "certified-f32 align refine (W3.3) in f32 / double-f32 emulation under the production host loop: AlignResult bit-identical to autoAlign (synthetic + up to 2 real photos when public/photos, .cache/horizon and sips exist), fault caught by the runtime checks; full set: `npx tsx src/lib/gpu/align/cert.check.ts 100 4`",
		timeoutS: 120,
	},
	{
		id: "export",
		tier: "fast",
		group: "export",
		cmd: tsx("scripts/test-export.ts"),
		needs: ["public/photos/photos.json", "public/photos/IMG_7131.jpg"],
		timeoutS: 300,
	},

	// ---- fast: near field / Step Inside --------------------------------------------------------
	{
		id: "nearfield-core",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/nearfield.check.ts"),
		timeoutS: 300,
	},
	{
		id: "splat-loaders",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/splat-loaders.check.ts"),
		timeoutS: 120,
	},
	{
		id: "splat-loaders-ext",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/splat-loaders-ext.check.ts"),
		note: "SPZ v2/v3/v4 + KSPLAT 0/1 + plain .splat through @loaders.gl/splats (hand-built fixtures)",
		timeoutS: 120,
	},
	{
		id: "nearfield-export",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/export-check.ts"),
		timeoutS: 300,
	},
	{
		id: "nearfield-spot",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/roll/spot.check.ts"),
		timeoutS: 300,
	},
	{
		id: "nearfield-eyes",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/roll/eyes.check.ts"),
		timeoutS: 300,
	},
	{
		id: "nearfield-propagate",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("tools/nearfield/propagate/propagate.check.ts"),
		timeoutS: 300,
	},
	{
		id: "tiles3d",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/tiles3d/tiles3d.check.ts"),
		timeoutS: 120,
	},
	{
		id: "nearfield-service",
		tier: "fast",
		group: "nearfield",
		cmd: [
			"tools/matcher/.venv/bin/python",
			"-m",
			"unittest",
			"discover",
			"-s",
			"tools/nearfield/service/tests",
		],
		needs: ["tools/matcher/.venv/bin/python"],
		note: "near-field service CR-05 caps and error paths, in-process (no torch, no model load); SKIPs without the matcher venv",
		timeoutS: 120,
	},
	{
		id: "splat-sort",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("scripts/nearfield/splat-sort-test.ts"),
		timeoutS: 300,
	},

	// ---- fast: concordance (kept: core, priors/focal table, cues, occluder; app.check asserts ?concord defaults off)
	{
		id: "concord-core",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/concord/core/core.check.ts"),
		timeoutS: 300,
	},
	{
		id: "concord-priors",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/concord/priors/priors.check.ts"),
		timeoutS: 300,
	},
	{
		id: "concord-cues",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/concord/cues/cues.check.ts"),
		timeoutS: 300,
	},
	{
		id: "concord-app",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/concord/app/app.check.ts"),
		timeoutS: 300,
	},
	{
		id: "concord-occl",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/concord/occl/occl.check.ts"), // offline; --live is never used here
		timeoutS: 300,
	},
	{
		id: "cache-range",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/cache/range.check.ts"),
		note: "tile cache byte ranges (key = url + range), mocked server",
		timeoutS: 60,
	},
	{
		id: "terrain-stall",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/deck/terrain-stream.check.ts"),
		note: "terrain loads that never complete: the streamer retries then gives up on an always-failing tile (set completes, stats.failed), tile-cache fetch stall timeout (TimeoutError), DEM ancestor fallback after a stall",
		timeoutS: 60,
	},
	{
		id: "silhouette-mask",
		tier: "fast",
		group: "concord",
		cmd: tsx("scripts/gpu/silhouette-mask-check.ts"),
		note: "silhouette re-rank mask: CPU emulation of the GPU predicate vs the CPU scorer (Object.is), zero-texture and stale-nonce fallbacks, redrawIfBlank (a blank finalist render is drawn once more)",
		timeoutS: 120,
	},
	{
		id: "precision-gate-score",
		tier: "fast",
		group: "concord",
		cmd: ["node", "scripts/gpu/precision-gate.check.mjs"],
		note: "precision gate scoring (precision-gate-score.mjs): identity vs the f64 noise floor, quality arm against the tracked blind verdicts (false accepts, lost correct accepts, unverified new accepts), GT-12 arm, verdict",
		timeoutS: 60,
	},

	// ---- fast: geocam (GEO phase A, src/lib/geocam; synthetic, offline) ----------------------------
	{
		id: "geocam-map",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/map/map.check.ts"),
		timeoutS: 300,
	},
	{
		id: "geocam-priors",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/priors/priors.check.ts"), // WMM2025 vs NOAA test values; asserts every geo* flag defaults off
		timeoutS: 300,
	},
	{
		id: "geocam-lakes",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/lakes/lakes.check.ts"),
		timeoutS: 300,
	},
	{
		id: "geocam-integrity",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/integrity/integrity.check.ts"),
		timeoutS: 300,
	},

	// ---- fast: node checks that existed but were not registered (found by the unit system's
	// registry spec, scripts/ci/__tests__/checks.spec.ts, 2026-10-01; each passed in node, no GPU) -----
	{
		id: "bridge-compute",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/compute-bridge.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-atm-sky",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/atm-sky.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-composite",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/composite.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-drape",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/drape.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-geometry-source",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/geometry-source.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-gizmo",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/gizmo.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-multi-drape",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/multi-drape.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-photo-sky",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/photo-sky.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-ridges",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/ridges.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-splats",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/splats.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-terrain-styles",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/terrain-styles.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-tiles3d",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/tiles3d.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-pins",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/pins.check.ts"),
		timeoutS: 120,
	},
	{
		id: "layer-trail",
		tier: "fast",
		group: "deck-webgpu",
		cmd: tsx("src/lib/deck-webgpu/layers/trail.check.ts"),
		timeoutS: 120,
	},
	{
		id: "align-refine-guard",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/align/refine-guard.check.ts"),
		timeoutS: 120,
	},
	{
		id: "nebelmeer",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/nebelmeer/nebelmeer.test.ts"),
		timeoutS: 120,
	},
	{
		id: "precipitation",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/weather/__tests__/precipitation.test.ts"),
		timeoutS: 120,
	},
	{
		id: "picker-candidates",
		tier: "fast",
		group: "picker",
		cmd: tsx("src/lib/picker/candidates.check.ts"),
		timeoutS: 120,
	},
	{
		id: "roll-propagate",
		tier: "fast",
		group: "roll",
		cmd: tsx("src/lib/roll/propagate/propagate.check.ts"),
		needs: ["public/photos/photos.json", "data/ground-truth.json"],
		timeoutS: 120,
	},

	// ---- full: browser, one at a time under the render lock -------------------------------------
	{
		id: "style-baseline",
		tier: "full",
		group: "parity",
		browser: true,
		// The script pins ?renderer=deck (WebGL on SwiftShader; it reads deck's geometry source) and sets no
		// ?style / ?concord flag, so this row is also the concord-off (and look-off) parity gate: classic
		// must stay pixel-identical with flags off. Its reference (out/lead/style-baseline) is
		// captured once on deck (`node scripts/gpu/with-render-lock.mjs -- node
		// scripts/style-baseline.mjs capture`); until then `needs` is missing and the row SKIPs.
		cmd: lock([
			"node",
			"scripts/style-baseline.mjs",
			"check",
			"--url",
			"{url}",
		]),
		needs: [
			"out/lead/style-baseline/baseline.json",
			"public/photos/photos.json",
		],
		note: "deck-pinned (WebGL): classic pixel identity + geometry hash; = concord-off parity (no style/concord flag). SKIPs until the deck reference is captured",
		timeoutS: 3600,
	},
	{
		id: "deck-smoke",
		tier: "full",
		group: "parity",
		browser: true,
		cmd: lock([
			"node",
			"scripts/deck-engine-smoke.mjs",
			"--url",
			"{url}",
			"--out",
			"out/ci/deck-engine-smoke.json",
			"--renderer",
			"webgpu",
		]),
		needs: ["public/photos/photos.json"],
		note: "?renderer=deck (WebGL, reference) vs ?renderer=webgpu (each run checks the engine that ran): |Δyaw| ≤ 0.5°, label overlap ≥ 0.6",
		timeoutS: 3600,
	},
	{
		id: "settle-submits",
		tier: "full",
		group: "parity",
		browser: true,
		cmd: lock([
			"node",
			"scripts/deck-webgpu/settle-submits.mjs",
			"IMG_7086",
			"--url",
			"{url}",
			"--renderer",
			"webgpu",
		]),
		needs: ["public/photos/photos.json", "public/photos/IMG_7086.jpg"],
		note: "WAG W1.2 settle fusion, webgpu-pinned: masks + band stats byte-identical with settleFusion off / on; submits per settle and settle-to-labels latency reported (not gated)",
		timeoutS: 1800,
	},
	{
		id: "graph-plumbing-ab",
		tier: "full",
		group: "parity",
		browser: true,
		cmd: lock([
			"node",
			"scripts/gpu/graph-plumbing-ab.mjs",
			"--url",
			"{url}",
			"--renderer",
			"webgpu",
		]),
		note: "WAG graph plumbing, webgpu-pinned: silhouette-gpu and geo-query-gpu on core ComputeGraphs vs a replica of their former raw dispatches, byte-identical read-backs; timing reported (not gated)",
		timeoutS: 3600,
	},
	{
		id: "eval-app",
		tier: "full",
		group: "accuracy",
		browser: true,
		cmd: lock(["node", "scripts/eval-app.mjs", "--renderer", "webgpu"]),
		// one retry on a crash: the first run on 2026-09-29 died in playwright's launch
		// ("SyntaxError: Unexpected end of JSON input" in coreBundle.js) and passed on re-run
		retries: 1,
		env: { APP_URL: "{url}" },
		needs: ["data/control-points.json", "public/photos/photos.json"],
		note: "webgpu-pinned (the app default); gate: 'N/M within 1° yaw' ≥ known-failures.json evalAppWebgpu.minWithin1deg",
		timeoutS: 3600,
		// advisory until a webgpu run records evalAppWebgpu (run.mjs --update-baseline)
		advisoryUntil: "evalAppWebgpu",
		gate: evalAppGate("webgpu", "evalAppWebgpu"),
	},
	{
		id: "eval-app-deck",
		tier: "full",
		group: "accuracy",
		browser: true,
		cmd: lock(["node", "scripts/eval-app.mjs", "--renderer", "deck"]),
		retries: 1,
		env: { APP_URL: "{url}" },
		needs: ["data/control-points.json", "public/photos/photos.json"],
		note: "deck-pinned (WebGL2); gate: 'N/M within 1° yaw' ≥ known-failures.json evalAppDeck.minWithin1deg",
		timeoutS: 3600,
		// Were evalAppDeck removed from the
		// baseline, a failure of any kind (gate, exit code, timeout) would report KNOWN, not FAIL
		advisoryUntil: "evalAppDeck",
		gate: evalAppGate("deck", "evalAppDeck"),
	},
	// Wave 5 (2026-10-02). Dawn checks print SKIP and exit 0 without DAWN_DIR (a webgpu@0.3.0 install dir).
	{
		id: "wgsl-compile",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/wgsl-compile-all.ts"),
		timeoutS: 120,
	},
	{
		id: "features",
		tier: "fast",
		group: "nn",
		cmd: tsx("src/lib/features/__tests__/parity.check.ts", "--quick"),
		needs: [
			"out/features-parity/index.json",
			"public/models/aliked-n16.dc5fb7d3.safetensors",
			"public/models/lightglue-aliked.f35aee62.safetensors",
		],
		note: "browser ALIKED + LightGlue (src/lib/features) vs the PyTorch lightglue package: per-layer maps, keypoint repeatability, descriptor cosine, LightGlue match IoU on reference features. Fixtures: scripts/models/aliked-lightglue.py fixtures --layers --max-kp 1024 2048",
		timeoutS: 300,
	},
	{
		id: "imhof",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/__tests__/imhof.check.ts"),
		timeoutS: 120,
	},
	{
		id: "palette-cvd",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/roll/mosaic/__tests__/palette-cvd.check.ts"),
		timeoutS: 60,
	},
	{
		id: "haze-scan-sg",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/haze-scan-sg-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "skyline-stages",
		tier: "fast",
		group: "pose",
		cmd: tsx("src/lib/gpu/skyline/skyline.check.ts"),
		timeoutS: 120,
	},
	{
		id: "render-lock-signals",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/with-render-lock.check.ts"),
		timeoutS: 120,
	},
	{
		id: "export-geoid-default",
		tier: "fast",
		group: "export",
		cmd: tsx("src/lib/export/geoid-default.check.ts"),
		timeoutS: 60,
	},
	{
		id: "stage1-worker-snapshot",
		tier: "fast",
		group: "matcher",
		cmd: tsx("tools/matcher/stage1/__tests__/worker-snapshot.check.ts"),
		timeoutS: 60,
	},
	{
		id: "t6-gpu-grid-default",
		tier: "fast",
		group: "matcher",
		cmd: tsx("tools/matcher/stage1/__tests__/t6-gpu-grid-default.check.ts"),
		timeoutS: 60,
	},
	{
		id: "render-bundle-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/render-bundle-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "mosaic-mips",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/horizon/mosaic-mips.check.ts"),
		timeoutS: 60,
	},
	{
		id: "color-target-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/color-target-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "sky-graph-idle",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/sky/graph-idle.check.ts"),
		timeoutS: 60,
	},
	{
		id: "realm-flags",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/gpu/core/realm-flags.check.ts"),
		timeoutS: 60,
	},
	{
		id: "imagery-release",
		tier: "fast",
		group: "gpu",
		cmd: tsx("src/lib/deck-webgpu/imagery-release.check.ts"),
		timeoutS: 60,
	},
	{
		id: "height-atlas-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/height-atlas-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "terrain-cull-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/terrain-cull-dawn.ts"),
		timeoutS: 180,
	},
	{
		id: "haze-argmin-dawn",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/haze-argmin-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "haze-band-dawn",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/haze-band-dawn.ts"),
		timeoutS: 180,
	},
	{
		id: "haze-lists-dawn",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/haze-lists-dawn.ts", "2", "3"),
		timeoutS: 240,
	},
	{
		id: "stats-fold-dawn",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/stats-fold-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "terrarium-stats-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/terrarium-stats-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "sky-refine-conv-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/sky-refine-conv-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "skyglobal-compaction-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/skyglobal-compaction-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "skyglobal-rescore-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/skyglobal-rescore-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "skyline-conv-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/skyline-conv-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "skyline-raster-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/skyline-raster-dawn.ts"),
		timeoutS: 180,
	},
	{
		id: "refine-fft-dawn",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/gpu/refine-fft-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "fft1d-lengths-dawn",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/gpu/fft1d-lengths-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "photo-look-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/photo-look-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "roll-coverage-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/roll-coverage-dawn.ts"),
		timeoutS: 120,
	},
	{
		// vite-node, not tsx: roll.ts imports the virtual:photos module
		id: "roll-spatial-dawn",
		tier: "fast",
		group: "gpu",
		cmd: [
			"npx",
			"vite-node",
			"-c",
			"vitest.config.ts",
			"scripts/gpu/roll-spatial-dawn.ts",
		],
		timeoutS: 180,
	},
	{
		id: "guided-filter-conv-dawn",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/gpu/guided-filter-conv-dawn.ts"),
		timeoutS: 120,
	},
	{
		id: "color-stats-dawn",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/color-stats-dawn.ts", "3"),
		note: "band stats on Dawn at 512x384 / 1600x1200 / 3000x2000: BAND_STATS + GPUGroupAggregation fold vs the CPU twin (counts within 1e-4, |d| <= 1e-4), median wall times; SKIP without DAWN_DIR",
		timeoutS: 300,
	},
	{
		id: "relief-gradient-dawn",
		tier: "fast",
		group: "look",
		cmd: tsx("scripts/gpu/relief-gradient-dawn.ts", "3"),
		note: "GPU relief field on Dawn at res 512 / 1024 / 2048 vs the CPU twin (byte-diff histogram per channel; <= 0.5 % of texels off by > 2, identical coverage), the normal's GPUFiniteDifference2D gradient on phase planes, median wall times, and the texture path's bytes equal the read path's; SKIP without DAWN_DIR",
		timeoutS: 300,
	},
	{
		id: "photoprep-hist-dawn",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/gpu/photoprep-hist-dawn.ts", "3"),
		note: "the GPU photo prep's edge graph on Dawn at 512x384 / 1024x768 / 2048x1536: radix-select digit histograms (luma GPUHistogram) and sky colour counts (GPUGroupAggregation count) leave the planes Object.is-equal to emulate.ts; median wall times; SKIP without DAWN_DIR",
		timeoutS: 300,
	},
	{
		id: "ransac-dawn",
		tier: "fast",
		group: "pose",
		cmd: tsx("scripts/gpu/ransac-dawn.ts"),
		note: "GPU RANSAC scoring (src/lib/gpu/ransac: K hypotheses x N correspondences, arg-max on the GPU, winner read back) on Dawn vs the f64 CPU twin for the chord / angular / reproj modes incl. a 2-D grid past 65535 hypotheses, and the async solvers vs the sync ones; SKIP without DAWN_DIR",
		timeoutS: 180,
	},
	{
		id: "nn-parity",
		tier: "fast",
		group: "gpu",
		cmd: tsx("scripts/nn/parity.check.ts"),
		note: "src/lib/nn GPU backend (WGSL kernels on one ComputeGraph per forward) vs the CPU reference on seeded random tensors over Dawn: every op family incl. implicit-GEMM conv / convT / deformable conv, flash attention, topk, a transformer block in one forward, f16 weights; max rel error <= 1e-4; SKIP without DAWN_DIR",
		timeoutS: 300,
	},
];
