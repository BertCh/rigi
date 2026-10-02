// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll coverage heat grid: how many photos look over each ground cell. One ComputeGraph on the compute
// device: a kernel turns the per-photo wedge parameters into AZIMUTH x RANGE ground samples (float32x2
// positions + area weights), luma GPUGridAggregation ("sum", literal bounds) bins them into the grid,
// a read node returns it. The CPU twin makes the same samples (frame.ts wedgeSamples) and bins them in
// JS; no device (WebGL render, ?gpu=off) uses it. Display-only.
import type { Device } from "@luma.gl/core";
import { cachedGraph } from "../../gpu/core/graph";
import { defineKernel } from "../../gpu/core/kernel";
import { GPUGridAggregation } from "../../gpu/core/luma";
import { pooledStorage, withLease } from "../../gpu/core/pool";
import { getComputeDevice } from "../../gpu/device";
import {
	AZIMUTH_SAMPLES,
	type CoveragePhoto,
	type Frame,
	frameAround,
	RANGE_SAMPLES,
	SAMPLES_PER_WEDGE,
	type Wedge,
	type WedgeOptions,
	wedgeSamples,
	wedgesOf,
} from "./frame";

export type CoverageGridOptions = WedgeOptions & {
	/** cells per side (default 128) */
	gridSize?: number;
	/** metric frame (default: around the photos) */
	frame?: Frame;
	/** compute device; undefined = getComputeDevice(), null = CPU twin */
	device?: Device | null;
};

export type CoverageGrid = {
	/** row-major `size` x `size`, row 0 = southmost; each cell about the number of photos whose wedge covers it */
	data: Float32Array;
	size: number;
	/** frame metres of the grid square */
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	frame: Frame;
	backend: "gpu" | "cpu";
	/** sum of all cells */
	total: number;
	/** largest cell */
	max: number;
};

/** Grid bounds snap to this many metres so the cached graph (literal bounds) is reused. */
const BOUNDS_SNAP_M = 250;
/** Largest photo capacity of the GPU path (positions 8 B + weight 4 B per sample must fit one binding). */
const MAX_GPU_CAPACITY = 1024;
const WORKGROUP = 64;
const MAX_WORKGROUPS_X = 32768;

/** Square ground domain holding every wedge, snapped outwards to BOUNDS_SNAP_M. */
export function coverageBounds(wedges: readonly Wedge[]) {
	let minX = 0;
	let minY = 0;
	let maxX = 0;
	let maxY = 0;
	wedges.forEach((w, i) => {
		const x0 = w.x - w.radius;
		const x1 = w.x + w.radius;
		const y0 = w.y - w.radius;
		const y1 = w.y + w.radius;
		minX = i ? Math.min(minX, x0) : x0;
		maxX = i ? Math.max(maxX, x1) : x1;
		minY = i ? Math.min(minY, y0) : y0;
		maxY = i ? Math.max(maxY, y1) : y1;
	});
	const q = BOUNDS_SNAP_M;
	const x0 = Math.floor(minX / q) * q;
	const y0 = Math.floor(minY / q) * q;
	const side = Math.max(q, Math.ceil(Math.max(maxX - x0, maxY - y0) / q) * q);
	return { minX: x0, minY: y0, maxX: x0 + side, maxY: y0 + side };
}

const photoCapacity = (count: number) =>
	2 ** Math.ceil(Math.log2(Math.max(8, count)));

const K_SAMPLES = defineKernel(
	"roll-coverage-samples",
	/* wgsl */ `
const AZ = ${AZIMUTH_SAMPLES}u;
const RG = ${RANGE_SAMPLES}u;
const PER = ${SAMPLES_PER_WEDGE}u;
// two vec4 per photo: (x, y, yaw, halfAngle) metres/radians, (weightScale, radius, 0, 0)
@group(0) @binding(0) var<storage, read> photos: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> positions: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> weights: array<f32>;
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
	let i = gid.y * nwg.x * ${WORKGROUP}u + gid.x;
	if (i >= arrayLength(&weights)) { return; }
	let photo = i / PER;
	let k = i % PER;
	let ri = k / AZ;
	let ai = k % AZ;
	let a = photos[photo * 2u];
	let b = photos[photo * 2u + 1u];
	let r = (f32(ri) + 0.5) / f32(RG) * b.y;
	let stagger = select(0.25, 0.75, (ri & 1u) == 1u);
	let theta = a.z + ((f32(ai) + stagger) / f32(AZ) - 0.5) * 2.0 * a.w;
	positions[i] = vec2<f32>(a.x + r * sin(theta), a.y + r * cos(theta));
	weights[i] = b.x * r;
}
`,
	[
		["photos", "read-only-storage"],
		["positions", "storage"],
		["weights", "storage"],
	],
	{ group: "roll-coverage" },
);

type GridBounds = ReturnType<typeof coverageBounds>;

