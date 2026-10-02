// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Runs the REAL WGSL of the GPU sky prep (src/lib/gpu/sky/prep.wgsl.ts, the kernels exactly as the
// worker compiles them) on a native WebGPU implementation in node (Dawn, via the `webgpu` npm
// package) and compares every output with the CPU chain of sky/core.ts, Object.is on each float and
// byte-for-byte on the RGBA words. This is the check that the compiled shader computes what the u32
// emulation (sky-prep-check.ts) computes. It is not a browser test: there is no ImageBitmap upload
// (the padded rows are written from the pixels), and no ORT.
//
// `webgpu` is deliberately not a dependency of the app; install it anywhere and point DAWN_DIR at it:
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # 0.3.x loads on macOS 14; newer wants 26
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/sky-prep-dawn.ts [--quick] [--photos N]
// --graph runs the app's own path instead of hand-made bind groups: prepSkyGpuFromRows (src/lib/gpu/sky/
// prep.ts), i.e. the cachedGraph "sky-prep" ComputeGraph on a luma.gl WebGPU device over the same Dawn,
// its readbacks (readAll) and the opacity flag (isOpaque); only the ImageBitmap upload is replaced by a
// queue write of the padded rows.
// --graph --release also frees the cached graphs (releasePrepGraphs) and reruns two shapes: the cache
// empties, the rerun rebuilds (no cache hit) and its outputs are bit-identical to the first run.
// Exit 1 on any mismatch, 2 when no adapter/package is available.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cachedGraphCount } from "../../src/lib/gpu/core/graph";
import {
	K_PREP_H,
	K_PREP_NORM,
	K_PREP_UNPACK,
	K_PREP_V,
	prepSkyGpuFromRows,
	releasePrepGraphs,
} from "../../src/lib/gpu/sky/prep";
import { axisTapsF64, constsTable } from "../../src/lib/gpu/sky/prep-ref";
import { lutTable } from "../../src/lib/gpu/sky/refine";
import {
	modelSize,
	normalise,
	resamplePlanes,
	rgbPlanes,
	workingSize,
} from "../../src/lib/sky/core";

const argv = process.argv.slice(2);
const QUICK = argv.includes("--quick");
const GRAPH = argv.includes("--graph");
const RELEASE = argv.includes("--release");
const pi = argv.indexOf("--photos");
const MAX_PHOTOS = pi >= 0 ? Number(argv[pi + 1]) : 99;
const ROOT = path.resolve(import.meta.dirname, "../..");

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
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.error("no WebGPU adapter");
	process.exit(2);
}
const device: GPUDevice = await adapter.requestDevice();
console.log("adapter:", JSON.stringify(adapter.info ?? {}));
let lumaDevice: Device | null = null;
if (GRAPH) {
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu, userAgent: "node" },
		configurable: true,
	});
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	lumaDevice = await luma.createDevice({
		type: "webgpu",
		adapters: [webgpuAdapter],
		createCanvasContext: false,
	} as never);
	console.log("mode: --graph (prepSkyGpuFromRows on a luma.gl device)");
}

// GPUBufferUsage flags (the globals only exist once the dawn package installs them)
const U = {
	MAP_READ: 0x01,
	COPY_SRC: 0x04,
	COPY_DST: 0x08,
	UNIFORM: 0x40,
	STORAGE: 0x80,
};
const buf = (size: number, usage: number, data?: ArrayBufferView) => {
	const b = device.createBuffer({
		size: Math.max(16, Math.ceil(size / 4) * 4),
		usage,
	});
	if (data)
		device.queue.writeBuffer(
			b,
			0,
			data.buffer as ArrayBuffer,
			data.byteOffset,
			data.byteLength,
		);
	return b;
};
const STORAGE = U.STORAGE | U.COPY_DST | U.COPY_SRC;

const pipelines = new Map<string, GPUComputePipeline>();
const pipe = (spec: { id: string; source: string; entryPoint: string }) => {
	let p = pipelines.get(spec.id);
	if (!p) {
		const module = device.createShaderModule({ code: spec.source });
		p = device.createComputePipeline({
			layout: "auto",
			compute: { module, entryPoint: spec.entryPoint },
		});
		pipelines.set(spec.id, p);
	}
	return p;
};

async function readBuf(b: GPUBuffer, size: number) {
	const staging = device.createBuffer({
		size,
		usage: U.COPY_DST | U.MAP_READ,
	});
	const enc = device.createCommandEncoder();
	enc.copyBufferToBuffer(b, 0, staging, 0, size);
	device.queue.submit([enc.finish()]);
	await staging.mapAsync(1 /* GPUMapMode.READ */);
	const out = staging.getMappedRange().slice(0);
	staging.unmap();
	staging.destroy();
	return out;
}

