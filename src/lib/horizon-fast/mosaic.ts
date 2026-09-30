/**
 * Float32 DEM mosaics in Web-Mercator pixel space, one per distance ring
 * (fine near the camera, coarse far away), built from Terrarium tiles, plus
 * a max-mipmap pyramid per mosaic for block skipping in the horizon march.
 *
 * Pixel convention (same as geo/terrain.ts): global pixel (gx, gy) at zoom z
 * has its centre at Mercator pixel coordinate (gx + 0.5, gy + 0.5), where the
 * world is `worldPx = 2^z · tileSize` pixels wide. A mosaic stores the window
 * gx ∈ [x0, x0 + width), gy ∈ [y0, y0 + height); local sample coordinate
 * u = X − 0.5 − x0 puts pixel centres on integers.
 */

import {
	MIN_VALID,
	NO_DATA,
	type TileKey,
	type TileValidation,
	tileId,
	validateTile,
} from "../dem";
import { DEG, destination, WGS84 } from "../geodesy";

/**
 * A Terrarium tile source. `load` resolves to size² heights, `null` when the
 * server has no such tile (404), or undefined on a transient failure.
 * `reload` (optional) bypasses any cache; used when a tile fails validation.
 */
export interface TileSource {
	tileSize: number;
	maxZoom: number;
	load(k: TileKey): Promise<Float32Array | null | undefined>;
	reload?(k: TileKey): Promise<Float32Array | null | undefined>;
}

export interface Ring {
	/** Zoom used for this ring. */
	z: number;
	/** Upper distance bound, metres; the ring starts where the previous ends. */
	maxDistance: number;
	/** Finer zoom to use instead when the source has it under the eye. */
	preferZ?: number;
}

/** §3 recommended rings for 512 px Mapterhorn tiles. */
export const DEFAULT_RINGS: Ring[] = [
	{ z: 14, preferZ: 15, maxDistance: 3_000 },
	{ z: 13, maxDistance: 10_000 },
	{ z: 12, maxDistance: 30_000 },
	{ z: 11, maxDistance: 80_000 },
	{ z: 10, maxDistance: 200_000 },
	{ z: 9, maxDistance: 300_000 },
];

/** One zoom coarser everywhere: ¼ of the memory, for phones. */
export const LITE_RINGS: Ring[] = DEFAULT_RINGS.map((r) => ({
	z: r.z - 1,
	maxDistance: r.maxDistance,
}));

export interface MipPyramid {
	/** Level of mips[0]; a level-L cell covers 2^L × 2^L pixels. */
	minLevel: number;
	/**
	 * mips[i][cy * w + cx] = max over pixels [cx·S, cx·S + S) × [cy·S, cy·S + S)
	 * (S = 2^(minLevel + i), an exact partition). A bilinear sample with
	 * floor(u / S) = cx, floor(v / S) = cy also reads the next pixel, so its
	 * bound is the max over cells (cx..cx+1) × (cy..cy+1).
	 */
	mips: Float32Array[];
	widths: number[];
	heights: number[];
}

/** Mip levels used by default (4 px .. 256 px cells). */
export const MIP_MIN_LEVEL = 2;
export const MIP_MAX_LEVEL = 8;

export interface Mosaic {
	z: number;
	tileSize: number;
	/** 2^z · tileSize. */
	worldPx: number;
	x0: number;
	y0: number;
	width: number;
	height: number;
	/** Row-major heights, metres; NO_DATA where unknown. */
	data: Float32Array;
	/** Distance range (m) this mosaic serves. */
	minDistance: number;
	maxDistance: number;
	/** Ground size of one pixel at the eye latitude, metres. */
	cellMeters: number;
	mip?: MipPyramid;
}

