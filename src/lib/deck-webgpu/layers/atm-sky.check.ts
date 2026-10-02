// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU check for layers/atm-sky.ts (browser only; no lab wiring needed). Renders the WGSL port on a
// standalone WebGPU device through the real colour pass (hosts/passes.ts runColorPass: 4× MSAA
// rgba16float, reversed-Z, resolve) and compares it with the ORIGINAL GLSL (look/glsl/atmosphere.ts
// ATM_BLOCK / ATMOSPHERE_FNS / SKY_BLOCK / SKY_FS_MAIN, compiled as-is on a WebGL2 canvas into an
// rgba32float target) on the same camera and atmosphere values.
//
//   sky       atm_sky(camera_ray) vs atmSky(sky_ray · ndc) for a low sun ahead (physical airlight)
//             and a high sun behind (fitted airlight, turbid), every sky pixel
//   depth     an opaque quad drawn earlier (depth 0.5) keeps its colour (sky only where depth = 0)
//   under     a translucent premultiplied overlay drawn earlier over the sky ends up OVER the sky
//             (the WebGL "sky first" result)
//   flat      mode 'flat' → WORLD_SKY, sRGB-encoded back to #a9c2da (±1)
//   photo     frame.view 'photo' → the sky stays transparent (alpha 0)
//   fog       batched terrain + atmosphereFogPart vs GLSL applyAtmosphere(colour, ENU) per pixel, where
//             colour / ENU come from the same terrain without fog and the geometry pass
//
// Run from any page on the dev server (vite transforms the import):
//   await (await import("/src/lib/deck-webgpu/layers/atm-sky.check.ts")).runAtmSkyCheck()
import type { Device, Texture } from "@luma.gl/core";
import { luma } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { lookAtQuaternion, ViewCamera } from "#/lib/camera/view-camera";
import { createSyntheticTile } from "#/lib/deck/synthetic-tile";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { type AtmValues, defaultAtmosphere } from "#/lib/look/atmosphere";
import {
	ATM_BLOCK,
	ATMOSPHERE_FNS,
	SKY_BLOCK,
	SKY_FS_MAIN,
	SKY_VS,
	skyRayMatrix,
} from "#/lib/look/glsl/atmosphere";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import {
	type CameraPose,
	runColorPass,
	runGeometryPass,
} from "../hosts/passes";
import {
	type FrameState,
	type GpuLayerCore,
	type PassContext,
	passModelProps,
} from "../pass";
import { TextureReader } from "../readback";
import { ColorTargets, GeometryTargets } from "../targets";
import type { TerrainShaderPart } from "../terrain";
import { AtmSkyCore, atmosphereFogPart, WORLD_SKY } from "./atm-sky";
import { createBatchedTerrain } from "./batched-terrain";

const W = 256;
const H = 160;

export type AtmSkyCheckResult = {
	ok: boolean;
	errors: string[];
	checks: Record<string, { ok: boolean; [k: string]: unknown }>;
	/** Side-by-side PNG (WGSL | GLSL) of the first sky scenario, sRGB. */
	preview?: string;
};

// ---------- small helpers ----------

function atmOf(sunDir: Vec3, over: Partial<AtmValues> = {}): AtmValues {
	const p = defaultAtmosphere(sunDir);
	return {
		eye: [0, 0, 0],
		betaR: p.betaR,
		sunDir: p.sunDir,
		sunColor: p.sunColor,
		airlight: p.airlight,
		h: [p.hR, p.hM],
		betaM: p.betaM,
		strength: p.strength,
		mieG: p.mieG,
		airlightMix: p.airlightMix ?? 0,
		...over,
	};
}

function norm(a: Vec3): Vec3 {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}

const f16 = (h: number) => {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (m / 1024);
	if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + m / 1024);
};

const enc = (c: number) => {
	const x = Math.max(0, c);
	return Math.round(
		255 *
			Math.min(1, x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055),
	);
};

/** rgba16float texture → Float32Array (top-first rows). */
async function readHalf(device: Device, tex: Texture) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		id: "atm-check-read",
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008,
	});
	tex.readBuffer({}, buf);
	const data = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const u16 = new Uint16Array(
		data.buffer,
		data.byteOffset,
		data.byteLength / 2,
	);
	const out = new Float32Array(tex.width * tex.height * 4);
	const stride = layout.bytesPerRow / 2;
	for (let y = 0; y < tex.height; y++)
		for (let i = 0; i < tex.width * 4; i++)
			out[y * tex.width * 4 + i] = f16(u16[y * stride + i]);
	return out;
}

