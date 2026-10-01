// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Checks for layers/tiles3d.ts.
//
// CPU (node, no GPU):  npx tsx src/lib/deck-webgpu/layers/tiles3d.check.ts
//   - the four programs (colour / GEOMETRY_PASS × mesh / INSTANCED) assemble with luma's WGSL
//     assembler and expose the expected bindings
//
// GPU (browser, WebGPU): `runTiles3DGpuCheck()` renders synthetic tile meshes (real THREE meshes with
// tiles3d/material.ts materials, a duck-typed Tiles3DSet) through the real passes
// (hosts/passes.ts: geometry, then 4× MSAA colour + resolve), reads back and checks:
//   shade      untextured, camera-facing quad = srgb_decode(albedo · 0.55) (derivative normal faces the
//              camera: the WebGL cross(dFdx, dFdy) sign)
//   texture    textured quad = srgb_decode(texel bytes)
//   instanced  both i3dm instances land on their CPU projections
//   eyeClear   a quad 20 m from the Step Inside eye is dithered away (uClear 25 → 40 m)
//   bias       a tile 2% behind an opaque wall wins with depthBias 0.97, loses with 1.0
//   fill       inside the photo frame, a tile in front of the photographed surface is dropped, a
//              tile well behind it (disocclusion) stays, the fg mask brings the dropped one back,
//              tiles outside the frame stay
//   truth      Truth mix of the DEM provenance colour; hideDisplayOnly removes Google
//   geometry   geometry: true writes class 3 + ENU xyz + range, never the display-only tile
// Load it from any page on the dev server:
//   await (await import('/src/lib/deck-webgpu/layers/tiles3d.check.ts')).runTiles3DGpuCheck()
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { ShaderAssembler } from "@luma.gl/shadertools";
import * as THREE from "three";
import {
	PROVENANCE_COLORS,
	PROVENANCE_TINT_MIX,
} from "#/lib/nearfield/provenance";
import {
	makeTileMaterial,
	makeTileSharedUniforms,
} from "#/lib/tiles3d/material";
import type { Tiles3DSet } from "#/lib/tiles3d/tiles";
import {
	type CameraUniforms,
	cameraModule,
	cameraUniforms,
	photoCameraModule,
	projectToPixel,
} from "../camera";
import {
	type CameraPose,
	runColorPass,
	runGeometryPass,
} from "../hosts/passes";
import {
	type FrameState,
	type GpuLayerCore,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { TextureReader } from "../readback";
import { ColorTargets, GeometryTargets } from "../targets";
import { createTiles3DCore, tiles3dModule, tiles3dWGSL } from "./tiles3d";

type V3 = [number, number, number];

// ---------------------------------------------------------------- CPU: program layouts

type Layout = { bindings: { name: string; type: string; group: number }[] };

async function assembleLayout(
	geometry: boolean,
	instanced: boolean,
): Promise<Layout> {
	const { getShaderLayoutFromWGSL } = await import("@luma.gl/webgpu");
	const asm = ShaderAssembler.getDefaultShaderAssembler(
		"wgsl" as never,
	) as unknown as { assembleWGSLShader(p: unknown): { source: string } };
	const r = asm.assembleWGSLShader({
		platformInfo: {
			type: "webgpu",
			shaderLanguage: "wgsl",
			shaderLanguageVersion: 100,
			gpu: "apple",
			features: new Set(),
		},
		source: tiles3dWGSL,
		modules: geometry
			? [cameraModule, tiles3dModule]
			: [cameraModule, photoCameraModule, tiles3dModule],
		defines: {
			...(geometry ? { GEOMETRY_PASS: true } : {}),
			...(instanced ? { INSTANCED: true } : {}),
		},
	});
	return getShaderLayoutFromWGSL(r.source) as unknown as Layout;
}

export async function runTiles3DCpuCheck() {
	const out: Record<string, { ok: boolean; bindings: string[] }> = {};
	for (const geometry of [false, true])
		for (const instanced of [false, true]) {
			const l = await assembleLayout(geometry, instanced);
			const names = l.bindings.map((b) => b.name).sort();
			const want = geometry
				? ["camera", "tileData", "tiles3d"]
				: [
						"camera",
						"photoCam",
						"tileData",
						"tileFg",
						"tileFgSampler",
						"tileGeo",
						"tileMap",
						"tileMapSampler",
						"tiles3d",
					];
			out[`${geometry ? "geometry" : "color"}|${instanced ? "i3dm" : "mesh"}`] =
				{
					ok: JSON.stringify(names) === JSON.stringify(want.sort()),
					bindings: names,
				};
		}
	return { ok: Object.values(out).every((c) => c.ok), programs: out };
}

// ---------------------------------------------------------------- GPU: helpers

function half(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}

async function readRgba16f(device: Device, tex: Texture) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008,
	});
	tex.readBuffer({}, buf);
	const bytes = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const u16 = new Uint16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / 2,
	);
	const out = new Float32Array(tex.width * tex.height * 4);
	const stride = layout.bytesPerRow / 2;
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = half(u16[y * stride + x]);
	return out;
}

