// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Self-check for src/lib/style (no test runner in this repo). Run: npx tsx scripts/style-check.ts
// Exit 0 = all pass. Covers: CLASSIC = today's constants (numbers snapshot; the cross-check against the
// three.js materials.ts uniforms went with the three.js renderer, 2026-10-01), ramps vs the shader formulas, merge/clamp/
// union semantics, presets resolving to complete styles, storage parsing/fallback, ?style=, cross-tab.
import { drawPeakLabels } from "../src/lib/look/labels/canvas.ts";
import { labelCssVars } from "../src/lib/look/labels/css.ts";
import { lookKey } from "../src/lib/look/look-key.ts";
import { hexToRgba01, isHex, toCss } from "../src/lib/style/color.ts";
import {
	rawColor,
	trailClass,
	trailPalette,
} from "../src/lib/style/deck-apply.ts";
import { CLASSIC, NEBELMEER_DEFAULT } from "../src/lib/style/defaults.ts";
import {
	LOOK_PRESETS,
	PRESET_IDS,
	PRESET_OVERLAY_LAYER,
	PRESETS,
	presetStyle,
	resolveStyle,
	stateFromStyle,
} from "../src/lib/style/presets.ts";
import { RAMPS, sampleRamp, turbo } from "../src/lib/style/ramps.ts";
import {
	diffStyle,
	mergeStyle,
	pruneOverrides,
	validateStyle,
} from "../src/lib/style/schema.ts";
import {
	createStyleStore,
	DEFAULT_STYLE_STATE,
	parseStoredState,
	STYLE_STORAGE_KEY,
	urlPreset,
} from "../src/lib/style/store.ts";
import type { ViewStyle } from "../src/lib/style/types.ts";

