// Check for layers/ridges.ts.
//   Node (no GPU):  npx tsx src/lib/deck-webgpu/layers/ridges.check.ts
//     assembles ridgesModule the way luma's Model does and reflects its binding layout.
//   Browser (WebGPU): `(await import("/src/lib/deck-webgpu/layers/ridges.check.ts")).runRidgesGpuCheck()`
//     on any page of the dev server (render lock + GPU flags). Renders a synthetic scene
//     (sky / far ridge / near hill / very near patch, two normal planes meeting in a crease) through
//     every ridges function and compares each pixel with a literal CPU port of the WebGL GLSL,
//     evaluated on BOTTOM-first GL rows, so the top-first row handling is checked too.
import type { Device, Texture } from "@luma.gl/core";
import {
	DEFAULT_RIDGES,
	RIDGES_WGSL,
	type RidgeUniforms,
	ridgesModule,
} from "./ridges";

// ---- synthetic scene (top-first rows, like the foundation's GeometryTargets) ----------------------

const GW = 96;
const GH = 64;
// Output sizes chosen so no pixel centre (nor centre ± 1.25 texel) lands exactly on a texel edge:
// there GL (bottom-first) and WebGPU (top-first) nearest reads legitimately pick different texels.
const OW = 256;
const OH = 192;

type Scene = {
	range: Float32Array; // GW·GH, top-first, 0 = sky
	normal: Float32Array; // GW·GH·3 (as stored in f16)
	normalHalf: Uint16Array; // GW·GH·4
	mask: Uint8Array; // OW·OH, top-first refined coverage
};

function toHalf(v: number) {
	const f = new Float32Array([v]);
	const x = new Uint32Array(f.buffer)[0];
	const sign = (x >>> 16) & 0x8000;
	const e = ((x >>> 23) & 0xff) - 127 + 15;
	if (e <= 0) return sign;
	if (e >= 31) return sign | 0x7c00;
	const h = (e << 10) | ((x & 0x7fffff) >>> 13);
	return sign | (h + ((x >>> 12) & 1)); // round half up (carry into the exponent is fine)
}
function fromHalf(h: number) {
	const e = (h >>> 10) & 0x1f;
	const m = h & 0x3ff;
	const s = h & 0x8000 ? -1 : 1;
	return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15);
}

export function ridgesScene(): Scene {
	const range = new Float32Array(GW * GH);
	const normal = new Float32Array(GW * GH * 3);
	const normalHalf = new Uint16Array(GW * GH * 4);
	for (let y = 0; y < GH; y++)
		for (let x = 0; x < GW; x++) {
			const ys = 18 + 6 * Math.sin(x * 0.15);
			const yn = 40 + 4 * Math.cos(x * 0.2);
			let r = 0;
			if (y >= ys) r = 20000 / (1 + 0.02 * (y - ys));
			if (x >= 20 && x < 75 && y >= yn) r = 800 - 5 * (y - yn);
			if (x < 15 && y >= 56) r = 40;
			range[y * GW + x] = Math.fround(r);
			const nx = x < 48 ? -0.5 : 0.5;
			const l = Math.hypot(nx, 0.1, 1);
			const n = [nx / l, 0.1 / l, 1 / l];
			for (let k = 0; k < 3; k++) {
				const h = toHalf(n[k]);
				normalHalf[(y * GW + x) * 4 + k] = h;
				normal[(y * GW + x) * 3 + k] = fromHalf(h);
			}
			normalHalf[(y * GW + x) * 4 + 3] = 0; // class 0 = terrain
		}
	const mask = new Uint8Array(OW * OH);
	for (let y = 0; y < OH; y++)
		for (let x = 0; x < OW; x++) {
			const ys = (18 + 6 * Math.sin((x / OW) * GW * 0.15)) * (OH / GH);
			mask[y * OW + x] = Math.round(
				255 * Math.min(1, Math.max(0, 0.5 + (y - ys) / 3)),
			);
		}
	return { range, normal, normalHalf, mask };
}

