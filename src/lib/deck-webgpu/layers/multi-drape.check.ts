// Checks for layers/multi-drape.ts.
//
// Node (no GPU):  npx tsx src/lib/deck-webgpu/layers/multi-drape.check.ts
//   assembly   the program assembles the way luma's Model does; its binding layout has the camera,
//              the mdrape uniforms, both storage tables, four photo atlases (+ samplers), the
//              range atlas (no sampler: textureLoad) and the mask atlas (+ sampler)
//   relative   slotData's camera-relative matrix M·T(eye) applied to (p − eye) equals M·p
//   tables     the candidate lists: a photo facing away, one beyond the reach and one whose coarse
//              range map says the tile is hidden are not listed; hidden photos (gain 0) and photos
//              not ready are left out; nearest camera first
//   convention photoViewProjection (deck/photo-view.ts, what roll-map feeds DrapePhoto.viewProj)
//              and camera.ts cameraUniforms(photoCamera(...)) project to the same uv
//
// Browser (real WebGPU; any page served by vite, e.g. the lab):
//   await (await import("/src/lib/deck-webgpu/layers/multi-drape.check.ts")).runMultiDrapeCheck()
//   A synthetic valley (one TileMesh with a hill), five solid-colour photos at ground level (range
//   maps rendered by the real geometry pass from each photo camera, read back into a
//   WebGpuDrapeAtlas), drawn by TerrainCore + MultiDrapeCore through the real colour pass (4× MSAA,
//   reversed-Z, resolve) from an oblique view above. Every interior pixel is compared with a CPU
//   twin of the fragment shader (the GLSL of multi-drape-layer.ts, line by line) fed with the
//   view's own geometry pass (position, normal) and the same range maps:
//     expected = terrain·(1 − a) + srgb_decode(blend)·a      (premultiplied over, linear)
//   It also checks that the drape passes the depth test on its own surface everywhere the twin
//   says it should be visible, that sky / no-candidate pixels are untouched, and it reports how
//   many pixels exercised occlusion (vis < 1) and the TOP_K cut (> 4 contenders).
import type { Device, Texture } from "@luma.gl/core";
import type { Pose } from "#/lib/camera";
import type { TileMesh } from "#/lib/deck/terrain-data";
import {
	type CameraUniforms,
	cameraModule,
	cameraUniforms,
	photoCamera,
} from "../camera";
import type { MultiDrapeAtlas } from "./multi-drape";
import {
	buildMultiDrapeTables,
	type DrapePhoto,
	MIN_SIN_INC,
	MULTI_DRAPE_WGSL,
	multiDrapeModule,
	slotData,
	TOP_K,
} from "./multi-drape";

type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------
// shared scene helpers

/** Flat valley with a Gaussian hill, one tile: x ∈ [-2000, 2000], y ∈ [0, 4000]. */
const HILL = { x: 0, y: 1400, h: 70, s: 160 };
function heightAt(x: number, y: number) {
	const dx = x - HILL.x;
	const dy = y - HILL.y;
	return HILL.h * Math.exp(-(dx * dx + dy * dy) / (2 * HILL.s * HILL.s));
}

export function syntheticTile(seg = 96, id = "md-check-tile"): TileMesh {
	const x0 = -2000;
	const y0 = 0;
	const size = 4000;
	const n = seg + 1;
	const positions = new Float32Array(n * n * 3);
	const normals = new Float32Array(n * n * 3);
	const texCoords = new Float32Array(n * n * 2);
	const elev = new Float32Array(n * n);
	const heights = new Float32Array(n * n);
	const h = size / seg;
	for (let j = 0; j < n; j++)
		for (let i = 0; i < n; i++) {
			const k = j * n + i;
			const x = x0 + i * h;
			const y = y0 + j * h;
			const z = heightAt(x, y);
			positions.set([x, y, z], k * 3);
			const gx = (heightAt(x + 1, y) - heightAt(x - 1, y)) / 2;
			const gy = (heightAt(x, y + 1) - heightAt(x, y - 1)) / 2;
			const l = Math.hypot(gx, gy, 1);
			normals.set([-gx / l, -gy / l, 1 / l], k * 3);
			texCoords.set([i / seg, 1 - j / seg], k * 2);
			elev[k] = z;
			heights[k] = z;
		}
	const indices = new Uint32Array(seg * seg * 6);
	let o = 0;
	for (let j = 0; j < seg; j++)
		for (let i = 0; i < seg; i++) {
			const a = j * n + i;
			indices.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], o);
			o += 6;
		}
	return {
		id,
		key: { z: 14, x: 0, y: 0 },
		distance: 0,
		size: n,
		heights,
		sourceZ: 14,
		focus: true,
		seg,
		positions,
		normals,
		texCoords,
		elev,
		indices,
	} as TileMesh;
}

