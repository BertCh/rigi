// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Aerial perspective for terrain renders (CPU side; the GLSL lives with the renderers): chromatic,
// altitude-aware haze that replaces the grey exponential `haze()` in materials.ts.
//   extinction  Rayleigh β_R(λ) (H_R = 8 km) + Mie β_M (H_M = 1.2 km), analytic optical depth
//               along the straight eye→fragment segment through an exponential atmosphere
//   airlight    either fitted from the photo (haze-fit.ts) or derived from the sun with the
//               Rayleigh and Cornette–Shanks phase functions plus a multiple-scatter ambient
//   sky         cheap Preetham-like gradient for render-only backgrounds, same sun and airlight
// World frame is the camera-anchored ENU frame: z is metres ASL minus the curvature drop that
// terrain.ts bakes into the vertices, so altitude = z + (x² + y²)·(1 − k)/2R.
import { EARTH_R, REFRACTION_K } from "../geodesy";
import type { Vec3 } from "../ontology/core/geometry";
import { hexToRgb01, srgbToLinear } from "../style/color";
import type { ViewStyle } from "../style/types";
import { nebelRayTransmittance } from "./nebelmeer";
import { sunColor } from "./sun";

export type { Vec3 };

export type AtmosphereParams = {
	/** Rayleigh scattering at sea level, 1/m. */
	betaR: Vec3;
	/** Mie extinction at sea level, 1/m. */
	betaM: number;
	/** Scale heights, m. */
	hR: number;
	hM: number;
	/** Airlight (horizon haze colour), linear RGB in the render's display-referred units. */
	airlight: Vec3;
	/** Unit vector toward the sun, ENU. */
	sunDir: Vec3;
	/** Linear sun colour (1 = white noon sun). */
	sunColor: Vec3;
	/** Mie asymmetry. */
	mieG: number;
	/** Overall multiplier on both extinction terms (a user haze slider). */
	strength: number;
	/** 0 = physically derived airlight, 1 = `airlight` as given (fitted). Default 1. */
	airlightMix?: number;
};

// Sea-level coefficients (Bruneton / Hillaire defaults)
export const BETA_R0: Vec3 = [5.8e-6, 13.5e-6, 33.1e-6];
export const BETA_M0 = 21e-6;
export const H_R = 8000;
export const H_M = 1200;
export const MIE_G = 0.76;
/** Altitude gained per m² of horizontal distance² (curvature + refraction baked into z). */
export const ATM_CURV = (1 - REFRACTION_K) / (2 * EARTH_R);

/**
 * ∫ρ ds / ρ(0) along a straight segment of length L from altitude h0 to h1 through an
 * exponential density with scale height H (sea-level-equivalent path length, m).
 */
export function atmPath(h0: number, h1: number, L: number, H: number) {
	const x = (h1 - h0) / H;
	const f = Math.abs(x) < 1e-3 ? 1 - 0.5 * x : (1 - Math.exp(-x)) / x;
	return Math.exp(-h0 / H) * L * f;
}

/** Altitude ASL of an ENU point (undoes the baked curvature drop). */
export function enuAltitude(x: number, y: number, z: number) {
	return z + (x * x + y * y) * ATM_CURV;
}

/** CPU mirror of atmTransmittance(): per-channel transmittance from the eye to an ENU point. */
export function transmittance(p: AtmosphereParams, eye: Vec3, pt: Vec3): Vec3 {
	const L = Math.hypot(pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]);
	const h0 = enuAltitude(eye[0], eye[1], eye[2]);
	const h1 = enuAltitude(pt[0], pt[1], pt[2]);
	const dR = atmPath(h0, h1, L, p.hR) * p.strength;
	const dM = atmPath(h0, h1, L, p.hM) * p.strength * p.betaM;
	return [
		Math.exp(-p.betaR[0] * dR - dM),
		Math.exp(-p.betaR[1] * dR - dM),
		Math.exp(-p.betaR[2] * dR - dM),
	];
}

/**
 * CPU mirror of applyNebelmeer(): the fog's transmittance from the eye to an ENU point (1 when the
 * layer is off or absent). Altitudes are curvature-corrected like atmTransmittance.
 */
