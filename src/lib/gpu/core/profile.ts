// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Optional GPU timestamp profiling. Off unless `globalThis.__RIGI_GPU_PROFILE__ = true` (read live,
// per realm) and the device has 'timestamp-query'. When off, passProps() returns a shared empty
// object: no query sets, no extra work.
//
// When on, each profiled compute pass gets a 2-slot timestamp QuerySet (pooled per device); after
// core submit() the durations are read asynchronously and summed per label. getGpuProfile() gives
// { [label]: { gpuMs, count } } for this realm plus the GPU workers' reports merged into it.
//
// Workers: kernels in the app's GPU workers (horizon-fast-app, unknown-pose, eye suggest) run in
// their own realm. core/realm.ts carries the page's switch to them on their existing messages; each
// worker hands back takeGpuProfile() with its result, and the page's worker client adds it here with
// mergeGpuProfile(realm, p) as `${realm}:${label}` (e.g. "horizon-worker:horizon-march").
//
// Per graph (WAG W0.2): getGpuGraphProfile() reads the upstream GPUCommandGraphInspector snapshots
// (core/inspector.ts; graphs are observed while profiling is on, or once /dev/graph inspected them):
// per-node CPU encode and GPU p50 / p95, transient bytes, aliasing savings and the preflight fit,
// which the flat label totals above cannot carry. This realm only (worker graphs are not merged).
// core/inspector.ts registers the snapshot source, so this file stays free of luma runtime imports.
import type { ComputePassProps, Device, QuerySet } from "@luma.gl/core";
import { onLost, untilLost } from "./lifecycle";
import type { GPUCommandGraphInspectorSnapshot } from "./luma";

declare global {
	var __RIGI_GPU_PROFILE__: boolean | undefined;
}

export type GpuProfile = Record<string, { gpuMs: number; count: number }>;

const EMPTY: ComputePassProps = Object.freeze({}) as ComputePassProps;

let totals: GpuProfile = {};
const free = new WeakMap<Device, QuerySet[]>();
const pending = new WeakMap<Device, { label: string; qs: QuerySet }[]>();
const reads = new Set<Promise<void>>();

/** Whether profiling is on for `device` right now. */
export const profiling = (device: Device) =>
	globalThis.__RIGI_GPU_PROFILE__ === true &&
	device.features.has("timestamp-query");

/**
 * Props for `enc.beginComputePass(...)`: timestamp writes labelled `label` when profiling is on,
 * else an empty object. The pass must be submitted through core submit() to be counted.
 */
export function passProps(device: Device, label: string): ComputePassProps {
	if (!profiling(device)) return EMPTY;
	const qs =
		free.get(device)?.pop() ??
		device.createQuerySet({ type: "timestamp", count: 2 });
	let p = pending.get(device);
	if (!p) {
		p = [];
		pending.set(device, p);
		onLost(device, () => {
			pending.delete(device);
			free.delete(device);
		});
	}
	p.push({ label, qs });
	return {
		id: label,
		timestampQuerySet: qs,
		beginTimestampIndex: 0,
		endTimestampIndex: 1,
	};
}

/** Add a measured duration (graph.ts reports per-node timings through this). */
export function recordGpuTime(label: string, ms: number) {
	if (!Number.isFinite(ms) || ms < 0) return;
	const t = totals[label] ?? { gpuMs: 0, count: 0 };
	t.gpuMs += ms;
	t.count++;
	totals[label] = t;
}

/** @internal core/queue.ts: after a submit, read this device's pending pass timestamps. */
export function afterSubmit(device: Device) {
	const p = pending.get(device);
	if (!p?.length) return;
	pending.set(device, []);
	for (const { label, qs } of p) {
		// a lost device may never answer: untilLost keeps getGpuProfile() from waiting forever
		const r = untilLost(device, qs.readTimestampDuration(0, 1))
			.then((ms) => recordGpuTime(label, ms))
			.catch(() => {})
			.finally(() => {
				reads.delete(r);
				if (device.isLost) return;
				let f = free.get(device);
				if (!f) {
					f = [];
					free.set(device, f);
				}
				f.push(qs);
			});
		reads.add(r);
	}
}

