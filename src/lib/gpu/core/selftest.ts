// Browser self-test of src/lib/gpu/core (scripts/gpu/core-selftest.mjs runs it in headless
// Chromium): device registry, pool + leases, ring readback, kernels (sync / async / pooled, per-pass
// bindings), a ComputeGraph with a custom WGSL node feeding GPUReduction, timestamp profiling,
// adoptRenderDevice, the worker profile protocol, error checks (and their cost), the idle release and
// device loss (last: they destroy the sidecar). Every GPU result is compared exactly with a CPU
// computation.
import { Buffer, type Device, luma } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { setFlagOverride } from "#/lib/flags";
import {
	adoptedRenderDevice,
	adoptRenderDevice,
	COMPUTE_FEATURES,
	getComputeDevice,
	hasFeature,
	RAISED_LIMITS,
	releaseWhenIdle,
} from "./device";
import { ComputeGraph } from "./graph";
import {
	defineKernel,
	dispatch,
	dispatchAll,
	kernel,
	kernelAsync,
	release,
	stage,
	storage,
	submit,
	uniform,
	warmKernelsAsync,
} from "./kernel";
import { GpuDeviceLostError, idleFor, onLost } from "./lifecycle";
import { GPUReduction } from "./luma";
import {
	acquire,
	capacityFor,
	pooledStorage,
	pooledUniform,
	poolStats,
	withLease,
} from "./pool";
import { getGpuProfile, resetGpuProfile } from "./profile";
import { GpuValidationError } from "./queue";
import { readBack, readbackStats, stageReads } from "./readback";
import {
	applyRealmGpuOptions,
	mergeGpuProfile,
	realmGpuOptions,
	takeGpuProfile,
} from "./realm";

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
		const gpu = (
			navigator as unknown as {
				gpu: {
					requestAdapter: (
						o?: unknown,
					) => Promise<{ limits: Record<string, number> } | null>;
				};
			}
		).gpu;
		const adapter = await gpu.requestAdapter({
			powerPreference: "high-performance",
		});
		const limits = device.limits as unknown as Record<string, number>;
		const raised = Object.fromEntries(
			RAISED_LIMITS.map((k) => [k, [limits[k], adapter?.limits[k]]]),
		);
		check(
			"device-features-limits",
			!!adapter &&
				RAISED_LIMITS.every((k) => limits[k] === adapter.limits[k]) &&
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
