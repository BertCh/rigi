// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU twin of the roll drape's range-map hand-off (drape-atlas.ts setRange): the geometry pass's
// range target goes straight into its range-atlas cell on the GPU, and only the COARSE² max-pooled
// grid the CPU cull needs (1/64 of the texels) is read back. Replaces, per photo, a full readback,
// the row flip + sky fix-up (GpuGeometrySource.unpack, rangeMapFrom), a re-upload (writeData) and
// the CPU max-pool (coarsen).
//
// Two raw WebGL2 programs of their own (no shared deck/luma shader is touched: editing one
// re-optimised the geometry pass and moved its range bits, bb3f4b7). Both address texels with
// texelFetch at integer coordinates, so the row flip is exact (normalised-uv nearest sampling is
// not: hardware rounds the coordinate in fixed point near texel edges), and both apply
// rangeMapFrom∘unpack's fix-up bit-exactly with integer ops (fast-math can't fold them): a texel
// is kept when 0 < r < +Inf, else written as +0 (sky, negative, -0, ±Inf, NaN all → 0).
//
// Lifetime: every GL object here belongs to one RangeGpu (one device); a coarse request owns its
// small target + pack buffer until it lands; nothing here holds the geometry target or the atlas
// texture beyond one synchronous call (they are attached, drawn, detached).
import type { Device, Texture } from "@luma.gl/core";
import { glFence, readbackQuiet } from "#/lib/deck/geometry-pass";
import { glOf } from "#/lib/deck/gl";
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
uniform int u_h;
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
uniform ivec2 u_origin;
out vec4 o;
void main() {
	o = vec4(rangeAt(ivec2(gl_FragCoord.xy) - u_origin), 0.0, 0.0, 1.0);
}`;

/** Max-pool: the fragment at coarse texel (cx, cy) gets the max over its COARSE² block (from 0). */
const FS_POOL = `#version 300 es
precision highp float;
precision highp int;
${FETCH}
uniform ivec2 u_size;
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

type Prog = {
	prog: WebGLProgram;
	src: WebGLUniformLocation | null;
	h: WebGLUniformLocation | null;
	extra: WebGLUniformLocation | null;
};

const handleOf = (t: Texture) =>
	(t as unknown as { handle: WebGLTexture }).handle;

/** A landed coarse request: the grid, plus its cost (EVIDENCE accounting). */
export type CoarseResult = {
	grid: CoarseRange;
	/** Main-thread ms: max-pool draw + readPixels issue, and the copy-out once it landed. */
	mainMs: number;
	/** Bytes read back (RED or RGBA floats). */
	bytes: number;
};

export class RangeGpu {
	private gl: WebGL2RenderingContext;
	private copy: Prog | null = null;
	private pool: Prog | null = null;
	private vao: WebGLVertexArrayObject | null = null;
	private sampler: WebGLSampler | null = null;
	private fbo: WebGLFramebuffer | null = null;
	/** Programs failed to build: every call says no (callers take the CPU path). */
	private broken = false;
	private destroyed = false;

	constructor(readonly device: Device) {
		this.gl = glOf(device);
	}

	/** Usable now (a WebGL device that isn't lost, programs built). */
	get ok() {
		if (this.broken || this.destroyed || this.device.type !== "webgl")
			return false;
		if (this.gl.isContextLost()) return false;
		if (!this.copy) this.build();
		// objects of a context that was lost and restored are dead: stay on the CPU path
		else if (!this.gl.isProgram(this.copy.prog)) this.broken = true;
		return !this.broken;
	}

