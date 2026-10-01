// Checks for layers/splats.ts.
//
// CPU (node, no GPU):  npx tsx src/lib/deck-webgpu/layers/splats.check.ts
//   - both programs (colour, GEOMETRY_PASS) assemble with luma's WGSL assembler and expose the
//     expected bindings (camera + splat uniforms, two read-only storage buffers)
//   - packSplats equals the WebGL layer's packing (deck-splat-layer.ts math) bit for bit
//   - splatDepthRow + the sorter give back-to-front order for our camera convention
//
// GPU (browser, WebGPU): `runSplatsGpuCheck()` renders a synthetic cloud through the real colour
// pass (hosts/passes.ts runColorPass: 4× MSAA, reversed-Z, premultiplied over) and compares the
// resolved colour with a CPU twin of the EWA shader, with and without an opaque occluder plane
// (depth test), with Truth on, and checks the class-2 geometry contribution. Load it from any page
// on the dev server:  await (await import('/src/lib/deck-webgpu/layers/splats.check.ts')).runSplatsGpuCheck()
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { ShaderAssembler } from "@luma.gl/shadertools";
import { sortSplatsByDepth } from "#/lib/nearfield/splat-sort";
import type { GaussianCloud } from "#/lib/nearfield/types";
import {
	type CameraState,
	type CameraUniforms,
	cameraModule,
	cameraUniforms,
	projectToPixel,
} from "../camera";
import type { FrameState, GpuLayerCore, PassContext } from "../pass";
import { passModelProps } from "../pass";
import {
	createSplatsCore,
	packSplats,
	SPLAT_TINTS,
	SPLAT_WORDS,
	type SplatsOptions,
	splatDepthRow,
	splatModule,
	splatsWGSL,
} from "./splats";

type V3 = [number, number, number];

// ---------------------------------------------------------------- synthetic cloud

function rotQuat(axis: V3, deg: number): [number, number, number, number] {
	const l = Math.hypot(...axis) || 1;
	const h = (deg * Math.PI) / 360;
	const s = Math.sin(h) / l;
	return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** A handful of splats in front of an eye at the origin looking north (+y). */
export function syntheticCloud(): GaussianCloud {
	const S: {
		p: V3;
		s: V3;
		q: [number, number, number, number];
		c: [number, number, number, number];
		prov: number;
	}[] = [
		{
			p: [0, 30, 0],
			s: [3, 0.2, 2],
			q: [1, 0, 0, 0],
			c: [200, 40, 40, 230],
			prov: 0,
		},
		{
			p: [-2, 15, 1],
			s: [1.2, 0.5, 0.4],
			q: rotQuat([0, 1, 0], 35),
			c: [40, 200, 60, 200],
			prov: 1,
		},
		{
			p: [2.5, 12, -1],
			s: [0.6, 0.6, 1.5],
			q: rotQuat([1, 1, 0], 50),
			c: [60, 80, 230, 255],
			prov: 2,
		},
		{
			p: [0.5, 25, 1.5],
			s: [2, 1, 0.3],
			q: rotQuat([0, 0, 1], 60),
			c: [240, 220, 60, 160],
			prov: 3,
		},
		{
			p: [-4, 40, -2],
			s: [2.5, 0.5, 2.5],
			q: rotQuat([1, 0, 0], 20),
			c: [230, 120, 20, 255],
			prov: 0,
		},
		{
			p: [1, 8, 0.2],
			s: [0.3, 0.3, 0.3],
			q: [1, 0, 0, 0],
			c: [250, 250, 250, 255],
			prov: 1,
		},
		// behind the camera: sorted out
		{
			p: [0, -5, 0],
			s: [1, 1, 1],
			q: [1, 0, 0, 0],
			c: [255, 0, 255, 255],
			prov: 0,
		},
	];
	const n = S.length;
	const cloud: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: new Float32Array(3 * n),
		scales: new Float32Array(3 * n),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n),
		provenance: new Uint8Array(n),
	};
	S.forEach((s, i) => {
		cloud.positions.set(s.p, 3 * i);
		cloud.scales.set(s.s, 3 * i);
		cloud.rotations.set(s.q, 4 * i);
		cloud.colors.set(s.c, 4 * i);
		cloud.provenance[i] = s.prov;
	});
	return cloud;
}

