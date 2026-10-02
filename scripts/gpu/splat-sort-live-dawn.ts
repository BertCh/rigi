// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live splat sort + draw, before / after the indirect path (src/lib/gpu/splat-sort/live.wgsl.ts), on
// Dawn in node. A live buffer of CAPACITY splats whose first LIVE are real (the rest NaN dead slots),
// like nearfield/live:
//   before: fixed-count GpuSplatSorter over CAPACITY (GPUSort radix) + a draw of CAPACITY instances
//   after:  GpuSplatSorter with a counter buffer (counting sort over the live prefix, indirect
//           dispatch) + drawIndirect with instanceCount = kept
// The draw is a stand-in for the splat layer (an 8 px quad per splat, premultiplied blend, 1280x720
// offscreen), not its EWA shader: it shows the instance-count effect, not the layer's absolute cost.
// Also checks the live order: a permutation of the kept indices, ascending key, drawArgs.kept == CPU.
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/splat-sort-live-dawn.ts [--capacity 400000] [--lives 50000,200000] [--reps 9]
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import {
	attachWebGPUDevice,
	nativeWebGPUBuffer,
} from "../../src/lib/gpu/core/luma";
import { getGpuProfile, resetGpuProfile } from "../../src/lib/gpu/core/profile";
import { splatKeysF32 } from "../../src/lib/gpu/splat-sort/cpu";
import { GpuSplatSorter } from "../../src/lib/gpu/splat-sort/index";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 ? argv[i + 1] : d;
};
const CAPACITY = Number(arg("capacity", "400000"));
const LIVES = arg("lives", "50000,200000").split(",").map(Number);
const REPS = Number(arg("reps", "9"));
const dir = process.env.DAWN_DIR;
if (!dir) {
	console.error("set DAWN_DIR to a directory with `npm i webgpu@0.3.0`");
	process.exit(2);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) process.exit(2);
const limits: Record<string, number> = {};
for (const k of [
	"maxStorageBuffersPerShaderStage",
	"maxBufferSize",
	"maxStorageBufferBindingSize",
])
	limits[k] = adapter.limits[k];
const features = ["timestamp-query", "subgroups"].filter((f) =>
	adapter.features.has(f),
);
const handle: GPUDevice = await adapter.requestDevice({
	requiredFeatures: features,
	requiredLimits: limits,
});
console.log("adapter:", JSON.stringify(adapter.info ?? {}));
const device: Device = await attachWebGPUDevice(handle, { id: "bench" }, true);
const q = handle.queue;
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const STORAGE = 0x80 | 0x08 | 0x04;

let seed = 7;
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};

