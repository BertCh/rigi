// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Radius neighbour pairs over camera-roll positions: every pair (i < j) with distanceM < radiusM,
// exactly what the O(n^2) loops of roll.ts find, from a spatial index instead.
//
// Projection: unit-sphere ECEF in km (float32x3 on the GPU). A Euclidean ball of the chord that
// subtends the radius (padded for distanceM's equirectangular approximation and float32 rounding)
// is a superset of the distanceM test, including across the antimeridian (distanceM does not wrap
// longitude, the chord does: those candidates are simply rejected by the exact test) and near the
// poles. Every candidate pair is then confirmed with the exact distanceM on the CPU, so the result
// does not depend on the index.
//
// GPU path: ONE ComputeGraph = luma GPUGridIndex (3D uniform grid over the points) + a pair kernel
// that scans the 27 cells around each point. GPUGridIndexQuery kind "radius" is not used: it answers
// ONE query per node group by testing every indexed object (O(n) per query, a node set per query),
// which is O(n^2) work and thousands of nodes for a camera roll; the all-points batch is a single
// kernel over the index's cellOffsets/objectIds instead.
//
// CPU twin: the same projection in a hashed uniform grid (Map of cell hash to point list; a hash
// collision only adds candidates).
import { Buffer, type Device } from "@luma.gl/core";
import { ComputeGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { GPUGridIndex } from "#/lib/gpu/core/luma";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import { distanceM } from "../../geodesy";
import type { LatLon } from "../../ontology/core/geometry";

const DEG = Math.PI / 180;
/** Mean earth radius (km) of the projection (distanceM's own EARTH_R is 6371008.8 m). */
const EARTH_RADIUS_KM = 6371.0088;
/**
 * Beyond this radius the equirectangular distanceM and the chord can disagree by more than the
 * padding, so such queries are brute-forced (a roll link of 15 km and a viewpoint of 250 m are far
 * below it).
 */
export const MAX_INDEXED_RADIUS_M = 1_000_000;
/** Largest pair list the GPU path reads back (pairs); beyond it the caller streams on the CPU. */
export const MAX_GPU_PAIRS = 4_000_000;
/** Cells of the GPU grid (the cell width grows, never the count, when the extent is huge). */
const MAX_GRID_CELLS = 1 << 21;
const WORKGROUP = 64;

/** Sorted interleaved pairs: [i0, j0, i1, j1, ...], i < j, ordered by (i, j). */
export type NeighbourPairs = Uint32Array;

const isValid = (p: LatLon) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

/** Unit-sphere ECEF (km) of a valid position. */
function ecefKm(point: LatLon): [number, number, number] {
	const lat = point.lat * DEG;
	const lon = point.lon * DEG;
	const c = Math.cos(lat);
	return [
		EARTH_RADIUS_KM * c * Math.cos(lon),
		EARTH_RADIUS_KM * c * Math.sin(lon),
		EARTH_RADIUS_KM * Math.sin(lat),
	];
}

/**
 * Chord (km) of the padded arc: 15 % plus 50 m over the radius covers distanceM's
 * mean-latitude approximation at roll scales and the ~1 m float32 rounding of the positions.
 */
export function paddedChordKm(radiusM: number): number {
	const arcKm = (radiusM * 1.15 + 50) / 1000;
	return 2 * EARTH_RADIUS_KM * Math.sin(arcKm / (2 * EARTH_RADIUS_KM));
}

/** Indices of the points with a finite position. */
function validIndices(points: readonly LatLon[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < points.length; i++) if (isValid(points[i])) out.push(i);
	return out;
}

/** Sorts candidate pairs by (i, j) and drops the duplicates; returns the interleaved array. */
function packPairs(left: number[], right: number[], n: number): NeighbourPairs {
	const keys = new Float64Array(left.length);
	for (let k = 0; k < left.length; k++) keys[k] = left[k] * n + right[k];
	keys.sort();
	const out = new Uint32Array(keys.length * 2);
	let w = 0;
	let previous = -1;
	for (let k = 0; k < keys.length; k++) {
		if (keys[k] === previous) continue;
		previous = keys[k];
		const i = Math.floor(keys[k] / n);
		out[w++] = i;
		out[w++] = keys[k] - i * n;
	}
	return out.subarray(0, w);
}

/** Reference: every pair by the exact distanceM (what roll.ts does). */
export function neighbourPairsBrute(
	points: readonly LatLon[],
	radiusM: number,
): NeighbourPairs {
	const left: number[] = [];
	const right: number[] = [];
	for (let i = 0; i < points.length; i++) {
		if (!isValid(points[i])) continue;
		for (let j = i + 1; j < points.length; j++)
			if (isValid(points[j]) && distanceM(points[i], points[j]) < radiusM) {
				left.push(i);
				right.push(j);
			}
	}
	return packPairs(left, right, Math.max(1, points.length));
}

/**
 * Visits every confirmed pair (i < j, input indices, unordered, once each) from a hashed uniform
 * grid, without storing the pair list (dense rolls have O(n^2) pairs; a union-find consumer needs
 * none of them kept).
 */
export function forEachNeighbourPairCpu(
	points: readonly LatLon[],
	radiusM: number,
	visit: (i: number, j: number) => void,
): void {
	const ids = validIndices(points);
	if (radiusM > MAX_INDEXED_RADIUS_M || ids.length < 2) {
		if (radiusM > MAX_INDEXED_RADIUS_M)
			for (let a = 0; a < ids.length; a++)
				for (let b = a + 1; b < ids.length; b++)
					if (distanceM(points[ids[a]], points[ids[b]]) < radiusM)
						visit(ids[a], ids[b]);
		return;
	}
	const cell = paddedChordKm(radiusM);
	const chord2 = cell * cell;
	const offset = EARTH_RADIUS_KM + 1;
	const coords = new Float64Array(ids.length * 3);
	const cells = new Int32Array(ids.length * 3);
	const buckets = new Map<number, number[]>();
	const hash = (cx: number, cy: number, cz: number) =>
		(Math.imul(cx, 73856093) ^
			Math.imul(cy, 19349663) ^
			Math.imul(cz, 83492791)) |
		0;
	for (let a = 0; a < ids.length; a++) {
		const e = ecefKm(points[ids[a]]);
		for (let k = 0; k < 3; k++) {
			coords[a * 3 + k] = e[k];
			cells[a * 3 + k] = Math.floor((e[k] + offset) / cell);
		}
		const key = hash(cells[a * 3], cells[a * 3 + 1], cells[a * 3 + 2]);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(a);
		else buckets.set(key, [a]);
	}
	const seen = new Set<number>();
	for (let a = 0; a < ids.length; a++) {
		const cx = cells[a * 3];
		const cy = cells[a * 3 + 1];
		const cz = cells[a * 3 + 2];
		seen.clear();
		for (let dz = -1; dz <= 1; dz++)
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++) {
					const key = hash(cx + dx, cy + dy, cz + dz);
					if (seen.has(key)) continue;
					seen.add(key);
					const bucket = buckets.get(key);
					if (!bucket) continue;
					for (const b of bucket) {
						if (b <= a) continue;
						const ex = coords[a * 3] - coords[b * 3];
						const ey = coords[a * 3 + 1] - coords[b * 3 + 1];
						const ez = coords[a * 3 + 2] - coords[b * 3 + 2];
						if (ex * ex + ey * ey + ez * ez > chord2) continue;
						if (distanceM(points[ids[a]], points[ids[b]]) < radiusM)
							visit(ids[a], ids[b]);
					}
				}
	}
}

