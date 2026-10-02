// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The relief field (LOOK_RELIEF), built on the CPU from the DEM tiles each engine already holds and
// uploaded as two RGBA8 textures (look/glsl/relief.ts samples them):
//   field  R sun visibility (soft cast shadow), G sky-view factor, B local curvature (0.5 = planar,
//          > 0.5 ridge), A coverage
//   gen    RG the generalised (≈60 m smoothed) normal's xy × 0.5 + 0.5, A = valid
// over a square ENU extent 12 km ahead of the camera. Shadow and sky view are line sweeps, O(1) per
// texel and direction, instead of the old per-texel ray marches (the former render/relief-field.ts):
//   shadow  the occluder surface propagated one texel at a time away from the sun
//   SVF     8 azimuths, each a max-horizon search along hull pointers (the tangent point of the
//           texel ahead is the next vertex of the upper hull), capped at SVF_R
import type { Texture } from "@luma.gl/core";
import type { EnuFrame } from "../../geodesy";
import { lookGpuOn, trackLook } from "../../gpu/look/opt-in";
import type { ViewStyle } from "../../style/types";
import type { Vec3 } from "../atmosphere";
import type { BlockValues } from "../glsl/block";
import type { REL_BLOCK } from "../glsl/relief";
import { sunColor } from "../sun";
import { type Extent, type HeightTile, rasterizeHeights } from "./heights";

export type ReliefField = {
	res: number;
	extent: Extent;
	field: Uint8Array;
	gen: Uint8Array;
	/** Build time, ms. */
	ms: number;
};

/**
 * The field resident on a WebGPU render device (deck-webgpu/compute-bridge.ts LookBridge.reliefField):
 * the same bytes as ReliefField.field / .gen, already in two rgba8unorm res² textures (row 0 = south =
 * uv.y 0, LINEAR_CLAMP; SAMPLE | COPY_DST | COPY_SRC). Whoever displays them owns them
 * (TerrainStyles.setReliefField destroys them on replace); `read` is the lazy CPU copy (memoised,
 * rejects once the textures are gone), `dispose` frees a field nobody took.
 */
export type ResidentReliefField = {
	res: number;
	extent: Extent;
	textures: { field: Texture; gen: Texture };
	/** Build time (heights + encode + submit), ms. */
	ms: number;
	read(): Promise<ReliefField>;
	dispose(): void;
};

/** A GPU-resident relief build of the same input (null / a rejection = the readback path). */
export type BridgedRelief = (o: {
	tiles: readonly HeightTile[];
	frame: EnuFrame;
	sunDir: Vec3;
	yawDeg: number | null;
}) => Promise<ResidentReliefField | null>;

const RES = 1024;
const HALF = 20000;
/** The extent's centre sits this far ahead of the camera, along the pose yaw snapped to 30°. */
const AHEAD = 12000;
const SVF_R = 3000;
const HOLE = -1e6;

const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** The field for `sunDir`, centred ahead along `yawDeg` (null yaw = on the camera). */
export function buildReliefField(
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	sunDir: Vec3,
	yawDeg: number | null,
): ReliefField {
	const t0 = performance.now();
	const res = RES;
	const a = ((yawDeg ?? 0) * Math.PI) / 180;
	const c =
		yawDeg == null ? [0, 0] : [Math.sin(a) * AHEAD, Math.cos(a) * AHEAD];
	const extent: Extent = [c[0] - HALF, c[1] - HALF, c[0] + HALF, c[1] + HALF];
	const px = (2 * HALF) / res;
	const H = rasterizeHeights(tiles, frame, extent, res, HOLE);
	const field = new Uint8Array(res * res * 4);
	const gen = new Uint8Array(res * res * 4);
	castShadow(H, res, px, sunDir, field);
	skyView(H, res, px, field);
	curvatureAndNormal(H, res, px, field, gen);
	return { res, extent, field, gen, ms: performance.now() - t0 };
}

