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
		id: "labels",
		tier: "fast",
		group: "look",
		cmd: tsx("src/lib/look/__tests__/labels.check.ts"),
		timeoutS: 300,
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
		id: "export",
		tier: "fast",
		group: "export",
		cmd: tsx("scripts/test-export.ts"),
		needs: ["public/photos/photos.json"],
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
		id: "geocam-lakes-factors",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/lakes/lakes-factors.check.ts"),
		timeoutS: 300,
	},
	{
		id: "geocam-tjunc",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/tjunc/tjunc.check.ts"),
		timeoutS: 300,
	},
	{
		id: "geocam-integrity",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/integrity/integrity.check.ts"),
		timeoutS: 300,
	},
	{
		id: "geocam-observe",
		tier: "fast",
		group: "geocam",
		cmd: tsx("src/lib/geocam/observe/observe.check.ts"),
		timeoutS: 300,
	},

	// ---- full: browser, one at a time under the render lock -------------------------------------
	{
		id: "style-baseline",
		tier: "full",
		group: "parity",
		browser: true,
		// No ?style / ?concord / ?renderer flag on the captured URLs, so this row is also the
		// concord-off (and look-off) parity gate: classic must stay pixel-identical with flags off.
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
		note: "classic pixel identity + geometry hash; = concord-off parity (no flag set)",
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
		]),
		needs: ["public/photos/photos.json"],
		note: "three vs ?renderer=deck: |Δyaw| ≤ 0.5°, label overlap ≥ 0.6",
		timeoutS: 3600,
	},
	{
		id: "eval-app",
		tier: "full",
		group: "accuracy",
		browser: true,
		cmd: lock(["node", "scripts/eval-app.mjs"]),
		// one retry on a crash: the first run on 2026-09-29 died in playwright's launch
		// ("SyntaxError: Unexpected end of JSON input" in coreBundle.js) and passed on re-run
		retries: 1,
		env: { APP_URL: "{url}" },
		needs: ["data/control-points.json", "public/photos/photos.json"],
		note: "gate: 'N/M within 1° yaw' ≥ known-failures.json evalApp.minWithin1deg",
		timeoutS: 3600,
		gate(out, ctx) {
			const m =
				/(\d+)\/(\d+) within 1° yaw; median auto px error ([\d.∞]+)/.exec(out);
			if (!m) return "no summary line in the output";
			const [ok, of, med] = [Number(m[1]), Number(m[2]), m[3]];
			ctx.metrics = { within1deg: ok, of, medianAutoPx: med };
			const min = ctx.baseline?.evalApp?.minWithin1deg;
			if (min == null) return null; // no baseline yet (first run / --update-baseline records it)
			return ok < min ? `${ok}/${of} within 1° < baseline ${min}` : null;
		},
	},
];