/** A WebGL-style (world, not camera-relative) view-projection whose x / y / w rows are exactly
 * camera.ts's photo camera: viewProjRel · T(−eye). */
function worldViewProj(u: CameraUniforms): number[] {
	const m = u.viewProj;
	const out = m.slice();
	for (let r = 0; r < 4; r++)
		out[12 + r] =
			m[12 + r] - (m[r] * u.eye[0] + m[4 + r] * u.eye[1] + m[8 + r] * u.eye[2]);
	return out;
}

type PhotoSpec = {
	id: string;
	pose: Pose;
	eye: V3;
	gain: number;
	/** sRGB bytes of the solid-colour photo. */
	rgb: V3;
};

/** Photographers on low vantage points around the hill (all look roughly north); a–e and g–i
 * overlap south of the hill so more than TOP_K compete there. */
function photoSpecs(): PhotoSpec[] {
	const at = (x: number, y: number, up = 25): V3 => [x, y, heightAt(x, y) + up];
	return [
		{
			id: "a",
			pose: { yaw: 0, pitch: -9, roll: 0, vfov: 40 },
			eye: at(0, 700),
			gain: 1,
			rgb: [220, 40, 40],
		},
		{
			id: "b",
			pose: { yaw: 20, pitch: -10, roll: 0, vfov: 45 },
			eye: at(-500, 600),
			gain: 1,
			rgb: [40, 200, 60],
		},
		{
			id: "c",
			pose: { yaw: -25, pitch: -8, roll: 2, vfov: 38 },
			eye: at(600, 900),
			gain: 2,
			rgb: [50, 80, 230],
		},
		{
			id: "d",
			pose: { yaw: 5, pitch: -14, roll: 0, vfov: 50 },
			eye: at(150, 1000),
			gain: 0.7,
			rgb: [230, 210, 40],
		},
		{
			id: "e",
			pose: { yaw: -5, pitch: -11, roll: -1, vfov: 42 },
			eye: at(-150, 850),
			gain: 1,
			rgb: [200, 60, 210],
		},
		{
			id: "g",
			pose: { yaw: 10, pitch: -12, roll: 0, vfov: 48 },
			eye: at(-100, 750, 40),
			gain: 1,
			rgb: [40, 200, 200],
		},
		{
			id: "h",
			pose: { yaw: -10, pitch: -10, roll: 1, vfov: 44 },
			eye: at(100, 650, 30),
			gain: 1.2,
			rgb: [240, 140, 30],
		},
		{
			id: "i",
			pose: { yaw: 0, pitch: -13, roll: 0, vfov: 46 },
			eye: at(50, 800, 35),
			gain: 0.9,
			rgb: [120, 120, 120],
		},
		// hidden (gain 0): never listed, never drawn
		{
			id: "f",
			pose: { yaw: 0, pitch: -5, roll: 0, vfov: 40 },
			eye: at(0, 800),
			gain: 0,
			rgb: [255, 255, 255],
		},
	];
}

const RANGE_W = 240;
const RANGE_H = 160; // aspect exactly 1.5, the photos' aspect
const PHOTO_ASPECT = 1.5;

function drapePhotoOf(s: PhotoSpec): DrapePhoto {
	const u = cameraUniforms(
		photoCamera({ pose: s.pose, eye: s.eye, width: RANGE_W, height: RANGE_H }),
	);
	return {
		id: s.id,
		viewProj: worldViewProj(u),
		eye: s.eye,
		minRange: 30,
		gain: s.gain,
		aspect: PHOTO_ASPECT,
		vfov: s.pose.vfov,
	};
}

