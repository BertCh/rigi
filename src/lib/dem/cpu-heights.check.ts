// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/dem/cpu-heights.check.ts
// Node check of the lazy CPU heights view (WAG W2.4, dem/cpu-heights.ts) and the plumbing that moved
// with it. Every comparison is bit for bit:
//  1. getCpuHeights: an eager tile returns its own array; a lazy one materialises once, keeps the
//     result, releases its source; a tile with neither throws;
//  2. heightStats == the scans it replaces (buildBatchGrid's lo / hi, localElevRange's every 7th
//     sample), copied verbatim from before the change;
//  3. buildBatchGrid(heights) == buildBatchGrid(heightStats) (base grid, sphere, every field);
//     buildLiteMesh of a lazy raster == of the eager one, without materialising it;
//  4. downsampleHeights2 / downsampleSteps / fitStreamTile == the streamer's old inline loop;
//  5. TerrainSet.heightAt / localMax and localElevRange on lazy tiles == on eager tiles; the colour
//     ramp range never materialises a lazy tile (it reads heightStats).
import { buildBatchGrid, buildLiteMesh } from "#/lib/deck/batched-terrain-grid";
import { localElevRange } from "#/lib/deck/scene";
import { TerrainSet, type TileMesh } from "#/lib/deck/terrain-data";
import { fitStreamTile } from "#/lib/deck/terrain-stream";
import { EnuFrame } from "#/lib/geodesy";
import {
	cpuHeightsCounters,
	getCpuHeights,
	hasCpuHeights,
	heightStats,
} from "./cpu-heights";
import { downsampleHeights2, downsampleSteps } from "./grid";
import type { DemRaster } from "./load";
import { latToTileY, lonToTileX, type TileKey } from "./tiles";