// ---- CPU reference: the GLSL, literally, on GL rows (row 0 = bottom) ------------------------------

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const roundEven = (x: number) => {
	const r = Math.round(x);
	return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

export type RidgeRef = {
	ridge: number;
	skyline: number;
	range: number;
	crease: number;
	silIn: number;
	silSky: number;
	inkX: number;
	inkY: number;
};

export function ridgesReference(
	s: Scene,
	P: RidgeUniforms,
	// GL vUv (y up)
	u: number,
	v: number,
): RidgeRef {
	const rGL = (ix: number, iy: number) => {
		const x = clamp(ix, 0, GW - 1);
		const y = clamp(iy, 0, GH - 1);
		return s.range[(GH - 1 - y) * GW + x];
	};
	const nGL = (ix: number, iy: number) => {
		const i = ((GH - 1 - iy) * GW + ix) * 3;
		return [s.normal[i], s.normal[i + 1], s.normal[i + 2]];
	};
	const tex = (uu: number, vv: number) =>
		rGL(Math.floor(uu * GW), Math.floor(vv * GH));
	const lrOf = (r: number) => (r > 0 ? Math.log(r) : 13.5);
	const lr = (uu: number, vv: number) => lrOf(tex(uu, vv));
	// classic (composite-shader.ts)
	const range = tex(u, v);
	const c = lr(u, v);
	const ox = 1.25 / GW;
	const oy = 1.25 / GH;
	const e = Math.max(
		Math.abs(c - lr(u + ox, v)),
		Math.abs(c - lr(u - ox, v)),
		Math.abs(c - lr(u, v + oy)),
		Math.abs(c - lr(u, v - oy)),
	);
	const skyline = range > 0 && tex(u, v + oy) === 0 ? 1 : 0;
	let ridge = smoothstep(P.thr[0], P.thr[1], e);
	if (P.nearFade > 0)
		ridge *= range > 0 ? smoothstep(P.nearFade * 0.5, P.nearFade, range) : 1;
	// silhouettes (look/glsl/composite.ts)
	const innerWidth = (r: number) =>
		clamp(
			1.4 - (0.4 * Math.log(Math.max(r, 1) / 1000)) / Math.log(10),
			0.6,
			1.4,
		) * P.inkWidth;
	const sil = (): [number, number, number] => {
		const px = u * GW;
		const py = v * GH;
		const cx = Math.floor(px);
		const cy = Math.floor(py);
		const lc = lrOf(rGL(cx, cy));
		let jmax = 0;
		for (let k = 0; k < 8; k++) {
			const a = Math.fround(k * 0.7853982);
			const dx = Math.fround(Math.cos(a));
			const dy = Math.fround(Math.sin(a));
			jmax = Math.max(
				jmax,
				Math.abs(
					lrOf(rGL(cx + roundEven(dx * 3), cy + roundEven(dy * 3))) - lc,
				),
			);
			jmax = Math.max(
				jmax,
				Math.abs(
					lrOf(rGL(cx + roundEven(dx * 1.5), cy + roundEven(dy * 1.5))) - lc,
				),
			);
		}
		if (jmax < 0.1) return [0, 0, lc < 13 ? Math.exp(lc) : 0];
		const L: number[] = [];
		let lmin = 20;
		for (let i = 0; i < 49; i++) {
			L[i] = lrOf(rGL(cx + (i % 7) - 3, cy + Math.floor(i / 7) - 3));
			lmin = Math.min(lmin, L[i]);
		}
		if (lmin > 13) return [0, 0, 0];
		const pxPerTexel = P.outSize[0] / GW;
		const k = 0.5 * Math.max(pxPerTexel, 1);
		let sN = 0;
		let sF = 0;
		let sS = 0;
		const slopeAllow = (0.045 * 1024) / GW;
		let cMin = [0, 0];
		for (let i = 0; i < 49; i++)
			if (L[i] === lmin) cMin = [(i % 7) - 3, Math.floor(i / 7) - 3];
		for (let i = 0; i < 49; i++) {
			const o = [(i % 7) - 3, Math.floor(i / 7) - 3];
			const jump =
				L[i] - lmin - slopeAllow * Math.hypot(o[0] - cMin[0], o[1] - cMin[1]);
			const ee = Math.exp(
				(-Math.hypot(px - (cx + o[0] + 0.5), py - (cy + o[1] + 0.5)) *
					pxPerTexel) /
					k,
			);
			if (L[i] - lmin < 0.08) sN += ee;
			else if (L[i] > 13) sS += ee;
			else if (jump > 0.12) sF += smoothstep(0.12, 0.4, jump) * ee;
		}
		const dN = -k * Math.log(Math.max(sN, 1e-30));
		const sIn = sF > 0 ? 0.5 * (-k * Math.log(sF) - dN) : 1e3;
		const sSk = sS > 0 ? 0.5 * (-k * Math.log(sS) - dN) : 1e3;
		const rNear = Math.exp(lmin);
		const wIn = innerWidth(rNear);
		const wSky = 1.5 * P.inkWidth;
		return [
			clamp(Math.min(sIn + 0.5, wIn) - Math.max(sIn - 0.5, 0), 0, 1),
			clamp(Math.min(sSk + 0.5, wSky) - Math.max(sSk - 0.5, 0), 0, 1),
			rNear,
		];
	};
	// MASK(uv) = texture(maskTex, (uv.x, 1 − uv.y)), maskTex top-first, bilinear clamp
	const MASK = (uu: number, vv: number) => {
		const x = uu * OW - 0.5;
		const y = (1 - vv) * OH - 0.5;
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const fx = x - x0;
		const fy = y - y0;
		const at = (ix: number, iy: number) =>
			s.mask[clamp(iy, 0, OH - 1) * OW + clamp(ix, 0, OW - 1)] / 255;
		return mix(
			mix(at(x0, y0), at(x0 + 1, y0), fx),
			mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx),
			fy,
		);
	};
	const refinedSkyline = (w: number) => {
		const px = 1 / P.outSize[0];
		const py = 1 / P.outSize[1];
		const q = MASK(u, v);
		const gx = MASK(u + px, v) - MASK(u - px, v);
		const gy = MASK(u, v + py) - MASK(u, v - py);
		const g = 0.5 * Math.hypot(gx, gy);
		if (g < 1e-3) return 0;
		const d = (q - 0.5) / g;
		return (
			clamp(Math.min(d + 0.5, w) - Math.max(d - 0.5, 0), 0, 1) *
			smoothstep(0.008, 0.03, g)
		);
	};
	const creases = () => {
		const cx = Math.floor(u * GW);
		const cy = Math.floor(v * GH);
		const n = nGL(cx, cy);
		let e2 = 0;
		for (const [ox2, oy2] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		]) {
			const qx = clamp(cx + ox2, 0, GW - 1);
			const qy = clamp(cy + oy2, 0, GH - 1);
			// GL normal pass alpha = 1 on terrain
			if (rGL(qx, qy) > 0) {
				const q = nGL(qx, qy);
				e2 = Math.max(e2, 1 - (n[0] * q[0] + n[1] * q[1] + n[2] * q[2]));
			}
		}
		return smoothstep(0.08, 0.25, e2);
	};
	const sv = sil();
	const crease = range > 0 ? creases() : 0;
	// inkLines (cov = 1)
	const lineRange = sv[2] > 0 ? sv[2] : 50000;
	const fade = Math.sqrt(Math.exp(-lineRange / Math.max(P.inkFade, 1)));
	const near =
		P.nearFade > 0 ? smoothstep(P.nearFade * 0.5, P.nearFade, lineRange) : 1;
	const sky = P.refine > 0.5 ? refinedSkyline(1.5 * P.inkWidth) : sv[1];
	const inner = sv[0] * (1 - sky);
	const cr =
		P.inkCrease > 0 && range > 0 ? crease * (1 - inner) * (1 - sky) : 0;
	return {
		ridge,
		skyline,
		range,
		crease,
		silIn: sv[0],
		silSky: sv[1],
		inkX: Math.max(inner * 0.5, cr * P.inkCrease * 0.4) * fade * near,
		inkY: sky * mix(0.55, 1, fade),
	};
}

