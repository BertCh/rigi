// Browser self-test of src/lib/gpu/core (scripts/gpu/core-selftest.mjs runs it in headless
// Chromium): device registry, pool + leases, ring readback, kernels (sync / async / pooled, per-pass
// bindings), a ComputeGraph with a custom WGSL node feeding GPUReduction, timestamp profiling, and
// adoptRenderDevice. Every GPU result is compared exactly with a CPU computation.
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
import { GPUReduction } from "./luma";
import {
	acquire,
	capacityFor,
	pooledStorage,
	pooledUniform,
	withLease,
} from "./pool";
import { getGpuProfile, resetGpuProfile } from "./profile";
import { readBack, readbackStats } from "./readback";

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

	return {
		ok: checks.every((c) => c.ok),
		checks,
		ms: performance.now() - t0,
	};
}
