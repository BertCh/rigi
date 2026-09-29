// Step Inside P3 (research flag): render the TRUE scene from a novel camera into an RGB-D "3D cache" frame
// (the GEN3C / Voyager pattern, research_notes/step_inside_models_2026-09.md): DEM terrain + the photo draped
// onto it from the photo camera (only surfaces the photo saw) + the near-field splats. Whatever is left
// uncovered is a hole the generator may fill.
//
// Offscreen and self-contained: it draws the engine's terrain meshes with its own override materials into
// its own float targets on the engine's WebGLRenderer (engine.ts is not touched, no engine private is read).
// The terrain group is re-parented into a private Scene for the duration of one render call and put back
// at the same child index before returning (synchronous, so the engine never sees it moved).
//
// Passes per view: (1) geometry → ENU xyz + range per pixel; (2) drape → photo colour where the terrain point
// is visible from the photo eye (range test against the photo camera's own range buffer, like the engine's
// world drape but with a tight metric tolerance and object masking), then the splats over it with the same
// log depth; (3) CPU: sky pixels (no DEM) take the photo's sky along the same direction when the photo saw
// sky there. Colours are linear in the float target and converted to sRGB on readback.
import * as THREE from "three";
import type { Pose } from "../../camera";
import { poseBasis } from "../../camera";
import { applyPose } from "../../pose";
import { intrinsicsFromPose } from "../geom";
import type { RGBAImage } from "../lift";
import { ThreeSplats } from "../three-splats";
import type { GaussianCloud } from "../types";
import type { RgbdView } from "./holes";
import type { NovelCamera } from "./trajectory";

export type CacheSceneInput = {
	/** The engine's WebGLRenderer (it owns the terrain's GL buffers). */
	renderer: THREE.WebGLRenderer;
	/** Terrain meshes, ENU (the engine's Terrain.group). */
	terrain: THREE.Object3D;
	/** The photo (decoded image element) and its RGBA (any resolution, same framing; imageToRGBA). */
	photoImage: TexImageSource & { width: number; height: number };
	photoRGBA: RGBAImage;
	photoPose: Pose;
	photoEye: { x: number; y: number; z: number };
	/** Photo W/H. */
	aspect: number;
	/**
	 * Pixels of the photo that must NOT be draped on the DEM (near-field objects: they are splats, and
	 * behind them is a disocclusion), row 0 = top, 1 = masked. Usually split.cls === Object (+ people).
	 */
	dropMask?: { width: number; height: number; data: Uint8Array } | null;
	/** Near-field splats, ENU (NearFieldScene.splats, later merged with generated ones). */
	splats?: GaussianCloud | null;
};

export type CacheRenderOpts = {
	/** Photo range-buffer width (px). Default 1024. */
	photoRangeWidth?: number;
	/** Visibility test: r < seen·(1 + rel) + abs. Defaults 0.012 and 1.0 m (the engine's world view uses 0.015 / 15 m). */
	visRel?: number;
	visAbs?: number;
	/** Terrain nearer than this to the photo eye is never draped (m). Default 0. */
	minRange?: number;
};

export type ViewRenderOpts = {
	/** Splat truth tint 0..1 (0 = true colour). Default 0. */
	truth?: number;
	/** Draw the splats. Default true. */
	splats?: boolean;
	/** Fill the sky from the photo along the same direction. Default true. */
	sky?: boolean;
};

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;

const GEO_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vWorld, length(vWorld - cameraPosition));
}`;

const DRAPE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uPhoto;
uniform sampler2D uPhotoRange;
uniform sampler2D uDrop;
uniform float uDropOn;
uniform mat4 uPhotoViewProj;
uniform vec3 uPhotoPos;
uniform vec3 uVis; // rel, abs, minRange
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec4 col = vec4(0.0);
  vec4 clip = uPhotoViewProj * vec4(vWorld, 1.0);
  if (clip.w > 0.0) {
    vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
    if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
      float r = length(vWorld - uPhotoPos);
      float seen = texture2D(uPhotoRange, puv).a;
      bool visible = seen > 0.0 && r < seen * (1.0 + uVis.x) + uVis.y && r > uVis.z;
      // masks are row 0 = top; puv.y is up
      if (uDropOn > 0.5 && texture2D(uDrop, vec2(puv.x, 1.0 - puv.y)).r > 0.5) visible = false;
      if (visible) col = vec4(texture2D(uPhoto, puv).rgb, 1.0);
    }
  }
  gl_FragColor = col;
}`;

