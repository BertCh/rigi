// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { floatToHalf } from "#/lib/nn/safetensors";
import {
	CACHE_FORMAT,
	clearDepthCache,
	type DepthCacheBackend,
	type DepthWithFit,
	decodeDepthRecord,
	depthCacheKey,
	encodeDepthRecord,
	evictLru,
	getCachedDepth,
	OCT_MAX_ANGLE_DEG,
	octDecode,
	octEncode,
	packRecord,
	putCachedDepth,
	unpackRecord,
} from "../depth-cache";

function fakeBackend(): DepthCacheBackend & { map: Map<string, Uint8Array> } {
	const map = new Map<string, Uint8Array>();
	return {
		map,
		get: async (k) => map.get(k) ?? null,
		put: async (k, b) => void map.set(k, b.slice()),
		delete: async (k) => void map.delete(k),
		keys: async () => [...map.keys()],
	};
}

/** A smooth ramp-like scene: depth 2..40 m, a sky strip (invalid), unit normals from a tilted plane. */
function syntheticDepth(w = 64, h = 48, seed = 1): DepthWithFit {
	const n = w * h;
	const depth = new Float32Array(n);
	const valid = new Uint8Array(n);
	const normal = new Float32Array(3 * n);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const k = y * w + x;
			if (y < 6) continue; // sky
			depth[k] = 2 + (y / h) * 30 + 0.01 * seed * x;
			valid[k] = 1;
			const a = 0.3 + 0.002 * x;
			normal[3 * k] = Math.sin(a) * 0.5;
			normal[3 * k + 1] = -0.5;
			normal[3 * k + 2] = -Math.cos(a);
			const l = Math.hypot(normal[3 * k], normal[3 * k + 1], normal[3 * k + 2]);
			for (let c = 0; c < 3; c++) normal[3 * k + c] /= l;
		}
	return {
		width: w,
		height: h,
		depth,
		valid,
		normal,
		intrinsicsNorm: { fx: 1.1, fy: 1.2, cx: 0.5, cy: 0.49 },
		model: "moge-2-vits-normal",
		seconds: 1.5,
		focal: 0.83,
		shift: 0.07,
	};
}

const angleDeg = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	(Math.acos(
		Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])),
	) *
		180) /
	Math.PI;

describe("octahedral normals (2 x int8)", () => {
	it("stays within OCT_MAX_ANGLE_DEG over the sphere (measured)", () => {
		let worst = 0;
		const out = [0, 0, 0];
		const code = [0, 0];
		for (let i = 0; i < 60000; i++) {
			// Fibonacci sphere
			const z = 1 - (2 * (i + 0.5)) / 60000;
			const r = Math.sqrt(1 - z * z);
			const t = i * 2.399963229728653;
			const v = [r * Math.cos(t), r * Math.sin(t), z];
			octEncode(v[0], v[1], v[2], code);
			octDecode(code[0], code[1], out);
			worst = Math.max(worst, angleDeg(v, out));
		}
		console.info(`oct int8 max angle error ${worst.toFixed(3)} deg`);
		expect(worst).toBeLessThanOrEqual(OCT_MAX_ANGLE_DEG);
	});

	it("keeps the zero vector as 'no normal'", () => {
		const code = [0, 0];
		octEncode(0, 0, 0, code);
		const out = [9, 9, 9];
		octDecode(code[0], code[1], out);
		expect(out).toEqual([0, 0, 0]);
	});
});

