// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Browser self-test of src/lib/gpu/core (scripts/gpu/core-selftest.mjs runs it in headless
// Chromium): device registry, pool + leases, ring readback, kernels (sync / async / pooled, per-pass
// bindings), a ComputeGraph with a custom WGSL node feeding GPUReduction, timestamp profiling,
// adoptRenderDevice, the worker profile protocol, the W0.1 wrapper widening (GPU indirect conditions
// and their lint, an adopted graph + preflight, raw-node audit, texture bindings with copy / render /
// frame passthroughs, listCachedGraphs), the W0.2 graph inspection, the W0.5 partial readback map, error checks (and their
// cost), the idle release and device loss (last: they destroy the sidecar). Every GPU result is compared exactly with a CPU
// computation.
import { Buffer, type Device, luma, Texture } from "@luma.gl/core";
import { type WebGPUDevice, webgpuAdapter } from "@luma.gl/webgpu";
import { setFlagOverride } from "#/lib/flags";
import { adapterLimits } from "../adapter-peek";
import {
	adoptedRenderDevice,
	adoptRenderDevice,
	COMPUTE_FEATURES,
	getComputeDevice,
	hasFeature,
	RAISED_LIMITS,
	releaseWhenIdle,
} from "../device";
import {
	ComputeGraph,
	cachedGraph,
	cachedGraphCount,
	type GraphTexture,
	listCachedGraphs,
} from "./graph";
import { inspectGraphs } from "./inspect";
import {
	defineKernel,
	encodeDispatch,
	kernel,
	kernelAsync,
	release,
	stage,
	storage,
	uniform,
	warmKernelsAsync,
} from "./kernel";
import { GpuDeviceLostError, idleFor, onLost } from "./lifecycle";
import { GPUCommandGraph, GPUReduction } from "./luma";
import {
	acquire,
	capacityFor,
	pooledStorage,
	pooledUniform,
	poolStats,
	releasePool,
	withLease,
} from "./pool";
import { getGpuGraphProfile, getGpuProfile, resetGpuProfile } from "./profile";
import { GpuValidationError, submit } from "./queue";
import {
	readBack,
	readbackStats,
	stagePartialRead,
	stageReads,
} from "./readback";
import {
	applyRealmGpuOptions,
	mergeGpuProfile,
	realmGpuOptions,
	takeGpuProfile,
} from "./realm";
import { dispatch, dispatchAll } from "./test-dispatch";

type Check = { name: string; ok: boolean; detail?: unknown };

const AXPY = /* wgsl */ `
struct P { a: u32, n: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<u32>;
@group(0) @binding(2) var<storage, read> y: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;
// @workgroup_size(64): tiny test kernel
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	if (g.x >= p.n) { return; }
	out[g.x] = x[g.x] * p.a + y[g.x];
}`;
const LAYOUT: [string, "uniform" | "read-only-storage" | "storage"][] = [
	["p", "uniform"],
	["x", "read-only-storage"],
	["y", "read-only-storage"],
	["out", "storage"],
];
const K_AXPY = defineKernel("selftest-axpy", AXPY, LAYOUT, {
	group: "selftest",
});

// transcendental f32 kernel: sync vs async pipelines must agree bit for bit
const SINE = /* wgsl */ `
override SCALE: f32 = 1.0;
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
// @workgroup_size(64): tiny test kernel
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	if (g.x >= arrayLength(&x)) { return; }
	out[g.x] = sin(x[g.x] * SCALE) * exp(-x[g.x] * 0.01);
}`;
const SINE_LAYOUT: [string, "read-only-storage" | "storage"][] = [
	["x", "read-only-storage"],
	["out", "storage"],
];
const K_SIN_SYNC = defineKernel("selftest-sin-sync", SINE, SINE_LAYOUT, {
	group: "selftest",
	constants: { SCALE: 1.7 },
});
const K_SIN_ASYNC = defineKernel("selftest-sin-async", SINE, SINE_LAYOUT, {
	group: "selftest-async",
	constants: { SCALE: 1.7 },
});

// graph node: v[i] = f32((i * 7919) % 10007) - 5000 (exact integers in f32)
const FILL = /* wgsl */ `
struct P { n: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> v: array<f32>;
// @workgroup_size(256): tiny test kernel
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u) {
	if (g.x >= p.n) { return; }
	v[g.x] = f32((g.x * 7919u) % 10007u) - 5000.0;
}`;
const K_FILL = defineKernel(
	"selftest-fill",
	FILL,
	[
		["p", "uniform"],
		["v", "storage"],
	],
	{ group: "selftest" },
);

// graph clear / alias test: acc[x[i] % m] += 1 (atomics on a transient that aliases another one)
const K_HIST = defineKernel(
	"selftest-hist",
	/* wgsl */ `
struct P { n: u32, m: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<u32>;
@group(0) @binding(2) var<storage, read_write> acc: array<atomic<u32>>;
// @workgroup_size(64): tiny test kernel
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	if (g.x >= p.n) { return; }
	atomicAdd(&acc[x[g.x] % p.m], 1u);
}`,
	[
		["p", "uniform"],
		["x", "read-only-storage"],
		["acc", "storage"],
	],
	{ group: "selftest" },
);
// GPU-condition reader: out[i] = v[i] + 1 (same workgroup size as FILL, so one indirect command
// gates both)
const K_PLUS1 = defineKernel(
	"selftest-plus1",
	/* wgsl */ `
struct P { n: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> v: array<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
// @workgroup_size(256): tiny test kernel
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u) {
	if (g.x >= p.n) { return; }
	out[g.x] = v[g.x] + 1.0;
}`,
	[
		["p", "uniform"],
		["v", "read-only-storage"],
		["out", "storage"],
	],
	{ group: "selftest" },
);
// graph texture binding: out[4i..4i+3] = texel i (row-major)
const K_TEXLOAD = defineKernel(
	"selftest-texload",
	/* wgsl */ `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
// @workgroup_size(64): tiny test kernel
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	let d = textureDimensions(t);
	if (g.x >= d.x * d.y) { return; }
	out[g.x] = textureLoad(t, vec2u(g.x % d.x, g.x / d.x), 0);
}`,
	[
		["t", "texture"],
		["out", "storage"],
	],
	{ group: "selftest" },
);
// the sine kernel under a spec only the graph compileAsync check builds (so its pipeline is async)
const K_SIN_GRAPH_ASYNC = defineKernel(
	"selftest-sin-graph-async",
	SINE,
	SINE_LAYOUT,
	{ group: "selftest-graph-async", constants: { SCALE: 1.7 } },
);

// a kernel that cannot compile: its pipeline is invalid, so the encoder fails validation
const K_BAD = defineKernel(
	"selftest-bad",
	/* wgsl */ `
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
// @workgroup_size(64): tiny test kernel
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	out[g.x] = no_such_symbol + 1u;
}`,
	[["out", "storage"]],
	{ group: "selftest-bad" },
);
// long-running kernel, so a read is still in flight when the device is destroyed
const K_SPIN = defineKernel(
	"selftest-spin",
	/* wgsl */ `
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
// @workgroup_size(64): tiny test kernel
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	var h = g.x;
	for (var i = 0u; i < 20000u; i++) { h = h * 1664525u + 1013904223u; }
	out[g.x] = h;
}`,
	[["out", "storage"]],
	{ group: "selftest" },
);

/** How `p` settles within `ms`: resolved / rejected (with the error's name) / timeout. */
const settle = async <T>(p: Promise<T>, ms: number) => {
	const t0 = performance.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const r = await Promise.race([
		p.then(
			(value) => ({ state: "resolved" as const, value, error: "" }),
			(e: Error) => ({
				state: "rejected" as const,
				value: undefined,
				error: `${e?.name}: ${String(e?.message ?? e).slice(0, 160)}`,
			}),
		),
		new Promise<{ state: "timeout"; value: undefined; error: string }>(
			(res) => {
				timer = setTimeout(
					() => res({ state: "timeout", value: undefined, error: "" }),
					ms,
				);
			},
		),
	]);
	clearTimeout(timer);
	return { ...r, ms: Math.round(performance.now() - t0) };
};

const u32 = (n: number, f: (i: number) => number) =>
	Uint32Array.from({ length: n }, (_, i) => f(i) >>> 0);
