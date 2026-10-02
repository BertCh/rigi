// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Presets: each is a DeepPartial layered on CLASSIC (styling.md §2.2). Resolved style =
// merge(CLASSIC, PRESETS[preset], overrides): a preset only changes what it names, and the user's
// overrides survive a preset switch. Values other than classic are first drafts, tuned in chunk 5.
import { SWISSTOPO_LABELS } from "../terroir/labels/swisstopo";
import { CLASSIC } from "./defaults";
import {
	BERANN_INK,
	CONTOUR_BROWN,
	CONTOUR_CASING_BROWN,
	DARK_INK,
	TOPO_PAPER,
	WARM_INK,
} from "./palette";
import { ABSOLUTE_RAMP_RANGE } from "./ramps";
import { diffStyle, mergeStyle, pruneOverrides } from "./schema";
import type { DeepPartial, PresetId, StyleState, ViewStyle } from "./types";

/** Everything about a preset except its style values: the picker label and the layers it switches to. */
export type PresetInfo = {
	label: string;
	/** Other names accepted in ?style= and storage (the id stays the persisted form). */
	aliases?: readonly string[];
	/** The photo-view layer (Settings.overlayStyle) choosing the preset switches to. */
	overlayLayer?: "slope";
	/** Map layers (Settings.mapStyle / worldStyle) choosing the preset switches to; the user can change them back. */
	mapLayers?: { mapStyle?: "hillshade"; worldStyle?: "hillshade" };
};

/** The preset registry, in picker order. PRESET_IDS / PRESET_LABELS / PRESET_*_LAYER derive from it. */
export const PRESET_INFO: Record<PresetId, PresetInfo> = {
	classic: { label: "Classic" },
	minimal: { label: "Minimal" },
	"topo-map": { label: "Topo" },
	night: { label: "Night" },
	"high-contrast": { label: "High contrast" },
	"photo-matched": { label: "Photo-matched" },
	// the id predates the Landeskarte signature and stays the stored form
	swiss: { label: "Landeskarte", aliases: ["landeskarte"] },
	berann: { label: "Berann" },
	"topo-ink": { label: "Topo ink" },
	slope: { label: "Slope angle", overlayLayer: "slope" },
	// the terroir land cover shows on the relief rendering, not on satellite imagery
	terroir: {
		label: "Terroir",
		mapLayers: { mapStyle: "hillshade", worldStyle: "hillshade" },
	},
	"field-sketch": {
		label: "Field sketch",
		mapLayers: { mapStyle: "hillshade", worldStyle: "hillshade" },
	},
};

export const PRESET_IDS = Object.keys(PRESET_INFO) as readonly PresetId[];

export const PRESET_LABELS = Object.fromEntries(
	PRESET_IDS.map((id) => [id, PRESET_INFO[id].label]),
) as Record<PresetId, string>;

export function isPresetId(v: unknown): v is PresetId {
	return typeof v === "string" && Object.hasOwn(PRESET_INFO, v);
}

/** A preset id or one of its aliases (?style=landeskarte) → the id; anything else → null. */
export function presetIdFrom(v: unknown): PresetId | null {
	if (isPresetId(v)) return v;
	if (typeof v !== "string") return null;
	return PRESET_IDS.find((id) => PRESET_INFO[id].aliases?.includes(v)) ?? null;
}

/**
 * Brown Swiss contours with heavier index lines on a thin dark-brown casing (never Classic's navy:
 * no Swiss map draws brown lines on a blue-black halo; swiss-cartography-review D1). Landeskarte
 * and Terroir; Field sketch fades the alphas.
 */
const SWISS_CONTOURS = {
	color: { mode: "solid", ...CONTOUR_BROWN },
	minorAlpha: 0.55,
	majorAlpha: 0.9,
	width: 1.0,
	majorWidthMul: 1.9,
	casing: {
		on: true,
		color: CONTOUR_CASING_BROWN,
		extraPx: 1.2,
		alpha: 0.35,
	},
} as const satisfies DeepPartial<ViewStyle["overlay"]["contours"]>;

