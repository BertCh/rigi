// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// "Who sees here": which photos' view wedges contain a ground point. GPU: luma GPUBVH over the wedge
// boxes (float32x2 minima/maxima, built once per roll into persistent buffers), GPUBVHQuery kind
// "point" per click returns candidate ids, and an exact CPU wedge test (bearing and range) filters
// them, since a box is a superset of its wedge. CPU twin: the same exact test over every photo.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "../../gpu/core/graph";
import { GPUBVH, GPUBVHQuery } from "../../gpu/core/luma";
import { withLease } from "../../gpu/core/pool";
import { getComputeDevice } from "../../gpu/device";
import {
	type CoveragePhoto,
	type Frame,
	frameAround,
	type Wedge,
	type WedgeOptions,
	wedgeBounds,
	wedgeContains,
	wedgesOf,
} from "./frame";

export type WhoSeesResult = {
	/** indices into the photo array, ascending */
	indices: number[];
	backend: "gpu" | "cpu";
	/** BVH leaves the point fell in before the exact wedge test (cpu: every photo) */
	candidates: number;
	/** the BVH reported more matches than it could store (should not happen: capacity = leaves) */
	overflow: boolean;
};

export type WhoSeesOptions = WedgeOptions & {
	frame?: Frame;
	/** compute device; undefined = getComputeDevice(), null = CPU */
	device?: Device | null;
};

/** A roll's wedges ready to query; `destroy()` frees the GPU buffers. */
export type WedgeIndex = {
	backend: "gpu" | "cpu";
	frame: Frame;
	wedges: Wedge[];
	query(point: { x: number; y: number }): Promise<WhoSeesResult>;
	destroy(): void;
};

const BOX_PAD_M = 1; // f32 rounding of box corners must never drop a wedge the exact test accepts
const EMPTY = 1e30;
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;

const leafCapacityFor = (count: number) =>
	2 ** Math.ceil(Math.log2(Math.max(2, count)));

/** Brute-force exact test over all wedges (the CPU twin, and the reference for the Dawn check). */
export function whoSeesCpu(
	wedges: readonly Wedge[],
	point: { x: number; y: number },
): WhoSeesResult {
	const indices: number[] = [];
	for (const w of wedges)
		if (wedgeContains(w, point.x, point.y)) indices.push(w.index);
	return {
		indices,
		backend: "cpu",
		candidates: wedges.length,
		overflow: false,
	};
}

type IndexBuffers = Record<
	| "bmin"
	| "bmax"
	| "nodeMin"
	| "nodeMax"
	| "children"
	| "leafIds"
	| "count"
	| "overflow"
	| "query",
	Buffer
>;

/** The BVH build graph and the point-query graph of one leaf capacity (cached, both over imported buffers). */
function graphsFor(device: Device, leaves: number) {
	const nodes = 2 * leaves - 1;
	const declare = (
		g: import("../../gpu/core/graph").ComputeGraph<undefined>,
	) => ({
		bmin: g.importBuffer("bmin", leaves * 8),
		bmax: g.importBuffer("bmax", leaves * 8),
		nodeMin: g.importBuffer("nodeMin", nodes * 8),
		nodeMax: g.importBuffer("nodeMax", nodes * 8),
		children: g.importBuffer("children", nodes * 8),
		leafIds: g.importBuffer("leafIds", leaves * 4),
		count: g.importBuffer("count", 16),
		overflow: g.importBuffer("overflow", 16),
	});
	const build = cachedGraph<undefined, undefined>(
		device,
		"roll-who",
		`build|${leaves}`,
		(g) => {
			const b = declare(g);
			g.add(
				new GPUBVH({
					id: "wedge-bvh",
					minima: g.graph.createDataView(b.bmin, {
						format: "float32x2",
						length: leaves,
					}),
					maxima: g.graph.createDataView(b.bmax, {
						format: "float32x2",
						length: leaves,
					}),
					leafCapacity: leaves,
					nodeMinima: g.graph.createDataView(b.nodeMin, {
						format: "float32x2",
						length: nodes,
					}),
					nodeMaxima: g.graph.createDataView(b.nodeMax, {
						format: "float32x2",
						length: nodes,
					}),
					nodeChildren: g.graph.createDataView(b.children, {
						format: "uint32x2",
						length: nodes,
					}),
					leafIds: g.view(b.leafIds, "uint32", leaves),
					count: g.view(b.count, "uint32", 1),
					overflow: g.view(b.overflow, "uint32", 1),
				}),
			);
			return undefined;
		},
	);
	const query = cachedGraph<undefined, undefined>(
		device,
		"roll-who",
		`query|${leaves}`,
		(g) => {
			const b = declare(g);
			const point = g.importBuffer("query", 16);
			const outCount = g.transientBuffer("outCount", 16);
			const outOverflow = g.transientBuffer("outOverflow", 16);
			const output = g.transientBuffer("output", leaves * 4);
			g.clearNode("zero-count", outCount);
			g.clearNode("zero-overflow", outOverflow);
			g.add(
				new GPUBVHQuery({
					id: "wedge-query",
					kind: "point",
					bvh: {
						leafCapacity: leaves,
						nodeMinima: g.graph.createDataView(b.nodeMin, {
							format: "float32x2",
							length: nodes,
						}),
						nodeMaxima: g.graph.createDataView(b.nodeMax, {
							format: "float32x2",
							length: nodes,
						}),
						nodeChildren: g.graph.createDataView(b.children, {
							format: "uint32x2",
							length: nodes,
						}),
						leafIds: g.view(b.leafIds, "uint32", leaves),
						overflow: g.view(b.overflow, "uint32", 1),
					},
					query: g.view(point, "float32", 2),
					output: g.view(output, "uint32", leaves),
					count: g.view(outCount, "uint32", 1),
					overflow: g.view(outOverflow, "uint32", 1),
				}),
			);
			g.readNode("hits", [
				outCount,
				outOverflow,
				{ buffer: output, size: leaves * 4 },
			]);
			return undefined;
		},
	);
	return { build, query };
}

