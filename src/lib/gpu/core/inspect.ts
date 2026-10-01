// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Graph inspection over every cachedGraph (WAG W0.2): the upstream preflight (fitsDeviceLimits,
// workload bounds), the compile stats (transient bytes, aliasing savings) and the upstream
// GPUCommandGraphInspector's samples (per-node CPU encode / GPU times, core/inspector.ts), joined per
// graph. For the /dev/graph page and core/profile.ts getGpuGraphProfile().
//
//   const rows = inspectGraphs();            // this realm's live graphs, every device
//   const rows = inspectGraphs({ device });  // one device
//
// inspectGraphs() starts observing every compiled cached graph it lists (opt-in by calling it), so
// later encodes of those graphs are recorded; it never compiles or runs anything. Graphs in worker
// realms (horizon-fast, unknown-pose, eye, sky, ridgelines) are invisible here: the app graph
// manifest (src/lib/gpu/app-graph) declares them.
//
// summarizeGraph() is pure (node check: core/inspect.check.ts).
import type { Device } from "@luma.gl/core";
import { listCachedGraphs } from "./graph";
import { inspectorSnapshots } from "./inspector";
import type {
	GPUCommandGraphInspectorDurationSnapshot,
	GPUCommandGraphInspectorGraphSnapshot,
	GPUCommandGraphPreflightReport,
	GPUCommandGraphStats,
} from "./luma";

/** A duration summary (ms): latest / p50 / p95 over the retained samples. */
export type DurationSummary = {
	samples: number;
	latestMs?: number;
	p50Ms?: number;
	p95Ms?: number;
};

/** One scheduled node of an inspected graph. */
export type NodeInspection = {
	id: string;
	type?: string;
	cpu: DurationSummary;
	gpu: DurationSummary;
	/** the node's preflight workload bounds, when it declared any (KernelNode.workload) */
	maximumInvocationCount?: number;
	/** the node's condition from preflight: "cpu skip" or "gpu indirect" */
	condition?: string;
};

/** One graph, as inspectGraphs() reports it. */
export type GraphInspection = {
	device: Device;
	/** the ComputeGraph id (`${group}|${key}` for cached graphs) */
	id: string;
	/** cachedGraph group and key (undefined: a graph observed outside the cache) */
	group?: string;
	key?: string;
	cached: boolean;
	compiled: boolean;
	nodeCount: number;
	transient: {
		logicalBufferBytes: number;
		physicalBufferBytes: number;
		/** logical bytes avoided by lifetime aliasing */
		reusedBufferBytes: number;
		reusePercentage: number;
		logicalBufferCount: number;
		physicalBufferCount: number;
		logicalTextureBytes: number;
		physicalTextureBytes: number;
		reusedTextureBytes: number;
	};
	importedBufferBytes: number;
	importedTextureBytes: number;
	preflight?: {
		fitsDeviceLimits: boolean;
		largestBufferByteLength: number;
		maxBufferByteLength: number;
		largestStorageBufferBindingByteLength: number;
		maxStorageBufferBindingByteLength: number;
		annotatedNodeCount: number;
		conditionalNodeCount: number;
		maximumInvocationCount: number;
		maximumWorkgroupCount: number;
	};
	/** encodings recorded since the graph was observed (0: not observed or not encoded since) */
	encodings: number;
	totals: { cpu: DurationSummary; gpu: DurationSummary };
	nodes: NodeInspection[];
};

const summary = (
	d: GPUCommandGraphInspectorDurationSnapshot | undefined,
): DurationSummary => ({
	samples: d?.sampleCount ?? 0,
	...(d?.latestMilliseconds !== undefined
		? { latestMs: d.latestMilliseconds }
		: {}),
	...(d?.p50Milliseconds !== undefined ? { p50Ms: d.p50Milliseconds } : {}),
	...(d?.p95Milliseconds !== undefined ? { p95Ms: d.p95Milliseconds } : {}),
});

/**
 * Join one graph's compile stats, preflight and inspector snapshot (any may be missing) into a
 * GraphInspection. Nodes follow the compiled order, then any node only the snapshot knows.
 */
