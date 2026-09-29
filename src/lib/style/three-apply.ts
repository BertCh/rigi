// ViewStyle → three.js uniforms / materials for the PhotoEngine (styling.md §2.3, chunk 3).
// Only this adapter knows both the style types and the shader's uniform names. Every write is a
// `.value` update: no geometry rebuilds (engine.ts recompiles only when the look's LOOK_* set changes). The geometry pass (uStyle == 3)
// reads none of these uniforms, so styling can never change what align.ts / sampleAt see.
//
// Colour conventions (each slot mirrors how its classic constant was used, so CLASSIC stays exact):
//  - ramp stops and solid contour colours: sRGB, mixed in sRGB, then the shader applies pow(2.2);
//  - THREE.Color slots (haze, sky, frame, pin): sRGB, linearised by THREE.Color. The haze then gets
//    the shader's toLinear on top: the legacy double linearisation (§2.3), kept on purpose;
//  - "raw" shader slots (casing, ridges, hairline, band line, projection / imagery tint, trail vertex
//    colours): the classic literals were used as-is in linear space, so a float tuple is passed
//    through exactly, while a '#hex' string (what the UI and presets write) is converted sRGB → linear.
import * as THREE from "three";
import { type RampStopsU, writeRamp } from "../materials";
import {
	type AtmosphereParams,
	type Vec3,
	atmosphereValues,
} from "../look/atmosphere";
import { ATM_BLOCK } from "../look/glsl/atmosphere";
import { SLOPE_BLOCK } from "../look/glsl/ramps";
import { REL_BLOCK } from "../look/glsl/relief";
import { type ReliefField, reliefValues } from "../look/relief/field";
import { type SunContext, sunDirFromStyle } from "../look/sun";
import { hexToRgb01, hexToRgba01, srgbToLinear } from "./color";
import { RAMPS, resolveRamp, turbo } from "./ramps";
import type {
	BandStyle,
	Hex,
	ImageryAdjust,
	RampRef,
	TerrainLook,
	ViewStyle,
} from "./types";

type U = Record<string, THREE.IUniform>;
export type StyleMode = "overlay" | "replace" | "world";

