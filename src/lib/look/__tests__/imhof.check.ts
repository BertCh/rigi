// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Imhof relief (look/imhof.ts):
//  1. reference properties: scale weights, zero swing = swiss, the swing lights both sides of a N-S
//     ridge, colour is warm lit / cool shade, aerial perspective is monotone in range and off at 0;
//  2. the shader texts: the real WGSL (IMHOF_WGSL_MATH) runs as a compute kernel on Dawn (the
//     `webgpu` npm package, DAWN_DIR=<dir with node_modules/webgpu>; skipped with a note when unset)
//     over a synthetic fractal DEM and, when .cache/terrarium has one, a real tile, and every output
//     is compared with the TS reference within a small tolerance. The GLSL text is checked to carry
//     the same constants (it cannot run in node).
// Run: DAWN_DIR=/tmp/dawn npx tsx src/lib/look/__tests__/imhof.check.ts
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	IMHOF_GLSL_MATH,
	IMHOF_SCALE_CENTERS,
	IMHOF_WGSL_MATH,
	imhofAerial,
	imhofBlendNormalXy,
	imhofColour,
	imhofScaleWeights,
	imhofSwungLight,
} from "../imhof";

let failed = 0;
const ok = (cond: boolean, msg: string) => {
	if (!cond) {
		failed++;
		console.error(`FAIL ${msg}`);
	} else console.log(`ok   ${msg}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---- 1. reference properties -----------------------------------------------------------------
{
	const sums = [10, 300, 500, 1000, 2000, 5000, 7000, 20000, 25000, 1e6].map(
		(r) => imhofScaleWeights(r).reduce((a, b) => a + b, 0),
	);
	ok(
		sums.every((s) => near(s, 1, 1e-12)),
		"scale weights sum to 1",
	);
	ok(imhofScaleWeights(100)[0] === 1, "near range is all fine");
	ok(imhofScaleWeights(200000)[3] === 1, "far range is all coarsest");
	const mid = imhofScaleWeights(10 ** IMHOF_SCALE_CENTERS[1]);
	ok(near(mid[1], 1, 1e-12), "a scale centre is exactly that level");
	let monotone = true;
	let prev = 0;
	for (let lg = 2.5; lg < 4.6; lg += 0.01) {
		const w = imhofScaleWeights(10 ** lg);
		const coarse = w[1] + w[2] * 2 + w[3] * 3;
		if (coarse + 1e-9 < prev) monotone = false;
		prev = coarse;
	}
	ok(monotone, "coarse share never decreases with range");
	const xy = imhofBlendNormalXy(
		[
			[0.4, 0],
			[0.2, 0],
			[0.1, 0],
			[0, 0],
		],
		[0.5, 0.5, 0, 0],
	);
	ok(near(xy[0], 0.3, 1e-12), "blended normal xy");
}
{
	const slope = (az: number, s: number): [number, number, number] => {
		const a = (az * Math.PI) / 180;
		const x = Math.sin(a) * s;
		const y = Math.cos(a) * s;
		return [x, y, Math.sqrt(1 - s * s)];
	};
	// slope facing straight away from the NW light (aspect 135)
	const away = slope(135, 0.5);
	ok(imhofSwungLight(away, 0.37, 0) === 0.37, "swing 0 is exactly mdow");
	// a N-S ridge: west face (aspect 270) is lit by the NW light; the east face (aspect 90) is not.
	// The swing must lift the east face from black, and keep the west face lit.
	const east = slope(90, 0.5);
	const west = slope(270, 0.5);
	const fixedEast = imhofSwungLight(east, 0, 0);
	const swungEast = imhofSwungLight(east, 0, 1);
	ok(swungEast > fixedEast + 0.05, "swing lights the east face of a N-S ridge");
	ok(imhofSwungLight(west, 0.8, 1) > 0.3, "the west face stays lit");
	// continuity across the facing-away aspect (no seam at 135 degrees)
	const a = imhofSwungLight(slope(134.9, 0.5), 0.1, 1);
	const b = imhofSwungLight(slope(135.1, 0.5), 0.1, 1);
	ok(near(a, b, 0.01), "no seam where the slope faces away from the light");
}
{
	const lit = imhofColour([0.5, 0.5, 0.5], 1.0, 1500, 0);
	const shade = imhofColour([0.5, 0.5, 0.5], 0.1, 1500, 0);
	ok(lit[0] > lit[2], "lit slopes are warm (R > B)");
	ok(shade[2] > shade[0], "shaded slopes are cool (B > R)");
	const low = imhofColour([0.5, 0.5, 0.5], 0.8, 300, 1);
	const high = imhofColour([0.5, 0.5, 0.5], 0.8, 3500, 1);
	ok(
		low[1] / low[0] > high[1] / high[0],
		"lowlands are greener than the high alpine",
	);
	ok(high[0] > low[0], "high alpine is lighter");
	const same = imhofColour([0.5, 0.5, 0.5], 0.8, 300, 0);
	ok(
		near(same[0], imhofColour([0.5, 0.5, 0.5], 0.8, 3500, 0)[0], 1e-12),
		"tint 0 ignores elevation",
	);
	const c: [number, number, number] = [0.5, 0.3, 0.1];
	const sat = (v: readonly number[]) => Math.max(...v) - Math.min(...v);
	const a0 = imhofAerial(c, 40000, 400, 0);
	ok(
		a0[0] === c[0] && a0[1] === c[1] && a0[2] === c[2],
		"aerial 0 is identity",
	);
	ok(imhofAerial(c, 500, 400, 1)[0] === c[0], "no aerial veil nearby");
	ok(
		sat(imhofAerial(c, 40000, 400, 1)) < sat(imhofAerial(c, 10000, 400, 1)) &&
			sat(imhofAerial(c, 10000, 400, 1)) < sat(c),
		"aerial desaturates more with range",
	);
	ok(
		sat(imhofAerial(c, 20000, 400, 1)) < sat(imhofAerial(c, 20000, 3500, 1)),
		"valleys are hazier than summits",
	);
}
{
	const m = (s: string) => s.match(/e[+-]\d+/g)?.length ?? 0;
	const nums = (s: string) =>
		(s.match(/-?\d\.\d{9}e[+-]\d+/g) ?? []).map(Number).join(",");
	ok(
		m(IMHOF_WGSL_MATH) === m(IMHOF_GLSL_MATH) &&
			nums(IMHOF_WGSL_MATH) === nums(IMHOF_GLSL_MATH),
		"WGSL and GLSL texts carry the same constants in the same order",
	);
}

// ---- 2. Dawn: the WGSL against the reference ----------------------------------------------------
type Sample = {
	n: [number, number, number];
	mdow: number;
	L: number;
	elev: number;
	range: number;
	swing: number;
	tint: number;
	aerial: number;
	albedo: [number, number, number];
};

function syntheticSamples(): Sample[] {
	const out: Sample[] = [];
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	// fractal-ish DEM: sum of sines; the gradient gives the normals
	const h = (x: number, y: number) =>
		900 * Math.sin(x / 3100) * Math.cos(y / 2700) +
		260 * Math.sin(x / 700 + y / 900) +
		70 * Math.sin(x / 190) * Math.sin(y / 230) +
		1800;
	for (let i = 0; i < 2048; i++) {
		const x = rnd() * 40000;
		const y = rnd() * 40000;
		const e = 30;
		const gx = (h(x + e, y) - h(x - e, y)) / (2 * e);
		const gy = (h(x, y + e) - h(x, y - e)) / (2 * e);
		const l = Math.hypot(gx, gy, 1);
		out.push({
			n: [-gx / l, -gy / l, 1 / l],
			mdow: rnd() * 1.2,
			L: rnd() * 1.4,
			elev: h(x, y),
			range: 10 ** (2 + rnd() * 3.2),
			swing: rnd(),
			tint: rnd(),
			aerial: rnd(),
			albedo: [rnd() * 0.8, rnd() * 0.8, rnd() * 0.8],
		});
	}
	return out;
}

async function realSamples(): Promise<Sample[] | null> {
	const dir = path.resolve(
		import.meta.dirname,
		"../../../../.cache/terrarium/11",
	);
	if (!fs.existsSync(dir)) return null;
	const col = fs.readdirSync(dir).find((d) => /^\d+$/.test(d));
	if (!col) return null;
	const file = fs
		.readdirSync(path.join(dir, col))
		.find((f) => f.endsWith(".png"));
	if (!file) return null;
	const { createCanvas, loadImage } = await import("@napi-rs/canvas");
	const img = await loadImage(fs.readFileSync(path.join(dir, col, file)));
	const c = createCanvas(img.width, img.height);
	const g = c.getContext("2d");
	g.drawImage(img, 0, 0);
	const px = g.getImageData(0, 0, img.width, img.height).data;
	const W = img.width;
	const H = img.height;
	const elevAt = (i: number, j: number) => {
		const k = (j * W + i) * 4;
		return px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
	};
	const cell = 52; // metres per z11 terrarium pixel at 47 N, close enough for normals
	const out: Sample[] = [];
	let seed = 777;
	const rnd = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	for (let i = 0; i < 2048; i++) {
		const x = 2 + Math.floor(rnd() * (W - 4));
		const y = 2 + Math.floor(rnd() * (H - 4));
		const gx = (elevAt(x + 1, y) - elevAt(x - 1, y)) / (2 * cell);
		const gy = (elevAt(x, y - 1) - elevAt(x, y + 1)) / (2 * cell);
		const l = Math.hypot(gx, gy, 1);
		out.push({
			n: [-gx / l, -gy / l, 1 / l],
			mdow: rnd() * 1.2,
			L: rnd() * 1.4,
			elev: elevAt(x, y),
			range: 10 ** (2 + rnd() * 3.2),
			swing: rnd(),
			tint: rnd(),
			aerial: rnd(),
			albedo: [rnd() * 0.8, rnd() * 0.8, rnd() * 0.8],
		});
	}
	return out;
}

const STRIDE = 20; // floats per sample (std430 friendly: 5 × vec4)
const OUT = 12;
const KERNEL = /* wgsl */ `
fn ts_relief_light_dir(azDeg: f32, altDeg: f32) -> vec3<f32> {
  let az = radians(azDeg);
  let al = radians(altDeg);
  return vec3<f32>(cos(al) * sin(az), cos(al) * cos(az), sin(al));
}
${IMHOF_WGSL_MATH}
@group(0) @binding(0) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> outp: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&inp) / 5u) { return; }
  let a = inp[i * 5u];       // n.xyz, mdow
  let b = inp[i * 5u + 1u];  // L, elev, range, swing
  let c = inp[i * 5u + 2u];  // tint, aerial, -, -
  let d = inp[i * 5u + 3u];  // albedo.rgb, -
  let w = ts_imhof_scale_weights(b.z);
  let sw = ts_imhof_swung_light(a.xyz, a.w, b.w);
  let col = ts_imhof_colour(d.xyz, b.x, b.y, c.x);
  let air = ts_imhof_aerial(d.xyz, b.z, b.y, c.y);
  let o = i * ${OUT}u;
  outp[o] = w.x; outp[o + 1u] = w.y; outp[o + 2u] = w.z; outp[o + 3u] = w.w;
  outp[o + 4u] = sw;
  outp[o + 5u] = col.x; outp[o + 6u] = col.y; outp[o + 7u] = col.z;
  outp[o + 8u] = air.x; outp[o + 9u] = air.y; outp[o + 10u] = air.z;
}
`;

const BUFFER_USAGE = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
const keepGpuObjects: unknown[] = [];
let cachedDevice: GPUDevice | null | undefined;
async function getDevice(dir: string): Promise<GPUDevice | null> {
	if (cachedDevice !== undefined) return cachedDevice;
	const { create, globals } = await import(
		pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	const gpu = create([]);
	const adapter = await gpu.requestAdapter();
	cachedDevice = adapter ? await adapter.requestDevice() : null;
	keepGpuObjects.push(gpu, adapter, cachedDevice);
	return cachedDevice ?? null;
}

async function dawnCompare(label: string, samples: Sample[]) {
	const dir = process.env.DAWN_DIR;
	if (!dir) {
		console.log(`skip ${label}: DAWN_DIR unset (WGSL-vs-reference not run)`);
		return;
	}
	const device = await getDevice(dir);
	if (!device) {
		console.log(`skip ${label}: no WebGPU adapter`);
		return;
	}
	const n = samples.length;
	const data = new Float32Array(n * STRIDE);
	samples.forEach((s, i) => {
		data.set(
			[
				...s.n,
				s.mdow,
				s.L,
				s.elev,
				s.range,
				s.swing,
				s.tint,
				s.aerial,
				0,
				0,
				...s.albedo,
				0,
				0,
				0,
				0,
				0,
			],
			i * STRIDE,
		);
	});
	const inBuf = device.createBuffer({
		size: data.byteLength,
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
	});
	device.queue.writeBuffer(
		inBuf,
		0,
		data.buffer as ArrayBuffer,
		data.byteOffset,
		data.byteLength,
	);
	const outBytes = n * OUT * 4;
	const outBuf = device.createBuffer({
		size: outBytes,
		usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC | BUFFER_USAGE.COPY_DST,
	});
	const readBuf = device.createBuffer({
		size: outBytes,
		usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
	});
	const module = device.createShaderModule({ code: KERNEL });
	const pipeline = device.createComputePipeline({
		layout: "auto",
		compute: { module, entryPoint: "main" },
	});
	const bind = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: inBuf } },
			{ binding: 1, resource: { buffer: outBuf } },
		],
	});
	const enc = device.createCommandEncoder();
	const pass = enc.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bind);
	pass.dispatchWorkgroups(Math.ceil(n / 64));
	pass.end();
	device.queue.submit([enc.finish()]);
	// Dawn's node bindings crash when a live GPU object is garbage collected: keep every one
	keepGpuObjects.push(
		inBuf,
		outBuf,
		readBuf,
		module,
		pipeline,
		bind,
		pass,
		enc,
	);
	const copyEnc = device.createCommandEncoder();
	copyEnc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes);
	device.queue.submit([copyEnc.finish()]);
	await readBuf.mapAsync(1 /* GPUMapMode.READ */);
	const got = new Float32Array(readBuf.getMappedRange().slice(0));
	readBuf.unmap();
	let worst = 0;
	let worstWhat = "";
	const cmp = (what: string, a: number, b: number) => {
		const e = Math.abs(a - b) / (1 + Math.abs(b));
		if (e > worst || Number.isNaN(e)) {
			worst = Number.isNaN(e) ? Number.POSITIVE_INFINITY : e;
			worstWhat = what;
		}
	};
	samples.forEach((s, i) => {
		const o = i * OUT;
		const w = imhofScaleWeights(s.range);
		const sw = imhofSwungLight(s.n, s.mdow, s.swing);
		const col = imhofColour(s.albedo, s.L, s.elev, s.tint);
		const air = imhofAerial(s.albedo, s.range, s.elev, s.aerial);
		for (let k = 0; k < 4; k++) cmp(`weights[${k}]`, got[o + k], w[k]);
		cmp("swung", got[o + 4], sw);
		for (let k = 0; k < 3; k++) {
			cmp(`colour[${k}]`, got[o + 5 + k], col[k]);
			cmp(`aerial[${k}]`, got[o + 8 + k], air[k]);
		}
	});
	ok(
		worst < 2e-4,
		`${label}: Dawn WGSL vs reference over ${n} samples, worst rel err ${worst.toExponential(2)} (${worstWhat})`,
	);
}

// Dawn settles its promises from native callbacks that do not hold the event loop open
const keepAlive = setInterval(() => {}, 50);
// decode the real tile before Dawn starts (two native graphics stacks in one process are flaky)
const real = await realSamples();
if (!real) console.log("skip real tile: .cache/terrarium missing");
await dawnCompare("synthetic DEM + real terrarium tile", [
	...syntheticSamples(),
	...(real ?? []),
]);
// Dawn can keep the process alive or tear it down on its own schedule: exit explicitly below

// ---- 3. the whole relief program on Dawn (compile, swiss unchanged, imhof sane) -----------------
// ts_relief_shade is run with real textures for `reliefWgsl` and the given uniforms. With
// RELIEF_WGSL_BASELINE=<module exporting RELIEF_WGSL> (the pre-Imhof text, e.g. a copy of
// terrain-styles.ts from master) the swiss output of the two programs is compared (float rounding tolerance).
const SHADE_SAMPLES = 1024;
async function runReliefShade(
	device: GPUDevice,
	reliefWgsl: string,
	withImhof: boolean,
	uniforms: number[],
): Promise<Float32Array> {
	const fields = withImhof
		? "imhof: f32, swing: f32, tint: f32, aerial: f32,"
		: "";
	let b = 1;
	const code = `