export function nebelTransmittance(
	v: Pick<AtmValues, "nebel">,
	eye: Vec3,
	pt: Vec3,
): number {
	if (!v.nebel || v.nebel[1] <= 0) return 1;
	return nebelRayTransmittance(
		Math.hypot(pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]),
		enuAltitude(eye[0], eye[1], eye[2]),
		enuAltitude(pt[0], pt[1], pt[2]),
		v.nebel[1],
		v.nebel[0],
		v.nebel[2],
	);
}

/** Physical defaults for a given sun direction (airlight derived in the shader). */
export function defaultAtmosphere(
	sunDir: Vec3 = [-0.5, -0.4, 0.75],
): AtmosphereParams {
	const n = Math.hypot(sunDir[0], sunDir[1], sunDir[2]) || 1;
	const s: Vec3 = [sunDir[0] / n, sunDir[1] / n, sunDir[2] / n];
	return {
		betaR: [...BETA_R0],
		betaM: BETA_M0,
		hR: H_R,
		hM: H_M,
		airlight: [0.62, 0.7, 0.8],
		sunDir: s,
		sunColor: sunColor(s),
		mieG: MIE_G,
		strength: 1,
		airlightMix: 0,
	};
}

/** A haze fit below this quality only lends its airlight; the extinction stays physical. */
export const FIT_MIN_QUALITY = 0.5;

/** look/glsl/atmosphere.ts ATM_BLOCK's values. */
export type AtmValues = {
	eye: Vec3;
	betaR: Vec3;
	sunDir: Vec3;
	sunColor: Vec3;
	airlight: Vec3;
	h: [number, number];
	betaM: number;
	strength: number;
	mieG: number;
	airlightMix: number;
	/** Nebelmeer (look/nebelmeer): (top m, density 1/m, falloff 1/m). Density 0: off. */
	nebel?: Vec3;
	/** Nebelmeer colour, linear RGB. */
	nebelColor?: Vec3;
};

/**
 * The atmosphere for one view of a style (both engines): physical defaults for the sun, or the
 * photo's haze fit (airlight 'fitted'), with the style's strength × the view's haze multiplier
 * (replace.haze / world.haze; overlay 1), as for the classic haze density.
 */
export function atmosphereValues(
	style: ViewStyle,
	mode: "overlay" | "replace" | "world",
	sunDir: Vec3,
	eye: Vec3,
	fit?: (AtmosphereParams & { quality: number }) | null,
): AtmValues {
	const a = style.terrain.atmosphere;
	const phys = defaultAtmosphere(sunDir);
	let p = phys;
	if (a.mode === "physical" && a.airlight === "fitted" && fit)
		p =
			fit.quality >= FIT_MIN_QUALITY
				? fit
				: { ...phys, airlight: fit.airlight, airlightMix: 1 };
	const view =
		mode === "replace"
			? style.replace.haze
			: mode === "world"
				? style.world.haze
				: 1;
	// always emitted: the WebGL writers keep a missing field's last value, so off must be sent as
	// density 0 (the shader's density <= 0 early-return makes it the identity)
	const nm = a.mode === "physical" ? a.nebelmeer : undefined;
	const nebel =
		nm && nm.density > 0
			? {
					nebel: [nm.top, nm.density, nm.falloff] as Vec3,
					nebelColor: hexToRgb01(nm.color).map(srgbToLinear) as Vec3,
				}
			: {
					nebel: [nm?.top ?? 0, 0, nm?.falloff ?? 0] as Vec3,
					nebelColor: [0, 0, 0] as Vec3,
				};
	return {
		...nebel,
		eye,
		betaR: p.betaR,
		sunDir: phys.sunDir,
		sunColor: phys.sunColor,
		airlight: p.airlight,
		h: [p.hR, p.hM],
		betaM: p.betaM,
		strength: p.strength * (a.mode === "physical" ? a.strength : 1) * view,
		mieG: p.mieG,
		airlightMix: p.airlightMix ?? 1,
	};
}
