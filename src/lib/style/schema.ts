// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Schema for ViewStyle: validation (clamps, hex checks, unknown keys dropped), schema-aware deep
// merge (tuples / ramps replaced wholesale, discriminated unions switch variant cleanly), pruning of
// untrusted partials (localStorage) and diffing (so storage keeps diff-only overrides).
import { clamp } from "../math";
import { isHex } from "./color";
import { CLASSIC, NEBELMEER_DEFAULT } from "./defaults";
import { isRampName, MAX_RAMP_STOPS } from "./ramps";
import type { DeepPartial, ViewStyle } from "./types";

type Obj = Record<string, unknown>;
type Fields = Record<string, Node>;
export type Node =
	| { k: "num"; min: number; max: number; int?: boolean }
	| { k: "bool" }
	| { k: "hex" }
	| { k: "enum"; values: readonly string[] }
	| { k: "lit"; value: unknown }
	| { k: "str"; max: number }
	| { k: "tuple"; items: Node[] }
	| { k: "ramp" }
	| { k: "obj"; fields: Fields }
	| {
			k: "union";
			tag: string;
			variants: Record<string, { fields: Fields; def: Obj }>;
	  }
	| { k: "nullable"; inner: Node; def: unknown }
	| { k: "litOr"; lit: string; inner: Node; def: unknown };

const num = (min: number, max: number, int = false): Node => ({
	k: "num",
	min,
	max,
	int,
});
const bool: Node = { k: "bool" };
const hex: Node = { k: "hex" };
const ramp: Node = { k: "ramp" };
const en = (...values: string[]): Node => ({ k: "enum", values });
const obj = (fields: Fields): Node => ({ k: "obj", fields });
const tup = (...items: Node[]): Node => ({ k: "tuple", items });
const unit = num(0, 1);

const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v);

// ---- the ViewStyle schema ----------------------------------------------------------------------

const imagery = obj({
	saturation: num(0, 3),
	brightness: num(0, 3),
	contrast: num(0, 3),
	tint: hex,
	tintAmount: unit,
});
const bandFields: Fields = {
	ramp,
	lines: {
		k: "litOr",
		lit: "contours",
		inner: obj({
			width: num(0.25, 8),
			every: num(1, 20, true),
			majorWidthMul: num(0.5, 5),
			minorAlpha: unit,
			majorAlpha: unit,
		}),
		def: {
			width: 1.2,
			every: 5,
			majorWidthMul: 1.8,
			minorAlpha: 0.45,
			majorAlpha: 0.95,
		},
	},
	shadeMin: unit,
	lineWhiten: unit,
	lineColor: hex,
	alpha: unit,
	lineAlpha: unit,
	groundFade: tup(num(0, 10000), num(0, 10000)),
};
const exportFields: Fields = {
	scaleRef: num(100, 20000),
	namePx: num(4, 100),
	subPx: num(4, 100),
	leaderPx: num(0, 300),
	leaderW: num(0, 20),
	dotR: num(0, 50),
	haloBlur: num(0, 50),
	haloAlpha: unit,
	textGap: num(0, 200),
	lineGap: num(0, 200),
	subAlpha: unit,
	dotShadow: bool,
};

