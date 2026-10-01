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
// change of the app's default renderer never silently changes what a gate measures. The three.js renderer
// was removed (2026-10-01): its rows were retargeted to deck (style-baseline, deck-smoke's reference arm)
// or to the WebGPU default (eval-app).

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
		id: "atlas",
		tier: "fast",
		group: "static",
		cmd: tsx("src/lib/atlas/atlas.check.ts"),
		note: "Atlas graph integrity + ontology link (ids, uniqueness, taxonomy agreement, import boundary)",
		timeoutS: 60,
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
		id: "labels",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/__tests__/labels.check.ts"),
		timeoutS: 300,
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
		note: "SPZ v2/v3/v4 + KSPLAT 0/1 through @loaders.gl/splats (hand-built fixtures)",
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
		id: "nearfield-generate",
		tier: "fast",
		group: "nearfield",
		cmd: tsx("src/lib/nearfield/generate/generate.check.ts"),
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
		id: "cog-reader",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/concord/occl/cog-reader.check.ts"),
		note: "loaders.gl vs own COG reader on real swisstopo COGs; bytes cached in .cache/swiss-cog by a networked run",
		// SKIPs until one run with network filled the range cache (then offline)
		needs: [".cache/swiss-cog", "public/photos/photos.json"],
		timeoutS: 600,
	},
	{
		id: "cache-range",
		tier: "fast",
		group: "concord",
		cmd: tsx("src/lib/cache/range.check.ts"),
		note: "tile cache byte ranges (key = url + range), mocked server",
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

	// ---- full: browser, one at a time under the render lock -------------------------------------
	{
		id: "style-baseline",
		tier: "full",
		group: "parity",
		browser: true,
		// The script pins ?renderer=deck (WebGL on SwiftShader; it reads deck's geometry source) and sets no
		// ?style / ?concord flag, so this row is also the concord-off (and look-off) parity gate: classic
		// must stay pixel-identical with flags off. Its reference moved to out/lead/style-baseline-deck and
		// must be captured once on deck (`node scripts/gpu/with-render-lock.mjs -- node
		// scripts/style-baseline.mjs capture`); until then `needs` is missing and the row SKIPs.
		cmd: lock([
			"node",
			"scripts/style-baseline.mjs",
			"check",
			"--url",
			"{url}",
		]),
		needs: [
			"out/lead/style-baseline-deck/baseline.json",
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
		note: "webgpu-pinned (the app default; was three-pinned until 2026-10-01); gate: 'N/M within 1° yaw' ≥ known-failures.json evalAppWebgpu.minWithin1deg",
		timeoutS: 3600,
		// advisory until a webgpu run records evalAppWebgpu (run.mjs --update-baseline); the old evalApp
		// minimum was a three.js number and was dropped with that renderer
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
		note: "deck-pinned (deck is the default renderer); gate: 'N/M within 1° yaw' ≥ known-failures.json evalAppDeck.minWithin1deg",
		timeoutS: 3600,
		// in the full tier since the default renderer flipped to deck. Were evalAppDeck removed from the
		// baseline, a failure of any kind (gate, exit code, timeout) would report KNOWN, not FAIL
		advisoryUntil: "evalAppDeck",
		gate: evalAppGate("deck", "evalAppDeck"),
	},
];