/** R: soft cast shadow. O = the occluder surface over each texel, propagated away from the sun. */
function castShadow(
	H: Float32Array,
	res: number,
	px: number,
	sun: Vec3,
	out: Uint8Array,
) {
	const hz = Math.hypot(sun[0], sun[1]);
	if (sun[2] <= -0.02 || hz < 1e-4) {
		const v = sun[2] <= -0.02 ? 0 : 255;
		for (let q = 0; q < res * res; q++) out[q * 4] = v;
		return;
	}
	const tanEl = sun[2] / hz;
	// walk along the major axis of the sun's azimuth: the upstream texel is one step toward the sun
	// there, and `slope` texels across it (linearly interpolated)
	const xMajor = Math.abs(sun[0]) >= Math.abs(sun[1]);
	const major = xMajor ? sun[0] : sun[1];
	const slope = (xMajor ? sun[1] : sun[0]) / Math.abs(major);
	const s = major > 0 ? 1 : -1;
	const drop = px * Math.hypot(1, slope) * tanEl;
	const w = Math.max(8, 0.6 * drop);
	const bias = 0.6 + 0.15 * px;
	const O = new Float32Array(res * res);
	// texel (a = along the major axis, b = across) → index a·sa + b·sb
	const sa = xMajor ? 1 : res;
	const sb = xMajor ? res : 1;
	for (let n = 0; n < res; n++) {
		const a = s > 0 ? res - 1 - n : n;
		const au = a + s;
		for (let b = 0; b < res; b++) {
			const q = a * sa + b * sb;
			let o = Number.NEGATIVE_INFINITY;
			const bb = b + slope;
			const b0 = Math.floor(bb);
			if (au >= 0 && au < res && b0 >= 0 && b0 + 1 < res) {
				const f = bb - b0;
				const q0 = au * sa + b0 * sb;
				const q1 = q0 + sb;
				o =
					Math.max(H[q0], O[q0]) * (1 - f) + Math.max(H[q1], O[q1]) * f - drop;
			}
			O[q] = o;
			out[q * 4] = (255 * smooth(-w, w, H[q] + bias - o) + 0.5) | 0;
		}
	}
}

const DIRS = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
	[1, 1],
	[1, -1],
	[-1, 1],
	[-1, -1],
];

/**
 * G: sky-view factor, 1 − mean sin(horizon elevation) over 8 azimuths within SVF_R, swept at half
 * resolution (2×2 means; the 3 km search makes it a smooth term) and upsampled bilinearly.
 */
function skyView(Hf: Float32Array, rf: number, pf: number, out: Uint8Array) {
	const res = rf >> 1;
	const px = pf * 2;
	const N = res * res;
	const H = new Float32Array(N);
	for (let j = 0; j < res; j++)
		for (let i = 0; i < res; i++) {
			const q = 2 * j * rf + 2 * i;
			H[j * res + i] =
				Math.min(Hf[q], Hf[q + 1], Hf[q + rf], Hf[q + rf + 1]) <= HOLE
					? HOLE
					: 0.25 * (Hf[q] + Hf[q + 1] + Hf[q + rf] + Hf[q + rf + 1]);
		}
	const acc = new Float32Array(N);
	const hull = new Int32Array(N);
	for (const [di, dj] of DIRS) {
		const L = px * (di && dj ? Math.SQRT2 : 1);
		// hull points lie on the line p + k·d, k = (r − p) / stride, at distance k·L
		const stride = dj * res + di;
		const kL = L / stride;
		for (let jn = 0; jn < res; jn++) {
			const j = dj > 0 ? res - 1 - jn : jn;
			const qj = j + dj;
			if (qj < 0 || qj >= res) {
				hull.fill(-1, j * res, j * res + res);
				continue;
			}
			for (let in_ = 0; in_ < res; in_++) {
				const i = di > 0 ? res - 1 - in_ : in_;
				const p = j * res + i;
				const qi = i + di;
				if (qi < 0 || qi >= res) {
					hull[p] = -1;
					continue;
				}
				const h0 = H[p];
				let best = p + stride;
				let bh = H[best] - h0;
				let bd = L;
				// walk the hull while the elevation angle grows (compared as bh/bd without dividing)
				for (let r = hull[best]; r >= 0; r = hull[r]) {
					const d = (r - p) * kL;
					if (d > SVF_R) break;
					const dh = H[r] - h0;
					if (dh * bd <= bh * d) break;
					best = r;
					bh = dh;
					bd = d;
				}
				hull[p] = best;
				if (bh > 0) acc[p] += bh / Math.sqrt(bh * bh + bd * bd);
			}
		}
	}
	// half-res texel centres sit at full-res (2i + 0.5): sample acc there, clamped at the borders
	const k = 255 / DIRS.length;
	for (let j = 0; j < rf; j++) {
		const v = Math.min(res - 1, Math.max(0, (j - 0.5) / 2));
		const j0 = Math.min(res - 2, v | 0);
		const fv = v - j0;
		for (let i = 0; i < rf; i++) {
			const u = Math.min(res - 1, Math.max(0, (i - 0.5) / 2));
			const i0 = Math.min(res - 2, u | 0);
			const fu = u - i0;
			const q = j0 * res + i0;
			const a = acc[q] + (acc[q + 1] - acc[q]) * fu;
			const b = acc[q + res] + (acc[q + res + 1] - acc[q + res]) * fu;
			out[(j * rf + i) * 4 + 1] =
				Math.max(0, 255.5 - (a + (b - a) * fv) * k) | 0;
		}
	}
}