// ---------------------------------------------------------------- CPU twin of the shaders

const srgbDecode = (c: number) =>
	c <= 0.04045 ? c * 0.0773993808 : (c * 0.9478672986 + 0.0521327014) ** 2.4;

/** Covariance words of splat i from packSplats (f32 view). */
function covOf(f: Float32Array, i: number) {
	const o = i * SPLAT_WORDS;
	return {
		p: [f[o], f[o + 1], f[o + 2]] as V3,
		code: f[o + 3],
		S: [
			[f[o + 4], f[o + 5], f[o + 6]],
			[f[o + 5], f[o + 7], f[o + 8]],
			[f[o + 6], f[o + 8], f[o + 9]],
		],
	};
}

/**
 * Straight EWA evaluation per pixel centre, back to front, premultiplied over `bg`: what the
 * vertex + fragment stages compute (same low-pass, sigma crop, radius cap, alpha cuts).
 */
export function cpuSplatImage(
	cloud: GaussianCloud,
	cam: CameraUniforms,
	o: SplatsOptions,
	bg: (x: number, y: number) => [number, number, number, number],
	occluderDepth = Number.POSITIVE_INFINITY,
): Float32Array {
	const W = cam.viewport[0];
	const H = cam.viewport[1];
	const words = packSplats(cloud);
	const f = new Float32Array(words.buffer);
	const img = new Float32Array(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) img.set(bg(x, y), (y * W + x) * 4);
	const order = new Uint32Array(cloud.count);
	const n = sortSplatsByDepth(
		cloud.positions,
		cloud.count,
		splatDepthRow(cam),
		order,
	);
	const m = cam.viewProj;
	const hx = W / 2;
	const hy = H / 2;
	for (let k = 0; k < n; k++) {
		const i = order[k];
		const { p, code, S } = covOf(f, i);
		const d: V3 = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
		const cx = m[0] * d[0] + m[4] * d[1] + m[8] * d[2];
		const cy = m[1] * d[0] + m[5] * d[1] + m[9] * d[2];
		const w = m[3] * d[0] + m[7] * d[1] + m[11] * d[2];
		if (w < 0.05) continue;
		if (w > occluderDepth) continue; // behind the occluder plane: depth test fails
		const ndc = [cx / w, cy / w];
		const J = [0, 1, 2].map((col) => {
			const dxc = m[col * 4];
			const dyc = m[col * 4 + 1];
			const dwc = m[col * 4 + 3];
			return [(hx * (dxc - ndc[0] * dwc)) / w, (hy * (dyc - ndc[1] * dwc)) / w];
		});
		const Jx = [J[0][0], J[1][0], J[2][0]];
		const Jy = [J[0][1], J[1][1], J[2][1]];
		const mul = (v: number[]) =>
			S.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
		const dot = (a: number[], b: number[]) =>
			a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
		const a = dot(Jx, mul(Jx)) + 0.3;
		const b = dot(Jx, mul(Jy));
		const dd = dot(Jy, mul(Jy)) + 0.3;
		const mid = 0.5 * (a + dd);
		const rad = Math.sqrt(Math.max(0.25 * (a - dd) ** 2 + b * b, 0));
		const l1 = mid + rad;
		const l2 = Math.max(mid - rad, 0.05);
		let v1: [number, number];
		if (Math.abs(b) > 1e-9) {
			const L = Math.hypot(b, l1 - a);
			v1 = [b / L, (l1 - a) / L];
		} else v1 = a >= dd ? [1, 0] : [0, 1];
		const v2 = [-v1[1], v1[0]];
		const r1 = Math.min(o.sigmas * Math.sqrt(l1), o.maxRadiusPx);
		const r2 = Math.min(o.sigmas * Math.sqrt(l2), o.maxRadiusPx);
		if (
			Math.abs(ndc[0] * hx) - r1 > hx * 1.05 ||
			Math.abs(ndc[1] * hy) - r1 > hy * 1.05
		)
			continue;
		const rgba = words[i * SPLAT_WORDS + 10];
		let col = [
			rgba & 255,
			(rgba >>> 8) & 255,
			(rgba >>> 16) & 255,
			rgba >>> 24,
		].map((v) => v / 255);
		if (o.truth) {
			const t =
				SPLAT_TINTS[code < 0.5 ? 0 : code < 1.5 ? 1 : code < 2.5 ? 2 : 3];
			col = [0, 1, 2]
				.map((c) => col[c] * (1 - t[3]) + t[c] * t[3])
				.concat(col[3]);
		}
		col[3] *= o.opacity;
		if (col[3] < 1 / 255) continue;
		const lin = [srgbDecode(col[0]), srgbDecode(col[1]), srgbDecode(col[2])];
		// centre in pixels (x right, y DOWN)
		const pcx = (ndc[0] + 1) * hx;
		const pcy = (1 - ndc[1]) * hy;
		const R = Math.ceil(r1) + 1;
		for (
			let y = Math.max(0, Math.floor(pcy - R));
			y < Math.min(H, pcy + R);
			y++
		)
			for (
				let x = Math.max(0, Math.floor(pcx - R));
				x < Math.min(W, pcx + R);
				x++
			) {
				// offset in clip-up pixels
				const ox = x + 0.5 - pcx;
				const oy = -(y + 0.5 - pcy);
				const e1 = ox * v1[0] + oy * v1[1];
				const e2 = ox * v2[0] + oy * v2[1];
				// inside the (possibly radius-capped) quad
				if (Math.abs(e1) > r1 || Math.abs(e2) > r2) continue;
				const q2 = (e1 * e1) / l1 + (e2 * e2) / l2;
				if (q2 > o.sigmas * o.sigmas) continue;
				const al = col[3] * Math.exp(-0.5 * q2);
				if (al < 1 / 255) continue;
				const j = (y * W + x) * 4;
				for (let c = 0; c < 3; c++)
					img[j + c] = lin[c] * al + img[j + c] * (1 - al);
				img[j + 3] = al + img[j + 3] * (1 - al);
			}
	}
	return img;
}