const floatRT = (w: number, h: number) =>
	new THREE.WebGLRenderTarget(w, h, {
		type: THREE.FloatType,
		format: THREE.RGBAFormat,
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		depthBuffer: true,
		generateMipmaps: false,
	});

/** Linear 0..1 → sRGB 0..255. */
const LUT_N = 4096;
const SRGB_LUT = (() => {
	const t = new Uint8ClampedArray(LUT_N + 1);
	for (let i = 0; i <= LUT_N; i++) {
		const c = i / LUT_N;
		const s = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
		t[i] = Math.round(s * 255);
	}
	return t;
})();
const toSrgb8 = (c: number) =>
	SRGB_LUT[Math.max(0, Math.min(LUT_N, Math.round(c * LUT_N)))];

export class CacheRenderer {
	readonly input: CacheSceneInput;
	private opts: Required<CacheRenderOpts>;
	private scene = new THREE.Scene();
	private splatScene = new THREE.Scene();
	private geoMat: THREE.ShaderMaterial;
	private drapeMat: THREE.ShaderMaterial;
	private photoTex: THREE.Texture;
	private dropTex: THREE.DataTexture | null = null;
	private photoRT: THREE.WebGLRenderTarget;
	private photoRange: Float32Array;
	private photoCam = new THREE.PerspectiveCamera(50, 1, 0.3, 400000);
	private cam = new THREE.PerspectiveCamera(50, 1, 0.3, 400000);
	private splats: ThreeSplats | null = null;
	private rts = new Map<string, THREE.WebGLRenderTarget>();

	constructor(input: CacheSceneInput, opts: CacheRenderOpts = {}) {
		this.input = input;
		this.opts = {
			photoRangeWidth: opts.photoRangeWidth ?? 1024,
			visRel: opts.visRel ?? 0.012,
			visAbs: opts.visAbs ?? 1.0,
			minRange: opts.minRange ?? 0,
		};
		this.geoMat = new THREE.ShaderMaterial({
			vertexShader: VERT,
			fragmentShader: GEO_FRAG,
			side: THREE.DoubleSide,
		});
		const tex = new THREE.Texture(input.photoImage as THREE.Texture["image"]);
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.minFilter = THREE.LinearFilter;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;
		this.photoTex = tex;
		const dm = input.dropMask;
		if (dm) {
			const d = new Uint8Array(dm.width * dm.height);
			for (let k = 0; k < d.length; k++) d[k] = dm.data[k] ? 255 : 0;
			this.dropTex = new THREE.DataTexture(
				d,
				dm.width,
				dm.height,
				THREE.RedFormat,
			);
			this.dropTex.minFilter = THREE.NearestFilter;
			this.dropTex.magFilter = THREE.NearestFilter;
			this.dropTex.needsUpdate = true;
		}
		const pw = this.opts.photoRangeWidth;
		const ph = Math.max(1, Math.round(pw / input.aspect));
		this.photoRT = floatRT(pw, ph);
		this.photoRange = new Float32Array(pw * ph * 4);
		this.drapeMat = new THREE.ShaderMaterial({
			vertexShader: VERT,
			fragmentShader: DRAPE_FRAG,
			side: THREE.DoubleSide,
			uniforms: {
				uPhoto: { value: tex },
				uPhotoRange: { value: this.photoRT.texture },
				uDrop: { value: this.dropTex },
				uDropOn: { value: this.dropTex ? 1 : 0 },
				uPhotoViewProj: { value: new THREE.Matrix4() },
				uPhotoPos: { value: new THREE.Vector3() },
				uVis: {
					value: new THREE.Vector3(
						this.opts.visRel,
						this.opts.visAbs,
						this.opts.minRange,
					),
				},
			},
		});
		this.setSplats(input.splats ?? null);
		this.renderPhotoRange();
	}

	/** Replace the splat cloud drawn over the drape (e.g. after merging generated splats). */
	setSplats(cloud: GaussianCloud | null) {
		if (this.splats) {
			this.splatScene.remove(this.splats);
			this.splats.dispose();
			this.splats = null;
		}
		if (cloud && cloud.count > 0) {
			if (cloud.frame !== "enu")
				throw new Error("CacheRenderer: splats must be ENU");
			this.splats = new ThreeSplats(cloud, { worker: false });
			this.splatScene.add(this.splats);
		}
	}