// ---- GPU run ---------------------------------------------------------------------------------------

const CHECK_WGSL = /* wgsl */ `\
@group(0) @binding(auto) var geoTex: texture_2d<f32>;
@group(0) @binding(auto) var normalTex: texture_2d<f32>;
@group(0) @binding(auto) var maskTex: texture_2d<f32>;
@group(0) @binding(auto) var maskTexSampler: sampler;

struct VOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VOut;
  o.position = vec4<f32>(p, 0.0, 1.0);
  o.uv = vec2<f32>(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}
struct FOut { @location(0) a: vec4<f32>, @location(1) b: vec4<f32> };
@fragment fn fragmentMain(v: VOut) -> FOut {
  let s = ridge_detect(geoTex, v.uv, ridges);
  let sil = ink_silhouettes(geoTex, v.uv, ridges);
  var cr = 0.0;
  if (s.range > 0.0) { cr = ink_creases(geoTex, normalTex, v.uv); }
  let ink = ink_lines(geoTex, normalTex, maskTex, maskTexSampler, v.uv, s.range, 1.0, ridges);
  // exercise the colour helpers too (compiled, values not compared)
  let c0 = ridge_overlay(vec3<f32>(0.0), s, 1.0, ridges) + ridge_replace(vec3<f32>(0.0), s, 1.0, ridges)
         + ink_apply(vec3<f32>(0.0), ink, 1.0, ridges);
  var o: FOut;
  o.a = vec4<f32>(s.ridge, s.skyline, s.range, cr + 0.0 * c0.x);
  o.b = vec4<f32>(sil.x, sil.y, ink.x, ink.y);
  return o;
}
`;