// ---------------------------------------------------------------- CPU checks (node)

type Layout = { bindings: { name: string; type: string }[] };

async function assembleLayout(geometry: boolean): Promise<Layout> {
	const { getShaderLayoutFromWGSL } = await import("@luma.gl/webgpu");
	const asm = ShaderAssembler.getDefaultShaderAssembler(
		"wgsl" as never,
	) as unknown as {
		assembleWGSLShader(p: unknown): { source: string };
	};
	const r = asm.assembleWGSLShader({
		platformInfo: {
			type: "webgpu",
			shaderLanguage: "wgsl",
			shaderLanguageVersion: 100,
			gpu: "apple",
			features: new Set(),
		},
		source: splatsWGSL,
		modules: [cameraModule, splatModule],
		defines: geometry ? { GEOMETRY_PASS: true } : {},
	});
	return getShaderLayoutFromWGSL(r.source) as unknown as Layout;
}

/** packSplatTexture's math (deck-splat-layer.ts), written out independently. */
function webglCov(q: number[], s: number[]) {
	const [w, x, y, z] = q.map((v) => v / (Math.hypot(...q) || 1));
	const R = [
		[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
		[2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
		[2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
	];
	const M = R.map((r) => r.map((v, j) => v * s[j]));
	const S = (i: number, j: number) =>
		M[i][0] * M[j][0] + M[i][1] * M[j][1] + M[i][2] * M[j][2];
	return [S(0, 0), S(0, 1), S(0, 2), S(1, 1), S(1, 2), S(2, 2)];
}

export async function cpuChecks() {
	const errors: string[] = [];
	for (const geometry of [false, true]) {
		const L = await assembleLayout(geometry);
		const by = new Map(L.bindings.map((b) => [b.name, b.type]));
		for (const [name, type] of [
			["camera", "uniform"],
			["splat", "uniform"],
			["splatData", "read-only-storage"],
			["splatOrder", "read-only-storage"],
		])
			if (by.get(name) !== type)
				errors.push(
					`${geometry ? "geometry" : "color"}: binding ${name} is ${by.get(name)}, want ${type}`,
				);
	}
	const cloud = syntheticCloud();
	const u = packSplats(cloud);
	const f = new Float32Array(u.buffer);
	let maxCovErr = 0;
	for (let i = 0; i < cloud.count; i++) {
		const ref = webglCov(
			Array.from(cloud.rotations.subarray(4 * i, 4 * i + 4)),
			Array.from(cloud.scales.subarray(3 * i, 3 * i + 3)),
		);
		for (let k = 0; k < 6; k++)
			maxCovErr = Math.max(
				maxCovErr,
				Math.abs(Math.fround(ref[k]) - f[i * SPLAT_WORDS + 4 + k]) /
					(1e-6 + Math.abs(ref[k])),
			);
		const c = cloud.colors.subarray(4 * i, 4 * i + 4);
		const w = u[i * SPLAT_WORDS + 10];
		if (
			(w & 255) !== c[0] ||
			((w >>> 8) & 255) !== c[1] ||
			((w >>> 16) & 255) !== c[2] ||
			w >>> 24 !== c[3]
		)
			errors.push(`colour pack mismatch at ${i}`);
	}
	if (maxCovErr > 1e-5) errors.push(`covariance pack rel err ${maxCovErr}`);
	// sort: back to front for a camera looking north from the origin, behind-camera splat dropped
	const cam = cameraUniforms(checkCamera(64, 48));
	const order = new Uint32Array(cloud.count);
	const n = sortSplatsByDepth(
		cloud.positions,
		cloud.count,
		splatDepthRow(cam),
		order,
	);
	const depths = Array.from(order.subarray(0, n)).map(
		(i) => cloud.positions[3 * i + 1],
	);
	if (n !== cloud.count - 1)
		errors.push(`sort kept ${n}, want ${cloud.count - 1}`);
	for (let k = 1; k < n; k++)
		if (depths[k] > depths[k - 1])
			errors.push(`sort not back-to-front at ${k}: ${depths}`);
	return { ok: errors.length === 0, errors, maxCovErr, sorted: n };
}

// ---------------------------------------------------------------- GPU check (browser)

function checkCamera(width: number, height: number): CameraState {
	return {
		eye: [0, 0, 0],
		forward: [0, 1, 0],
		up: [0, 0, 1],
		vfov: 50,
		width,
		height,
		near: 0.3,
	};
}

/** An opaque plane perpendicular to the view at `viewDepth`, drawn first (depth write). */
class OccluderCore implements GpuLayerCore {
	readonly id = "occluder";
	readonly passes = ["color"] as const;
	readonly order = 0;
	private model?: Model;
	constructor(
		readonly viewDepth: number,
		readonly grey: number,
	) {}
	draw(ctx: PassContext) {
		this.model ??= new Model(ctx.device, {
			id: "occluder",
			source: /* wgsl */ `\
struct OccOut { @builtin(position) position: vec4<f32> };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> OccOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: OccOut;
  let w = ${this.viewDepth.toFixed(4)};
  o.position = vec4<f32>(p * w, camera.near, w);
  return o;
}
@fragment fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(vec3<f32>(${this.grey.toFixed(4)}), 1.0);
}
`,
			modules: [cameraModule] as never,
			...passModelProps("color"),
			topology: "triangle-list",
			vertexCount: 3,
		} as never);
		this.model.shaderInputs.setProps({ camera: ctx.camera } as never);
		this.model.draw(ctx.renderPass);
	}
	destroy() {
		this.model?.destroy();
	}
}

const f16 = (h: number) => {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 31;
	const m = h & 1023;
	if (e === 0) return s * 2 ** -14 * (m / 1024);
	if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + m / 1024);
};

/** Read an rgba16float / rgba32float texture (mip 0), top-first rows, as floats. */
async function readTexture(
	device: Device,
	tex: Texture,
): Promise<Float32Array> {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008,
	});
	tex.readBuffer({}, buf);
	const data = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const half = tex.format === "rgba16float";
	const out = new Float32Array(tex.width * tex.height * 4);
	for (let y = 0; y < tex.height; y++) {
		const row = y * layout.bytesPerRow;
		for (let k = 0; k < tex.width * 4; k++) {
			const o = row + k * (half ? 2 : 4);
			out[y * tex.width * 4 + k] = half
				? f16(data[o] | (data[o + 1] << 8))
				: new DataView(data.buffer, data.byteOffset + o, 4).getFloat32(0, true);
		}
	}
	return out;
}

