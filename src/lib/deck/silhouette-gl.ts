// The silhouette pass mask on WebGL2 (deck backend): silhouette-mask.ts has the predicate and the
// identity argument. One fragment per 96-pixel group reads the pose's r32float range target
// (GpuGeometrySource.texture, GL rows: row 0 = bottom) and writes an RGBA32UI texel: 3 words of
// pass bits (top-down pixel order) + a header (nonce << 16 | positive texels << 8 | undecided). All poses of one
// re-rank land in one target (pose k = rows [k·H, (k+1)·H), top-down) and come back in ONE
// asynchronous readPixels (PBO + fence, geometry-pass.ts glFence / readbackQuiet).
//
// Raw GL, like GpuGeometrySource.copyRangeTo: luma's WebGL state tracker wraps the context's
// setters, so these calls keep its cache coherent, and every binding / capability touched is
// restored afterwards.
import type { Device } from "@luma.gl/core";
import { glFence, readbackQuiet } from "./geometry-pass";
import { glOf } from "./gl";
import {
	SIL_GROUP,
	silGroups,
	silhouetteThresholds,
	silMaskWords,
} from "./silhouette-mask";

const VS = `#version 300 es
void main() {
	// one triangle covering the viewport
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform highp sampler2D uRange;
uniform int uW;
uniform int uH;
uniform int uBase;     // first target row of this pose
uniform uint uNonce;
// rmax, khi, klo, zlo, zhi, flo, fhi
uniform float uT[7];
layout(location = 0) out uvec4 outMask;

// 0 = surely fail, 1 = surely pass, 2 = undecided
const int F = 0;
const int T = 1;
const int U = 2;

bool odd(float v) {
	uint b = floatBitsToUint(v) & 0x7fffffffu;
	return (b != 0u && b < 0x00800000u) || b >= 0x7f800000u; // denormal, Inf, NaN
}
float rangeAt(int x, int yTop) {
	return texelFetch(uRange, ivec2(x, uH - 1 - yTop), 0).r;
}
// one neighbour's three-valued pass test; z = the centre's own [Z] verdict
int nb(float rn, float rc, int z) {
	if (odd(rn)) return U;
	if (!(rn > 0.0)) return z;
	int lt = rn <= uT[5] ? T : (rn >= uT[6] ? F : U);
	int r = rn >= rc * uT[1] ? T : (rn <= rc * uT[2] ? F : U);
	if (lt == T) return r;
	if (lt == F) return z;
	return (r == z && r != U) ? r : U;
}

void main() {
	int g = int(gl_FragCoord.x);
	int y = int(gl_FragCoord.y) - uBase;
	uint bits[3] = uint[3](0u, 0u, 0u);
	uint und = 0u;
	// positive-range texels of the group's row (all rows / columns): the zero-texture guard
	uint pos = 0u;
	for (int k = 0; k < ${SIL_GROUP}; k++) {
		int x = g * ${SIL_GROUP} + k;
		if (x >= uW) break;
		float r = rangeAt(x, y);
		if (!odd(r) && r > 0.0) pos++;
	}
	if (y >= 1 && y <= uH - 2) {
		for (int k = 0; k < ${SIL_GROUP}; k++) {
			int x = g * ${SIL_GROUP} + k;
			if (x < 1 || x > uW - 2) continue;
			float rc = rangeAt(x, y);
			if (odd(rc)) { und++; continue; }
			if (!(rc > 0.0) || rc > uT[0]) continue;
			int z = rc <= uT[3] ? T : (rc >= uT[4] ? F : U);
			int a = nb(rangeAt(x, y - 1), rc, z);
			int b = nb(rangeAt(x + 1, y), rc, z);
			int c = nb(rangeAt(x - 1, y), rc, z);
			if (a == T || b == T || c == T) bits[k >> 5] |= 1u << uint(k & 31);
			else if (a == U || b == U || c == U) und++;
		}
	}
	outMask = uvec4(bits[0], bits[1], bits[2], (uNonce << 16) | (pos << 8) | min(und, 255u));
}`;