const USAGE_SAMPLE = 0x04;
const USAGE_COPY_DST = 0x02;
const USAGE_COPY_SRC = 0x01;
const USAGE_RENDER = 0x10;

export async function runRidgesGpuCheck(
	opts: { device?: Device } = {},
): Promise<Record<string, unknown>> {
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	const { Model } = await import("@luma.gl/engine");
	const { TextureReader } = await import("../readback");
	const { maskTexture } = await import("../textures");
	const { OPTIONAL_FEATURES } = await import("../device");
	const device =
		opts.device ??
		(await luma.createDevice({
			id: "ridges-check",
			type: "webgpu",
			adapters: [webgpuAdapter],
			featureLevel: "max",
			optionalFeatures: [...OPTIONAL_FEATURES],
		} as never));
	const errors: string[] = [];
	const gpu = (device as unknown as { handle: GPUDevice }).handle;
	gpu.pushErrorScope("validation");
	const scene = ridgesScene();
	const sampler = {
		minFilter: "nearest",
		magFilter: "nearest",
		addressModeU: "clamp-to-edge",
		addressModeV: "clamp-to-edge",
	} as const;
	const geo = device.createTexture({
		id: "ridges-check-geo",
		format: "rgba32float",
		width: GW,
		height: GH,
		usage: USAGE_SAMPLE | USAGE_COPY_DST,
		sampler,
	});
	const g4 = new Float32Array(GW * GH * 4);
	for (let i = 0; i < GW * GH; i++) g4[i * 4 + 3] = scene.range[i];
	geo.writeData(g4 as never, { width: GW, height: GH, bytesPerRow: GW * 16 });
	const normal = device.createTexture({
		id: "ridges-check-normal",
		format: "rgba16float",
		width: GW,
		height: GH,
		usage: USAGE_SAMPLE | USAGE_COPY_DST,
		sampler,
	});
	normal.writeData(scene.normalHalf as never, {
		width: GW,
		height: GH,
		bytesPerRow: GW * 8,
	});
	const mask = maskTexture(device, scene.mask, OW, OH, "ridges-check-mask");
	const outs: Texture[] = [0, 1].map((i) =>
		device.createTexture({
			id: `ridges-check-out${i}`,
			format: "rgba32float",
			width: OW,
			height: OH,
			usage: USAGE_RENDER | USAGE_COPY_SRC,
		}),
	);
	const fbo = device.createFramebuffer({
		id: "ridges-check-fbo",
		width: OW,
		height: OH,
		colorAttachments: outs,
	});
	const model = new Model(device, {
		id: "ridges-check-model",
		source: CHECK_WGSL,
		vertexEntryPoint: "vertexMain",
		fragmentEntryPoint: "fragmentMain",
		modules: [ridgesModule] as never,
		vertexCount: 3,
		colorAttachmentFormats: ["rgba32float", "rgba32float"],
		parameters: { cullMode: "none" },
	} as never);
	model.setBindings({ geoTex: geo, normalTex: normal, maskTex: mask });
	const reader = new TextureReader(device);
	const runs: Record<string, unknown> = {};
	let ok = true;
	for (const [name, over] of [
		["classic+ink+crease", { inkCrease: 1, refine: 0 }],
		["refined-skyline", { inkCrease: 0, refine: 1 }],
	] as const) {
		const P: RidgeUniforms = {
			...DEFAULT_RIDGES,
			outSize: [OW, OH],
			...over,
		};
		model.shaderInputs.setProps({ ridges: P } as never);
		const pass = device.beginRenderPass({
			id: "ridges-check-pass",
			framebuffer: fbo,
			clearColor: [0, 0, 0, 0],
		});
		model.draw(pass);
		pass.end();
		device.submit();
		const a = await reader.read(outs[0]);
		const b = await reader.read(outs[1]);
		if (!a || !b) {
			errors.push(`${name}: readback failed`);
			ok = false;
			continue;
		}
		const keys = [
			"ridge",
			"skyline",
			"range",
			"crease",
			"silIn",
			"silSky",
			"inkX",
			"inkY",
		] as const;
		const maxErr: Record<string, number> = {};
		const bad: Record<string, number> = {};
		const nonzero: Record<string, number> = {};
		for (const k of keys) {
			maxErr[k] = 0;
			bad[k] = 0;
			nonzero[k] = 0;
		}
		for (let y = 0; y < OH; y++)
			for (let x = 0; x < OW; x++) {
				const r = ridgesReference(scene, P, (x + 0.5) / OW, 1 - (y + 0.5) / OH);
				const i = (y * OW + x) * 4;
				const g = [
					a[i],
					a[i + 1],
					a[i + 2],
					a[i + 3],
					b[i],
					b[i + 1],
					b[i + 2],
					b[i + 3],
				];
				keys.forEach((k, j) => {
					const ref = r[k];
					const err =
						k === "range"
							? Math.abs(g[j] - ref) / Math.max(1, ref)
							: Math.abs(g[j] - ref);
					if (ref > 0.01) nonzero[k]++;
					maxErr[k] = Math.max(maxErr[k], err);
					if (err > (k === "range" ? 1e-5 : 0.02)) bad[k]++;
				});
			}
		// texel-boundary float differences may flip a handful of pixels; demand ≤ 0.2 %
		const limit = Math.ceil(OW * OH * 0.002);
		const pass_ = keys.every((k) => bad[k] <= limit);
		// the scene must actually exercise each feature
		const exercised =
			nonzero.ridge > 100 &&
			nonzero.skyline > 50 &&
			nonzero.inkY > 50 &&
			nonzero.inkX > 50 &&
			(name !== "classic+ink+crease" || nonzero.crease > 50);
		ok &&= pass_ && exercised;
		runs[name] = { pass: pass_, exercised, limit, bad, maxErr, nonzero };
	}
	const err = await gpu.popErrorScope();
	if (err) {
		errors.push(err.message);
		ok = false;
	}
	reader.destroy();
	model.destroy();
	fbo.destroy();
	for (const t of [geo, normal, mask, ...outs]) t.destroy();
	if (!opts.device) device.destroy();
	return { ok, errors, runs, size: { geo: [GW, GH], out: [OW, OH] } };
}

// ---- Node: assemble + reflect (no GPU) -------------------------------------------------------------

async function nodeCheck() {
	const { ShaderAssembler } = await import("@luma.gl/shadertools");
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
		source: CHECK_WGSL,
		modules: [ridgesModule],
		defines: {},
	});
	const layout = getShaderLayoutFromWGSL(r.source) as {
		bindings: { name: string; type: string }[];
	};
	const names = layout.bindings.map((b) => b.name);
	const want = ["ridges", "geoTex", "normalTex", "maskTex", "maskTexSampler"];
	const ok =
		want.every((n) => names.includes(n)) &&
		RIDGES_WGSL.includes("fn ridge_detect(") &&
		!RIDGES_WGSL.includes("@binding");
	console.log(JSON.stringify({ ok, bindings: layout.bindings }));
	if (!ok) process.exit(1);
}

if (typeof window === "undefined") await nodeCheck();