/** True where SharedArrayBuffer can be posted to workers (node; COOP+COEP pages). */
export const canShare = () =>
	typeof SharedArrayBuffer !== "undefined" &&
	(typeof (globalThis as { crossOriginIsolated?: boolean })
		.crossOriginIsolated !== "boolean" ||
		(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
			true);

/** Float32Array, backed by a SharedArrayBuffer when `shared`. */
export function allocF32(n: number, shared = false) {
	return shared
		? new Float32Array(new SharedArrayBuffer(n * 4))
		: new Float32Array(n);
}

/** Normalised Web-Mercator coordinates in [0, 1). */
export function mercator(lon: number, lat: number) {
	const s = Math.sin(lat * DEG);
	return {
		x: (lon + 180) / 360,
		y:
			0.5 -
			Math.atanh(Math.max(-0.9999999, Math.min(0.9999999, s))) / (2 * Math.PI),
	};
}

export function cellMeters(lat: number, z: number, tileSize: number) {
	return (2 * Math.PI * WGS84.A * Math.cos(lat * DEG)) / (2 ** z * tileSize);
}

// ---------- tile store ----------

/** Loaded tiles with parent fallback for tiles the source lacks. */
export class TileStore {
	/** Float32Array = loaded, null = does not exist at the source. */
	readonly tiles = new Map<string, Float32Array | null>();
	readonly validation = new Map<string, TileValidation>();
	private readonly inFlight = new Map<string, Promise<void>>();
	private readonly mipCache = new Map<string, Float32Array[]>();

	constructor(
		readonly source: TileSource,
		/** Validate decoded tiles (jump detection + 256 m repair). */
		readonly validate = true,
	) {}

	get tileSize() {
		return this.source.tileSize;
	}

	has(k: TileKey) {
		return this.tiles.has(tileId(k));
	}

	get(k: TileKey) {
		return this.tiles.get(tileId(k));
	}

	/** Loads a tile; on 404 loads ancestors (up to 6 levels) instead. */
	private loadOne(k: TileKey): Promise<void> {
		const id = tileId(k);
		if (this.tiles.has(id)) return Promise.resolve();
		const pending = this.inFlight.get(id);
		if (pending) return pending;
		const p = (async () => {
			if (k.z > this.source.maxZoom) this.tiles.set(id, null);
			else {
				let t = await this.source.load(k);
				if (t && this.validate) {
					let v = validateTile(t, this.tileSize);
					if (v.repaired > 0 && this.source.reload) {
						const t2 = await this.source.reload(k);
						if (t2) {
							const v2 = validateTile(t2, this.tileSize);
							if (v2.repaired < v.repaired) {
								t = t2;
								v = v2;
							}
						}
					}
					if (v.jumps || v.filled) this.validation.set(id, v);
				}
				if (t === undefined) return; // transient; not cached
				this.tiles.set(id, t);
			}
			if (this.tiles.get(id) === null && k.z > 0)
				await this.loadOne({ z: k.z - 1, x: k.x >> 1, y: k.y >> 1 });
		})().finally(() => this.inFlight.delete(id));
		this.inFlight.set(id, p);
		return p;
	}

	async ensure(keys: TileKey[], concurrency = 16) {
		const todo = keys.filter((k) => !this.tiles.has(tileId(k)));
		let next = 0;
		const worker = async () => {
			while (next < todo.length) await this.loadOne(todo[next++]);
		};
		await Promise.all(
			Array.from({ length: Math.min(concurrency, todo.length) }, worker),
		);
	}

	/** Exact-partition max mips of a loaded tile (cached per tile). */
	tileMips(k: TileKey, data: Float32Array, minLevel: number, maxLevel: number) {
		const id = `${tileId(k)}@${minLevel}-${maxLevel}`;
		let m = this.mipCache.get(id);
		if (!m) {
			const T = this.tileSize;
			m = gridMips(data, T, T, minLevel, maxLevel).mips;
			this.mipCache.set(id, m);
		}
		return m;
	}

	/** Drops decoded tiles and mips (e.g. between distant locations). */
	clear() {
		this.tiles.clear();
		this.mipCache.clear();
		this.validation.clear();
	}

	/** Nearest loaded tile or ancestor covering (z, x, y). */
	resolve(k: TileKey) {
		for (let dz = 0; dz <= 8 && dz <= k.z; dz++) {
			const t = this.tiles.get(`${k.z - dz}/${k.x >> dz}/${k.y >> dz}`);
			if (t) return { data: t, dz };
		}
		return undefined;
	}

	/** Pixel (gx, gy) at zoom z, from the tile or an ancestor (nearest). */
	pixel(z: number, gx: number, gy: number) {
		const T = this.tileSize;
		const tx = Math.floor(gx / T);
		const ty = Math.floor(gy / T);
		const r = this.resolve({ z, x: tx, y: ty });
		if (!r) return NO_DATA;
		const s = 2 ** r.dz;
		const px = Math.floor(gx / s) - (tx >> r.dz) * T;
		const py = Math.floor(gy / s) - (ty >> r.dz) * T;
		return r.data[py * T + px];
	}

	/** Bilinear height at lon/lat from zoom-z tiles (slow path; for snapping). */
	heightAt(lon: number, lat: number, z: number) {
		const m = mercator(lon, lat);
		const w = 2 ** z * this.tileSize;
		const px = m.x * w - 0.5;
		const py = m.y * w - 0.5;
		const x0 = Math.floor(px);
		const y0 = Math.floor(py);
		const fx = px - x0;
		const fy = py - y0;
		const h00 = this.pixel(z, x0, y0);
		const h10 = this.pixel(z, x0 + 1, y0);
		const h01 = this.pixel(z, x0, y0 + 1);
		const h11 = this.pixel(z, x0 + 1, y0 + 1);
		return (
			(h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
		);
	}
}

// ---------- rings and windows ----------

export interface RingSpan {
	z: number;
	minDistance: number;
	maxDistance: number;
}

/**
 * Resolves rings to concrete zooms and distance spans clipped to
 * [minDistance, maxDistance]. `preferZ` is used when the store has that
 * tile under the eye (probing it loads it).
 */
export async function resolveRings(
	rings: Ring[],
	lat: number,
	lon: number,
	maxDistance: number,
	store?: TileStore,
): Promise<RingSpan[]> {
	const out: RingSpan[] = [];
	let lo = 0;
	for (const r of rings) {
		if (lo >= maxDistance) break;
		let z = r.z;
		if (r.preferZ !== undefined && store) {
			const m = mercator(lon, lat);
			const n = 2 ** r.preferZ;
			const k = {
				z: r.preferZ,
				x: Math.floor(m.x * n),
				y: Math.floor(m.y * n),
			};
			if (r.preferZ <= store.source.maxZoom) {
				await store.ensure([k]);
				if (store.get(k)) z = r.preferZ;
			}
		}
		out.push({
			z,
			minDistance: lo,
			maxDistance: Math.min(r.maxDistance, maxDistance),
		});
		lo = r.maxDistance;
	}
	if (lo < maxDistance && out.length)
		out[out.length - 1].maxDistance = maxDistance;
	return out;
}

export interface PixelWindow {
	z: number;
	x0: number;
	y0: number;
	width: number;
	height: number;
}

/**
 * Integer pixel window (zoom z) covering the part of the ring
 * [minDistance, maxDistance] swept by azimuths [az0, az1] (degrees,
 * az1 − az0 ≥ 360 for the full circle), padded by `padMeters` + 3 px.
 * Great circles curve in Mercator, so the bbox is taken over sampled
 * destination points.
 */
export function ringWindow(
	lat: number,
	lon: number,
	span: RingSpan,
	tileSize: number,
	az0 = 0,
	az1 = 360,
	padMeters = 0,
	/** Align origin and size to this many pixels (mip tile reuse). */
	align = 1 << MIP_MAX_LEVEL,
): PixelWindow {
	const w = 2 ** span.z * tileSize;
	const cell = cellMeters(lat, span.z, tileSize);
	const full = az1 - az0 >= 360;
	const nA = full ? 72 : Math.max(2, Math.ceil((az1 - az0) / 2) + 1);
	const nR = 12;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const add = (la: number, lo: number) => {
		const m = mercator(lo, la);
		minX = Math.min(minX, m.x * w);
		maxX = Math.max(maxX, m.x * w);
		minY = Math.min(minY, m.y * w);
		maxY = Math.max(maxY, m.y * w);
	};
	const azs: number[] = [];
	for (let i = 0; i < nA; i++)
		azs.push(az0 + ((full ? 360 : az1 - az0) * i) / (full ? nA : nA - 1));
	// Cardinal directions inside the sector bound the bbox.
	if (!full)
		for (let c = Math.ceil(az0 / 90) * 90; c <= az1; c += 90) azs.push(c);
	for (const az of azs)
		for (let j = 0; j <= nR; j++) {
			const d =
				span.minDistance + ((span.maxDistance - span.minDistance) * j) / nR;
			const p = destination(lat, lon, az, d);
			add(p.lat, p.lon);
		}
	if (!full) add(lat, lon);
	// Chords between sampled azimuths cut inside the arc: pad by the sagitta.
	const dA = full ? 360 / nA : (az1 - az0) / Math.max(1, nA - 1);
	const sag = span.maxDistance * (1 - Math.cos((dA * DEG) / 2));
	const pad = Math.ceil((padMeters + sag) / cell) + 3;
	const A = Math.max(1, align);
	const x0 = Math.floor((Math.floor(minX - 0.5) - pad) / A) * A;
	const y0 = Math.max(0, Math.floor((Math.floor(minY - 0.5) - pad) / A) * A);
	const x1 = Math.ceil((Math.ceil(maxX + 0.5) + pad + 1) / A) * A;
	const y1 = Math.min(w, Math.ceil((Math.ceil(maxY + 0.5) + pad + 1) / A) * A);
	return { z: span.z, x0, y0, width: x1 - x0, height: y1 - y0 };
}

export function windowTiles(win: PixelWindow, tileSize: number): TileKey[] {
	const n = 2 ** win.z;
	const keys: TileKey[] = [];
	const tx0 = Math.floor(win.x0 / tileSize);
	const tx1 = Math.floor((win.x0 + win.width - 1) / tileSize);
	const ty0 = Math.max(0, Math.floor(win.y0 / tileSize));
	const ty1 = Math.min(n - 1, Math.floor((win.y0 + win.height - 1) / tileSize));
	for (let ty = ty0; ty <= ty1; ty++)
		for (let tx = tx0; tx <= tx1; tx++)
			keys.push({ z: win.z, x: ((tx % n) + n) % n, y: ty });
	return keys;
}

/**
 * Copies the store's tiles into a window (ancestors upsampled, nearest).
 * With `mips`, also assembles the max-mipmap from cached per-tile mips
 * (computed from the pixels only for fallback / missing tiles).
 */
export function buildMosaic(
	store: TileStore,
	win: PixelWindow,
	span: RingSpan,
	lat: number,
	mips = false,
	/** Back data and mips by SharedArrayBuffers (see canShare). */
	shared = false,
): Mosaic {
	const T = store.tileSize;
	const n = 2 ** win.z;
	const data = allocF32(win.width * win.height, shared);
	const fillRect = (gx0: number, gx1: number, gy0: number, gy1: number) => {
		for (let gy = gy0; gy < gy1; gy++) {
			const row = (gy - win.y0) * win.width - win.x0;
			data.fill(NO_DATA, row + gx0, row + gx1);
		}
	};
	const tx0 = Math.floor(win.x0 / T);
	const tx1 = Math.floor((win.x0 + win.width - 1) / T);
	const ty0 = Math.floor(win.y0 / T);
	const ty1 = Math.floor((win.y0 + win.height - 1) / T);
	const maxL = Math.min(MIP_MAX_LEVEL, Math.log2(T) | 0);
	const A = 1 << maxL;
	const mip =
		mips && win.x0 % A === 0 && win.y0 % A === 0
			? emptyMips(win.width, win.height, MIP_MIN_LEVEL, maxL, shared)
			: undefined;
	/** Rects whose mips must come from the pixels (fallback / no data). */
	const dataRects: number[][] = [];
	for (let ty = ty0; ty <= ty1; ty++) {
		for (let tx = tx0; tx <= tx1; tx++) {
			// Overlap of this tile with the window, in global pixels.
			const gx0 = Math.max(win.x0, tx * T);
			const gx1 = Math.min(win.x0 + win.width, (tx + 1) * T);
			const gy0 = Math.max(win.y0, ty * T);
			const gy1 = Math.min(win.y0 + win.height, (ty + 1) * T);
			const key = { z: win.z, x: ((tx % n) + n) % n, y: ty };
			const r = ty >= 0 && ty < n ? store.resolve(key) : undefined;
			if (!r) {
				fillRect(gx0, gx1, gy0, gy1);
				if (mip)
					dataRects.push([
						gx0 - win.x0,
						gx1 - win.x0,
						gy0 - win.y0,
						gy1 - win.y0,
					]);
				continue;
			}
			if (mip) {
				if (r.dz === 0) {
					const tm = store.tileMips(key, r.data, mip.minLevel, maxL);
					for (let i = 0; i < mip.mips.length; i++) {
						const S = 1 << (mip.minLevel + i);
						const tw = T / S;
						const mw = mip.widths[i];
						const cx0 = (gx0 - tx * T) / S;
						const ncx = Math.ceil((gx1 - gx0) / S);
						const mx0 = (gx0 - win.x0) / S;
						const cy0 = Math.floor((gy0 - ty * T) / S);
						const ncy = Math.ceil((gy1 - gy0) / S);
						const my0 = Math.floor((gy0 - win.y0) / S);
						for (let j = 0; j < ncy && my0 + j < mip.heights[i]; j++) {
							const src = (cy0 + j) * tw + cx0;
							mip.mips[i].set(
								tm[i].subarray(src, src + ncx),
								(my0 + j) * mw + mx0,
							);
						}
					}
				} else
					dataRects.push([
						gx0 - win.x0,
						gx1 - win.x0,
						gy0 - win.y0,
						gy1 - win.y0,
					]);
			}
			if (r.dz === 0) {
				for (let gy = gy0; gy < gy1; gy++) {
					const src = (gy - ty * T) * T + (gx0 - tx * T);
					data.set(
						r.data.subarray(src, src + (gx1 - gx0)),
						(gy - win.y0) * win.width + (gx0 - win.x0),
					);
				}
			} else {
				const s = 2 ** r.dz;
				const ox = (key.x >> r.dz) * T;
				const oy = (ty >> r.dz) * T;
				const shift = (tx - key.x) * T; // world wrap
				for (let gy = gy0; gy < gy1; gy++) {
					const py = Math.min(T - 1, Math.floor(gy / s) - oy);
					const row = (gy - win.y0) * win.width - win.x0;
					for (let gx = gx0; gx < gx1; gx++) {
						const px = Math.min(T - 1, Math.floor((gx - shift) / s) - ox);
						data[row + gx] = r.data[py * T + px];
					}
				}
			}
		}
	}
	const m: Mosaic = {
		z: win.z,
		tileSize: T,
		worldPx: n * T,
		x0: win.x0,
		y0: win.y0,
		width: win.width,
		height: win.height,
		data,
		minDistance: span.minDistance,
		maxDistance: span.maxDistance,
		cellMeters: cellMeters(lat, win.z, T),
	};
	if (mip) {
		for (const [a, b, c, d] of dataRects)
			rectMips(data, win.width, win.height, mip, a, b, c, d);
		m.mip = mip;
	} else if (mips) m.mip = buildMips(m);
	return m;
}

function emptyMips(
	W: number,
	H: number,
	minLevel: number,
	maxLevel: number,
	shared = false,
): MipPyramid {
	const mips: Float32Array[] = [];
	const widths: number[] = [];
	const heights: number[] = [];
	for (let L = minLevel; L <= maxLevel; L++) {
		const w = Math.ceil(W / (1 << L));
		const h = Math.ceil(H / (1 << L));
		mips.push(allocF32(w * h, shared));
		widths.push(w);
		heights.push(h);
	}
	return { minLevel, mips, widths, heights };
}

/**
 * Fills mip cells covering pixel rect [x0, x1) × [y0, y1) from the pixels
 * (level minLevel) and the level below (higher levels). Rect edges must be
 * multiples of the coarsest cell size, or the grid edge.
 */
function rectMips(
	d: Float32Array,
	W: number,
	H: number,
	mip: MipPyramid,
	x0: number,
	x1: number,
	y0: number,
	y1: number,
) {
	for (let i = 0; i < mip.mips.length; i++) {
		const S = 1 << (mip.minLevel + i);
		const w = mip.widths[i];
		const out = mip.mips[i];
		const cx0 = Math.floor(x0 / S);
		const cx1 = Math.ceil(x1 / S);
		const cy0 = Math.floor(y0 / S);
		const cy1 = Math.ceil(y1 / S);
		if (i === 0) {
			for (let cy = cy0; cy < cy1; cy++)
				for (let cx = cx0; cx < cx1; cx++) {
					let mx = Number.NEGATIVE_INFINITY;
					const ya = cy * S;
					const yb = Math.min(H, ya + S);
					const xa = cx * S;
					const xb = Math.min(W, xa + S);
					for (let y = ya; y < yb; y++) {
						const row = y * W;
						for (let x = xa; x < xb; x++) {
							const v = d[row + x];
							if (v > mx) mx = v;
						}
					}
					out[cy * w + cx] = mx;
				}
		} else {
			const prev = mip.mips[i - 1];
			const pw = mip.widths[i - 1];
			const ph = mip.heights[i - 1];
			for (let cy = cy0; cy < cy1; cy++)
				for (let cx = cx0; cx < cx1; cx++) {
					const a = 2 * cx;
					const b = Math.min(pw - 1, a + 1);
					const c = 2 * cy;
					const e = Math.min(ph - 1, c + 1);
					out[cy * w + cx] = Math.max(
						prev[c * pw + a],
						prev[c * pw + b],
						prev[e * pw + a],
						prev[e * pw + b],
					);
				}
		}
	}
}

/** Exact-partition max mips of a W×H grid (see MipPyramid). */
export function gridMips(
	d: Float32Array,
	W: number,
	H: number,
	minLevel = MIP_MIN_LEVEL,
	maxLevel = MIP_MAX_LEVEL,
): MipPyramid {
	const S = 1 << minLevel;
	const w0 = Math.ceil(W / S);
	// Row pass: rm[y * w0 + cx] = max d[y][cx·S .. cx·S + S).
	const rm = new Float32Array(H * w0);
	for (let y = 0; y < H; y++) {
		const row = y * W;
		for (let cx = 0; cx < w0; cx++) {
			const a = cx * S;
			const b = Math.min(W, a + S);
			let mx = d[row + a];
			for (let x = a + 1; x < b; x++) {
				const v = d[row + x];
				if (v > mx) mx = v;
			}
			rm[y * w0 + cx] = mx;
		}
	}
	const mip = emptyMips(W, H, minLevel, maxLevel);
	const first = mip.mips[0];
	const h0 = mip.heights[0];
	for (let cy = 0; cy < h0; cy++) {
		const a = cy * S;
		const b = Math.min(H, a + S);
		for (let cx = 0; cx < w0; cx++) {
			let mx = rm[a * w0 + cx];
			for (let y = a + 1; y < b; y++) {
				const v = rm[y * w0 + cx];
				if (v > mx) mx = v;
			}
			first[cy * w0 + cx] = mx;
		}
	}
	// Higher levels from the level below (whole grid).
	for (let i = 1; i < mip.mips.length; i++) mipLevelFromBelow(mip, i);
	return mip;
}

function mipLevelFromBelow(mip: MipPyramid, i: number) {
	const prev = mip.mips[i - 1];
	const pw = mip.widths[i - 1];
	const ph = mip.heights[i - 1];
	const out = mip.mips[i];
	const w = mip.widths[i];
	const h = mip.heights[i];
	for (let cy = 0; cy < h; cy++) {
		const c = 2 * cy;
		const e = Math.min(ph - 1, c + 1);
		for (let cx = 0; cx < w; cx++) {
			const a = 2 * cx;
			const b = Math.min(pw - 1, a + 1);
			out[cy * w + cx] = Math.max(
				prev[c * pw + a],
				prev[c * pw + b],
				prev[e * pw + a],
				prev[e * pw + b],
			);
		}
	}
}

/** Max-mipmap of a mosaic straight from its pixels. */
export function buildMips(
	m: Mosaic,
	minLevel = MIP_MIN_LEVEL,
	maxLevel = MIP_MAX_LEVEL,
): MipPyramid {
	return gridMips(m.data, m.width, m.height, minLevel, maxLevel);
}

export interface MosaicOptions {
	rings?: Ring[];
	maxDistance?: number;
	/** Azimuth sector (degrees) the mosaics must cover; default full circle. */
	az0?: number;
	az1?: number;
	/** Extra window padding, metres (peak snapping near sector edges). */
	padMeters?: number;
	/** Build the max-mipmap now (else the march builds it on first use). */
	mips?: boolean;
	/** SharedArrayBuffer-backed mosaics (for scripts/lib/horizon-fast/pool.ts HorizonPool, without copies). */
	shared?: boolean;
	concurrency?: number;
}

/** Tile keys needed for the mosaics around a point. */
export function mosaicTileKeys(
	lat: number,
	lon: number,
	spans: RingSpan[],
	tileSize: number,
	opts: MosaicOptions = {},
) {
	return spans.flatMap((s) =>
		windowTiles(
			ringWindow(lat, lon, s, tileSize, opts.az0, opts.az1, opts.padMeters),
			tileSize,
		),
	);
}

/** Loads tiles (through `store`) and builds one mosaic per ring. */
export async function loadMosaics(
	lat: number,
	lon: number,
	store: TileStore,
	opts: MosaicOptions = {},
): Promise<Mosaic[]> {
	const spans = await resolveRings(
		opts.rings ?? DEFAULT_RINGS,
		lat,
		lon,
		opts.maxDistance ?? 150_000,
		store,
	);
	await store.ensure(
		mosaicTileKeys(lat, lon, spans, store.tileSize, opts),
		opts.concurrency,
	);
	return buildMosaics(lat, lon, store, spans, opts);
}

/** Builds mosaics from already-loaded tiles (synchronous). */
export function buildMosaics(
	lat: number,
	lon: number,
	store: TileStore,
	spans: RingSpan[],
	opts: MosaicOptions = {},
): Mosaic[] {
	return spans.map((s) => {
		return buildMosaic(
			store,
			ringWindow(
				lat,
				lon,
				s,
				store.tileSize,
				opts.az0,
				opts.az1,
				opts.padMeters,
			),
			s,
			lat,
			opts.mips,
			opts.shared,
		);
	});
}

/** Bilinear height at lon/lat from a mosaic; NaN outside it. */
export function mosaicHeight(m: Mosaic, lon: number, lat: number) {
	const p = mercator(lon, lat);
	const u = p.x * m.worldPx - 0.5 - m.x0;
	const v = p.y * m.worldPx - 0.5 - m.y0;
	if (!(u >= 0 && v >= 0 && u < m.width - 1 && v < m.height - 1))
		return Number.NaN;
	const x0 = u | 0;
	const y0 = v | 0;
	const fx = u - x0;
	const fy = v - y0;
	const i = y0 * m.width + x0;
	const d = m.data;
	const h =
		(d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) +
		(d[i + m.width] * (1 - fx) + d[i + m.width + 1] * fx) * fy;
	return h < MIN_VALID ? Number.NaN : h;
}

/** Mosaic serving distance d (the ring containing it). */
export function mosaicFor(mosaics: Mosaic[], d: number) {
	for (const m of mosaics) if (d <= m.maxDistance) return m;
	return mosaics[mosaics.length - 1];
}
