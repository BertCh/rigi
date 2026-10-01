// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside: a dependency-free 3D Gaussian splat renderer for three.js (reports/step-inside-design.md).
//
// One instanced quad per splat. Splat data lives in an RGBA32UI texture, two texels per splat:
//   texel 0: x, y, z (float bits), RGBA8 packed (r | g<<8 | b<<16 | a<<24)
//   texel 1: half2(sx, sy), half2(sz, qw), half2(qx, qy), half2(qz, provenance)
// The vertex shader builds the 3D covariance R·S·Sᵀ·Rᵀ, projects it with the EWA Jacobian
// (Zwicker et al.; as in antimatter15/splat and gsplat.js), takes the 2D eigen-axes and sizes the quad
// to where the Gaussian falls below the alpha cutoff. The only per-instance attribute is the splat index,
// which a worker (splat-sort.ts) re-orders back to front whenever the camera has moved enough.
// Blending is premultiplied "over" with depthWrite off and depthTest on, and the shaders include three's
// logdepthbuf chunks, so splats occlude and are occluded correctly against the engine's
// logarithmicDepthBuffer terrain (and still work without log depth). Perspective cameras only.
import * as THREE from "three";
import { SPLAT_PROVENANCE_COLORS } from "./provenance";
import { type DepthRow, SplatSorter } from "./splat-sort";
import type { GaussianCloud } from "./types";

// Moved to ./provenance (three-free, so the Step Inside panel can use it without this module);
// re-exported for existing importers.
export { SPLAT_PROVENANCE_COLORS };

export type ThreeSplatsOpts = {
	/** Global opacity multiplier 0..1 (fades). Default 1. */
	opacity?: number;
	/** Truth tint: 0 = true colour, 1 = provenance colour (true → 0.65). Default 0. */
	truth?: number | boolean;
	/** Largest splat half-extent on screen, CSS-independent device pixels. Default 512. */
	maxScreenPx?: number;
	/** Fragments (and whole splats) below this alpha are dropped. Default 1/255. */
	alphaCutoff?: number;
	/** false: sort on the main thread (tests). Default: worker. */
	worker?: boolean;
	/**
	 * Re-sort once the worst-case depth change of any splat since the last sort exceeds this
	 * fraction of the cloud radius. Default 0.002. A settle sort follows when the camera stops.
	 */
	sortEpsilon?: number;
};

const TEX_W = 4096; // texels per row → 2048 splats per row; 1M splats = 489 rows

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** float32 → IEEE half bits (round to nearest, clamps to ±65504, flushes tiny values to 0). */
function toHalf(v: number): number {
	f32[0] = v;
	const x = u32[0];
	const sign = (x >>> 16) & 0x8000;
	const e = ((x >>> 23) & 0xff) - 112; // rebias 127 → 15
	const m = x & 0x7fffff;
	if (e >= 31) return sign | 0x7bff;
	if (e <= 0) {
		if (e < -10) return sign;
		const mm = (m | 0x800000) >>> (1 - e);
		return sign | ((mm + 0x1000) >>> 13);
	}
	// "+" (not "|"): a mantissa round-up must carry into the exponent (1.9999 → 2, not 1); clamp so
	// the carry out of the largest exponent stays finite
	return sign | Math.min((e << 10) + ((m + 0x1000) >>> 13), 0x7bff);
}

/** Pack a cloud into the RGBA32UI layout described at the top of the file. */
export function packSplatTexture(cloud: GaussianCloud): {
	data: Uint32Array;
	width: number;
	height: number;
} {
	const n = cloud.count;
	const height = Math.max(1, Math.ceil((2 * n) / TEX_W));
	const data = new Uint32Array(TEX_W * height * 4);
	const pf = new Float32Array(data.buffer);
	const {
		positions: p,
		scales: s,
		rotations: q,
		colors: c,
		provenance: pv,
	} = cloud;
	for (let i = 0; i < n; i++) {
		const o = 8 * i;
		pf[o] = p[3 * i];
		pf[o + 1] = p[3 * i + 1];
		pf[o + 2] = p[3 * i + 2];
		data[o + 3] =
			(c[4 * i] |
				(c[4 * i + 1] << 8) |
				(c[4 * i + 2] << 16) |
				(c[4 * i + 3] << 24)) >>>
			0;
		// scales below ~1e-4 m would go subnormal in half precision; nothing that small is visible
		const sx = Math.max(s[3 * i], 1e-4);
		const sy = Math.max(s[3 * i + 1], 1e-4);
		const sz = Math.max(s[3 * i + 2], 1e-4);
		data[o + 4] = (toHalf(sx) | (toHalf(sy) << 16)) >>> 0;
		data[o + 5] = (toHalf(sz) | (toHalf(q[4 * i]) << 16)) >>> 0;
		data[o + 6] = (toHalf(q[4 * i + 1]) | (toHalf(q[4 * i + 2]) << 16)) >>> 0;
		data[o + 7] = (toHalf(q[4 * i + 3]) | (toHalf(pv ? pv[i] : 0) << 16)) >>> 0;
	}
	return { data, width: TEX_W, height };
}

const VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D splatTex;
uniform vec2 viewport;
uniform float maxScreenPx;
uniform float alphaCutoff;
uniform float opacity;
uniform float truth;
uniform vec3 truthColors[4];
/** 1: the target stores sRGB (canvas), so the sRGB splat colours pass through; 0: decode to linear. */
uniform float srgbOut;

attribute uint splatIndex;

varying vec4 vColor;
varying vec2 vPos;

#include <common>
#include <logdepthbuf_pars_vertex>

void cull() { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }

void main() {
	uint i0 = splatIndex * 2u;
	uint i1 = i0 + 1u;
	uvec4 t0 = texelFetch(splatTex, ivec2(int(i0 & 4095u), int(i0 >> 12u)), 0);
	uvec4 t1 = texelFetch(splatTex, ivec2(int(i1 & 4095u), int(i1 >> 12u)), 0);

	vec4 viewC = modelViewMatrix * vec4(uintBitsToFloat(t0.xyz), 1.0);
	vec4 clipC = projectionMatrix * viewC;
	if (clipC.w <= 0.0 || viewC.z >= 0.0) { cull(); return; }

	vec4 rgba = vec4(float(t0.w & 255u), float((t0.w >> 8u) & 255u), float((t0.w >> 16u) & 255u), float(t0.w >> 24u)) / 255.0;
	float a = rgba.a * opacity;
	if (a < alphaCutoff) { cull(); return; }

	vec2 s01 = unpackHalf2x16(t1.x);
	vec2 s2w = unpackHalf2x16(t1.y);
	vec2 qxy = unpackHalf2x16(t1.z);
	vec2 qzp = unpackHalf2x16(t1.w);
	vec4 qn = vec4(s2w.y, qxy, qzp.x); // w, x, y, z
	qn /= max(length(qn), 1e-8);
	float w = qn.x, x = qn.y, y = qn.z, z = qn.w;
	// columns of the rotation matrix
	mat3 R = mat3(
		1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
		2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
		2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
	);
	mat3 M = R * mat3(s01.x, 0.0, 0.0, 0.0, s01.y, 0.0, 0.0, 0.0, s2w.x);
	mat3 Vrk = M * transpose(M);

	// EWA: J = d(pixel)/d(view) at the centre (both rows share a sign flip for three's -z, which
	// leaves J·Σ·Jᵀ unchanged); W = the model-view linear part.
	vec3 v = viewC.xyz;
	float fx = projectionMatrix[0][0] * viewport.x * 0.5;
	float fy = projectionMatrix[1][1] * viewport.y * 0.5;
	float iz = 1.0 / v.z;
	mat3 J = mat3(
		fx * iz, 0.0, 0.0,
		0.0, fy * iz, 0.0,
		-fx * v.x * iz * iz, -fy * v.y * iz * iz, 0.0
	);
	mat3 T = J * mat3(modelViewMatrix);
	mat3 cov = T * Vrk * transpose(T);
	// low-pass filter (antialiasing dilation of ~0.55 px)
	float ca = cov[0][0] + 0.3;
	float cb = cov[0][1];
	float cc = cov[1][1] + 0.3;

	float mid = 0.5 * (ca + cc);
	float rad = length(vec2(0.5 * (ca - cc), cb));
	float l1 = mid + rad;
	float l2 = max(mid - rad, 0.1);
	vec2 d1 = abs(cb) > 1e-9 ? normalize(vec2(cb, l1 - ca)) : (ca >= cc ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
	vec2 d2 = vec2(-d1.y, d1.x); // CCW, keeps the quad front-facing

	// quad half-extent in sigmas: where a * exp(-r^2 / 2) drops below the cutoff, at most 3 sigma
	float rMax = min(3.0, sqrt(max(2.0 * log(a / alphaCutoff), 0.0)));
	if (rMax <= 0.0) { cull(); return; }
	float sig1 = min(sqrt(l1), maxScreenPx / rMax);
	float sig2 = min(sqrt(l2), maxScreenPx / rMax);
	vec2 ext = vec2(rMax * sig1, rMax * sig2);

	// frustum cull on the splat's bounding circle (NDC)
	vec2 ndc = clipC.xy / clipC.w;
	vec2 rNdc = 2.0 * ext.x / viewport;
	if (any(greaterThan(abs(ndc) - rNdc, vec2(1.0))) || clipC.z > clipC.w) { cull(); return; }

	vec2 offPx = position.x * ext.x * d1 + position.y * ext.y * d2;
	gl_Position = vec4(clipC.xy + offPx * 2.0 / viewport * clipC.w, clipC.z, clipC.w);
	#include <logdepthbuf_vertex>

	int prov = clamp(int(qzp.y + 0.5), 0, 3);
	vec3 col = mix(rgba.rgb, truthColors[prov], truth);
	// colours are sRGB; convert once per splat here rather than per fragment
	if (srgbOut < 0.5)
		col = mix(col / 12.92, pow((col + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), col));
	vColor = vec4(col, a);
	vPos = position.xy * rMax;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform float alphaCutoff;

layout(location = 0) out highp vec4 fragColor;

varying vec4 vColor;
varying vec2 vPos;

#include <common>
#include <logdepthbuf_pars_fragment>

void main() {
	float al = vColor.a * exp(-0.5 * dot(vPos, vPos));
	if (al < alphaCutoff) discard;
	#include <logdepthbuf_fragment>
	fragColor = vec4(vColor.rgb * al, al);
}
`;

export type SplatStats = {
	count: number;
	/** Splats in the current draw (in front of the camera at the last sort). */
	drawn: number;
	sorts: number;
	lastSortMs: number;
	usingWorker: boolean;
};

const _mv = new THREE.Matrix4();
const _vp = new THREE.Vector4();

export class ThreeSplats extends THREE.Mesh<
	THREE.InstancedBufferGeometry,
	THREE.ShaderMaterial
> {
	readonly cloud: GaussianCloud;
	readonly stats: SplatStats;
	private tex: THREE.DataTexture;
	private indexAttr: THREE.InstancedBufferAttribute;
	private spare: Uint32Array | null;
	private sorter: SplatSorter;
	private lastRow: DepthRow | null = null;
	private lastSortAt = 0;
	private dirtySince = 0;
	private sortEps: number;
	private center = new THREE.Vector3();
	private radius = 1;
	private disposed = false;

	constructor(cloud: GaussianCloud, opts: ThreeSplatsOpts = {}) {
		const n = cloud.count;
		const packed = packSplatTexture(cloud);
		const tex = new THREE.DataTexture(
			packed.data,
			packed.width,
			packed.height,
			THREE.RGBAIntegerFormat,
			THREE.UnsignedIntType,
		);
		tex.internalFormat = "RGBA32UI";
		tex.minFilter = THREE.NearestFilter;
		tex.magFilter = THREE.NearestFilter;
		tex.generateMipmaps = false;
		tex.flipY = false;
		tex.needsUpdate = true;

		const geom = new THREE.InstancedBufferGeometry();
		geom.setAttribute(
			"position",
			new THREE.BufferAttribute(
				new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
				3,
			),
		);
		geom.setIndex([0, 1, 2, 0, 2, 3]);
		const idx = new Uint32Array(n);
		for (let i = 0; i < n; i++) idx[i] = i;
		const indexAttr = new THREE.InstancedBufferAttribute(idx, 1);
		indexAttr.setUsage(THREE.DynamicDrawUsage);
		geom.setAttribute("splatIndex", indexAttr);
		geom.instanceCount = n;

		const truth =
			opts.truth === true ? 0.65 : opts.truth === false ? 0 : (opts.truth ?? 0);
		const mat = new THREE.ShaderMaterial({
			glslVersion: THREE.GLSL3,
			vertexShader: VERT,
			fragmentShader: FRAG,
			uniforms: {
				splatTex: { value: tex },
				viewport: { value: new THREE.Vector2(1, 1) },
				maxScreenPx: { value: opts.maxScreenPx ?? 512 },
				alphaCutoff: { value: opts.alphaCutoff ?? 1 / 255 },
				opacity: { value: opts.opacity ?? 1 },
				truth: { value: truth },
				srgbOut: { value: 1 },
				truthColors: {
					value: SPLAT_PROVENANCE_COLORS.map(
						(c) => new THREE.Vector3(c[0], c[1], c[2]),
					),
				},
			},
			transparent: true,
			depthWrite: false,
			depthTest: true,
			blending: THREE.CustomBlending,
			blendEquation: THREE.AddEquation,
			blendSrc: THREE.OneFactor,
			blendDst: THREE.OneMinusSrcAlphaFactor,
			blendSrcAlpha: THREE.OneFactor,
			blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
			toneMapped: false,
			side: THREE.DoubleSide, // a mirrored parent transform must not cull every splat
		});
		super(geom, mat);
		this.name = "ThreeSplats";
		this.cloud = cloud;
		this.tex = tex;
		this.indexAttr = indexAttr;
		this.spare = new Uint32Array(n);
		this.frustumCulled = false; // bounds of an instanced quad are meaningless; the shader culls
		this.sortEps = opts.sortEpsilon ?? 0.002;
		this.stats = {
			count: n,
			drawn: n,
			sorts: 0,
			lastSortMs: 0,
			usingWorker: false,
		};

		// bounding sphere (centroid + max distance) for the re-sort threshold
		const p = cloud.positions;
		let cx = 0;
		let cy = 0;
		let cz = 0;
		for (let i = 0; i < n; i++) {
			cx += p[3 * i];
			cy += p[3 * i + 1];
			cz += p[3 * i + 2];
		}
		if (n) this.center.set(cx / n, cy / n, cz / n);
		let r2 = 0;
		for (let i = 0; i < n; i++) {
			const dx = p[3 * i] - this.center.x;
			const dy = p[3 * i + 1] - this.center.y;
			const dz = p[3 * i + 2] - this.center.z;
			r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
		}
		this.radius = Math.max(Math.sqrt(r2), 1e-3);

		this.sorter = new SplatSorter(p, n, { worker: opts.worker });
		this.stats.usingWorker = this.sorter.usingWorker;
		this.onBeforeRender = (renderer, _scene, camera) =>
			this.beforeRender(renderer, camera);
	}

	setOpacity(v: number) {
		this.material.uniforms.opacity.value = v;
	}
	setTruth(v: number | boolean) {
		this.material.uniforms.truth.value =
			v === true ? 0.65 : v === false ? 0 : v;
	}
	setMaxScreenPx(v: number) {
		this.material.uniforms.maxScreenPx.value = v;
	}
	setAlphaCutoff(v: number) {
		this.material.uniforms.alphaCutoff.value = v;
	}

	private beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
		renderer.getCurrentViewport(_vp);
		const target = renderer.getRenderTarget();
		const srgb = target
			? target.texture.colorSpace === THREE.SRGBColorSpace
			: renderer.outputColorSpace === THREE.SRGBColorSpace;
		this.material.uniforms.srgbOut.value = srgb ? 1 : 0;
		this.material.uniforms.viewport.value.set(_vp.z, _vp.w);
		_mv.multiplyMatrices(camera.matrixWorldInverse, this.matrixWorld);
		const e = _mv.elements;
		const row: DepthRow = [e[2], e[6], e[10], e[14]];
		if (!this.needsSort(row)) return;
		const near = (camera as THREE.PerspectiveCamera).near ?? 0;
		this.requestSort(row, near);
	}

	/** Worst-case depth change of any splat in the bounding sphere since the last sort. */
	private needsSort(row: DepthRow): boolean {
		const last = this.lastRow;
		if (!last) return true;
		const da = row[0] - last[0];
		const db = row[1] - last[1];
		const dc = row[2] - last[2];
		const dd = row[3] - last[3];
		const c = this.center;
		const change =
			Math.abs(da * c.x + db * c.y + dc * c.z + dd) +
			Math.hypot(da, db, dc) * this.radius;
		if (change === 0) return false;
		const now = performance.now();
		if (change > this.sortEps * this.radius) return true;
		// small residual motion: one settle sort after the camera has been still for a moment
		if (!this.dirtySince) this.dirtySince = now;
		return now - this.dirtySince > 200 && now - this.lastSortAt > 200;
	}

	private requestSort(row: DepthRow, near: number) {
		if (this.sorter.busy || !this.spare) return;
		const out = this.spare;
		this.spare = null;
		const ok = this.sorter.sort(
			row,
			out,
			(r) => {
				if (this.disposed) return;
				const attr = this.indexAttr;
				const old = attr.array as Uint32Array;
				attr.array = r.indices;
				attr.clearUpdateRanges();
				attr.addUpdateRange(0, r.count);
				attr.needsUpdate = true;
				this.geometry.instanceCount = r.count;
				this.spare = old;
				this.stats.sorts++;
				this.stats.lastSortMs = r.ms;
				this.stats.drawn = r.count;
				this.stats.usingWorker = this.sorter.usingWorker;
			},
			near,
		);
		if (!ok) {
			this.spare = out;
			return;
		}
		this.lastRow = row;
		this.lastSortAt = performance.now();
		this.dirtySince = 0;
	}

	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.sorter.dispose();
		this.geometry.dispose();
		this.material.dispose();
		this.tex.dispose();
		this.removeFromParent();
	}
}
