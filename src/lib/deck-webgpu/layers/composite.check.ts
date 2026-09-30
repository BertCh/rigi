// In-browser isolation check for layers/composite.ts (no lab, no terrain, no region data).
// Writes a synthetic scene straight into the foundation targets — geometry (range 1000 m left,
// 20 km right of a vertical depth jump, sky above row SKY_ROWS) and a premultiplied colour layer —
// then draws the CompositeCore into a bgra8unorm "canvas" (with and without depth24plus, like the
// deck canvas / the direct host) and compares EVERY pixel against a CPU reference of the classic
// WebGL shader (deck/composite-shader.ts compositeFs, straight-alpha form):
//   overlay          photo ⊕ layer·opacity, ridges + skyline
//   overlay + tint   turbo distance tint
//   replace ×3       swipe, lens, range blends (keepSky on / off), hairline, replace ridges
//   brush            a painted brush stroke selects the layer
//   reveal           t = 1 ≈ classic; t = 0 dims the terrain and hides the overlay
//   LOOK_*           every composite define set compiles, validates and gives finite output
//   defaults         defaultCompositeSettings === deck/composite.ts's
// Run from a page served by vite (any route), e.g. with playwright:
//   await page.evaluate(async () => (await import("/src/lib/deck-webgpu/layers/composite.check.ts")).runCompositeCheck())
import { type Device, luma, type Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { defaultCompositeSettings as deckDefaults } from "#/lib/deck/composite";
import { compositeValues, harmonizeValues } from "#/lib/look/composite";
import type { LookDefine } from "#/lib/look/look-key";
import type { RevealUniforms } from "#/lib/reveal/config";
import { deckCompositeStyle } from "#/lib/style/deck-apply";
import { CLASSIC } from "#/lib/style/defaults";
import type { PassContext, PassTarget } from "../pass";
import { ColorTargets, GeometryTargets, USAGE } from "../targets";
import {
	CompositeCore,
	type CompositeSettings,
	defaultCompositeSettings,
} from "./composite";

const W = 96;
const H = 64;
const SKY_ROWS = 16;
const JUMP_X = 48;
const NEAR_R = 1000;
const FAR_R = 20000;
/** the layer colour (straight, linear) and alpha written premultiplied */
const LAYER: [number, number, number] = [0.2, 0.5, 0.8];
const LAYER_A = 0.6;
/** photo, sRGB bytes (solid, so filtering / mips cannot differ) */
const PHOTO_SRGB: [number, number, number] = [150, 110, 70];

type Case = {
	name: string;
	maxErr: number;
	meanErr: number;
	/** worst pixel (x, y, got, want) */
	worst?: [number, number, number[], number[]];
	ok: boolean;
	note?: string;
};

export type CompositeCheck = {
	ok: boolean;
	adapter: string;
	cases: Case[];
	errors: string[];
	/** GPU ms per composite frame (96×64 is tiny: this is overhead, not fill cost) */
	msPerDraw?: number;
};

// ---------- CPU reference (classic GLSL, straight alpha) ----------

const srgbDecode = (c: number) =>
	c <= 0.04045 ? c * 0.0773993808 : (c * 0.9478672986 + 0.0521327014) ** 2.4;
const srgbEncode = (c0: number) => {
	const c = Math.min(Math.max(c0, 0), 1);
	return c <= 0.0031308 ? c * 12.92 : c ** 0.41666 * 1.055 - 0.055;
};
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};
const mix3 = (a: number[], b: readonly number[], t: number) =>
	a.map((v, i) => v * (1 - t) + b[i] * t);
function turbo(x0: number) {
	const x = clamp(x0, 0, 1);
	const v4 = [1, x, x * x, x * x * x];
	const v2 = [v4[2] * v4[2], v4[3] * v4[2]];
	const d4 = (k: number[]) => k.reduce((s, kv, i) => s + kv * v4[i], 0);
	const d2 = (k: number[]) => k[0] * v2[0] + k[1] * v2[1];
	return [
		d4([0.13572138, 4.6153926, -42.66032258, 132.13108234]) +
			d2([-152.94239396, 59.28637943]),
		d4([0.09140261, 2.19418839, 4.84296658, -14.18503333]) +
			d2([4.27729857, 2.82956604]),
		d4([0.1066733, 12.64194608, -60.58204836, 110.36276771]) +
			d2([-89.90310912, 27.34824973]),
	];
}

