// three.js-on-WebGPU spike (scripts/three-webgpu/spike.mjs mounts it on a bare page). For one photo
// pose it loads the DEM terrain exactly as engine.ts does (terrain.ts Terrain.load, the viewing wedge),
// then:
//  1. renders the classic hillshade with WebGPURenderer + the TSL material (terrain-tsl.ts) to a canvas;
//  2. renders colour + geometry in ONE pass into an MRT target (rgba16float "output" + rgba32float
//     "geo"), reads the geometry back asynchronously;
//  3. runs a core compute kernel (src/lib/gpu/core) on the SAME GPUDevice over a copy of the geometry
//     texture (no CPU round trip) and checks it against the CPU readback;
//  4. renders the same scene with WebGL2 (WebGLRenderer + materials.ts makeTerrainMaterial, the
//     engine's shader, uStyle 0 and 3) and compares colour and geometry pixel by pixel.
// Nothing here is wired into the app.
import { Buffer, type Device } from "@luma.gl/core";
import type { WebGPUBuffer } from "@luma.gl/webgpu";
import * as THREE from "three";
import { HalfFloatType, RenderTarget } from "three/webgpu";
import { hfovFromAspect, type Pose } from "#/lib/camera";
import { EnuFrame } from "#/lib/geodesy";
import { getComputeDevice } from "#/lib/gpu/core/device";
import { defineKernel, dispatch, kernel } from "#/lib/gpu/core/kernel";
import { pooledStorage } from "#/lib/gpu/core/pool";
import { readBack } from "#/lib/gpu/core/readback";
import {
	makeSharedUniforms,
	makeTerrainMaterial,
	STYLE,
} from "#/lib/materials";
import { applyPose } from "#/lib/pose";
import { Terrain } from "#/lib/terrain";
import { createSharedRenderer, type DeviceMode, gpuTextureOf } from "./device";
import {
	geometryMRT,
	makeTerrainNodeMaterial,
	terrainNodes,
} from "./terrain-tsl";

export type SpikeInput = {
	lat: number;
	lon: number;
	/** Eye height (m MSL), e.g. data/ground-truth.json `eye`. */
	eye: number;
	pose: Pose;
	/** Photo aspect (width / height). */
	aspect: number;
	/** Canvas / target long side in px (default 1024). */
	size?: number;
	mode?: DeviceMode;
	/** Also render the WebGL2 reference and compare (default true). */
	webgl?: boolean;
	/** Warm frames timed per renderer (default 20). */
	frames?: number;
};

const now = () => performance.now();
const r2 = (x: number) => Math.round(x * 100) / 100;