/**
 * The full terroir layer set (names, tiers, cover, glaciers, legend, card, furniture…) of the Terroir
 * preset; Field sketch takes it with hatching instead of the sun path.
 */
const TERROIR_LAYERS = {
	names: {
		on: true,
		reach: "near",
		language: "local+usual",
		maxLabels: 16,
	},
	peakTiers: true,
	subPill: true,
	contours: { adaptive: true, swissIndex: true, inkByCover: true },
	hatch: false,
	cover: { on: true, snow: "date", pattern: true },
	glacier: { on: true, year: 1850, style: "outline" },
	sunPath: true,
	legend: true,
	uncertainty: true,
	placeCard: true,
	furniture: true,
} as const satisfies DeepPartial<ViewStyle["terroir"]>;

const OVERLAY_RIDGE_GAIN = CLASSIC.overlay.ridges.gain; // 0.9
const REPLACE_RIDGE_GAIN = CLASSIC.replace.ridges.gain; // 0.5

export const PRESETS: Record<PresetId, DeepPartial<ViewStyle>> = {
	classic: {},

	/** Quiet lines that let the photo carry the image. */
	minimal: {
		overlay: {
			contours: {
				color: { mode: "solid", minor: "#ffffff", major: "#ffffff" },
				minorAlpha: 0.25,
				majorAlpha: 0.7,
				width: 1.0,
				casing: { on: false },
			},
			bands: { ramp: "grey", alpha: 0.35 },
			ridges: {
				inner: "#ffffff",
				skyline: "#ffffff",
				gain: OVERLAY_RIDGE_GAIN * 0.6,
			},
		},
		replace: { ridges: { inner: "#ffffff", gain: REPLACE_RIDGE_GAIN * 0.6 } },
		// in map: softer and paler, so the draped photo and the frame carry the view
		world: {
			haze: 0.7,
			imagery: { saturation: 0.75, contrast: 0.92, brightness: 1.04 },
			sky: { clear: "#c4d2df", background: "#cfdae5" },
			frame: {
				lineColor: "#ffffff",
				lineOpacity: 0.75,
				pinColor: "#f5f5f5",
				pinRadiusM: 14,
			},
		},
		labels: {
			name: { px: 11, weight: 500 },
			sub: { show: "ele" },
			leader: { lengthPx: 18 },
			dot: { px: 4 },
			halo: { kind: "shadow", blurPx: 6, color: "#00000080" },
			export: null,
		},
	},

	/** Paper-map look. */
	"topo-map": {
		terrain: {
			sun: { mode: "azel", azimuthDeg: 315, elevationDeg: 45 },
			reliefRamp: "swiss",
		},
		overlay: {
			contours: {
				color: { mode: "solid", minor: "#9a6a3a", major: "#6b4423" },
				majorWidthMul: 2.0,
				casing: { on: true, color: TOPO_PAPER, alpha: 0.5 },
			},
			bands: { ramp: "swiss", shadeMin: 0.4 },
			ridges: { inner: "#4a3520", skyline: "#4a3520" },
		},
		replace: { imagery: { saturation: 0.85 }, ridges: { inner: "#4a3520" } },
		// in map: a paper sheet under a crisp, slightly warm, muted map (little aerial haze)
		world: {
			haze: 0.2,
			imagery: {
				saturation: 0.8,
				contrast: 1.06,
				brightness: 1.02,
				tint: TOPO_PAPER,
				tintAmount: 0.12,
			},
			sky: { clear: "#ece4d0", background: "#f1eadb" },
			frame: { lineColor: "#4a3520", lineOpacity: 0.95, pinColor: "#b3362b" },
		},
		labels: {
			name: { color: "#1d1d1d" },
			sub: { color: "#333333cc" },
			halo: { kind: "stroke", color: "#ffffffe6", strokePx: 3 },
			leader: { color: "#1d1d1dcc" },
			export: null,
		},
	},

	/** Dark and glowing, for dusk or astro photos. */
	night: {
		terrain: { hazeColor: "#1a2436", reliefRamp: "grey", ambient: 0.12 },
		overlay: {
			contours: {
				color: { mode: "ramp", ramp: "night" },
				casing: { on: true, color: "#000000", alpha: 0.7 },
			},
			ridges: { inner: "#7fe9ff", skyline: "#ff4fd8" },
			depthTint: { ramp: "night" },
		},
		replace: {
			imagery: {
				brightness: 0.55,
				saturation: 0.4,
				tint: "#3b5bdb",
				tintAmount: 0.25,
			},
			ridges: { inner: "#7fe9ff" },
		},
		world: {
			imagery: {
				brightness: 0.55,
				saturation: 0.4,
				tint: "#3b5bdb",
				tintAmount: 0.25,
			},
			sky: { clear: "#070b14", background: "#0b1220" },
			frame: { lineColor: "#7fe9ff" },
		},
		labels: {
			name: { color: "#bdf4ff" },
			halo: { color: "#000000" },
			leader: { color: "#7fe9ffcc" },
			export: null,
		},
	},

	/** Legibility first: small screens, print, accessibility. */
	"high-contrast": {
		overlay: {
			contours: {
				color: { mode: "solid", minor: "#ffd400", major: "#ffd400" },
				width: 2.0,
				minorAlpha: 0.7,
				majorAlpha: 1,
				casing: { on: true, color: "#000000", extraPx: 3, alpha: 0.9 },
			},
			bands: { ramp: "viridis", alpha: 0.7 },
			ridges: {
				inner: "#ffffff",
				skyline: "#ffd400",
				gain: Math.min(1, OVERLAY_RIDGE_GAIN * 1.1),
			},
		},
		replace: {
			ridges: { inner: "#ffffff", gain: Math.min(1, REPLACE_RIDGE_GAIN * 1.1) },
		},
		// in map: haze-free and punchy, a deep sky, a yellow frame and an unmissable pin
		world: {
			haze: 0.15,
			imagery: { saturation: 1.15, contrast: 1.25 },
			sky: { clear: "#5d8fc4", background: "#6a9bd0" },
			frame: {
				planeOpacity: 1,
				lineColor: "#ffd400",
				lineOpacity: 1,
				pinColor: "#ff2d2d",
				pinRadiusM: 24,
			},
		},
		trails: { width: 3 },
		labels: {
			name: { px: 14, weight: 700 },
			sub: { px: 12 },
			halo: { kind: "stroke", color: "#000000", strokePx: 3 },
			leader: { widthPx: 2 },
			export: null,
		},
	},

	/**
	 * Aerial perspective fitted to the photo's own haze (look/haze-fit on its P(sky)): distant ridges
	 * go blue and hazy as in the photo, under the photo's sun, with the analytic sky in the map.
	 */
	"photo-matched": {
		terrain: {
			sun: { mode: "photo-time" },
			atmosphere: { mode: "physical", strength: 1, airlight: "fitted" },
		},
		// the physical extinction is the full effect: no extra per-view dimming
		replace: { haze: 1 },
		world: { haze: 1, sky: { mode: "atmosphere" }, drapeHarmonize: 0.8 },
		// the blend snaps to the photo's own skyline and takes on its colour, tone and grain; warm ink
		composite: {
			refine: true,
			sky: "photo",
			harmonize: 0.8,
			ridges: "ink",
			output: "neutral",
		},
		labels: { export: null },
	},

	/**
	 * Landeskarte, the Swiss-map signature (id stays "swiss"): Imhof relief (multi-scale normals,
	 * aspect-swung light, warm/cool colour, aerial perspective) over the Alpine tint, brown Swiss
	 * contours (100 m index lines heavier, interval thinned with range), ink ridges, landeskarte
	 * hachures (rock, scree and glacier lines; they need no pack) and swisstopo label typography.
	 * Every terroir layer that needs a cover pack stays off, so it degrades to nothing without one.
	 */
	swiss: {
		terrain: {
			sun: { mode: "photo-time" },
			relief: {
				mode: "imhof",
				realism: 0.15,
				generalize: 0.6,
				curvature: 0.5,
				swing: 0.5,
				tint: 0.5,
				aerial: 0.4,
			},
			albedo: { mode: "alpine" },
		},
		overlay: {
			contours: {
				kind: "plain",
				...SWISS_CONTOURS,
			},
			// school-atlas hypsometry for the bands layer, not Classic's teal-to-magenta (review D2)
			bands: { ramp: "swiss" },
		},
		composite: {
			harmonize: 0.3,
			ridges: "ink",
			ink: {
				strength: 0.5,
				width: 0.9,
				crease: 0.2,
				...WARM_INK,
			},
		},
		labels: { ...SWISSTOPO_LABELS, export: null },
		terroir: {
			// place names stay off without a pack; switched on, they take the national-map type
			names: { typography: "swisstopo" },
			contours: { adaptive: true, swissIndex: true, inkByCover: false },
			hatch: true,
			hatchStyle: "landeskarte",
		},
	},

	/** Heinrich Berann's panoramas: saturated greens, warm rock, bright snow, half real sun, strong ridges. */
	berann: {
		terrain: {
			sun: { mode: "photo-time" },
			reliefRamp: "berann",
			rampRange: ABSOLUTE_RAMP_RANGE,
			relief: { mode: "swiss", realism: 0.55, generalize: 0.6, curvature: 0.8 },
		},
		overlay: { bands: { ramp: "berann" } },
		composite: {
			harmonize: 0.15,
			ridges: "ink",
			ink: {
				strength: 0.45,
				width: 1,
				crease: 0.35,
				...BERANN_INK,
			},
		},
		labels: { export: null },
	},

	/** A pen drawing: dark ink silhouettes and creases, ink contours, a warm paper relief for the map. */
	"topo-ink": {
		terrain: {
			reliefRamp: {
				kind: "stops",
				stops: [
					{ t: 0, c: "#f0ece3" },
					{ t: 1, c: "#f0ece3" },
				],
			},
			relief: { mode: "swiss", realism: 0, generalize: 0.6, curvature: 0.5 },
		},
		overlay: {
			contours: {
				color: { mode: "solid", minor: "#1d2330", major: "#1d2330" },
				casing: { on: false },
			},
		},
		replace: { haze: 0.5 },
		world: { haze: 0.5 },
		composite: {
			ridges: "ink",
			ink: {
				strength: 1,
				width: 1.35,
				crease: 0.6,
				inner: DARK_INK,
				skyline: DARK_INK,
			},
		},
		labels: { export: null },
	},

	/**
	 * Avalanche-slope reading: the FATMAP 30/35/40/45° classes (the slope layer, which choosing this
	 * preset switches on, PRESET_OVERLAY_LAYER) over a muted Alpine relief, with light warm ink.
	 */
	slope: {
		terrain: {
			sun: { mode: "photo-time" },
			relief: { mode: "swiss", realism: 0.2, generalize: 0.6, curvature: 0.5 },
			albedo: { mode: "alpine" },
		},
		overlay: { slope: { alpha: 0.7 } },
		replace: { haze: 0.7 },
		world: { haze: 0.7 },
		composite: { harmonize: 0.2, ridges: "ink", ink: { strength: 0.4 } },
		labels: { export: null },
	},

	/**
	 * Terroir (reports/terroir-cartography.md): the place, not the GIS. Absolute elevation (Berann
	 * ramp, keyed by the legend), warm-brown Swiss contours with a 100 m index that thin with range,
	 * land cover / names / glaciers from the region's terroir pack, prominence-tiered peaks, the sun's
	 * path, and softened marks while a pose is unverified. Every terroir layer degrades to nothing
	 * where no pack covers the photo.
	 */
	terroir: {
		terrain: {
			sun: { mode: "photo-time" },
			reliefRamp: "berann",
			rampRange: {
				mode: "absolute",
				lo: ABSOLUTE_RAMP_RANGE.lo,
				hi: ABSOLUTE_RAMP_RANGE.hi,
			},
			relief: { mode: "swiss", realism: 0.3, generalize: 0.5, curvature: 0.4 },
			albedo: { mode: "alpine" },
			atmosphere: { mode: "physical", strength: 0.8, airlight: "physical" },
		},
		overlay: {
			contours: {
				...SWISS_CONTOURS,
			},
			bands: { ramp: "berann" },
		},
		replace: { haze: 0.75 },
		world: { haze: 0.75 },
		composite: {
			ridges: "ink",
			ink: {
				strength: 0.55,
				...WARM_INK,
			},
		},
		// classic placement (upright, wrapped, above the summit) with prominence tiers reads calmer than the
		// rotated panorama layout once place names share the frame
		labels: { maxLabels: 18, export: null },
		terroir: TERROIR_LAYERS,
	},

	/**
	 * Field sketch (reports/archive/gipfelbuch-design-book.md): the Swiss field-notebook look. Terroir's warm
	 * contours, land cover and names, plus slope hatching, pencil-wobbled ink lines and pencil trails.
	 * Display only; opt-in like every look.
	 */
	"field-sketch": {
		terrain: {
			sun: { mode: "photo-time" },
			reliefRamp: "berann",
			rampRange: {
				mode: "absolute",
				lo: ABSOLUTE_RAMP_RANGE.lo,
				hi: ABSOLUTE_RAMP_RANGE.hi,
			},
			relief: {
				mode: "swiss",
				realism: 0.25,
				generalize: 0.55,
				curvature: 0.4,
			},
			albedo: { mode: "alpine" },
			atmosphere: { mode: "physical", strength: 0.7, airlight: "physical" },
		},
		overlay: {
			contours: { ...SWISS_CONTOURS, minorAlpha: 0.5, majorAlpha: 0.85 },
			bands: { ramp: "berann" },
		},
		replace: { haze: 0.7 },
		world: { haze: 0.7 },
		composite: {
			ridges: "ink",
			sketch: 0.6,
			ink: {
				strength: 0.6,
				...WARM_INK,
			},
		},
		trails: { stroke: "pencil" },
		labels: { maxLabels: 18, export: null },
		terroir: { ...TERROIR_LAYERS, hatch: true, sunPath: false },
	},
};