// ---------- the GLSL reference (the WebGL shaders' own source) ----------

class GlslRef {
	readonly gl: WebGL2RenderingContext;
	private sky: WebGLProgram;
	private apply: WebGLProgram;
	private fbo: WebGLFramebuffer;

	constructor() {
		const canvas = document.createElement("canvas");
		canvas.width = W;
		canvas.height = H;
		const gl = canvas.getContext("webgl2");
		if (!gl) throw new Error("no WebGL2");
		if (!gl.getExtension("EXT_color_buffer_float"))
			throw new Error("no EXT_color_buffer_float");
		this.gl = gl;
		const head =
			"#version 300 es\nprecision highp float;\nprecision highp int;\n";
		this.sky = this.program(
			`${head}${SKY_VS}`,
			`${head}${ATM_BLOCK.glslDecl}${ATMOSPHERE_FNS}${SKY_BLOCK.glslDecl}${SKY_FS_MAIN}
out vec4 o;
void main() { o = vec4(skyColor(), 1.0); }`,
		);
		this.apply = this.program(
			`${head}${SKY_VS}`,
			`${head}${ATM_BLOCK.glslDecl}${ATMOSPHERE_FNS}
uniform sampler2D uCol;
uniform sampler2D uPos;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = vec4(applyAtmosphere(texelFetch(uCol, p, 0).rgb, texelFetch(uPos, p, 0).xyz), 1.0);
}`,
		);
		const tex = this.floatTex(null);
		const fbo = gl.createFramebuffer();
		if (!fbo) throw new Error("fbo");
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(
			gl.FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			tex,
			0,
		);
		this.fbo = fbo;
	}

	private floatTex(data: Float32Array | null) {
		const gl = this.gl;
		const t = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, t);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA32F,
			W,
			H,
			0,
			gl.RGBA,
			gl.FLOAT,
			data,
		);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		return t;
	}

	private program(vs: string, fs: string) {
		const gl = this.gl;
		const p = gl.createProgram();
		for (const [type, src] of [
			[gl.VERTEX_SHADER, vs],
			[gl.FRAGMENT_SHADER, fs],
		] as const) {
			const s = gl.createShader(type);
			if (!s) throw new Error("shader");
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
				throw new Error(`GLSL: ${gl.getShaderInfoLog(s)}`);
			gl.attachShader(p, s);
		}
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS))
			throw new Error(`GLSL link: ${gl.getProgramInfoLog(p)}`);
		return p;
	}

	private setAtm(p: WebGLProgram, atm: AtmValues, eye: Vec3) {
		const gl = this.gl;
		const v = { ...atm, eye } as Record<string, number | readonly number[]>;
		for (const [k, type] of Object.entries(ATM_BLOCK.fields)) {
			const loc = gl.getUniformLocation(p, ATM_BLOCK.uniformName(k));
			const x = v[k];
			if (type === "float") gl.uniform1f(loc, x as number);
			else if (type === "vec2") gl.uniform2fv(loc, x as number[]);
			else gl.uniform3fv(loc, x as number[]);
		}
	}

	private run() {
		const gl = this.gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
		gl.viewport(0, 0, W, H);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		const out = new Float32Array(W * H * 4);
		gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, out);
		return out;
	}

	/** Sky radiance, rows flipped to top-first (WebGPU order). */
	renderSky(atm: AtmValues, cam: ViewCamera) {
		const gl = this.gl;
		const use = gl.useProgram.bind(gl);
		use(this.sky);
		this.setAtm(this.sky, atm, cam.eye);
		gl.uniformMatrix4fv(
			gl.getUniformLocation(this.sky, SKY_BLOCK.uniformName("ray")),
			false,
			skyRayMatrix([...cam.projectionMatrix()], [...cam.viewMatrix()]),
		);
		const raw = this.run();
		const out = new Float32Array(raw.length);
		for (let y = 0; y < H; y++)
			out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
		return out;
	}

	/** applyAtmosphere(col[i], pos[i]) per texel (same row order in and out). */
	renderApply(atm: AtmValues, eye: Vec3, col: Float32Array, pos: Float32Array) {
		const gl = this.gl;
		const use = gl.useProgram.bind(gl);
		use(this.apply);
		this.setAtm(this.apply, atm, eye);
		const tc = this.floatTex(col);
		const tp = this.floatTex(pos);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, tc);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, tp);
		gl.uniform1i(gl.getUniformLocation(this.apply, "uCol"), 0);
		gl.uniform1i(gl.getUniformLocation(this.apply, "uPos"), 1);
		const out = this.run();
		gl.deleteTexture(tc);
		gl.deleteTexture(tp);
		return out;
	}
}

