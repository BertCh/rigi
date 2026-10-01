// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Graph inspection (core/inspect.ts, core/inspector.ts, core/profile.ts getGpuGraphProfile), node-only:
// a fake device and a fake compiled graph drive the real upstream GPUCommandGraphInspector.
// Run: npx tsx src/lib/gpu/core/inspect.check.ts
import type { Device } from "@luma.gl/core";
import { inspectGraphs, summarizeGraph } from "./inspect";
import { inspectorSnapshots, observeCompiledGraph } from "./inspector";
import type {
	CompiledGPUCommandGraph,
	GPUCommandGraphEncoding,
	GPUCommandGraphPreflightReport,
	GPUCommandGraphStats,
} from "./luma";
import { getGpuGraphProfile } from "./profile";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

const STATS: GPUCommandGraphStats = {
	nodeOrder: ["clear", "k1", "k2", "read"],
	importedBufferCount: 2,
	importedBufferBytes: 4096,
	logicalBufferCount: 5,
	logicalBufferBytes: 4096 + 3000,
	logicalTransientBufferCount: 3,
	physicalTransientBufferCount: 2,
	logicalTransientBytes: 3000,
	physicalTransientBytes: 2000,
	reusedTransientBytes: 1000,
	reusePercentage: 33.3,
	importedTextureCount: 0,
	importedTextureBytes: 0,
	logicalTextureCount: 0,
	logicalTextureBytes: 0,
	logicalTransientTextureCount: 0,
	physicalTransientTextureCount: 0,
	logicalTransientTextureBytes: 0,
	physicalTransientTextureBytes: 0,
	reusedTransientTextureBytes: 0,
} as GPUCommandGraphStats;

const node = (
	id: string,
	type: "compute" | "copy",
	extra: Record<string, unknown> = {},
) => ({
	id,
	type,
	commandCount: 1,
	maximumWorkgroupCount: 0,
	maximumInvocationCount: 0,
	readByteLength: 0,
	writeByteLength: 0,
	...extra,
});
const PREFLIGHT = {
	nodes: [
		node("clear", "copy"),
		node("k1", "compute", { maximumInvocationCount: 4096 }),
		node("k2", "compute", {
			condition: { id: "tail", source: "gpu", mode: "indirect" },
		}),
		node("read", "copy"),
	],
	annotatedNodeCount: 1,
	conditionalNodeCount: 1,
	commandCount: 4,
	maximumWorkgroupCount: 64,
	maximumInvocationCount: 4096,
	readByteLength: 0,
	writeByteLength: 0,
	largestBufferByteLength: 2048,
	largestStorageBufferBindingByteLength: 2048,
	maxBufferByteLength: 1 << 28,
	maxStorageBufferBindingByteLength: 1 << 27,
	fitsDeviceLimits: true,
} as unknown as GPUCommandGraphPreflightReport;

// a device that is lost on demand
let lose: () => void = () => {};
const device = {
	id: "fake-device",
	lost: new Promise<{ reason: "destroyed"; message: string }>((r) => {
		lose = () => r({ reason: "destroyed", message: "test" });
	}),
} as unknown as Device;

// ---- summarizeGraph (pure) ----
{
	const s = summarizeGraph({
		device,
		id: "g|k",
		group: "g",
		key: "k",
		cached: true,
		compiled: true,
		stats: STATS,
		preflight: PREFLIGHT,
	});
	check(
		"summary: node order = compiled order",
		s.nodes.map((n) => n.id).join() === "clear,k1,k2,read",
	);
	check(
		"summary: transient bytes and aliasing savings",
		s.transient.logicalBufferBytes === 3000 &&
			s.transient.physicalBufferBytes === 2000 &&
			s.transient.reusedBufferBytes === 1000 &&
			s.importedBufferBytes === 4096,
	);
	check(
		"summary: preflight fit and per-node workload / condition",
		s.preflight?.fitsDeviceLimits === true &&
			s.nodes[1].maximumInvocationCount === 4096 &&
			s.nodes[2].condition === "gpu indirect" &&
			s.nodes[0].condition === undefined,
	);
	check(
		"summary: unobserved graph has no samples",
		s.encodings === 0 &&
			s.totals.gpu.samples === 0 &&
			s.nodes[0].cpu.samples === 0,
	);
	const empty = summarizeGraph({
		device,
		id: "x",
		cached: true,
		compiled: false,
	});
	check(
		"summary: uncompiled graph",
		empty.nodeCount === 0 && !empty.preflight && empty.nodes.length === 0,
	);
}

