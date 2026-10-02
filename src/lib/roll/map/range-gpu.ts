// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU twin of the roll drape's range-map hand-off (drape-atlas.ts setRange): the geometry pass's
// range target goes straight into its range-atlas cell on the GPU, and only the COARSE² max-pooled
// grid the CPU cull needs (1/64 of the texels) is read back. Replaces, per photo, a full readback,
// the row flip + sky fix-up (GpuGeometrySource.unpack, rangeMapFrom), a re-upload (writeData) and
// the CPU max-pool (coarsen).
//
// Two luma Models of their own (no shared deck/luma shader is touched: editing one
// re-optimised the geometry pass and moved its range bits, bb3f4b7). The GLSL is the former
// programs verbatim except that the three plain uniforms (u_h, u_origin, u_size) are one std140
// block (luma 10 has no plain-uniform path; same values, same math). Both address texels with
// texelFetch at integer coordinates, so the row flip is exact (normalised-uv nearest sampling is
// not: hardware rounds the coordinate in fixed point near texel edges), and both apply
// rangeMapFrom∘unpack's fix-up bit-exactly with integer ops (fast-math can't fold them): a texel
// is kept when 0 < r < +Inf, else written as +0 (sky, negative, -0, ±Inf, NaN all → 0).
//
// Lifetime: the Models belong to one RangeGpu (one device); a coarse request owns its small
// target + readback buffer until it lands; nothing here holds the geometry target or the atlas
// texture beyond one synchronous call (a Framebuffer over the atlas lives for one draw).
// The programs link asynchronously where the driver allows: `ok` is false until they have, and
// `whenReady()` resolves then (callers take the CPU path meanwhile).
import type { Buffer, Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import {
	glFence,
	readbackBuffer,
	readbackQuiet,
} from "#/lib/deck/geometry-pass";
import { glOf } from "#/lib/deck/gl";
import type { RangeHandOff } from "./backend";
import { COARSE, type CoarseRange } from "./drape-atlas";

const VS = `#version 300 es
void main() {
	// one triangle covering the viewport (attributeless)
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** The geometry target's texel for range-map texel (x, y) (row 0 = top), fixed up as rangeMapFrom. */
const FETCH = `
uniform highp sampler2D u_src;
layout(std140) uniform rangeUniforms {
	int u_h;
	ivec2 u_origin; // copy: the cell's first texel
	ivec2 u_size;   // pool: the range map's size
};
float rangeAt(ivec2 p) {
	// the target is GL order (row 0 = bottom): rangeMapFrom's row y is the target's row h-1-y
	uint b = floatBitsToUint(texelFetch(u_src, ivec2(p.x, u_h - 1 - p.y), 0).r);
	// 0 < r < +Inf ⇔ sign bit clear, not +0, below +Inf's bits (NaNs sit above): else +0
	return uintBitsToFloat(b > 0u && b < 0x7f800000u ? b : 0u);
}`;

/** Copy: the fragment at cell texel (x, y) (viewport = the cell) gets rangeAt(x, y). */
const FS_COPY = `#version 300 es
precision highp float;
precision highp int;
${FETCH}
out vec4 o;
void main() {
	o = vec4(rangeAt(ivec2(gl_FragCoord.xy) - u_origin), 0.0, 0.0, 1.0);
}`;

/** Max-pool: the fragment at coarse texel (cx, cy) gets the max over its COARSE² block (from 0). */
const FS_POOL = `#version 300 es
precision highp float;
precision highp int;
${FETCH}
out vec4 o;
void main() {
	ivec2 b0 = ivec2(gl_FragCoord.xy) * ${COARSE};
	ivec2 b1 = min(b0 + ${COARSE}, u_size);
	float m = 0.0;
	for (int y = b0.y; y < b1.y; y++)
		for (int x = b0.x; x < b1.x; x++) {
			float v = rangeAt(ivec2(x, y));
			if (v > m) m = v;
		}
	o = vec4(m, 0.0, 0.0, 1.0);
}`;

const rangeModule = {
	name: "range",
	uniformTypes: {
		u_h: "i32",
		u_origin: "vec2<i32>",
		u_size: "vec2<i32>",
	},
} as const;

const NEAREST = {
	minFilter: "nearest",
	magFilter: "nearest",
	mipmapFilter: "none",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

/** A landed coarse request: the grid, plus its cost (EVIDENCE accounting). */
export type CoarseResult = {
	grid: CoarseRange;
	/** Main-thread ms: max-pool draw + readPixels issue, and the copy-out once it landed. */
	mainMs: number;
	/** Bytes read back (RED or RGBA floats). */
	bytes: number;
};

export class RangeGpu implements RangeHandOff {
	private copy: Model | null = null;
	private pool: Model | null = null;
	private building: Promise<void> | null = null;
	/** Programs failed to build: every call says no (callers take the CPU path). */
	private broken = false;
	private destroyed = false;

	constructor(readonly device: Device) {}

	/** Usable now (a WebGL device that isn't lost, programs built); starts the build on first call. */
	get ok() {
		if (this.broken || this.destroyed || this.device.type !== "webgl")
			return false;
		if (this.device.isLost) return false;
		this.build();
		return !!this.copy && !!this.pool;
	}

	/** Resolves once the programs have linked (or failed: `ok` then stays false). */
	async whenReady(): Promise<void> {
		if (this.broken || this.destroyed || this.device.type !== "webgl") return;
		await this.build();
	}

	private build(): Promise<void> {
		this.building ??= (async () => {
			const make = (id: string, fs: string) =>
				Model.createAsync(this.device, {
					id,
					vs: VS,
					fs,
					modules: [rangeModule],
					bufferLayout: [],
					topology: "triangle-list",
					vertexCount: 3,
				});
			try {
				const [copy, pool] = await Promise.all([
					make("range-copy", FS_COPY),
					make("range-pool", FS_POOL),
				]);
				if (this.destroyed) {
					copy.destroy();
					pool.destroy();
					return;
				}
				this.copy = copy;
				this.pool = pool;
			} catch (e) {
				console.warn("[range-gpu]", e);
				this.broken = true;
			}
		})();
		return this.building;
	}

	/**
	 * One fullscreen-triangle draw of `model` reading `src` into `dst` over the viewport rect.
	 * The Framebuffer over `dst` is destroyed again before returning (the atlas is sampled next
	 * and its owner may destroy it any time); no clear.
	 */
	private draw(
		model: Model,
		src: Texture,
		srcH: number,
		dst: Texture,
		vp: [number, number, number, number],
		extra: { u_origin?: [number, number]; u_size?: [number, number] },
	) {
		const fbo = this.device.createFramebuffer({
			id: "range-gpu-fbo",
			width: dst.width,
			height: dst.height,
			colorAttachments: [dst],
		});
		const pass = this.device.beginRenderPass({
			id: model.id,
			framebuffer: fbo,
			clearColor: false,
			clearDepth: false,
			parameters: { viewport: [...vp, 0, 1] },
		});
		try {
			model.shaderInputs.setProps({
				range: { u_h: srcH, u_origin: [0, 0], u_size: [0, 0], ...extra },
			});
			// texelFetch ignores filtering, but an r32float texture whose sampler asks for linear is
			// incomplete (not filterable) and would fetch 0: the geometry target's sampler is nearest
			model.setBindings({ u_src: src });
			model.draw(pass);
		} finally {
			pass.end();
			fbo.destroy();
		}
	}

	/**
	 * rangeMapFrom(src) written into `atlas` at cell (x, y) (top-left texels; texture row = data
	 * row, as writeData puts it): `src` is the geometry target's r32float texture (GL order),
	 * w × h. false = nothing written (not usable now).
	 */
	copyInto(
		atlas: Texture,
		[x, y]: readonly number[],
		src: Texture,
		w: number,
		h: number,
	): boolean {
		if (!this.ok || !this.copy) return false;
		this.draw(this.copy, src, h, atlas, [x, y, w, h], { u_origin: [x, y] });
		return true;
	}

	/**
	 * coarsen(rangeMapFrom(src).data, w, h) computed on the GPU and read back asynchronously
	 * (buffer + fence; only ⌈w/COARSE⌉ × ⌈h/COARSE⌉ texels cross). Issue it right after the draw
	 * into `src`: the texels are taken when the GPU runs it. null = not usable / context lost /
	 * `cancelled()` (callers take the CPU path). The grid is read as RGBA/FLOAT (always allowed
	 * for readPixels; the former RED/FLOAT probe is gone), so `bytes` is 4× the old RED figure.
	 */
	async coarse(
		src: Texture,
		w: number,
		h: number,
		cancelled: () => boolean = () => false,
	): Promise<CoarseResult | null> {
		if (!this.ok || !this.pool) return null;
		const t0 = performance.now();
		const cw = Math.ceil(w / COARSE);
		const ch = Math.ceil(h / COARSE);
		const bytes = cw * ch * 16;
		let tex: Texture | null = null;
		let buf: Buffer | null = null;
		try {
			tex = this.device.createTexture({
				id: "range-coarse",
				format: "rgba32float",
				width: cw,
				height: ch,
				sampler: NEAREST,
			});
			buf = readbackBuffer(this.device, bytes, "range-coarse-readback");
			this.draw(this.pool, src, h, tex, [0, 0, cw, ch], { u_size: [w, h] });
			// read it into the buffer now; copy it out once a fence behind it signalled
			tex.readBuffer({ width: cw, height: ch }, buf);
			const poolMs = performance.now() - t0;
			const stop = () => this.destroyed || cancelled();
			const gl = glOf(this.device);
			const fence = await glFence(gl, stop);
			const quiet = fence.ok
				? await readbackQuiet(gl, fence.ms, stop)
				: { ok: false };
			if (!quiet.ok || stop() || this.device.isLost) return null;
			const t1 = performance.now();
			const raw = await buf.readAsync(0, bytes);
			const rgba = new Float32Array(raw.buffer, raw.byteOffset, cw * ch * 4);
			const data = new Float32Array(cw * ch);
			for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
			// framebuffer row 0 = texture row 0 = coarse row 0 (top): no flip
			return {
				grid: { width: cw, height: ch, data },
				mainMs: poolMs + performance.now() - t1,
				bytes,
			};
		} finally {
			buf?.destroy();
			tex?.destroy();
		}
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		this.copy?.destroy();
		this.pool?.destroy();
		this.copy = null;
		this.pool = null;
	}
}