describe("depth record", () => {
	it("round-trips depth (<= 1e-3 relative), valid exactly, normals within the bound, metadata exactly", () => {
		const d = syntheticDepth();
		const back = decodeDepthRecord(encodeDepthRecord(d));
		if (!back) throw new Error("decode failed");
		expect(back.width).toBe(d.width);
		expect(back.height).toBe(d.height);
		expect(back.valid).toEqual(d.valid);
		expect(back.model).toBe(d.model);
		expect(back.seconds).toBe(d.seconds);
		expect(back.focal).toBe(d.focal);
		expect(back.shift).toBe(d.shift);
		expect(back.intrinsicsNorm).toEqual(d.intrinsicsNorm);
		let worstRel = 0;
		let worstAngle = 0;
		for (let k = 0; k < d.depth.length; k++) {
			if (!d.valid[k]) {
				expect(back.depth[k]).toBe(0);
				continue;
			}
			worstRel = Math.max(
				worstRel,
				Math.abs(back.depth[k] - d.depth[k]) / d.depth[k],
			);
			worstAngle = Math.max(
				worstAngle,
				angleDeg(
					d.normal?.subarray(3 * k, 3 * k + 3) ?? [],
					back.normal?.subarray(3 * k, 3 * k + 3) ?? [],
				),
			);
		}
		expect(worstRel).toBeLessThanOrEqual(1e-3);
		expect(worstAngle).toBeLessThanOrEqual(OCT_MAX_ANGLE_DEG);
	});

	it("keeps invalid / NaN depth at 0, a missing normal missing, and zero normals zero", () => {
		const d = syntheticDepth(8, 8);
		d.depth[10] = Number.NaN;
		d.valid[10] = 0;
		d.normal?.fill(0, 30, 33);
		const back = decodeDepthRecord(encodeDepthRecord(d));
		expect(back?.depth[10]).toBe(0);
		expect(Array.from(back?.normal?.subarray(30, 33) ?? [])).toEqual([0, 0, 0]);
		const { normal: _n, ...bare } = d;
		const noNormal = decodeDepthRecord(encodeDepthRecord(bare));
		expect(noNormal?.normal).toBeUndefined();
		const { intrinsicsNorm: _k, ...noK } = d;
		expect(
			decodeDepthRecord(encodeDepthRecord(noK))?.intrinsicsNorm,
		).toBeUndefined();
	});

	it("rejects short, truncated, padded and wrong-format records", () => {
		const rec = encodeDepthRecord(syntheticDepth(8, 8));
		expect(decodeDepthRecord(new Uint8Array(0))).toBeNull();
		expect(decodeDepthRecord(rec.subarray(0, 5))).toBeNull();
		expect(decodeDepthRecord(rec.subarray(0, rec.length - 1))).toBeNull();
		expect(decodeDepthRecord(new Uint8Array([...rec, 0]))).toBeNull();
		const wrong = rec.slice();
		wrong[3] = CACHE_FORMAT + 1;
		expect(decodeDepthRecord(wrong)).toBeNull();
		expect(decodeDepthRecord(rec.map(() => 7))).toBeNull();
	});

	it("f16 conversion matches the reference on the depth range", () => {
		expect(floatToHalf(1)).toBe(0x3c00);
		expect(floatToHalf(-2)).toBe(0xc000);
	});

	it("gzip shrinks a smooth depth by well over 10% (measured) and round-trips; garbage unpacks to null", async () => {
		const rec = encodeDepthRecord(syntheticDepth(256, 192));
		const packed = await packRecord(rec);
		console.info(
			`record ${rec.length} B -> packed ${packed.length} B (${((100 * packed.length) / rec.length).toFixed(1)}%)`,
		);
		expect(packed[0]).toBe(1);
		expect(packed.length).toBeLessThan(rec.length * 0.9);
		expect(await unpackRecord(packed)).toEqual(rec);
		expect(await unpackRecord(new Uint8Array([1, 9, 9, 9]))).toBeNull();
		expect(await unpackRecord(new Uint8Array([5, 1, 2]))).toBeNull();
		// incompressible bytes stay raw
		const noise = new Uint8Array(4096);
		let s = 12345;
		for (let i = 0; i < noise.length; i++) {
			s = (s * 1664525 + 1013904223) >>> 0;
			noise[i] = s >>> 24;
		}
		const p2 = await packRecord(noise);
		expect(p2[0]).toBe(0);
		expect(await unpackRecord(p2)).toEqual(noise);
	});
});

describe("depthCacheKey", () => {
	const parts = { weights: "a.safetensors", size: 1024, tokens: 1200 };
	const blob = (...b: number[]) => new Blob([new Uint8Array(b)]);

	it("is a stable sha-256 hex that changes with content, weights variant, size and tokens", async () => {
		const k = await depthCacheKey(blob(1, 2, 3), parts);
		expect(k).toMatch(/^[0-9a-f]{64}$/);
		expect(await depthCacheKey(blob(1, 2, 3), { ...parts })).toBe(k);
		const others = await Promise.all([
			depthCacheKey(blob(1, 2, 4), parts),
			depthCacheKey(blob(1, 2, 3), { ...parts, weights: "b.safetensors" }),
			depthCacheKey(blob(1, 2, 3), { ...parts, size: 512 }),
			depthCacheKey(blob(1, 2, 3), { ...parts, tokens: 2000 }),
		]);
		expect(new Set([k, ...others]).size).toBe(5);
	});
});

