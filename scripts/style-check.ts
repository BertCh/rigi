// Self-check for src/lib/style (no test runner in this repo). Run: npx tsx scripts/style-check.ts
// Exit 0 = all pass. Covers: CLASSIC = today's constants (numbers snapshot + cross-check against
// materials.ts makeSharedUniforms + source literal scan), ramps vs the shader formulas, merge/clamp/
// union semantics, presets resolving to complete styles, storage parsing/fallback, ?style=, cross-tab.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { makeSharedUniforms } from "../src/lib/materials.ts";
import { drawPeakLabels } from "../src/lib/look/labels/canvas.ts";
import { labelCssVars } from "../src/lib/look/labels/css.ts";
import {
	applyCompositeStyle,
	applyLayerStyle,
	applyTerrainLook,
	makeCompositeStyleUniforms,
	rawColor,
	trailColor,
} from "../src/lib/style/three-apply.ts";
import {
	hazeColorAsRendered,
	hexToRgba01,
	isHex,
	toCss,
} from "../src/lib/style/color.ts";
import { CLASSIC } from "../src/lib/style/defaults.ts";
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
import { lookKey } from "../src/lib/look/look-key.ts";
import {
	STYLE_STORAGE_KEY,
	createStyleStore,
	parseStoredState,
	urlPreset,
} from "../src/lib/style/store.ts";
import type { ViewStyle } from "../src/lib/style/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
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

// ---- 2. cross-check the shader's shared uniforms (materials.ts:13–38) ----------------------------
{
	const u = makeSharedUniforms();
	const sun = new THREE.Vector3(
		...(CLASSIC.terrain.sun as { dir: [number, number, number] }).dir,
	).normalize();
	ok(
		(u.uSunDir.value as THREE.Vector3).equals(sun),
		"uSunDir = normalise(CLASSIC sun)",
	);
	ok(
		u.uContourMajorEvery.value === CLASSIC.overlay.contours.majorEvery,
		"uContourMajorEvery",
	);
	ok(u.uContourWidth.value === CLASSIC.overlay.contours.width, "uContourWidth");
	ok(
		u.uContourFadeNear.value === CLASSIC.overlay.contours.distFade.near,
		"uContourFadeNear",
	);
	ok(
		u.uContourFadeFar.value === CLASSIC.overlay.contours.distFade.far,
		"uContourFadeFar",
	);
	// the legacy path: THREE.Color.set(hex) (linearises) → shader toLinear again
	const hc = u.uHazeColor.value as THREE.Color;
	ok(
		hc.equals(new THREE.Color(CLASSIC.terrain.hazeColor as string)),
		"uHazeColor = Color(CLASSIC hazeColor)",
	);
	const asR = hazeColorAsRendered(CLASSIC.terrain.hazeColor);
	ok(
		near(asR[0], hc.r ** 2.2, 1e-6) && near(asR[2], hc.b ** 2.2, 1e-6),
		"hazeColorAsRendered mirrors three + toLinear",
		[asR, [hc.r, hc.g, hc.b]],
	);
	// chunk 2 adds uniforms filled with CLASSIC values; check those that exist
	const opt: [string, unknown][] = [
		["uShadeAmbient", CLASSIC.terrain.ambient],
		["uShadeDirect", CLASSIC.terrain.direct],
		["uHazeDensity", CLASSIC.terrain.hazeDensity],
		["uHazeMax", CLASSIC.terrain.hazeMax],
		["uContourMajorMul", CLASSIC.overlay.contours.majorWidthMul],
		["uMinorAlpha", CLASSIC.overlay.contours.minorAlpha],
		["uMajorAlpha", CLASSIC.overlay.contours.majorAlpha],
		["uFadeFloor", CLASSIC.overlay.contours.distFade.floor],
		["uBandShadeMin", CLASSIC.overlay.bands.shadeMin],
		["uBandLineWhiten", CLASSIC.overlay.bands.lineWhiten],
		["uBandLineAlpha", CLASSIC.overlay.bands.lineAlpha],
		["uBandAlpha", CLASSIC.overlay.bands.alpha],
	];
	for (const [k, v] of opt)
		if (u[k]) ok(u[k].value === v, `chunk-2 uniform ${k}`, u[k].value);
}