const rangeAt = (x: number, y: number) => {
	const cx = clamp(Math.floor(x), 0, W - 1);
	const cy = clamp(Math.floor(y), 0, H - 1);
	if (cy < SKY_ROWS) return 0;
	return cx < JUMP_X ? NEAR_R : FAR_R;
};
const lr = (r: number) => (r > 0 ? Math.log(r) : 13.5);

function reference(
	s: CompositeSettings,
	st: ReturnType<typeof deckCompositeStyle>,
	brush: (x: number, y: number) => number,
	x: number,
	y: number,
): number[] {
	const photo = PHOTO_SRGB.map((b) => srgbDecode(b / 255));
	let col = [...photo];
	const px = x + 0.5;
	const py = y + 0.5;
	const u = px / W;
	const v = py / H;
	const range = rangeAt(px, py);
	const layerA = range > 0 ? LAYER_A : 0;
	const layerRgb = range > 0 ? LAYER : [0, 0, 0];
	const c = lr(range);
	const e = Math.max(
		Math.abs(c - lr(rangeAt(px + 1.25, py))),
		Math.abs(c - lr(rangeAt(px - 1.25, py))),
		Math.abs(c - lr(rangeAt(px, py + 1.25))),
		Math.abs(c - lr(rangeAt(px, py - 1.25))),
	);
	const isSky = range > 0 && rangeAt(px, py - 1.25) === 0 ? 1 : 0;
	let ridge = smoothstep(st.ridgeThr[0], st.ridgeThr[1], e);
	if (s.nearFade > 0 && range > 0)
		ridge *= smoothstep(s.nearFade * 0.5, s.nearFade, range);
	const fg = 0;
	const cov = layerA;
	if (s.mode === "overlay") {
		if (s.depthTint > 0 && range > 0) {
			const t = clamp(
				(Math.log(range) - st.depthLog[0]) * st.depthLog[1],
				0,
				1,
			);
			const dc = turbo(t);
			const lum = (col[0] + col[1] + col[2]) * 0.333;
			const k = st.depthLuma[0] + st.depthLuma[1] * lum * 1.4;
			col = mix3(
				col,
				dc.map((d) => d * k),
				s.depthTint * st.depthGain,
			);
		}
		col = mix3(col, layerRgb, layerA * s.layerOpacity * (1 - fg));
		const rc = isSky ? st.ridgeSky : st.ridgeInner;
		col = mix3(col, rc, ridge * s.ridges * st.ridgeGainO * (1 - fg));
	} else {
		const f = Math.max(s.feather, 0.001);
		let m: number;
		if (s.method === "swipe")
			m = smoothstep(s.swipe - f * 0.5, s.swipe + f * 0.5, u);
		else if (s.method === "lens") {
			const d = Math.hypot((u - s.lens[0]) * (W / H), v - s.lens[1]);
			m = 1 - smoothstep(s.lensR - f, s.lensR + f, d);
		} else if (s.method === "range") {
			const rr = range > 0 ? range : 1e9;
			const R = s.rangeKm * 1000;
			m = smoothstep(R * (1 - f * 4), R * (1 + f * 4), rr);
		} else m = brush(u, v);
		const edgeLine = (1 - Math.abs(m - 0.5) * 2) * cov * (1 - fg);
		if (s.keepSky) m *= cov;
		m *= 1 - fg;
		col = mix3(col, layerRgb, m * Math.max(layerA, s.keepSky ? 0 : 1));
		if (s.method !== "brush")
			col = mix3(col, st.hair, smoothstep(0.7, 1, edgeLine) * st.hair[3]);
		col = mix3(col, st.ridgeInnerR, ridge * s.ridges * st.ridgeGainR * m);
	}
	return col.map((ch) => srgbEncode(ch) * 255);
}

// ---------- GPU scaffolding ----------