export function summarizeGraph(input: {
	device: Device;
	id: string;
	group?: string;
	key?: string;
	cached: boolean;
	compiled: boolean;
	stats?: Readonly<Omit<GPUCommandGraphStats, "nodeOrder">> & {
		readonly nodeOrder: readonly string[];
	};
	preflight?: GPUCommandGraphPreflightReport;
	snapshot?: GPUCommandGraphInspectorGraphSnapshot;
}): GraphInspection {
	const stats = input.stats ?? input.snapshot?.stats;
	const preflight = input.preflight ?? input.snapshot?.preflight;
	const sampled = new Map(input.snapshot?.nodes.map((n) => [n.id, n]) ?? []);
	const planned = new Map(preflight?.nodes.map((n) => [n.id, n]) ?? []);
	const order = [...(stats?.nodeOrder ?? [])];
	for (const id of sampled.keys()) if (!order.includes(id)) order.push(id);
	const nodes = order.map((id): NodeInspection => {
		const s = sampled.get(id);
		const p = planned.get(id);
		const condition = p?.condition
			? `${p.condition.source} ${p.condition.mode}`
			: undefined;
		return {
			id,
			...(s?.type || p?.type ? { type: s?.type ?? p?.type } : {}),
			cpu: summary(s?.cpu),
			gpu: summary(s?.gpu),
			...(p && p.maximumInvocationCount > 0
				? { maximumInvocationCount: p.maximumInvocationCount }
				: {}),
			...(condition ? { condition } : {}),
		};
	});
	return {
		device: input.device,
		id: input.id,
		...(input.group !== undefined ? { group: input.group } : {}),
		...(input.key !== undefined ? { key: input.key } : {}),
		cached: input.cached,
		compiled: input.compiled,
		nodeCount: stats?.nodeOrder.length ?? 0,
		transient: {
			logicalBufferBytes: stats?.logicalTransientBytes ?? 0,
			physicalBufferBytes: stats?.physicalTransientBytes ?? 0,
			reusedBufferBytes: stats?.reusedTransientBytes ?? 0,
			reusePercentage: stats?.reusePercentage ?? 0,
			logicalBufferCount: stats?.logicalTransientBufferCount ?? 0,
			physicalBufferCount: stats?.physicalTransientBufferCount ?? 0,
			logicalTextureBytes: stats?.logicalTransientTextureBytes ?? 0,
			physicalTextureBytes: stats?.physicalTransientTextureBytes ?? 0,
			reusedTextureBytes: stats?.reusedTransientTextureBytes ?? 0,
		},
		importedBufferBytes: stats?.importedBufferBytes ?? 0,
		importedTextureBytes: stats?.importedTextureBytes ?? 0,
		...(preflight
			? {
					preflight: {
						fitsDeviceLimits: preflight.fitsDeviceLimits,
						largestBufferByteLength: preflight.largestBufferByteLength,
						maxBufferByteLength: preflight.maxBufferByteLength,
						largestStorageBufferBindingByteLength:
							preflight.largestStorageBufferBindingByteLength,
						maxStorageBufferBindingByteLength:
							preflight.maxStorageBufferBindingByteLength,
						annotatedNodeCount: preflight.annotatedNodeCount,
						conditionalNodeCount: preflight.conditionalNodeCount,
						maximumInvocationCount: preflight.maximumInvocationCount,
						maximumWorkgroupCount: preflight.maximumWorkgroupCount,
					},
				}
			: {}),
		encodings: input.snapshot?.encodingCount ?? 0,
		totals: {
			cpu: summary(input.snapshot?.totals.cpu),
			gpu: summary(input.snapshot?.totals.gpu),
		},
		nodes,
	};
}

/**
 * Every live graph of this realm: the cached graphs of `device` (every device with a cache when
 * omitted), plus graphs observed outside the cache (profiled ComputeGraphs). `observe` (default
 * true) starts observing each compiled cached graph, so later encodes are recorded. Read-only
 * otherwise: no compile, no run, LRU order untouched.
 */
export function inspectGraphs(
	opts: { device?: Device; observe?: boolean } = {},
): GraphInspection[] {
	const cached = listCachedGraphs(opts.device);
	if (opts.observe !== false)
		for (const c of cached) if (c.compiled) c.graph.inspect();
	const snaps = new Map<
		Device,
		Map<string, GPUCommandGraphInspectorGraphSnapshot>
	>();
	for (const { device, snapshot } of inspectorSnapshots(opts.device))
		snaps.set(device, new Map(snapshot.graphs.map((g) => [g.id, g])));
	const out: GraphInspection[] = [];
	const seen = new Set<string>();
	for (const c of cached) {
		const snapshot = snaps.get(c.device)?.get(c.id);
		seen.add(`${c.device.id}\u0000${c.id}`);
		out.push(
			summarizeGraph({
				device: c.device,
				id: c.id,
				group: c.group,
				key: c.key,
				cached: true,
				compiled: c.compiled,
				stats: c.stats,
				preflight: c.graph.preflight,
				snapshot,
			}),
		);
	}
	for (const [device, graphs] of snaps)
		for (const [id, snapshot] of graphs)
			if (!seen.has(`${device.id}\u0000${id}`))
				out.push(
					summarizeGraph({
						device,
						id,
						cached: false,
						compiled: true,
						snapshot,
					}),
				);
	return out;
}