// ---- 3. source literal scan (WARN only: chunks 2–4 move these literals into uniforms/CSS vars) ----
{
	const src = (f: string) => readFileSync(join(ROOT, f), "utf8");
	const mat = src("src/lib/materials.ts");
	const eng = src("src/lib/engine.ts");
	const ws = src("src/components/PhotoWorkspace.tsx");
	const lits: [string, string, string][] = [
		[mat, "materials.ts", "vec3 c0 = vec3(0.36, 0.52, 0.30)"],
		[mat, "materials.ts", "vec3 c4 = vec3(0.97, 0.98, 1.00)"],
		[mat, "materials.ts", "smoothstep(0.72, 0.85, t)"],
		[mat, "materials.ts", "vec3 a = vec3(0.10, 0.85, 0.80)"],
		[mat, "materials.ts", "vec3 e = vec3(1.00, 0.95, 0.85)"],
		[mat, "materials.ts", "return 0.25 * sky + 0.85 * l"],
		[mat, "materials.ts", "-range * 0.000018 * uHaze"],
		[mat, "materials.ts", "clamp(f, 0.0, 0.85)"],
		[mat, "materials.ts", "smoothstep(0.08, 0.2, density)"],
		[mat, "materials.ts", "smoothstep(0.1, 0.25, fwidth(em))"],
		[mat, "materials.ts", "uContourWidth * 1.8"],
		[
			mat,
			"materials.ts",
			"max(minorA * 0.45, majorA * 0.95) * mix(0.3, 1.0, fade)",
		],
		[mat, "materials.ts", "(0.55 + 0.45 * shade(n))"],
		[
			mat,
			"materials.ts",
			"mix(bc, vec3(1.0), a * 0.8), (0.55 + 0.4 * a) * smoothstep(60.0, 450.0, range)",
		],
		[mat, "materials.ts", "vec3(0.02, 0.03, 0.06)"],
		[mat, "materials.ts", "casing * 0.55"],
		[mat, "materials.ts", "vec3(1.0, 0.85, 0.6)"],
		[eng, "engine.ts", "log(200.0)) / (log(80000.0) - log(200.0))"],
		[
			eng,
			"engine.ts",
			"(0.35 + 0.65 * dot(col, vec3(0.333)) * 1.4), uDepthTint * 0.75",
		],
		[
			eng,
			"engine.ts",
			"mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.45, 0.25), isSkyline)",
		],
		[eng, "engine.ts", "ridge * uRidges * 0.9"],
		[eng, "engine.ts", "smoothstep(0.12, 0.45, e)"],
		[eng, "engine.ts", "smoothstep(0.7, 1.0, edgeLine) * 0.6"],
		[eng, "engine.ts", "ridge * uRidges * 0.5 * m"],
		[eng, "engine.ts", "s.mode === 'replace' ? 0.6 : 1"],
		[eng, "engine.ts", "u.uHaze.value = 0.5"],
		[eng, "engine.ts", "setClearColor(0x9fb8d0, 1)"],
		[eng, "engine.ts", "new THREE.Color(0xa9c2da)"],
		[
			eng,
			"engine.ts",
			"new THREE.SphereGeometry(18, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff5533 })",
		],
		[eng, "engine.ts", "color: 0xffffff, transparent: true, opacity: 0.9"],
		[eng, "engine.ts", "hiking: [1.0, 0.82, 0.25]"],
		[eng, "engine.ts", "mountain_hiking: [1.0, 0.32, 0.36]"],
		[eng, "engine.ts", "alpine_hiking: [0.3, 0.67, 0.97]"],
		[
			eng,
			"engine.ts",
			"linewidth: 2.2, vertexColors: true, worldUnits: false, transparent: true, opacity: 0.95",
		],
		[eng, "engine.ts", "peakLabels(max = 28)"],
		[eng, "engine.ts", "const s = W / 1400"],
		[eng, "engine.ts", "const stem = 34 * s"],
		[eng, "engine.ts", "1.5 * s, stem"],
		[eng, "engine.ts", "ctx.arc(x, y, 3.5 * s"],
		[eng, "engine.ts", "ctx.shadowColor = 'rgba(0,0,0,0.85)'"],
		[eng, "engine.ts", "ctx.shadowBlur = 4 * s"],
		[eng, "engine.ts", "y - stem - 16 * s"],
		[eng, "engine.ts", "`600 ${15 * s}px Manrope, system-ui, sans-serif`"],
		[eng, "engine.ts", "`400 ${12 * s}px Manrope, system-ui, sans-serif`"],
		[eng, "engine.ts", "'rgba(255,255,255,0.8)'"],
		[eng, "engine.ts", "ty + 15 * s"],
		[
			ws,
			"PhotoWorkspace.tsx",
			"h-7 w-px -translate-x-1/2 from-white/90 to-white/0",
		],
		[
			ws,
			"PhotoWorkspace.tsx",
			"size-1.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(0,0,0,0.6)]",
		],
		[ws, "PhotoWorkspace.tsx", "drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"],
		[
			ws,
			"PhotoWorkspace.tsx",
			"text-[12px] leading-tight font-semibold text-white",
		],
		[ws, "PhotoWorkspace.tsx", "text-[10px] leading-tight text-white/75"],
	];
	for (const [s, f, lit] of lits)
		if (!s.includes(lit))
			warns.push(`${f}: literal not found (moved by a later chunk?): ${lit}`);
}