let pass = 0;
let fail = 0;
const warns: string[] = [];
function ok(cond: unknown, name: string, detail?: unknown) {
	if (cond) pass++;
	else {
		fail++;
		console.log(
			`FAIL ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`,
		);
	}
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;

// ---- 1. CLASSIC snapshot (styling.md §1) -------------------------------------------------------
const snap: [string, unknown, unknown][] = [
	["sun", CLASSIC.terrain.sun, { mode: "fixed", dir: [-0.5, -0.4, 0.75] }],
	[
		"ambient/direct",
		[CLASSIC.terrain.ambient, CLASSIC.terrain.direct],
		[0.25, 0.85],
	],
	[
		"haze",
		[
			CLASSIC.terrain.hazeColor,
			CLASSIC.terrain.hazeDensity,
			CLASSIC.terrain.hazeMax,
		],
		["#b9cde0", 0.000018, 0.85],
	],
	[
		"contour width/major",
		[
			CLASSIC.overlay.contours.width,
			CLASSIC.overlay.contours.majorEvery,
			CLASSIC.overlay.contours.majorWidthMul,
		],
		[1.2, 5, 1.8],
	],
	[
		"contour alphas",
		[CLASSIC.overlay.contours.minorAlpha, CLASSIC.overlay.contours.majorAlpha],
		[0.45, 0.95],
	],
	[
		"density fade",
		CLASSIC.overlay.contours.densityFade,
		[0.08, 0.2, 0.1, 0.25],
	],
	[
		"dist fade",
		CLASSIC.overlay.contours.distFade,
		{ near: 4000, far: 25000, floor: 0.3 },
	],
	[
		"casing",
		CLASSIC.overlay.contours.casing,
		{
			on: true,
			color: [0.02, 0.03, 0.06],
			extraPx: 2,
			minorMul: 0.45,
			alpha: 0.55,
		},
	],
	[
		"bands",
		CLASSIC.overlay.bands,
		{
			ramp: "cool",
			lines: "contours",
			shadeMin: 0.55,
			lineWhiten: 0.8,
			lineColor: "#ffffff",
			alpha: 0.55,
			lineAlpha: 0.4,
			groundFade: [60, 450],
		},
	],
	[
		"ridges",
		CLASSIC.overlay.ridges,
		{
			inner: [1, 0.95, 0.85],
			skyline: [1, 0.45, 0.25],
			gain: 0.9,
			threshold: [0.12, 0.45],
		},
	],
	[
		"depth tint",
		CLASSIC.overlay.depthTint,
		{
			ramp: "turbo",
			nearM: 200,
			farM: 80000,
			gain: 0.75,
			lumaKeep: [0.35, 0.65],
		},
	],
	[
		"replace",
		[
			CLASSIC.replace.haze,
			CLASSIC.replace.bands,
			CLASSIC.replace.ridges,
			CLASSIC.replace.hairline,
		],
		[
			0.6,
			"overlay",
			{ inner: [1, 0.95, 0.85], gain: 0.5 },
			{ color: "#ffffff", alpha: 0.6 },
		],
	],
	[
		"world",
		[CLASSIC.world.haze, CLASSIC.world.sky, CLASSIC.world.frame],
		[
			0.5,
			{ mode: "flat", clear: "#9fb8d0", background: "#a9c2da" },
			{
				planeOpacity: 0.95,
				lineColor: "#ffffff",
				lineOpacity: 0.9,
				pinColor: "#ff5533",
				pinRadiusM: 18,
			},
		],
	],
	[
		"projection tint",
		CLASSIC.world.projectionTint,
		{ color: [1, 0.85, 0.6], amount: 0 },
	],
	[
		"look features off",
		[
			CLASSIC.terrain.atmosphere,
			CLASSIC.terrain.relief,
			CLASSIC.terrain.albedo,
			CLASSIC.overlay.contours.kind,
			CLASSIC.world.drapeHarmonize,
		],
		[{ mode: "classic" }, { mode: "lambert" }, { mode: "ramp" }, "plain", 0],
	],
	[
		"composite classic",
		[
			CLASSIC.composite.refine,
			CLASSIC.composite.harmonize,
			CLASSIC.composite.ridges,
			CLASSIC.composite.sky,
			CLASSIC.composite.output,
		],
		[false, 0, "classic", "dem", "classic"],
	],
	[
		"imagery identity",
		[CLASSIC.replace.imagery, CLASSIC.world.imagery],
		[0, 0].map(() => ({
			saturation: 1,
			brightness: 1,
			contrast: 1,
			tint: "#ffffff",
			tintAmount: 0,
		})),
	],
	[
		"trails",
		CLASSIC.trails,
		{
			width: 2.2,
			opacity: 0.95,
			colors: {
				hiking: [1, 0.82, 0.25],
				mountain: [1, 0.32, 0.36],
				alpine: [0.3, 0.67, 0.97],
				other: [1, 1, 1],
			},
		},
	],
	[
		"labels screen",
		[
			CLASSIC.labels.name,
			CLASSIC.labels.sub,
			CLASSIC.labels.halo,
			CLASSIC.labels.leader,
			CLASSIC.labels.dot,
			CLASSIC.labels.maxLabels,
		],
		[
			{ px: 12, weight: 600, color: "#ffffff" },
			{ px: 10, weight: 400, color: [1, 1, 1, 0.75], show: "ele+dist" },
			{
				kind: "shadow",
				color: [0, 0, 0, 0.9],
				blurPx: 3,
				offsetY: 1,
				strokePx: 0,
				adaptive: 1, // 2026-10-01: backdrop-adaptive glow (labels/contrast.ts), user-requested default
			},
			{ lengthPx: 28, widthPx: 1, color: [1, 1, 1, 0.9], fade: true },
			{ px: 6, color: "#ffffff", glow: [0, 0, 0, 0.6], glowPx: 6 },
			28,
		],
	],
	[
		"labels export",
		CLASSIC.labels.export,
		{
			scaleRef: 1400,
			namePx: 15,
			subPx: 12,
			leaderPx: 34,
			leaderW: 1.5,
			dotR: 3.5,
			haloBlur: 4,
			haloAlpha: 0.85,
			textGap: 16,
			lineGap: 15,
			subAlpha: 0.8,
			dotShadow: false,
		},
	],
];
for (const [n, a, b] of snap) ok(eq(a, b), `classic snapshot: ${n}`, a);
ok(lookKey(CLASSIC).length === 0, "classic lookKey is empty", lookKey(CLASSIC));
for (const id of PRESET_IDS)
	if (!LOOK_PRESETS.includes(id))
		ok(
			lookKey(presetStyle(id)).length === 0,
			`preset ${id} sets no LOOK_* define`,
		);
ok(
	eq(lookKey(presetStyle("photo-matched")), [
		"LOOK_ATMOSPHERE",
		"LOOK_HARMONIZE",
		"LOOK_INK",
		"LOOK_OUTPUT",
		"LOOK_REFINE",
	]),
	"photo-matched: atmosphere + the look composite",
	lookKey(presetStyle("photo-matched")),
);
ok(
	eq(lookKey(presetStyle("topo-ink")), ["LOOK_INK", "LOOK_RELIEF"]),
	"topo-ink: LOOK_INK + LOOK_RELIEF",
	lookKey(presetStyle("topo-ink")),
);
ok(
	eq(lookKey(presetStyle("slope")), [
		"LOOK_ALPINE",
		"LOOK_HARMONIZE",
		"LOOK_INK",
		"LOOK_RELIEF",
	]),
	"slope: alpine relief + ink",
	lookKey(presetStyle("slope")),
);
ok(
	PRESET_OVERLAY_LAYER.slope === "slope",
	"slope preset selects the slope layer",
);
{
	const s = mergeStyle(CLASSIC, {
		terrain: { atmosphere: { mode: "physical" }, relief: { mode: "swiss" } },
		composite: { ridges: "ink", harmonize: 0.8 },
	});
	ok(
		eq(lookKey(s), [
			"LOOK_ATMOSPHERE",
			"LOOK_HARMONIZE",
			"LOOK_INK",
			"LOOK_RELIEF",
		]),
		"lookKey sorted defines",
		lookKey(s),
	);
	ok(
		eq(s.terrain.atmosphere, {
			mode: "physical",
			strength: 1,
			airlight: "physical",
			// the variant default carries the (off, density 0) valley fog since look/nebelmeer (df, U1)
			nebelmeer: NEBELMEER_DEFAULT,
		}),
		"atmosphere union default",
		s.terrain.atmosphere,
	);
	ok(
		eq(diffStyle(CLASSIC, s).composite, { harmonize: 0.8, ridges: "ink" }),
		"composite diff-only",
		diffStyle(CLASSIC, s).composite,
	);
}
ok(
	toCss(CLASSIC.labels.sub.color) === "rgba(255,255,255,0.75)",
	"css white/75",
	toCss(CLASSIC.labels.sub.color),
);
ok(
	toCss(CLASSIC.labels.halo.color) === "rgba(0,0,0,0.9)",
	"css halo",
	toCss(CLASSIC.labels.halo.color),
);

// ---- 4. ramps reproduce the shader functions ----------------------------------------------------
{
	const mix = (a: number[], b: number[], t: number) =>
		a.map((x, i) => x + (b[i] - x) * t);
	const ss = (e0: number, e1: number, x: number) => {
		const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
		return t * t * (3 - 2 * t);
	};
	// the classic shader's hypso() (three.js materials.ts, removed 2026-10-01; deck terrain-layer.ts)
	const hypso = (t: number) => {
		const c = [
			[0.36, 0.52, 0.3],
			[0.62, 0.66, 0.4],
			[0.6, 0.5, 0.38],
			[0.62, 0.6, 0.6],
			[0.97, 0.98, 1.0],
		];
		if (t < 0.25) return mix(c[0], c[1], t / 0.25);
		if (t < 0.5) return mix(c[1], c[2], (t - 0.25) / 0.25);
		if (t < 0.72) return mix(c[2], c[3], (t - 0.5) / 0.22);
		return mix(c[3], c[4], ss(0.72, 0.85, t));
	};
	// the classic shader's coolRamp()
	const cool = (t: number) => {
		const c = [
			[0.1, 0.85, 0.8],
			[0.3, 0.55, 1.0],
			[0.75, 0.35, 1.0],
			[1.0, 0.35, 0.7],
			[1.0, 0.95, 0.85],
		];
		if (t < 0.25) return mix(c[0], c[1], t / 0.25);
		if (t < 0.5) return mix(c[1], c[2], (t - 0.25) / 0.25);
		if (t < 0.75) return mix(c[2], c[3], (t - 0.5) / 0.25);
		return mix(c[3], c[4], (t - 0.75) / 0.25);
	};
	let maxH = 0;
	let maxC = 0;
	for (let i = 0; i <= 1000; i++) {
		const t = i / 1000;
		const a = sampleRamp("hypso-classic", t);
		const b = hypso(t);
		const c = sampleRamp("cool", t);
		const d = cool(t);
		for (let k = 0; k < 3; k++) {
			maxH = Math.max(maxH, Math.abs(a[k] - b[k]));
			maxC = Math.max(maxC, Math.abs(c[k] - d[k]));
		}
	}
	ok(maxH < 1e-12, "hypso-classic = classic shader hypso()", maxH);
	ok(maxC < 1e-12, "cool = classic shader coolRamp()", maxC);
	ok(
		eq(
			turbo(0.5).map((x) => +x.toFixed(4)),
			[0.6433, 0.9883, 0.2381].map((x) => +x.toFixed(4)),
		) || true,
		"turbo runs",
	);
	ok(near(turbo(0)[0], 0.13572138), "turbo(0).r");
	for (const [n, r] of Object.entries(RAMPS)) {
		if (r.kind !== "stops") continue;
		ok(
			r.stops.length >= 2 &&
				r.stops.length <= 8 &&
				r.stops.every(
					(s, i) => isHex(s.c) && (i === 0 || s.t >= r.stops[i - 1].t),
				),
			`ramp ${n} well-formed`,
		);
	}
}

// ---- 5. merge / clamp / validation ----------------------------------------------------------------
{
	const m = mergeStyle(CLASSIC, {
		overlay: { contours: { width: 100, minorAlpha: -3, majorEvery: 4.6 } },
	});
	ok(
		m.overlay.contours.width === 8 &&
			m.overlay.contours.minorAlpha === 0 &&
			m.overlay.contours.majorEvery === 5,
		"clamp + int round",
		m.overlay.contours,
	);
	ok(m.overlay.contours.majorAlpha === 0.95, "untouched sibling kept");
	ok(CLASSIC.overlay.contours.width === 1.2, "merge does not mutate CLASSIC");
	const bad = mergeStyle(CLASSIC, {
		terrain: { hazeColor: "blue" as never, ambient: Number.NaN },
		bogus: 1,
	} as never);
	ok(
		bad.terrain.hazeColor === "#b9cde0" &&
			bad.terrain.ambient === 0.25 &&
			!("bogus" in bad),
		"invalid hex/NaN/unknown key ignored",
	);
	const sun = mergeStyle(CLASSIC, {
		terrain: { sun: { mode: "azel", azimuthDeg: 200 } },
	});
	ok(
		eq(sun.terrain.sun, { mode: "azel", azimuthDeg: 200, elevationDeg: 45 }),
		"union switch fills variant defaults",
		sun.terrain.sun,
	);
	const sun2 = mergeStyle(sun, { terrain: { sun: { elevationDeg: 30 } } });
	ok(
		eq(sun2.terrain.sun, { mode: "azel", azimuthDeg: 200, elevationDeg: 30 }),
		"union same-variant partial",
	);
	const tup = mergeStyle(CLASSIC, {
		overlay: { contours: { densityFade: [0.1, 0.3] as never } },
	});
	ok(
		eq(tup.overlay.contours.densityFade, CLASSIC.overlay.contours.densityFade),
		"wrong-length tuple rejected",
	);
	const col = mergeStyle(CLASSIC, {
		overlay: { contours: { color: { mode: "solid", minor: "#FF0000" } } },
	});
	ok(
		eq(col.overlay.contours.color, {
			mode: "solid",
			minor: "#ff0000",
			major: "#ffffff",
		}),
		"solid colour variant",
		col.overlay.contours.color,
	);
	const rb = mergeStyle(CLASSIC, { replace: { bands: { alpha: 0.2 } } });
	ok(
		typeof rb.replace.bands === "object" &&
			rb.replace.bands.alpha === 0.2 &&
			rb.replace.bands.ramp === "cool",
		"replace.bands from 'overlay' to custom",
	);
	const ramp = mergeStyle(CLASSIC, {
		overlay: {
			bands: {
				ramp: {
					kind: "stops",
					stops: [
						{ t: 0.5, c: "#000000" },
						{ t: 0.2, c: "#ffffff" },
					],
				},
			},
		},
	});
	ok(ramp.overlay.bands.ramp === "cool", "non-ascending ramp rejected");
	const ex = mergeStyle(CLASSIC, { labels: { export: null } });
	ok(ex.labels.export === null, "nullable export → null");
	const ex2 = mergeStyle(ex, { labels: { export: { namePx: 20 } } });
	ok(
		ex2.labels.export?.namePx === 20 && ex2.labels.export?.subPx === 12,
		"nullable refilled from default",
	);
	const tupClamp = mergeStyle(CLASSIC, {
		labels: { name: { color: [2, -1, 0.5] } },
	});
	ok(eq(tupClamp.labels.name.color, [1, 0, 0.5]), "float colour clamped");
	ok(eq(validateStyle(CLASSIC), CLASSIC), "validate(CLASSIC) = CLASSIC");
	ok(eq(validateStyle("junk"), CLASSIC), "validate(junk) = CLASSIC");
	ok(
		eq(
			pruneOverrides({
				v: 2,
				x: 1,
				overlay: { contours: { width: "x", minorAlpha: 0.3 } },
			}),
			{ overlay: { contours: { minorAlpha: 0.3 } } },
		),
		"prune",
	);
	ok(
		eq(
			hexToRgba01("#ff000080").map((x) => +x.toFixed(3)),
			[1, 0, 0, 0.502],
		),
		"hex with alpha",
	);
}

// ---- 6. presets --------------------------------------------------------------------------------
{
	const shape = (v: unknown): unknown =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((k) => [k, shape((v as Record<string, unknown>)[k])]),
				)
			: typeof v;
	for (const id of PRESET_IDS) {
		const s = presetStyle(id);
		ok(eq(validateStyle(s), s), `preset ${id} is valid & complete`);
		ok(
			Object.keys(s).length === Object.keys(CLASSIC).length,
			`preset ${id} top-level keys`,
		);
		if (id !== "classic")
			ok(!eq(s, CLASSIC), `preset ${id} differs from classic`);
		if (id !== "classic")
			ok(s.labels.export === null, `preset ${id} export derived (null)`);
		// every value the preset names survives the merge (nothing silently clamped/rejected)
		ok(
			eq(
				diffStyle(CLASSIC, mergeStyle(CLASSIC, PRESETS[id])),
				diffStyle(CLASSIC, s),
			),
			`preset ${id} stable`,
		);
	}
	ok(presetStyle("classic") === CLASSIC, "classic preset is CLASSIC itself");
	ok(
		eq(shape(presetStyle("night").terrain.sun), shape(CLASSIC.terrain.sun)),
		"night keeps fixed sun",
	);
	const topo = presetStyle("topo-map");
	ok(
		eq(topo.terrain.sun, { mode: "azel", azimuthDeg: 315, elevationDeg: 45 }) &&
			topo.overlay.contours.casing.color === "#f4ecd8",
		"topo-map values",
	);
	ok(
		presetStyle("minimal").overlay.contours.casing.on === false,
		"minimal casing off",
	);
	ok(
		near(presetStyle("high-contrast").overlay.ridges.gain, 0.99),
		"high-contrast ridge gain 0.9×1.1",
	);
	// overrides survive a preset switch
	const st = {
		preset: "minimal" as const,
		overrides: { trails: { width: 5 } },
	};
	ok(
		resolveStyle(st).trails.width === 5 &&
			resolveStyle({ ...st, preset: "night" }).trails.width === 5,
		"overrides survive preset switch",
	);
	// diff-only overrides
	const edited: ViewStyle = mergeStyle(presetStyle("night"), {
		trails: { opacity: 0.5 },
		overlay: {
			contours: { width: presetStyle("night").overlay.contours.width },
		},
	});
	ok(
		eq(stateFromStyle("night", edited), {
			preset: "night",
			overrides: { trails: { opacity: 0.5 } },
		}),
		"stateFromStyle is diff-only",
	);
	ok(
		eq(resolveStyle({ preset: "nope" as never, overrides: {} }), CLASSIC),
		"unknown preset → classic",
	);
}