// ---------- test cores drawn before the sky ----------

/** An NDC rectangle at a fixed reversed-Z depth, opaque (depth write) or translucent (test-only). */
class QuadCore implements GpuLayerCore {
	readonly passes = ["color"] as const;
	private model?: Model;

	constructor(
		readonly id: string,
		readonly order: number,
		private rect: [number, number, number, number],
		private depth: number,
		private rgba: [number, number, number, number],
		private opaque: boolean,
	) {}

	draw(ctx: PassContext) {
		const [x0, y0, x1, y1] = this.rect;
		const [r, g, b, a] = this.rgba;
		this.model ??= new Model(ctx.device, {
			id: this.id,
			source: /* wgsl */ `
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var c = array<vec2<f32>, 6>(vec2<f32>(${x0}, ${y0}), vec2<f32>(${x1}, ${y0}), vec2<f32>(${x1}, ${y1}),
                              vec2<f32>(${x0}, ${y0}), vec2<f32>(${x1}, ${y1}), vec2<f32>(${x0}, ${y1}));
  return vec4<f32>(c[i], ${this.depth.toFixed(4)}, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(${[r * a, g * a, b * a, a].map((v) => v.toFixed(4)).join(", ")});
}`,
			...passModelProps("color", {
				depth: this.opaque ? "write" : "test",
				blend: !this.opaque,
			}),
			topology: "triangle-list",
			vertexCount: 6,
		} as never);
		this.model.draw(ctx.renderPass);
	}

	destroy() {
		this.model?.destroy();
	}
}

// ---------- scenes ----------

const EYE: Vec3 = [0, 0, 1500];
const VFOV = 70;

function pose(pitchDeg: number): CameraPose {
	const p = (pitchDeg * Math.PI) / 180;
	const forward = norm([0, Math.cos(p), Math.sin(p)]);
	const right: Vec3 = [1, 0, 0];
	const up: Vec3 = [
		right[1] * forward[2] - right[2] * forward[1],
		right[2] * forward[0] - right[0] * forward[2],
		right[0] * forward[1] - right[1] * forward[0],
	];
	return { eye: EYE, forward, up, vfov: VFOV, near: 5 };
}

function viewCamera(p: CameraPose) {
	const cam = new ViewCamera(VFOV, W / H, 5, 600000);
	cam.position.set(...p.eye);
	lookAtQuaternion(
		cam.quaternion,
		p.eye,
		[p.eye[0] + p.forward[0], p.eye[1] + p.forward[1], p.eye[2] + p.forward[2]],
		p.up,
	);
	return cam;
}

/** Flat ground (800 m) on a z8 tile, about 107 km square; the batched terrain bakes the curvature drop in. */
function groundTile(): TileMesh {
	return createSyntheticTile(() => 800, { z: 8, southEdgeM: 50 }).tile;
}

// ---------- the check ----------

