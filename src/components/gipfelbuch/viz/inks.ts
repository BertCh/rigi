// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One colour per layer. A measured layer is drawn on a photograph in a bright "photo" ink (yellow, magenta,
// cyan) and on paper (cones, equations, key text) in the darker Brezine chart kin of the same hue. Every
// figure part (photo overlays, DEM cones, the story map, math symbols, toggle dots, the Key) reads this
// table, so a swatch always matches the stroke it names. No imports: node checks can load it.

export type PhotoLayer =
	| "skyline"
	| "weight"
	| "prior"
	| "solved"
	| "peaks"
	| "priorPeaks"
	| "sky";

export type InkSurface = "photo" | "paper";

export interface LayerInk {
	/** What the layer is called in toggles and keys. */
	label: string;
	/** Ink on a photograph. */
	photo: string;
	/** Ink on paper: a token with a hex fallback (Ascher code in the comment). */
	paper: string;
	/** The hex fallback of `paper`, for code that mixes colours (a CSS var cannot be mixed in JS). */
	paperHex: string;
	/** Dash pattern in px at photo scale (undefined = solid); scale with `dashFor`. */
	dash?: readonly [number, number];
}

export const LAYER_INKS: Record<PhotoLayer, LayerInk> = {
	skyline: {
		label: "skyline in photo",
		photo: "#f0a30a",
		paper: "var(--gb-contour, #95500c)", // NB
		paperHex: "#95500c",
	},
	weight: {
		label: "trace confidence",
		photo: "#f0a30a",
		paper: "var(--gb-contour, #95500c)", // NB
		paperHex: "#95500c",
	},
	prior: {
		label: "horizon at phone's guess",
		photo: "#e0207f",
		paper: "#ab343a", // RM
		paperHex: "#ab343a",
		dash: [6, 5],
	},
	solved: {
		label: "horizon at solved pose",
		photo: "#0aa5bd",
		paper: "var(--gb-water, #30626b)", // GL
		paperHex: "#30626b",
	},
	peaks: {
		label: "peaks at solved pose",
		photo: "var(--gb-ink, #131313)",
		paper: "var(--gb-ink, #131313)",
		paperHex: "#131313",
	},
	priorPeaks: {
		label: "peaks at phone's guess",
		photo: "#e0207f",
		paper: "#ab343a", // RM
		paperHex: "#ab343a",
	},
	sky: {
		label: "sky mask",
		photo: "#7aa7ff",
		paper: "var(--gb-navy, #002f55)",
		paperHex: "#002f55",
	},
};

/** The ink of `layer` on a photograph or on paper. */
export const inkFor = (layer: PhotoLayer, surface: InkSurface): string =>
	LAYER_INKS[layer][surface];

/** The layer's dash pattern as an SVG `stroke-dasharray`, scaled by `k` (undefined for a solid layer). */
export const dashFor = (layer: PhotoLayer, k = 1): string | undefined => {
	const dash = LAYER_INKS[layer].dash;
	return dash
		? `${+(dash[0] * k).toFixed(2)} ${+(dash[1] * k).toFixed(2)}`
		: undefined;
};

/** True when `key` names a layer. */
export const isPhotoLayer = (key: unknown): key is PhotoLayer =>
	typeof key === "string" && Object.hasOwn(LAYER_INKS, key);

/** The first layer whose photo or paper ink is exactly `color` (so a Key given a raw colour finds its layer). */
export function layerOfColor(color: string): PhotoLayer | undefined {
	return (Object.keys(LAYER_INKS) as PhotoLayer[]).find(
		(layer) =>
			LAYER_INKS[layer].photo === color || LAYER_INKS[layer].paper === color,
	);
}

/** Layer to {label, color (photo ink)}: the shape the toggles and older figures use. */
export const LAYER_STYLE: Record<PhotoLayer, { label: string; color: string }> =
	Object.fromEntries(
		(Object.keys(LAYER_INKS) as PhotoLayer[]).map((layer) => [
			layer,
			{ label: LAYER_INKS[layer].label, color: LAYER_INKS[layer].photo },
		]),
	) as Record<PhotoLayer, { label: string; color: string }>;
