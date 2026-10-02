// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Clear air: take the photo's own aerial perspective out of a photo drape before the view's haze
// goes on. A draped photo already carries the haze between the photo camera and the ground; the
// terrain shader then hazes the fragment again from the viewer, so distant ground was veiled twice
// and drifted toward the airlight. Here the drape sample is inverted along the PHOTO camera's ray
// (Koschmieder, per channel):
//   I = J·t + A·(1 − t)   ⇒   J = (I − A) / max(t, floor) + A,   t = exp(−∫β ds) from the photo eye
// with the same altitude-aware optical depth as look/atmosphere.ts (Rayleigh + Mie, exponential
// layers, curvature-corrected altitude). The model comes from, in order:
//   'fitted'      the photo's haze fit (look/haze-fit) when quality ≥ FIT_MIN_QUALITY: the photo's
//                 actual airlight and extinction, so J is the ground's own colour
//   'consistent'  the render's own haze model at overlay strength (the one tuned to look like the
//                 photo): physical atmosphere (LOOK_ATMOSPHERE) or the classic grey haze. The view
//                 then re-adds the same model from its own eye, so seen from the photo eye the drape
//                 round-trips to the photo, and from anywhere else nothing is hazed twice.
// `floor` caps the gain at 1/floor (JPEG noise on far ridges), `amount` blends J back with I.
// Display only: never on the matched photo view, never in eval / matcher renders (Tier 0/1 of
// reports/archive/geospatial-rendering-aesthetics-2026-09-30.md: the drape is a render, not the evidence).
// GLSL / WGSL: look/glsl/clear-air.ts. Both engines fill it from clearAirValues().
import { hexToLinearHaze } from "../style/color";
import type { ViewStyle } from "../style/types";
import {
	ATM_CURV,
	type AtmosphereParams,
	atmosphereValues,
	atmPath,
	FIT_MIN_QUALITY,
	type Vec3,
} from "./atmosphere";

/** Values of CLEAR_AIR_BLOCK (look/glsl/clear-air.ts). amount 0 = the identity. */
export type ClearAirValues = {
	/** Airlight the photo's haze converges to, linear (display-referred, like the photo decode). */
	airlight: Vec3;
	/** Rayleigh extinction at sea level × strength, 1/m (the classic haze: its density, grey). */
	betaR: Vec3;
	/** Scale heights (hR, hM), m. The classic haze: 1e9 (no altitude dependence). */
	h: [number, number];
	/** Mie extinction at sea level × strength, 1/m. */
	betaM: number;
	/** 0..1 blend of the corrected colour. */
	amount: number;
	/** Lowest transmittance divided by. */
	floor: number;
};

export const CLEAR_AIR_OFF: ClearAirValues = {
	airlight: [0, 0, 0],
	betaR: [0, 0, 0],
	h: [1e9, 1e9],
	betaM: 0,
	amount: 0,
	floor: 1,
};

/** Classic haze has no altitude term: an exponential layer this tall is flat over any terrain. */
const FLAT_H = 1e9;

/** The style wants the haze fit for clear air (engines fit in the world view only when this is true). */
export const wantsClearAirFit = (s: ViewStyle) =>
	s.world.clearAir.mode === "fitted" && s.world.clearAir.amount > 0;

/** Whether the world view's drape should carry clear air at all. */
export const clearAirOn = (s: ViewStyle) =>
	s.world.clearAir.mode !== "off" && s.world.clearAir.amount > 0;

/**
 * CPU mirror of look/glsl/atmosphere.ts atmPhysAirlight (constant airlight for one direction, used
 * when the physical model's airlight isn't fully fitted): single-scattered sun + sky ambient.
 */
export function physAirlight(
	p: Pick<
		AtmosphereParams,
		"betaR" | "betaM" | "sunDir" | "sunColor" | "mieG"
	> & {
		h: [number, number];
	},
	eyeAlt: number,
	viewDir: Vec3,
): Vec3 {
	const s = p.sunDir;
	const c = viewDir[0] * s[0] + viewDir[1] * s[1] + viewDir[2] * s[2];
	const eR = Math.exp(-eyeAlt / p.h[0]);
	const bR: Vec3 = [p.betaR[0] * eR, p.betaR[1] * eR, p.betaR[2] * eR];
	const bM = p.betaM * Math.exp(-eyeAlt / p.h[1]);
	const phR = 0.75 * (1 + c * c);
	const g = p.mieG;
	const g2 = g * g;
	const phM = Math.min(
		(1.5 * (1 - g2) * (1 + c * c)) /
			((2 + g2) * Math.max(1 + g2 - 2 * g * c, 1e-4) ** 1.5),
		40,
	);
	const smooth = (e0: number, e1: number, x: number) => {
		const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
		return t * t * (3 - 2 * t);
	};
	const day = smooth(-0.12, 0.25, s[2]);
	const mieFrac = bM / Math.max(bM + bR[1], 1e-9);
	const sunK = 0.42 * Math.min(Math.max(s[2] * 2 + 0.4, 0), 1);
	const skyAmb = [0.3, 0.4, 0.56];
	const grey = [0.62, 0.66, 0.7];
	const out: Vec3 = [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		const ext = Math.max(bR[i] + bM, 1e-9);
		const single = (bR[i] * phR + 0.9 * bM * phM) / ext;
		const amb =
			skyAmb[i] * (0.25 + 0.75 * day) * (1 - mieFrac) +
			grey[i] * (0.3 + 0.7 * day) * mieFrac;
		out[i] = sunK * p.sunColor[i] * single + amb;
	}
	return out;
}

