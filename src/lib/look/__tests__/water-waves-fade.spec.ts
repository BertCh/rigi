// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roadmap G5: the distance fade of the animated lake waves, pinned on the JS reference of the
// shader (waterWaveTilt). Each packet's attenuation is 1 − smoothstep(0.8, 3, freq · pix) with
// pix = range · WAVE_PIXEL · WAVE_SCALE, so a packet is gone once range ≥ 3 / (freq · WAVE_PIXEL ·
// WAVE_SCALE); the longest packet (freq 2.1) sets the far cutoff (≈ 29.8 km). The live watch (motion,
// shimmer, the fade as seen from a summit) stays a browser batch item.
import { describe, expect, it } from "vitest";
import {
	WAVE_PIXEL,
	WAVE_SCALE,
	WAVE_TABLE,
	waterWaveTilt,
} from "../water/waves";

/** Range (m) beyond which a packet of this frequency contributes nothing. */
const fadeEnd = (freq: number) => 3 / (freq * WAVE_PIXEL * WAVE_SCALE);
/** Range (m) below which a packet is at full strength. */
const fadeStart = (freq: number) => 0.8 / (freq * WAVE_PIXEL * WAVE_SCALE);

const rmsTilt = (range: number) => {
	let s = 0;
	const n = 1000;
	for (let i = 0; i < n; i++) {
		const [gx, gy] = waterWaveTilt(i * 7.3, i * 3.1, i * 0.37, range);
		s += gx * gx + gy * gy;
	}
	return Math.sqrt(s / n);
};

describe("water wave distance fade (G5)", () => {
	const freqs = WAVE_TABLE.map((p) => p[1]);
	const farCutoff = fadeEnd(Math.min(...freqs));

	it("the far cutoff is set by the longest packet, near 30 km", () => {
		expect(farCutoff).toBeGreaterThan(29_000);
		expect(farCutoff).toBeLessThan(31_000);
		// the finest packet is gone within 4 km
		expect(fadeEnd(Math.max(...freqs))).toBeLessThan(4_000);
	});

	it("is at full strength up to the first packet's fade start", () => {
		const near = rmsTilt(50);
		expect(near).toBeGreaterThan(0);
		expect(rmsTilt(0.99 * fadeStart(Math.max(...freqs)))).toBe(near);
	});

	it("never grows with range", () => {
		let last = Number.POSITIVE_INFINITY;
		for (const r of [50, 1_000, 2_000, 4_000, 8_000, 10_000, 15_000, 20_000]) {
			const v = rmsTilt(r);
			expect(v).toBeLessThanOrEqual(last);
			last = v;
		}
	});

	it("is under half its near strength by 10 km", () => {
		expect(rmsTilt(10_000)).toBeLessThan(0.5 * rmsTilt(50));
		expect(rmsTilt(10_000)).toBeGreaterThan(0);
	});

	it("is exactly flat beyond the far cutoff", () => {
		for (const r of [farCutoff * 1.001, 60_000, 200_000])
			expect(rmsTilt(r)).toBe(0);
	});
});
