// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Presets: each is a DeepPartial layered on CLASSIC (styling.md §2.2). Resolved style =
// merge(CLASSIC, PRESETS[preset], overrides): a preset only changes what it names, and the user's
// overrides survive a preset switch. Values other than classic are first drafts, tuned in chunk 5.
import { CLASSIC } from "./defaults";
import { ABSOLUTE_RAMP_RANGE } from "./ramps";
import { diffStyle, mergeStyle, pruneOverrides } from "./schema";
import type { DeepPartial, PresetId, StyleState, ViewStyle } from "./types";

export const PRESET_IDS: readonly PresetId[] = [
	"classic",
	"minimal",
	"topo-map",
	"night",
	"high-contrast",
	"photo-matched",
	"swiss",
	"berann",
	"topo-ink",
	"slope",
	"terroir",
	"field-sketch",
];

export const PRESET_LABELS: Record<PresetId, string> = {
	classic: "Classic",
	minimal: "Minimal",
	"topo-map": "Topo",
	night: "Night",
	"high-contrast": "High contrast",
	"photo-matched": "Photo-matched",
	swiss: "Swiss relief",
	berann: "Berann",
	"topo-ink": "Topo ink",
	slope: "Slope angle",
	terroir: "Terroir",
	"field-sketch": "Field sketch",
};

export function isPresetId(v: unknown): v is PresetId {
	return typeof v === "string" && (PRESET_IDS as readonly string[]).includes(v);
}

/** Ink colours (linear, from the former studio): dark map ink, and Swiss / Berann blue-black. */
const DARK_INK: [number, number, number] = [0.02, 0.025, 0.04];

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
				casing: { on: true, color: "#f4ecd8", alpha: 0.5 },
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
				tint: "#f4ecd8",
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
	 * Swiss cartographic relief (look/relief): multidirectional NW hillshade with Imhof contrast,
	 * a touch of the photo's sun with its cast shadows, sky-view darkening in the valleys, over the
	 * Alpine natural tint, with illuminated (Tanaka) contours on the photo.
	 */
	swiss: {
		terrain: {
			sun: { mode: "photo-time" },
			relief: { mode: "swiss", realism: 0.15, generalize: 0.6, curvature: 0.5 },
			albedo: { mode: "alpine" },
		},
		overlay: { contours: { kind: "tanaka" } },
		composite: {
			harmonize: 0.3,
			ridges: "ink",
			ink: {
				strength: 0.5,
				width: 0.9,
				crease: 0.2,
				inner: [0.08, 0.1, 0.16],
				skyline: [0.05, 0.06, 0.1],
			},
		},
		labels: { export: null },
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
				inner: [0.1, 0.12, 0.22],
				skyline: [0.08, 0.1, 0.2],
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
				color: { mode: "solid", minor: "#b98a5e", major: "#8a5a32" },
				minorAlpha: 0.55,
				majorAlpha: 0.9,
				width: 1.0,
				majorWidthMul: 1.9,
				casing: {
					on: true,
					color: [0.12, 0.08, 0.04],
					extraPx: 1.2,
					alpha: 0.35,
				},
			},
			bands: { ramp: "berann" },
		},
		replace: { haze: 0.75 },
		world: { haze: 0.75 },
		composite: {
			ridges: "ink",
			ink: {
				strength: 0.55,
				inner: [0.16, 0.11, 0.07],
				skyline: [0.1, 0.07, 0.05],
			},
		},
		// classic placement (upright, wrapped, above the summit) with prominence tiers reads calmer than the
		// rotated panorama layout once place names share the frame
		labels: { maxLabels: 18, export: null },
		terroir: {
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
		},
	},

	/**
	 * Field sketch (reports/gipfelbuch-design-book.md): the Swiss field-notebook look. Terroir's warm
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
			contours: {
				color: { mode: "solid", minor: "#b98a5e", major: "#8a5a32" },
				minorAlpha: 0.5,
				majorAlpha: 0.85,
				width: 1.0,
				majorWidthMul: 1.9,
			},
			bands: { ramp: "berann" },
		},
		replace: { haze: 0.7 },
		world: { haze: 0.7 },
		composite: {
			ridges: "ink",
			sketch: 0.6,
			ink: {
				strength: 0.6,
				inner: [0.16, 0.11, 0.07],
				skyline: [0.1, 0.07, 0.05],
			},
		},
		trails: { stroke: "pencil" },
		labels: { maxLabels: 18, export: null },
		terroir: {
			names: {
				on: true,
				reach: "near",
				language: "local+usual",
				maxLabels: 16,
			},
			peakTiers: true,
			subPill: true,
			contours: { adaptive: true, swissIndex: true, inkByCover: true },
			hatch: true,
			cover: { on: true, snow: "date", pattern: true },
			glacier: { on: true, year: 1850, style: "outline" },
			sunPath: false,
			legend: true,
			uncertainty: true,
			placeCard: true,
			furniture: true,
		},
	},
};

/** The photo-view layer (Settings.overlayStyle) a preset switches to when it is chosen. */
export const PRESET_OVERLAY_LAYER: Partial<Record<PresetId, "slope">> = {
	slope: "slope",
};

/**
 * Map layers (Settings.mapStyle / worldStyle) a preset switches to when it is chosen: the terroir land
 * cover shows on the relief rendering, not on satellite imagery. The user can still pick another one.
 */
export const PRESET_MAP_LAYERS: Partial<
	Record<PresetId, { mapStyle?: "hillshade"; worldStyle?: "hillshade" }>
> = {
	terroir: { mapStyle: "hillshade", worldStyle: "hillshade" },
	"field-sketch": { mapStyle: "hillshade", worldStyle: "hillshade" },
};

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