	/** Photo-camera range buffer (the drape's shadow map), kept on the CPU too for the sky test. */
	private renderPhotoRange() {
		const { photoPose, photoEye, aspect } = this.input;
		applyPose(
			this.photoCam,
			photoPose,
			aspect,
			new THREE.Vector3(photoEye.x, photoEye.y, photoEye.z),
		);
		this.withTerrain(this.geoMat, () => {
			this.drawTo(this.photoRT, this.photoCam, this.scene, true);
		});
		const { width: w, height: h } = this.photoRT;
		this.input.renderer.readRenderTargetPixels(
			this.photoRT,
			0,
			0,
			w,
			h,
			this.photoRange,
		);
		const u = this.drapeMat.uniforms;
		u.uPhotoViewProj.value.multiplyMatrices(
			this.photoCam.projectionMatrix,
			this.photoCam.matrixWorldInverse,
		);
		u.uPhotoPos.value.set(photoEye.x, photoEye.y, photoEye.z);
	}

	/** Terrain seen from the photo eye in normalised photo coords (u right, v down): range > 0. */
	photoRangeAt(u: number, v: number): number {
		const { width: w, height: h } = this.photoRT;
		const x = Math.floor(u * w);
		const y = Math.floor((1 - v) * h);
		if (x < 0 || y < 0 || x >= w || y >= h) return 0;
		return this.photoRange[(y * w + x) * 4 + 3];
	}

	private rt(key: string, w: number, h: number) {
		let rt = this.rts.get(key);
		if (!rt || rt.width !== w || rt.height !== h) {
			rt?.dispose();
			rt = floatRT(w, h);
			this.rts.set(key, rt);
		}
		return rt;
	}

	/** Run `fn` with the terrain group temporarily in the private scene under `mat`, then restore it. */
	private withTerrain(mat: THREE.Material, fn: () => void) {
		const g = this.input.terrain;
		const parent = g.parent;
		const idx = parent ? parent.children.indexOf(g) : -1;
		this.scene.overrideMaterial = mat;
		this.scene.add(g);
		try {
			fn();
		} finally {
			this.scene.remove(g);
			this.scene.overrideMaterial = null;
			if (parent) {
				parent.add(g);
				// back to its original slot (three appends)
				const c = parent.children;
				c.splice(c.indexOf(g), 1);
				c.splice(idx, 0, g);
			}
		}
	}

	private drawTo(
		rt: THREE.WebGLRenderTarget,
		cam: THREE.Camera,
		scene: THREE.Scene,
		clear: boolean,
	) {
		const r = this.input.renderer;
		const prevRT = r.getRenderTarget();
		const prevAuto = r.autoClear;
		const prevColor = r.getClearColor(new THREE.Color());
		const prevAlpha = r.getClearAlpha();
		try {
			r.setRenderTarget(rt);
			if (clear) {
				r.setClearColor(0x000000, 0);
				r.clear(true, true, true);
			}
			r.autoClear = false;
			r.render(scene, cam);
		} finally {
			r.autoClear = prevAuto;
			r.setClearColor(prevColor, prevAlpha);
			r.setRenderTarget(prevRT);
		}
	}

	private applyCamera(c: NovelCamera) {
		applyPose(
			this.cam,
			c.pose,
			this.input.aspect,
			new THREE.Vector3(c.eye[0], c.eye[1], c.eye[2]),
		);
	}