const sameBits = (a: ArrayBuffer, b: ArrayBuffer) => {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};
const axpyCpu = (x: Uint32Array, y: Uint32Array, a: number) =>
	u32(x.length, (i) => Math.imul(x[i], a) + y[i]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function coreSelftest(): Promise<{
	ok: boolean;
	checks: Check[];
	ms: number;
}> {
	const t0 = performance.now();
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail?: unknown) =>
		checks.push({ name, ok, detail });
	const run = async (name: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (e) {
			check(name, false, String((e as Error)?.stack ?? e).slice(0, 600));
		}
	};

	const device = await getComputeDevice();
	check("device", !!device && device.type === "webgpu", device?.info?.gpu);
	if (!device) return { ok: false, checks, ms: performance.now() - t0 };

	await run("device-features-limits", async () => {
		const features = Object.fromEntries(
			COMPUTE_FEATURES.map((f) => [f, hasFeature(device, f)]),
		);
		const adapter = (device as WebGPUDevice).adapter;
		const adapterLimitValues = adapter
			? adapterLimits(adapter, RAISED_LIMITS)
			: {};
		const limits = device.limits as unknown as Record<string, number>;
		const raised = Object.fromEntries(
			RAISED_LIMITS.map((k) => [k, [limits[k], adapterLimitValues[k]]]),
		);
		check(
			"device-features-limits",
			!!adapter &&
				RAISED_LIMITS.every((k) => limits[k] === adapterLimitValues[k]) &&
				hasFeature(null, "subgroups") === false,
			{ features, raised },
		);
	});

	await run("gpu-off", async () => {
		setFlagOverride("gpu", "off");
		const d = await getComputeDevice();
		setFlagOverride("gpu", undefined);
		const back = await getComputeDevice();
		check("gpu-off", d === null && back === device);
	});

	await run("pool", async () => {
		const U = Buffer.STORAGE | Buffer.COPY_DST;
		const a = acquire(device, "selftest/a", 1000, U);
		const a2 = acquire(device, "selftest/a", 600, U);
		const other = acquire(device, "selftest/a", 600, U | Buffer.COPY_SRC);
		const b = acquire(device, "selftest/a", 5000, U);
		const b2 = acquire(device, "selftest/a", 10, U);
		check(
			"pool",
			a === a2 &&
				a !== other &&
				a.byteLength === 1024 &&
				b !== a &&
				b === b2 &&
				b.byteLength === capacityFor(5000) &&
				capacityFor(1) === 256,
			{ a: a.byteLength, b: b.byteLength },
		);
	});

	await run("lease", async () => {
		const log: string[] = [];
		let inside = 0;
		let maxInside = 0;
		await Promise.all(
			[30, 5, 15].map((ms, i) =>
				withLease("selftest-lease", async () => {
					inside++;
					maxInside = Math.max(maxInside, inside);
					log.push(`start${i}`);
					await sleep(ms);
					log.push(`end${i}`);
					inside--;
				}),
			),
		);
		// a failing holder releases the lease
		const err = await withLease("selftest-lease", () => {
			throw new Error("boom");
		}).catch((e: Error) => e.message);
		const after = await withLease("selftest-lease", () => "free");
		check(
			"lease",
			maxInside === 1 &&
				log.join() === "start0,end0,start1,end1,start2,end2" &&
				err === "boom" &&
				after === "free",
			log,
		);
	});

	await run("readback", async () => {
		const bytes = Uint8Array.from(
			{ length: 1000 },
			(_, i) => (i * 37 + 11) & 255,
		);
		const src = storage(device, bytes);
		const ranges = [
			{ offset: 0, size: 7 },
			{ offset: 12, size: 100 },
			{ offset: 996, size: 3 },
			{ offset: 400, size: 0 },
		];
		const before = readbackStats(device).slots;
		let ok = true;
		for (let rep = 0; rep < 3; rep++) {
			const got = await readBack(
				device,
				() => {},
				ranges.map((r) => ({ buffer: src, ...r })),
			);
			ranges.forEach((r, i) => {
				ok &&=
					got[i].byteLength === r.size &&
					sameBits(got[i], bytes.slice(r.offset, r.offset + r.size).buffer);
			});
		}
		const stats = readbackStats(device);
		release(src);
		check(
			"readback",
			ok && stats.busy === 0 && stats.slots <= before + 1,
			stats,
		);
	});

	await run("kernel-sync-concurrent", async () => {
		const n = 1000;
		const k = kernel(device, K_AXPY);
		const cases = [3, 7, 11].map((a, c) => ({
			a,
			x: u32(n, (i) => i * (c + 1) + 17),
			y: u32(n, (i) => 0xfffff000 + i * 13 + c),
		}));
		const enc = device.createCommandEncoder({ id: "selftest-axpy" });
		const bufs = cases.map(({ a, x, y }) => {
			const p = uniform(device, new Uint32Array([a, n]).buffer);
			const xb = storage(device, x);
			const yb = storage(device, y);
			const out = storage(device, n * 4);
			return { p, xb, yb, out };
		});
		// same kernel, different bindings, one encoder: first two as separate passes, the third
		// together with a repeat of the first in one pass
		dispatch(
			enc,
			k,
			{ p: bufs[0].p, x: bufs[0].xb, y: bufs[0].yb, out: bufs[0].out },
			16,
		);
		dispatch(
			enc,
			k,
			{ p: bufs[1].p, x: bufs[1].xb, y: bufs[1].yb, out: bufs[1].out },
			16,
		);
		dispatchAll(enc, [
			{
				k,
				bindings: {
					p: bufs[2].p,
					x: bufs[2].xb,
					y: bufs[2].yb,
					out: bufs[2].out,
				},
				x: 16,
			},
			{
				k,
				bindings: {
					p: bufs[0].p,
					x: bufs[0].xb,
					y: bufs[0].yb,
					out: bufs[0].out,
				},
				x: 16,
			},
		]);
		const reads = bufs.map((b) => stage(device, enc, b.out, n * 4));
		submit(device, enc);
		const got = await Promise.all(reads.map((r) => r.read()));
		const ok = cases.every((c, i) =>
			sameBits(got[i], axpyCpu(c.x, c.y, c.a).buffer),
		);
		for (const b of bufs) release(b.p, b.xb, b.yb, b.out);
		check("kernel-sync-concurrent", ok);
	});

	await run("dispatch-limit", async () => {
		// over maxComputeWorkgroupsPerDimension: refused while encoding (not a silent failed submit)
		const k = kernel(device, K_AXPY);
		const max = device.limits.maxComputeWorkgroupsPerDimension;
		const p = uniform(device, new Uint32Array([1, 4]).buffer);
		const b = storage(device, 16);
		const enc = device.createCommandEncoder({ id: "selftest-dispatch-limit" });
		let threw = "";
		try {
			dispatch(enc, k, { p, x: b, y: b, out: b }, max + 1);
		} catch (e) {
			threw = String(e);
		}
		release(p, b);
		check(
			"dispatch-limit",
			/exceeds maxComputeWorkgroupsPerDimension/.test(threw),
			{
				max,
				threw,
			},
		);
	});

	await run("kernel-async-vs-sync", async () => {
		const failed = await warmKernelsAsync(device, "selftest-async");
		const n = 4096;
		const x = Float32Array.from({ length: n }, (_, i) => (i - 2048) * 0.0037);
		const kS = kernel(device, K_SIN_SYNC);
		const kA = await kernelAsync(device, K_SIN_ASYNC);
		const again = await kernelAsync(device, K_SIN_ASYNC);
		const xb = storage(device, x);
		const o1 = storage(device, n * 4);
		const o2 = storage(device, n * 4);
		const got = await readBack(
			device,
			(enc) => {
				dispatch(enc, kS, { x: xb, out: o1 }, n / 64);
				dispatch(enc, kA, { x: xb, out: o2 }, n / 64);
			},
			[
				{ buffer: o1, size: n * 4 },
				{ buffer: o2, size: n * 4 },
			],
		);
		// sanity against the CPU (loose: GPU sin/exp are not libm)
		const g = new Float32Array(got[0]);
		let maxErr = 0;
		for (let i = 0; i < n; i++)
			maxErr = Math.max(
				maxErr,
				Math.abs(g[i] - Math.sin(x[i] * 1.7) * Math.exp(-x[i] * 0.01)),
			);
		release(xb, o1, o2);
		const same = sameBits(got[0], got[1]);
		check(
			"kernel-async-vs-sync",
			failed === 0 && kA === again && same && maxErr < 1e-4,
			{ same, maxErr },
		);
	});

	await run("kernel-pooled-vs-fresh", async () => {
		const k = kernel(device, K_AXPY);
		let ok = true;
		// growing sizes exercise pool growth + retirement under a lease
		for (const n of [100, 700, 3000, 50]) {
			const x = u32(n, (i) => i * 2654435761);
			const y = u32(n, (i) => i ^ 0x5bd1e995);
			const fresh = await (async () => {
				const p = uniform(device, new Uint32Array([5, n]).buffer);
				const xb = storage(device, x);
				const yb = storage(device, y);
				const out = storage(device, n * 4);
				const r = await readBack(
					device,
					(enc) =>
						dispatch(enc, k, { p, x: xb, y: yb, out }, Math.ceil(n / 64)),
					[{ buffer: out, size: n * 4 }],
				);
				release(p, xb, yb, out);
				return r[0];
			})();
			const pooled = await withLease("selftest-axpy", async () => {
				const p = pooledUniform(
					device,
					"selftest-axpy/p",
					new Uint32Array([5, n]),
				);
				const xb = pooledStorage(device, "selftest-axpy/x", x);
				const yb = pooledStorage(device, "selftest-axpy/y", y);
				const out = pooledStorage(device, "selftest-axpy/out", n * 4, {
					zero: false,
				});
				const r = await readBack(
					device,
					(enc) =>
						dispatch(enc, k, { p, x: xb, y: yb, out }, Math.ceil(n / 64)),
					[{ buffer: out, size: n * 4 }],
				);
				release(p, xb, yb, out); // no-op for pooled buffers
				return r[0];
			});
			ok &&=
				sameBits(fresh, pooled) && sameBits(pooled, axpyCpu(x, y, 5).buffer);
		}
		const still = acquire(
			device,
			"selftest-axpy/out",
			4,
			Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC,
		);
		check("kernel-pooled-vs-fresh", ok && !still.destroyed, {
			outCapacity: still.byteLength,
		});
	});

	await run("graph-reduction", async () => {
		const n = 100_003;
		const g = new ComputeGraph<{ n: number }>(device, "selftest-graph");
		const params = g.importBuffer(
			"params",
			16,
			undefined,
			Buffer.UNIFORM | Buffer.COPY_DST,
		);
		const values = g.transientBuffer("values", n * 4);
		const ext = g.importBuffer("extent", 8);
		g.addKernel({
			id: "fill",
			spec: K_FILL,
			bindings: { p: params, v: values },
			workgroups: (p) => [Math.ceil(p.n / 256)],
		});
		g.add(
			new GPUReduction({
				id: "selftest-extent",
				input: g.view(values, "float32", n),
				output: g.view(ext, "float32", 2),
				operation: "extent",
			}),
		);
		g.compile();
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = 0; i < n; i++) {
			const v = ((i * 7919) % 10007) - 5000;
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
		const pBuf = uniform(device, new Uint32Array([n]).buffer);
		const eBuf = storage(device, 8);
		const results: number[][] = [];
		for (let rep = 0; rep < 2; rep++) {
			const { data, timings } = await g.run(
				{ n },
				{
					buffers: { params: pBuf, extent: eBuf },
					read: [{ buffer: eBuf, size: 8 }],
					timings: rep === 1,
				},
			);
			results.push([...new Float32Array(data[0])]);
			if (rep === 1)
				check(
					"graph-timings",
					!hasFeature(device, "timestamp-query") ||
						(timings?.nodes.length ?? 0) >= 2,
					timings && {
						gpuMs: timings.gpuTimeMilliseconds,
						nodes: timings.nodes.map((x) => x.id),
					},
				);
		}
		g.destroy();
		release(pBuf, eBuf);
		check(
			"graph-reduction",
			results.every(([a, b]) => a === lo && b === hi),
			{ results, cpu: [lo, hi] },
		);
	});

	// Transients are never zeroed and alias: B (atomics) reuses A's physical buffer. With a clear node
	// the histogram is exact on every run (two runs, different data and sizes); without one it
	// inherits A's bytes. Also: readNode on a transient (A, B, and a parameter-sized range), and the
	// `cleared` check refusing an unclearaed atomic transient.
	await run("graph-clear-alias", async () => {
		type P = { n: number; m: number };
		const N = 4096;
		const M = 1024;
		const build = (withClear: boolean) => {
			const g = new ComputeGraph<P>(device, `selftest-alias-${withClear}`);
			const params = g.importBuffer(
				"params",
				16,
				undefined,
				Buffer.UNIFORM | Buffer.COPY_DST,
			);
			const x = g.importBuffer("x", N * 4);
			const a = g.transientBuffer("A", N * 4);
			const b = g.transientBuffer("B", M * 4);
			g.addKernel({
				id: "fill",
				spec: K_FILL,
				bindings: { p: params, v: a },
				workgroups: (p) => [Math.ceil(p.n / 256)],
			});
			g.readNode("readA", [{ buffer: a, size: (p) => p.n * 4 }]);
			// order B's lifetime after A's (independent nodes may otherwise interleave), so they alias
			if (withClear) g.clearNode("clearB", b, { dependsOn: ["readA"] });
			g.addKernel({
				id: "hist",
				spec: K_HIST,
				bindings: { p: params, x, acc: b },
				workgroups: (p) => [Math.ceil(p.n / 64)],
				cleared: withClear ? ["acc"] : undefined,
				dependsOn: ["readA"],
			});
			g.readNode("readB", [
				b,
				{ buffer: b, offset: 16, size: (p) => p.m * 4 - 16 },
			]);
			return g.compile();
		};
		const g = build(true);
		const raw = build(false);
		const stats = g.stats;
		// the clear lint (at compile, against the scheduled order): no clear at all; a use before the clear
		const lintOf = (useFirst: boolean) => {
			try {
				const bad = new ComputeGraph<P>(
					device,
					`selftest-alias-lint-${useFirst}`,
				);
				const t = bad.transientBuffer("T", 64);
				if (useFirst) {
					bad.readNode("peek", [t]);
					bad.clearNode("clear", t, { dependsOn: ["peek"] });
				}
				bad.addKernel({
					id: "h",
					spec: K_HIST,
					bindings: {
						p: bad.importBuffer(
							"p",
							16,
							undefined,
							Buffer.UNIFORM | Buffer.COPY_DST,
						),
						x: bad.importBuffer("x", 64),
						acc: t,
					},
					workgroups: [1],
					writes: { acc: "atomic" },
				});
				bad.compile();
				bad.destroy();
				return "";
			} catch (e) {
				return String((e as Error).message);
			}
		};
		const lint = `${lintOf(false)} / ${lintOf(true)}`;
		const runs: Record<string, unknown>[] = [];
		let ok =
			!!stats &&
			stats.physicalTransientBufferCount < stats.logicalTransientBufferCount &&
			lint.includes("without a clear node") &&
			lint.includes("before its clear node");
		let staleSeen = false;
		for (const [rep, n, m, seed] of [
			[0, 4096, 1024, 7],
			[1, 3001, 997, 13],
		] as const) {
			const x = u32(N, (i) => Math.imul(i + seed, 2654435761) >>> 7);
			const pBuf = uniform(device, new Uint32Array([n, m]).buffer);
			const xBuf = storage(device, x);
			const hist = new Uint32Array(M);
			for (let i = 0; i < n; i++) hist[x[i] % m]++;
			const fill = new Float32Array(n);
			for (let i = 0; i < n; i++) fill[i] = ((i * 7919) % 10007) - 5000;
			const res = await g.run({ n, m }, { buffers: { params: pBuf, x: xBuf } });
			const res2 = await raw.run(
				{ n, m },
				{ buffers: { params: pBuf, x: xBuf } },
			);
			release(pBuf, xBuf);
			const [bAll, bTail] = res.reads.readB;
			const got = new Uint32Array(bAll);
			let histOk = true;
			// B beyond m is never touched by the kernel: the clear left zeros there
			for (let i = 0; i < M; i++)
				if (got[i] !== (i < m ? hist[i] : 0)) histOk = false;
			const tailOk = sameBits(bTail, got.slice(4, m).buffer);
			const aOk = sameBits(res.reads.readA[0], fill.buffer);
			const rawGot = new Uint32Array(res2.reads.readB[0]);
			let rawDiff = 0;
			for (let i = 0; i < m; i++) if (rawGot[i] !== hist[i]) rawDiff++;
			staleSeen ||= rawDiff > 0;
			ok &&= histOk && tailOk && aOk;
			runs.push({ rep, n, m, histOk, tailOk, aOk, rawDiff });
		}
		g.destroy();
		raw.destroy();
		check("graph-clear-alias", ok && staleSeen, {
			physical: stats?.physicalTransientBufferCount,
			logical: stats?.logicalTransientBufferCount,
			lint: lint.slice(0, 120),
			runs,
		});
	});

	// compileAsync: pipelines built with createComputePipelineAsync give the sync pipeline's bits;
	// concurrent compileAsync calls share one compilation.
	await run("graph-compile-async", async () => {
		const n = 5000;
		const x = Float32Array.from({ length: n }, (_, i) => (i - 2500) * 0.37);
		const build = (spec: typeof K_SIN_SYNC, id: string) => {
			const g = new ComputeGraph(device, id);
			const xs = g.importBuffer("x", n * 4);
			const out = g.transientBuffer("out", n * 4);
			g.addKernel({
				id: "sin",
				spec,
				bindings: { x: xs, out },
				workgroups: [Math.ceil(n / 64)],
			});
			g.readNode("read", [out]);
			return g;
		};
		const ga = build(K_SIN_GRAPH_ASYNC, "selftest-graph-async");
		const [a1, a2] = await Promise.all([ga.compileAsync(), ga.compileAsync()]);
		const gs = build(K_SIN_SYNC, "selftest-graph-sync").compile();
		const xBuf = storage(device, x);
		const ra = await ga.run(undefined, { buffers: { x: xBuf } });
		const rs = await gs.run(undefined, { buffers: { x: xBuf } });
		release(xBuf);
		ga.destroy();
		gs.destroy();
		check(
			"graph-compile-async",
			a1 === ga && a2 === ga && sameBits(ra.reads.read[0], rs.reads.read[0]),
			{
				bytes: ra.reads.read[0].byteLength,
			},
		);
	});

	// runNow (no lease, sync up to submit) on an import-only graph: two back-to-back calls that rewrite
	// the SAME pooled input in between each read their own input (queue order), bit-equal to run();
	// a graph with a transient is refused.
	await run("graph-run-now", async () => {
		const n = 3000;
		const g = new ComputeGraph(device, "selftest-run-now");
		const xs = g.importBuffer("x", n * 4);
		const out = g.importBuffer("out", n * 4);
		g.addKernel({
			id: "sin",
			spec: K_SIN_SYNC,
			bindings: { x: xs, out },
			workgroups: [Math.ceil(n / 64)],
		});
		g.readNode("read", [out]);
		await g.compileAsync();
		const xa = Float32Array.from({ length: n }, (_, i) => (i - 1500) * 0.37);
		const xb = Float32Array.from({ length: n }, (_, i) => (i - 900) * 0.11);
		const call = (x: Float32Array) =>
			g.runNow(undefined, {
				buffers: {
					x: pooledStorage(device, "selftest-run-now/x", x),
					out: acquire(
						device,
						"selftest-run-now/out",
						n * 4,
						Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
					),
				},
			});
		const pa = call(xa);
		const pb = call(xb);
		const [ra, rb] = await Promise.all([pa, pb]);
		const ref = async (x: Float32Array) => {
			const xBuf = storage(device, x);
			const outBuf = storage(device, n * 4);
			const r = await g.run(undefined, { buffers: { x: xBuf, out: outBuf } });
			release(xBuf, outBuf);
			return r.reads.read[0];
		};
		const [fa, fb] = [await ref(xa), await ref(xb)];
		const t = new ComputeGraph(device, "selftest-run-now-transient");
		const tx = t.importBuffer("x", n * 4);
		const tout = t.transientBuffer("out", n * 4);
		t.addKernel({
			id: "sin",
			spec: K_SIN_SYNC,
			bindings: { x: tx, out: tout },
			workgroups: [Math.ceil(n / 64)],
		});
		t.readNode("read", [tout]);
		let refused = false;
		try {
			void t.runNow(undefined, {});
		} catch {
			refused = true;
		}
		t.destroy();
		g.destroy();
		releasePool(device, "selftest-run-now/");
		check(
			"graph-run-now",
			sameBits(ra.reads.read[0], fa) &&
				sameBits(rb.reads.read[0], fb) &&
				!sameBits(fa, fb) &&
				refused,
			{ bytes: fa.byteLength, refused },
		);
	});

	// shape-keyed cache: hit returns the same compiled graph, LRU evicts beyond max (destroyed under its
	// lease), and a cached graph's runs are exact.
	await run("graph-cache", async () => {
		let builds = 0;
		const get = (n: number) =>
			cachedGraph<{ n: number }, number>(
				device,
				"selftest-cache",
				`n=${n}`,
				(g) => {
					builds++;
					const params = g.importBuffer(
						"params",
						16,
						undefined,
						Buffer.UNIFORM | Buffer.COPY_DST,
					);
					const v = g.transientBuffer("v", n * 4);
					g.addKernel({
						id: "fill",
						spec: K_FILL,
						bindings: { p: params, v },
						workgroups: [Math.ceil(n / 256)],
					});
					g.readNode("read", [v]);
					g.compile();
					return n;
				},
				2,
			);
		const a = get(1000);
		const b = get(2000);
		const a2 = get(1000);
		const c = get(3000); // evicts n=2000
		const b2 = get(2000); // rebuilt, evicts n=1000
		const count = cachedGraphCount(device, "selftest-cache");
		let exact = true;
		for (const e of [c, b2]) {
			const n = e.extra;
			const pBuf = uniform(device, new Uint32Array([n]).buffer);
			const r = await e.graph.run({ n }, { buffers: { params: pBuf } });
			release(pBuf);
			const f = new Float32Array(n);
			for (let i = 0; i < n; i++) f[i] = ((i * 7919) % 10007) - 5000;
			exact &&= sameBits(r.reads.read[0], f.buffer);
		}
		// the evicted graphs were destroyed after their (absent) runs
		await a.graph.lease(() => {});
		await b.graph.lease(() => {});
		check(
			"graph-cache",
			a2 === a &&
				b2 !== b &&
				builds === 4 &&
				count === 2 &&
				!a.graph.isCompiled &&
				!b.graph.isCompiled &&
				exact,
			{
				builds,
				count,
				exact,
			},
		);
	});

	// listCachedGraphs: the two entries graph-cache left, read without touching the LRU order.
	await run("graph-cache-list", async () => {
		const list = listCachedGraphs(device, "selftest-cache");
		const all = listCachedGraphs();
		check(
			"graph-cache-list",
			list.length === 2 &&
				list.map((e) => e.key).join() === "n=3000,n=2000" &&
				list.every(
					(e) =>
						e.id === `selftest-cache|${e.key}` &&
						e.compiled &&
						(e.stats?.nodeCount ?? 0) >= 2 &&
						e.device === device,
				) &&
				list.every((e) => all.some((x) => x.graph === e.graph)) &&
				cachedGraphCount(device, "selftest-cache") === 2,
			list.map(({ key, id, compiled }) => ({ key, id, compiled })),
		);
	});

	// W0.2 inspection: inspectGraphs() lists the cached graphs with their stats and preflight and starts
	// observing them; an observed graph's run is bit-identical to the unobserved one, its encodes are
	// recorded, and a profiled run's GPU node times reach the inspector and getGpuGraphProfile().
	await run("graph-inspect", async () => {
		const [e] = listCachedGraphs(device, "selftest-cache").filter(
			(x) => x.key === "n=3000",
		);
		const n = 3000;
		const once = async () => {
			const pBuf = uniform(device, new Uint32Array([n]).buffer);
			const r = await e.graph.run({ n }, { buffers: { params: pBuf } });
			release(pBuf);
			return r;
		};
		const before = await once();
		const rows = inspectGraphs({ device }).filter(
			(r) => r.group === "selftest-cache",
		);
		const row0 = rows.find((r) => r.key === "n=3000");
		const after = await once();
		const row1 = inspectGraphs({ device, observe: false }).find(
			(r) => r.id === e.id,
		);
		let gpuTimed: boolean | null = null;
		if (device.features.has("timestamp-query")) {
			globalThis.__RIGI_GPU_PROFILE__ = true;
			try {
				const timed = await once();
				const prof = (await getGpuGraphProfile()).find(
					(p) => p.graph === e.id && p.device === device.id,
				);
				gpuTimed =
					!!timed.timings &&
					prof?.gpuMs !== undefined &&
					prof.nodes.fill?.gpuMs !== undefined &&
					sameBits(timed.reads.read[0], before.reads.read[0]);
			} finally {
				globalThis.__RIGI_GPU_PROFILE__ = undefined;
				resetGpuProfile();
			}
		}
		check(
			"graph-inspect",
			rows.length === 2 &&
				!!row0 &&
				row0.compiled &&
				row0.nodeCount >= 2 &&
				row0.preflight?.fitsDeviceLimits === true &&
				row0.transient.logicalBufferBytes >= n * 4 &&
				row0.encodings === 0 &&
				row1?.encodings === 1 &&
				(row1?.nodes.find((x) => x.id === "fill")?.cpu.samples ?? 0) === 1 &&
				sameBits(after.reads.read[0], before.reads.read[0]) &&
				gpuTimed !== false,
			{
				rows: rows.length,
				transient: row0?.transient,
				encodings: row1?.encodings,
				gpuTimed,
			},
		);
	});

	// Read-node slots never leak: (a) a checked submit's validation error (a bad kernel after the read
	// node) rejects run() and returns every staged slot; (b) a throw while encoding (a graph kernel
	// node over maxComputeWorkgroupsPerDimension, refused by encodeDispatch's guard) after a read node
	// staged returns it too; (c) a caller dropping encodeReads' reads sees them as pending.
	await run("graph-read-leak", async () => {
		const checks = globalThis as { __RIGI_GPU_CHECKS__?: boolean };
		const busy0 = readbackStats(device).busy;
		const build = (id: string, bad: "pipeline" | "limit") => {
			const g = new ComputeGraph<{ n: number }>(device, id);
			const params = g.importBuffer(
				"params",
				16,
				undefined,
				Buffer.UNIFORM | Buffer.COPY_DST,
			);
			const v = g.transientBuffer("v", 4096);
			const o = g.transientBuffer("o", 256);
			g.addKernel({
				id: "fill",
				spec: K_FILL,
				bindings: { p: params, v },
				workgroups: [4],
			});
			g.readNode("read", [v]);
			if (bad === "pipeline")
				g.addKernel({
					id: "bad",
					spec: K_BAD,
					bindings: { out: o },
					workgroups: [1],
					dependsOn: ["read"],
				});
			else
				g.addKernel({
					id: "huge",
					spec: K_FILL,
					bindings: { p: params, v: o },
					workgroups: [device.limits.maxComputeWorkgroupsPerDimension + 1],
					dependsOn: ["read"],
				});
			return g.compile();
		};
		const pBuf = uniform(device, new Uint32Array([1024]).buffer);
		const ga = build("selftest-leak-validation", "pipeline");
		checks.__RIGI_GPU_CHECKS__ = true;
		const a = await settle(
			ga.run({ n: 1024 }, { buffers: { params: pBuf } }),
			3000,
		);
		checks.__RIGI_GPU_CHECKS__ = undefined;
		await sleep(50);
		const busyA = readbackStats(device).busy;
		const gb = build("selftest-leak-limit", "limit");
		const b = await settle(
			gb.run({ n: 1024 }, { buffers: { params: pBuf } }),
			3000,
		);
		const busyB = readbackStats(device).busy;
		// (c) encodeReads: reads are pending until read or cancelled
		const gc = new ComputeGraph<{ n: number }>(device, "selftest-leak-pending");
		const pc = gc.importBuffer(
			"params",
			16,
			undefined,
			Buffer.UNIFORM | Buffer.COPY_DST,
		);
		const vc = gc.transientBuffer("v", 4096);
		gc.addKernel({
			id: "fill",
			spec: K_FILL,
			bindings: { p: pc, v: vc },
			workgroups: [4],
		});
		gc.readNode("read", [vc]);
		gc.compile();
		const enc = device.createCommandEncoder({ id: "selftest-leak-pending" });
		const { reads } = await gc.lease(() =>
			gc.encodeReads(enc, { n: 1024 }, { params: pBuf }),
		);
		const pendingBefore = reads.pending;
		reads.cancel();
		const pendingAfter = reads.pending;
		const busyC = readbackStats(device).busy;
		release(pBuf);
		ga.destroy();
		gb.destroy();
		gc.destroy();
		check(
			"graph-read-leak",
			a.state === "rejected" &&
				a.error.startsWith("GpuValidationError") &&
				b.state === "rejected" &&
				/exceeds maxComputeWorkgroupsPerDimension/.test(b.error) &&
				busyA === busy0 &&
				busyB === busy0 &&
				pendingBefore === 1 &&
				pendingAfter === 0 &&
				busyC === busy0,
			{
				busy0,
				a: a.error.slice(0, 90),
				busyA,
				b: b.error.slice(0, 110),
				busyB,
				pendingBefore,
				pendingAfter,
				busyC,
			},
		);
	});

	// W0.1 GPU indirect conditions: a GPU-gated fill (x from a GPU command buffer; x = 0 skips it).
	// Lint: an ungated reader of its transient needs a clear before it (else compile() throws); a
	// reader gated by the same command needs none. Runs: cleared + ungated read gives fill or zeros;
	// same-gate reader gives fill + 1 or leaves its import untouched.
	await run("graph-gpu-condition", async () => {
		type P = { n: number };
		const n = 1000;
		const wg = Math.ceil(n / 256);
		const CMD = Buffer.INDIRECT | Buffer.COPY_DST | Buffer.STORAGE;
		const build = (mode: "clear" | "gated" | "bad-read" | "bad-ungated") => {
			const g = new ComputeGraph<P>(device, `selftest-gpucond-${mode}`);
			const params = g.importBuffer(
				"params",
				16,
				undefined,
				Buffer.UNIFORM | Buffer.COPY_DST,
			);
			const cmd = g.importBuffer("cmd", 16, undefined, CMD);
			const v = g.transientBuffer("v", n * 4);
			const gate = {
				id: "gate",
				source: "gpu" as const,
				mode: "indirect" as const,
				buffer: cmd,
			};
			if (mode === "clear") g.clearNode("clearV", v);
			g.addKernel({
				id: "fill",
				spec: K_FILL,
				bindings: { p: params, v },
				workgroups: [wg],
				condition: gate,
			});
			if (mode === "clear" || mode === "bad-read") g.readNode("readV", [v]);
			else {
				const out = g.importBuffer("out", n * 4);
				g.addKernel({
					id: "plus1",
					spec: K_PLUS1,
					bindings: { p: params, v, out },
					workgroups: [wg],
					condition:
						mode === "gated" ? { ...gate, id: "gate-reader" } : undefined,
				});
			}
			return g;
		};
		const lintOf = (mode: "bad-read" | "bad-ungated") => {
			try {
				build(mode).compile().destroy();
				return "";
			} catch (e) {
				return String((e as Error).message);
			}
		};
		const lint = [lintOf("bad-read"), lintOf("bad-ungated")];
		const fill = new Float32Array(n);
		for (let i = 0; i < n; i++) fill[i] = ((i * 7919) % 10007) - 5000;
		const plus = fill.map((x) => x + 1);
		const pBuf = uniform(device, new Uint32Array([n]).buffer);
		const cmdOf = (x: number) =>
			device.createBuffer({
				usage: CMD,
				data: new Uint32Array([x, 1, 1, 0]),
			});
		const gc = build("clear").compile();
		const gg = build("gated").compile();
		const runs: Record<string, boolean> = {};
		for (const x of [wg, 0, wg]) {
			const cmd = cmdOf(x);
			const rc = await gc.run({ n }, { buffers: { params: pBuf, cmd } });
			runs[`clear-x${x}`] = sameBits(
				rc.reads.readV[0],
				(x ? fill : new Float32Array(n)).buffer,
			);
			const out = storage(device, new Float32Array(n).fill(-7));
			const rg = await gg.run(
				{ n },
				{
					buffers: { params: pBuf, cmd, out },
					read: [{ buffer: out, size: n * 4 }],
				},
			);
			runs[`gated-x${x}`] = sameBits(
				rg.data[0],
				(x ? plus : new Float32Array(n).fill(-7)).buffer,
			);
			release(cmd, out);
		}
		const preflight = gg.preflight;
		gc.destroy();
		gg.destroy();
		release(pBuf);
		check(
			"graph-gpu-condition",
			lint.every((m) => m.includes("GPU-conditioned fill")) &&
				Object.values(runs).every(Boolean) &&
				preflight?.conditionalNodeCount === 2,
			{
				lint: lint.map((m) => m.slice(0, 140)),
				runs,
				conditional: preflight?.conditionalNodeCount,
			},
		);
	});

	// W0.1 adopt an external GPUCommandGraph; workload annotations reach upstream preflight.
	await run("graph-adopt-preflight", async () => {
		type P = { n: number };
		const n = 3000;
		const raw = new GPUCommandGraph<P>(device, { id: "selftest-adopt-raw" });
		const g = new ComputeGraph<P>(device, "selftest-adopt", { graph: raw });
		const params = g.importBuffer(
			"params",
			16,
			undefined,
			Buffer.UNIFORM | Buffer.COPY_DST,
		);
		const v = g.transientBuffer("v", n * 4);
		g.addKernel({
			id: "fill",
			spec: K_FILL,
			bindings: { p: params, v },
			workgroups: [Math.ceil(n / 256)],
			workload: {
				operation: "fill",
				maximumInvocationCount: n,
				writeByteLength: n * 4,
			},
		});
		g.readNode("read", [v]);
		g.compile();
		const pf = g.preflight;
		const node = pf?.nodes.find((x) => x.id === "fill");
		const pBuf = uniform(device, new Uint32Array([n]).buffer);
		const r = await g.run({ n }, { buffers: { params: pBuf } });
		release(pBuf);
		g.destroy();
		const f = new Float32Array(n);
		for (let i = 0; i < n; i++) f[i] = ((i * 7919) % 10007) - 5000;
		check(
			"graph-adopt-preflight",
			g.graph === raw &&
				sameBits(r.reads.read[0], f.buffer) &&
				node?.maximumInvocationCount === n &&
				node?.writeByteLength === n * 4 &&
				(pf?.annotatedNodeCount ?? 0) >= 1 &&
				g.fitsDeviceLimits() === undefined &&
				pf?.fitsDeviceLimits === true,
			{
				annotated: pf?.annotatedNodeCount,
				node,
				fits: pf?.fitsDeviceLimits,
			},
		);
	});

	// W0.1 raw nodes join the clear lint (G5): a raw atomic node declaring `cleared` without a clear
	// node is refused; with one it compiles.
	await run("graph-raw-audit", async () => {
		const build = (withClear: boolean) => {
			const g = new ComputeGraph<void>(device, `selftest-raw-${withClear}`);
			const p = g.importBuffer(
				"p",
				16,
				undefined,
				Buffer.UNIFORM | Buffer.COPY_DST,
			);
			const x = g.importBuffer("x", 64);
			const t = g.transientBuffer("T", 64);
			if (withClear) g.clearNode("clear", t);
			g.addComputePass({
				id: "raw-hist",
				resources: [
					{ buffer: p, usage: "uniform" },
					{ buffer: x, usage: "storage-read" },
					{ buffer: t, usage: "storage-read-write" },
				],
				cleared: [t],
				compile: ({ device: d }) => {
					const k = kernel(d, K_HIST);
					return {
						encode: ({ computePass, getBuffer }) =>
							encodeDispatch(
								computePass,
								k,
								{ p: getBuffer(p), x: getBuffer(x), acc: getBuffer(t) },
								1,
							),
					};
				},
			});
			g.readNode("read", [t]);
			return g;
		};
		let refused = "";
		try {
			build(false).compile().destroy();
		} catch (e) {
			refused = String((e as Error).message);
		}
		const ok = build(true).compile();
		const compiled = ok.isCompiled;
		ok.destroy();
		check(
			"graph-raw-audit",
			refused.includes("without a clear node") && compiled,
			refused.slice(0, 140),
		);
	});

	// W0.1 texture bindings in addKernel: an imported texture, a transient texture filled by a raw copy
	// node, a transient texture cleared by a raw render node (graph attachments), and a frame texture
	// supplied per run. Each is read texel-exact by a "texture" layout kernel.
	await run("graph-texture", async () => {
		const W = 16;
		const H = 8;
		const n = W * H;
		const texels = Float32Array.from(
			{ length: n * 4 },
			(_, i) => i * 0.25 - 100,
		);
		const desc = (id: string, usage: number) => ({
			id,
			format: "rgba32float" as const,
			width: W,
			height: H,
			usage,
		});
		const makeTexture = (data: Float32Array) => {
			const t = device.createTexture({
				format: "rgba32float",
				width: W,
				height: H,
				usage: Texture.SAMPLE | Texture.COPY_DST,
			});
			t.writeData(data);
			return t;
		};
		const reader = (g: ComputeGraph<void>, src: GraphTexture) => {
			const out = g.transientBuffer("out", n * 16);
			g.addKernel({
				id: "load",
				spec: K_TEXLOAD,
				bindings: { t: src, out },
				workgroups: [Math.ceil(n / 64)],
			});
			g.readNode("read", [out]);
		};
		const results: Record<string, boolean> = {};
		// (a) imported
		const tex = makeTexture(texels);
		const ga = new ComputeGraph<void>(device, "selftest-tex-import");
		reader(
			ga,
			ga.importTexture(desc("src", Texture.SAMPLE | Texture.COPY_DST), tex),
		);
		results.imported = sameBits(
			(await ga.compile().run(undefined)).reads.read[0],
			texels.buffer,
		);
		ga.destroy();
		// (b) transient, filled by a copy node (bytesPerRow = 16 × 16 B = 256)
		const srcBuf = storage(device, texels);
		const gb = new ComputeGraph<void>(device, "selftest-tex-copy");
		const sb = gb.importBuffer("srcBuf", n * 16);
		const tt = gb.transientTexture(
			desc("tt", Texture.SAMPLE | Texture.COPY_DST),
		);
		gb.addCopyPass({
			id: "upload",
			resources: [
				{ buffer: sb, usage: "copy-source" },
				{ texture: tt, usage: "copy-destination" },
			],
			compile: () => ({
				encode: ({ commandEncoder, getBuffer, getTexture }) =>
					commandEncoder.copyBufferToTexture({
						sourceBuffer: getBuffer(sb),
						destinationTexture: getTexture(tt),
						bytesPerRow: W * 16,
						rowsPerImage: H,
						size: [W, H, 1],
					}),
			}),
		});
		reader(gb, tt);
		results.copy = sameBits(
			(await gb.compile().run(undefined, { buffers: { srcBuf } })).reads
				.read[0],
			texels.buffer,
		);
		gb.destroy();
		release(srcBuf);
		// (c) transient render target cleared by a render node
		const color = [1.5, -2, 0.25, 8];
		const gc = new ComputeGraph<void>(device, "selftest-tex-render");
		const rt = gc.transientTexture(desc("rt", Texture.SAMPLE | Texture.RENDER));
		gc.addRenderPass({
			id: "clear-rt",
			attachments: { colorAttachments: [gc.textureView(rt)] },
			compile: () => ({
				getRenderPassProps: () => ({
					id: "selftest-clear-rt",
					clearColor: color as [number, number, number, number],
				}),
				encode: () => {},
			}),
		});
		reader(gc, rt);
		const cleared = new Float32Array(n * 4).map((_, i) => color[i % 4]);
		results.render = sameBits(
			(await gc.compile().run(undefined)).reads.read[0],
			cleared.buffer,
		);
		gc.destroy();
		// (d) frame texture, a different texture per run with an increasing frameId
		const gd = new ComputeGraph<void>(device, "selftest-tex-frame");
		reader(gd, gd.importFrameTexture(desc("frame", Texture.SAMPLE)));
		gd.compile();
		const second = texels.map((x) => -x);
		const tex2 = makeTexture(second);
		let frameOk = true;
		for (const [frameId, t, want] of [
			[1, tex, texels],
			[2, tex2, second],
		] as const) {
			const r = await gd.run(undefined, {
				frameTextures: { frame: { texture: t, frameId } },
			});
			frameOk &&= sameBits(r.reads.read[0], want.buffer);
		}
		results.frame = frameOk;
		gd.destroy();
		tex.destroy();
		tex2.destroy();
		check("graph-texture", Object.values(results).every(Boolean), results);
	});

	// W0.5 deferred partial map: header first, then only [0, total); bad totals reject and every slot
	// is returned.
	await run("readback-partial", async () => {
		const capacity = 4096;
		const words = new Uint32Array(capacity / 4);
		for (let i = 1; i < words.length; i++) words[i] = Math.imul(i, 2654435761);
		const src = storage(device, words);
		const results: Record<string, unknown> = {};
		let ok = true;
		for (const count of [37, 0, capacity / 4 - 1]) {
			words[0] = count;
			src.write(words.subarray(0, 1));
			const enc = device.createCommandEncoder({ id: "selftest-partial" });
			const staged = stagePartialRead(device, enc, {
				buffer: src,
				capacity,
				headerBytes: 4,
				total: (h) => 4 + new Uint32Array(h)[0] * 4,
			});
			submit(device, enc);
			const r = await staged.read();
			const total = 4 + count * 4;
			const good =
				r.total === total &&
				r.data.byteLength === total &&
				r.header.byteLength === 4 &&
				sameBits(r.data, words.slice(0, total / 4).buffer);
			results[`count${count}`] = good;
			ok &&= good;
		}
		// a total past the capacity rejects (and returns its slot)
		const enc = device.createCommandEncoder({ id: "selftest-partial-bad" });
		const bad = stagePartialRead(device, enc, {
			buffer: src,
			capacity,
			headerBytes: 4,
			total: () => capacity + 4,
		});
		submit(device, enc);
		const badRead = await settle(bad.read(), 5000);
		release(src);
		await sleep(0);
		const stats = readbackStats(device);
		results.bad = badRead.state;
		check(
			"readback-partial",
			ok && badRead.state === "rejected" && stats.busy === 0,
			{ ...results, busy: stats.busy },
		);
	});

	await run("profile", async () => {
		if (!hasFeature(device, "timestamp-query")) {
			check("profile", true, "no timestamp-query: skipped");
			return;
		}
		resetGpuProfile();
		globalThis.__RIGI_GPU_PROFILE__ = true;
		try {
			const n = 1 << 16;
			const k = kernel(device, K_AXPY);
			const p = uniform(device, new Uint32Array([3, n]).buffer);
			const xb = storage(device, n * 4);
			const out = storage(device, n * 4);
			for (let i = 0; i < 3; i++)
				await readBack(
					device,
					(enc) =>
						dispatch(
							enc,
							k,
							{ p, x: xb, y: xb, out },
							n / 64,
							1,
							1,
							"selftest-prof",
						),
					[{ buffer: out, size: 4 }],
				);
			release(p, xb, out);
		} finally {
			globalThis.__RIGI_GPU_PROFILE__ = undefined;
		}
		const prof = await getGpuProfile();
		const e = prof["selftest-prof"];
		check("profile", e?.count === 3 && e.gpuMs >= 0 && e.gpuMs < 1000, prof);
		resetGpuProfile();
	});

	await run("adopt-render-device", async () => {
		const render: Device = await luma.createDevice({
			id: "selftest-render",
			type: "webgpu",
			adapters: [webgpuAdapter],
		});
		adoptRenderDevice(null);
		const before = await getComputeDevice();
		adoptRenderDevice(render);
		const during = await getComputeDevice();
		// kernels run on the adopted device too
		const k = kernel(render, K_AXPY);
		const x = u32(64, (i) => i);
		const p = uniform(render, new Uint32Array([2, 64]).buffer);
		const xb = storage(render, x);
		const out = storage(render, 256);
		const [r] = await readBack(
			render,
			(enc) => dispatch(enc, k, { p, x: xb, y: xb, out }, 1),
			[{ buffer: out, size: 256 }],
		);
		release(p, xb, out);
		render.destroy();
		await render.lost;
		const after = await getComputeDevice();
		check(
			"adopt-render-device",
			before === device &&
				during === render &&
				sameBits(r, axpyCpu(x, x, 2).buffer) &&
				adoptedRenderDevice() === null &&
				after === device,
		);
	});

	await run("realm-profile", async () => {
		const off = realmGpuOptions();
		globalThis.__RIGI_GPU_PROFILE__ = true;
		const on = realmGpuOptions();
		const k = kernel(device, K_AXPY);
		const p = uniform(device, new Uint32Array([3, 64]).buffer);
		const xb = storage(device, 256);
		const out = storage(device, 256);
		resetGpuProfile();
		await readBack(
			device,
			(enc) =>
				dispatch(enc, k, { p, x: xb, y: xb, out }, 1, 1, 1, "selftest-realm"),
			[{ buffer: out, size: 4 }],
		);
		release(p, xb, out);
		// what a worker sends back: its totals, then cleared
		const taken = await takeGpuProfile();
		const left = await getGpuProfile();
		mergeGpuProfile("selftest-worker", taken);
		mergeGpuProfile("selftest-worker", undefined);
		const merged = await getGpuProfile();
		globalThis.__RIGI_GPU_PROFILE__ = undefined;
		const none = takeGpuProfile();
		resetGpuProfile();
		const g = globalThis as { __RIGI_GPU_CHECKS__?: boolean };
		applyRealmGpuOptions({ checks: true });
		const applied = g.__RIGI_GPU_CHECKS__ === true;
		g.__RIGI_GPU_CHECKS__ = undefined;
		const timed = hasFeature(device, "timestamp-query");
		check(
			"realm-profile",
			off === undefined &&
				on?.profile === true &&
				none === undefined &&
				applied &&
				(!timed ||
					(taken?.["selftest-realm"]?.count === 1 &&
						!left["selftest-realm"] &&
						merged["selftest-worker:selftest-realm"]?.count === 1)),
			{ on, taken, merged },
		);
	});

	await run("error-checks", async () => {
		const g = globalThis as { __RIGI_GPU_CHECKS__?: boolean };
		const res: Record<string, unknown> = {};
		const attempt = () =>
			settle(
				(async () => {
					const o = storage(device, new Uint32Array(64).fill(7));
					try {
						const [b] = await readBack(
							device,
							(enc) => dispatch(enc, kernel(device, K_BAD), { out: o }, 1),
							[{ buffer: o, size: 256 }],
						);
						return new Uint32Array(b)[0];
					} finally {
						release(o);
					}
				})(),
				3000,
			);
		// a storage binding without STORAGE usage: a bind-group validation error
		const badBinding = () =>
			settle(
				(async () => {
					const k = kernel(device, K_AXPY);
					const p = uniform(device, new Uint32Array([1, 64]).buffer);
					const xb = storage(device, 256);
					const out = storage(device, 256);
					try {
						const [b] = await readBack(
							device,
							(enc) => dispatch(enc, k, { p, x: p, y: xb, out }, 1),
							[{ buffer: out, size: 4 }],
						);
						return new Uint32Array(b)[0];
					} finally {
						release(p, xb, out);
					}
				})(),
				3000,
			);
		g.__RIGI_GPU_CHECKS__ = undefined;
		const off = await attempt();
		g.__RIGI_GPU_CHECKS__ = true;
		const on = await attempt();
		const onBinding = await badBinding();
		// a valid kernel under checks: same bits as without
		const x = u32(1000, (i) => i * 2654435761);
		const k = kernel(device, K_AXPY);
		const p = uniform(device, new Uint32Array([9, 1000]).buffer);
		const xb = storage(device, x);
		const out = storage(device, 4000);
		const [good] = await readBack(
			device,
			(enc) => dispatch(enc, k, { p, x: xb, y: xb, out }, 16),
			[{ buffer: out, size: 4000 }],
		);
		release(p, xb, out);
		g.__RIGI_GPU_CHECKS__ = undefined;
		res.off = off;
		res.on = on;
		res.onBinding = onBinding;
		// the pool / readback state is still usable after the failures
		const stats = readbackStats(device);
		check(
			"error-checks",
			off.state === "resolved" &&
				on.state === "rejected" &&
				on.error.startsWith(GpuValidationError.name) &&
				onBinding.state === "rejected" &&
				sameBits(good, axpyCpu(x, x, 9).buffer) &&
				stats.busy === 0,
			res,
		);
	});

	await run("error-checks-cost", async () => {
		// the typical small kernel + readback (align's grid is ~2 ms wall): checks off vs on, interleaved
		const g = globalThis as { __RIGI_GPU_CHECKS__?: boolean };
		const n = 1 << 14;
		const k = kernel(device, K_AXPY);
		const x = u32(n, (i) => i);
		const once = () =>
			withLease("selftest-cost", async () => {
				const p = pooledUniform(
					device,
					"selftest-cost/p",
					new Uint32Array([3, n]),
				);
				const xb = pooledStorage(device, "selftest-cost/x", x);
				const out = pooledStorage(device, "selftest-cost/out", n * 4, {
					zero: false,
				});
				const t = performance.now();
				await readBack(
					device,
					(enc) => dispatch(enc, k, { p, x: xb, y: xb, out }, n / 64),
					[{ buffer: out, size: n * 4 }],
				);
				return performance.now() - t;
			});
		const ms: Record<"off" | "on", number[]> = { off: [], on: [] };
		for (let i = 0; i < 20; i++) await once(); // warm
		for (let rep = 0; rep < 10; rep++)
			for (const mode of ["off", "on"] as const) {
				g.__RIGI_GPU_CHECKS__ = mode === "on";
				for (let i = 0; i < 20; i++) ms[mode].push(await once());
			}
		g.__RIGI_GPU_CHECKS__ = undefined;
		const med = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];
		const mean = (a: number[]) => a.reduce((p, q) => p + q, 0) / a.length;
		const r = {
			calls: ms.off.length,
			medianOff: +med(ms.off).toFixed(3),
			medianOn: +med(ms.on).toFixed(3),
			meanOff: +mean(ms.off).toFixed(3),
			meanOn: +mean(ms.on).toFixed(3),
		};
		// negligible: within 0.2 ms (or 15 %) of the unchecked median
		check(
			"error-checks-cost",
			r.medianOn - r.medianOff < Math.max(0.2, 0.15 * r.medianOff),
			r,
		);
	});

	await run("idle-release", async () => {
		const d = await getComputeDevice();
		if (!d) throw new Error("no device");
		// an adopted render device must survive the sidecar's idle release
		const render: Device = await luma.createDevice({
			id: "selftest-idle-render",
			type: "webgpu",
			adapters: [webgpuAdapter],
		});
		adoptRenderDevice(render);
		releaseWhenIdle(150);
		// a held lease keeps it alive past the timeout
		await withLease("selftest-idle", () => sleep(400));
		const aliveWhileLeased = !d.isLost;
		await sleep(500);
		const released = d.isLost;
		releaseWhenIdle(null);
		const adoptKept =
			adoptedRenderDevice() === render &&
			!render.isLost &&
			(await getComputeDevice()) === render;
		render.destroy();
		await render.lost;
		const d2 = await getComputeDevice();
		const x = u32(64, (i) => i * 3);
		let ok = false;
		if (d2) {
			const p = uniform(d2, new Uint32Array([4, 64]).buffer);
			const xb = storage(d2, x);
			const out = storage(d2, 256);
			const [r] = await readBack(
				d2,
				(enc) => dispatch(enc, kernel(d2, K_AXPY), { p, x: xb, y: xb, out }, 1),
				[{ buffer: out, size: 256 }],
			);
			release(p, xb, out);
			ok = sameBits(r, axpyCpu(x, x, 4).buffer);
		}
		check(
			"idle-release",
			aliveWhileLeased &&
				released &&
				adoptKept &&
				!!d2 &&
				d2 !== d &&
				d2 !== render &&
				ok,
			{
				aliveWhileLeased,
				released,
				adoptKept,
				recreated: !!d2 && d2 !== d && d2 !== render,
				ok,
			},
		);
	});

	await run("device-loss", async () => {
		const d = await getComputeDevice();
		if (!d) throw new Error("no device");
		// warm state on the old device: pooled slots, a readback slot, a cached pipeline
		const k = kernel(d, K_SPIN);
		const n = 1 << 20;
		const o = pooledStorage(d, "selftest-loss/out", n * 4, { zero: false });
		// a caller holding a lease, with a long kernel in flight
		const inflight = withLease("selftest-loss", async () => {
			const enc = d.createCommandEncoder({ id: "selftest-spin" });
			dispatch(enc, k, { out: o }, n / 64);
			const s = stageReads(d, enc, [{ buffer: o, size: 1024 }]);
			submit(d, enc);
			return s.read();
		});
		await sleep(0);
		const pooledBefore = poolStats(d).slots;
		d.destroy();
		// synchronously after destroy(), before d.lost settles: never the lost device
		const next = getComputeDevice();
		const read = await settle(inflight, 3000);
		// the lease was released by the rejection
		const lease = await settle(
			withLease("selftest-loss", () => "free"),
			1000,
		);
		// new work on the lost device rejects at once
		const again = await settle(
			readBack(d, (enc) => dispatch(enc, k, { out: o }, 1), [
				{ buffer: o, size: 4 },
			]),
			1000,
		);
		const d2 = await next;
		await d.lost;
		const oldPool = poolStats(d).slots;
		const oldRing = readbackStats(d).slots;
		// after the loss fired: a hook registered late still runs (in a microtask), and a caller
		// that stages reads on the stale device and does not cancel() them when submit() throws
		// (sky/refine, the look passes) leaks no slot and no in-flight count (idle release stays on)
		let lateHook = false;
		onLost(d, () => {
			lateHook = true;
		});
		const staleEnc = d.createCommandEncoder({ id: "selftest-stale" });
		// (a buffer made on the stale device: the pooled `o` was destroyed with the pool)
		const staleSrc = d.createBuffer({
			id: "selftest-stale-src",
			usage: Buffer.STORAGE | Buffer.COPY_SRC,
			byteLength: 256,
		});
		stageReads(d, staleEnc, [{ buffer: staleSrc, size: 4 }]);
		const staleBusy = readbackStats(d).busy;
		let staleThrew = false;
		try {
			submit(d, staleEnc);
		} catch (e) {
			staleThrew = e instanceof GpuDeviceLostError;
		}
		const staleBusyAfter = readbackStats(d).busy;
		await sleep(5);
		const late = {
			lateHook,
			staleBusy,
			staleThrew,
			staleBusyAfter,
			staleRing: readbackStats(d).slots,
			idle: idleFor() > 0,
		};
		// the new device computes the same as the CPU, from fresh pools / pipelines
		const x = u32(1000, (i) => i * 7 + 1);
		let same = false;
		let fresh = false;
		if (d2) {
			const r = await withLease("selftest-axpy", async () => {
				const p = pooledUniform(
					d2,
					"selftest-axpy/p",
					new Uint32Array([6, 1000]),
				);
				const xb = pooledStorage(d2, "selftest-axpy/x", x);
				const out = pooledStorage(d2, "selftest-axpy/out", 4000, {
					zero: false,
				});
				fresh = !xb.destroyed && kernel(d2, K_AXPY) !== kernel(d, K_AXPY);
				return readBack(
					d2,
					(enc) =>
						dispatch(enc, kernel(d2, K_AXPY), { p, x: xb, y: xb, out }, 16),
					[{ buffer: out, size: 4000 }],
				);
			});
			same = sameBits(r[0], axpyCpu(x, x, 6).buffer);
		}
		check(
			"device-loss",
			read.state === "rejected" &&
				read.error.startsWith(GpuDeviceLostError.name) &&
				read.ms < 1000 &&
				lease.state === "resolved" &&
				again.state === "rejected" &&
				!!d2 &&
				d2 !== d &&
				!d2.isLost &&
				pooledBefore > 0 &&
				oldPool === 0 &&
				oldRing === 0 &&
				late.lateHook &&
				late.staleBusy === 1 &&
				late.staleThrew &&
				late.staleBusyAfter === 0 &&
				late.staleRing === 0 &&
				late.idle &&
				fresh &&
				same,
			{
				read: { state: read.state, ms: read.ms, error: read.error },
				lease: lease.state,
				again: { state: again.state, error: again.error },
				newDevice: !!d2 && d2 !== d,
				pooledBefore,
				oldPool,
				oldRing,
				late,
				fresh,
				same,
			},
		);
	});

	return {
		ok: checks.every((c) => c.ok),
		checks,
		ms: performance.now() - t0,
	};
}