function buildGraph(
	device: Device,
	capacity: number,
	size: number,
	bounds: GridBounds,
) {
	const key = `${capacity}|${size}|${bounds.minX},${bounds.minY},${bounds.maxX},${bounds.maxY}`;
	return cachedGraph<undefined, undefined>(
		device,
		"roll-coverage",
		key,
		(g) => {
			const total = capacity * SAMPLES_PER_WEDGE;
			const photos = g.importBuffer("photos", capacity * 32);
			const positions = g.transientBuffer("positions", total * 8);
			const weights = g.transientBuffer("weights", total * 4);
			const grid = g.transientBuffer("grid", size * size * 4);
			const groups = Math.ceil(total / WORKGROUP);
			const x = Math.min(groups, MAX_WORKGROUPS_X);
			g.addKernel({
				id: "samples",
				spec: K_SAMPLES,
				bindings: { photos, positions, weights },
				workgroups: [x, Math.ceil(groups / x)],
			});
			g.add(
				new GPUGridAggregation({
					id: "coverage-bin",
					positions: g.graph.createDataView(positions, {
						format: "float32x2",
						length: total,
					}),
					weights: g.view(weights, "float32", total),
					output: g.view(grid, "float32", size * size),
					operation: "sum",
					gridSize: [size, size],
					bounds: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
				}),
			);
			g.readNode("grid", [grid]);
			return undefined;
		},
	);
}

function finish(
	data: Float32Array,
	size: number,
	bounds: GridBounds,
	frame: Frame,
	backend: "gpu" | "cpu",
): CoverageGrid {
	let total = 0;
	let max = 0;
	for (const v of data) {
		total += v;
		if (v > max) max = v;
	}
	return { data, size, bounds, frame, backend, total, max };
}

/** CPU twin: the same samples as the kernel, binned in JS (out-of-bounds samples are dropped). */
export function coverageGridCpu(
	photos: readonly CoveragePhoto[],
	opts: CoverageGridOptions = {},
): CoverageGrid {
	const size = opts.gridSize ?? 128;
	const frame = opts.frame ?? frameAround(photos);
	const wedges = wedgesOf(photos, frame, opts);
	const bounds = coverageBounds(wedges);
	const side = bounds.maxX - bounds.minX;
	const cellArea = (side / size) ** 2;
	const { positions, weights } = wedgeSamples(wedges, cellArea);
	const data = new Float32Array(size * size);
	for (let i = 0; i < weights.length; i++) {
		const u = (positions[2 * i] - bounds.minX) / side;
		const v = (positions[2 * i + 1] - bounds.minY) / side;
		if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue;
		data[
			Math.min(size - 1, Math.floor(v * size)) * size +
				Math.min(size - 1, Math.floor(u * size))
		] += weights[i];
	}
	return finish(data, size, bounds, frame, "cpu");
}

/** The GPU path on an explicit device (the Dawn check and the wrapper use it). */
export async function coverageGridGpu(
	device: Device,
	photos: readonly CoveragePhoto[],
	opts: CoverageGridOptions = {},
): Promise<CoverageGrid> {
	const size = opts.gridSize ?? 128;
	const frame = opts.frame ?? frameAround(photos);
	const wedges = wedgesOf(photos, frame, opts);
	const bounds = coverageBounds(wedges);
	const side = bounds.maxX - bounds.minX;
	const cellArea = (side / size) ** 2;
	const capacity = photoCapacity(wedges.length);
	const params = new Float32Array(capacity * 8);
	wedges.forEach((w, i) => {
		const dr = w.radius / RANGE_SAMPLES;
		const dtheta = (2 * w.halfRad) / AZIMUTH_SAMPLES;
		params.set(
			[
				w.x,
				w.y,
				w.yawRad,
				w.halfRad,
				(w.weight * dr * dtheta) / cellArea,
				w.radius,
				0,
				0,
			],
			i * 8,
		);
	});
	return withLease("roll-coverage", async () => {
		const entry = buildGraph(device, capacity, size, bounds);
		const photosBuffer = pooledStorage(device, "roll-coverage:photos", params);
		const { reads } = await entry.graph.run(undefined, {
			buffers: { photos: photosBuffer },
		});
		return finish(new Float32Array(reads.grid[0]), size, bounds, frame, "gpu");
	});
}

/**
 * Coverage heat grid of `photos`: GPU when the compute device exists (and the roll fits one binding),
 * else the CPU twin. `backend` says which ran.
 */
export async function coverageGrid(
	photos: readonly CoveragePhoto[],
	opts: CoverageGridOptions = {},
): Promise<CoverageGrid> {
	const device =
		opts.device === undefined ? await getComputeDevice() : opts.device;
	if (!device || photoCapacity(photos.length) > MAX_GPU_CAPACITY)
		return coverageGridCpu(photos, opts);
	return coverageGridGpu(device, photos, opts);
}