	/** Render one novel view of the cache at W×H (W/H should equal the photo aspect). */
	renderView(
		camera: NovelCamera,
		width: number,
		height: number,
		opts: ViewRenderOpts = {},
	): RgbdView {
		const r = this.input.renderer;
		this.applyCamera(camera);
		const geoRT = this.rt("geo", width, height);
		const colRT = this.rt("col", width, height);
		this.withTerrain(this.geoMat, () =>
			this.drawTo(geoRT, this.cam, this.scene, true),
		);
		this.withTerrain(this.drapeMat, () =>
			this.drawTo(colRT, this.cam, this.scene, true),
		);
		if (this.splats && opts.splats !== false) {
			this.splats.setTruth(opts.truth ?? 0);
			// sort for this camera now (synchronous sorter), so the draw below uses this view's order
			this.splats.updateMatrixWorld(true);
			this.splats.onBeforeRender(
				r,
				this.splatScene,
				this.cam,
				this.splats.geometry,
				this.splats.material,
				null as unknown as THREE.Group,
			);
			this.drawTo(colRT, this.cam, this.splatScene, false);
		}
		const n = width * height;
		const geo = new Float32Array(4 * n);
		const col = new Float32Array(4 * n);
		r.readRenderTargetPixels(geoRT, 0, 0, width, height, geo);
		r.readRenderTargetPixels(colRT, 0, 0, width, height, col);

		const rgba = new Uint8ClampedArray(4 * n);
		const world = new Float32Array(3 * n);
		const range = new Float32Array(n);
		const observed = new Uint8Array(n);
		const sky = new Uint8Array(n);
		const K = intrinsicsFromPose(camera.pose, this.input.aspect);
		const B = poseBasis(camera.pose);
		const P = poseBasis(this.input.photoPose);
		const PK = intrinsicsFromPose(this.input.photoPose, this.input.aspect);
		const photo = this.input.photoRGBA;
		const drop = this.input.dropMask;
		for (let j = 0; j < height; j++) {
			const src = height - 1 - j; // GL rows are bottom-up
			for (let i = 0; i < width; i++) {
				const k = j * width + i;
				const s = 4 * (src * width + i);
				const rg = geo[s + 3];
				if (rg > 0) {
					range[k] = rg;
					world[3 * k] = geo[s];
					world[3 * k + 1] = geo[s + 1];
					world[3 * k + 2] = geo[s + 2];
				} else {
					world[3 * k] = Number.NaN;
					world[3 * k + 1] = Number.NaN;
					world[3 * k + 2] = Number.NaN;
				}
				const a = col[s + 3];
				rgba[4 * k + 3] = 255;
				if (a >= 0.5) {
					observed[k] = 1;
					// premultiplied over a transparent hole: un-premultiply
					const inv = a > 0 ? 1 / Math.min(1, a) : 0;
					rgba[4 * k] = toSrgb8(col[s] * inv);
					rgba[4 * k + 1] = toSrgb8(col[s + 1] * inv);
					rgba[4 * k + 2] = toSrgb8(col[s + 2] * inv);
				} else if (rg <= 0 && opts.sky !== false) {
					// no DEM here: the photo's own sky along the same direction (translation is negligible at infinity)
					const u = (i + 0.5) / width;
					const v = (j + 0.5) / height;
					const x = (u - K.cx) / K.fx;
					const y = (v - K.cy) / K.fy;
					const d = [0, 1, 2].map(
						(q) => B.right[q] * x - B.up[q] * y + B.forward[q],
					);
					const zc =
						d[0] * P.forward[0] + d[1] * P.forward[1] + d[2] * P.forward[2];
					if (zc <= 0) continue;
					const xc =
						(d[0] * P.right[0] + d[1] * P.right[1] + d[2] * P.right[2]) / zc;
					const yc = -(d[0] * P.up[0] + d[1] * P.up[1] + d[2] * P.up[2]) / zc;
					const pu = PK.cx + PK.fx * xc;
					const pv = PK.cy + PK.fy * yc;
					if (!(pu > 0 && pu < 1 && pv > 0 && pv < 1)) continue;
					if (this.photoRangeAt(pu, pv) > 0) continue; // the photo saw terrain there: not sky
					if (drop) {
						const dx = Math.min(drop.width - 1, Math.floor(pu * drop.width));
						const dy = Math.min(drop.height - 1, Math.floor(pv * drop.height));
						if (drop.data[dy * drop.width + dx]) continue; // a near object against the sky
					}
					const px = Math.min(photo.width - 1, Math.floor(pu * photo.width));
					const py = Math.min(photo.height - 1, Math.floor(pv * photo.height));
					const o = 4 * (py * photo.width + px);
					rgba[4 * k] = photo.data[o];
					rgba[4 * k + 1] = photo.data[o + 1];
					rgba[4 * k + 2] = photo.data[o + 2];
					observed[k] = 1;
					sky[k] = 1;
				}
			}
		}
		return {
			width,
			height,
			camera,
			aspect: this.input.aspect,
			rgba,
			world,
			range,
			observed,
			sky,
		};
	}

	dispose() {
		this.setSplats(null);
		this.geoMat.dispose();
		this.drapeMat.dispose();
		this.photoTex.dispose();
		this.dropTex?.dispose();
		this.photoRT.dispose();
		for (const rt of this.rts.values()) rt.dispose();
		this.rts.clear();
	}
}