/** Per-label GPU time so far (waits for in-flight timestamp reads first). */
export async function getGpuProfile(): Promise<GpuProfile> {
	await Promise.all([...reads]);
	return structuredClone(totals);
}

/** Clear the totals. */
export function resetGpuProfile() {
	totals = {};
}

/** Whether this realm profiles (the page's switch; a worker gets it through core/realm.ts). */
export const profileRequested = () => globalThis.__RIGI_GPU_PROFILE__ === true;

/**
 * For a worker's result message: this realm's totals so far, then cleared (so the page never counts
 * a pass twice). undefined, without waiting on anything, when profiling is off.
 */
export function takeGpuProfile(): Promise<GpuProfile> | undefined {
	if (!profileRequested()) return undefined;
	return getGpuProfile().then((p) => {
		for (const k of Object.keys(p)) {
			const t = totals[k];
			if (!t) continue;
			// passes that finished while we waited stay for the next report
			t.gpuMs -= p[k].gpuMs;
			t.count -= p[k].count;
			if (t.count <= 0) delete totals[k];
		}
		return p;
	});
}

/** Page side: add a worker's report as `${realm}:${label}`. No-op for undefined. */
export function mergeGpuProfile(realm: string, p: GpuProfile | undefined) {
	if (!p) return;
	for (const [label, v] of Object.entries(p)) {
		const k = `${realm}:${label}`;
		const t = totals[k] ?? { gpuMs: 0, count: 0 };
		t.gpuMs += v.gpuMs;
		t.count += v.count;
		totals[k] = t;
	}
}

/** One observed graph's inspector summary (getGpuGraphProfile). Durations are p50 / p95 in ms. */
export type GpuGraphProfileEntry = {
	/** the device's luma id (graphs of several devices may share an id) */
	device: string;
	graph: string;
	encodings: number;
	cpuEncodeMs?: number;
	gpuMs?: number;
	gpuP95Ms?: number;
	transientBytes: number;
	physicalTransientBytes: number;
	/** transient bytes saved by lifetime aliasing */
	reusedTransientBytes: number;
	fitsDeviceLimits?: boolean;
	nodes: Record<
		string,
		{ samples: number; cpuEncodeMs?: number; gpuMs?: number; gpuP95Ms?: number }
	>;
};

type SnapshotSource = () => {
	device: Device;
	snapshot: GPUCommandGraphInspectorSnapshot;
}[];
let snapshotSource: SnapshotSource | null = null;

/** @internal core/inspector.ts: where getGpuGraphProfile() reads the inspector snapshots. */
export function setGraphSnapshotSource(source: SnapshotSource) {
	snapshotSource = source;
}

/**
 * Per observed graph of this realm, from the upstream inspector's snapshot: encode count, CPU encode
 * and GPU p50 (whole graph and per node), GPU p95, transient bytes and aliasing savings, preflight fit.
 * Empty when nothing was observed (profiling off and /dev/graph never opened).
 */
export async function getGpuGraphProfile(): Promise<GpuGraphProfileEntry[]> {
	await Promise.all([...reads]);
	const out: GpuGraphProfileEntry[] = [];
	for (const { device, snapshot } of snapshotSource?.() ?? [])
		for (const g of snapshot.graphs) {
			const nodes: GpuGraphProfileEntry["nodes"] = {};
			for (const n of g.nodes)
				nodes[n.id] = {
					samples: Math.max(n.cpu.sampleCount, n.gpu.sampleCount),
					cpuEncodeMs: n.cpu.p50Milliseconds,
					gpuMs: n.gpu.p50Milliseconds,
					gpuP95Ms: n.gpu.p95Milliseconds,
				};
			out.push({
				device: device.id,
				graph: g.id,
				encodings: g.encodingCount,
				cpuEncodeMs: g.totals.cpu.p50Milliseconds,
				gpuMs: g.totals.gpu.p50Milliseconds,
				gpuP95Ms: g.totals.gpu.p95Milliseconds,
				transientBytes: g.stats.logicalTransientBytes,
				physicalTransientBytes: g.stats.physicalTransientBytes,
				reusedTransientBytes: g.stats.reusedTransientBytes,
				fitsDeviceLimits: g.preflight?.fitsDeviceLimits,
				nodes,
			});
		}
	return out;
}
