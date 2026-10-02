// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The in-browser relative-rotation estimator (features mocked, images stubbed): service-equivalent
// outputs on a synthetic pure-rotation pair, caching, and the error strings that replace HTTP errors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expSO3, rotationDistanceDeg } from "#/lib/pose6dof";
import { seededRandom } from "#/test/helpers";
import {
	bearingsOf,
	type FeatureBackend,
	type Features,
	focalOf,
	type Matches,
	relRot,
	relRotAvailable,
	relRotFromFeatures,
	setFeatureBackend,
} from "../estimator";

const W = 1024;
const H = 768;

/** Keypoints of a pure-rotation pair: B sees R·d for every direction d A sees; the first nOut matches are wrong. */
function pair(
	R: Float64Array,
	vfovA: number,
	vfovB: number,
	n: number,
	nOut: number,
) {
	const rnd = seededRandom(17);
	const fA = focalOf(vfovA, H);
	const fB = focalOf(vfovB, H);
	const ka: number[] = [];
	const kb: number[] = [];
	while (ka.length < n * 2) {
		const u = rnd() * W;
		const v = rnd() * H;
		const d = [(u + 0.5 - W / 2) / fA, (v + 0.5 - H / 2) / fA, 1];
		const q = [0, 1, 2].map(
			(r) => R[r * 3] * d[0] + R[r * 3 + 1] * d[1] + R[r * 3 + 2] * d[2],
		);
		if (q[2] <= 0) continue;
		const ub = (q[0] / q[2]) * fB + W / 2 - 0.5;
		const vb = (q[1] / q[2]) * fB + H / 2 - 0.5;
		if (ub < 0 || ub >= W || vb < 0 || vb >= H) continue;
		ka.push(u, v);
		kb.push(ub + (rnd() - 0.5) * 0.6, vb + (rnd() - 0.5) * 0.6);
	}
	for (let i = 0; i < nOut; i++) {
		kb[i * 2] = rnd() * W;
		kb[i * 2 + 1] = rnd() * H;
	}
	const fa: Features = {
		width: W,
		height: H,
		keypoints: Float32Array.from(ka),
		count: n,
	};
	const fb: Features = {
		width: W,
		height: H,
		keypoints: Float32Array.from(kb),
		count: n,
	};
	const id = Uint32Array.from({ length: n }, (_, i) => i);
	const m: Matches = { indices0: id, indices1: id, count: n };
	return { fa, fb, m };
}

describe("relRotFromFeatures", () => {
	it("recovers the relative rotation, with the service's evidence fields", async () => {
		const R = expSO3(0.02, -0.25, 0.01);
		const { fa, fb, m } = pair(R, 50, 55, 300, 90);
		const out = await relRotFromFeatures(fa, fb, m, m, 50, 55, { gpu: "off" });
		expect(out.method).toBe("rot");
		expect(out.n).toBe(300);
		expect(rotationDistanceDeg(out.relR ?? [], R)).toBeLessThan(0.05);
		expect(out.inliers).toBeGreaterThanOrEqual(205);
		expect(out.inliers).toBeLessThanOrEqual(212);
		expect(out.rmsPx ?? 9).toBeLessThan(1);
		expect(out.bwd?.inliers).toBeGreaterThan(200);
		expect(out.fwdBwdDeg ?? 9).toBeLessThan(0.05);
		expect(out.sizeA).toEqual([W, H]);
		expect(out.sizeB).toEqual([W, H]);
	});
	it("gives no rotation (and no fwd/bwd) below 3 matches", async () => {
		const { fa, fb } = pair(expSO3(0, 0.1, 0), 50, 50, 10, 0);
		const two: Matches = {
			indices0: Uint32Array.of(0, 1),
			indices1: Uint32Array.of(0, 1),
			count: 2,
		};
		const out = await relRotFromFeatures(fa, fb, two, two, 50, 50, {
			gpu: "off",
		});
		expect(out.relR).toBeNull();
		expect(out.inliers).toBe(0);
		expect(out.bwd).toBeNull();
		expect(out.fwdBwdDeg).toBeNull();
	});
	it("bearings are unit vectors through the pixel centre (+0.5, rot_ransac)", () => {
		const f: Features = {
			width: 4,
			height: 2,
			keypoints: Float32Array.of(1.5, 0.5),
			count: 1,
		};
		const b = bearingsOf(f, Uint32Array.of(0), 1, 90);
		expect(Array.from(b)).toEqual([0, 0, 1]);
	});
});

describe("relRot (images stubbed, backend mocked)", () => {
	const R = expSO3(0.01, 0.3, -0.02);
	const { fa, fb, m } = pair(R, 48, 52, 200, 40);
	let extract: ReturnType<typeof vi.fn>;
	let match: ReturnType<typeof vi.fn>;
	let available: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		extract = vi.fn(async (bmp: { src: string }) =>
			bmp.src === "a.jpg" ? fa : fb,
		);
		match = vi.fn(async () => m);
		available = vi.fn(async () => true);
		setFeatureBackend({
			available,
			extract,
			match,
		} as unknown as FeatureBackend);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (src: string) => ({
				ok: src !== "missing.jpg",
				status: 404,
				blob: async () => src,
			})),
		);
		vi.stubGlobal(
			"createImageBitmap",
			vi.fn(async (src: string) => ({
				src,
				width: W,
				height: H,
				close: () => {},
			})),
		);
	});
	afterEach(() => setFeatureBackend(null));

	it("runs features → fwd + bwd matches → rotation, and caches features and results", async () => {
		const r = await relRot(
			{ src: "a.jpg", vfov: 48 },
			{ src: "b.jpg", vfov: 52 },
		);
		if (typeof r === "string") throw new Error(r);
		expect(rotationDistanceDeg(r.relR ?? [], R)).toBeLessThan(0.05);
		expect(match).toHaveBeenCalledTimes(2);
		expect(extract).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ maxKeypoints: 2048, longSide: 1024 }),
		);
		const again = await relRot(
			{ src: "a.jpg", vfov: 48 },
			{ src: "b.jpg", vfov: 52 },
		);
		expect(again).toBe(r);
		await relRot({ src: "a.jpg", vfov: 48 }, { src: "b.jpg", vfov: 53 });
		expect(extract).toHaveBeenCalledTimes(2);
	});
	it("returns messages instead of throwing", async () => {
		expect(
			await relRot({ src: "a.jpg", vfov: 200 }, { src: "b.jpg", vfov: 50 }),
		).toBe("vfov out of range");
		expect(
			await relRot(
				{ src: "missing.jpg", vfov: 50 },
				{ src: "b.jpg", vfov: 50 },
			),
		).toBe("estimator failed (image 404)");
		const ac = new AbortController();
		ac.abort();
		match.mockRejectedValueOnce(new Error("aborted by caller"));
		expect(
			await relRot(
				{ src: "a.jpg", vfov: 40 },
				{ src: "b.jpg", vfov: 50 },
				ac.signal,
			),
		).toBe("aborted");
	});
	it("availability = the feature models load; a failure is cached briefly", async () => {
		expect(await relRotAvailable(true)).toBe(true);
		available.mockResolvedValue(false);
		expect(await relRotAvailable()).toBe(true); // cached success
		expect(await relRotAvailable(true)).toBe(false);
		available.mockRejectedValue(new Error("no weights"));
		expect(await relRotAvailable(true)).toBe(false);
	});
});