// ---------------------------------------------------------------------------------------------
// CPU twin of fragmentMain (with solid-colour photos: the texel is the photo's colour)

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};
const mdPow = (x: number, s: number) => (x > 0 ? x ** s : 0);
const srgbDecode = (c: number) =>
	c <= 0.04045 ? c * 0.0773993808 : (c * 0.9478672986 + 0.0521327014) ** 2.4;

type TwinPhoto = {
	slot: Float32Array; // slotData
	rgb: V3; // 0..1 sRGB
};

type TwinOut = {
	rgbSrgb: V3;
	alpha: number;
	/** min distance of any winner's uv to its frame edge (mip bleed guard) */
	minEdge: number;
	contenders: number;
	occluded: boolean;
	winners: number;
};

function twinFragment(
	p: V3,
	n0: V3,
	viewEye: V3,
	list: number[],
	photos: TwinPhoto[],
	range: Float32Array,
	rangeW: number,
	s: {
		opacity: number;
		sharpness: number;
		falloffM: number;
		outline: number;
		reachM: number;
	},
): TwinOut | null {
	const nl = Math.hypot(...n0) || 1;
	const n: V3 = [n0[0] / nl, n0[1] / nl, n0[2] / nl];
	const vd = [p[0] - viewEye[0], p[1] - viewEye[1], p[2] - viewEye[2]];
	const vl = Math.hypot(vd[0], vd[1], vd[2]);
	const view = [vd[0] / vl, vd[1] / vl, vd[2] / vl];
	const topW = new Array(TOP_K).fill(0);
	const topI = new Array(TOP_K).fill(0);
	let wmax = 0;
	let edge = 0;
	let contenders = 0;
	let occluded = false;
	const uvOf = (sl: Float32Array, d: number[]) => {
		const c = [0, 0, 0, 0];
		for (let r = 0; r < 4; r++)
			c[r] = sl[r] * d[0] + sl[4 + r] * d[1] + sl[8 + r] * d[2] + sl[12 + r];
		const w = Math.abs(c[3]) > 1e-6 ? c[3] : 1e-6;
		return [(c[0] / w) * 0.5 + 0.5, 1 - ((c[1] / w) * 0.5 + 0.5), c[3]];
	};
	const seenBy = (x: number, y: number, r: number, slack: number) => {
		const seen = range[y * rangeW + x];
		return seen > 0 && r < seen * 1.015 + 15 + slack ? 1 : 0;
	};
	for (const i of list) {
		const sl = photos[i].slot;
		const eye = [sl[16], sl[17], sl[18], sl[19]];
		const ex = [sl[28], sl[29], sl[30], sl[31]];
		const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
		const r = Math.hypot(d[0], d[1], d[2]);
		if (r < ex[0]) continue;
		const reach = 1 - smoothstep(0.55 * s.reachM, s.reachM, r);
		if (
			mdPow((eye[3] * reach) / (1 + r / s.falloffM), s.sharpness) <=
			topW[TOP_K - 1]
		)
			continue;
		const [u, v, cw] = uvOf(sl, d);
		if (cw <= 0 || u < 0 || v < 0 || u > 1 || v > 1) continue;
		const sinInc = -(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / r;
		const inc = Math.min(1, Math.max(0, sinInc * 3));
		const e2x = Math.min(u, 1 - u) * ex[1];
		const e2y = Math.min(v, 1 - v);
		const feather = smoothstep(0, 0.05, Math.min(e2x, e2y));
		const along = smoothstep(
			0.985,
			0.9995,
			(view[0] * d[0] + view[1] * d[1] + view[2] * d[2]) / r,
		);
		const graze = smoothstep(0.08, 0.3, sinInc) * (1 - along) + along;
		const cover = eye[3] * feather * reach * graze;
		if (cover <= 0) continue;
		const wBase = (cover * (0.25 + 0.75 * inc)) / (1 + r / s.falloffM);
		if (mdPow(wBase, s.sharpness) <= topW[TOP_K - 1]) continue;
		const rr = [sl[24], sl[25], sl[26], sl[27]];
		const slack = (1.5 * r * ex[2]) / Math.max(sinInc, MIN_SIN_INC);
		const tcx = u * rr[2] - 0.5;
		const tcy = v * rr[3] - 0.5;
		const bx = Math.floor(tcx);
		const by = Math.floor(tcy);
		const fx = tcx - bx;
		const fy = tcy - by;
		const cl = (x: number, lo: number, hi: number) =>
			Math.min(hi, Math.max(lo, x));
		const X = (o: number) => cl(rr[0] + bx + o, rr[0], rr[0] + rr[2] - 1);
		const Y = (o: number) => cl(rr[1] + by + o, rr[1], rr[1] + rr[3] - 1);
		const v00 = seenBy(X(0), Y(0), r, slack);
		const v10 = seenBy(X(1), Y(0), r, slack);
		const v01 = seenBy(X(0), Y(1), r, slack);
		const v11 = seenBy(X(1), Y(1), r, slack);
		const vis =
			(v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
		if (vis < 1) occluded = true;
		if (vis <= 0) continue;
		const seen = smoothstep(0, 0.75, vis); // mask all zero: keep = 1
		if (seen <= 0) continue;
		contenders++;
		const w = mdPow(wBase * seen, s.sharpness);
		wmax = Math.max(wmax, cover * seen);
		if (eye[3] > 1.5)
			edge = Math.max(edge, 1 - smoothstep(0, 0.006, Math.min(e2x, e2y)));
		if (w <= topW[TOP_K - 1]) continue;
		let at = TOP_K - 1;
		for (let q = TOP_K - 1; q > 0; q--) {
			if (topW[q - 1] >= w) break;
			topW[q] = topW[q - 1];
			topI[q] = topI[q - 1];
			at = q - 1;
		}
		topW[at] = w;
		topI[at] = i;
	}
	const acc = [0, 0, 0];
	let wsum = 0;
	let minEdge = 1;
	let winners = 0;
	for (let j = 0; j < TOP_K; j++) {
		if (topW[j] <= 0) break;
		const ph = photos[topI[j]];
		const d = [p[0] - ph.slot[16], p[1] - ph.slot[17], p[2] - ph.slot[18]];
		const [u, v] = uvOf(ph.slot, d);
		minEdge = Math.min(minEdge, u, 1 - u, v, 1 - v);
		for (let c = 0; c < 3; c++) acc[c] += ph.rgb[c] * topW[j];
		wsum += topW[j];
		winners++;
	}
	if (wsum <= 0) return null;
	let col: V3 = [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum];
	if (s.outline > 0) {
		const k = edge * s.outline;
		col = [
			col[0] + (1 - col[0]) * k,
			col[1] + (0.72 - col[1]) * k,
			col[2] + (0.45 - col[2]) * k,
		];
	}
	return {
		rgbSrgb: col,
		alpha: s.opacity * Math.min(1, Math.max(0, wmax)),
		minEdge,
		contenders,
		occluded,
		winners,
	};
}

// ---------------------------------------------------------------------------------------------
// Node: assembly + tables (no GPU)

async function assemblyCheck() {
	const { ShaderAssembler } = await import("@luma.gl/shadertools");
	const { getShaderLayoutFromWGSL } = await import("@luma.gl/webgpu");
	const asm = ShaderAssembler.getDefaultShaderAssembler(
		"wgsl" as never,
	) as never as { assembleWGSLShader(p: unknown): { source: string } };
	const r = asm.assembleWGSLShader({
		platformInfo: {
			type: "webgpu",
			shaderLanguage: "wgsl",
			shaderLanguageVersion: 100,
			gpu: "apple",
			features: new Set(),
		},
		source: MULTI_DRAPE_WGSL,
		modules: [cameraModule, multiDrapeModule],
		defines: {},
	});
	const layout = getShaderLayoutFromWGSL(r.source);
	const names = (layout?.bindings ?? []).map((b) => b.name);
	const want = [
		"camera",
		"mdrape",
		"mdrapeSlots",
		"mdrapeLists",
		"mdPhoto0",
		"mdPhoto0Sampler",
		"mdPhoto1",
		"mdPhoto1Sampler",
		"mdPhoto2",
		"mdPhoto2Sampler",
		"mdPhoto3",
		"mdPhoto3Sampler",
		"mdRange",
		"mdMask",
		"mdMaskSampler",
	];
	const missing = want.filter((n) => !names.includes(n));
	const attrs = (layout?.attributes ?? []).map((a) => a.name);
	return {
		ok:
			!missing.length &&
			!names.includes("mdRangeSampler") &&
			["positions", "normals", "tileInfo"].every((a) => attrs.includes(a)),
		bindings: names,
		attributes: attrs,
		missing,
	};
}

/** A CPU-only stand-in for the atlas (cells / coarse / ready), enough for the tables. */
function fakeAtlas(
	ids: string[],
	coarseFar: Record<string, number> = {},
	notReady: string[] = [],
): MultiDrapeAtlas {
	const cols = Math.ceil(Math.sqrt(ids.length));
	return {
		ids,
		cells: ids.map((_, k) => ({
			atlas: 0,
			photo: [0, 0, 0.25, 0.25],
			photoPx: [0, 0, 1024, 683],
			range: [
				(k % cols) * RANGE_W,
				Math.floor(k / cols) * RANGE_H,
				RANGE_W,
				RANGE_H,
			],
		})),
		photo: [],
		range: null as never,
		mask: null as never,
		ready: ids.map((id) => !notReady.includes(id)),
		coarse: ids.map((id) =>
			id in coarseFar
				? {
						width: RANGE_W / 8,
						height: RANGE_H / 8,
						data: new Float32Array((RANGE_W / 8) * (RANGE_H / 8)).fill(
							coarseFar[id],
						),
					}
				: null,
		),
		readyVersion: 1,
		version: 1,
	} as unknown as MultiDrapeAtlas;
}

async function tablesCheck() {
	const tile = syntheticTile(16);
	const base = photoSpecs()[0];
	const mk = (id: string, over: Partial<PhotoSpec>) =>
		drapePhotoOf({ ...base, id, ...over });
	const photos = [
		mk("near", { eye: [0, -200, 2] }),
		mk("far", { eye: [0, -1500, 2] }),
		mk("away", { eye: [0, -200, 2], pose: { ...base.pose, yaw: 180 } }),
		mk("beyond", { eye: [0, -20000, 2] }),
		mk("hiddenByRange", { eye: [300, -300, 2] }),
		mk("gain0", { eye: [0, -300, 2], gain: 0 }),
		mk("notReady", { eye: [0, -300, 2] }),
	];
	const atlas = fakeAtlas(
		photos.map((p) => p.id),
		{ hiddenByRange: 100 },
		["notReady"],
	);
	const t = buildMultiDrapeTables([tile], atlas, photos, 8000);
	const row = t.rows.get(tile.id);
	const listed = row
		? Array.from(t.lists.subarray(row[0], row[0] + row[1])).map(
				(i) => atlas.ids[t.atlasIndex[i]],
			)
		: [];
	const tablesOk =
		JSON.stringify(listed) === JSON.stringify(["near", "far"]) &&
		t.atlasIndex.length === 5; // gain0 and notReady never enter the table

	// camera-relative slot: M'·(p − eye) = M·p
	let relErr = 0;
	for (const ph of photos.slice(0, 3)) {
		const s = slotData(atlas, atlas.ids.indexOf(ph.id), ph);
		const M = ph.viewProj;
		for (const q of [
			[100, 500, 3],
			[-1500, 3000, 40],
			[900, 50, 0],
		]) {
			const d = [q[0] - ph.eye[0], q[1] - ph.eye[1], q[2] - ph.eye[2]];
			for (const r of [0, 1, 3]) {
				const a = s[r] * d[0] + s[4 + r] * d[1] + s[8 + r] * d[2] + s[12 + r];
				const b = M[r] * q[0] + M[4 + r] * q[1] + M[8 + r] * q[2] + M[12 + r];
				relErr = Math.max(relErr, Math.abs(a - b) / Math.max(1, Math.abs(b)));
			}
		}
	}

	// photoViewProjection (roll-map) vs camera.ts (this check's photos): same uv
	let convErr = Number.NaN;
	try {
		const { photoViewProjection } = await import("#/lib/deck/photo-view");
		convErr = 0;
		for (const s of photoSpecs()) {
			const A = Array.from(photoViewProjection(s.pose, s.eye, PHOTO_ASPECT));
			const B = drapePhotoOf(s).viewProj;
			for (const q of [
				[0, 2000, 0],
				[-400, 1500, 30],
				[500, 2500, 10],
			]) {
				const uv = (M: ArrayLike<number>) => {
					const x = M[0] * q[0] + M[4] * q[1] + M[8] * q[2] + M[12];
					const y = M[1] * q[0] + M[5] * q[1] + M[9] * q[2] + M[13];
					const w = M[3] * q[0] + M[7] * q[1] + M[11] * q[2] + M[15];
					return [x / w, y / w];
				};
				const [ax, ay] = uv(A);
				const [bx, by] = uv(B);
				convErr = Math.max(convErr, Math.abs(ax - bx), Math.abs(ay - by));
			}
		}
	} catch (e) {
		console.warn(
			"photoViewProjection import failed (convention check skipped)",
			e,
		);
	}
	return {
		tables: { ok: tablesOk, listed, tablePhotos: t.atlasIndex.length },
		relative: { ok: relErr < 1e-5, relErr },
		convention: { ok: !(convErr > 1e-4), ndcErr: convErr },
	};
}

// ---------------------------------------------------------------------------------------------
// Browser: the real passes on WebGPU

function half(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** rgba16float / rgba32float texture → Float32Array rgba, top-first rows. */
async function readRgba(device: Device, tex: Texture) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
	});
	tex.readBuffer({}, buf);
	const bytes = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const out = new Float32Array(tex.width * tex.height * 4);
	if (tex.format === "rgba32float") {
		const f = new Float32Array(
			bytes.buffer,
			bytes.byteOffset,
			bytes.byteLength / 4,
		);
		const stride = layout.bytesPerRow / 4;
		for (let y = 0; y < tex.height; y++)
			out.set(
				f.subarray(y * stride, y * stride + tex.width * 4),
				y * tex.width * 4,
			);
		return out;
	}
	const u16 = new Uint16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / 2,
	);
	const stride = layout.bytesPerRow / 2;
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = half(u16[y * stride + x]);
	return out;
}