/** CPU twin: the hashed-grid pairs, sorted by (i, j). */
export function neighbourPairsCpu(
	points: readonly LatLon[],
	radiusM: number,
): NeighbourPairs {
	const left: number[] = [];
	const right: number[] = [];
	forEachNeighbourPairCpu(points, radiusM, (i, j) => {
		left.push(i);
		right.push(j);
	});
	return packPairs(left, right, Math.max(1, points.length));
}

// ---------------------------------------------------------------------------------------------
// GPU

/**
 * One thread per point: scan the 27 cells around its own cell of the GPUGridIndex and append every
 * later point within the padded chord. The cell function is GPUGridIndex's own getCoordinate with
 * minimum 0 (the positions are shifted to the bounding-box corner), so the thread's cell is the
 * cell the index put the point in. pairCount keeps counting past capacity: the host reruns with
 * room for all of them.
 */
const K_PAIRS = defineKernel(
	"roll-spatial-pairs",
	/* wgsl */ `
struct Params {
	dims: vec4<u32>,
	bounds: vec4<f32>,
	capacity: vec4<u32>,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> positions: array<f32>;
@group(0) @binding(2) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(3) var<storage, read> objectIds: array<u32>;
@group(0) @binding(4) var<storage, read_write> pairCount: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> pairs: array<u32>;

fn getCoordinate(value: f32, maximum: f32, size: u32) -> u32 {
	if (maximum == 0.0 || value == 0.0) { return 0u; }
	if (value == maximum) { return size - 1u; }
	return min(u32(value / maximum * f32(size)), size - 1u);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let a = id.x;
	let n = params.dims.w;
	if (a >= n) { return; }
	let ax = positions[a * 3u];
	let ay = positions[a * 3u + 1u];
	let az = positions[a * 3u + 2u];
	let gx = params.dims.x;
	let gy = params.dims.y;
	let gz = params.dims.z;
	let cx = i32(getCoordinate(ax, params.bounds.x, gx));
	let cy = i32(getCoordinate(ay, params.bounds.y, gy));
	let cz = i32(getCoordinate(az, params.bounds.z, gz));
	let chord2 = params.bounds.w;
	for (var dz = -1; dz <= 1; dz++) {
		let z = cz + dz;
		if (z < 0 || z >= i32(gz)) { continue; }
		for (var dy = -1; dy <= 1; dy++) {
			let y = cy + dy;
			if (y < 0 || y >= i32(gy)) { continue; }
			for (var dx = -1; dx <= 1; dx++) {
				let x = cx + dx;
				if (x < 0 || x >= i32(gx)) { continue; }
				let cell = (u32(z) * gy + u32(y)) * gx + u32(x);
				let end = cellOffsets[cell + 1u];
				for (var k = cellOffsets[cell]; k < end; k++) {
					let b = objectIds[k];
					if (b <= a) { continue; }
					let ex = ax - positions[b * 3u];
					let ey = ay - positions[b * 3u + 1u];
					let ez = az - positions[b * 3u + 2u];
					if (ex * ex + ey * ey + ez * ez > chord2) { continue; }
					let slot = atomicAdd(&pairCount[0], 1u);
					if (slot < params.capacity.x) {
						pairs[slot * 2u] = a;
						pairs[slot * 2u + 1u] = b;
					}
				}
			}
		}
	}
}
`,
	[
		["params", "uniform"],
		["positions", "read-only-storage"],
		["cellOffsets", "read-only-storage"],
		["objectIds", "read-only-storage"],
		["pairCount", "storage"],
		["pairs", "storage"],
	],
	{ group: "roll-spatial" },
);