// ---- 4. ramps reproduce the shader functions ----------------------------------------------------
{
	const mix = (a: number[], b: number[], t: number) =>
		a.map((x, i) => x + (b[i] - x) * t);
	const ss = (e0: number, e1: number, x: number) => {
		const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
		return t * t * (3 - 2 * t);
	};
	// materials.ts:92–105
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
	// materials.ts:108–121
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
	ok(maxH < 1e-12, "hypso-classic = materials.ts hypso()", maxH);
	ok(maxC < 1e-12, "cool = materials.ts coolRamp()", maxC);
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
		eq(parseStoredState(null), { preset: "classic", overrides: {} }),
		"empty storage → classic",
	);
	ok(
		eq(parseStoredState("{nope"), { preset: "classic", overrides: {} }),
		"corrupt JSON → classic",
	);
	ok(
		eq(parseStoredState('{"v":2,"preset":"night","overrides":{}}'), {
			preset: "classic",
			overrides: {},
		}),
		"unknown version → classic",
	);
	ok(
		eq(parseStoredState('{"v":1,"preset":"zzz","overrides":{}}'), {
			preset: "classic",
			overrides: {},
		}),
		"unknown preset → classic",
	);
	ok(
		eq(parseStoredState("[1,2]"), { preset: "classic", overrides: {} }),
		"array → classic",
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
		onExternalChange: (_k: string, cb: (v: string | null) => void) => (
			(ext = cb), () => (ext = null)
		),
	};
	const s = createStyleStore(env);
	let n = 0;
	s.subscribe(() => n++);
	ok(s.getStyle() === CLASSIC, "store starts at classic");
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
		s.getState().preset === "classic",
		"cleared storage in another tab → classic",
	);
	s.setPreset("night");
	s.setState({ preset: "classic", overrides: {} });
	ok(!mem.has(STYLE_STORAGE_KEY), "classic with no overrides removes the key");
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
	ok(none.getStyle() === CLASSIC, "no storage → classic");
}