	private build() {
		const gl = this.gl;
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type);
			if (!s) return null;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
				console.warn("[range-gpu]", gl.getShaderInfoLog(s));
				gl.deleteShader(s);
				return null;
			}
			return s;
		};
		const link = (fs: string, extra: string): Prog | null => {
			const v = compile(gl.VERTEX_SHADER, VS);
			const f = compile(gl.FRAGMENT_SHADER, fs);
			const prog = v && f ? gl.createProgram() : null;
			if (prog && v && f) {
				gl.attachShader(prog, v);
				gl.attachShader(prog, f);
				gl.linkProgram(prog);
			}
			if (v) gl.deleteShader(v);
			if (f) gl.deleteShader(f);
			if (!prog || !gl.getProgramParameter(prog, gl.LINK_STATUS)) {
				if (prog) {
					console.warn("[range-gpu]", gl.getProgramInfoLog(prog));
					gl.deleteProgram(prog);
				}
				return null;
			}
			return {
				prog,
				src: gl.getUniformLocation(prog, "u_src"),
				h: gl.getUniformLocation(prog, "u_h"),
				extra: gl.getUniformLocation(prog, extra),
			};
		};
		this.copy = link(FS_COPY, "u_origin");
		this.pool = link(FS_POOL, "u_size");
		this.vao = gl.createVertexArray();
		this.sampler = gl.createSampler();
		this.fbo = gl.createFramebuffer();
		if (!this.copy || !this.pool || !this.vao || !this.sampler || !this.fbo) {
			this.broken = true;
			return;
		}
		// texelFetch ignores filtering, but an r32float texture whose bound sampler asks for linear
		// is incomplete (not filterable) and would fetch 0: sample through a nearest sampler
		gl.samplerParameteri(this.sampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.samplerParameteri(this.sampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	}

	/**
	 * One fullscreen-triangle draw of `p` reading `src` into `dst` (an r32float texture) over the
	 * viewport rect, with every piece of GL state it touches restored afterwards (luma's state
	 * cache sees the same calls). The texture is detached again before returning.
	 */
	private draw(
		p: Prog,
		src: Texture,
		srcH: number,
		dst: WebGLTexture,
		vp: [number, number, number, number],
		setExtra: (loc: WebGLUniformLocation | null) => void,
	) {
		const gl = this.gl;
		const prev = {
			prog: gl.getParameter(gl.CURRENT_PROGRAM),
			vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
			draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
			unit: gl.getParameter(gl.ACTIVE_TEXTURE),
			viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
			mask: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
		};
		const caps = [
			gl.SCISSOR_TEST,
			gl.BLEND,
			gl.DEPTH_TEST,
			gl.STENCIL_TEST,
			gl.CULL_FACE,
			gl.RASTERIZER_DISCARD,
			gl.SAMPLE_ALPHA_TO_COVERAGE,
			gl.SAMPLE_COVERAGE,
			gl.POLYGON_OFFSET_FILL,
		].filter((c) => gl.isEnabled(c));
		for (const c of caps) gl.disable(c);
		gl.activeTexture(gl.TEXTURE0);
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
		const prevSampler = gl.getParameter(gl.SAMPLER_BINDING);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
		gl.framebufferTexture2D(
			gl.DRAW_FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			dst,
			0,
		);
		gl.viewport(vp[0], vp[1], vp[2], vp[3]);
		gl.colorMask(true, true, true, true);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(p.prog);
		gl.bindVertexArray(this.vao);
		gl.bindTexture(gl.TEXTURE_2D, handleOf(src));
		gl.bindSampler(0, this.sampler);
		gl.uniform1i(p.src, 0);
		gl.uniform1i(p.h, srcH);
		setExtra(p.extra);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		// detach: the atlas is sampled next and its owner may destroy it any time
		gl.framebufferTexture2D(
			gl.DRAW_FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			null,
			0,
		);
		gl.bindSampler(0, prevSampler);
		gl.bindTexture(gl.TEXTURE_2D, prevTex);
		gl.activeTexture(prev.unit);
		gl.bindVertexArray(prev.vao);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(prev.prog);
		gl.colorMask(prev.mask[0], prev.mask[1], prev.mask[2], prev.mask[3]);
		gl.viewport(
			prev.viewport[0],
			prev.viewport[1],
			prev.viewport[2],
			prev.viewport[3],
		);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prev.draw);
		for (const c of caps) gl.enable(c);
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
		this.draw(this.copy, src, h, handleOf(atlas), [x, y, w, h], (loc) =>
			this.gl.uniform2i(loc, x, y),
		);
		return true;
	}

	/**
	 * coarsen(rangeMapFrom(src).data, w, h) computed on the GPU and read back asynchronously
	 * (PBO + fence; only ⌈w/COARSE⌉ × ⌈h/COARSE⌉ floats cross). Issue it right after the draw into
	 * `src`: the texels are taken when the GPU runs it. null = not usable / context lost /
	 * `cancelled()` (callers take the CPU path).
	 */
	async coarse(
		src: Texture,
		w: number,
		h: number,
		cancelled: () => boolean = () => false,
	): Promise<CoarseResult | null> {
		if (!this.ok || !this.pool) return null;
		const gl = this.gl;
		const t0 = performance.now();
		const cw = Math.ceil(w / COARSE);
		const ch = Math.ceil(h / COARSE);
		const tex = gl.createTexture();
		const pbo = gl.createBuffer();
		const rfb = gl.createFramebuffer();
		const free = () => {
			gl.deleteTexture(tex);
			gl.deleteBuffer(pbo);
			gl.deleteFramebuffer(rfb);
		};
		if (!tex || !pbo || !rfb) {
			free();
			return null;
		}
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, cw, ch);
		gl.bindTexture(gl.TEXTURE_2D, prevTex);
		this.draw(this.pool, src, h, tex, [0, 0, cw, ch], (loc) =>
			gl.uniform2i(loc, w, h),
		);
		// read it into a pack buffer now; copy it out once a fence behind it signalled
		const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
		const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
		const prevAlign = gl.getParameter(gl.PACK_ALIGNMENT);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb);
		gl.framebufferTexture2D(
			gl.READ_FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			tex,
			0,
		);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		// RED/FLOAT where the implementation takes it, else RGBA/FLOAT (always allowed)
		const red =
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED &&
			gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT;
		const comps = red ? 1 : 4;
		const bytes = cw * ch * comps * 4;
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
		gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
		gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
		gl.readPixels(0, 0, cw, ch, red ? gl.RED : gl.RGBA, gl.FLOAT, 0);
		gl.pixelStorei(gl.PACK_ALIGNMENT, prevAlign);
		gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
		gl.framebufferTexture2D(
			gl.READ_FRAMEBUFFER,
			gl.COLOR_ATTACHMENT0,
			gl.TEXTURE_2D,
			null,
			0,
		);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
		const poolMs = performance.now() - t0;
		const stop = () => this.destroyed || cancelled();
		const fence = await glFence(gl, stop);
		const quiet = fence.ok
			? await readbackQuiet(gl, fence.ms, stop)
			: { ok: false };
		if (!quiet.ok || stop() || gl.isContextLost()) {
			free();
			return null;
		}
		const t1 = performance.now();
		const raw = new Float32Array(cw * ch * comps);
		const prevCopy = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
		gl.bindBuffer(gl.COPY_READ_BUFFER, pbo);
		gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, raw);
		gl.bindBuffer(gl.COPY_READ_BUFFER, prevCopy);
		free();
		let data = raw;
		if (comps === 4) {
			data = new Float32Array(cw * ch);
			for (let i = 0; i < data.length; i++) data[i] = raw[i * 4];
		}
		// framebuffer row 0 = texture row 0 = coarse row 0 (top): no flip
		return {
			grid: { width: cw, height: ch, data },
			mainMs: poolMs + performance.now() - t1,
			bytes,
		};
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		const gl = this.gl;
		if (this.device.type !== "webgl" || gl.isContextLost()) return;
		if (this.copy) gl.deleteProgram(this.copy.prog);
		if (this.pool) gl.deleteProgram(this.pool.prog);
		gl.deleteVertexArray(this.vao);
		gl.deleteSampler(this.sampler);
		gl.deleteFramebuffer(this.fbo);
	}
}
