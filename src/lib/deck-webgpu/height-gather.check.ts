// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/deck-webgpu/height-gather.check.ts
// Node check of the GPU height gathers (WAG W2.4, height-gather.ts) against TerrainSet.heightAt, bit
// for bit, with the kernel emulated (unpack the texel word, read the layer, return nonce + raw bits):
//  1. gridCorners + blendCorners == sampleGrid (random sizes and positions, edges and clamps);
//  2. TerrainSet.locate + sampleGrid == heightAt;
//  3. planHeights + emulated gather + finishHeights == heightAt on a mixed set (eager tiles, lazy tiles
//     in small and big layers, a lazy tile that is not resident, gaps outside coverage), and no lazy
//     resident tile is materialised;
//  4. the certificate: a wrong nonce, a failed gather (null) and a tile whose slot changed after the
//     plan all fall back to heightAt and still give heightAt's values;
//  5. replayHeights over buildTrailSegments and localMaxOf == the direct calls (segments, positions
//     and summits bit for bit), synchronously and through a promise.
import {
	buildLiteMesh,
	type StreamRaster,
} from "#/lib/deck/batched-terrain-grid";
import {
	localMaxOf,
	TerrainSet,
	type TileLocation,
	type TileMesh,
} from "#/lib/deck/terrain-data";
import { buildTrailSegments } from "#/lib/deck/trail-layer";
import {
	blendCorners,
	gridCorners,
	hasCpuHeights,
	heightStats,
	latToTileY,
	lonToTileX,
	sampleGrid,
	type TileKey,
} from "#/lib/dem";
import { EnuFrame } from "#/lib/geodesy";
import type { RegionData } from "#/lib/photos";
import {
	finishHeights,
	heightGatherCounters,
	planHeights,
	replayHeights,
	type SlotOf,
} from "./height-gather";

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

/** Terrarium-like heights: multiples of 1/256 (some after a 2× box average: 1/1024). */
function heightsOf(S: number, seed: number) {
	const r = rng(seed);
	const h = new Float32Array(S * S);
	const base = 400 + r() * 2000;
	for (let y = 0; y < S; y++)
		for (let x = 0; x < S; x++) {
			const v =
				base +
				900 * Math.sin((x / S) * 5 + seed) * Math.cos((y / S) * 3) +
				40 * (r() - 0.5);
			h[y * S + x] = Math.max(0, Math.round(v * 1024) / 1024);
		}
	return h;
}

const same = (a: number | null, b: number | null) =>
	a == null || Number.isNaN(a)
		? b == null || Number.isNaN(b as number)
		: Object.is(a, b);

// ---------------- 1. gridCorners + blendCorners == sampleGrid ----------------
{
	const r = rng(1);
	let bad = 0;
	const k = [0, 0, 0, 0, 0, 0];
	for (const S of [1, 2, 64, 128, 256, 512]) {
		const h = heightsOf(S, S);
		for (let i = 0; i < 4000; i++) {
			// mostly inside, some at the edges and past them (the clamps)
			const px = i % 10 === 0 ? (r() - 0.1) * S * 1.2 : r() * S;
			const py = i % 7 === 0 ? (i % 2 ? 0 : S) : r() * S;
			gridCorners(S, px, py, k);
			const [x0, y0, x1, y1, fx, fy] = k;
			const v = blendCorners(
				h[y0 * S + x0],
				h[y0 * S + x1],
				h[y1 * S + x0],
				h[y1 * S + x1],
				fx,
				fy,
			);
			if (!Object.is(v, sampleGrid(h, S, px, py))) bad++;
		}
	}
	check("gridCorners + blendCorners == sampleGrid (24000 samples)", !bad);
}

// ---------------- a mixed TerrainSet ----------------
const frame = new EnuFrame(46.7107, 7.7713, 600);
const keyAt = (lat: number, lon: number, z: number): TileKey => ({
	z,
	x: Math.floor(lonToTileX(lon, z)),
	y: Math.floor(latToTileY(lat, z)),
});

type Atlas = { small: Float32Array[]; big: Float32Array[] };
const SMALL = 256;
const BIG = 512;

/** Tiles at z 12 (coarse, eager), z 13 (lazy, 256 → small), z 14 (lazy 512 → big, one eager, one
 * not resident, one 128 px in a small layer). Returns the set, the slots and the emulated atlas. */