/**
 * B: height above the mean of two 8-sample rings (≈60 m and ≈250 m), tanh-squashed around 0.5;
 * A: coverage; gen: the normal differenced over the inner ring's ±≈60 m axis samples (Imhof's
 * generalisation).
 */
function curvatureAndNormal(
	H: Float32Array,
	res: number,
	px: number,
	field: Uint8Array,
	gen: Uint8Array,
) {
	const ra = Math.max(1, Math.round(60 / px));
	const rb = Math.max(3, Math.round(250 / px));
	// ring offsets: axis samples at r texels, diagonal ones at r/√2
	const da = Math.max(1, Math.round(ra / Math.SQRT2));
	const db = Math.max(1, Math.round(rb / Math.SQRT2));
	const ax = ra;
	const ay = ra * res;
	const bx = rb;
	const by = rb * res;
	const dap = da * (res + 1);
	const dam = da * (res - 1);
	const dbp = db * (res + 1);
	const dbm = db * (res - 1);
	const ka = (0.55 / (ra * px * 0.35)) * 0.125;
	const kb = (0.45 / (rb * px * 0.3)) * 0.125;
	const g = 1 / (2 * ra * px);
	for (let j = 0; j < res; j++)
		for (let i = 0; i < res; i++) {
			const q = j * res + i;
			const h0 = H[q];
			field[q * 4 + 2] = 128;
			field[q * 4 + 3] = h0 > HOLE ? 255 : 0;
			if (h0 <= HOLE || i < rb || j < rb || i >= res - rb || j >= res - rb)
				continue;
			const xp = H[q + ax];
			const xm = H[q - ax];
			const yp = H[q + ay];
			const ym = H[q - ay];
			const sa =
				xp + xm + yp + ym + H[q + dap] + H[q - dap] + H[q + dam] + H[q - dam];
			const sb =
				H[q + bx] +
				H[q - bx] +
				H[q + by] +
				H[q - by] +
				H[q + dbp] +
				H[q - dbp] +
				H[q + dbm] +
				H[q - dbm];
			// a hole anywhere drags its ring sum below HOLE / 2
			if (sa < HOLE / 2 || sb < HOLE / 2) continue;
			// tanh(rel) as a Padé approximant, exact at ±3 (clamped there)
			const x = Math.min(
				3,
				Math.max(-3, ka * (8 * h0 - sa) + kb * (8 * h0 - sb)),
			);
			field[q * 4 + 2] =
				(127.5 + (127.5 * x * (27 + x * x)) / (27 + 9 * x * x) + 0.5) | 0;
			const gx = (xm - xp) * g;
			const gy = (ym - yp) * g;
			const l = 0.5 / Math.sqrt(gx * gx + gy * gy + 1);
			gen[q * 4] = (255 * (0.5 + gx * l) + 0.5) | 0;
			gen[q * 4 + 1] = (255 * (0.5 + gy * l) + 0.5) | 0;
			gen[q * 4 + 3] = 255;
		}
}

/**
 * Rebuilds the field when the sun, the snapped yaw or the tile set changes. Shared by both engines:
 * `update` returns the new field (upload it) or null (keep the current one).
 */
export class ReliefController {
	/** The latest field as CPU bytes (CPU / readback paths); null while `resident` is the latest. */
	field: ReliefField | null = null;
	/** The latest field when it was built on the render device (update's `bridged`); else null. */
	resident: ResidentReliefField | null = null;
	private key = "";
	/** Opt-in GPU path (gpu/look, ?lookgpu=1): update returns null and this fires when the field lands. */
	onAsync?: (f: ReliefField | ResidentReliefField) => void;
	private seq = 0;