let checks = 0;
let fails = 0;

async function runGpu(
	rgba: Uint8Array,
	W: number,
	H: number,
	lw: number,
	lh: number,
) {
	const n = lw * lh;
	const N = W * H;
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	const h = axisTapsF64(W, lw);
	const v = axisTapsF64(H, lh);
	const cst = constsTable([h.scaleLo, h.scaleHi], [v.scaleLo, v.scaleHi]);
	const padded = new Uint8Array(rowBytes * H);
	for (let y = 0; y < H; y++)
		padded.set(rgba.subarray(4 * y * W, 4 * (y + 1) * W), y * rowBytes);
	if (lumaDevice) {
		const prep = await prepSkyGpuFromRows(lumaDevice, padded, W, H, lw, lh);
		try {
			const all = await prep.readAll();
			let opaque = true;
			for (let i = 3; i < rgba.length; i += 4)
				if (rgba[i] !== 255) opaque = false;
			if ((await prep.isOpaque()) !== opaque) {
				console.log(`FAIL isOpaque: expected ${opaque}`);
				fails++;
			}
			return { rgba: all.rgba, lo: all.rgbLo, inp: all.input };
		} finally {
			prep.dispose();
		}
	}
	const prm = buf(
		32,
		U.UNIFORM | U.COPY_DST,
		new Uint32Array([W, H, lw, lh, rowBytes / 4, 0, 0, 0]),
	);
	const bufs: Record<string, GPUBuffer> = {
		prm,
		pad: buf(rowBytes * H, STORAGE, padded),
		rgba: buf(N * 4, STORAGE),
		axH: buf(h.table.byteLength, STORAGE, h.table),
		axV: buf(v.table.byteLength, STORAGE, v.table),
		cst: buf(cst.byteLength, STORAGE, cst),
		lut: buf(512 * 4, STORAGE, lutTable()),
		tmp: buf(3 * H * lw * 4, STORAGE),
		lo: buf(3 * n * 4, STORAGE),
		inp: buf(3 * n * 4, STORAGE),
	};
	const jobs: [typeof K_PREP_H, number][] = [
		[K_PREP_UNPACK, N],
		[K_PREP_H, 3 * H * lw],
		[K_PREP_V, 3 * n],
		[K_PREP_NORM, 3 * n],
	];
	const enc = device.createCommandEncoder();
	const pass = enc.beginComputePass();
	for (const [spec, count] of jobs) {
		const p = pipe(spec);
		pass.setPipeline(p);
		pass.setBindGroup(
			0,
			device.createBindGroup({
				layout: p.getBindGroupLayout(0),
				entries: spec.layout.map(([name], binding) => ({
					binding,
					resource: { buffer: bufs[name] },
				})),
			}),
		);
		pass.dispatchWorkgroups(Math.ceil(count / 256));
	}
	pass.end();
	device.queue.submit([enc.finish()]);
	const out = {
		rgba: new Uint8Array(await readBuf(bufs.rgba, N * 4)),
		lo: new Uint32Array(await readBuf(bufs.lo, 3 * n * 4)),
		inp: new Uint32Array(await readBuf(bufs.inp, 3 * n * 4)),
	};
	for (const b of Object.values(bufs)) b.destroy();
	return out;
}

const f32bits = (f: Float32Array) =>
	new Uint32Array(f.buffer, f.byteOffset, f.length);

async function chain(
	name: string,
	rgba: Uint8Array,
	W: number,
	H: number,
	longSide: number,
) {
	const { width: lw, height: lh } = modelSize(W, H, longSide);
	if (lw > W || lh > H) return;
	const lo = resamplePlanes(
		rgbPlanes({ width: W, height: H, data: rgba }),
		W,
		H,
		3,
		lw,
		lh,
	);
	const inp = normalise(lo, lw * lh);
	const t0 = performance.now();
	const g = await runGpu(rgba, W, H, lw, lh);
	const ms = performance.now() - t0;
	let bad = 0;
	for (let i = 0; i < rgba.length; i++) if (g.rgba[i] !== rgba[i]) bad++;
	const wl = f32bits(lo);
	const wi = f32bits(inp);
	const fl = new Float32Array(g.lo.buffer);
	const fi = new Float32Array(g.inp.buffer);
	for (let i = 0; i < wl.length; i++) {
		checks += 2;
		if (g.lo[i] !== wl[i] || !Object.is(fl[i], lo[i])) bad++;
		if (g.inp[i] !== wi[i] || !Object.is(fi[i], inp[i])) bad++;
	}
	if (bad) fails++;
	console.log(
		`${bad ? "FAIL" : "ok  "} ${name}: ${W}x${H} -> ${lw}x${lh}${bad ? ` (${bad} differ)` : ""} gpu ${ms.toFixed(0)} ms`,
	);
}