function compare(gpu: Float32Array, cpu: Float32Array, W: number, H: number) {
	let maxErr = 0;
	let sumErr = 0;
	let over2 = 0;
	let covered = 0;
	for (let i = 0; i < W * H; i++) {
		let e = 0;
		for (let c = 0; c < 4; c++)
			e = Math.max(e, Math.abs(gpu[i * 4 + c] - cpu[i * 4 + c]));
		maxErr = Math.max(maxErr, e);
		sumErr += e;
		if (e > 2 / 255) over2++;
		if (cpu[i * 4 + 3] > 0.01) covered++;
	}
	return {
		maxErr,
		meanErr: sumErr / (W * H),
		fracOver2of255: over2 / (W * H),
		covered,
	};
}

export async function runSplatsGpuCheck(
	o: { width?: number; height?: number } = {},
) {
	const { createRenderDevice } = await import("../device");
	const { runColorPass, runGeometryPass } = await import("../hosts/passes");
	const { ColorTargets, GeometryTargets } = await import("../targets");
	const W = o.width ?? 320;
	const H = o.height ?? 240;
	const canvas = document.createElement("canvas");
	canvas.width = W;
	canvas.height = H;
	const device = await createRenderDevice(canvas, { useDevicePixels: 1 });
	const errors: string[] = [];
	const gpuErrors: string[] = [];
	(device as unknown as { onError?: (e: Error) => void }).onError = (e) =>
		gpuErrors.push(String(e.message ?? e));
	const color = new ColorTargets(device, W, H);
	const geometry = new GeometryTargets(device, W, H);
	const pose = checkCamera(W, H);
	const cam = cameraUniforms(pose);
	const cloud = syntheticCloud();
	const frame: FrameState = { frame: 0, time: 0, view: "photo" };
	const splats = createSplatsCore(device, {
		sortWorker: false,
		sortBackend: "worker",
	});
	splats.setCloud(cloud);
	const results: Record<string, unknown> = {};

	const run = async (
		name: string,
		opts: Partial<SplatsOptions>,
		occ: OccluderCore | null,
		tol: { mean: number; frac: number },
	) => {
		splats.setOptions(opts);
		const cores: GpuLayerCore[] = occ ? [occ, splats] : [splats];
		runColorPass({ device, cores, geometry, color, view: pose, frame });
		device.submit();
		const gpu = await readTexture(device, color.color);
		const g = occ?.grey ?? 0;
		const bgLin = g; // occluder writes linear grey, alpha 1
		const cpu = cpuSplatImage(
			cloud,
			cam,
			splats.options,
			() => (occ ? [bgLin, bgLin, bgLin, 1] : [0, 0, 0, 0]),
			occ?.viewDepth,
		);
		const c = compare(gpu, cpu, W, H);
		results[name] = {
			...c,
			drawn: splats.stats.drawn,
			sorts: splats.stats.sorts,
		};
		if (c.covered < 500)
			errors.push(`${name}: too little coverage (${c.covered})`);
		if (c.meanErr > tol.mean || c.fracOver2of255 > tol.frac)
			errors.push(
				`${name}: mean ${c.meanErr.toFixed(5)} frac>2/255 ${c.fracOver2of255.toFixed(4)}`,
			);
		return { gpu, cpu };
	};

	// MSAA resolves quad-edge (3σ crop) and triangle-seam samples; per-pixel shading is identical
	const tol = { mean: 0.002, frac: 0.01 };
	await run("plain", {}, null, tol);
	await run("truth", { truth: true, opacity: 0.7 }, null, tol);
	await run(
		"occluded",
		{ truth: false, opacity: 1 },
		new OccluderCore(20, 0.2),
		tol,
	);
	// depth test off: everything over the occluder
	splats.setOptions({ noDepthTest: true });
	const occ = new OccluderCore(20, 0.2);
	runColorPass({
		device,
		cores: [occ, splats],
		geometry,
		color,
		view: pose,
		frame,
	});
	device.submit();
	const noDepth = await readTexture(device, color.color);
	const withDepthAll = cpuSplatImage(cloud, cam, splats.options, () => [
		0.2, 0.2, 0.2, 1,
	]);
	const nd = compare(noDepth, withDepthAll, W, H);
	results.noDepthTest = nd;
	if (nd.meanErr > tol.mean) errors.push(`noDepthTest: mean ${nd.meanErr}`);
	splats.setOptions({ noDepthTest: false });

	// geometry contribution: class 2 at the centres of opaque splats, generated (code 3) absent
	splats.setOptions({ geometry: true });
	runGeometryPass({ device, cores: [splats], geometry, photo: pose, frame });
	device.submit();
	const xyzr = await readTexture(device, geometry.geometry);
	const normal = await readTexture(device, geometry.normal);
	const gcam = cameraUniforms({
		...pose,
		width: geometry.width,
		height: geometry.height,
	});
	const centres: unknown[] = [];
	for (let i = 0; i < cloud.count; i++) {
		const p = Array.from(cloud.positions.subarray(3 * i, 3 * i + 3)) as V3;
		const px = projectToPixel(gcam, p);
		if (
			!px ||
			px.x < 0 ||
			px.y < 0 ||
			px.x >= geometry.width ||
			px.y >= geometry.height
		)
			continue;
		const k = (Math.floor(px.y) * geometry.width + Math.floor(px.x)) * 4;
		const cls = normal[k + 3];
		const range = xyzr[k + 3];
		const gen = cloud.provenance[i] === 3;
		centres.push({
			i,
			cls,
			range: +range.toFixed(3),
			want: +px.range.toFixed(3),
			gen,
		});
		// the nearest splat over this pixel wins; only check splats nothing nearer covers
		if (gen) continue;
		if (cls !== 2) errors.push(`geometry: splat ${i} class ${cls}`);
		else if (range > px.range + 1e-3)
			errors.push(`geometry: splat ${i} range ${range} > own ${px.range}`);
	}
	results.geometry = centres;
	splats.setOptions({ geometry: false });

	splats.destroy();
	occ.destroy();
	color.destroy();
	geometry.destroy();
	await new Promise((r) => setTimeout(r, 50));
	device.destroy();
	const ok = errors.length === 0 && gpuErrors.length === 0;
	return { ok, errors, gpuErrors, results };
}

// run the CPU checks when executed directly with tsx
const isMain =
	typeof window === "undefined" &&
	typeof process !== "undefined" &&
	/splats\.check\.ts$/.test(process.argv[1] ?? "");
if (isMain)
	cpuChecks().then((r) => {
		console.log(JSON.stringify(r));
		if (!r.ok) process.exit(1);
	});