export const VIEW_STYLE_SCHEMA: Node = obj({
	v: { k: "lit", value: 1 },
	terrain: obj({
		sun: {
			k: "union",
			tag: "mode",
			variants: {
				fixed: {
					fields: { dir: tup(num(-1, 1), num(-1, 1), num(-1, 1)) },
					def: { mode: "fixed", dir: [-0.5, -0.4, 0.75] },
				},
				azel: {
					fields: { azimuthDeg: num(0, 360), elevationDeg: num(-10, 90) },
					def: { mode: "azel", azimuthDeg: 315, elevationDeg: 45 },
				},
				"photo-time": { fields: {}, def: { mode: "photo-time" } },
			},
		},
		ambient: num(0, 2),
		direct: num(0, 2),
		reliefRamp: ramp,
		rampRange: {
			k: "union",
			tag: "mode",
			variants: {
				local: { fields: {}, def: { mode: "local" } },
				absolute: {
					fields: { lo: num(-500, 9000), hi: num(-500, 9000) },
					def: { mode: "absolute", lo: 400, hi: 4200 },
				},
			},
		},
		hazeColor: hex,
		hazeDensity: num(0, 0.001),
		hazeMax: unit,
		atmosphere: {
			k: "union",
			tag: "mode",
			variants: {
				classic: { fields: {}, def: { mode: "classic" } },
				physical: {
					fields: {
						strength: num(0, 3),
						airlight: en("physical", "fitted"),
						nebelmeer: obj({
							top: num(-500, 6000),
							density: num(0, 0.02),
							falloff: num(0.0002, 0.1),
							color: hex,
						}),
					},
					def: {
						mode: "physical",
						strength: 1,
						airlight: "physical",
						nebelmeer: NEBELMEER_DEFAULT,
					},
				},
			},
		},
		relief: {
			k: "union",
			tag: "mode",
			variants: {
				lambert: { fields: {}, def: { mode: "lambert" } },
				swiss: {
					fields: { realism: unit, generalize: unit, curvature: unit },
					def: {
						mode: "swiss",
						realism: 0.15,
						generalize: 0.6,
						curvature: 0.5,
					},
				},
			},
		},
		albedo: {
			k: "union",
			tag: "mode",
			variants: {
				ramp: { fields: {}, def: { mode: "ramp" } },
				alpine: {
					fields: { water: bool },
					def: { mode: "alpine", water: false },
				},
			},
		},
	}),
	overlay: obj({
		contours: obj({
			kind: en("plain", "tanaka"),
			color: {
				k: "union",
				tag: "mode",
				variants: {
					ramp: { fields: { ramp }, def: { mode: "ramp", ramp: "cool" } },
					solid: {
						fields: { minor: hex, major: hex },
						def: { mode: "solid", minor: "#ffffff", major: "#ffffff" },
					},
				},
			},
			width: num(0.25, 8),
			majorEvery: num(1, 20, true),
			majorWidthMul: num(0.5, 5),
			minorAlpha: unit,
			majorAlpha: unit,
			densityFade: tup(num(0, 2), num(0, 2), num(0, 2), num(0, 2)),
			distFade: obj({ near: num(0, 500000), far: num(0, 500000), floor: unit }),
			casing: obj({
				on: bool,
				color: hex,
				extraPx: num(0, 10),
				minorMul: unit,
				alpha: unit,
			}),
		}),
		bands: obj(bandFields),
		ridges: obj({
			inner: hex,
			skyline: hex,
			gain: unit,
			threshold: tup(num(0, 2), num(0, 2)),
		}),
		depthTint: obj({
			ramp,
			nearM: num(1, 1e6),
			farM: num(1, 1e7),
			gain: unit,
			lumaKeep: tup(num(0, 2), num(0, 2)),
		}),
		slope: obj({ alpha: unit, colors: tup(hex, hex, hex, hex) }),
	}),
	replace: obj({
		haze: num(0, 3),
		imagery,
		bands: {
			k: "litOr",
			lit: "overlay",
			inner: obj(bandFields),
			def: CLASSIC.overlay.bands,
		},
		ridges: obj({ inner: hex, gain: unit }),
		hairline: obj({ color: hex, alpha: unit }),
	}),
	world: obj({
		haze: num(0, 3),
		imagery,
		sky: obj({ mode: en("flat", "atmosphere"), clear: hex, background: hex }),
		frame: obj({
			planeOpacity: unit,
			lineColor: hex,
			lineOpacity: unit,
			pinColor: hex,
			pinRadiusM: num(0, 500),
		}),
		projectionTint: obj({ color: hex, amount: unit }),
		drapeHarmonize: unit,
		clearAir: obj({
			mode: en("off", "consistent", "fitted"),
			amount: unit,
			floor: num(0.05, 1),
		}),
		weather: {
			k: "union",
			tag: "mode",
			variants: {
				off: { fields: {}, def: { mode: "off" } },
				rain: {
					fields: { intensity: unit, wind: num(-20, 20) },
					def: { mode: "rain", intensity: 0.6, wind: 3 },
				},
				snow: {
					fields: { intensity: unit, wind: num(-20, 20) },
					def: { mode: "snow", intensity: 0.6, wind: 1 },
				},
			},
		},
	}),
	composite: obj({
		refine: bool,
		harmonize: unit,
		ridges: en("classic", "ink"),
		ink: obj({
			strength: unit,
			width: num(0.25, 4),
			crease: unit,
			inner: hex,
			skyline: hex,
		}),
		sky: en("dem", "photo"),
		output: en("classic", "neutral"),
	}),
	trails: obj({
		width: num(0.5, 10),
		opacity: unit,
		colors: obj({ hiking: hex, mountain: hex, alpine: hex, other: hex }),
		dash: tup(num(0.5, 5000), num(0, 5000)),
	}),
	labels: obj({
		layout: en("classic", "panorama", "inline"),
		fontFamily: { k: "str", max: 200 },
		name: obj({ px: num(6, 40), weight: num(100, 900, true), color: hex }),
		sub: obj({
			px: num(6, 40),
			weight: num(100, 900, true),
			color: hex,
			show: en("ele+dist", "ele", "dist", "none"),
		}),
		halo: obj({
			kind: en("shadow", "stroke", "none"),
			color: hex,
			blurPx: num(0, 20),
			offsetY: num(-10, 10),
			strokePx: num(0, 10),
			adaptive: unit,
		}),
		leader: obj({
			lengthPx: num(0, 100),
			widthPx: num(0, 6),
			color: hex,
			fade: bool,
		}),
		dot: obj({
			px: num(0, 30),
			color: hex,
			glow: { k: "nullable", inner: hex, def: "#00000099" },
			glowPx: num(0, 30),
		}),
		maxLabels: num(0, 100, true),
		export: {
			k: "nullable",
			inner: obj(exportFields),
			def: CLASSIC.labels.export,
		},
	}),
	terroir: obj({
		names: obj({
			on: bool,
			reach: en("near", "all"),
			language: en("local", "local+usual"),
			maxLabels: num(0, 80, true),
		}),
		peakTiers: bool,
		subPill: bool,
		contours: obj({ adaptive: bool, swissIndex: bool, inkByCover: bool }),
		cover: obj({ on: bool, snow: en("none", "date") }),
		glacier: obj({
			on: bool,
			year: num(1850, 2030, true),
			style: en("outline", "fill"),
		}),
		sunPath: bool,
		legend: bool,
		uncertainty: bool,
		placeCard: bool,
		furniture: bool,
	}),
});