// stand-in splat draw: reads position by order[instance], 8 px quad, premultiplied blend
const W = 1280;
const H = 720;
const DRAW_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> splatData: array<vec4<u32>>;
@group(0) @binding(1) var<storage, read> splatOrder: array<u32>;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) inst: u32) -> VOut {
  let i = splatOrder[inst];
  let t = bitcast<vec4<f32>>(splatData[3u * i]);
  let corner = array<vec2<f32>, 6>(vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.), vec2(-1.,1.), vec2(1.,-1.), vec2(1.,1.))[v];
  var o: VOut;
  let w = -t.z;
  if (!(w > 0.01)) { o.pos = vec4<f32>(2., 2., 2., 1.); o.uv = vec2<f32>(0.); return o; }
  let c = vec2<f32>(t.x / w * 1.2, t.y / w * 2.1);
  o.pos = vec4<f32>(c + corner * vec2<f32>(8. / ${W}., 8. / ${H}.), 0.5, 1.);
  o.uv = corner;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4<f32> {
  let a = exp(-dot(i.uv, i.uv) * 2.) * 0.2;
  return vec4<f32>(a * 0.8, a * 0.6, a, a);
}
`;
const module = handle.createShaderModule({ code: DRAW_WGSL });
const pipeline = handle.createRenderPipeline({
	layout: "auto",
	vertex: { module, entryPoint: "vs" },
	fragment: {
		module,
		entryPoint: "fs",
		targets: [
			{
				format: "rgba8unorm",
				blend: {
					color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
					alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
				},
			},
		],
	},
	primitive: { topology: "triangle-list" },
});
const target = handle.createTexture({
	size: [W, H],
	format: "rgba8unorm",
	usage: 0x10,
});
const hasTs = features.includes("timestamp-query");
const tsSet = hasTs
	? handle.createQuerySet({ type: "timestamp", count: 2 })
	: null;
const tsResolve = handle.createBuffer({
	size: 16,
	usage: 0x200 | 0x4,
});
const tsRead = handle.createBuffer({
	size: 16,
	usage: 0x8 | 0x1,
});

/** One draw submit; returns its GPU ms (timestamp pair) when supported. */
async function drawOnce(
	data: GPUBuffer,
	order: GPUBuffer,
	instances: number,
	args: GPUBuffer | null,
): Promise<number> {
	const bind = handle.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: data } },
			{ binding: 1, resource: { buffer: order } },
		],
	});
	const enc = handle.createCommandEncoder();
	const pass = enc.beginRenderPass({
		colorAttachments: [
			{
				view: target.createView(),
				loadOp: "clear",
				storeOp: "store",
				clearValue: [0, 0, 0, 0],
			},
		],
		...(tsSet
			? {
					timestampWrites: {
						querySet: tsSet,
						beginningOfPassWriteIndex: 0,
						endOfPassWriteIndex: 1,
					},
				}
			: {}),
	});
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bind);
	if (args) pass.drawIndirect(args, 0);
	else pass.draw(6, instances);
	pass.end();
	if (tsSet) {
		enc.resolveQuerySet(tsSet, 0, 2, tsResolve, 0);
		enc.copyBufferToBuffer(tsResolve, 0, tsRead, 0, 16);
	}
	q.submit([enc.finish()]);
	if (!tsSet) return 0;
	await tsRead.mapAsync(1);
	const t = new BigUint64Array(tsRead.getMappedRange().slice(0));
	tsRead.unmap();
	return Number(t[1] - t[0]) / 1e6;
}

const row = [0, 0, 1, 0] as const;
let failures = 0;
for (const live of LIVES) {
	const words = new Uint32Array(CAPACITY * 12);
	const f32 = new Float32Array(words.buffer);
	const positions = new Float32Array(live * 3);
	for (let i = 0; i < CAPACITY; i++) {
		if (i < live) {
			// a few behind the camera plane: dropped
			const x = (rnd() - 0.5) * 60;
			const y = (rnd() - 0.5) * 30;
			const z = rnd() < 0.02 ? 5 : -(0.05 + rnd() * 100);
			f32[12 * i] = x;
			f32[12 * i + 1] = y;
			f32[12 * i + 2] = z;
			positions.set([x, y, z], 3 * i);
		} else {
			f32[12 * i] = Number.NaN;
			f32[12 * i + 1] = Number.NaN;
			f32[12 * i + 2] = Number.NaN;
		}
	}
	const mkOrder = () => {
		const id = new Uint32Array(CAPACITY);
		for (let i = 0; i < CAPACITY; i++) id[i] = i;
		return device.createBuffer({
			byteLength: CAPACITY * 4,
			usage: STORAGE,
			data: id,
		});
	};
	const data = device.createBuffer({
		byteLength: words.byteLength,
		usage: STORAGE,
		data: words,
	});
	const counter = device.createBuffer({
		byteLength: 16,
		usage: STORAGE,
		data: new Uint32Array([live, 0, 0, 0]),
	});
	const nativeData = nativeWebGPUBuffer(data) as GPUBuffer;
	const out: Record<string, { wall: number; sort: number; draw: number }> = {};

	for (const mode of ["before", "after"] as const) {
		const order = mkOrder();
		const sorter = new GpuSplatSorter(
			device,
			data,
			order,
			CAPACITY,
			mode === "after" ? counter : undefined,
		);
		await sorter.ready;
		const nativeOrder = nativeWebGPUBuffer(order) as GPUBuffer;
		const nativeArgs = sorter.drawArgs
			? (nativeWebGPUBuffer(sorter.drawArgs) as GPUBuffer)
			: null;
		const step = async () => {
			const a = performance.now();
			await sorter.sort(row);
			const g = await drawOnce(nativeData, nativeOrder, CAPACITY, nativeArgs);
			await q.onSubmittedWorkDone();
			return { wall: performance.now() - a, draw: g };
		};
		for (let r = 0; r < 3; r++) await step();
		const walls: number[] = [];
		const draws: number[] = [];
		for (let r = 0; r < REPS; r++) {
			const s = await step();
			walls.push(s.wall);
			draws.push(s.draw);
		}
		const prof0 = globalThis as { __RIGI_GPU_PROFILE__?: boolean };
		prof0.__RIGI_GPU_PROFILE__ = true;
		resetGpuProfile();
		const PR = Math.max(REPS, 7);
		for (let r = 0; r < PR; r++) {
			await sorter.sort(row);
			await q.onSubmittedWorkDone();
		}
		await new Promise((r) => setTimeout(r, 200));
		const prof = await getGpuProfile();
		prof0.__RIGI_GPU_PROFILE__ = false;
		let sort = 0;
		for (const [k, v] of Object.entries(prof))
			if (k.startsWith("splat-sort")) sort += v.gpuMs / v.count;
		out[mode] = { wall: med(walls), sort, draw: med(draws) };
		if (mode === "after") {
			const got = new Uint32Array((await order.readAsync()).slice().buffer);
			const args = new Uint32Array(
				(
					await (
						sorter.drawArgs as NonNullable<typeof sorter.drawArgs>
					).readAsync()
				).slice().buffer,
			);
			const { keys, kept } = splatKeysF32(positions, live, row);
			const seen = new Set<number>();
			let ok = args[1] === kept && args[0] === 6;
			let prev = -1;
			for (let i = 0; i < kept && ok; i++) {
				const idx = got[i];
				if (idx >= live || seen.has(idx) || keys[idx] > 65535) ok = false;
				seen.add(idx);
				// ascending key; GPU keys may differ from the f32 twin by 1 at bin edges
				if (keys[idx] + 1 < prev) ok = false;
				prev = Math.max(prev, keys[idx]);
			}
			console.log(
				`live=${live} kept(cpu)=${kept} drawArgs=[${Array.from(args)}] order ok=${ok}`,
			);
			if (!ok) failures++;
		}
		sorter.destroy();
		order.destroy();
	}
	console.log(
		`capacity=${CAPACITY} live=${live} (median of ${REPS}; shared GPU, noisy)`,
		JSON.stringify(
			Object.fromEntries(
				Object.entries(out).map(([k, v]) => [
					k,
					{
						wallMs: +v.wall.toFixed(2),
						sortGpuMs: +v.sort.toFixed(3),
						drawGpuMs: +v.draw.toFixed(3),
						sortPlusDrawGpuMs: +(v.sort + v.draw).toFixed(3),
					},
				]),
			),
		),
	);
	data.destroy();
	counter.destroy();
}
process.exit(failures ? 1 : 0);