function mixedSet() {
	const tiles: TileMesh[] = [];
	const heights = new Map<TileMesh, Float32Array>();
	const slots = new Map<TileMesh, { layer: number; big: boolean }>();
	const atlas: Atlas = { small: [], big: [] };
	let seed = 10;
	const add = (
		key: TileKey,
		size: number,
		kind: "eager" | "lazy" | "lazy-absent",
	) => {
		const h = heightsOf(size, seed++);
		const dem: StreamRaster =
			kind === "eager"
				? { key, source: key, size, heights: h }
				: {
						key,
						source: key,
						size,
						heightStats: heightStats(h),
						lazyHeights: { materialize: () => Float32Array.from(h) },
					};
		const m = buildLiteMesh(frame, dem, 32, 1000, true);
		tiles.push(m);
		heights.set(m, h);
		if (kind !== "lazy") return;
		const big = size > SMALL;
		const pool = big ? atlas.big : atlas.small;
		const L = big ? BIG : SMALL;
		// a few unused layers first, so layer indices are not trivial
		while (pool.length < (big ? 3 : 5)) pool.push(new Float32Array(L * L));
		const layer = new Float32Array(L * L).fill(-9999);
		for (let y = 0; y < size; y++)
			layer.set(h.subarray(y * size, (y + 1) * size), y * L);
		slots.set(m, { layer: pool.length, big });
		pool.push(layer);
	};
	const c12 = keyAt(46.7107, 7.7713, 12);
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++)
			add({ z: 12, x: c12.x + dx, y: c12.y + dy }, 256, "eager");
	const c13 = keyAt(46.7107, 7.7713, 13);
	for (let dy = 0; dy <= 1; dy++)
		for (let dx = 0; dx <= 1; dx++)
			add({ z: 13, x: c13.x + dx, y: c13.y + dy }, 256, "lazy");
	const c14 = keyAt(46.7107, 7.7713, 14);
	add(c14, 512, "lazy");
	add({ ...c14, x: c14.x + 1 }, 512, "eager");
	add({ ...c14, y: c14.y + 1 }, 512, "lazy-absent");
	add({ ...c14, x: c14.x + 1, y: c14.y + 1 }, 128, "lazy");
	return { set: new TerrainSet(frame, tiles), tiles, heights, slots, atlas };
}

/** The kernel's twin: nonce + raw bits per texel word. */
function emulateGather(words: ArrayLike<number>, nonce: number, atlas: Atlas) {
	const out = new Uint32Array(words.length * 2);
	const f = new Float32Array(out.buffer);
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		const x = w & 511;
		const y = (w >>> 9) & 511;
		const layer = (w >>> 18) & 4095;
		const big = w >>> 30 !== 0;
		out[i * 2] = nonce;
		f[i * 2 + 1] = (big ? atlas.big : atlas.small)[layer][
			y * (big ? BIG : SMALL) + x
		];
	}
	return out;
}

/** A fresh copy of the mixed set's twin: all eager (the reference heightAt). */
function eagerTwin(m: ReturnType<typeof mixedSet>) {
	return new TerrainSet(
		frame,
		m.tiles.map((t) => ({
			...t,
			heights: m.heights.get(t),
			lazyHeights: undefined,
		})),
	);
}

function points(n: number, seed: number) {
	const r = rng(seed);
	const lats: number[] = [];
	const lons: number[] = [];
	// a third over the whole set (gaps included), the rest over the z 13 / z 14 tiles
	for (let i = 0; i < n; i++) {
		const s = i % 3 ? 0.18 : 1;
		lats.push(46.7107 + (r() - 0.5) * 0.25 * s);
		lons.push(7.7713 + (r() - 0.5) * 0.35 * s);
	}
	return { lats, lons };
}

// ---------------- 2. locate + sampleGrid == heightAt ----------------
{
	const m = mixedSet();
	const ref = eagerTwin(m);
	const { lats, lons } = points(5000, 2);
	const loc = { px: 0, py: 0 } as TileLocation;
	let bad = 0;
	for (let i = 0; i < lats.length; i++) {
		const a = ref.locate(lats[i], lons[i], loc);
		const v = a
			? sampleGrid(a.tile.heights as Float32Array, a.tile.size, a.px, a.py)
			: null;
		if (!same(v, ref.heightAt(lats[i], lons[i]))) bad++;
	}
	check("TerrainSet.locate + sampleGrid == heightAt (5000 points)", !bad);
}

