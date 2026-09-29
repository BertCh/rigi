// The roll map's basemap presets: what the terrain under the drapes looks like. The muted / dark
// ones exist so the draped photos stand out: same satellite tiles, desaturated and dimmed through
// the terrain shader's imagery adjust (ViewStyle ImageryAdjust, LOOK imgAdj).
import type { ImagerySource } from "#/lib/deck/terrain-data";
import type { TerrainStyle } from "#/lib/deck/terrain-layer";
import { deckTerrainStyle, rawColor } from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import type { ImageryAdjust } from "#/lib/style/types";

export type RollBasemap = "satellite" | "muted" | "dark" | "topo" | "relief";

export const ROLL_BASEMAPS: { value: RollBasemap; label: string }[] = [
	{ value: "satellite", label: "Satellite" },
	{ value: "muted", label: "Muted" },
	{ value: "dark", label: "Dark" },
	{ value: "topo", label: "Topo" },
	{ value: "relief", label: "Relief" },
];

const ADJUST: Partial<Record<RollBasemap, ImageryAdjust>> = {
	muted: {
		saturation: 0.3,
		brightness: 0.85,
		contrast: 0.85,
		tint: "#ffffff",
		tintAmount: 0,
	},
	dark: {
		saturation: 0,
		brightness: 0.45,
		contrast: 1.1,
		tint: "#8fa3c0",
		tintAmount: 0.25,
	},
};

/** Imagery tiles to fetch (null = none: DEM shading only). */
export function basemapSource(b: RollBasemap): ImagerySource | null {
	return b === "relief" ? null : b === "topo" ? "topo" : "satellite";
}

/** The TerrainLayer style + look for a basemap (overlay mode: haze 1, as before). */
export function basemapLook(b: RollBasemap): {
	style: TerrainStyle;
	look: ReturnType<typeof deckTerrainStyle>;
} {
	const look = deckTerrainStyle(CLASSIC, "overlay");
	const adj = ADJUST[b];
	return {
		style: basemapSource(b) ? "imagery" : "hillshade",
		look: adj
			? {
					...look,
					imgOn: 1,
					imgAdj: [adj.saturation, adj.brightness, adj.contrast],
					imgTint: [...rawColor(adj.tint), adj.tintAmount],
				}
			: look,
	};
}
