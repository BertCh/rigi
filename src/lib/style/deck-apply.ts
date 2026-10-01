// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ViewStyle → deck.gl uniform values for the deck backend (styling.md §2.6, chunk 7). The deck
// counterpart of three-apply.ts, with no three.js import: it produces plain numbers the deck layers
// (src/lib/deck/terrain-layer.ts, composite-shader.ts, trail-layer.ts, world-view.ts) put in their
// uniform blocks / layer props.
//
// Colour conventions: exactly three-apply.ts's, so a preset looks the same in both renderers.
//  - ramp stops and solid contour colours: sRGB, mixed in sRGB, then the shader applies pow(2.2);
//  - haze: what THREE.Color.set(hex) stores (sRGB → linear), then the shader's toLinear on top (the
//    legacy double linearisation, styling.md §2.3, kept on purpose in both renderers);
//  - "raw" slots (casing, ridges, hairline, band line, imagery / projection tint, trail colours):
//    float tuples pass through exactly (the classic literals were linear values), '#hex' strings
//    are converted sRGB → linear;
//  - sky, photo-frame lines and pin: displayed sRGB (three's THREE.Color → output encoding round
//    trip), i.e. the colour itself as 0..255 bytes / CSS.

import type { ViewMode } from "#/lib/settings";
import {
	type AtmosphereParams,
	type AtmValues,
	atmosphereValues,
} from "../look/atmosphere";
import { clearAirOn } from "../look/clear-air";
import { type LookDefine, terrainDefines } from "../look/look-key";
import { type RelValues, reliefValues } from "../look/relief/field";
import { type SunContext, sunDirFromStyle } from "../look/sun";
import {
	hexToLinearLikeThree,
	hexToRgb01,
	hexToRgba01,
	srgbToLinear,
	toCss,
} from "./color";
import { MAX_RAMP_STOPS, resolveRamp, turbo } from "./ramps";
import type {
	BandStyle,
	Hex,
	ImageryAdjust,
	RampRef,
	ViewStyle,
} from "./types";

export type DeckStyleMode = ViewMode;
type V3 = [number, number, number];