struct TerrainReliefUniforms {
  sunDir: vec4<f32>, sunColor: vec4<f32>, extent: vec4<f32>,
  realism: f32, generalize: f32, curvature: f32, edge: f32, ${fields}
};
@group(0) @binding(0) var<uniform> terrainRelief: TerrainReliefUniforms;
${reliefWgsl.replace(/@binding\(auto\)/g, () => `@binding(${b++})`)}
@group(0) @binding(5) var<storage, read> inp: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> outp: array<vec4<f32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&outp)) { return; }
  let a = inp[i * 3u];
  let p = inp[i * 3u + 1u];
  let c = inp[i * 3u + 2u];
  outp[i] = vec4<f32>(ts_relief_shade(c.xyz, normalize(a.xyz), p.xyz, a.w), 1.0);
}`;
	const U = BUFFER_USAGE;
	const res = 64;
	let seed = 99;
	const rnd = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	const inp = new Float32Array(SHADE_SAMPLES * 12);
	for (let i = 0; i < SHADE_SAMPLES; i++) {
		const sx = (rnd() - 0.5) * 1.4;
		const sy = (rnd() - 0.5) * 1.4;
		const l = Math.hypot(sx, sy, 1);
		inp.set(
			[
				sx / l,
				sy / l,
				1 / l,
				10 ** (2 + rnd() * 3.2),
				(rnd() - 0.5) * 38000,
				(rnd() - 0.5) * 38000,
				500 + rnd() * 3000,
				0,
				rnd() * 0.6,
				rnd() * 0.6,
				rnd() * 0.6,
				0,
			],
			i * 12,
		);
	}
	const tex = (fill: (x: number, y: number) => number[]) => {
		const t = device.createTexture({
			size: [res, res],
			format: "rgba8unorm",
			usage: 4 | 2, // TEXTURE_BINDING | COPY_DST
		});
		const px = new Uint8Array(res * res * 4);
		for (let y = 0; y < res; y++)
			for (let x = 0; x < res; x++) px.set(fill(x, y), (y * res + x) * 4);
		device.queue.writeTexture(
			{ texture: t },
			px.buffer as ArrayBuffer,
			{ bytesPerRow: res * 4, offset: px.byteOffset },
			[res, res],
		);
		return t;
	};
	const field = tex((x, y) => [
		128 + 100 * Math.sin(x * 0.3),
		160 + 90 * Math.cos(y * 0.2),
		128 + 70 * Math.sin((x + y) * 0.25),
		255,
	]);
	const gen = tex((x, y) => [
		128 + 60 * Math.sin(x * 0.2 + 1),
		128 + 60 * Math.cos(y * 0.17),
		0,
		x < 4 ? 0 : 255,
	]);
	const sampler = device.createSampler({
		magFilter: "linear",
		minFilter: "linear",
	});
	const ubuf = device.createBuffer({
		size: 256,
		usage: 64 | U.COPY_DST, // UNIFORM
	});
	const udata = new Float32Array(64);
	udata.set(uniforms);
	device.queue.writeBuffer(ubuf, 0, udata.buffer as ArrayBuffer, 0, 256);
	const inBuf = device.createBuffer({
		size: inp.byteLength,
		usage: U.STORAGE | U.COPY_DST,
	});
	device.queue.writeBuffer(
		inBuf,
		0,
		inp.buffer as ArrayBuffer,
		0,
		inp.byteLength,
	);
	const outBytes = SHADE_SAMPLES * 16;
	const outBuf = device.createBuffer({
		size: outBytes,
		usage: U.STORAGE | U.COPY_SRC | U.COPY_DST,
	});
	const readBuf = device.createBuffer({
		size: outBytes,
		usage: U.MAP_READ | U.COPY_DST,
	});
	const module = device.createShaderModule({ code });
	const pipeline = device.createComputePipeline({
		layout: "auto",
		compute: { module, entryPoint: "main" },
	});
	const bind = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: ubuf } },
			{ binding: 1, resource: field.createView() },
			{ binding: 2, resource: sampler },
			{ binding: 3, resource: gen.createView() },
			{ binding: 4, resource: sampler },
			{ binding: 5, resource: { buffer: inBuf } },
			{ binding: 6, resource: { buffer: outBuf } },
		],
	});
	const enc = device.createCommandEncoder();
	const pass = enc.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bind);
	pass.dispatchWorkgroups(SHADE_SAMPLES / 64);
	pass.end();
	device.queue.submit([enc.finish()]);
	const copyEnc = device.createCommandEncoder();
	copyEnc.copyBufferToBuffer(outBuf, 0, readBuf, 0, outBytes);
	device.queue.submit([copyEnc.finish()]);
	keepGpuObjects.push(
		field,
		gen,
		sampler,
		ubuf,
		inBuf,
		outBuf,
		readBuf,
		module,
		pipeline,
		bind,
		pass,
		enc,
	);
	await readBuf.mapAsync(1 /* GPUMapMode.READ */);
	const got = new Float32Array(readBuf.getMappedRange().slice(0));
	readBuf.unmap();
	return got;
}

async function reliefProgramChecks() {
	const dir = process.env.DAWN_DIR;
	const device = dir ? await getDevice(dir) : null;
	if (!device) {
		console.log("skip relief program: no DAWN_DIR / adapter");
		return;
	}
	const { RELIEF_WGSL } = await import(
		"../../deck-webgpu/layers/terrain-styles"
	);
	// sunDir, sunColor, extent, realism, generalize, curvature, edge, then imhof, swing, tint, aerial
	const base = [
		0.4, 0.3, 0.8, 0, 1, 0.95, 0.85, 0, -20000, -20000, 20000, 20000, 0.3, 0.7,
		0.6, 0.12,
	];
	const swiss = await runReliefShade(device, RELIEF_WGSL, true, [
		...base,
		0,
		0,
		0,
		0,
	]);
	ok(
		swiss.every((v) => Number.isFinite(v) && v >= 0),
		"relief program compiles; swiss output finite and non-negative",
	);
	const baselinePath = process.env.RELIEF_WGSL_BASELINE;
	if (baselinePath) {
		const old = await import(pathToFileURL(path.resolve(baselinePath)).href);
		const before = await runReliefShade(device, old.RELIEF_WGSL, false, base);
		// the compiler reassociates the surrounding maths when the program text changes, so the
		// swiss output agrees to float rounding (a few ulp), not bit for bit
		let worstRel = 0;
		for (let i = 0; i < swiss.length; i++)
			worstRel = Math.max(
				worstRel,
				Math.abs(swiss[i] - before[i]) / (1e-3 + Math.abs(before[i])),
			);
		ok(
			worstRel < 1e-5,
			`swiss output equals the pre-Imhof program to float rounding (worst rel ${worstRel.toExponential(2)})`,
		);
	} else console.log("skip baseline compare: RELIEF_WGSL_BASELINE unset");
	const imhof = await runReliefShade(device, RELIEF_WGSL, true, [
		...base,
		1,
		0.7,
		0.6,
		0.7,
	]);
	ok(
		imhof.every((v) => Number.isFinite(v) && v >= 0),
		"imhof output finite and non-negative",
	);
	let changed = 0;
	for (let i = 0; i < imhof.length; i++)
		if (Math.abs(imhof[i] - swiss[i]) > 1e-4) changed++;
	ok(changed > imhof.length * 0.5, "imhof differs from swiss");
}
await reliefProgramChecks();

clearInterval(keepAlive);
if (failed) {
	console.error(`${failed} imhof check(s) failed`);
	process.exit(1);
}
console.log("imhof checks passed");
process.exit(0);