// ---- observation through the real upstream inspector ----
const encodings: GPUCommandGraphEncoding[] = [];
const fakeEncoding = (gpu: number[]) => {
	const nodes = STATS.nodeOrder.map((id, i) => ({
		id,
		type: i === 0 || i === 3 ? "copy" : "compute",
		cpuEncodeTimeMilliseconds: 0.01 * (i + 1),
	}));
	const e = {
		stats: {
			cpuEncodeTimeMilliseconds: 0.1,
			nodeCount: nodes.length,
			skippedNodeCount: 0,
			computePassCount: 2,
			coalescedComputeNodeCount: 0,
			timestampedNodeCount: 2,
			nodes,
		},
		canReadGPUTimings: true,
		readTimings: async () => ({
			cpuEncodeTimeMilliseconds: 0.1,
			gpuTimeMilliseconds: gpu[0] + gpu[1],
			nodes: nodes.map((n, i) =>
				i === 1
					? { ...n, gpuTimeMilliseconds: gpu[0] }
					: i === 2
						? { ...n, gpuTimeMilliseconds: gpu[1] }
						: n,
			),
		}),
	} as unknown as GPUCommandGraphEncoding;
	encodings.push(e);
	return e;
};
let encodeCalls = 0;
let nextGpu = [1, 2];
const compiled = {
	device,
	id: "observed|n=4",
	stats: STATS,
	preflight: PREFLIGHT,
	capabilities: {
		timestampQueries: true,
		subgroups: false,
		subgroupId: false,
		softwareAdapter: false,
		maxBufferByteLength: 1 << 28,
		maxStorageBufferBindingByteLength: 1 << 27,
		maxComputeInvocationsPerWorkgroup: 256,
		maxComputeWorkgroupsPerDimension: 65535,
	},
	encode: () => {
		encodeCalls++;
		return fakeEncoding(nextGpu);
	},
} as unknown as CompiledGPUCommandGraph<void>;

check("no inspector before any observation", inspectorSnapshots().length === 0);
const obs = observeCompiledGraph(compiled);
const enc = {} as Parameters<typeof obs.encode>[0];
const e1 = obs.encode(enc, { parameters: undefined });
check("observation encodes through the compiled graph", encodeCalls === 1);
const r1 = await obs.recordGPUTimings(e1);
check("observation returns the timing report", r1?.gpuTimeMilliseconds === 3);
nextGpu = [3, 4];
const e2 = obs.encode(enc, { parameters: undefined });
await obs.recordGPUTimings(e2);
const again = await obs.recordGPUTimings(e2);
check(
	"a second timing read of one encoding is coalesced",
	again?.gpuTimeMilliseconds === 7,
);

const profile = await getGpuGraphProfile();
const p = profile.find((x) => x.graph === "observed|n=4");
check(
	"getGpuGraphProfile: whole graph from the snapshot",
	!!p &&
		p.device === "fake-device" &&
		p.encodings === 2 &&
		p.gpuMs === 3 &&
		p.gpuP95Ms === 7 &&
		p.transientBytes === 3000 &&
		p.reusedTransientBytes === 1000 &&
		p.fitsDeviceLimits === true,
	JSON.stringify(p),
);
check(
	"getGpuGraphProfile: per-node GPU p50 / p95",
	p?.nodes.k1.gpuMs === 1 &&
		p?.nodes.k1.gpuP95Ms === 3 &&
		p?.nodes.k2.gpuP95Ms === 4 &&
		p?.nodes.clear.gpuMs === undefined &&
		p?.nodes.clear.samples === 2,
	JSON.stringify(p?.nodes),
);

const rows = inspectGraphs({ observe: false });
const row = rows.find((r) => r.id === "observed|n=4");
check(
	"inspectGraphs: an observed graph outside the cache is listed",
	!!row &&
		!row.cached &&
		row.encodings === 2 &&
		row.nodes.length === 4 &&
		row.nodes[2].gpu.p95Ms === 4 &&
		row.transient.reusedBufferBytes === 1000 &&
		row.preflight?.fitsDeviceLimits === true,
);

obs.detach();
check(
	"detach removes the registration",
	!inspectGraphs({ observe: false }).some((r) => r.id === "observed|n=4"),
);

observeCompiledGraph(compiled);
lose();
await new Promise((r) => setTimeout(r, 0));
check("device loss drops its inspector", inspectorSnapshots().length === 0);

console.log(failures ? `${failures} FAIL` : "inspect.check: all passed");
process.exit(failures ? 1 : 0);