/** A "raw" shader colour: float tuples exact, hex strings sRGB → linear (three-apply.ts rawColor). */
export function rawColor(c: Hex): V3 {
	const [r, g, b] = hexToRgb01(c);
	return typeof c === "string"
		? [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
		: [r, g, b];
}

/** A displayed sRGB colour as deck's 0..255 RGBA (alpha from the colour × `alpha`). */
export function rgba255(c: Hex, alpha = 1): [number, number, number, number] {
	const [r, g, b, a] = hexToRgba01(c);
	const q = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
	return [q(r), q(g), q(b), q(a * alpha)];
}

// ---- ramps ---------------------------------------------------------------------------------------

/**
 * A ramp as three mat4 uniforms (deck's std140 blocks take no arrays): c0 / c1 = stops 0–3 / 4–7 as
 * columns (rgb = sRGB colour, a = t), de = columns D0–3, D4–7, E0–3, E4–7 (segment divisor and
 * smoothstep flag, as materials.ts writeRamp), n = stop count. Column-major, as luma expects.
 */
export type DeckRampU = { c0: number[]; c1: number[]; de: number[]; n: number };

export function rampU(r: RampRef): DeckRampU {
	const ramp = resolveRamp(r);
	const stops =
		ramp.kind === "turbo"
			? Array.from({ length: 8 }, (_, i) => ({
					t: i / 7,
					c: turbo(i / 7) as V3,
					smooth: false,
				}))
			: ramp.stops.map((s) => ({
					t: s.t,
					c: hexToRgb01(s.c),
					smooth: s.ease === "smooth",
				}));
	const n = Math.max(1, Math.min(MAX_RAMP_STOPS, stops.length));
	const C: number[] = [];
	const D: number[] = [];
	const E: number[] = [];
	for (let i = 0; i < MAX_RAMP_STOPS; i++) {
		const s = stops[Math.min(i, n - 1)];
		C.push(s.c[0], s.c[1], s.c[2], s.t);
		D.push(i > 0 && i < n ? stops[i].t - stops[i - 1].t || 1 : 1);
		E.push(i < n && s.smooth ? 1 : 0);
	}
	return { c0: C.slice(0, 16), c1: C.slice(16, 32), de: [...D, ...E], n };
}

// ---- terrain -------------------------------------------------------------------------------------

/** Everything the terrain shader (terrain-layer.ts) reads from the style, for one view. */
export type DeckTerrainStyle = {
	sunDir: V3;
	/** ambient, direct */
	shade: [number, number];
	/** linear, like THREE.Color(hex); the shader re-linearises it (see header) */
	hazeColor: V3;
	/** uHaze: overlay 1, replace / world from the style */
	haze: number;
	/** density, max */
	hazeParams: [number, number];
	relief: DeckRampU;
	line: DeckRampU;
	band: DeckRampU;
	contourWidth: number;
	contourMajorEvery: number;
	contourMajorMul: number;
	minorAlpha: number;
	majorAlpha: number;
	densityFade: [number, number, number, number];
	fadeNear: number;
	fadeFar: number;
	fadeFloor: number;
	contourSolid: number;
	contourMinorCol: V3;
	contourMajorCol: V3;
	/** on, extra px, minor multiplier, alpha */
	casing: [number, number, number, number];
	casingCol: V3;
	/** shadeMin, 1 - shadeMin */
	bandShade: [number, number];
	bandLineWhiten: number;
	bandLineCol: V3;
	bandAlpha: number;
	bandLineAlpha: number;
	bandGroundFade: [number, number];
	imgOn: number;
	/** saturation, brightness, contrast */
	imgAdj: V3;
	/** linear rgb + amount */
	imgTint: [number, number, number, number];
	photoTint: number;
	photoTintCol: V3;
	/** The terrain's LOOK_* defines (look-key.ts terrainDefines): the terrain program is rebuilt when they change. */
	defines: LookDefine[];
	/** ATM_BLOCK values (eye filled in at draw time), when the terrain or the world sky needs them. */
	atm: AtmValues | null;
	/** REL_BLOCK values (the field's extent filled in at draw time) under LOOK_RELIEF. */
	rel: RelValues | null;
	/** SLOPE_BLOCK alpha (the slope layer, LOOK_SLOPE) */
	slopeAlpha: number;
	/** the four slope class colours, linear */
	slopeColors: V3[];
};

const IDENTITY_IMAGERY: ImageryAdjust = {
	saturation: 1,
	brightness: 1,
	contrast: 1,
	tint: "#ffffff",
	tintAmount: 0,
};

/** three-apply.ts applyTerrainLook + applyLayerStyle(u, style, mode) + applyAtmosphereLook, as values. */
export function deckTerrainStyle(
	style: ViewStyle,
	mode: DeckStyleMode,
	ctx: SunContext = {},
	fit?: (AtmosphereParams & { quality: number }) | null,
	/** this pass draws bands: their own `lines` (if any) replace the contour line settings */
	bands = false,
): DeckTerrainStyle {
	const t = style.terrain;
	const b: BandStyle =
		mode === "replace" && style.replace.bands !== "overlay"
			? style.replace.bands
			: style.overlay.bands;
	const c0 = style.overlay.contours;
	const c =
		bands && b.lines !== "contours"
			? {
					...c0,
					width: b.lines.width,
					majorEvery: b.lines.every,
					majorWidthMul: b.lines.majorWidthMul,
					minorAlpha: b.lines.minorAlpha,
					majorAlpha: b.lines.majorAlpha,
				}
			: c0;
	const img =
		mode === "replace"
			? style.replace.imagery
			: mode === "world"
				? style.world.imagery
				: IDENTITY_IMAGERY;
	const identity =
		img.saturation === 1 &&
		img.brightness === 1 &&
		img.contrast === 1 &&
		img.tintAmount === 0;
	const tint = rawColor(img.tint);
	const solid = c.color.mode === "solid";
	const sunDir = sunDirFromStyle(t.sun, ctx);
	// the drape harmonisation only in the world view's program: on ANGLE/Metal the extra uniform block
	// costs every photo-view terrain pass (~10 ms a drag frame); a view switch rebuilds the programs
	const defines = terrainDefines(style).filter(
		(d) => d !== "LOOK_HARMONIZE" || mode === "world",
	);
	// likewise the photo's clear-air inversion (look/clear-air; never in lookKey: no composite or
	// overlay program wants it): it exists only in the world view's drape
	if (mode === "world" && clearAirOn(style)) defines.push("LOOK_CLEARAIR");
	const atm =
		defines.includes("LOOK_ATMOSPHERE") ||
		(mode === "world" && style.world.sky.mode === "atmosphere");
	return {
		sunDir,
		shade: [t.ambient, t.direct],
		hazeColor: hexToLinearLikeThree(t.hazeColor),
		haze:
			mode === "replace"
				? style.replace.haze
				: mode === "world"
					? style.world.haze
					: 1,
		hazeParams: [t.hazeDensity, t.hazeMax],
		relief: rampU(t.reliefRamp),
		line: rampU(c.color.mode === "ramp" ? c.color.ramp : "cool"),
		band: rampU(b.ramp),
		contourWidth: c.width,
		contourMajorEvery: c.majorEvery,
		contourMajorMul: c.majorWidthMul,
		minorAlpha: c.minorAlpha,
		majorAlpha: c.majorAlpha,
		densityFade: [...c.densityFade],
		fadeNear: c.distFade.near,
		fadeFar: c.distFade.far,
		fadeFloor: c.distFade.floor,
		contourSolid: solid ? 1 : 0,
		contourMinorCol:
			c.color.mode === "solid" ? hexToRgb01(c.color.minor) : [1, 1, 1],
		contourMajorCol:
			c.color.mode === "solid" ? hexToRgb01(c.color.major) : [1, 1, 1],
		casing: [
			c.casing.on ? 1 : 0,
			c.casing.extraPx,
			c.casing.minorMul,
			c.casing.alpha,
		],
		casingCol: rawColor(c.casing.color),
		bandShade: [b.shadeMin, 1 - b.shadeMin],
		bandLineWhiten: b.lineWhiten,
		bandLineCol: rawColor(b.lineColor),
		bandAlpha: b.alpha,
		bandLineAlpha: b.lineAlpha,
		bandGroundFade: [b.groundFade[0], b.groundFade[1]],
		imgOn: identity ? 0 : 1,
		imgAdj: [img.saturation, img.brightness, img.contrast],
		imgTint: [tint[0], tint[1], tint[2], img.tintAmount],
		photoTint: style.world.projectionTint.amount,
		photoTintCol: rawColor(style.world.projectionTint.color),
		defines,
		atm: atm ? atmosphereValues(style, mode, sunDir, [0, 0, 0], fit) : null,
		slopeAlpha: style.overlay.slope.alpha,
		slopeColors: style.overlay.slope.colors.map((x) => {
			const [r, g, bl] = hexToRgb01(x);
			return [r ** 2.2, g ** 2.2, bl ** 2.2] as V3;
		}),
		rel: defines.includes("LOOK_RELIEF")
			? reliefValues(style, mode === "world", sunDir)
			: null,
	};
}

/** The colour ramps' elevation range: the style's absolute range, else the data-driven local one. */
export function deckElevRange(
	style: ViewStyle,
	local: [number, number] | null,
): [number, number] | null {
	const r = style.terrain.rampRange;
	return r.mode === "absolute" ? [r.lo, Math.max(r.hi, r.lo + 1)] : local;
}

// ---- composite (overlay / replace) ---------------------------------------------------------------

/** The composite shader's style uniforms (composite-shader.ts), three-apply.ts applyCompositeStyle. */
export type DeckCompositeStyle = {
	ridgeInner: V3;
	ridgeSky: V3;
	ridgeThr: [number, number];
	ridgeGainO: number;
	ridgeInnerR: V3;
	ridgeGainR: number;
	/** rgb + alpha */
	hair: [number, number, number, number];
	/** (log near, 1 / (log far - log near)) with the GLSL compiler's float32 folding */
	depthLog: [number, number];
	depthGain: number;
	depthLuma: [number, number];
	/** 0 = turbo (analytic), 1 = depthRamp stops */
	depthRampKind: number;
	depthRamp: DeckRampU;
};

function depthLog(near: number, far: number): [number, number] {
	const f = Math.fround;
	const a = f(Math.log(near));
	return [a, f(1 / Math.max(f(f(Math.log(far)) - a), 1e-3))];
}

export function deckCompositeStyle(style: ViewStyle): DeckCompositeStyle {
	const r = style.overlay.ridges;
	const d = style.overlay.depthTint;
	const h = style.replace.hairline;
	const hc = rawColor(h.color);
	const ramp = resolveRamp(d.ramp);
	return {
		ridgeInner: rawColor(r.inner),
		ridgeSky: rawColor(r.skyline),
		ridgeThr: [r.threshold[0], r.threshold[1]],
		ridgeGainO: r.gain,
		ridgeInnerR: rawColor(style.replace.ridges.inner),
		ridgeGainR: style.replace.ridges.gain,
		hair: [hc[0], hc[1], hc[2], h.alpha * hexToRgba01(h.color)[3]],
		depthLog: depthLog(d.nearM, d.farM),
		depthGain: d.gain,
		depthLuma: [d.lumaKeep[0], d.lumaKeep[1]],
		depthRampKind: ramp.kind === "turbo" ? 0 : 1,
		depthRamp: rampU(ramp.kind === "turbo" ? "viridis" : ramp),
	};
}

// ---- trails, world -------------------------------------------------------------------------------

/** SAC scale → the four trail classes of TrailStyle.colors (engine.ts buildTrails). */
export const TRAIL_CLASSES = ["hiking", "mountain", "alpine", "other"] as const;

export function trailClass(sac: string | null | undefined): number {
	switch (sac) {
		case "hiking":
			return 0;
		case "mountain_hiking":
		case "demanding_mountain_hiking":
			return 1;
		case "alpine_hiking":
		case "demanding_alpine_hiking":
		case "difficult_alpine_hiking":
			return 2;
		default:
			return 3;
	}
}

/** Linear vertex colour per trail class (index = trailClass()). */
export function trailPalette(style: ViewStyle): V3[] {
	return TRAIL_CLASSES.map((k) => rawColor(style.trails.colors[k]));
}

export type DeckWorldStyle = {
	/** CSS colour behind the world view (three: scene.background) */
	sky: string;
	planeOpacity: number;
	lineColor: [number, number, number, number];
	pinColor: [number, number, number, number];
	pinRadiusM: number;
};

export function deckWorldStyle(style: ViewStyle): DeckWorldStyle {
	const f = style.world.frame;
	return {
		sky: toCss(style.world.sky.background),
		planeOpacity: f.planeOpacity,
		lineColor: rgba255(f.lineColor, f.lineOpacity),
		pinColor: rgba255(f.pinColor),
		pinRadiusM: f.pinRadiusM,
	};
}