	/**
	 * The latest field, CPU or resident (what a WebGPU engine hands TerrainStyles.setReliefField). A
	 * resident field whose textures were destroyed (device loss / teardown) is dropped and the next
	 * update rebuilds.
	 */
	get current(): ReliefField | ResidentReliefField | null {
		const r = this.resident;
		const t = r?.textures;
		if (t && (t.field.destroyed || t.gen.destroyed || t.field.device.isLost)) {
			this.resident = null;
			this.key = "";
		}
		return this.resident ?? this.field;
	}

	/** The latest field's bytes: `field`, or the resident field read back (lazily, once). */
	async bytes(): Promise<ReliefField | null> {
		const c = this.current;
		return c && "textures" in c ? c.read() : c;
	}

	update(o: {
		tiles: readonly HeightTile[];
		frame: EnuFrame;
		sunDir: Vec3;
		yawDeg: number | null;
		/**
		 * Build on the render device straight into the textures it samples (deck-webgpu
		 * compute-bridge.ts). Used instead of the GPU readback path when set; null / a rejection
		 * falls back to it. Async like the GPU path (onAsync; the result lands in `resident`).
		 */
		bridged?: BridgedRelief;
	}): ReliefField | null {
		const yaw =
			o.yawDeg == null ? null : (Math.round(o.yawDeg / 30) * 30 + 360) % 360;
		const key = `${o.sunDir.map((v) => v.toFixed(4))},${yaw},${o.tiles.length}`;
		if (key === this.key || !o.tiles.length) return null;
		this.key = key;
		const seq = ++this.seq;
		if (o.bridged || lookGpuOn()) {
			const { tiles, frame, sunDir } = o;
			const readback = () =>
				import("../../gpu/look/hooks").then((m) =>
					m.reliefFieldAsync(tiles, frame, sunDir, yaw),
				);
			const built: Promise<ReliefField | ResidentReliefField | null> = o.bridged
				? o
						.bridged({ tiles, frame, sunDir, yawDeg: yaw })
						.catch((e) => {
							console.warn("[relief] bridged field failed, reading back", e);
							return null;
						})
						.then<ReliefField | ResidentReliefField | null>(
							(f) => f ?? (seq === this.seq ? readback() : null),
						)
				: readback();
			trackLook(
				built
					.then((f) => {
						if (!f) return;
						if (seq !== this.seq) {
							if ("textures" in f) f.dispose();
							return;
						}
						if ("textures" in f) {
							this.resident = f;
							this.field = null;
						} else {
							this.field = f;
							this.resident = null;
						}
						this.onAsync?.(f);
					})
					.catch((e) => console.warn("[relief] async field failed", e)),
			);
			return null;
		}
		this.field = buildReliefField(o.tiles, o.frame, o.sunDir, yaw);
		this.resident = null;
		if (import.meta.env?.DEV)
			console.info(
				`[relief] field ${this.field.res}² in ${this.field.ms.toFixed(0)} ms`,
			);
		return this.field;
	}
}

/** REL_BLOCK values (look/glsl/relief.ts) for a 'swiss' relief, or null; `extent` = the field's once built. */
export function reliefValues(
	style: ViewStyle,
	world: boolean,
	sunDir: Vec3,
	extent: Extent | null = null,
) {
	const r = style.terrain.relief;
	if (r.mode !== "swiss" && r.mode !== "imhof") return null;
	const imhof = r.mode === "imhof";
	return {
		sunDir,
		sunColor: sunColor(sunDir),
		extent: extent ?? [0, 0, 1, 1],
		realism: r.realism,
		generalize: r.generalize,
		curvature: r.curvature,
		// the orbit camera sees the field's edge from above: a wider fade
		edge: world ? 0.22 : 0.08,
		// Imhof relief (look/imhof.ts); all 0 for swiss
		imhof: imhof ? 1 : 0,
		swing: imhof ? r.swing : 0,
		tint: imhof ? r.tint : 0,
		aerial: imhof ? r.aerial : 0,
	} satisfies Partial<BlockValues<typeof REL_BLOCK.fields>>;
}
export type RelValues = NonNullable<ReturnType<typeof reliefValues>>;