// hits (w > 0), max and min range: positive f32 order = u32 bit order, so atomicMax/Min on the bits
const GEO_STATS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> geo: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> acc: array<atomic<u32>, 4>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) g: vec3u) {
	if (g.x >= arrayLength(&geo)) { return; }
	let r = geo[g.x].w;
	if (r > 0.0) {
		atomicAdd(&acc[0], 1u);
		atomicMax(&acc[1], bitcast<u32>(r));
		atomicMin(&acc[2], bitcast<u32>(r));
	}
}`;
const K_GEO_STATS = defineKernel(
	"three-webgpu-geo-stats",
	GEO_STATS,
	[
		["geo", "read-only-storage"],
		["acc", "storage"],
	],
	{ group: "three-webgpu" },
);

/** An HTML canvas even on the SVG host page. */
function htmlCanvas(w: number, h: number) {
	const c = document.createElementNS(
		"http://www.w3.org/1999/xhtml",
		"canvas",
	) as HTMLCanvasElement;
	c.width = w;
	c.height = h;
	return c;
}

/** The canvas's current pixels (RGBA8, top row first); call in the same task as the render. */
function grab(src: HTMLCanvasElement) {
	const c = htmlCanvas(src.width, src.height);
	const ctx = c.getContext("2d") as CanvasRenderingContext2D;
	ctx.drawImage(src, 0, 0);
	return {
		canvas: c,
		data: ctx.getImageData(0, 0, c.width, c.height).data,
	};
}

const quantiles = (xs: Float64Array | number[], ps: number[]) => {
	const s = Float64Array.from(xs).sort();
	return ps.map((p) =>
		s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : 0,
	);
};

async function gpuDone(device: GPUDevice) {
	await device.queue.onSubmittedWorkDone();
}

export async function runSpike(input: SpikeInput) {
	const size = input.size ?? 1024;
	const aspect = input.aspect;
	const W = aspect >= 1 ? size : Math.round(size * aspect);
	const H = aspect >= 1 ? Math.round(size / aspect) : size;
	const frames = input.frames ?? 20;
	const mode = input.mode ?? "luma-first";
	const t: Record<string, number> = {};
	const out: Record<string, unknown> = { mode, W, H };

	// ---- terrain (the engine's load: wedge around the prior yaw, same LOD / radius defaults) ----
	const frame = new EnuFrame(input.lat, input.lon, 0);
	const shared = makeSharedUniforms();
	const nodes = terrainNodes(shared);
	// one NodeMaterial for every tile: the node graph (and so the pipeline) is shared
	const nodeMat = makeTerrainNodeMaterial(nodes);
	let t0 = now();
	const terrain = await Terrain.load(
		frame,
		shared,
		() => nodeMat as unknown as THREE.ShaderMaterial,
		{
			wedge: {
				center: input.pose.yaw,
				halfWidth: hfovFromAspect(input.pose.vfov, aspect) / 2 + 32,
			},
		},
	);
	t.terrainLoadMs = now() - t0;
	out.tiles = terrain.tiles.length;
	out.triangles = terrain.tiles.reduce(
		(a, x) => a + (x.mesh.geometry.index?.count ?? 0) / 3,
		0,
	);
	// engine.ts init: the ramp's elevation range = local relief within 25 km, at least 500 m
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	for (const tile of terrain.tiles) {
		if (tile.distance > 25000) continue;
		for (let i = 0; i < tile.heights.length; i += 7) {
			lo = Math.min(lo, tile.heights[i]);
			hi = Math.max(hi, tile.heights[i]);
		}
	}
	(shared.uElevRange.value as THREE.Vector2).set(lo, Math.max(hi, lo + 500));
	shared.uStyle.value = STYLE.hillshade;

	const scene = new THREE.Scene();
	scene.add(terrain.group);
	const cam = new THREE.PerspectiveCamera(50, 1, 1, 400000);
	applyPose(cam, input.pose, aspect, new THREE.Vector3(0, 0, input.eye));

	// ---- WebGPU ----
	const gpuCanvas = htmlCanvas(W, H);
	t0 = now();
	const sr = await createSharedRenderer(gpuCanvas, mode);
	t.webgpuInitMs = now() - t0;
	const { renderer, gpuDevice, luma } = sr;
	out.compatibility = sr.compatibility;
	out.deviceFeatures = [...gpuDevice.features].sort();
	out.maxStorageBufferBindingSize =
		gpuDevice.limits.maxStorageBufferBindingSize;
	renderer.setPixelRatio(1);
	renderer.setSize(W, H, false);
	renderer.setClearColor(0x000000, 1);
	out.samples = (renderer as unknown as { samples: number }).samples;

	t0 = now();
	await renderer.compileAsync(scene, cam);
	t.webgpuCompileMs = now() - t0;
	t0 = now();
	renderer.render(scene, cam);
	await gpuDone(gpuDevice);
	t.webgpuFirstFrameMs = now() - t0;
	t0 = now();
	for (let i = 0; i < frames; i++) {
		renderer.render(scene, cam);
		await gpuDone(gpuDevice);
	}
	t.webgpuFrameMs = (now() - t0) / frames;
	renderer.render(scene, cam);
	const gpuImg = grab(gpuCanvas);

	// ---- MRT: colour + geometry in one pass, async readback ----
	const rt = new RenderTarget(W, H, {
		count: 2,
		type: HalfFloatType,
		depthBuffer: true,
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
	});
	rt.textures[0].name = "output";
	rt.textures[1].name = "geo";
	rt.textures[1].type = THREE.FloatType;
	renderer.setRenderTarget(rt);
	renderer.setMRT(geometryMRT(nodes));
	renderer.setClearColor(0x000000, 0);
	t0 = now();
	renderer.render(scene, cam);
	await gpuDone(gpuDevice);
	t.mrtFirstMs = now() - t0;
	t0 = now();
	for (let i = 0; i < frames; i++) {
		renderer.render(scene, cam);
		await gpuDone(gpuDevice);
	}
	t.mrtFrameMs = (now() - t0) / frames;
	t0 = now();
	const geoGpu = (await renderer.readRenderTargetPixelsAsync(
		rt,
		0,
		0,
		W,
		H,
		1,
	)) as Float32Array;
	t.geoReadbackMs = now() - t0;
	renderer.setRenderTarget(null);
	renderer.setMRT(null);
	out.geoReadbackLength = geoGpu.length;

	// ---- compute on the shared device: stats over the geometry texture, no CPU round trip ----
	const compute = await (async () => {
		const dev: Device | null = await getComputeDevice();
		const same = !!luma && dev === luma;
		const res: Record<string, unknown> = {
			computeDeviceIsRenderDevice: same,
		};
		if (!dev || !luma || !same) return res;
		const tex = gpuTextureOf(renderer, rt.textures[1]);
		if (!tex) return { ...res, error: "no GPUTexture for the geo attachment" };
		const bytes = W * H * 16;
		const t1 = now();
		const buf = luma.createBuffer({
			byteLength: bytes,
			usage: Buffer.STORAGE | Buffer.COPY_DST,
		});
		const enc = gpuDevice.createCommandEncoder();
		enc.copyTextureToBuffer(
			{ texture: tex },
			{ buffer: (buf as WebGPUBuffer).handle, bytesPerRow: W * 16 },
			[W, H, 1],
		);
		gpuDevice.queue.submit([enc.finish()]);
		const acc = pooledStorage(
			luma,
			"three-webgpu/acc",
			new Uint32Array([0, 0, 0xffffffff, 0]),
		);
		const k = kernel(luma, K_GEO_STATS);
		const [r] = await readBack(
			luma,
			(e) => dispatch(e, k, { geo: buf, acc }, Math.ceil((W * H) / 256)),
			[{ buffer: acc, size: 16 }],
		);
		res.ms = now() - t1;
		buf.destroy();
		const u = new Uint32Array(r);
		const f = new Float32Array(r);
		// the CPU twin over the async readback
		let n = 0;
		let mx = 0;
		let mn = Number.POSITIVE_INFINITY;
		const f32 = new Float32Array(1);
		for (let i = 3; i < W * H * 4; i += 4) {
			const v = geoGpu[i];
			if (v > 0) {
				n++;
				f32[0] = v;
				if (f32[0] > mx) mx = f32[0];
				if (f32[0] < mn) mn = f32[0];
			}
		}
		Object.assign(res, {
			gpu: { hits: u[0], maxRange: f[1], minRange: f[2] },
			cpu: { hits: n, maxRange: mx, minRange: mn },
			exact: u[0] === n && f[1] === mx && f[2] === mn,
		});
		return res;
	})();
	out.compute = compute;

	// ---- WebGL2 reference: the engine's ShaderMaterial on the same meshes ----
	if (input.webgl !== false) {
		const glCanvas = htmlCanvas(W, H);
		t0 = now();
		const gl = new THREE.WebGLRenderer({
			canvas: glCanvas,
			antialias: true,
			logarithmicDepthBuffer: true,
			alpha: false,
			preserveDrawingBuffer: true,
		});
		gl.setPixelRatio(1);
		gl.setSize(W, H, false);
		gl.outputColorSpace = THREE.SRGBColorSpace;
		gl.setClearColor(0x000000, 1);
		t.webglInitMs = now() - t0;
		scene.overrideMaterial = makeTerrainMaterial({
			...shared,
			map: { value: null },
			hasMap: { value: 0 },
		});
		const ctx = gl.getContext();
		const px = new Uint8Array(4);
		const finish = () =>
			ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
		t0 = now();
		gl.render(scene, cam);
		finish();
		t.webglFirstFrameMs = now() - t0;
		t0 = now();
		for (let i = 0; i < frames; i++) {
			gl.render(scene, cam);
			finish();
		}
		t.webglFrameMs = (now() - t0) / frames;
		const glImg = grab(glCanvas);

		// geometry (uStyle 3) into a float target, sync readback (row 0 = bottom)
		const grt = new THREE.WebGLRenderTarget(W, H, {
			type: THREE.FloatType,
			minFilter: THREE.NearestFilter,
			magFilter: THREE.NearestFilter,
			depthBuffer: true,
		});
		shared.uStyle.value = STYLE.geometry;
		gl.setRenderTarget(grt);
		gl.setClearColor(0x000000, 0);
		gl.clear();
		gl.render(scene, cam);
		const geoGl = new Float32Array(W * H * 4);
		t0 = now();
		gl.readRenderTargetPixels(grt, 0, 0, W, H, geoGl);
		t.webglGeoReadbackMs = now() - t0;
		gl.setRenderTarget(null);
		shared.uStyle.value = STYLE.hillshade;
		scene.overrideMaterial = null;

		out.colorDiff = compareColor(gpuImg.data, glImg.data, geoGpu, W, H);
		out.geoDiff = compareGeo(geoGpu, geoGl, W, H);
		out.images = {
			webgl: glImg.canvas.toDataURL("image/jpeg", 0.9),
			diff: diffImage(gpuImg.data, glImg.data, W, H),
		};
		grt.dispose();
		gl.dispose();
	}
	out.images = {
		...(out.images as object),
		webgpu: gpuImg.canvas.toDataURL("image/jpeg", 0.9),
	};
	out.timings = Object.fromEntries(
		Object.entries(t).map(([k, v]) => [k, r2(v)]),
	);

	rt.dispose();
	renderer.dispose();
	terrain.dispose();
	nodeMat.dispose();
	if (mode === "luma-first") luma?.destroy();
	return out;
}

/** 8-bit RGB differences, split by the WebGPU geometry mask (terrain / sky) and silhouette distance. */
function compareColor(
	a: Uint8ClampedArray,
	b: Uint8ClampedArray,
	geo: Float32Array,
	W: number,
	H: number,
) {
	const d = new Float64Array(W * H);
	const interior: number[] = [];
	let over2 = 0;
	let over8 = 0;
	let over32 = 0;
	let exact = 0;
	for (let i = 0; i < W * H; i++) {
		const m = Math.max(
			Math.abs(a[i * 4] - b[i * 4]),
			Math.abs(a[i * 4 + 1] - b[i * 4 + 1]),
			Math.abs(a[i * 4 + 2] - b[i * 4 + 2]),
		);
		d[i] = m;
		if (m === 0) exact++;
		if (m > 2) over2++;
		if (m > 8) over8++;
		if (m > 32) over32++;
		// interior: this pixel and its 4-neighbours are terrain with range within 2% (no silhouette / AA)
		const x = i % W;
		const y = (i / W) | 0;
		if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
		const r = geo[i * 4 + 3];
		if (!(r > 0)) continue;
		let flat = true;
		for (const j of [i - 1, i + 1, i - W, i + W]) {
			const rj = geo[j * 4 + 3];
			if (!(rj > 0) || Math.abs(rj - r) > 0.02 * r) flat = false;
		}
		if (flat) interior.push(m);
	}
	const n = W * H;
	const [p50, p95, p99, pmax] = quantiles(d, [0.5, 0.95, 0.99, 1]);
	const [i50, i99, imax] = quantiles(interior, [0.5, 0.99, 1]);
	let sum = 0;
	for (const v of d) sum += v;
	return {
		metric: "max |ΔR,ΔG,ΔB| per pixel, 8-bit sRGB",
		mean: r2(sum / n),
		p50,
		p95,
		p99,
		max: pmax,
		exactFrac: r2((100 * exact) / n) / 100,
		over2Frac: r2((100 * over2) / n) / 100,
		over8Frac: r2((100 * over8) / n) / 100,
		over32Frac: r2((100 * over32) / n) / 100,
		interior: { n: interior.length, p50: i50, p99: i99, max: imax },
	};
}

/** Geometry targets: hit masks and range / xyz differences (WebGL rows flipped to top-first). */
function compareGeo(g: Float32Array, w: Float32Array, W: number, H: number) {
	let both = 0;
	let onlyGpu = 0;
	let onlyGl = 0;
	const rel: number[] = [];
	const dxyz: number[] = [];
	let relOver1pct = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			const j = ((H - 1 - y) * W + x) * 4;
			const hg = g[i + 3] > 0;
			const hw = w[j + 3] > 0;
			if (hg && hw) {
				both++;
				const e = Math.abs(g[i + 3] - w[j + 3]) / w[j + 3];
				rel.push(e);
				if (e > 0.01) relOver1pct++;
				dxyz.push(
					Math.hypot(g[i] - w[j], g[i + 1] - w[j + 1], g[i + 2] - w[j + 2]),
				);
			} else if (hg) onlyGpu++;
			else if (hw) onlyGl++;
		}
	const [r50, r99, rmax] = quantiles(rel, [0.5, 0.99, 1]);
	const [x50, x99] = quantiles(dxyz, [0.5, 0.99]);
	let exact = 0;
	for (const e of rel) if (e === 0) exact++;
	return {
		hitsBoth: both,
		onlyWebgpu: onlyGpu,
		onlyWebgl: onlyGl,
		maskAgreement: r2((100 * both) / (both + onlyGpu + onlyGl)) / 100,
		rangeRel: { p50: r50, p99: r99, max: rmax, exactFrac: exact / both },
		rangeRelOver1pctFrac: relOver1pct / both,
		xyzM: { p50: x50, p99: x99 },
	};
}

/** |Δ| × 4 as a grey PNG (sky and exact pixels black). */
function diffImage(
	a: Uint8ClampedArray,
	b: Uint8ClampedArray,
	W: number,
	H: number,
) {
	const c = htmlCanvas(W, H);
	const ctx = c.getContext("2d") as CanvasRenderingContext2D;
	const img = ctx.createImageData(W, H);
	for (let i = 0; i < W * H; i++) {
		const m = Math.max(
			Math.abs(a[i * 4] - b[i * 4]),
			Math.abs(a[i * 4 + 1] - b[i * 4 + 1]),
			Math.abs(a[i * 4 + 2] - b[i * 4 + 2]),
		);
		const v = Math.min(255, m * 4);
		img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
		img.data[i * 4 + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	return c.toDataURL("image/png");
}