/** Index the wedges: GPU BVH when `device` is given, else the brute-force CPU twin. */
export async function createWedgeIndex(
	wedges: Wedge[],
	frame: Frame,
	device: Device | null,
): Promise<WedgeIndex> {
	if (!device || !wedges.length) {
		return {
			backend: "cpu",
			frame,
			wedges,
			query: async (point) => whoSeesCpu(wedges, point),
			destroy() {},
		};
	}
	const leaves = leafCapacityFor(wedges.length);
	const nodes = 2 * leaves - 1;
	const make = (id: string, bytes: number) =>
		device.createBuffer({
			id: `roll-who:${id}`,
			usage: STORAGE,
			byteLength: bytes,
		});
	const buffers: IndexBuffers = {
		bmin: make("bmin", leaves * 8),
		bmax: make("bmax", leaves * 8),
		nodeMin: make("nodeMin", nodes * 8),
		nodeMax: make("nodeMax", nodes * 8),
		children: make("children", nodes * 8),
		leafIds: make("leafIds", leaves * 4),
		count: make("count", 16),
		overflow: make("overflow", 16),
		query: make("query", 16),
	};
	const minima = new Float32Array(leaves * 2).fill(EMPTY);
	const maxima = new Float32Array(leaves * 2).fill(-EMPTY);
	for (const w of wedges) {
		const b = wedgeBounds(w);
		minima.set([b.minX - BOX_PAD_M, b.minY - BOX_PAD_M], w.index * 2);
		maxima.set([b.maxX + BOX_PAD_M, b.maxY + BOX_PAD_M], w.index * 2);
	}
	buffers.bmin.write(minima);
	buffers.bmax.write(maxima);
	const graphs = graphsFor(device, leaves);
	await withLease("roll-who", () =>
		graphs.build.graph.run(undefined, {
			// the build graph imports every buffer but the query point; extra names are rejected
			buffers: Object.fromEntries(
				Object.entries(buffers).filter(([name]) => name !== "query"),
			),
		}),
	);
	let destroyed = false;
	return {
		backend: "gpu",
		frame,
		wedges,
		async query(point) {
			if (destroyed) return whoSeesCpu(wedges, point);
			const { reads } = await withLease("roll-who", async () => {
				buffers.query.write(new Float32Array([point.x, point.y, 0, 0]));
				return graphs.query.graph.run(undefined, {
					buffers: buffers as unknown as Record<string, Buffer>,
				});
			});
			const [countBytes, overflowBytes, ids] = reads.hits;
			const count = new Uint32Array(countBytes)[0];
			const overflow = new Uint32Array(overflowBytes)[0] !== 0;
			const stored = new Uint32Array(ids, 0, Math.min(count, leaves));
			const indices: number[] = [];
			for (const id of stored) {
				const w = id < wedges.length ? wedges[id] : null;
				if (w && wedgeContains(w, point.x, point.y)) indices.push(id);
			}
			indices.sort((a, b) => a - b);
			return { indices, backend: "gpu", candidates: count, overflow };
		},
		destroy() {
			destroyed = true;
			for (const b of Object.values(buffers)) b.destroy();
		},
	};
}

const indexCache = new WeakMap<readonly CoveragePhoto[], Promise<WedgeIndex>>();

/** Index of a roll's photos on the compute device (or CPU), reused for the same array (and radius). */
export async function whoSeesIndex(
	photos: readonly CoveragePhoto[],
	opts: WhoSeesOptions = {},
): Promise<WedgeIndex> {
	const frame = opts.frame ?? frameAround(photos);
	const device =
		opts.device === undefined ? await getComputeDevice() : opts.device;
	const wedges = wedgesOf(photos, frame, opts);
	return createWedgeIndex(wedges, frame, device);
}

/**
 * Which photos see the ground point (lat, lon)? Builds the index once per `photos` array (cached
 * weakly; pass a new array after the roll changes) and queries it.
 */
export async function whoSees(
	photos: readonly CoveragePhoto[],
	point: { lat: number; lon: number },
	opts: WhoSeesOptions = {},
): Promise<WhoSeesResult> {
	let index = indexCache.get(photos);
	if (!index) {
		index = whoSeesIndex(photos, opts);
		indexCache.set(photos, index);
	}
	const built = await index;
	const frame = built.frame;
	const x = (point.lon - frame.lon0) * frame.metresPerDegLon;
	const y = (point.lat - frame.lat0) * frame.metresPerDegLat;
	return built.query({ x, y });
}
