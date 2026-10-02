// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom } from "../../../test/helpers";
import { projectPoint } from "../../camera";
import { DEG, EARTH_R, REFRACTION_K } from "../../geodesy";
import { computeHorizonFast } from "../../horizon-fast/march";
import {
	columnElevation,
	columnProfile,
	enuToApparent,
	hitEnu,
	makeRayScene,
	pixelDirection,
	rayCastFrame,
	traceRay,
} from "../cpu";
import { syntheticMosaic } from "./synthetic";

const EYE = { lat: 46.7, lon: 8.0 };
const C = (1 - REFRACTION_K) / (2 * EARTH_R);

describe("flat plane", () => {
	it("horizon dips by the curvature + refraction angle", () => {
		const h0 = 300;
		const mosaics = [syntheticMosaic(EYE, 9, 82_000, () => 0, 80_000)];
		const S = makeRayScene(mosaics, { ...EYE, h: h0 }, { maxDistance: 80_000 });
		// max over d of t = -h0/d - c d  =>  t = -2 sqrt(h0 c) at d = sqrt(h0 / c) (66 km < 80 km)
		const expected = Math.atan(-2 * Math.sqrt(h0 * C)) / DEG;
		for (const az of [0, 90, 211.3]) {
			expect(columnElevation(S, az)).toBeCloseTo(expected, 3);
		}
		// the 1-D march agrees on the same mosaics
		const hf = computeHorizonFast(
			mosaics,
			{ ...EYE, h: h0 },
			{ step: 90, maxDistance: 80_000, noRidges: true },
		);
		expect(hf.elevation[1]).toBeCloseTo(expected, 3);
	});

	it("a downward ray hits the plane at the ground distance of the curved ray", () => {
		const h0 = 100;
		const mosaics = [syntheticMosaic(EYE, 11, 22_000, () => 0, 20_000)];
		const S = makeRayScene(mosaics, { ...EYE, h: h0 });
		const s = -0.05;
		// h0 + s d + c d^2 = 0  =>  smaller root
		const d = (-s - Math.sqrt(s * s - 4 * C * h0)) / (2 * C);
		expect(traceRay(S, 0, 1, s)).toBe(true);
		expect(S.hitD).toBeCloseTo(d, 0);
		expect(S.hitH).toBeCloseTo(0, 3);
		// a ray above the horizon never hits
		expect(traceRay(S, 0, 1, 0.01)).toBe(false);
	});
});

describe("single cone", () => {
	const apex = 6000;
	const radius = 3000;
	const ground = 1000;
	const peak = 1000;
	const cone = (dist: number, bearing: number) => {
		// apex at bearing 0 (north)
		const e = dist * Math.sin(bearing * DEG);
		const n = dist * Math.cos(bearing * DEG);
		const r = Math.hypot(e, n - apex);
		return ground + peak * Math.max(0, 1 - r / radius);
	};
	const mosaics = [syntheticMosaic(EYE, 13, 9_000, cone)];
	const S = makeRayScene(mosaics, { ...EYE, h: 1100 });

	it("hit distance on the near flank", () => {
		const dHit = 4500; // 1500 m before the apex: h = 1500
		const s = (1500 - 1100) / dHit - C * dHit;
		expect(traceRay(S, 0, 1, s)).toBe(true);
		expect(Math.abs(S.hitD - dHit)).toBeLessThan(6);
		expect(S.hitH).toBeCloseTo(1500, -1);
	});

	it("misses over the apex and hits just under it", () => {
		const sApex = (2000 - 1100) / apex - C * apex;
		expect(traceRay(S, 0, 1, sApex + 0.01)).toBe(false);
		expect(traceRay(S, 0, 1, sApex - 0.01)).toBe(true);
	});

	it("column horizon is the apex elevation", () => {
		const sApex = (2000 - 1100) / apex - C * apex;
		// the apex is one pixel sample: ~1 m low
		expect(
			Math.abs(columnElevation(S, 0) - Math.atan(sApex) / DEG),
		).toBeLessThan(0.02);
	});
});

/** Smooth random cosines plus per-pixel noise, so the max mips matter. */
function randomField(seed: number) {
	const rand = seededRandom(seed);
	const waves = Array.from({ length: 6 }, () => ({
		kx: (2 * Math.PI) / (300 + rand() * 7000),
		ky: (2 * Math.PI) / (300 + rand() * 7000),
		ph: rand() * 2 * Math.PI,
		amp: 100 + rand() * 300,
	}));
	return (dist: number, bearing: number) => {
		const e = dist * Math.sin(bearing * DEG);
		const n = dist * Math.cos(bearing * DEG);
		let h = 900;
		for (const w of waves) h += w.amp * Math.cos(w.kx * e + w.ky * n + w.ph);
		// deterministic hash noise, +-12 m
		const q = Math.sin(e * 12.9898 + n * 78.233) * 43758.5453;
		return h + (q - Math.floor(q) - 0.5) * 24;
	};
}

