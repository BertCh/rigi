// PhotoWorkspace Settings (engine.ts) → the deck photo view, mirroring engine.ts renderNow():
//   terrainLookFor   → TerrainLayer props (layer pass: style, imagery, haze, contours, near fade)
//   compositeFor     → PhotoCompositor settings (composite pass uniforms, engine.ts ~:715-729)

import type { Settings } from "../settings";
import type { CompositeSettings } from "./composite";
import type { ImagerySource } from "./terrain-data";
import type { TerrainStyle } from "./terrain-layer";

export type DeckTerrainLook = {
	style: TerrainStyle;
	/** Draped imagery the style needs (null = none). */
	imagery: ImagerySource | null;
	/** The view mode the style applies (deck-apply.ts deckTerrainStyle: haze, imagery, bands). */
	mode: "overlay" | "replace";
	contourInterval: number;
	/**
	 * engine.ts uContourOpacity: overlay style "none" still renders the layer, at alpha 0, so the
	 * trails keep their terrain occlusion.
	 */
	contourOpacity: number;
	/** Contour/band fade over near terrain: overlay only (engine.ts: u.uNearFade). */
	nearFade: number;
	trails: boolean;
};

/** World view is not implemented in the deck backend: it keeps the overlay photo view. */
const photoMode = (s: Settings) =>
	s.mode === "replace" ? "replace" : "overlay";

export function terrainLookFor(s: Settings): DeckTerrainLook {
	if (photoMode(s) === "overlay")
		return {
			style:
				s.overlayStyle === "bands"
					? "elevation"
					: s.overlayStyle === "slope"
						? "slopeClass"
						: "contours",
			imagery: null,
			mode: "overlay",
			contourInterval: s.contourInterval,
			contourOpacity: s.overlayStyle === "none" ? 0 : 1,
			nearFade: s.nearFade,
			trails: s.trails,
		};
	const imagery =
		s.mapStyle === "satellite" || s.mapStyle === "topo" ? s.mapStyle : null;
	return {
		style: imagery
			? "imagery"
			: s.mapStyle === "bands"
				? "elevation"
				: "hillshade",
		imagery,
		mode: "replace",
		contourInterval: s.contourInterval,
		contourOpacity: 1,
		nearFade: 0,
		trails: s.trails,
	};
}

/** engine.ts renderNow's composite uniforms (lens v is top-down here; the shader samples uvT). */
export function compositeFor(s: Settings): CompositeSettings {
	return {
		mode: photoMode(s),
		layerOpacity: s.layerOpacity,
		ridges: s.ridges,
		depthTint: s.depthTint,
		method: s.method,
		swipe: s.swipe,
		lens: [s.lens[0], s.lens[1]],
		lensR: s.lensR,
		rangeKm: s.rangeKm,
		keepSky: s.keepSky,
		feather: s.feather,
		nearFade: s.nearFade,
		protectPeople: s.protectPeople,
	};
}