type Prog = {
	program: WebGLProgram;
	vao: WebGLVertexArrayObject;
	loc: Record<string, WebGLUniformLocation | null>;
};

/** One per DeckEngine (one GL context). */
export class SilhouetteMaskGL {
	private prog: Prog | null = null;
	private failed = false;
	private tex: WebGLTexture | null = null;
	private fbo: WebGLFramebuffer | null = null;
	private size = { w: 0, h: 0 };
	private pbo: WebGLBuffer | null = null;
	private pboBytes = 0;
	private busy = false;
	private destroyed = false;

	constructor(readonly device: Device) {}

	private get gl() {
		return glOf(this.device);
	}

	private compile(): Prog | null {
		if (this.prog || this.failed) return this.prog;
		const gl = this.gl;
		const sh = (type: number, src: string) => {
			const s = gl.createShader(type);
			if (!s) return null;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			return s;
		};
		const vs = sh(gl.VERTEX_SHADER, VS);
		const fs = sh(gl.FRAGMENT_SHADER, FS);
		const program = gl.createProgram();
		const vao = gl.createVertexArray();
		if (!vs || !fs || !program || !vao) {
			this.failed = true;
			return null;
		}
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		// once per engine: the only synchronous status query
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn(
				"[silhouette-gl] link failed, CPU re-rank",
				gl.getShaderInfoLog(fs),
				gl.getProgramInfoLog(program),
			);
			this.failed = true;
			return null;
		}
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		const loc: Prog["loc"] = {};
		for (const n of ["uRange", "uW", "uH", "uBase", "uNonce", "uT"])
			loc[n] = gl.getUniformLocation(program, n);
		this.prog = { program, vao, loc };
		return this.prog;
	}

	/** The RGBA32UI target, `w` groups × `h` rows (grown, never shrunk). */
	private target(w: number, h: number) {
		const gl = this.gl;
		if (this.tex && this.size.w === w && this.size.h >= h) return true;
		if (h > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return false;
		if (this.tex) gl.deleteTexture(this.tex);
		this.fbo ??= gl.createFramebuffer();
		this.tex = gl.createTexture();
		if (!this.tex || !this.fbo) return false;
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, w, h);
		gl.bindTexture(gl.TEXTURE_2D, prevTex);
		this.size = { w, h };
		return true;
	}

	/**
	 * Masks of the poses rendered into `ranges` (r32float, `W` × `H`, GL rows), in one readback:
	 * pose k's words at k · silMaskWords(W, H). null = not run (compile / size / busy / context
	 * lost / superseded): the caller scores on the CPU.
	 */
	async run(
		ranges: WebGLTexture[],
		W: number,
		H: number,
		nonce: number,
	): Promise<Uint32Array | null> {
		if (this.destroyed || this.busy || !ranges.length) return null;
		const gl = this.gl;
		if (gl.isContextLost()) return null;
		const prog = this.compile();
		const G = silGroups(W);
		const rows = H * ranges.length;
		if (!prog || !this.target(G, rows)) return null;
		this.busy = true;
		try {
			this.draw(prog, ranges, W, H, nonce);
			const words = silMaskWords(W, H) * ranges.length;
			const bytes = words * 4;
			// read into a STREAM_READ pack buffer, orphaned per read (geometry-pass.ts readPixelsInto)
			this.pbo ??= gl.createBuffer();
			if (!this.pbo) return null;
			const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
			const prevPack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
			const prevAlign = gl.getParameter(gl.PACK_ALIGNMENT);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
			gl.readBuffer(gl.COLOR_ATTACHMENT0);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
			gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
			this.pboBytes = bytes;
			gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
			gl.readPixels(0, 0, G, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, 0);
			gl.pixelStorei(gl.PACK_ALIGNMENT, prevAlign);
			gl.bindBuffer(gl.PIXEL_PACK_BUFFER, prevPack);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
			const cancelled = () => this.destroyed;
			const fence = await glFence(gl, cancelled);
			if (!fence.ok) return null;
			const quiet = await readbackQuiet(gl, fence.ms, cancelled);
			if (!quiet.ok || this.destroyed || !this.pbo) return null;
			const out = new Uint32Array(words);
			const prev = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
			gl.bindBuffer(gl.COPY_READ_BUFFER, this.pbo);
			gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, out, 0, words);
			gl.bindBuffer(gl.COPY_READ_BUFFER, prev);
			return out;
		} catch (e) {
			console.warn("[silhouette-gl] mask pass failed, CPU re-rank", e);
			return null;
		} finally {
			this.busy = false;
		}
	}

	/** Bytes the last run() read back. */
	get lastBytes() {
		return this.pboBytes;
	}

	private draw(
		prog: Prog,
		ranges: WebGLTexture[],
		W: number,
		H: number,
		nonce: number,
	) {
		const gl = this.gl;
		const G = silGroups(W);
		const t = silhouetteThresholds();
		// save everything the pass touches; restored in `finally`, so a throw (e.g. a lost context
		// mid-pass) never leaves luma's state cache pointing at our program / framebuffer
		const prev = {
			fbo: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
			program: gl.getParameter(gl.CURRENT_PROGRAM),
			vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
			viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
			active: gl.getParameter(gl.ACTIVE_TEXTURE),
			mask: gl.getParameter(gl.COLOR_WRITEMASK) as boolean[],
		};
		const caps = [
			gl.BLEND,
			gl.DEPTH_TEST,
			gl.STENCIL_TEST,
			gl.SCISSOR_TEST,
			gl.CULL_FACE,
			gl.RASTERIZER_DISCARD,
			gl.SAMPLE_ALPHA_TO_COVERAGE,
			gl.SAMPLE_COVERAGE,
			gl.POLYGON_OFFSET_FILL,
		];
		const on = caps.map((c) => gl.isEnabled(c));
		gl.activeTexture(gl.TEXTURE0);
		const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
		const prevSampler = gl.getParameter(gl.SAMPLER_BINDING);
		try {
			for (const c of caps) gl.disable(c);
			gl.bindSampler(0, null);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
			gl.framebufferTexture2D(
				gl.DRAW_FRAMEBUFFER,
				gl.COLOR_ATTACHMENT0,
				gl.TEXTURE_2D,
				this.tex,
				0,
			);
			gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
			gl.colorMask(true, true, true, true);
			// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
			gl.useProgram(prog.program);
			gl.bindVertexArray(prog.vao);
			const L = prog.loc;
			gl.uniform1i(L.uRange, 0);
			gl.uniform1i(L.uW, W);
			gl.uniform1i(L.uH, H);
			gl.uniform1ui(L.uNonce, nonce);
			gl.uniform1fv(
				L.uT,
				new Float32Array([t.rmax, t.khi, t.klo, t.zlo, t.zhi, t.flo, t.fhi]),
			);
			ranges.forEach((tex, k) => {
				gl.bindTexture(gl.TEXTURE_2D, tex);
				gl.uniform1i(L.uBase, k * H);
				gl.viewport(0, k * H, G, H);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
			});
		} finally {
			gl.bindTexture(gl.TEXTURE_2D, prevTex);
			gl.bindSampler(0, prevSampler);
			gl.activeTexture(prev.active);
			gl.bindVertexArray(prev.vao);
			// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
			gl.useProgram(prev.program);
			gl.colorMask(prev.mask[0], prev.mask[1], prev.mask[2], prev.mask[3]);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, prev.fbo);
			gl.viewport(
				prev.viewport[0],
				prev.viewport[1],
				prev.viewport[2],
				prev.viewport[3],
			);
			caps.forEach((c, i) => {
				if (on[i]) gl.enable(c);
			});
		}
	}

	destroy() {
		this.destroyed = true;
		const gl = this.gl;
		if (this.prog) {
			gl.deleteProgram(this.prog.program);
			gl.deleteVertexArray(this.prog.vao);
		}
		if (this.tex) gl.deleteTexture(this.tex);
		if (this.fbo) gl.deleteFramebuffer(this.fbo);
		if (this.pbo) gl.deleteBuffer(this.pbo);
		this.prog = null;
		this.tex = null;
		this.fbo = null;
		this.pbo = null;
	}
}