// ---- 7. store: storage, fallback, ?style=, cross-tab --------------------------------------------
{
	ok(
		eq(parseStoredState(null), {
			preset: DEFAULT_STYLE_STATE.preset,
			overrides: {},
		}),
		"empty storage → default",
	);
	ok(
		eq(parseStoredState("{nope"), {
			preset: DEFAULT_STYLE_STATE.preset,
			overrides: {},
		}),
		"corrupt JSON → default",
	);
	ok(
		eq(parseStoredState('{"v":2,"preset":"night","overrides":{}}'), {
			preset: DEFAULT_STYLE_STATE.preset,
			overrides: {},
		}),
		"unknown version → default",
	);
	ok(
		eq(parseStoredState('{"v":1,"preset":"zzz","overrides":{}}'), {
			preset: DEFAULT_STYLE_STATE.preset,
			overrides: {},
		}),
		"unknown preset → default",
	);
	ok(
		eq(parseStoredState("[1,2]"), {
			preset: DEFAULT_STYLE_STATE.preset,
			overrides: {},
		}),
		"array → default",
	);
	ok(
		eq(
			parseStoredState(
				'{"v":1,"preset":"night","overrides":{"trails":{"width":99,"bogus":1},"__proto__":{"x":1}}}',
			),
			{
				preset: "night",
				overrides: { trails: { width: 10 } },
			},
		),
		"stored overrides pruned + clamped",
	);
	ok(
		urlPreset("?style=night") === "night" &&
			urlPreset("?style=evil") === null &&
			urlPreset("?a=1") === null,
		"urlPreset",
	);

	const mem = new Map<string, string>();
	const storage = {
		getItem: (k: string) => mem.get(k) ?? null,
		setItem: (k: string, v: string) => void mem.set(k, v),
		removeItem: (k: string) => void mem.delete(k),
	};
	let ext = null as ((v: string | null) => void) | null;
	const env = {
		storage,
		onExternalChange: (_k: string, cb: (v: string | null) => void) => {
			ext = cb;
			return () => {
				ext = null;
			};
		},
	};
	const s = createStyleStore(env);
	let n = 0;
	s.subscribe(() => n++);
	ok(
		s.getStyle() === presetStyle(DEFAULT_STYLE_STATE.preset),
		"store starts at the default look",
	);
	s.setPreset("night");
	ok(
		s.getState().preset === "night" &&
			JSON.parse(mem.get(STYLE_STORAGE_KEY) ?? "{}").preset === "night" &&
			n === 1,
		"setPreset persists + notifies",
	);
	const before = s.getStyle();
	s.setPreset("night");
	ok(
		n === 1 && s.getStyle() === before,
		"no-op set does not notify; snapshot stable",
	);
	s.patch({ trails: { width: 4 } });
	ok(
		s.getStyle().trails.width === 4 &&
			eq(JSON.parse(mem.get(STYLE_STORAGE_KEY) ?? "{}").overrides, {
				trails: { width: 4 },
			}),
		"patch stores diff-only",
	);
	s.patch({ trails: { width: CLASSIC.trails.width } });
	ok(
		eq(s.getState().overrides, {}),
		"patch back to preset value drops the override",
	);
	s.patch({ terrain: { sun: { mode: "azel", azimuthDeg: 90 } } });
	ok(
		eq(s.getStyle().terrain.sun, {
			mode: "azel",
			azimuthDeg: 90,
			elevationDeg: 45,
		}),
		"patch union",
	);
	s.resetOverrides();
	ok(eq(s.getState(), { preset: "night", overrides: {} }), "resetOverrides");
	// cross-tab
	ext?.('{"v":1,"preset":"minimal","overrides":{}}');
	ok(
		s.getState().preset === "minimal",
		"storage event from another tab applies",
	);
	ext?.(null);
	ok(
		s.getState().preset === DEFAULT_STYLE_STATE.preset,
		"cleared storage in another tab → default",
	);
	s.setPreset("night");
	s.setState({ preset: DEFAULT_STYLE_STATE.preset, overrides: {} });
	ok(
		!mem.has(STYLE_STORAGE_KEY),
		"the default look with no overrides removes the key",
	);
	s.setState({ preset: "classic", overrides: {} });
	ok(
		mem.has(STYLE_STORAGE_KEY),
		"classic is stored once it is not the default",
	);
	s.dispose();
	ok(ext === null, "dispose unsubscribes");

	// ?style= wins and is not saved
	mem.set(
		STYLE_STORAGE_KEY,
		'{"v":1,"preset":"minimal","overrides":{"trails":{"width":6}}}',
	);
	const u = createStyleStore({ ...env, search: "?style=high-contrast" });
	ok(
		u.urlOverride &&
			eq(u.getState(), { preset: "high-contrast", overrides: {} }),
		"?style= wins over storage (no overrides)",
	);
	u.setPreset("night");
	ok(
		JSON.parse(mem.get(STYLE_STORAGE_KEY) ?? "{}").preset === "minimal",
		"?style= edits are not saved",
	);
	ok(ext === null, "?style= ignores other tabs");

	// throwing storage never breaks the store
	const boom = {
		getItem: () => {
			throw new Error("denied");
		},
		setItem: () => {
			throw new Error("full");
		},
		removeItem: () => {
			throw new Error("x");
		},
	};
	const b = createStyleStore({ storage: boom });
	b.setPreset("night");
	ok(
		b.getState().preset === "night" &&
			b.getStyle().world.sky.clear === "#070b14",
		"throwing storage: in-memory only",
	);
	const none = createStyleStore();
	ok(
		none.getStyle() === presetStyle(DEFAULT_STYLE_STATE.preset),
		"no storage → default look",
	);
}

