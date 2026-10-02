// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { sampleGrid } from "#/lib/dem";
import { seededRandom, uniform } from "#/test/helpers";
import {
	finishHeights,
	type HeightPlan,
	heightGatherCounters,
	planHeights,
	replayHeights,
	type SlotOf,
	texelWord,
} from "../height-gather";

const S = 4;
const ramp = Float32Array.from({ length: S * S }, (_, i) => i * 3.5);

type FakeTile = { size: number; heights?: Float32Array; id: string };
const cpuTile: FakeTile = { size: S, heights: ramp, id: "cpu" };
const lazyTile: FakeTile = { size: S, id: "lazy" };

// one fake point per (lat): lat 0 → null, 1 → cpu tile, 2.. → lazy tile at (px, py) = (lat, 1.25)
const fakeSet = (
	resolve: (lat: number) => FakeTile | null,
	truth: (lat: number) => number | null,
) =>
	({
		locate(
			lat: number,
			_lon: number,
			out: { tile: unknown; px: number; py: number },
		) {
			const tile = resolve(lat);
			if (!tile) return null;
			out.tile = tile;
			out.px = Math.min(lat, S);
			out.py = 1.25;
			return out;
		},
		heightAt: (lat: number) => truth(lat),
	}) as never;

describe("texelWord", () => {
	it("packs x | y<<9 | layer<<18 | big<<30", () => {
		expect(texelWord({ layer: 0, big: false }, 0, 0)).toBe(0);
		expect(texelWord({ layer: 3, big: false }, 5, 7)).toBe(
			(3 << 18) | (7 << 9) | 5,
		);
		expect(texelWord({ layer: 1, big: true }, 511, 511)).toBe(
			(1 << 30) | (1 << 18) | (511 << 9) | 511,
		);
	});
	it("unpacks back to the fields", () => {
		const w = texelWord({ layer: 1234, big: true }, 300, 450);
		expect(w & 0x1ff).toBe(300);
		expect((w >> 9) & 0x1ff).toBe(450);
		expect((w >> 18) & 0xfff).toBe(1234);
		expect((w >> 30) & 1).toBe(1);
	});
});

describe("planHeights", () => {
	const slotOf: SlotOf = (t) =>
		(t as FakeTile).id === "lazy" ? { layer: 5, big: false } : null;
	it("answers CPU tiles and misses at once, plans lazy tiles as four texels", () => {
		const before = { ...heightGatherCounters };
		const set = fakeSet(
			(lat) => (lat === 0 ? null : lat === 1 ? cpuTile : lazyTile),
			() => null,
		);
		const p = planHeights(set, [0, 1, 2], [0, 0, 0], slotOf);
		expect(p.out[0]).toBeNaN();
		expect(p.out[1]).toBe(sampleGrid(ramp, S, 1, 1.25));
		expect(p.idx).toEqual([2]);
		expect(p.words.length).toBe(4);
		// px 2, py 1.25 → x = 1.5, y = 0.75 → x0 1, x1 2, y0 0, y1 1
		const slot = { layer: 5, big: false };
		expect(p.words).toEqual([
			texelWord(slot, 1, 0),
			texelWord(slot, 2, 0),
			texelWord(slot, 1, 1),
			texelWord(slot, 2, 1),
		]);
		expect(p.fx[0]).toBeCloseTo(0.5, 12);
		expect(p.fy[0]).toBeCloseTo(0.75 - 0, 12);
		expect(heightGatherCounters.nullSamples - before.nullSamples).toBe(1);
		expect(heightGatherCounters.cpuSamples - before.cpuSamples).toBe(1);
		expect(heightGatherCounters.samples - before.samples).toBe(3);
	});
	it("falls back to heightAt-equivalent CPU sampling for a lazy tile with no slot", () => {
		const tile: FakeTile = {
			size: S,
			id: "lazy2",
			// biome-ignore lint/suspicious/noExplicitAny: minimal lazy source stub
			lazyHeights: { materialize: () => ramp } as any,
		} as FakeTile;
		const set = fakeSet(
			() => tile,
			() => null,
		);
		const p = planHeights(set, [2], [0], null);
		expect(p.idx).toEqual([]);
		expect(p.out[0]).toBe(sampleGrid(ramp, S, 2, 1.25));
	});
});