// ---------------- 3. plan + gather + finish == heightAt ----------------
{
	const m = mixedSet();
	const ref = eagerTwin(m);
	const slotOf: SlotOf = (t) => m.slots.get(t as TileMesh) ?? null;
	const { lats, lons } = points(20000, 3);
	const c0 = { ...heightGatherCounters };
	const plan = planHeights(m.set, lats, lons, slotOf);
	const bits = emulateGather(plan.words, 7, m.atlas);
	const out = finishHeights(plan, bits, 0, 7, slotOf);
	let bad = 0;
	for (let i = 0; i < lats.length; i++)
		if (!same(out[i], ref.heightAt(lats[i], lons[i]))) bad++;
	const d = (k: keyof typeof heightGatherCounters) =>
		heightGatherCounters[k] - c0[k];
	const residentLazy = [...m.slots.keys()];
	check(
		"plan + emulated gather + finish == heightAt (20000 points)",
		!bad,
		`(gpu ${d("gpuSamples")}, cpu ${d("cpuSamples")}, null ${d("nullSamples")}, fallback ${d("fallbackSamples")})`,
	);
	check(
		"every path taken; resident lazy tiles not materialised",
		d("gpuSamples") > 0 &&
			d("cpuSamples") > 0 &&
			d("nullSamples") > 0 &&
			d("fallbackSamples") > 0 &&
			d("certificateMisses") === 0 &&
			residentLazy.every((t) => !hasCpuHeights(t)),
	);
	// two plans in one batch (the per-tick flush): offsets
	const m2 = mixedSet();
	const slotOf2: SlotOf = (t) => m2.slots.get(t as TileMesh) ?? null;
	const a = points(3000, 4);
	const b = points(3000, 5);
	const pa = planHeights(m2.set, a.lats, a.lons, slotOf2);
	const pb = planHeights(m2.set, b.lats, b.lons, slotOf2);
	const both = emulateGather([...pa.words, ...pb.words], 9, m2.atlas);
	const oa = finishHeights(pa, both, 0, 9, slotOf2);
	const ob = finishHeights(pb, both, pa.words.length, 9, slotOf2);
	let bad2 = 0;
	for (let i = 0; i < 3000; i++) {
		if (!same(oa[i], ref.heightAt(a.lats[i], a.lons[i]))) bad2++;
		if (!same(ob[i], ref.heightAt(b.lats[i], b.lons[i]))) bad2++;
	}
	check("two plans in one gather (offsets) == heightAt", !bad2);
}

// ---------------- 4. the certificate ----------------
{
	/** `tamper` runs between the plan and the (emulated) gather; it returns the bits the finish sees
	 * (from `gather()`, the kernel run on the atlas as it is then) and the slots after the gather. */
	const run = (
		name: string,
		tamper: (
			m: ReturnType<typeof mixedSet>,
			gather: () => Uint32Array,
		) => { bits: Uint32Array | null; slotOf?: SlotOf },
	) => {
		const m = mixedSet();
		const ref = eagerTwin(m);
		const slotOf: SlotOf = (t) => m.slots.get(t as TileMesh) ?? null;
		const { lats, lons } = points(4000, 6);
		const plan = planHeights(m.set, lats, lons, slotOf);
		const c = tamper(m, () => emulateGather(plan.words, 11, m.atlas));
		const miss0 = heightGatherCounters.certificateMisses;
		const out = finishHeights(plan, c.bits, 0, 11, c.slotOf ?? slotOf);
		let bad = 0;
		for (let i = 0; i < lats.length; i++)
			if (!same(out[i], ref.heightAt(lats[i], lons[i]))) bad++;
		const misses = heightGatherCounters.certificateMisses - miss0;
		check(
			`certificate: ${name} → heightAt's values`,
			!bad && (c.bits === null || misses > 0),
			`(${misses} misses)`,
		);
	};
	run("wrong nonce on one texel", (_m, gather) => {
		const bits = gather();
		bits[2] = 0;
		return { bits };
	});
	run("all-zero output (a dispatch that failed validation)", (_m, gather) => ({
		bits: new Uint32Array(gather().length),
	}));
	run("gather failed (null)", () => ({ bits: null }));
	run(
		"a tile's layer re-used before the gather (slot changed)",
		(m, gather) => {
			const [t, s] = [...m.slots][0];
			// the tile was evicted and its layer now holds another tile's heights
			const pool = s.big ? m.atlas.big : m.atlas.small;
			pool[s.layer] = new Float32Array(pool[s.layer].length).fill(1234.5);
			const bits = gather();
			return {
				bits,
				slotOf: (x) => (x === t ? null : (m.slots.get(x as TileMesh) ?? null)),
			};
		},
	);
	run("a tile moved to another layer after the plan", (m, gather) => {
		const [t, s] = [...m.slots][1];
		const moved = { layer: s.layer + 1, big: s.big };
		return {
			bits: gather(),
			slotOf: (x) => (x === t ? moved : (m.slots.get(x as TileMesh) ?? null)),
		};
	});
}