// ---- leaves -----------------------------------------------------------------------------------

const NOPE = Symbol("invalid");

function sanitizeRamp(v: unknown): unknown {
	if (isRampName(v)) return v;
	if (!isObj(v)) return NOPE;
	if (v.kind === "turbo") return { kind: "turbo" };
	if (v.kind !== "stops" || !Array.isArray(v.stops)) return NOPE;
	const s = v.stops;
	if (s.length < 2 || s.length > MAX_RAMP_STOPS) return NOPE;
	const out: Obj[] = [];
	let prev = -1;
	for (const st of s) {
		if (
			!isObj(st) ||
			typeof st.t !== "number" ||
			!Number.isFinite(st.t) ||
			st.t < 0 ||
			st.t > 1 ||
			st.t < prev
		)
			return NOPE;
		const c = sanitizeHex(st.c);
		if (c === NOPE) return NOPE;
		if (st.ease !== undefined && st.ease !== "linear" && st.ease !== "smooth")
			return NOPE;
		out.push(st.ease ? { t: st.t, c, ease: st.ease } : { t: st.t, c });
		prev = st.t;
	}
	return { kind: "stops", stops: out };
}

function sanitizeHex(v: unknown): unknown {
	if (!isHex(v)) return NOPE;
	return typeof v === "string" ? v.toLowerCase() : v.map((x) => clamp(x, 0, 1));
}

/** A valid, clamped copy of a leaf value, or NOPE. */
function leaf(n: Node, v: unknown): unknown {
	switch (n.k) {
		case "num":
			if (typeof v !== "number" || !Number.isFinite(v)) return NOPE;
			return clamp(n.int ? Math.round(v) : v, n.min, n.max);
		case "bool":
			return typeof v === "boolean" ? v : NOPE;
		case "hex":
			return sanitizeHex(v);
		case "enum":
			return typeof v === "string" && n.values.includes(v) ? v : NOPE;
		case "lit":
			return v === n.value ? v : NOPE;
		case "str":
			return typeof v === "string" && v.length <= n.max ? v : NOPE;
		case "ramp":
			return sanitizeRamp(v);
		case "tuple": {
			if (!Array.isArray(v) || v.length !== n.items.length) return NOPE;
			const out = v.map((x, i) => leaf(n.items[i], x));
			return out.includes(NOPE) ? NOPE : out;
		}
		default:
			return NOPE;
	}
}

const isLeaf = (n: Node) =>
	n.k !== "obj" && n.k !== "union" && n.k !== "nullable" && n.k !== "litOr";

// ---- merge ------------------------------------------------------------------------------------

/** `base` (assumed valid) with the valid parts of `over` applied. Always a complete, valid value. */
export function mergeNode(n: Node, base: unknown, over: unknown): unknown {
	if (over === undefined) return base;
	if (isLeaf(n)) {
		const v = leaf(n, over);
		return v === NOPE ? base : v;
	}
	switch (n.k) {
		case "obj": {
			if (!isObj(over)) return base;
			const b = base as Obj;
			const out: Obj = {};
			for (const [k, f] of Object.entries(n.fields))
				out[k] = mergeNode(f, b[k], over[k]);
			return out;
		}
		case "union": {
			if (!isObj(over)) return base;
			const b = base as Obj;
			const want = over[n.tag];
			const tag =
				typeof want === "string" && want in n.variants
					? want
					: (b[n.tag] as string);
			const variant = n.variants[tag];
			const start = b[n.tag] === tag ? b : variant.def;
			const out: Obj = { [n.tag]: tag };
			for (const [k, f] of Object.entries(variant.fields))
				out[k] = mergeNode(f, start[k], over[k]);
			return out;
		}
		case "nullable":
			if (over === null) return null;
			return mergeNode(n.inner, base === null ? n.def : base, over);
		case "litOr":
			if (over === n.lit) return n.lit;
			if (!isObj(over)) return base;
			return mergeNode(n.inner, base === n.lit ? n.def : base, over);
	}
	return base;
}