/** The photo-view layer (Settings.overlayStyle) a preset switches to when it is chosen. */
export const PRESET_OVERLAY_LAYER: Partial<Record<PresetId, "slope">> =
	Object.fromEntries(
		PRESET_IDS.flatMap((id) => {
			const layer = PRESET_INFO[id].overlayLayer;
			return layer ? [[id, layer]] : [];
		}),
	);

/** Map layers (Settings.mapStyle / worldStyle) a preset switches to when it is chosen. */
export const PRESET_MAP_LAYERS: Partial<
	Record<PresetId, NonNullable<PresetInfo["mapLayers"]>>
> = Object.fromEntries(
	PRESET_IDS.flatMap((id) => {
		const layers = PRESET_INFO[id].mapLayers;
		return layers ? [[id, layers]] : [];
	}),
);

/** Presets that switch on look features (LOOK_* defines, look-key.ts); the rest stay classic-compatible. */
export const LOOK_PRESETS: readonly PresetId[] = [
	"photo-matched",
	"swiss",
	"berann",
	"topo-ink",
	"slope",
	"terroir",
	"field-sketch",
];

const presetCache = new Map<PresetId, ViewStyle>();

/** CLASSIC with the preset applied (no user overrides). */
export function presetStyle(id: PresetId): ViewStyle {
	let s = presetCache.get(id);
	if (!s) {
		s = id === "classic" ? CLASSIC : mergeStyle(CLASSIC, PRESETS[id]);
		presetCache.set(id, s);
	}
	return s;
}

/** The style to render: merge(CLASSIC, PRESETS[preset], overrides), validated and clamped. */
export function resolveStyle(state: StyleState): ViewStyle {
	const base = presetStyle(isPresetId(state.preset) ? state.preset : "classic");
	const o = state.overrides;
	return o && Object.keys(o).length ? mergeStyle(base, o) : base;
}

/**
 * The state for an edited full style: overrides become the diff against the preset, so a value the
 * user set back to the preset's own is dropped (and later preset improvements reach them).
 */
export function stateFromStyle(preset: PresetId, style: ViewStyle): StyleState {
	return {
		preset,
		overrides: pruneOverrides(diffStyle(presetStyle(preset), style)),
	};
}