// ---------------- 5. replayHeights ----------------
{
	const m = mixedSet();
	const ref = eagerTwin(m);
	const slotOf: SlotOf = (t) => m.slots.get(t as TileMesh) ?? null;
	const lookup = (lats: number[], lons: number[]) => {
		const plan = planHeights(m.set, lats, lons, slotOf);
		return finishHeights(
			plan,
			emulateGather(plan.words, 3, m.atlas),
			0,
			3,
			slotOf,
		);
	};
	const r = rng(8);
	const trails: RegionData["trails"] = [];
	for (let k = 0; k < 40; k++) {
		const coords: [number, number][] = [];
		let lon = 7.7713 + (r() - 0.5) * 0.3;
		let lat = 46.7107 + (r() - 0.5) * 0.2;
		for (let i = 0; i < 30; i++) {
			coords.push([lon, lat]);
			lon += (r() - 0.5) * 0.004;
			lat += (r() - 0.5) * 0.003;
		}
		trails.push({
			coords,
			sac: ["hiking", "mountain_hiking", undefined][k % 3],
		} as RegionData["trails"][number]);
	}
	const region = { trails } as RegionData;
	const at = { lat: 46.7107, lon: 7.7713 };
	const direct = buildTrailSegments(region, frame, at, (la, lo) =>
		ref.heightAt(la, lo),
	);
	const replayed = replayHeights(
		(h) => buildTrailSegments(region, frame, at, h),
		lookup,
	) as ReturnType<typeof buildTrailSegments>;
	const eqArr = (a: ArrayLike<number>, b: ArrayLike<number>) =>
		a.length === b.length &&
		Array.prototype.every.call(a, (v: number, i: number) => Object.is(v, b[i]));
	check(
		"replayHeights(buildTrailSegments) == direct",
		direct.count > 100 &&
			direct.count === replayed.count &&
			eqArr(direct.positions, replayed.positions) &&
			eqArr(direct.colors, replayed.colors) &&
			eqArr(direct.classes, replayed.classes) &&
			eqArr(direct.dist ?? [], replayed.dist ?? []),
		`(${direct.count} segments)`,
	);
	let bad = 0;
	for (let i = 0; i < 300; i++) {
		const lat = 46.7107 + (r() - 0.5) * 0.25;
		const lon = 7.7713 + (r() - 0.5) * 0.35;
		const radius = 60 + r() * 190;
		const a = ref.localMax(lat, lon, radius);
		const b = replayHeights(
			(h) => localMaxOf(h, lat, lon, radius),
			lookup,
		) as ReturnType<typeof localMaxOf>;
		if (
			!(
				Object.is(a.h, b.h) &&
				Object.is(a.lat, b.lat) &&
				Object.is(a.lon, b.lon)
			)
		)
			bad++;
	}
	check("replayHeights(localMaxOf) == TerrainSet.localMax (300 peaks)", !bad);
	// all peaks in one gather (snapPeaksNear's batch): one lookup call, same snaps, resident lazy tiles
	// stay un-materialised (the CPU localMax materialises every tile it samples)
	{
		const peaks = Array.from({ length: 40 }, () => ({
			lat: 46.7107 + (r() - 0.5) * 0.25,
			lon: 7.7713 + (r() - 0.5) * 0.35,
			radius: 60 + r() * 190,
		}));
		const lazy = [...m.slots.keys()];
		const before = lazy.filter((t) => hasCpuHeights(t)).length;
		let lookups = 0;
		let samples = 0;
		const snaps = peaks.map((pk) =>
			replayHeights(
				(h) => localMaxOf(h, pk.lat, pk.lon, pk.radius),
				(la, lo) => {
					lookups++;
					samples += la.length;
					return lookup(la, lo);
				},
			),
		) as ReturnType<typeof localMaxOf>[];
		const after = lazy.filter((t) => hasCpuHeights(t)).length;
		const refSnaps = peaks.map((pk) => ref.localMax(pk.lat, pk.lon, pk.radius));
		check(
			"batched peak snaps == CPU localMax; one lookup per peak, no tile materialised",
			snaps.every(
				(a, i) =>
					Object.is(a.h, refSnaps[i].h) &&
					Object.is(a.lat, refSnaps[i].lat) &&
					Object.is(a.lon, refSnaps[i].lon),
			) &&
				lookups === peaks.length &&
				after === before,
			`(${samples} samples, ${lookups} lookups, lazy tiles with CPU heights ${before} -> ${after})`,
		);
	}
	const viaPromise = await replayHeights(
		(h) => localMaxOf(h, 46.71, 7.77, 200),
		async (la, lo) => lookup(la, lo),
	);
	const sync = ref.localMax(46.71, 7.77, 200);
	check(
		"replayHeights through a promise == sync",
		Object.is(viaPromise.h, sync.h) && Object.is(viaPromise.lat, sync.lat),
	);
}

console.log(failures ? `\n${failures} FAILED` : "\nheight-gather: all ok");
process.exit(failures ? 1 : 0);