// ---- prune (untrusted partial → valid partial) --------------------------------------------------

/** Keeps only the valid (clamped) parts of an untrusted partial. undefined when nothing is left. */
export function pruneNode(n: Node, over: unknown): unknown {
	if (over === undefined) return undefined;
	if (isLeaf(n)) {
		const v = leaf(n, over);
		return v === NOPE ? undefined : v;
	}
	switch (n.k) {
		case "obj":
			return pruneFields(n.fields, over);
		case "union": {
			if (!isObj(over)) return undefined;
			const tag = over[n.tag];
			if (typeof tag === "string" && tag in n.variants) {
				return {
					...(pruneFields(n.variants[tag].fields, over) as Obj | undefined),
					[n.tag]: tag,
				};
			}
			// no (valid) tag: keep fields valid in some variant; merge applies them to the base's variant
			const all: Fields = {};
			for (const v of Object.values(n.variants)) Object.assign(all, v.fields);
			return pruneFields(all, over);
		}
		case "nullable":
			return over === null ? null : pruneNode(n.inner, over);
		case "litOr":
			return over === n.lit ? n.lit : pruneNode(n.inner, over);
	}
	return undefined;
}

function pruneFields(fields: Fields, over: unknown): Obj | undefined {
	if (!isObj(over)) return undefined;
	const out: Obj = {};
	for (const [k, f] of Object.entries(fields)) {
		const v = pruneNode(f, over[k]);
		if (v !== undefined) out[k] = v;
	}
	return Object.keys(out).length ? out : undefined;
}

// ---- diff ---------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

/** The minimal partial that turns `base` into `value` under mergeNode. undefined when equal. */
export function diffNode(n: Node, base: unknown, value: unknown): unknown {
	if (same(base, value)) return undefined;
	if (isLeaf(n)) return value;
	switch (n.k) {
		case "obj": {
			const b = base as Obj;
			const v = value as Obj;
			const out: Obj = {};
			for (const [k, f] of Object.entries(n.fields)) {
				const d = diffNode(f, b[k], v[k]);
				if (d !== undefined) out[k] = d;
			}
			return Object.keys(out).length ? out : undefined;
		}
		case "union": {
			const b = base as Obj;
			const v = value as Obj;
			if (b[n.tag] !== v[n.tag]) return value;
			const out: Obj = {};
			for (const [k, f] of Object.entries(
				n.variants[v[n.tag] as string].fields,
			)) {
				const d = diffNode(f, b[k], v[k]);
				if (d !== undefined) out[k] = d;
			}
			return Object.keys(out).length ? out : undefined;
		}
		case "nullable":
			return base === null || value === null
				? value
				: diffNode(n.inner, base, value);
		case "litOr":
			return base === n.lit || value === n.lit
				? value
				: diffNode(n.inner, base, value);
	}
	return value;
}

// ---- typed API ----------------------------------------------------------------------------------

/** Deep merge of partials onto a complete style. Invalid / unknown parts are ignored, numbers clamped. */
export function mergeStyle(
	base: ViewStyle,
	...partials: (DeepPartial<ViewStyle> | undefined)[]
): ViewStyle {
	let s: unknown = base;
	for (const p of partials) s = mergeNode(VIEW_STYLE_SCHEMA, s, p);
	return s as ViewStyle;
}

/** Untrusted input (storage, URL, UI) → a valid partial containing only known, in-range values. */
export function pruneOverrides(v: unknown): DeepPartial<ViewStyle> {
	const p = pruneNode(VIEW_STYLE_SCHEMA, v) as Obj | undefined;
	if (p) delete p.v;
	return (p ?? {}) as DeepPartial<ViewStyle>;
}

/** Diff-only overrides: what `value` changes relative to `base`. */
export function diffStyle(
	base: ViewStyle,
	value: ViewStyle,
): DeepPartial<ViewStyle> {
	return (diffNode(VIEW_STYLE_SCHEMA, base, value) ??
		{}) as DeepPartial<ViewStyle>;
}

/** A full style from untrusted input: every missing or invalid field falls back to `fallback`. */
export function validateStyle(
	v: unknown,
	fallback: ViewStyle = CLASSIC,
): ViewStyle {
	return mergeNode(VIEW_STYLE_SCHEMA, fallback, v) as ViewStyle;
}