const srgbDecode = (c: number) =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** A camera-facing quad in the plane y = const: x0..x1, z0..z1. */
function quadGeometry(x0: number, x1: number, z0: number, z1: number, y = 0) {
	const g = new THREE.BufferGeometry();
	g.setAttribute(
		"position",
		new THREE.BufferAttribute(
			new Float32Array([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]),
			3,
		),
	);
	g.setAttribute(
		"uv",
		new THREE.BufferAttribute(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 2),
	);
	g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
	return g;
}

/** Colour-only opaque wall in y = WALL_Y (depth written): the bias test's occluder. */
class ColorWall implements GpuLayerCore {
	readonly id = "tiles3d-check-wall";
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = 0;
	private model: Model;
	constructor(device: Device, y: number, x0: number, x1: number) {
		this.model = new Model(device, {
			id: this.id,
			source: /* wgsl */ `\
var<private> P = array<vec2<f32>, 6>(
  vec2<f32>(${x0.toFixed(1)}, -60.0), vec2<f32>(${x1.toFixed(1)}, -60.0), vec2<f32>(${x1.toFixed(1)}, 60.0),
  vec2<f32>(${x0.toFixed(1)}, -60.0), vec2<f32>(${x1.toFixed(1)}, 60.0), vec2<f32>(${x0.toFixed(1)}, 60.0),
);
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let q = P[i];
  return camera_clip(vec3<f32>(q.x, ${y.toFixed(1)}, q.y));
}
@fragment fn fragmentMain() -> @location(0) vec4<f32> { return vec4<f32>(0.0, 0.0, 1.0, 1.0); }
`,
			modules: [cameraModule] as never,
			...passModelProps("color", { depth: "write" }),
			topology: "triangle-list",
			vertexCount: 6,
		} as never);
	}
	draw(ctx: PassContext) {
		this.model.shaderInputs.setProps({ camera: ctx.camera } as never);
		this.model.draw(ctx.renderPass);
	}
	destroy() {
		this.model.destroy();
	}
}

/** Geometry-only "terrain": a big plane at y = Y (class 0), what the photo camera sees. */
class GeometryWall implements GpuLayerCore {
	readonly id = "tiles3d-check-ground";
	readonly passes: readonly PassKind[] = ["geometry"];
	readonly order = 0;
	private model: Model;
	constructor(device: Device, y: number) {
		this.model = new Model(device, {
			id: this.id,
			source: /* wgsl */ `\
var<private> P = array<vec2<f32>, 6>(
  vec2<f32>(-5000.0, -5000.0), vec2<f32>(5000.0, -5000.0), vec2<f32>(5000.0, 5000.0),
  vec2<f32>(-5000.0, -5000.0), vec2<f32>(5000.0, 5000.0), vec2<f32>(-5000.0, 5000.0),
);
struct V { @builtin(position) p: vec4<f32>, @location(0) w: vec3<f32> };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> V {
  let q = P[i];
  let w = vec3<f32>(q.x, ${y.toFixed(1)}, q.y);
  return V(camera_clip(w), w);
}
struct G { @location(0) xyzr: vec4<f32>, @location(1) normal: vec4<f32> };
@fragment fn fragmentMain(v: V) -> G {
  return G(vec4<f32>(v.w, camera_range(v.w)), vec4<f32>(0.0, -1.0, 0.0, 0.0));
}
`,
			modules: [cameraModule] as never,
			...passModelProps("geometry"),
			topology: "triangle-list",
			vertexCount: 6,
		} as never);
	}
	draw(ctx: PassContext) {
		this.model.shaderInputs.setProps({ camera: ctx.camera } as never);
		this.model.draw(ctx.renderPass);
	}
	destroy() {
		this.model.destroy();
	}
}

