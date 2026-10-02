// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tiny WebGL2 renderer for the panorama strip: one textured mesh per photo on the (az, el)
// canvas, drawn in the given order with a feathered edge so overlaps blend.
//
// On luma.gl: a WebGLDevice on the strip's own canvas (its public constructor, which is what
// webgl2Adapter.create runs after its async debug-tool load; constructed synchronously so PanoGL
// keeps its sync constructor), one Model per photo (the pipeline is shared through luma's pipeline
// cache), luma Buffers / Textures. The GLSL is the former program verbatim except that its uniforms
// are two std140 blocks, one per stage (luma 10 feeds GLSL uniforms through blocks only; a block per
// stage keeps the fragment uniforms at the fragment shader's mediump default). The canvas keeps one
// device while it is in the DOM (a canvas has one WebGL context), so a re-effected strip (React
// strict mode) reuses it; dispose() releases the device (and loses the context) once the canvas is
// detached, since an unmounted landing embed must free its GPU context rather than wait for GC.
import {
	Buffer,
	type Device,
	type RenderPipelineParameters,
	Texture,
} from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { WebGLDevice } from "@luma.gl/webgl";
import type { PanoMesh } from "./panorama";
import { wrapOffsets } from "./panorama";

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
layout(std140) uniform panoVsUniforms {
  vec2 u_size;
  float u_az0;
  float u_elc;
  float u_ppd;
  float u_off;
};
out vec2 v_uv;
void main() {
  float x = (a_pos.x + u_off - u_az0) * u_ppd;
  float y = (a_pos.y - u_elc) * u_ppd;
  gl_Position = vec4(x / u_size.x * 2.0 - 1.0, y / u_size.y * 2.0, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
layout(std140) uniform panoFsUniforms {
  float u_feather;
  float u_alpha;
};
out vec4 o;
void main() {
  vec2 e = min(v_uv, 1.0 - v_uv);
  float a = smoothstep(0.0, u_feather, e.x) * smoothstep(0.0, u_feather * 1.33, e.y);
  o = vec4(texture(u_tex, v_uv).rgb, a * u_alpha);
}`;

const panoVs = {
	name: "panoVs",
	uniformTypes: {
		u_size: "vec2<f32>",
		u_az0: "f32",
		u_elc: "f32",
		u_ppd: "f32",
		u_off: "f32",
	},
} as const;

const panoFs = {
	name: "panoFs",
	uniformTypes: { u_feather: "f32", u_alpha: "f32" },
} as const;

/** premultiplied output (the canvas default), so feathered edges composite over the terrain */
const BLEND: RenderPipelineParameters = {
	blend: true,
	blendColorOperation: "add",
	blendColorSrcFactor: "src-alpha",
	blendColorDstFactor: "one-minus-src-alpha",
	blendAlphaOperation: "add",
	blendAlphaSrcFactor: "one",
	blendAlphaDstFactor: "one-minus-src-alpha",
};

/** Trilinear, clamped (the former texParameteri set). */
const SAMPLER = {
	minFilter: "linear",
	magFilter: "linear",
	mipmapFilter: "linear",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

/** Largest texture edge; bigger uploads are downscaled on decode. */
const MAX_TEX = 2048;

/** Frames a draw is retried while luma still links the program (parallel shader compile). */
const MAX_LINK_RETRIES = 120;

type Item = {
	mesh: PanoMesh;
	model: Model;
	bufs: Buffer[];
	tex: Texture | null;
	src: string;
};

export type PanoView = {
	az0: number;
	elc: number;
	ppd: number;
	w: number;
	h: number;
	dpr: number;
};
export type PanoDraw = { id: string; alpha?: number; feather?: number };

/** One luma device per strip canvas, for the canvas's life (its one WebGL context). */
const devices = new WeakMap<HTMLCanvasElement, Device>();

function deviceFor(canvas: HTMLCanvasElement): Device {
	let device = devices.get(canvas);
	if (!device) {
		// transparent: the viewpoint's terrain (a 2D canvas underneath) shows between and through the photos
		device = new WebGLDevice({
			id: "roll-panorama",
			createCanvasContext: {
				canvas,
				// the strip sizes its canvas itself (PanoramaStrip)
				autoResize: false,
				alphaMode: "premultiplied",
			},
			webgl: { antialias: true, alpha: true, preserveDrawingBuffer: false },
		});
		devices.set(canvas, device);
	}
	return device;
}

/** Destroy the canvas's device and lose its WebGL context now (a detached canvas is never reused). */
export function releaseDevice(canvas: HTMLCanvasElement) {
	const device = devices.get(canvas);
	if (!device) return;
	devices.delete(canvas);
	(device as WebGLDevice).loseDevice();
	device.destroy();
}

export class PanoGL {
	private device: Device;
	private items = new Map<string, Item>();
	private alive = true;
	private linkRetries = 0;

	constructor(
		private canvas: HTMLCanvasElement,
		private onLoad: () => void,
	) {
		this.device = deviceFor(this.canvas);
	}

	/** Register (or update) a photo; starts loading its texture once. */
	set(id: string, src: string, mesh: PanoMesh) {
		let it = this.items.get(id);
		if (it && it.mesh === mesh) return;
		if (it) {
			it.model.destroy();
			for (const b of it.bufs) b.destroy();
		}
		const d = this.device;
		const bp = d.createBuffer({ id: `pano-pos-${id}`, data: mesh.pos });
		const bu = d.createBuffer({ id: `pano-uv-${id}`, data: mesh.uv });
		const bi = d.createBuffer({
			id: `pano-idx-${id}`,
			usage: Buffer.INDEX,
			indexType: "uint16",
			data: mesh.idx,
		});
		const model = new Model(d, {
			id: `pano-${id}`,
			vs: VS,
			fs: FS,
			modules: [panoVs, panoFs],
			topology: "triangle-list",
			bufferLayout: [
				{ name: "a_pos", format: "float32x2" },
				{ name: "a_uv", format: "float32x2" },
			],
			attributes: { a_pos: bp, a_uv: bu },
			indexBuffer: bi,
			vertexCount: mesh.idx.length,
			parameters: BLEND,
		});
		const keepTex = it && it.src === src ? it.tex : null;
		if (it?.tex && !keepTex) it.tex.destroy();
		if (keepTex) model.setBindings({ u_tex: keepTex });
		it = { mesh, model, bufs: [bp, bu, bi], tex: keepTex, src };
		this.items.set(id, it);
		if (!keepTex) this.load(id, src);
	}

	has(id: string) {
		return !!this.items.get(id)?.tex;
	}

	private async load(id: string, src: string) {
		try {
			const img = new Image();
			img.decoding = "async";
			img.src = src;
			await img.decode();
			const s = Math.min(
				1,
				MAX_TEX / Math.max(img.naturalWidth, img.naturalHeight),
			);
			const bmp: HTMLImageElement | ImageBitmap =
				s < 1
					? await createImageBitmap(img, {
							resizeWidth: Math.round(img.naturalWidth * s),
							resizeHeight: Math.round(img.naturalHeight * s),
							resizeQuality: "high",
						})
					: img;
			const it = this.items.get(id);
			if (!this.alive || !it || it.src !== src) {
				if (bmp instanceof ImageBitmap) bmp.close();
				return;
			}
			const d = this.device;
			const { width, height } = d.getExternalImageSize(bmp);
			const tex = d.createTexture({
				id: `pano-tex-${id}`,
				format: "rgba8unorm",
				width,
				height,
				mipLevels: d.getMipLevelCount(width, height),
				usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER,
				sampler: SAMPLER,
			});
			tex.copyExternalImage({ image: bmp });
			if (bmp instanceof ImageBitmap) bmp.close(); // uploaded: the bitmap is no longer needed
			tex.generateMipmapsWebGL();
			it.tex = tex;
			it.model.setBindings({ u_tex: tex });
			this.onLoad();
		} catch (e) {
			console.warn("[roll/panorama] texture failed", id, e);
		}
	}

	/** Draw photos in order (later on top). Canvas size must already match view.w/h × dpr. */
	draw(list: PanoDraw[], v: PanoView) {
		const W = Math.round(v.w * v.dpr);
		const H = Math.round(v.h * v.dpr);
		const pass = this.device.beginRenderPass({
			id: "roll-panorama",
			clearColor: [0, 0, 0, 0],
			clearDepth: false,
			clearStencil: false,
			parameters: { viewport: [0, 0, W, H, 0, 1] },
		});
		const a1 = v.az0 + v.w / v.ppd;
		let skipped = false;
		try {
			for (const d of list) {
				const it = this.items.get(d.id);
				if (!it?.tex) continue;
				const fs = { u_feather: d.feather ?? 0.03, u_alpha: d.alpha ?? 1 };
				for (const off of wrapOffsets(
					it.mesh.azMin,
					it.mesh.azMax,
					v.az0,
					a1,
				)) {
					it.model.shaderInputs.setProps({
						panoVs: {
							u_size: [W, H],
							u_az0: v.az0,
							u_elc: v.elc,
							u_ppd: v.ppd * v.dpr,
							u_off: off,
						},
						panoFs: fs,
					});
					if (!it.model.draw(pass)) skipped = true;
				}
			}
		} finally {
			pass.end();
			this.device.submit();
		}
		// a draw is skipped while luma links the program asynchronously: draw again next frame
		if (skipped && this.linkRetries++ < MAX_LINK_RETRIES) this.onLoad();
		else if (!skipped) this.linkRetries = 0;
	}

	/** Forget photos not in keep. */
	prune(keep: ReadonlySet<string>) {
		for (const id of [...this.items.keys()]) if (!keep.has(id)) this.drop(id);
	}

	private drop(id: string) {
		const it = this.items.get(id);
		if (!it) return;
		it.model.destroy();
		for (const b of it.bufs) b.destroy();
		it.tex?.destroy();
		this.items.delete(id);
	}

	/**
	 * Frees every photo's GPU resources, then the device itself once the canvas has left the DOM
	 * (checked a task later: an effect re-run on the same, still attached canvas keeps its device).
	 */
	dispose() {
		this.alive = false;
		for (const id of [...this.items.keys()]) this.drop(id);
		const canvas = this.canvas;
		setTimeout(() => {
			if (!canvas.isConnected) releaseDevice(canvas);
		}, 0);
	}
}
