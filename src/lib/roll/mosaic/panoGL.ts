// Tiny WebGL2 renderer for the panorama strip: one textured mesh per photo on the (az, el)
// canvas, drawn in the given order with a feathered edge so overlaps blend. No dependencies.
import type { PanoMesh } from "./panorama";
import { wrapOffsets } from "./panorama";

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform vec2 u_size;
uniform float u_az0;
uniform float u_elc;
uniform float u_ppd;
uniform float u_off;
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
uniform float u_feather;
uniform float u_alpha;
out vec4 o;
void main() {
  vec2 e = min(v_uv, 1.0 - v_uv);
  float a = smoothstep(0.0, u_feather, e.x) * smoothstep(0.0, u_feather * 1.33, e.y);
  o = vec4(texture(u_tex, v_uv).rgb, a * u_alpha);
}`;

/** Largest texture edge; bigger uploads are downscaled on decode. */
const MAX_TEX = 2048;

type Item = {
	mesh: PanoMesh;
	vao: WebGLVertexArrayObject;
	bufs: WebGLBuffer[];
	tex: WebGLTexture | null;
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

export class PanoGL {
	private gl: WebGL2RenderingContext;
	private prog: WebGLProgram;
	private loc: Record<string, WebGLUniformLocation | null> = {};
	private aPos: number;
	private aUv: number;
	private items = new Map<string, Item>();
	private alive = true;

	constructor(
		canvas: HTMLCanvasElement,
		private onLoad: () => void,
	) {
		// transparent: the viewpoint's terrain (a 2D canvas underneath) shows between and through the photos
		const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
		if (!gl) throw new Error("WebGL2 unavailable");
		this.gl = gl;
		const sh = (type: number, src: string) => {
			const s = gl.createShader(type) as WebGLShader;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
				throw new Error(gl.getShaderInfoLog(s) ?? "shader");
			return s;
		};
		const p = gl.createProgram() as WebGLProgram;
		gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
		gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS))
			throw new Error(gl.getProgramInfoLog(p) ?? "link");
		this.prog = p;
		for (const n of [
			"u_size",
			"u_az0",
			"u_elc",
			"u_ppd",
			"u_off",
			"u_tex",
			"u_feather",
			"u_alpha",
		])
			this.loc[n] = gl.getUniformLocation(p, n);
		this.aPos = gl.getAttribLocation(p, "a_pos");
		this.aUv = gl.getAttribLocation(p, "a_uv");
	}

	/** Register (or update) a photo; starts loading its texture once. */
	set(id: string, src: string, mesh: PanoMesh) {
		const gl = this.gl;
		let it = this.items.get(id);
		if (it && it.mesh === mesh) return;
		if (it) {
			for (const b of it.bufs) gl.deleteBuffer(b);
			gl.deleteVertexArray(it.vao);
		}
		const vao = gl.createVertexArray() as WebGLVertexArrayObject;
		gl.bindVertexArray(vao);
		const buf = (target: number, data: ArrayBufferView) => {
			const b = gl.createBuffer() as WebGLBuffer;
			gl.bindBuffer(target, b);
			gl.bufferData(target, data, gl.STATIC_DRAW);
			return b;
		};
		const bp = buf(gl.ARRAY_BUFFER, mesh.pos);
		gl.enableVertexAttribArray(this.aPos);
		gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
		const bu = buf(gl.ARRAY_BUFFER, mesh.uv);
		gl.enableVertexAttribArray(this.aUv);
		gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
		const bi = buf(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);
		gl.bindVertexArray(null);
		const keepTex = it && it.src === src ? it.tex : null;
		if (it?.tex && !keepTex) gl.deleteTexture(it.tex);
		it = { mesh, vao, bufs: [bp, bu, bi], tex: keepTex, src };
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
			const bmp: TexImageSource =
				s < 1
					? await createImageBitmap(img, {
							resizeWidth: Math.round(img.naturalWidth * s),
							resizeHeight: Math.round(img.naturalHeight * s),
							resizeQuality: "high",
						})
					: img;
			const it = this.items.get(id);
			if (!this.alive || !it || it.src !== src) return;
			const gl = this.gl;
			const tex = gl.createTexture() as WebGLTexture;
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
			gl.generateMipmap(gl.TEXTURE_2D);
			gl.texParameteri(
				gl.TEXTURE_2D,
				gl.TEXTURE_MIN_FILTER,
				gl.LINEAR_MIPMAP_LINEAR,
			);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			it.tex = tex;
			this.onLoad();
		} catch (e) {
			console.warn("[roll/panorama] texture failed", id, e);
		}
	}

	/** Draw photos in order (later on top). Canvas size must already match view.w/h × dpr. */
	draw(list: PanoDraw[], v: PanoView) {
		const gl = this.gl;
		const W = Math.round(v.w * v.dpr);
		const H = Math.round(v.h * v.dpr);
		gl.viewport(0, 0, W, H);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		// biome-ignore lint/correctness/useHookAtTopLevel: WebGL call, not a React hook
		gl.useProgram(this.prog);
		gl.enable(gl.BLEND);
		// premultiplied output (the canvas default), so feathered edges composite over the terrain
		gl.blendFuncSeparate(
			gl.SRC_ALPHA,
			gl.ONE_MINUS_SRC_ALPHA,
			gl.ONE,
			gl.ONE_MINUS_SRC_ALPHA,
		);
		gl.uniform2f(this.loc.u_size, W, H);
		gl.uniform1f(this.loc.u_az0, v.az0);
		gl.uniform1f(this.loc.u_elc, v.elc);
		gl.uniform1f(this.loc.u_ppd, v.ppd * v.dpr);
		gl.uniform1i(this.loc.u_tex, 0);
		gl.activeTexture(gl.TEXTURE0);
		const a1 = v.az0 + v.w / v.ppd;
		for (const d of list) {
			const it = this.items.get(d.id);
			if (!it?.tex) continue;
			gl.bindVertexArray(it.vao);
			gl.bindTexture(gl.TEXTURE_2D, it.tex);
			gl.uniform1f(this.loc.u_feather, d.feather ?? 0.03);
			gl.uniform1f(this.loc.u_alpha, d.alpha ?? 1);
			for (const off of wrapOffsets(it.mesh.azMin, it.mesh.azMax, v.az0, a1)) {
				gl.uniform1f(this.loc.u_off, off);
				gl.drawElements(gl.TRIANGLES, it.mesh.idx.length, gl.UNSIGNED_SHORT, 0);
			}
		}
		gl.bindVertexArray(null);
	}

	/** Forget photos not in keep. */
	prune(keep: ReadonlySet<string>) {
		for (const id of [...this.items.keys()]) if (!keep.has(id)) this.drop(id);
	}

	private drop(id: string) {
		const gl = this.gl;
		const it = this.items.get(id);
		if (!it) return;
		for (const b of it.bufs) gl.deleteBuffer(b);
		gl.deleteVertexArray(it.vao);
		if (it.tex) gl.deleteTexture(it.tex);
		this.items.delete(id);
	}

	dispose() {
		this.alive = false;
		for (const id of [...this.items.keys()]) this.drop(id);
		this.gl.deleteProgram(this.prog);
	}
}