/** A "raw" shader colour: float tuples exact, hex strings sRGB → linear. */
export function rawColor(c: Hex): [number, number, number] {
	const [r, g, b] = hexToRgb01(c);
	return typeof c === "string"
		? [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
		: [r, g, b];
}

/** Set a THREE.Color from an sRGB style colour (a '#hex' goes through Color.set, exactly as `new Color(0xhex)`). */
export function setColor(col: THREE.Color, c: Hex) {
	if (typeof c === "string") col.set(c.slice(0, 7));
	else col.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
	return col;
}

/** Ramp → uniform stops. Turbo (analytic) becomes 8 evenly spaced samples for the terrain ramps. */
export function rampStops(r: RampRef): RampStopsU {
	const ramp = resolveRamp(r);
	if (ramp.kind === "turbo")
		return Array.from({ length: 8 }, (_, i) => ({ t: i / 7, c: turbo(i / 7) }));
	return ramp.stops.map((s) => ({
		t: s.t,
		c: hexToRgb01(s.c),
		smooth: s.ease === "smooth",
	}));
}

const set3 = (v: THREE.Vector3, c: [number, number, number]) =>
	v.set(c[0], c[1], c[2]);

// ---- terrain look (shared by every view) ----------------------------------------------------------

/**
 * Sun, shading, relief ramp and haze. `localRange` is the engine's data-driven elevation range
 * (engine.ts init); `rampRange: absolute` replaces it.
 */
export function applyTerrainLook(
	u: U,
	look: TerrainLook,
	ctx: SunContext & { localRange?: [number, number] } = {},
) {
	(u.uSunDir.value as THREE.Vector3).set(...sunDirFromStyle(look.sun, ctx));
	u.uShadeAmbient.value = look.ambient;
	u.uShadeDirect.value = look.direct;
	writeRamp(u, "uReliefRamp", rampStops(look.reliefRamp));
	const range =
		look.rampRange.mode === "absolute"
			? [look.rampRange.lo, Math.max(look.rampRange.hi, look.rampRange.lo + 1)]
			: ctx.localRange;
	if (range) (u.uElevRange.value as THREE.Vector2).set(range[0], range[1]);
	setColor(u.uHazeColor.value as THREE.Color, look.hazeColor);
	u.uHazeDensity.value = look.hazeDensity;
	u.uHazeMax.value = look.hazeMax;
}

/** The physical atmosphere (LOOK_ATMOSPHERE, world sky) for one view, seen from `eye` (ENU). */
export function applyAtmosphereLook(
	u: U,
	style: ViewStyle,
	mode: StyleMode,
	eye: Vec3,
	ctx: SunContext,
	fit?: (AtmosphereParams & { quality: number }) | null,
) {
	ATM_BLOCK.write(
		u,
		atmosphereValues(
			style,
			mode,
			sunDirFromStyle(style.terrain.sun, ctx),
			eye,
			fit,
		),
	);
}

/** The Swiss relief (LOOK_RELIEF) for one view: block values, plus the field's textures when it is new. */
export function applyReliefLook(
	u: U,
	style: ViewStyle,
	mode: StyleMode,
	field: ReliefField | null,
) {
	const v = reliefValues(
		style,
		mode === "world",
		(u.uSunDir.value as THREE.Vector3).toArray(),
		field?.extent,
	);
	if (v) REL_BLOCK.write(u, v);
	if (!field || u.reliefField.value.userData?.field === field) return;
	for (const [k, data] of [
		["reliefField", field.field],
		["reliefGen", field.gen],
	] as const) {
		const t = new THREE.DataTexture(data, field.res, field.res);
		t.minFilter = t.magFilter = THREE.LinearFilter;
		t.userData.field = field;
		t.needsUpdate = true;
		(u[k].value as THREE.Texture).dispose();
		u[k].value = t;
	}
}

/** The slope layer's alpha and class colours (LOOK_SLOPE). */
export function applySlopeLook(u: U, style: ViewStyle) {
	const [c0, c1, c2, c3] = slopeColors(style);
	SLOPE_BLOCK.write(u, { alpha: style.overlay.slope.alpha, c0, c1, c2, c3 });
}

/** overlay.slope.colors, linearised as the shader's former rampSrgb (pow 2.2). */
export function slopeColors(style: ViewStyle): [number, number, number][] {
	return style.overlay.slope.colors.map((c) => {
		const [r, g, b] = hexToRgb01(c);
		return [r ** 2.2, g ** 2.2, b ** 2.2] as [number, number, number];
	});
}

// ---- per-view layer style (set before each layer pass) ------------------------------------------

const IDENTITY_IMAGERY: ImageryAdjust = {
	saturation: 1,
	brightness: 1,
	contrast: 1,
	tint: "#ffffff",
	tintAmount: 0,
};

function applyImagery(u: U, a: ImageryAdjust) {
	const identity =
		a.saturation === 1 &&
		a.brightness === 1 &&
		a.contrast === 1 &&
		a.tintAmount === 0;
	u.uImgOn.value = identity ? 0 : 1;
	u.uImgSat.value = a.saturation;
	u.uImgBright.value = a.brightness;
	u.uImgContrast.value = a.contrast;
	const t = rawColor(a.tint);
	(u.uImgTint.value as THREE.Vector4).set(t[0], t[1], t[2], a.tintAmount);
}

/** The band style one view draws: replace may have its own. */
export function bandStyleFor(style: ViewStyle, mode: StyleMode): BandStyle {
	return mode === "replace" && style.replace.bands !== "overlay"
		? style.replace.bands
		: style.overlay.bands;
}

function applyBands(u: U, b: BandStyle) {
	writeRamp(u, "uBandRamp", rampStops(b.ramp));
	(u.uBandShade.value as THREE.Vector2).set(b.shadeMin, 1 - b.shadeMin);
	u.uBandLineWhiten.value = b.lineWhiten;
	set3(u.uBandLineCol.value as THREE.Vector3, rawColor(b.lineColor));
	u.uBandAlpha.value = b.alpha;
	u.uBandLineAlpha.value = b.lineAlpha;
	(u.uBandGroundFade.value as THREE.Vector2).set(
		b.groundFade[0],
		b.groundFade[1],
	);
}

/**
 * Contours, bands, haze, imagery adjust and the projection tint for one view. The contour style
 * also drives the band boundaries (same code path), unless the bands give their own `lines` and
 * this pass draws bands (`bands`).
 */
export function applyLayerStyle(
	u: U,
	style: ViewStyle,
	mode: StyleMode,
	bands = false,
) {
	const c = style.overlay.contours;
	const band = bandStyleFor(style, mode);
	const bl = bands && band.lines !== "contours" ? band.lines : null;
	u.uContourMajorEvery.value = bl ? bl.every : c.majorEvery;
	u.uContourWidth.value = bl ? bl.width : c.width;
	u.uContourMajorMul.value = bl ? bl.majorWidthMul : c.majorWidthMul;
	u.uMinorAlpha.value = bl ? bl.minorAlpha : c.minorAlpha;
	u.uMajorAlpha.value = bl ? bl.majorAlpha : c.majorAlpha;
	(u.uDensityFade.value as THREE.Vector4).set(
		c.densityFade[0],
		c.densityFade[1],
		c.densityFade[2],
		c.densityFade[3],
	);
	u.uContourFadeNear.value = c.distFade.near;
	u.uContourFadeFar.value = c.distFade.far;
	u.uFadeFloor.value = c.distFade.floor;
	if (c.color.mode === "solid") {
		u.uContourSolid.value = 1;
		set3(u.uContourMinorCol.value as THREE.Vector3, hexToRgb01(c.color.minor));
		set3(u.uContourMajorCol.value as THREE.Vector3, hexToRgb01(c.color.major));
	} else {
		u.uContourSolid.value = 0;
		writeRamp(u, "uLineRamp", rampStops(c.color.ramp));
	}
	(u.uCasing.value as THREE.Vector4).set(
		c.casing.on ? 1 : 0,
		c.casing.extraPx,
		c.casing.minorMul,
		c.casing.alpha,
	);
	set3(u.uCasingCol.value as THREE.Vector3, rawColor(c.casing.color));

	applyBands(u, band);

	// overlay: 1 is the classic value (no visible effect: contours and bands never call haze())
	u.uHaze.value =
		mode === "replace"
			? style.replace.haze
			: mode === "world"
				? style.world.haze
				: 1;
	applyImagery(
		u,
		mode === "replace"
			? style.replace.imagery
			: mode === "world"
				? style.world.imagery
				: IDENTITY_IMAGERY,
	);
	u.uPhotoTint.value = style.world.projectionTint.amount;
	set3(
		u.uPhotoTintCol.value as THREE.Vector3,
		rawColor(style.world.projectionTint.color),
	);
}

// ---- composite (overlay / replace) --------------------------------------------------------------

/** Uniforms the engine's composite shader declares for the style (defaults = the classic literals). */
export function makeCompositeStyleUniforms(): U {
	const u: U = {
		uRidgeInner: { value: new THREE.Vector3(1, 0.95, 0.85) },
		uRidgeSky: { value: new THREE.Vector3(1, 0.45, 0.25) },
		uRidgeThr: { value: new THREE.Vector2(0.12, 0.45) },
		uRidgeGainO: { value: 0.9 },
		uRidgeInnerR: { value: new THREE.Vector3(1, 0.95, 0.85) },
		uRidgeGainR: { value: 0.5 },
		uHairCol: { value: new THREE.Vector3(1, 1, 1) },
		uHairAlpha: { value: 0.6 },
		/** (log near, 1 / (log far - log near)), see depthLog() */
		uDepthLog: { value: new THREE.Vector2(...depthLog(200, 80000)) },
		uDepthGain: { value: 0.75 },
		uDepthLuma: { value: new THREE.Vector2(0.35, 0.65) },
		/** 0 = turbo (analytic), 1 = the uDepthRamp stops */
		uDepthRampKind: { value: 0 },
		uDepthRampC: {
			value: Array.from({ length: 8 }, () => new THREE.Vector3()),
		},
		uDepthRampT: { value: new Array<number>(8).fill(0) },
		uDepthRampD: { value: new Array<number>(8).fill(1) },
		uDepthRampE: { value: new Array<number>(8).fill(0) },
		uDepthRampN: { value: 1 },
	};
	writeRamp(u, "uDepthRamp", rampStops(RAMPS.viridis));
	return u;
}

/**
 * The classic shader had log(200.0) and log(80000.0) - log(200.0) as constants, which the GLSL
 * compiler folds in float32 (logf, then a float subtraction). Mirror that rounding so the
 * uniforms carry the same floats.
 */
function depthLog(near: number, far: number): [number, number] {
	const f = Math.fround;
	const a = f(Math.log(near));
	// y is the reciprocal: the compiler turned the division by the folded constant into a multiply
	return [a, f(1 / Math.max(f(f(Math.log(far)) - a), 1e-3))];
}

export function applyCompositeStyle(cu: U, style: ViewStyle) {
	const r = style.overlay.ridges;
	set3(cu.uRidgeInner.value as THREE.Vector3, rawColor(r.inner));
	set3(cu.uRidgeSky.value as THREE.Vector3, rawColor(r.skyline));
	(cu.uRidgeThr.value as THREE.Vector2).set(r.threshold[0], r.threshold[1]);
	cu.uRidgeGainO.value = r.gain;
	set3(
		cu.uRidgeInnerR.value as THREE.Vector3,
		rawColor(style.replace.ridges.inner),
	);
	cu.uRidgeGainR.value = style.replace.ridges.gain;
	set3(
		cu.uHairCol.value as THREE.Vector3,
		rawColor(style.replace.hairline.color),
	);
	cu.uHairAlpha.value =
		style.replace.hairline.alpha * hexToRgba01(style.replace.hairline.color)[3];
	const d = style.overlay.depthTint;
	(cu.uDepthLog.value as THREE.Vector2).set(...depthLog(d.nearM, d.farM));
	cu.uDepthGain.value = d.gain;
	(cu.uDepthLuma.value as THREE.Vector2).set(d.lumaKeep[0], d.lumaKeep[1]);
	const ramp = resolveRamp(d.ramp);
	cu.uDepthRampKind.value = ramp.kind === "turbo" ? 0 : 1;
	if (ramp.kind !== "turbo") writeRamp(cu, "uDepthRamp", rampStops(ramp));
}

// ---- world view, trails --------------------------------------------------------------------------

export function trailColor(
	style: ViewStyle,
	sac: string | null | undefined,
): [number, number, number] {
	const c = style.trails.colors;
	switch (sac) {
		case "hiking":
			return rawColor(c.hiking);
		case "mountain_hiking":
		case "demanding_mountain_hiking":
			return rawColor(c.mountain);
		case "alpine_hiking":
		case "demanding_alpine_hiking":
		case "difficult_alpine_hiking":
			return rawColor(c.alpine);
		default:
			return rawColor(c.other);
	}
}