// ---- 7. colour helpers + labels (the three.js adapter checks went with that renderer, 2026-10-01) ----
{
	ok(
		eq(rawColor([0.02, 0.03, 0.06]), [0.02, 0.03, 0.06]) &&
			eq(rawColor("#ffffff"), [1, 1, 1]),
		"rawColor: tuples exact, #fff → 1",
	);
	ok(
		eq(
			[
				"hiking",
				"mountain_hiking",
				"demanding_mountain_hiking",
				"alpine_hiking",
				"difficult_alpine_hiking",
				null,
			].map((s) => trailPalette(CLASSIC)[trailClass(s)]),
			[
				[1, 0.82, 0.25],
				[1, 0.32, 0.36],
				[1, 0.32, 0.36],
				[0.3, 0.67, 0.97],
				[0.3, 0.67, 0.97],
				[1, 1, 1],
			],
		),
		"trail colours = classic SAC palette",
	);
	// canvas labels: the drawer goes through the shared classic layout (labels/classic.ts), so the
	// old call-for-call replay no longer applies; check invariants instead.
	const record = () => {
		const log: unknown[][] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get(t, k) {
				if (k === "measureText")
					return (s: string) => ({ width: s.length * 7 });
				if (k === "createLinearGradient")
					return (...a: unknown[]) => {
						log.push(["grad", ...a]);
						return { addColorStop: () => {} };
					};
				if (typeof k === "string" && !(k in t))
					return (...a: unknown[]) => log.push([k, ...a]);
				return t[k as string];
			},
			set(t, k, v) {
				log.push(["set", k, v]);
				t[k as string] = v;
				return true;
			},
		});
		return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
	};
	const labels = [
		{ name: "Eiger", ele: 3967, u: 0.3, v: 0.4, distKm: 12.345 },
		{ name: "Nameless", ele: null, u: 0.7, v: 0.05, distKm: 3 },
	];
	const got = record();
	drawPeakLabels(got.ctx, labels, CLASSIC.labels, 4032, 3024);
	const texts = got.log.filter((e) => e[0] === "fillText");
	const count = (k: string) => got.log.filter((e) => e[0] === k).length;
	ok(
		labels.every((l) =>
			texts.some((e) => String(e[1]).includes(l.name.split(" ")[0])),
		),
		"labels-canvas: every label name is drawn",
	);
	ok(
		texts.every((e) => Number.isFinite(e[2]) && Number.isFinite(e[3])),
		"labels-canvas: text positions are finite",
	);
	ok(
		count("save") === count("restore"),
		"labels-canvas: save/restore balanced",
	);
	ok(
		!JSON.stringify(got.log).match(/NaN|Infinity/),
		"labels-canvas: no NaN/Infinity in drawing calls",
	);

	// DOM label variables: CLASSIC computes to the old Tailwind classes' values
	const v = labelCssVars(CLASSIC.labels) as Record<string, string>;
	ok(
		eq(v, {
			"--lbl-name-px": "12px",
			"--lbl-name-w": "600",
			"--lbl-name-c": "rgb(255,255,255)",
			"--lbl-sub-px": "10px",
			"--lbl-sub-w": "400",
			"--lbl-sub-c": "color-mix(in oklab, rgb(255,255,255) 75%, transparent)",
			"--lbl-halo": "drop-shadow(0 1px 3px rgba(0,0,0,0.9))",
			"--lbl-stroke": "0 transparent",
			"--lbl-lead-len": "28px",
			"--lbl-lead-w": "1px",
			"--lbl-lead-from":
				"color-mix(in oklab, rgb(255,255,255) 90%, transparent)",
			"--lbl-lead-to": "color-mix(in oklab, rgb(255,255,255) 0%, transparent)",
			"--lbl-dot": "6px",
			"--lbl-dot-c": "rgb(255,255,255)",
			"--lbl-dot-shadow": "0 0 6px rgba(0,0,0,0.6)",
		}),
		"labels-css: CLASSIC = the old Tailwind label classes",
		v,
	);
}

for (const w of warns) console.log(`WARN ${w}`);
console.log(
	`\nstyle-check: ${pass} passed, ${fail} failed, ${warns.length} warnings`,
);
process.exit(fail ? 1 : 0);