export async function runAtmSkyCheck(): Promise<AtmSkyCheckResult> {
	const errors: string[] = [];
	const checks: AtmSkyCheckResult["checks"] = {};
	const device = await luma.createDevice({
		id: "atm-sky-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
		featureLevel: "max",
		onError: (e: Error) => {
			errors.push(e.message);
		},
	} as never);
	const gpu = (device as unknown as { handle: GPUDevice }).handle;
	gpu.pushErrorScope("validation");
	const ref = new GlslRef();
	const geometry = new GeometryTargets(device, W, H, "atm-check-geo");
	const color = new ColorTargets(device, W, H, "atm-check-color");
	const world: FrameState = { frame: 0, time: 0, view: "world" };
	let preview: string | undefined;

	const renderColor = async (
		cores: GpuLayerCore[],
		view: CameraPose,
		frame = world,
	) => {
		runColorPass({ device, cores, geometry, color, view, frame });
		device.submit();
		return readHalf(device, color.color);
	};

	// --- sky scenarios (plus the depth / under-blend probes in the first) ---
	const solid = new QuadCore(
		"solid",
		0,
		[-0.9, 0.5, -0.5, 0.9],
		0.5,
		[1, 0, 0, 1],
		true,
	);
	const veil = new QuadCore(
		"veil",
		10,
		[0.5, 0.5, 0.9, 0.9],
		0.25,
		[0, 1, 0, 0.5],
		false,
	);
	const inRect = (
		x: number,
		y: number,
		r: [number, number, number, number],
		m = 0.02,
	) => {
		const nx = ((x + 0.5) / W) * 2 - 1;
		const ny = 1 - ((y + 0.5) / H) * 2;
		return nx > r[0] + m && nx < r[2] - m && ny > r[1] + m && ny < r[3] - m;
	};
	const scenarios: { name: string; atm: AtmValues; pitch: number }[] = [
		{ name: "sky-low-sun-ahead", atm: atmOf([0.2, 0.9, 0.15]), pitch: 3 },
		{
			name: "sky-high-sun-behind-fitted",
			atm: atmOf([-0.5, -0.4, 0.75], {
				airlight: [0.55, 0.6, 0.7],
				airlightMix: 1,
				strength: 2.5,
			}),
			pitch: 12,
		},
	];
	const sky = new AtmSkyCore();
	for (const [si, sc] of scenarios.entries()) {
		sky.setSky({ mode: "atmosphere", atm: sc.atm });
		sky.setView("world");
		const view = pose(sc.pitch);
		const probes = si === 0;
		const got = await renderColor(probes ? [sky, solid, veil] : [sky], view);
		const want = ref.renderSky(sc.atm, viewCamera(view));
		let maxAbs = 0;
		let maxRel = 0;
		let max8 = 0;
		const badRows = new Map<number, number>();
		let bad = 0;
		let solidBad = 0;
		let veilMax = 0;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const o = (y * W + x) * 4;
				// MSAA edge band of the probe quads: neither pure sky nor pure probe
				const edge = (r: [number, number, number, number]) =>
					inRect(x, y, r, -0.02) && !inRect(x, y, r);
				if (
					probes &&
					(edge([-0.9, 0.5, -0.5, 0.9]) || edge([0.5, 0.5, 0.9, 0.9]))
				)
					continue;
				if (probes && inRect(x, y, [-0.9, 0.5, -0.5, 0.9])) {
					const d =
						Math.abs(got[o] - 1) +
						got[o + 1] +
						got[o + 2] +
						Math.abs(got[o + 3] - 1);
					if (d > 1e-3) solidBad++;
					continue;
				}
				const isVeil = probes && inRect(x, y, [0.5, 0.5, 0.9, 0.9]);
				for (let c = 0; c < 3; c++) {
					const w = isVeil
						? (c === 1 ? 0.5 : 0) + 0.5 * want[o + c]
						: want[o + c];
					const e = Math.abs(got[o + c] - w);
					if (isVeil) veilMax = Math.max(veilMax, e);
					maxAbs = Math.max(maxAbs, e);
					maxRel = Math.max(maxRel, e / Math.max(1e-3, Math.abs(w)));
					max8 = Math.max(max8, Math.abs(enc(got[o + c]) - enc(w)));
					if (e > 1e-3 + 3e-3 * Math.abs(w)) {
						bad++;
						badRows.set(y, (badRows.get(y) ?? 0) + 1);
					}
				}
				if (Math.abs(got[o + 3] - 1) > 1e-3) bad++;
			}
		checks[sc.name] = {
			ok: bad === 0 && max8 <= 1,
			maxAbs,
			maxRel,
			max8,
			bad,
			badRows: Object.fromEntries(badRows),
		};
		if (probes) {
			checks.depth = { ok: solidBad === 0, badPixels: solidBad };
			checks.under = { ok: veilMax < 3e-3, maxAbs: veilMax };
			const c = document.createElement("canvas");
			c.width = W * 2;
			c.height = H;
			const g = c.getContext("2d");
			if (g) {
				const img = g.createImageData(W * 2, H);
				for (let y = 0; y < H; y++)
					for (let x = 0; x < W; x++)
						for (const [side, src] of [
							[0, got],
							[1, want],
						] as const) {
							const o = (y * W + x) * 4;
							const d = (y * W * 2 + side * W + x) * 4;
							for (let k = 0; k < 3; k++) img.data[d + k] = enc(src[o + k]);
							img.data[d + 3] = 255;
						}
				g.putImageData(img, 0, 0);
				preview = c.toDataURL("image/png");
			}
		}
	}

	// --- flat sky (mode 'flat', and 'atmosphere' without values) ---
	for (const [name, props] of [
		["flat", { mode: "flat", atm: scenarios[0].atm }],
		["flat-no-atm", { mode: "atmosphere", atm: null }],
	] as const) {
		sky.setSky({ ...props, flatColor: WORLD_SKY });
		const got = await renderColor([sky], pose(3));
		const want = [0xa9, 0xc2, 0xda];
		let max8 = 0;
		for (let i = 0; i < W * H; i++)
			for (let c = 0; c < 3; c++)
				max8 = Math.max(max8, Math.abs(enc(got[i * 4 + c]) - want[c]));
		checks[name] = { ok: max8 <= 1, max8, atmospheric: sky.atmospheric };
	}

	// --- photo view: transparent ---
	sky.setSky({ mode: "atmosphere", atm: scenarios[0].atm });
	{
		const got = await renderColor([sky], pose(3), { ...world, view: "photo" });
		let maxA = 0;
		for (let i = 0; i < W * H; i++) maxA = Math.max(maxA, got[i * 4 + 3]);
		sky.setView("photo");
		checks.photo = { ok: maxA === 0 && !sky.visible(), maxAlpha: maxA };
		sky.setView("world");
	}

	// --- fog: the batched terrain + atmosphereFogPart vs GLSL applyAtmosphere ---
	{
		const fogAtm = atmOf([0.3, 0.8, 0.25], { strength: 1.6 });
		const view = pose(-8);
		const tile = groundTile();
		const withFog = createBatchedTerrain(device, null, "atm-check-terrain-fog");
		const noFog = createBatchedTerrain(device, null, "atm-check-terrain-raw");
		const identity: TerrainShaderPart = {
			key: "identity-nofog",
			wgsl: "fn atm_check_identity(c: vec4<f32>, s: TerrainSample) -> vec4<f32> { return c; }",
			defines: { TERRAIN_NO_FOG: true },
			apply: "atm_check_identity",
		};
		withFog.setShaderParts(null, [atmosphereFogPart(() => fogAtm)]);
		noFog.setShaderParts(null, [identity]);
		withFog.setTiles([tile]);
		noFog.setTiles([tile]);
		runGeometryPass({
			device,
			cores: [noFog],
			geometry,
			photo: view,
			frame: world,
		});
		device.submit();
		const reader = new TextureReader(device);
		const xyzr = await reader.read(geometry.geometry);
		const raw = await renderColor([noFog], view);
		const got = await renderColor([withFog], view);
		if (!xyzr) throw new Error("geometry readback failed");
		const want = ref.renderApply(fogAtm, view.eye as Vec3, raw, xyzr);
		let n = 0;
		let bad = 0;
		let maxAbs = 0;
		let max8 = 0;
		let hazeMax = 0;
		for (let y = 1; y < H - 1; y++)
			for (let x = 0; x < W; x++) {
				const o = (y * W + x) * 4;
				// interior ground pixels only (MSAA edges mix ground and sky)
				if (
					!(
						xyzr[o + 3] > 0 &&
						xyzr[o + 3 - W * 4] > 0 &&
						xyzr[o + 3 + W * 4] > 0
					)
				)
					continue;
				n++;
				for (let c = 0; c < 3; c++) {
					const e = Math.abs(got[o + c] - want[o + c]);
					maxAbs = Math.max(maxAbs, e);
					max8 = Math.max(max8, Math.abs(enc(got[o + c]) - enc(want[o + c])));
					hazeMax = Math.max(hazeMax, Math.abs(want[o + c] - raw[o + c]));
					if (e > 2e-3 + 3e-3 * Math.abs(want[o + c])) bad++;
				}
			}
		checks.fog = {
			ok: n > W * 10 && bad === 0 && max8 <= 1 && hazeMax > 0.05,
			pixels: n,
			bad,
			maxAbs,
			max8,
			hazeMax,
		};
		reader.destroy();
		withFog.destroy();
		noFog.destroy();
	}

	const scopeErr = await gpu.popErrorScope();
	if (scopeErr) errors.push(`validation: ${scopeErr.message}`);
	sky.destroy();
	solid.destroy();
	veil.destroy();
	geometry.destroy();
	color.destroy();
	device.destroy();
	const ok = !errors.length && Object.values(checks).every((c) => c.ok);
	return { ok, errors, checks, preview };
}