describe("max-mip skipping", () => {
	const mosaics = [
		syntheticMosaic(EYE, 11, 22_000, randomField(12345), 20_000),
	];
	const eye = { ...EYE, h: 1000 };
	const fast = makeRayScene(mosaics, eye, { maxDistance: 20_000 });
	const brute = makeRayScene(mosaics, eye, {
		maxDistance: 20_000,
		mipSkip: false,
	});

	it("gives exactly the brute-force result on the same lattice", () => {
		const rand = seededRandom(7);
		let hits = 0;
		for (let i = 0; i < 300; i++) {
			const az = rand() * 360 * DEG;
			const s = -0.12 + rand() * 0.3;
			const a = traceRay(fast, Math.sin(az), Math.cos(az), s);
			const b = traceRay(brute, Math.sin(az), Math.cos(az), s);
			expect(a).toBe(b);
			if (a) {
				hits++;
				expect(fast.hitD).toBe(brute.hitD);
				expect(fast.hitH).toBe(brute.hitH);
			}
		}
		expect(hits).toBeGreaterThan(60);
		expect(hits).toBeLessThan(295);
		expect(fast.skips).toBeGreaterThan(0);
		expect(fast.samples).toBeLessThan(brute.samples / 2);
	});

	it("column horizon: same with and without skipping, and near the 1-D march", () => {
		const az = [0, 33.3, 120.1, 250.7, 301.9];
		const hf = computeHorizonFast(mosaics, eye, {
			step: 0.1,
			maxDistance: 20_000,
			noRidges: true,
		});
		for (const a of az) {
			const e1 = columnElevation(fast, a);
			expect(e1).toBe(columnElevation(brute, a));
			expect(Math.abs(e1 - hf.elevation[Math.round(a / 0.1)])).toBeLessThan(
				0.05,
			);
		}
		const prof = columnProfile(fast, 90);
		expect(prof.elevation.length).toBe(4);
	});
});

describe("xyz reprojection", () => {
	it("hit points land on their own pixel", () => {
		const mosaics = [syntheticMosaic(EYE, 11, 22_000, randomField(99), 20_000)];
		const S = makeRayScene(
			mosaics,
			{ ...EYE, h: 1000 },
			{ maxDistance: 20_000 },
		);
		const cam = {
			pose: { yaw: 40, pitch: -4, roll: 3, vfov: 30 },
			width: 96,
			height: 72,
		};
		const frame = rayCastFrame(S, cam, 4);
		const aspect = cam.width / cam.height;
		let checked = 0;
		let worst = 0;
		for (let j = 0; j < frame.height; j++)
			for (let i = 0; i < frame.width; i++) {
				const k = j * frame.width + i;
				if (frame.sky[k]) continue;
				const e = frame.enu[3 * k];
				const n = frame.enu[3 * k + 1];
				const u = frame.enu[3 * k + 2];
				const app = enuToApparent(S, e, n, u);
				const rho = 1000;
				const pt = [app.sinA * rho, app.cosA * rho, app.slope * rho];
				const p = projectPoint(cam.pose, aspect, [0, 0, 0], pt);
				expect(p).not.toBeNull();
				if (!p) continue;
				const px = p.u * cam.width - 0.5;
				const py = p.v * cam.height - 0.5;
				worst = Math.max(
					worst,
					Math.abs(px - (i * 4 + 2)),
					Math.abs(py - (j * 4 + 2)),
				);
				checked++;
			}
		expect(checked).toBeGreaterThan(50);
		expect(worst).toBeLessThan(0.02);
	});

	it("hitEnu and enuToApparent invert each other", () => {
		const mosaics = [syntheticMosaic(EYE, 11, 22_000, () => 500, 20_000)];
		const S = makeRayScene(mosaics, { ...EYE, h: 900 });
		const az = 70 * DEG;
		const p = hitEnu(S, Math.sin(az), Math.cos(az), 12_345, 650);
		const a = enuToApparent(S, p[0], p[1], p[2]);
		expect(a.d).toBeCloseTo(12_345, 4);
		expect(a.h).toBeCloseTo(650, 4);
		expect(a.sinA).toBeCloseTo(Math.sin(az), 12);
	});

	it("pixel directions are unit and follow the pose", () => {
		const cam = {
			pose: { yaw: 90, pitch: 0, roll: 0, vfov: 40 },
			width: 100,
			height: 100,
		};
		const d = pixelDirection(cam, 49.5, 49.5);
		expect(d[0]).toBeCloseTo(1, 9); // east
		expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
	});
});