async function solidPhoto(rgb: V3) {
	const c = new OffscreenCanvas(300, 200);
	const g = c.getContext("2d");
	if (!g) throw new Error("no 2d context");
	g.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
	g.fillRect(0, 0, 300, 200);
	return createImageBitmap(c);
}

export type MultiDrapeCheck = {
	ok: boolean;
	checks: Record<string, { ok: boolean; [k: string]: unknown }>;
	stats: unknown;
	errors: string[];
};

export async function runMultiDrapeCheck(
	opts: { width?: number; height?: number } = {},
): Promise<MultiDrapeCheck> {
	const W = opts.width ?? 480;
	const H = opts.height ?? 320;
	const [{ luma }, { webgpuAdapter }, passes, targets, terrainMod, md] =
		await Promise.all([
			import("@luma.gl/core"),
			import("@luma.gl/webgpu"),
			import("../hosts/passes"),
			import("../targets"),
			import("../terrain"),
			import("./multi-drape"),
		]);
	const errors: string[] = [];
	const device = await luma.createDevice({
		id: "multi-drape-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
		debug: true,
		// as device.ts: r32float / rgba32float bound as texture_2d<f32> need it (see multi-drape.ts)
		optionalFeatures: ["float32-filterable"],
	} as never);
	(device.handle as GPUDevice).addEventListener("uncapturederror", (e) =>
		errors.push(String((e as GPUUncapturedErrorEvent).error.message)),
	);
	const checks: MultiDrapeCheck["checks"] = {};
	const assembly = await assemblyCheck();
	checks.assembly = assembly;

	const tile = syntheticTile(96);
	const terrain = new terrainMod.TerrainCore(device, null, "md-check-terrain");
	terrain.setTiles([tile]);
	const frame = { frame: 0, time: performance.now(), view: "world" as const };

	// 1. range maps: the real geometry pass from each photo camera
	const specs = photoSpecs();
	const atlas = new md.WebGpuDrapeAtlas(
		device,
		specs.map((s) => ({
			id: s.id,
			width: 300,
			height: 200,
			rangeW: RANGE_W,
			rangeH: RANGE_H,
		})),
	);
	const rangeMaps: Float32Array[] = [];
	for (const [k, s] of specs.entries()) {
		const g = new targets.GeometryTargets(
			device,
			RANGE_W,
			RANGE_H,
			`md-range-${k}`,
		);
		const pose = photoCamera({
			pose: s.pose,
			eye: s.eye,
			width: RANGE_W,
			height: RANGE_H,
		});
		passes.runGeometryPass({
			device,
			cores: [terrain],
			geometry: g,
			photo: pose,
			frame,
		});
		device.submit();
		const xyzr = await readRgba(device, g.geometry);
		const r = new Float32Array(RANGE_W * RANGE_H);
		for (let i = 0; i < r.length; i++) r[i] = xyzr[i * 4 + 3];
		rangeMaps.push(r);
		atlas.setRange(k, r);
		atlas.setMask(k, null);
		await atlas.setPhoto(k, await solidPhoto(s.rgb));
		g.destroy();
	}
	// the whole range atlas as the shader sees it
	const rangeAtlas = new Float32Array(atlas.range.width * atlas.range.height);
	for (const [k, r] of rangeMaps.entries()) {
		const [x0, y0] = atlas.cells[k].range;
		for (let y = 0; y < RANGE_H; y++)
			rangeAtlas.set(
				r.subarray(y * RANGE_W, (y + 1) * RANGE_W),
				(y0 + y) * atlas.range.width + x0,
			);
	}

	// 2. the view: oblique, from above and behind the photographers
	const viewEye: V3 = [-200, -300, 800];
	const target: V3 = [0, 1400, 0];
	const f = norm(sub(target, viewEye));
	const r0 = norm(cross(f, [0, 0, 1]));
	const view = {
		eye: viewEye,
		forward: f,
		up: cross(r0, f),
		vfov: 45,
		near: 5,
	};
	const color = new targets.ColorTargets(device, W, H, "md-check-color");
	const viewGeo = new targets.GeometryTargets(device, W, H, "md-check-viewgeo");
	const drape = md.createMultiDrape(device, { outline: 1 });
	const photos = specs.map(drapePhotoOf);
	drape.setTiles([tile]);
	drape.setAtlas(atlas);
	drape.setPhotos(photos);

	passes.runGeometryPass({
		device,
		cores: [terrain],
		geometry: viewGeo,
		photo: view,
		frame,
	});
	passes.runColorPass({
		device,
		cores: [terrain],
		geometry: viewGeo,
		color,
		view,
		frame,
	});
	device.submit();
	const geo = await readRgba(device, viewGeo.geometry);
	const nrm = await readRgba(device, viewGeo.normal);
	const bg = await readRgba(device, color.color);
	passes.runColorPass({
		device,
		cores: [terrain, drape],
		geometry: viewGeo,
		color,
		view,
		frame,
	});
	device.submit();
	const out = await readRgba(device, color.color);

	// 3. compare with the twin
	const tables = drape.tables;
	if (!tables) throw new Error("no tables built");
	const row = tables.rows.get(tile.id);
	const list = row
		? Array.from(tables.lists.subarray(row[0], row[0] + row[1]))
		: [];
	const twinPhotos: TwinPhoto[] = tables.atlasIndex.map((k) => ({
		slot: slotData(atlas, k, photos[k]),
		rgb: specs[k].rgb.map((c) => c / 255) as V3,
	}));
	const s = drape.settings;
	const errs: number[] = [];
	let draped = 0;
	let occluded = 0;
	let cut = 0;
	let multi = 0;
	let missing = 0;
	let untouchedBad = 0;
	let untouched = 0;
	const rangeAt = (x: number, y: number) => geo[(y * W + x) * 4 + 3];
	for (let y = 1; y < H - 1; y++)
		for (let x = 1; x < W - 1; x++) {
			const i = (y * W + x) * 4;
			const rc = geo[i + 3];
			if (rc <= 0) {
				// sky: nothing may be drawn
				untouched++;
				if (Math.abs(out[i + 3] - bg[i + 3]) > 1e-3) untouchedBad++;
				continue;
			}
			// interior only: no silhouette / triangle-edge MSAA mixing across a range jump
			let edgePx = false;
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const rn = rangeAt(x + dx, y + dy);
				if (rn <= 0 || Math.abs(rn - rc) > 0.03 * rc) edgePx = true;
			}
			if (edgePx) continue;
			const p: V3 = [geo[i], geo[i + 1], geo[i + 2]];
			const n: V3 = [nrm[i], nrm[i + 1], nrm[i + 2]];
			const t = twinFragment(
				p,
				n,
				viewEye,
				list,
				twinPhotos,
				rangeAtlas,
				atlas.range.width,
				s,
			);
			if (!t) {
				untouched++;
				if (
					Math.max(
						...[0, 1, 2, 3].map((c) => Math.abs(out[i + c] - bg[i + c])),
					) > 2e-3
				)
					untouchedBad++;
				continue;
			}
			if (t.occluded) occluded++;
			if (t.contenders > TOP_K) cut++;
			if (t.winners > 1) multi++;
			// mip bleed at the photo cell's border (coarse mips average in the neighbouring cell)
			if (t.minEdge < 0.08) continue;
			draped++;
			const a = t.alpha;
			let e = 0;
			for (let c = 0; c < 3; c++) {
				const want = bg[i + c] * (1 - a) + srgbDecode(t.rgbSrgb[c]) * a;
				e = Math.max(e, Math.abs(out[i + c] - want));
			}
			if (
				a > 0.5 &&
				Math.abs(out[i] - bg[i]) +
					Math.abs(out[i + 1] - bg[i + 1]) +
					Math.abs(out[i + 2] - bg[i + 2]) <
					1e-4
			)
				missing++; // depth test rejected the drape on its own surface
			errs.push(e);
		}
	errs.sort((a, b) => a - b);
	const q = (f: number) =>
		errs[Math.min(errs.length - 1, Math.floor(f * errs.length))] ?? Number.NaN;
	checks.twin = {
		ok: draped > 3000 && q(0.5) < 0.004 && q(0.99) < 0.03,
		compared: draped,
		median: q(0.5),
		p99: q(0.99),
		max: errs[errs.length - 1],
		multiPhoto: multi,
		occlusion: occluded,
		topKCut: cut,
	};
	checks.depth = {
		ok: missing <= Math.max(5, draped * 0.001),
		rejectedOnOwnSurface: missing,
	};
	checks.untouched = {
		ok: untouchedBad <= untouched * 0.001,
		pixels: untouched,
		changed: untouchedBad,
	};
	checks.tables = {
		ok:
			tables.atlasIndex.length === specs.length - 1 &&
			!tables.atlasIndex.includes(specs.findIndex((x) => x.id === "f")),
		listed: list.length,
		photos: tables.atlasIndex.length,
	};
	checks.errors = { ok: errors.length === 0, errors };

	const stats = { ...drape.stats };
	drape.destroy();
	terrain.destroy();
	atlas.destroy();
	color.destroy();
	viewGeo.destroy();
	device.destroy();
	return {
		ok: Object.values(checks).every((c) => c.ok),
		checks,
		stats,
		errors,
	};
}

function sub(a: V3, b: V3): V3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: V3, b: V3): V3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
function norm(a: V3): V3 {
	const l = Math.hypot(...a) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}

// ---------------------------------------------------------------------------------------------
// Node entry

if (typeof window === "undefined") {
	const assembly = await assemblyCheck();
	const rest = await tablesCheck();
	const all = { assembly, ...rest };
	const ok = Object.values(all).every((c) => c.ok);
	console.log(JSON.stringify({ ok, ...all }, null, 1));
	if (!ok) process.exit(1);
}