type GridPlan = {
	size: [number, number, number];
	/** shifted positions (km, >= 0), float32x3 */
	positions: Float32Array;
	/** exclusive upper bound per axis (float32-exact) */
	extent: [number, number, number];
};

/** Float32 positions shifted to the bounding-box corner, and a grid whose cells are >= the chord. */
function planGrid(
	points: readonly LatLon[],
	ids: readonly number[],
	chordKm: number,
): GridPlan {
	const raw = new Float64Array(ids.length * 3);
	const min = [Infinity, Infinity, Infinity];
	for (let a = 0; a < ids.length; a++) {
		const e = ecefKm(points[ids[a]]);
		for (let k = 0; k < 3; k++) {
			raw[a * 3 + k] = e[k];
			if (e[k] < min[k]) min[k] = e[k];
		}
	}
	const positions = new Float32Array(ids.length * 3);
	const max = [0, 0, 0];
	for (let a = 0; a < ids.length; a++)
		for (let k = 0; k < 3; k++) {
			const v = Math.fround(raw[a * 3 + k] - min[k]);
			positions[a * 3 + k] = v;
			if (v > max[k]) max[k] = v;
		}
	// 1 m of slack so the largest point is strictly inside the (literal) domain
	const extent = max.map((m) => Math.fround(m + 0.001)) as [
		number,
		number,
		number,
	];
	let cell = chordKm;
	let size: [number, number, number];
	for (;;) {
		size = extent.map((e) => Math.max(1, Math.floor(e / cell))) as [
			number,
			number,
			number,
		];
		if (size[0] * size[1] * size[2] <= MAX_GRID_CELLS) break;
		cell *= 1.5;
	}
	return { size, positions, extent };
}

/**
 * GPU neighbour pairs on `device` (WebGPU): the exact pairs of neighbourPairsBrute, sorted by
 * (i, j). Null when the grid index reports a problem or the candidate list exceeds MAX_GPU_PAIRS;
 * the caller then streams on the CPU.
 */