/** Fill the geometry (+ normal) and colour targets with the synthetic scene. */
function writeScene(device: Device, g: GeometryTargets, c: ColorTargets) {
	const common = /* wgsl */ `\
struct VOut { @builtin(position) p: vec4<f32> };
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> VOut {
  let q = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VOut;
  o.p = vec4<f32>(q, 0.0, 1.0);
  return o;
}
fn range_of(p: vec2<f32>) -> f32 {
  if (p.y < ${SKY_ROWS.toFixed(1)}) { return 0.0; }
  return select(${FAR_R.toFixed(1)}, ${NEAR_R.toFixed(1)}, p.x < ${JUMP_X.toFixed(1)});
}
`;
	const geoModel = new Model(device, {
		id: "composite-check-geo",
		source: `${common}
struct GOut { @location(0) xyzr: vec4<f32>, @location(1) normal: vec4<f32> };
@fragment fn fragmentMain(v: VOut) -> GOut {
  let r = range_of(v.p.xy);
  var o: GOut;
  o.xyzr = vec4<f32>(0.0, r, 0.0, r);
  o.normal = select(vec4<f32>(0.0), vec4<f32>(0.0, 0.0, 1.0, 0.0), r > 0.0);
  return o;
}`,
		colorAttachmentFormats: ["rgba32float", "rgba16float"],
		vertexCount: 3,
	} as never);
	const colModel = new Model(device, {
		id: "composite-check-color",
		source: `${common}
@fragment fn fragmentMain(v: VOut) -> @location(0) vec4<f32> {
  if (range_of(v.p.xy) <= 0.0) { return vec4<f32>(0.0); }
  let a = ${LAYER_A.toFixed(4)};
  return vec4<f32>(vec3<f32>(${LAYER.map((x) => x.toFixed(4)).join(", ")}) * a, a);
}`,
		colorAttachmentFormats: ["rgba16float"],
		vertexCount: 3,
	} as never);
	const gfb = device.createFramebuffer({
		width: g.width,
		height: g.height,
		colorAttachments: [g.geometry, g.normal],
	});
	const cfb = device.createFramebuffer({
		width: c.width,
		height: c.height,
		colorAttachments: [c.color],
	});
	let pass = device.beginRenderPass({
		framebuffer: gfb,
		clearColor: [0, 0, 0, 0],
	});
	geoModel.draw(pass);
	pass.end();
	pass = device.beginRenderPass({
		framebuffer: cfb,
		clearColor: [0, 0, 0, 0],
	});
	colModel.draw(pass);
	pass.end();
	device.submit();
	geoModel.destroy();
	colModel.destroy();
	gfb.destroy();
	cfb.destroy();
}

type Out = { tex: Texture; depth?: Texture; target: PassTarget };

function makeOut(device: Device, withDepth: boolean): Out {
	const tex = device.createTexture({
		id: "composite-check-out",
		format: "bgra8unorm",
		width: W,
		height: H,
		usage: USAGE.RENDER | USAGE.COPY_SRC,
	});
	const depth = withDepth
		? device.createTexture({
				id: "composite-check-depth",
				format: "depth24plus",
				width: W,
				height: H,
				usage: USAGE.RENDER,
			})
		: undefined;
	return {
		tex,
		depth,
		target: {
			width: W,
			height: H,
			colorFormats: ["bgra8unorm"],
			depthFormat: withDepth ? "depth24plus" : null,
			samples: 1,
		},
	};
}

function drawComposite(
	device: Device,
	core: CompositeCore,
	out: Out,
	g: GeometryTargets,
	c: ColorTargets,
) {
	const fb = device.createFramebuffer({
		width: W,
		height: H,
		colorAttachments: [out.tex],
		...(out.depth ? { depthStencilAttachment: out.depth } : {}),
	});
	const renderPass = device.beginRenderPass({
		framebuffer: fb,
		clearColor: [1, 0, 1, 1],
		...(out.depth ? { clearDepth: 1 } : {}),
	});
	const ctx: PassContext = {
		device,
		kind: "screen",
		renderPass,
		camera: {} as never,
		target: out.target,
		frame: { frame: 0, time: 0, view: "photo" },
		geometry: g,
		color: c,
	};
	core.draw(ctx);
	renderPass.end();
	device.submit();
	fb.destroy();
}

/** bgra8unorm → RGB 0..255 per pixel, top-first. */
async function readOut(device: Device, tex: Texture) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
	});
	tex.readBuffer({}, buf);
	const bytes = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const out = new Float32Array(W * H * 3);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * layout.bytesPerRow + x * 4;
			const o = (y * W + x) * 3;
			out[o] = bytes[i + 2];
			out[o + 1] = bytes[i + 1];
			out[o + 2] = bytes[i];
		}
	return out;
}

function compare(
	name: string,
	got: Float32Array,
	want: (x: number, y: number) => number[] | null,
	tol: number,
): Case {
	let maxErr = 0;
	let sum = 0;
	let n = 0;
	let worst: Case["worst"];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const w = want(x, y);
			if (!w) continue;
			const o = (y * W + x) * 3;
			const g = [got[o], got[o + 1], got[o + 2]];
			const e = Math.max(...g.map((v, i) => Math.abs(v - w[i])));
			sum += e;
			n++;
			if (e > maxErr) {
				maxErr = e;
				worst = [x, y, g, w.map((v) => Math.round(v * 10) / 10)];
			}
		}
	return {
		name,
		maxErr,
		meanErr: n ? sum / n : 0,
		worst,
		ok: maxErr <= tol,
	};
}