let failures = 0;
const check = (name: string, ok: boolean, info = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` ${info}` : ""}`);
};

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Terrarium-like heights: multiples of 1/256, a smooth relief plus noise, some sea and cliffs. */
function heightsOf(S: number, seed: number) {
	const r = rng(seed);
	const h = new Float32Array(S * S);
	const base = 400 + r() * 2000;
	for (let y = 0; y < S; y++)
		for (let x = 0; x < S; x++) {
			const v =
				base +
				900 * Math.sin((x / S) * 5 + seed) * Math.cos((y / S) * 3) +
				40 * (r() - 0.5) +
				(x > S * 0.7 && y < S * 0.2 ? 1500 : 0);
			h[y * S + x] = Math.max(0, Math.round(v * 256) / 256);
		}
	return h;
}

const sameBits = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	if (a.length !== b.length) return false;
	const fa = Float32Array.from(a);
	const fb = Float32Array.from(b);
	const ua = new Uint32Array(fa.buffer);
	const ub = new Uint32Array(fb.buffer);
	for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
	return true;
};
const sameNum = (a: number, b: number) => Object.is(a, b);

// ---------------- 1. getCpuHeights ----------------
{
	const h = heightsOf(64, 1);
	const eager = { heights: h };
	check("eager tile returns its own array", getCpuHeights(eager) === h);
	let made = 0;
	let released = 0;
	const lazy: Parameters<typeof getCpuHeights>[0] = {
		lazyHeights: {
			materialize: () => {
				made++;
				return h;
			},
			release: () => {
				released++;
			},
		},
	};
	const before = cpuHeightsCounters.materialized;
	check("lazy tile has no CPU heights yet", !hasCpuHeights(lazy));
	const a = getCpuHeights(lazy);
	const b = getCpuHeights(lazy);
	check(
		"lazy tile materialises once, keeps it, releases its source",
		a === h &&
			b === h &&
			made === 1 &&
			released === 1 &&
			lazy.heights === h &&
			lazy.lazyHeights === undefined &&
			cpuHeightsCounters.materialized === before + 1,
	);
	let threw = false;
	try {
		getCpuHeights({});
	} catch {
		threw = true;
	}
	check("a tile with neither heights nor a source throws", threw);
}

// ---------------- 2. heightStats == the inline scans it replaces ----------------
{
	let bad = 0;
	for (let seed = 0; seed < 40; seed++) {
		const S = [64, 128, 256, 257, 512][seed % 5];
		const h = heightsOf(S, seed);
		if (seed % 7 === 3) h.fill(1234.5); // flat tile
		// buildBatchGrid before W2.4
		let lo = Number.POSITIVE_INFINITY;
		let hi = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < h.length; i++) {
			const v = h[i];
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		// localElevRange before W2.4 (one tile)
		let lo7 = Number.POSITIVE_INFINITY;
		let hi7 = Number.NEGATIVE_INFINITY;
		for (let i = 0; i < h.length; i += 7) {
			if (h[i] < lo7) lo7 = h[i];
			if (h[i] > hi7) hi7 = h[i];
		}
		const s = heightStats(h);
		if (
			!sameNum(s.lo, lo) ||
			!sameNum(s.hi, hi) ||
			!sameNum(s.lo7, lo7) ||
			!sameNum(s.hi7, hi7)
		)
			bad++;
	}
	check(
		"heightStats == buildBatchGrid / localElevRange scans (40 tiles)",
		!bad,
	);
}

// ---------------- 3. batch grid from stats ----------------
const frame = new EnuFrame(46.7107, 7.7713, 1950);
function keyAt(lat: number, lon: number, z: number): TileKey {
	return {
		z,
		x: Math.floor(lonToTileX(lon, z)),
		y: Math.floor(latToTileY(lat, z)),
	};
}
{
	let bad = 0;
	let cases = 0;
	for (const z of [8, 10, 12, 14]) {
		const key = keyAt(46.7 + z * 0.01, 7.75, z);
		const h = heightsOf(256, z);
		const a = buildBatchGrid(frame, key, h);
		const b = buildBatchGrid(frame, key, heightStats(h));
		cases++;
		if (
			!sameBits(a.base, b.base) ||
			!a.sphere.every((v, i) => sameNum(v, b.sphere[i])) ||
			a.G !== b.G ||
			!sameNum(a.skirt, b.skirt) ||
			!sameNum(a.merc0, b.merc0) ||
			!sameNum(a.dlon0, b.dlon0)
		)
			bad++;
		const dem: DemRaster = { key, source: key, size: 256, heights: h };
		const eager = buildLiteMesh(frame, dem, 64, 5000, true);
		let made = 0;
		const lazy = buildLiteMesh(
			frame,
			{
				key,
				source: key,
				size: 256,
				heightStats: heightStats(h),
				lazyHeights: {
					materialize: () => {
						made++;
						return h;
					},
				},
			},
			64,
			5000,
			true,
		);
		cases++;
		if (
			made ||
			lazy.heights ||
			!sameBits(eager.grid?.base ?? [], lazy.grid?.base ?? [1]) ||
			!(eager.grid?.sphere ?? []).every((v, i) =>
				sameNum(v, lazy.grid?.sphere[i] ?? Number.NaN),
			)
		)
			bad++;
	}
	check(
		"buildBatchGrid(heights) == buildBatchGrid(heightStats); lazy lite mesh == eager, unmaterialised",
		!bad,
		`(${cases} cases)`,
	);
}

// ---------------- 4. downsample plumbing ----------------
{
	/** terrain-stream.ts / roll-terrain.ts downsample2 before W2.4, verbatim */
	function oldDownsample2(r: DemRaster): DemRaster {
		const s = r.size / 2;
		const h = r.heights;
		const S = r.size;
		const out = new Float32Array(s * s);
		for (let y = 0; y < s; y++)
			for (let x = 0; x < s; x++) {
				const o = 2 * y * S + 2 * x;
				out[y * s + x] = (h[o] + h[o + 1] + h[o + S] + h[o + S + 1]) * 0.25;
			}
		return { ...r, size: s, heights: out };
	}
	let bad = 0;
	let cases = 0;
	for (const S of [256, 512, 1024])
		for (const seg of [32, 64, 128, 256]) {
			const key = { z: 12, x: 2136, y: 1453 };
			const dem: DemRaster = {
				key,
				source: key,
				size: S,
				heights: heightsOf(S, S + seg),
			};
			let old = dem;
			let steps = 0;
			while (old.size > 2 * seg && old.size > 256) {
				old = oldDownsample2(old);
				steps++;
			}
			const fit = fitStreamTile(dem, seg);
			cases++;
			if (
				fit.size !== old.size ||
				!sameBits(fit.heights, old.heights) ||
				downsampleSteps(S, seg) !== steps
			)
				bad++;
			if (S >= 2) {
				cases++;
				if (
					!sameBits(
						downsampleHeights2(dem.heights, S),
						oldDownsample2(dem).heights,
					)
				)
					bad++;
			}
		}
	check(
		"fitStreamTile / downsampleHeights2 / downsampleSteps == the old loop",
		!bad,
		`(${cases} cases)`,
	);
}

// ---------------- 5. TerrainSet queries on lazy tiles ----------------
{
	const z = 13;
	const c = keyAt(46.7107, 7.7713, z);
	const keys: TileKey[] = [];
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++) keys.push({ z, x: c.x + dx, y: c.y + dy });
	const eagerTiles: TileMesh[] = [];
	const lazyTiles: TileMesh[] = [];
	keys.forEach((key, i) => {
		const h = heightsOf(256, 100 + i);
		const dem: DemRaster = { key, source: key, size: 256, heights: h };
		eagerTiles.push(buildLiteMesh(frame, dem, 64, 1000 + i, true));
		lazyTiles.push(
			buildLiteMesh(
				frame,
				{
					key,
					source: key,
					size: 256,
					heightStats: heightStats(h),
					lazyHeights: { materialize: () => Float32Array.from(h) },
				},
				64,
				1000 + i,
				true,
			),
		);
	});
	const eager = new TerrainSet(frame, eagerTiles);
	const lazy = new TerrainSet(frame, lazyTiles);
	const r0 = localElevRange(eager);
	const r1 = localElevRange(lazy);
	check(
		"localElevRange: lazy == eager, nothing materialised",
		sameNum(r0[0], r1[0]) &&
			sameNum(r0[1], r1[1]) &&
			lazyTiles.every((t) => !hasCpuHeights(t)),
		`[${r0}]`,
	);
	const r = rng(7);
	let bad = 0;
	for (let i = 0; i < 2000; i++) {
		const lat = 46.7107 + (r() - 0.5) * 0.06;
		const lon = 7.7713 + (r() - 0.5) * 0.09;
		const a = eager.heightAt(lat, lon);
		const b = lazy.heightAt(lat, lon);
		if (!(a === b || (a == null && b == null))) bad++;
	}
	const m0 = eager.localMax(46.7107, 7.7713, 200);
	const m1 = lazy.localMax(46.7107, 7.7713, 200);
	check(
		"heightAt (2000 points) and localMax: lazy == eager",
		!bad &&
			sameNum(m0.h, m1.h) &&
			sameNum(m0.lat, m1.lat) &&
			sameNum(m0.lon, m1.lon),
		`(${lazyTiles.filter(hasCpuHeights).length}/${lazyTiles.length} tiles materialised by the queries)`,
	);
}

console.log(failures ? `\n${failures} FAILED` : "\ncpu-heights: all ok");
process.exit(failures ? 1 : 0);