let seed = 12345;
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};
const synth = (
	W: number,
	H: number,
	f: (x: number, y: number, c: number) => number,
) => {
	const a = new Uint8Array(4 * W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			for (let c = 0; c < 4; c++)
				a[4 * (y * W + x) + c] = c === 3 ? 255 : f(x, y, c) & 255;
	return a;
};
const sizes: [number, number, number][] = QUICK
	? [[1024, 683, 512]]
	: [
			[1024, 683, 512],
			[683, 1024, 512],
			[1000, 667, 512],
			[777, 1031, 512],
			[1024, 768, 384],
			[600, 450, 512],
			[513, 512, 512],
			[1024, 1024, 512],
			[2048, 1365, 512],
		];
for (const [W, H, ls] of sizes) {
	await chain(
		"noise",
		synth(W, H, () => Math.floor(rnd() * 256)),
		W,
		H,
		ls,
	);
	if (QUICK) continue;
	await chain(
		"ramp",
		synth(W, H, (x, y, c) => (x * 255) / W + c * y),
		W,
		H,
		ls,
	);
	await chain(
		"sat",
		synth(W, H, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? 255 : 0)),
		W,
		H,
		ls,
	);
	await chain(
		"white",
		synth(W, H, () => 255),
		W,
		H,
		ls,
	);
	await chain(
		"black",
		synth(W, H, () => 0),
		W,
		H,
		ls,
	);
}
{
	const pd = path.join(ROOT, "public/photos");
	const files = fs.existsSync(pd)
		? fs
				.readdirSync(pd)
				.filter((f) => /\.jpe?g$/i.test(f))
				.sort()
		: [];
	let k = 0;
	for (const f of files) {
		if (k++ >= MAX_PHOTOS) break;
		const img = await loadImage(path.join(pd, f));
		const { width: W, height: H } = workingSize(img.width, img.height, 1024);
		const cv = createCanvas(W, H);
		const ctx = cv.getContext("2d");
		ctx.drawImage(img, 0, 0, W, H);
		const px = ctx.getImageData(0, 0, W, H).data;
		const u8 = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
		await chain(f, u8, W, H, 512);
		if (!QUICK) await chain(`${f}@384`, u8, W, H, 384);
	}
}
if (RELEASE && lumaDevice) {
	// two shapes, release, the same two again: bit-identical outputs from freshly built graphs
	const shapes: [number, number, number][] = [
		[1024, 683, 512],
		[600, 450, 512],
	];
	const run = async () => {
		const outs = [];
		for (const [W, H, ls] of shapes) {
			const { width: lw, height: lh } = modelSize(W, H, ls);
			const px = synth(W, H, (x, y, c) => x * 3 + y * 5 + c * 41);
			const rowBytes = Math.ceil((W * 4) / 256) * 256;
			const padded = new Uint8Array(rowBytes * H);
			for (let y = 0; y < H; y++)
				padded.set(px.subarray(4 * y * W, 4 * (y + 1) * W), y * rowBytes);
			const prep = await prepSkyGpuFromRows(lumaDevice, padded, W, H, lw, lh);
			try {
				outs.push(await prep.readAll());
			} finally {
				prep.dispose();
			}
		}
		return outs;
	};
	const same = (a: ArrayBufferView, b: ArrayBufferView) =>
		Buffer.compare(
			Buffer.from(a.buffer, a.byteOffset, a.byteLength),
			Buffer.from(b.buffer, b.byteOffset, b.byteLength),
		) === 0;
	const expect = (name: string, ok: boolean) => {
		console.log(`${ok ? "ok  " : "FAIL"} release: ${name}`);
		if (!ok) fails++;
	};
	await releasePrepGraphs(lumaDevice);
	const first = await run();
	expect(
		`2 cached graphs after two shapes (${cachedGraphCount(lumaDevice, "sky-prep")})`,
		cachedGraphCount(lumaDevice, "sky-prep") === 2,
	);
	await releasePrepGraphs(lumaDevice);
	expect(
		"0 after releasePrepGraphs",
		cachedGraphCount(lumaDevice, "sky-prep") === 0,
	);
	const again = await run();
	expect("2 rebuilt graphs", cachedGraphCount(lumaDevice, "sky-prep") === 2);
	expect(
		"outputs bit-identical (rgba, rgbLo, input)",
		first.every(
			(f, i) =>
				same(f.rgba, again[i].rgba) &&
				same(f.rgbLo, again[i].rgbLo) &&
				same(f.input, again[i].input),
		),
	);
	await releasePrepGraphs(lumaDevice);
}
console.log(`${checks} float comparisons, ${fails} failing cases`);
process.exit(fails ? 1 : 0);