export type Tiles3DGpuCheck = {
	ok: boolean;
	checks: Record<string, { ok: boolean; [k: string]: unknown }>;
	stats: unknown;
	errors: string[];
};

// ---------------------------------------------------------------- GPU: the check

export async function runTiles3DGpuCheck(
	opts: { width?: number; height?: number } = {},
): Promise<Tiles3DGpuCheck> {
	const W = opts.width ?? 320;
	const H = opts.height ?? 200;
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	const { OPTIONAL_FEATURES } = await import("../device");
	const device = (await luma.createDevice({
		id: "tiles3d-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
		featureLevel: "max",
		optionalFeatures: [...OPTIONAL_FEATURES],
	} as never)) as Device;
	const errors: string[] = [];
	const gpu = (device as unknown as { handle: GPUDevice }).handle;
	gpu.addEventListener?.("uncapturederror", (e) =>
		errors.push(String((e as GPUUncapturedErrorEvent).error.message)),
	);

	// --- the synthetic tile set (duck-typed Tiles3DSet)
	const shared = makeTileSharedUniforms();
	shared.uEye.value.set(0, 0, 0);
	const buildings = { displayOnly: false, depthBias: 0.97 };
	const google = { displayOnly: true, depthBias: 0.97 };
	const ALBEDO: V3 = [0.8, 0.4, 0.2];
	const mat = (color: V3, map: THREE.Texture | null = null, bias = 0.97) =>
		makeTileMaterial(shared, {
			map,
			color,
			vertexColors: false,
			depthBias: bias,
		});
	// A: untextured, x −150..−50, y 500 (left: outside the photo frame)
	const A = new THREE.Mesh(quadGeometry(-150, -50, -40, 40), mat(ALBEDO));
	A.position.set(0, 500, 0);
	// B: textured, x 50..150 (right, outside the photo frame)
	const canvas = document.createElement("canvas");
	canvas.width = 16;
	canvas.height = 16;
	const c2d = canvas.getContext("2d");
	if (!c2d) throw new Error("no 2d context");
	c2d.fillStyle = "rgb(40,160,220)";
	c2d.fillRect(0, 0, 16, 16);
	const bitmap = await createImageBitmap(canvas);
	const tex = new THREE.Texture(bitmap as never);
	const B = new THREE.Mesh(quadGeometry(50, 150, -40, 40), mat([1, 1, 1], tex));
	B.position.set(0, 500, 0);
	// C: i3dm, a 20 m quad at two instances (−100, 500, 70) and (100, 500, 70)
	const GREEN: V3 = [0.2, 0.7, 0.3];
	const C = new THREE.InstancedMesh(
		quadGeometry(-10, 10, -10, 10),
		mat(GREEN),
		2,
	);
	const m4 = new THREE.Matrix4();
	C.setMatrixAt(0, m4.makeTranslation(-100, 500, 70));
	C.setMatrixAt(1, m4.makeTranslation(100, 500, 70));
	C.instanceMatrix.needsUpdate = true;
	// D: display-only (Google), inside the photo frame, x 20..40, z −40..−20
	const D = new THREE.Mesh(
		quadGeometry(20, 40, -40, -20),
		mat([0.9, 0.9, 0.9]),
	);
	D.position.set(0, 500, 0);
	// E: 20 m from the eye (inside the 25 m clear zone), centre of the view
	const E = new THREE.Mesh(quadGeometry(-3, 3, -3, 3), mat([1, 0, 1]));
	E.position.set(0, 20, 0);
	// F: centre, in front of the photographed surface (y 1000): dropped by fill
	const F = new THREE.Mesh(quadGeometry(-8, 8, -8, 8), mat([0.5, 0.5, 0.9]));
	F.position.set(0, 500, 0);
	// G: behind the photographed surface (a disocclusion: r > 1000·1.08 + 25): kept by fill
	const G = new THREE.Mesh(
		quadGeometry(-40, -20, 15, 35),
		mat([0.9, 0.9, 0.2]),
	);
	G.position.set(0, 1200, 0);
	const all: { mesh: THREE.Mesh; source: typeof buildings }[] = [
		{ mesh: A, source: buildings },
		{ mesh: B, source: buildings },
		{ mesh: C, source: buildings },
		{ mesh: D, source: google },
		{ mesh: E, source: buildings },
		{ mesh: F, source: buildings },
		{ mesh: G, source: buildings },
	];
	const set = {
		uniforms: shared,
		onDisposeMesh: new Set<(m: THREE.Mesh) => void>(),
		visibleMeshes() {
			for (const e of all) e.mesh.updateMatrixWorld(true);
			return all;
		},
	} as unknown as Tiles3DSet;

	// --- cores and targets
	const tiles = createTiles3DCore(device, {
		fill: false,
		clearCamera: [0, -1e5, 0],
	});
	tiles.setSet(set);
	const wall = new ColorWall(device, 490, -160, -120);
	const ground = new GeometryWall(device, 1000);
	const color = new ColorTargets(device, W, H, "tiles3d-check-color");
	const geometry = new GeometryTargets(device, 256, 160, "tiles3d-check-geo");
	const reader = new TextureReader(device);
	const view: CameraPose = {
		eye: [0, 0, 0],
		forward: [0, 1, 0],
		up: [0, 0, 1],
		vfov: 40,
		near: 1,
	};
	const photo: CameraPose = { ...view, vfov: 10 };
	const photoCam: CameraUniforms = cameraUniforms({
		...photo,
		width: geometry.width,
		height: geometry.height,
	});
	const cam = cameraUniforms({ ...view, width: W, height: H });
	let frameNo = 0;
	const cores = [wall, ground, tiles];
	const render = async () => {
		const frame: FrameState = {
			frame: ++frameNo,
			time: performance.now(),
			view: "world",
		};
		runGeometryPass({ device, cores, geometry, photo, frame });
		runColorPass({ device, cores, geometry, color, view, frame });
		device.submit();
		return readRgba16f(device, color.color);
	};
	const px = (buf: Float32Array, p: V3) => {
		const q = projectToPixel(cam, p);
		if (!q) return [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
		const i = (Math.floor(q.y) * W + Math.floor(q.x)) * 4;
		return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
	};
	const near = (a: number[], b: number[], tol = 0.012) =>
		a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
	const lin = (c: V3, k = 1) => [...c.map((v) => srgbDecode(v * k)), 1];
	const SKY = [0, 0, 0, 0];
	const checks: Tiles3DGpuCheck["checks"] = {};

	// run 1: plain (fill off, truth off, geometry off)
	let img = await render();
	const aOpen = px(img, [-70, 500, 0]);
	checks.shade = {
		ok: near(aOpen, lin(ALBEDO, 0.55)),
		got: aOpen,
		want: lin(ALBEDO, 0.55),
	};
	const bPx = px(img, [100, 500, 0]);
	const bWant = lin([40 / 255, 160 / 255, 220 / 255]);
	checks.texture = { ok: near(bPx, bWant), got: bPx, want: bWant };
	// the mipmapped texture is built in a later task (flushMips), then swapped in
	await new Promise((r) => setTimeout(r, 30));
	img = await render();
	const bMip = px(img, [100, 500, 0]);
	checks.textureMipmapped = {
		ok: tiles.stats.mipSwaps === 1 && near(bMip, bWant),
		mipSwaps: tiles.stats.mipSwaps,
		got: bMip,
	};
	const c0 = px(img, [-100, 500, 70]);
	const c1 = px(img, [100, 500, 70]);
	checks.instanced = {
		ok: near(c0, lin(GREEN, 0.55)) && near(c1, lin(GREEN, 0.55)),
		c0,
		c1,
	};
	// E covers ±8.5° around the centre; F only ±0.9°: sample E's area off F
	const eOff = px(img, [2.5, 20, 2.5]);
	checks.eyeClear = { ok: near(eOff, SKY), got: eOff };
	const aWall = px(img, [-140, 500, 0]);
	checks.biasWins = {
		ok: near(aWall, lin(ALBEDO, 0.55)),
		got: aWall,
	};
	const dOn = px(img, [30, 500, -30]);
	checks.displayOnlyShown = { ok: dOn[3] > 0.99, got: dOn };

	// run 2: depth bias 1.0 → the wall (2% nearer) wins
	(A.material as THREE.ShaderMaterial).uniforms.uDepthBias.value = 1;
	img = await render();
	const aWall1 = px(img, [-140, 500, 0]);
	checks.biasLoses = { ok: near(aWall1, [0, 0, 1, 1]), got: aWall1 };
	(A.material as THREE.ShaderMaterial).uniforms.uDepthBias.value = 0.97;

	// run 3: fill on, photo camera vfov 10 over the ground at 1000 m
	tiles.setOptions({ fill: true });
	tiles.setPhotoCamera(photoCam);
	img = await render();
	const fDrop = px(img, [0, 500, 0]);
	const gKeep = px(img, [-30, 1200, 25]);
	const aKeep = px(img, [-90, 500, 0]);
	const dDrop = px(img, [30, 500, -30]);
	checks.fill = {
		ok:
			near(fDrop, SKY) &&
			gKeep[3] > 0.99 &&
			near(aKeep, lin(ALBEDO, 0.55)) &&
			near(dDrop, SKY),
		fDrop,
		gKeep,
		aKeep,
		dDrop,
	};

	// run 4: the fg mask over the whole photo brings the photographed tiles back
	const ones = new Uint8Array(64 * 40).fill(255);
	tiles.setPhotoFg({ width: 64, height: 40, data: ones });
	img = await render();
	const fMasked = px(img, [0, 500, 0]);
	checks.fillMasked = { ok: fMasked[3] > 0.99, got: fMasked };
	tiles.setPhotoFg(null);
	tiles.setOptions({ fill: false });

	// run 5: Truth + hideDisplayOnly
	tiles.setOptions({ truth: true, hideDisplayOnly: true });
	img = await render();
	const t = PROVENANCE_COLORS.dem.map((v) => v / 255);
	const truthWant = [
		...ALBEDO.map((a, i) =>
			srgbDecode(a * 0.55 + (t[i] - a * 0.55) * PROVENANCE_TINT_MIX),
		),
		1,
	];
	const aTruth = px(img, [-70, 500, 0]);
	const dHidden = px(img, [30, 500, -30]);
	checks.truth = { ok: near(aTruth, truthWant), got: aTruth, want: truthWant };
	checks.hideDisplayOnly = { ok: near(dHidden, SKY), got: dHidden };
	tiles.setOptions({ truth: false, hideDisplayOnly: false });

	// run 6: geometry pass contribution (class 3), display-only excluded
	tiles.setOptions({ geometry: true });
	await render();
	const geo = await reader.read(geometry.geometry);
	const nrm = await readRgba16f(device, geometry.normal);
	const gpx = (p: V3) => {
		const q = projectToPixel(photoCam, p);
		if (!q || !geo) return null;
		const i = (Math.floor(q.y) * geometry.width + Math.floor(q.x)) * 4;
		return {
			xyzr: Array.from(geo.subarray(i, i + 4)),
			normal: Array.from(nrm.subarray(i, i + 4)),
		};
	};
	const gF = gpx([0, 500, 0]);
	const gD = gpx([30, 500, -30]);
	checks.geometry = {
		ok:
			!!gF &&
			!!gD &&
			Math.abs(gF.normal[3] - 3) < 1e-3 &&
			Math.abs(gF.xyzr[3] - 500) < 1 &&
			Math.abs(gF.xyzr[1] - 500) < 0.5 &&
			gF.normal[1] < -0.99 &&
			Math.abs(gD.normal[3]) < 1e-3 &&
			gD.xyzr[1] > 999,
		F: gF,
		D: gD,
	};
	tiles.setOptions({ geometry: false });

	// dispose hook frees the GPU copy
	const before = tiles.stats.meshes;
	for (const f of set.onDisposeMesh) f(A);
	checks.dispose = {
		ok: tiles.stats.meshes === before - 1,
		before,
		after: tiles.stats.meshes,
	};

	const stats = JSON.parse(JSON.stringify(tiles.stats));
	tiles.destroy();
	wall.destroy();
	ground.destroy();
	reader.destroy();
	color.destroy();
	geometry.destroy();
	device.destroy();
	checks.gpuErrors = { ok: errors.length === 0, errors };
	return {
		ok: Object.values(checks).every((c) => c.ok),
		checks,
		stats,
		errors,
	};
}

// node entry (CPU part)
if (
	typeof process !== "undefined" &&
	typeof window === "undefined" &&
	process.argv[1]?.endsWith("tiles3d.check.ts")
) {
	runTiles3DCpuCheck().then((r) => {
		console.log(JSON.stringify(r, null, 1));
		if (!r.ok) process.exitCode = 1;
	});
}