/**
 * The clear-air model for the world view's photo drape.
 * @param fit      the photo's haze fit (HazeController.fit), or null
 * @param sunDir   the style's sun (deckTerrainStyle(...).sunDir)
 * @param photo    the photo eye's altitude ASL and its view direction (ENU, unit): only for the
 *                 physical airlight when the style's airlight isn't fitted
 */
export function clearAirValues(
	style: ViewStyle,
	fit: (AtmosphereParams & { quality: number }) | null | undefined,
	sunDir: Vec3,
	photo: { eyeAlt: number; dir: Vec3 },
): ClearAirValues {
	const ca = style.world.clearAir;
	if (!clearAirOn(style)) return CLEAR_AIR_OFF;
	const base = { amount: ca.amount, floor: ca.floor };
	if (ca.mode === "fitted" && fit && fit.quality >= FIT_MIN_QUALITY) {
		const k = fit.strength;
		return {
			...base,
			airlight: [...fit.airlight],
			betaR: [fit.betaR[0] * k, fit.betaR[1] * k, fit.betaR[2] * k],
			h: [fit.hR, fit.hM],
			betaM: fit.betaM * k,
		};
	}
	const t = style.terrain;
	if (t.atmosphere.mode === "physical") {
		// the overlay view's atmosphere: the model tuned to reproduce the photo
		const a = atmosphereValues(style, "overlay", sunDir, [0, 0, 0], fit);
		const k = a.strength;
		const phys =
			a.airlightMix >= 1
				? null
				: physAirlight({ ...a, h: a.h }, photo.eyeAlt, photo.dir);
		const airlight: Vec3 = phys
			? ([0, 1, 2].map(
					(i) => phys[i] + (a.airlight[i] - phys[i]) * a.airlightMix,
				) as Vec3)
			: [...a.airlight];
		return {
			...base,
			airlight,
			betaR: [a.betaR[0] * k, a.betaR[1] * k, a.betaR[2] * k],
			h: [a.h[0], a.h[1]],
			betaM: a.betaM * k,
		};
	}
	// classic haze: f = min(1 − exp(−range·density), hazeMax) toward pow(hexToLinearHaze, 2.2)
	// (deck/terrain-layer.ts haze(); overlay haze multiplier 1)
	const d = t.hazeDensity;
	const col = hexToLinearHaze(t.hazeColor).map((c) => c ** 2.2) as Vec3;
	return {
		...base,
		airlight: col,
		betaR: [d, d, d],
		h: [FLAT_H, FLAT_H],
		betaM: 0,
		// the classic veil never exceeds hazeMax, so its transmittance never drops below 1 − hazeMax
		floor: Math.max(ca.floor, 1 - t.hazeMax),
	};
}

/** CPU mirror of clearAirPhoto() (tests / exports): linear photo sample → corrected, linear. */
export function clearAirPixel(
	v: ClearAirValues,
	pc: Vec3,
	pos: Vec3,
	eye: Vec3,
): Vec3 {
	if (v.amount <= 0) return pc;
	const alt = (p: Vec3) => p[2] + (p[0] * p[0] + p[1] * p[1]) * ATM_CURV;
	const L = Math.hypot(pos[0] - eye[0], pos[1] - eye[1], pos[2] - eye[2]);
	const h0 = alt(eye);
	const h1 = alt(pos);
	const dR = atmPath(h0, h1, L, v.h[0]);
	const dM = atmPath(h0, h1, L, v.h[1]);
	const out: Vec3 = [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		const T = Math.exp(-(v.betaR[i] * dR + v.betaM * dM));
		const J = Math.min(
			Math.max(
				(pc[i] - v.airlight[i]) / Math.max(T, v.floor) + v.airlight[i],
				0,
			),
			1,
		);
		out[i] = pc[i] + (J - pc[i]) * v.amount;
	}
	return out;
}