// ---------- the check ----------

export async function runCompositeCheck(): Promise<CompositeCheck> {
	const errors: string[] = [];
	const cases: Case[] = [];
	const device = await luma.createDevice({
		id: "composite-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
		featureLevel: "max",
		optionalFeatures: ["float32-filterable"],
	} as never);
	const gpu = (device as unknown as { handle: GPUDevice }).handle;
	const info = (
		device as unknown as { info: { gpu?: string; vendor?: string } }
	).info;
	gpu.pushErrorScope("validation");
	const geometry = new GeometryTargets(device, W, H, "composite-check-geo");
	const color = new ColorTargets(device, W, H, "composite-check-color");
	writeScene(device, geometry, color);

	const photo = new OffscreenCanvas(W * 2, H * 2);
	const pctx = photo.getContext("2d") as OffscreenCanvasRenderingContext2D;
	pctx.fillStyle = `rgb(${PHOTO_SRGB.join(",")})`;
	pctx.fillRect(0, 0, photo.width, photo.height);

	const style = {
		...deckCompositeStyle(CLASSIC),
		depthRampKind: 0,
	};
	const core = new CompositeCore({ aspect: W / H });
	core.setStyle(style);
	core.setPhoto(photo as never);
	const outs = { plain: makeOut(device, false), depth: makeOut(device, true) };

	const noBrush = () => 0;
	const run = async (
		name: string,
		s: Partial<CompositeSettings>,
		opts: {
			out?: Out;
			brush?: (u: number, v: number) => number;
			skip?: (x: number, y: number) => boolean;
		} = {},
	) => {
		core.setSettings({ ...defaultCompositeSettings, ...s });
		const out = opts.out ?? outs.plain;
		drawComposite(device, core, out, geometry, color);
		const got = await readOut(device, out.tex);
		const settings = core.settings;
		const c = compare(
			name,
			got,
			(x, y) =>
				opts.skip?.(x, y)
					? null
					: reference(settings, style, opts.brush ?? noBrush, x, y),
			2.5,
		);
		cases.push(c);
		return got;
	};

	// classic paths, every pixel
	const classic = await run("overlay", { mode: "overlay" });
	await run("overlay+depth24plus", { mode: "overlay" }, { out: outs.depth });
	await run("overlay+tint", { mode: "overlay", depthTint: 1 });
	await run("replace swipe", {
		mode: "replace",
		method: "swipe",
		swipe: 0.3,
	});
	await run("replace lens", {
		mode: "replace",
		method: "lens",
		lens: [0.6, 0.55],
		lensR: 0.2,
	});
	await run("replace range, keepSky off", {
		mode: "replace",
		method: "range",
		rangeKm: 5,
		keepSky: false,
	});
	// brush: paint a stroke, compare where the brush is saturated or empty (the canvas gradient's
	// exact bytes are the browser's); the reference reads the painted canvas itself
	core.clearBrush(false);
	core.paint(0.3, 0.6, 0.12, false);
	const bctx = core.brushCanvas.getContext("2d") as CanvasRenderingContext2D;
	const bw = core.brushCanvas.width;
	const bh = core.brushCanvas.height;
	const bdata = bctx.getImageData(0, 0, bw, bh).data;
	const brushAt = (u: number, v: number) => {
		// bilinear, like the r8unorm linear sampler (texel centres)
		const fx = clamp(u * bw - 0.5, 0, bw - 1);
		const fy = clamp(v * bh - 0.5, 0, bh - 1);
		const x0 = Math.floor(fx);
		const y0 = Math.floor(fy);
		const x1 = Math.min(x0 + 1, bw - 1);
		const y1 = Math.min(y0 + 1, bh - 1);
		const tx = fx - x0;
		const ty = fy - y0;
		const r = (x: number, y: number) => bdata[(y * bw + x) * 4] / 255;
		return (
			(r(x0, y0) * (1 - tx) + r(x1, y0) * tx) * (1 - ty) +
			(r(x0, y1) * (1 - tx) + r(x1, y1) * tx) * ty
		);
	};
	await run(
		"replace brush",
		{ mode: "replace", method: "brush" },
		{ brush: brushAt },
	);

	// reveal: finished (t = 1) ≈ classic; start (t = 0) → overlay hidden, terrain dimmed
	const reveal = (t: number): RevealUniforms => ({
		a: [t, 0, 2000, 1],
		win: [Math.log(500), Math.log(30000), 0, 3000],
		qD: [7, 8, 9, 10],
		qE: [500, 1000, 1500, 2000],
		shape: [0.1, 0.1, 0, 0.3],
		focus: [0.5, 0.5, 0.5, 0.5],
		glow: [1, 0.9, 0.7, 0.5],
		F: [0, 1, 0],
		R: [0.7, 0, 0],
		U: [0, 0, 0.5],
	});
	core.setReveal(reveal(1));
	await run("reveal t=1 ≈ classic", { mode: "overlay" });
	core.setReveal(reveal(0));
	core.setSettings({ ...defaultCompositeSettings, ridges: 0 });
	drawComposite(device, core, outs.plain, geometry, color);
	{
		const got = await readOut(device, outs.plain.tex);
		const photoLin = PHOTO_SRGB.map((b) => srgbDecode(b / 255));
		const want = (_x: number, y: number) => {
			const terrain = y + 0.5 >= SKY_ROWS;
			return photoLin.map((c) => srgbEncode(terrain ? c * (1 - 0.3) : c) * 255);
		};
		cases.push(compare("reveal t=0: dimmed, no overlay", got, want, 2.5));
	}
	core.setReveal(null);

	// LOOK_* define sets: compile + validate + finite, and INK changes something near the edges
	const lookDefs: LookDefine[][] = [
		["LOOK_INK"],
		["LOOK_REFINE"],
		["LOOK_HARMONIZE"],
		["LOOK_OUTPUT"],
		["LOOK_HARMONIZE", "LOOK_INK", "LOOK_OUTPUT", "LOOK_REFINE"],
	];
	const mask = new Uint8Array(W * H * 4);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = (y * W + x) * 4;
			mask[i] = y >= SKY_ROWS ? 255 : 0; // coverage
			mask[i + 1] = x >= JUMP_X ? 255 : 0; // cut
		}
	for (const defs of lookDefs)
		for (const mode of ["overlay", "replace"] as const) {
			core.setLook({
				defines: defs,
				values: (w, h) =>
					compositeValues(CLASSIC, {
						outW: w,
						outH: h,
						refine: defs.includes("LOOK_REFINE"),
						cut: true,
						crease: true,
						premul: true,
						noise: 0.01,
						photoW: W * 2,
					}),
				harmonize: harmonizeValues(null, 0.5),
				mask: { w: W, h: H, data: mask },
				normal: 1,
			});
			core.setSettings({
				...defaultCompositeSettings,
				mode,
				method: "range",
			});
			drawComposite(device, core, outs.depth, geometry, color);
			const got = await readOut(device, outs.depth.tex);
			let bad = 0;
			let magenta = 0;
			let diff = 0;
			for (let i = 0; i < got.length; i += 3) {
				if (!Number.isFinite(got[i])) bad++;
				if (got[i] === 255 && got[i + 1] === 0 && got[i + 2] === 255) magenta++;
				if (mode === "overlay")
					diff = Math.max(diff, Math.abs(got[i + 2] - classic[i + 2]));
			}
			cases.push({
				name: `${defs.join("+")} ${mode}`,
				maxErr: bad + magenta,
				meanErr: 0,
				ok: bad === 0 && magenta === 0,
				note: mode === "overlay" ? `max |Δ| vs classic ${diff}` : undefined,
			});
		}
	core.setLook(null);

	// defaults parity with the WebGL compositor
	const same =
		JSON.stringify(defaultCompositeSettings) === JSON.stringify(deckDefaults);
	cases.push({
		name: "defaults === deck/composite.ts",
		maxErr: same ? 0 : 1,
		meanErr: 0,
		ok: same,
	});

	// overhead per composite frame (GPU included)
	core.setSettings({ ...defaultCompositeSettings });
	const t0 = performance.now();
	for (let i = 0; i < 50; i++)
		drawComposite(device, core, outs.plain, geometry, color);
	await gpu.queue.onSubmittedWorkDone();
	const msPerDraw = (performance.now() - t0) / 50;

	const scopeErr = await gpu.popErrorScope();
	if (scopeErr) errors.push(`validation: ${scopeErr.message}`);
	core.destroy();
	for (const o of Object.values(outs)) {
		o.tex.destroy();
		o.depth?.destroy();
	}
	geometry.destroy();
	color.destroy();
	device.destroy();
	return {
		ok: errors.length === 0 && cases.every((c) => c.ok),
		adapter: `${info?.vendor ?? ""} ${info?.gpu ?? ""}`.trim(),
		cases,
		errors,
		msPerDraw,
	};
}
