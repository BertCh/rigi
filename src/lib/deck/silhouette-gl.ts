// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The silhouette pass mask on WebGL2 (deck backend): silhouette-mask.ts has the predicate and the
// identity argument. One fragment per 96-pixel group reads the pose's r32float range target
// (GpuGeometrySource.texture, GL rows: row 0 = bottom) and writes an RGBA32UI texel: 3 words of
// pass bits (top-down pixel order) + a header (nonce << 16 | positive texels << 8 | undecided). All poses of one
// re-rank land in one target (pose k = rows [k·H, (k+1)·H), top-down) and come back in ONE
// asynchronous readPixels (PBO + fence, geometry-pass.ts glFence / readbackQuiet).
//
// A luma Model on the deck device (no hand-written GL): the GLSL is the former program verbatim
// except that its uniforms are one std140 block (luma 10 has no plain-uniform path; identical
// values, identical math). The range targets come in as luma Textures (GpuGeometrySource.texture,
// what DeckEngine passes). The readback is texture.readBuffer into a fresh luma Buffer
// (orphaned per read), behind the same glFence / readbackQuiet queue probes.
import {
	type Buffer,
	type Device,
	type Framebuffer,
	Texture,
} from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { glFence, readbackBuffer, readbackQuiet } from "./geometry-pass";
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
// std140 block (luma 10 feeds uniforms through blocks only); uTa = rmax, khi, klo, zlo and
// uTb = zhi, flo, fhi, 0 are the former float uT[7]
layout(std140) uniform silUniforms {
	int uW;
	int uH;
	int uBase;     // first target row of this pose
	uint uNonce;
	vec4 uTa;
	vec4 uTb;
};
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
	int lt = rn <= uTb.y ? T : (rn >= uTb.z ? F : U);
	int r = rn >= rc * uTa.y ? T : (rn <= rc * uTa.z ? F : U);
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
			if (!(rc > 0.0) || rc > uTa.x) continue;
			int z = rc <= uTa.w ? T : (rc >= uTb.x ? F : U);
			int a = nb(rangeAt(x, y - 1), rc, z);
			int b = nb(rangeAt(x + 1, y), rc, z);
			int c = nb(rangeAt(x - 1, y), rc, z);
			if (a == T || b == T || c == T) bits[k >> 5] |= 1u << uint(k & 31);
			else if (a == U || b == U || c == U) und++;
		}
	}
	outMask = uvec4(bits[0], bits[1], bits[2], (uNonce << 16) | (pos << 8) | min(und, 255u));
}`;

const silModule = {
	name: "sil",
	uniformTypes: {
		uW: "i32",
		uH: "i32",
		uBase: "i32",
		uNonce: "u32",
		uTa: "vec4<f32>",
		uTb: "vec4<f32>",
	},
} as const;

const NEAREST = {
	minFilter: "nearest",
	magFilter: "nearest",
	mipmapFilter: "none",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

/** One per DeckEngine (one GL context). */
export class SilhouetteMaskGL {
	private model: Model | null = null;
	private compiling: Promise<Model | null> | null = null;
	private failed = false;
	private tex: Texture | null = null;
	private fbo: Framebuffer | null = null;
	private size = { w: 0, h: 0 };
	private pboBytes = 0;
	private busy = false;
	private destroyed = false;

	constructor(readonly device: Device) {}

	/** Compiled once per engine (asynchronously where the driver links in parallel). */
	private compile(): Promise<Model | null> {
		if (this.model || this.failed) return Promise.resolve(this.model);
		this.compiling ??= Model.createAsync(this.device, {
			id: "silhouette-mask",
			vs: VS,
			fs: FS,
			modules: [silModule],
			bufferLayout: [],
			topology: "triangle-list",
			vertexCount: 3,
		})
			.then((m) => {
				if (this.destroyed) {
					m.destroy();
					return null;
				}
				this.model = m;
				return m;
			})
			.catch((e) => {
				console.warn("[silhouette-gl] link failed, CPU re-rank", e);
				this.failed = true;
				return null;
			});
		return this.compiling;
	}

	/** The RGBA32UI target, `w` groups × `h` rows (grown, never shrunk). */
	private target(w: number, h: number) {
		if (this.tex && this.size.w === w && this.size.h >= h) return true;
		if (h > this.device.limits.maxTextureDimension2D) return false;
		this.fbo?.destroy();
		this.tex?.destroy();
		this.tex = this.device.createTexture({
			id: "silhouette-mask-target",
			format: "rgba32uint",
			width: w,
			height: h,
			usage: Texture.SAMPLE | Texture.RENDER | Texture.COPY_SRC,
			sampler: NEAREST,
		});
		this.fbo = this.device.createFramebuffer({
			id: "silhouette-mask-fbo",
			width: w,
			height: h,
			colorAttachments: [this.tex],
		});
		this.size = { w, h };
		return true;
	}

	/**
	 * Masks of the poses rendered into `ranges` (r32float, `W` × `H`, GL rows), in one readback:
	 * pose k's words at k · silMaskWords(W, H). null = not run (compile / size / busy / context
	 * lost / superseded): the caller scores on the CPU.
	 */
	async run(
		ranges: Texture[],
		W: number,
		H: number,
		nonce: number,
	): Promise<Uint32Array | null> {
		if (this.destroyed || this.busy || !ranges.length) return null;
		if (this.device.isLost) return null;
		const G = silGroups(W);
		const rows = H * ranges.length;
		this.busy = true;
		let readback: Buffer | null = null;
		try {
			const model = await this.compile();
			if (!model || this.destroyed || !this.target(G, rows)) return null;
			if (!this.draw(model, ranges, W, H, nonce)) return null;
			const words = silMaskWords(W, H) * ranges.length;
			const bytes = words * 4;
			// a fresh pack buffer per read = orphaned storage (geometry-pass.ts readPixelsInto)
			readback = readbackBuffer(this.device, bytes, "silhouette-mask-readback");
			this.tex?.readBuffer({ width: G, height: rows }, readback);
			this.pboBytes = bytes;
			const gl = glOf(this.device);
			const cancelled = () => this.destroyed;
			const fence = await glFence(gl, cancelled);
			if (!fence.ok) return null;
			const quiet = await readbackQuiet(gl, fence.ms, cancelled);
			if (!quiet.ok || this.destroyed) return null;
			const raw = await readback.readAsync(0, bytes);
			return new Uint32Array(raw.buffer, raw.byteOffset, words);
		} catch (e) {
			console.warn("[silhouette-gl] mask pass failed, CPU re-rank", e);
			return null;
		} finally {
			readback?.destroy();
			this.busy = false;
		}
	}

	/** Bytes the last run() read back. */
	get lastBytes() {
		return this.pboBytes;
	}

	private draw(
		model: Model,
		ranges: Texture[],
		W: number,
		H: number,
		nonce: number,
	): boolean {
		const G = silGroups(W);
		const t = silhouetteThresholds();
		const pass = this.device.beginRenderPass({
			id: "silhouette-mask",
			framebuffer: this.fbo ?? undefined,
			clearColor: false,
			clearDepth: false,
		});
		let ok = true;
		try {
			ranges.forEach((tex, k) => {
				model.shaderInputs.setProps({
					sil: {
						uW: W,
						uH: H,
						uBase: k * H,
						uNonce: nonce,
						uTa: [t.rmax, t.khi, t.klo, t.zlo],
						uTb: [t.zhi, t.flo, t.fhi, 0],
					},
				});
				model.setBindings({ uRange: tex });
				pass.setParameters({ viewport: [0, k * H, G, H, 0, 1] });
				ok = model.draw(pass) && ok;
			});
		} finally {
			pass.end();
		}
		return ok;
	}

	destroy() {
		this.destroyed = true;
		this.model?.destroy();
		this.fbo?.destroy();
		this.tex?.destroy();
		this.model = null;
		this.tex = null;
		this.fbo = null;
	}
}