export async function neighbourPairsGpu(
	device: Device,
	points: readonly LatLon[],
	radiusM: number,
): Promise<NeighbourPairs | null> {
	const ids = validIndices(points);
	if (radiusM > MAX_INDEXED_RADIUS_M) return null;
	if (ids.length < 2) return new Uint32Array(0);
	const m = ids.length;
	const chordKm = paddedChordKm(radiusM);
	const plan = planGrid(points, ids, chordKm);
	const cellCount = plan.size[0] * plan.size[1] * plan.size[2];
	// capacity doubles as the retry size: a first guess of a few neighbours per point
	let capacity = Math.max(4096, m * 8);
	return withLease("roll-spatial", async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const graph = new ComputeGraph<undefined>(device, "roll-spatial-pairs");
			try {
				const positions = pooledStorage(
					device,
					"roll-spatial/positions",
					plan.positions,
				);
				const cellOffsets = pooledStorage(
					device,
					"roll-spatial/offsets",
					(cellCount + 1) * 4,
				);
				const objectIds = pooledStorage(device, "roll-spatial/objects", m * 4);
				const indexCount = pooledStorage(
					device,
					"roll-spatial/index-count",
					16,
				);
				const indexOverflow = pooledStorage(
					device,
					"roll-spatial/index-overflow",
					16,
				);
				const pairCount = pooledStorage(device, "roll-spatial/pair-count", 16);
				const pairs = pooledStorage(device, "roll-spatial/pairs", capacity * 8);
				const params = pooledUniform(
					device,
					"roll-spatial/params",
					(() => {
						const words = new ArrayBuffer(48);
						const u = new Uint32Array(words);
						const f = new Float32Array(words);
						u.set([plan.size[0], plan.size[1], plan.size[2], m], 0);
						f.set([...plan.extent, Math.fround(chordKm * chordKm)], 4);
						u[8] = capacity;
						return words;
					})(),
				);
				const hPositions = graph.importBuffer("positions", m * 12);
				const hOffsets = graph.importBuffer("offsets", (cellCount + 1) * 4);
				const hObjects = graph.importBuffer("objects", m * 4);
				const hIndexCount = graph.importBuffer("indexCount", 4);
				const hIndexOverflow = graph.importBuffer("indexOverflow", 4);
				const hPairCount = graph.importBuffer("pairCount", 4);
				const hPairs = graph.importBuffer("pairs", capacity * 8);
				const hParams = graph.importBuffer(
					"params",
					48,
					undefined,
					Buffer.UNIFORM | Buffer.COPY_DST,
				);
				graph.add(
					new GPUGridIndex({
						id: "roll-spatial-index",
						positions: graph.graph.createDataView(hPositions, {
							format: "float32x3",
							length: m,
						}),
						gridSize: plan.size,
						bounds: [0, 0, 0, ...plan.extent],
						cellOffsets: graph.view(hOffsets, "uint32", cellCount + 1),
						objectIds: graph.view(hObjects, "uint32", m),
						count: graph.view(hIndexCount, "uint32", 1),
						overflow: graph.view(hIndexOverflow, "uint32", 1),
					}),
				);
				graph.addKernel({
					id: "pairs",
					spec: K_PAIRS,
					bindings: {
						params: hParams,
						positions: hPositions,
						cellOffsets: hOffsets,
						objectIds: hObjects,
						pairCount: hPairCount,
						pairs: hPairs,
					},
					workgroups: [Math.ceil(m / WORKGROUP)],
					writes: { pairCount: "atomic", pairs: "partial" },
				});
				const { data } = await graph.run(undefined, {
					buffers: {
						positions,
						offsets: cellOffsets,
						objects: objectIds,
						indexCount,
						indexOverflow,
						pairCount,
						pairs,
						params,
					},
					read: [
						{ buffer: indexCount, size: 4 },
						{ buffer: indexOverflow, size: 4 },
						{ buffer: pairCount, size: 4 },
						{ buffer: pairs, size: capacity * 8 },
					],
				});
				if (new Uint32Array(data[0])[0] !== m) return null; // points fell outside the domain
				if (new Uint32Array(data[1])[0] !== 0) return null;
				const found = new Uint32Array(data[2])[0];
				if (found > capacity) {
					if (found > MAX_GPU_PAIRS) return null;
					capacity = found;
					continue;
				}
				const raw = new Uint32Array(data[3], 0, found * 2);
				const left: number[] = [];
				const right: number[] = [];
				for (let k = 0; k < found; k++) {
					const i = ids[raw[2 * k]];
					const j = ids[raw[2 * k + 1]];
					// the exact test decides: the grid only proposes candidates
					if (distanceM(points[i], points[j]) < radiusM) {
						left.push(i);
						right.push(j);
					}
				}
				return packPairs(left, right, Math.max(1, points.length));
			} finally {
				graph.destroy();
			}
		}
		return null;
	});
}

/**
 * Neighbour pairs on the GPU when there is a compute device (and the pair list stays bounded),
 * otherwise the CPU twin. Same result either way.
 */
export async function neighbourPairs(
	points: readonly LatLon[],
	radiusM: number,
	device?: Device | null,
): Promise<NeighbourPairs> {
	let gpu: Device | null | undefined = device;
	if (gpu === undefined) {
		const { getComputeDevice } = await import("#/lib/gpu/device");
		gpu = await getComputeDevice();
	}
	if (gpu) {
		try {
			const pairs = await neighbourPairsGpu(gpu, points, radiusM);
			if (pairs) return pairs;
		} catch {
			// a lost or unsupported device: the CPU twin answers
		}
	}
	return neighbourPairsCpu(points, radiusM);
}
