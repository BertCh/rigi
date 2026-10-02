// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Glowing summit markers (style.labels.glow, default off): the shared, GPU-free half. Both engines
// draw additive point sprites with luma's `pointGlow` shader module (@luma.gl/shadertools, #3321)
// at the labelled peaks, after the composite: deck/glow-layer.ts (GLSL) and
// deck-webgpu/layers/glow.ts (WGSL). The labelled peaks come from the same engine.peakLabels the
// DOM labels use, so the glow sits on the dot of every label. Display-only: nothing here feeds the
// pose, confidence, measurements or exports.
import { hexToRgb01, srgbToLinear } from "../../style/color";
import type { LabelGlow } from "../../style/types";

/** A dusk / night glow: warm lamp-light tint over the label dots. Spread into `style.labels.glow`. */
export const GLOW_DEFAULT: LabelGlow = {
	radiusPx: 22,
	tint: "#ffd9a0",
	intensity: 1,
	coreRadius: 0.12,
	coreIntensity: 1,
	haloIntensity: 0.6,
	falloff: 5,
};

/** What an engine needs: sprite centres in normalised photo coordinates (u right, v down). */
export type GlowMarkers = {
	/** u, v per marker (2 floats). */
	points: Float32Array;
	look: LabelGlow;
};

/** Floats per marker instance on the GPU: u, v. */
export const GLOW_STRIDE = 2;

/** The peaks of a label list as glow markers; null when the glow is off or nothing is labelled. */
export function glowMarkersFor(
	labels: readonly { u: number; v: number }[],
	glow: LabelGlow | null | undefined,
): GlowMarkers | null {
	if (!glow || glow.intensity <= 0 || glow.radiusPx <= 0 || !labels.length)
		return null;
	const points = new Float32Array(labels.length * GLOW_STRIDE);
	labels.forEach((l, i) => {
		points[i * GLOW_STRIDE] = l.u;
		points[i * GLOW_STRIDE + 1] = l.v;
	});
	return { points, look: glow };
}

/** True when two marker sets draw the same pixels (so a no-op frame skips the upload). */
export function sameGlowMarkers(
	a: GlowMarkers | null,
	b: GlowMarkers | null,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.points.length !== b.points.length) return false;
	if (JSON.stringify(a.look) !== JSON.stringify(b.look)) return false;
	for (let i = 0; i < a.points.length; i++)
		if (a.points[i] !== b.points[i]) return false;
	return true;
}

/** The uniform values of the sprite shaders: tint in linear rgb, and the pointGlow module props. */
export function glowUniformsOf(look: LabelGlow) {
	const [r, g, b] = hexToRgb01(look.tint);
	return {
		tint: [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)] as [
			number,
			number,
			number,
		],
		radiusPx: look.radiusPx,
		intensity: look.intensity,
		pointGlow: {
			coreRadius: look.coreRadius,
			coreIntensity: look.coreIntensity,
			haloIntensity: look.haloIntensity,
			falloff: look.falloff,
		},
	};
}