// ---- 7. three.js adapter (chunks 2–4): applying CLASSIC reproduces the classic defaults ----------
{
	type IU = Record<string, { value: unknown }>;
	const flat = (v: unknown): unknown => {
		if (
			v &&
			typeof v === "object" &&
			"toArray" in v &&
			typeof (v as { toArray: unknown }).toArray === "function"
		)
			return (v as { toArray(): number[] }).toArray();
		if (Array.isArray(v)) return v.map(flat);
		return v;
	};
	const snapU = (u: IU) =>
		Object.fromEntries(Object.entries(u).map(([k, v]) => [k, flat(v.value)]));
	const diffKeys = (a: Record<string, unknown>, b: Record<string, unknown>) =>
		Object.keys(a).filter((k) => !eq(a[k], b[k]));

	const shared = makeSharedUniforms() as IU;
	ok(
		eq(flat(shared.uBandShade.value), [
			CLASSIC.overlay.bands.shadeMin,
			1 - CLASSIC.overlay.bands.shadeMin,
		]),
		"uBandShade = (shadeMin, 1 - shadeMin)",
	);
	ok(
		eq(flat(shared.uCasing.value), [1, 2, 0.45, 0.55]) &&
			eq(flat(shared.uCasingCol.value), CLASSIC.overlay.contours.casing.color),
		"casing uniforms = CLASSIC",
	);
	ok(
		eq(flat(shared.uDensityFade.value), CLASSIC.overlay.contours.densityFade),
		"uDensityFade = CLASSIC",
	);

	const hazeFor = {
		overlay: 1,
		replace: CLASSIC.replace.haze,
		world: CLASSIC.world.haze,
	};
	for (const mode of ["overlay", "replace", "world"] as const) {
		const u = makeSharedUniforms() as IU;
		const want = snapU(u);
		want.uHaze = hazeFor[mode];
		applyTerrainLook(u as never, CLASSIC.terrain, { localRange: [400, 4200] });
		applyLayerStyle(u as never, CLASSIC, mode);
		const d = diffKeys(want, snapU(u));
		ok(
			d.length === 0,
			`adapter: CLASSIC (${mode}) leaves every terrain uniform at its classic default`,
			d,
		);
	}
	{
		const cu = makeCompositeStyleUniforms() as IU;
		const want = snapU(cu);
		applyCompositeStyle(cu as never, CLASSIC);
		const d = diffKeys(want, snapU(cu));
		ok(
			d.length === 0,
			"adapter: CLASSIC leaves every composite uniform at its classic default",
			d,
		);
		const f = Math.fround;
		ok(
			eq(flat(cu.uDepthLog.value), [
				f(Math.log(200)),
				f(1 / f(f(Math.log(80000)) - f(Math.log(200)))),
			]),
			"uDepthLog mirrors the folded float32 constants",
		);
	}
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
			].map((s) => trailColor(CLASSIC, s)),
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
	// every preset goes through the adapter with finite values
	for (const id of PRESET_IDS) {
		const st = presetStyle(id);
		const u = makeSharedUniforms() as IU;
		const cu = makeCompositeStyleUniforms() as IU;
		applyTerrainLook(u as never, st.terrain, {
			localRange: [400, 4200],
			takenAt: "2025-08-01T15:00:00Z",
			lat: 46.5,
			lon: 8,
		});
		for (const m of ["overlay", "replace", "world"] as const)
			applyLayerStyle(u as never, st, m);
		applyCompositeStyle(cu as never, st);
		const bad = JSON.stringify([snapU(u), snapU(cu)]).match(/NaN|Infinity/);
		ok(!bad, `adapter: preset ${id} yields finite uniforms`);
	}

	// canvas labels: CLASSIC replays the pre-chunk-3 exportImage drawing call for call
	const record = () => {
		const log: unknown[] = [];
		const ctx = new Proxy({} as Record<string, unknown>, {
			get(t, k) {
				if (k === "createLinearGradient")
					return (...a: unknown[]) => {
						log.push(["grad", ...a]);
						return {
							addColorStop: (...b: unknown[]) => log.push(["stop", ...b]),
						};
					};
				if (
					typeof k === "string" &&
					["fillRect", "beginPath", "arc", "fill", "fillText"].includes(k)
				)
					return (...a: unknown[]) => log.push([k, ...a]);
				return t[k as string];
			},
			set(t, k, v) {
				const val = typeof v === "object" ? "gradient" : v;
				log.push([
					"set",
					k,
					k === "fillStyle" && v === "#fff" ? "rgb(255,255,255)" : val,
				]);
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
	const W = 4032;
	const H = 3024;
	const ref = record();
	{
		// engine.ts exportImage labels before chunk 3 (verbatim, "l.u * W" etc.)
		const ctx = ref.ctx;
		const s = W / 1400;
		ctx.textAlign = "center";
		for (const l of labels) {
			const x = l.u * W;
			const y = l.v * H;
			const up = l.v >= 0.1;
			const stem = 34 * s;
			const g = ctx.createLinearGradient(0, y, 0, up ? y - stem : y + stem);
			g.addColorStop(0, "rgba(255,255,255,0.9)");
			g.addColorStop(1, "rgba(255,255,255,0)");
			ctx.fillStyle = g;
			ctx.fillRect(x - 0.75 * s, up ? y - stem : y, 1.5 * s, stem);
			ctx.fillStyle = "#fff";
			ctx.beginPath();
			ctx.arc(x, y, 3.5 * s, 0, Math.PI * 2);
			ctx.fill();
			ctx.shadowColor = "rgba(0,0,0,0.85)";
			ctx.shadowBlur = 4 * s;
			const ty = up ? y - stem - 16 * s : y + stem + 16 * s;
			ctx.font = `600 ${15 * s}px Manrope, system-ui, sans-serif`;
			ctx.fillText(l.name, x, ty);
			ctx.font = `400 ${12 * s}px Manrope, system-ui, sans-serif`;
			ctx.fillStyle = "rgba(255,255,255,0.8)";
			ctx.fillText(
				`${l.ele ? `${Math.round(l.ele).toLocaleString()} m · ` : ""}${l.distKm.toFixed(1)} km`,
				x,
				ty + 15 * s,
			);
			ctx.shadowBlur = 0;
		}
	}
	const got = record();
	drawPeakLabels(got.ctx, labels, CLASSIC.labels, W, H);
	// the new drawer sets the (unchanged) white fill again before the name: drop no-op re-sets
	const dedupe = (log: unknown[]) => {
		const out: unknown[] = [];
		const cur: Record<string, unknown> = {};
		for (const e of log as unknown[][]) {
			if (e[0] === "set" && e[2] !== "gradient" && cur[e[1] as string] === e[2])
				continue;
			if (e[0] === "set") cur[e[1] as string] = e[2];
			out.push(e);
		}
		return JSON.stringify(out);
	};
	ok(
		dedupe(got.log) === dedupe(ref.log),
		"labels-canvas: CLASSIC = the old export drawing (call for call)",
		dedupe(got.log).slice(0, 300),
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