describe("finishHeights", () => {
	const slot = { layer: 5, big: false };
	const mkPlan = (heightAt: (lat: number) => number | null): HeightPlan => {
		const set = fakeSet(() => lazyTile, heightAt);
		const p = planHeights(set, [2], [0], () => slot);
		return p;
	};
	const bitsFor = (nonce: number, h: [number, number, number, number]) => {
		const b = new Uint32Array(8);
		const f = new Float32Array(b.buffer);
		for (let k = 0; k < 4; k++) {
			b[2 * k] = nonce;
			f[2 * k + 1] = h[k];
		}
		return b;
	};
	it("blends the four gathered heights when the certificate holds", () => {
		const p = mkPlan(() => -1);
		const out = finishHeights(p, bitsFor(7, [0, 10, 20, 30]), 0, 7, () => slot);
		// fx 0.5, fy 0.75: a = 5, b = 25, → 5 * 0.25 + 25 * 0.75
		expect(out[0]).toBeCloseTo(20, 5);
	});
	it("falls back to heightAt on a nonce mismatch or a moved slot", () => {
		const p = mkPlan(() => 42);
		const before = heightGatherCounters.certificateMisses;
		expect(
			finishHeights(p, bitsFor(8, [0, 10, 20, 30]), 0, 7, () => slot)[0],
		).toBe(42);
		expect(
			finishHeights(p, bitsFor(7, [0, 10, 20, 30]), 0, 7, () => ({
				layer: 6,
				big: false,
			}))[0],
		).toBe(42);
		expect(finishHeights(p, bitsFor(7, [0, 10, 20, 30]), 0, 7, null)[0]).toBe(
			42,
		);
		expect(heightGatherCounters.certificateMisses - before).toBe(3);
	});
	it("a failed gather (null bits) uses heightAt without counting a miss; null heightAt is NaN", () => {
		const p = mkPlan(() => null);
		const before = heightGatherCounters.certificateMisses;
		expect(finishHeights(p, null, 0, 7, () => slot)[0]).toBeNaN();
		expect(heightGatherCounters.certificateMisses).toBe(before);
	});
});

describe("replayHeights", () => {
	const rand = seededRandom(9);
	const field = (lat: number, lon: number) => Math.round(lat * 10 + lon);
	const body = (h: (lat: number, lon: number) => number | null) => {
		let sum = 0;
		for (let i = 0; i < 5; i++) sum += h(i, i * 2) ?? -100;
		return sum;
	};
	it("runs once to record, once to answer, synchronously for a sync lookup", () => {
		const asked: [number, number][] = [];
		const r = replayHeights(body, (lats, lons) => {
			for (let i = 0; i < lats.length; i++) asked.push([lats[i], lons[i]]);
			return Float64Array.from(lats, (la, i) => field(la, lons[i]));
		});
		expect(asked.length).toBe(5);
		expect(r).toBe(body(field));
	});
	it("maps NaN to null and supports async lookups", async () => {
		const r = replayHeights(body, (lats) =>
			Promise.resolve(Float64Array.from(lats, () => Number.NaN)),
		);
		expect(r).toBeInstanceOf(Promise);
		expect(await r).toBe(-500);
	});
	it("throws when the call order depends on the values", () => {
		let n = 0;
		const unstable = (h: (a: number, b: number) => number | null) => {
			n++;
			return h(n === 1 ? 1 : 2, 0);
		};
		expect(() => replayHeights(unstable, () => new Float64Array([0]))).toThrow(
			/call order changed/,
		);
	});
	it("uses the seeded generator for a larger random body", () => {
		const pts = Array.from({ length: 30 }, () => [
			uniform(rand, 0, 1),
			uniform(rand, 0, 1),
		]);
		const fn = (h: (a: number, b: number) => number | null) =>
			pts.map(([a, b]) => h(a, b));
		const out = replayHeights(fn, (lats, lons) =>
			Float64Array.from(lats, (la, i) => la + lons[i]),
		);
		expect(out).toEqual(pts.map(([a, b]) => a + b));
	});
});