describe("evictLru", () => {
	const e = (key: string, bytes: number, lastUsed: number) => ({
		key,
		bytes,
		lastUsed,
	});
	it("drops the oldest first until the rest fits, never the kept key", () => {
		const idx = [e("a", 40, 3), e("b", 40, 1), e("c", 40, 2)];
		expect(evictLru(idx, 100)).toEqual(["b"]);
		expect(evictLru(idx, 50)).toEqual(["b", "c"]);
		expect(evictLru(idx, 50, "b")).toEqual(["c", "a"]);
		expect(evictLru(idx, 200)).toEqual([]);
	});
});

describe("storage", () => {
	it("get returns what put stored; unknown keys miss", async () => {
		const backend = fakeBackend();
		const d = syntheticDepth(16, 16);
		await putCachedDepth("k1", d, { backend });
		const got = await getCachedDepth("k1", { backend });
		expect(got?.valid).toEqual(d.valid);
		expect(got?.focal).toBe(d.focal);
		expect(await getCachedDepth("nope", { backend })).toBeNull();
	});

	it("evicts least recently used records beyond the byte budget; a get touches", async () => {
		const backend = fakeBackend();
		const d = syntheticDepth(16, 16);
		const size = (await packRecord(encodeDepthRecord(d))).length;
		const budget = size * 2 + 10; // room for two records
		await putCachedDepth("a", d, { backend, budget });
		await putCachedDepth("b", d, { backend, budget });
		expect(await getCachedDepth("a", { backend, budget })).not.toBeNull(); // touch a
		await new Promise((r) => setTimeout(r, 0));
		await putCachedDepth("c", d, { backend, budget });
		expect(await getCachedDepth("b", { backend })).toBeNull(); // b was oldest
		expect(backend.map.has("b")).toBe(false);
		expect(backend.map.has("a")).toBe(true);
		expect(backend.map.has("c")).toBe(true);
		const index = JSON.parse(
			new TextDecoder().decode(backend.map.get("__index__")),
		) as Array<{ key: string; bytes: number }>;
		expect(index.map((x) => x.key).sort()).toEqual(["a", "c"]);
		expect(index.reduce((s, x) => s + x.bytes, 0)).toBeLessThanOrEqual(budget);
	});

	it("does not store a record larger than the whole budget", async () => {
		const backend = fakeBackend();
		await putCachedDepth("big", syntheticDepth(32, 32), {
			backend,
			budget: 10,
		});
		expect(backend.map.size).toBe(0);
	});

	it("a corrupt record is a miss and is dropped", async () => {
		const backend = fakeBackend();
		await putCachedDepth("k", syntheticDepth(8, 8), { backend });
		backend.map.set("k", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
		expect(await getCachedDepth("k", { backend })).toBeNull();
		await new Promise((r) => setTimeout(r, 0));
		expect(backend.map.has("k")).toBe(false);
	});

	it("clearDepthCache removes everything", async () => {
		const backend = fakeBackend();
		await putCachedDepth("k", syntheticDepth(8, 8), { backend });
		await clearDepthCache({ backend });
		expect(backend.map.size).toBe(0);
	});

	it("a throwing backend (and no backend) never throws and misses", async () => {
		const boom = async () => {
			throw new Error("quota");
		};
		const backend: DepthCacheBackend = {
			get: boom,
			put: boom,
			delete: boom,
			keys: boom,
		};
		const d = syntheticDepth(8, 8);
		await expect(putCachedDepth("k", d, { backend })).resolves.toBeUndefined();
		await expect(getCachedDepth("k", { backend })).resolves.toBeNull();
		await expect(clearDepthCache({ backend })).resolves.toBeUndefined();
		await expect(
			putCachedDepth("k", d, { backend: null }),
		).resolves.toBeUndefined();
		await expect(getCachedDepth("k", { backend: null })).resolves.toBeNull();
	});
});
