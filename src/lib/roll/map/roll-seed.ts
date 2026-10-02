// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Baked inputs for a roll map whose roll never changes (the landing's sample trip): what the live
// path would download and work out, stored once by scripts/demo/bake-roll-map.mjs from a run of that
// same live path, so a visitor's browser skips the work. RollMapOptions.seed (./roll-map.ts) takes
// any of the three parts below; a part that fails to load or does not match (another tile set,
// another pose) falls back to the live path for that part, so a stale bake costs a download, never
// a wrong map.
//   - terrain: the DEM raster of every tile loadRollTerrain picks (after its downsample), keyed by
//     tile id. Heights are lossless: Mapterhorn decodes and the 2× box filter give multiples of
//     1/HEIGHT_STEPS m, stored as integers through a planar predictor (left + up − up-left) as
//     zigzag varints, then gzip. A tile with any other value is stored as raw float32.
//   - imagery: the basemap image of every tile for one imagery source (loadImagery's mosaics), as
//     WebP blobs (lossy: the only part that is not bit-identical; see the bake script's report).
//   - photos: per photo, the coarse range grid the drape's cull reads back (CoarseRange) and its
//     clear-air + exposure texels (DrapeClear), valid for the stored pose and eye only.
import type { ImagerySource } from "#/lib/deck/terrain-data";
import type { DemRaster, TileKey } from "#/lib/dem";
import type { CoarseRange } from "./drape-atlas";

export type PhotoSeed = {
	/** Pose and eye (roll frame) the seed was made for: any other pose ignores it. */
	pose: { yaw: number; pitch: number; roll: number; vfov: number };
	eye: [number, number, number];
	coarse: CoarseRange;
	/** DrapeClear's 16 texel floats for the photo (clear-air values + exposure gain). */
	clear: Float32Array;
};

export type ImagerySeed = {
	source: ImagerySource;
	/** Encoded image per tile id. */
	tiles: ReadonlyMap<string, Blob>;
};

export type RollMapSeed = {
	terrain?: () => Promise<ReadonlyMap<string, DemRaster>>;
	imagery?: () => Promise<ImagerySeed>;
	photos?: () => Promise<ReadonlyMap<string, PhotoSeed>>;
};

/** Heights are stored as integer multiples of 1 / HEIGHT_STEPS m. */
const HEIGHT_STEPS = 128;
const TERRAIN_MAGIC = "RMT1";
const IMAGERY_MAGIC = "RMI1";
const PHOTOS_MAGIC = "RMP1";

// ---------------- byte helpers ----------------

class Writer {
	private buf = new Uint8Array(1 << 20);
	length = 0;
	private ensure(n: number) {
		if (this.length + n <= this.buf.length) return;
		const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
		next.set(this.buf.subarray(0, this.length));
		this.buf = next;
	}
	u8(v: number) {
		this.ensure(1);
		this.buf[this.length++] = v;
	}
	u16(v: number) {
		this.u8(v & 255);
		this.u8(v >>> 8);
	}
	u32(v: number) {
		this.ensure(4);
		new DataView(this.buf.buffer).setUint32(this.length, v, true);
		this.length += 4;
	}
	f64(v: number) {
		this.ensure(8);
		new DataView(this.buf.buffer).setFloat64(this.length, v, true);
		this.length += 8;
	}
	str(s: string) {
		this.u8(s.length);
		for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
	}
	bytes(b: Uint8Array) {
		this.ensure(b.length);
		this.buf.set(b, this.length);
		this.length += b.length;
	}
	/** Zigzag varint of a signed 32-bit integer. */
	svar(v: number) {
		let u = ((v << 1) ^ (v >> 31)) >>> 0;
		while (u >= 128) {
			this.u8((u & 127) | 128);
			u >>>= 7;
		}
		this.u8(u);
	}
	done() {
		return this.buf.slice(0, this.length);
	}
}

class Reader {
	at = 0;
	private view: DataView;
	constructor(readonly buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	u8() {
		return this.buf[this.at++];
	}
	u16() {
		const v = this.view.getUint16(this.at, true);
		this.at += 2;
		return v;
	}
	u32() {
		const v = this.view.getUint32(this.at, true);
		this.at += 4;
		return v;
	}
	f64() {
		const v = this.view.getFloat64(this.at, true);
		this.at += 8;
		return v;
	}
	str() {
		const n = this.u8();
		const s = String.fromCharCode(...this.buf.subarray(this.at, this.at + n));
		this.at += n;
		return s;
	}
	bytes(n: number) {
		const b = this.buf.subarray(this.at, this.at + n);
		this.at += n;
		return b;
	}
	magic(m: string) {
		// a wrong magic is a stale or foreign file: the caller falls back to the live path
		if (String.fromCharCode(...this.bytes(4)) !== m)
			throw new Error(`roll seed: bad magic (want ${m})`);
	}
}

const tileKeyOf = (r: Reader): TileKey => ({
	z: r.u8(),
	x: r.u32(),
	y: r.u32(),
});

// ---------------- terrain ----------------

/** Planar prediction of sample (x, y) from the decoded integers q of an S × S tile. */
function predict(q: Int32Array, S: number, x: number, y: number) {
	const i = y * S + x;
	if (y === 0) return x === 0 ? 0 : q[i - 1];
	if (x === 0) return q[i - S];
	return q[i - 1] + q[i - S] - q[i - S - 1];
}

/** The terrain layout (uncompressed; the bake gzips it). Tiles are written in map order. */
export function encodeTerrainSeed(
	rasters: ReadonlyMap<string, DemRaster>,
): Uint8Array {
	const w = new Writer();
	for (const c of TERRAIN_MAGIC) w.u8(c.charCodeAt(0));
	w.u32(rasters.size);
	for (const [id, r] of rasters) {
		w.str(id);
		for (const k of [r.key, r.source]) {
			w.u8(k.z);
			w.u32(k.x);
			w.u32(k.y);
		}
		w.u16(r.size);
		const S = r.size;
		const q = new Int32Array(S * S);
		let exact = r.heights.length === S * S;
		for (let i = 0; exact && i < q.length; i++) {
			const v = r.heights[i] * HEIGHT_STEPS;
			exact = Number.isInteger(v) && Math.abs(v) < 2 ** 30;
			q[i] = v;
		}
		w.u8(exact ? 0 : 1);
		if (exact) {
			for (let y = 0; y < S; y++)
				for (let x = 0; x < S; x++) w.svar(q[y * S + x] - predict(q, S, x, y));
		} else {
			w.bytes(
				new Uint8Array(
					r.heights.buffer,
					r.heights.byteOffset,
					r.heights.byteLength,
				).slice(),
			);
		}
	}
	return w.done();
}

/**
 * Decode the terrain layout, yielding to the event loop every few ms so the ~16 M samples of the
 * sample trip never make one long task.
 */
export async function decodeTerrainSeed(
	bytes: Uint8Array,
): Promise<Map<string, DemRaster>> {
	const r = new Reader(bytes);
	r.magic(TERRAIN_MAGIC);
	const n = r.u32();
	const out = new Map<string, DemRaster>();
	let lastYield = performance.now();
	for (let t = 0; t < n; t++) {
		const id = r.str();
		const key = tileKeyOf(r);
		const source = tileKeyOf(r);
		const S = r.u16();
		const mode = r.u8();
		const heights = new Float32Array(S * S);
		if (mode === 0) {
			const q = new Int32Array(S * S);
			const buf = r.buf;
			let at = r.at;
			for (let y = 0; y < S; y++)
				for (let x = 0; x < S; x++) {
					let u = 0;
					let shift = 0;
					let b: number;
					do {
						b = buf[at++];
						u |= (b & 127) << shift;
						shift += 7;
					} while (b & 128);
					const i = y * S + x;
					q[i] = ((u >>> 1) ^ -(u & 1)) + predict(q, S, x, y);
					heights[i] = q[i] / HEIGHT_STEPS;
				}
			r.at = at;
		} else {
			heights.set(
				new Float32Array(r.bytes(S * S * 4).slice().buffer, 0, S * S),
			);
		}
		out.set(id, { key, source, size: S, heights });
		if (performance.now() - lastYield > 8) {
			await new Promise((res) => setTimeout(res, 0));
			lastYield = performance.now();
		}
	}
	return out;
}

// ---------------- imagery ----------------

/** The imagery layout: the source, then per tile its id and encoded bytes. Not compressed again. */
export function encodeImagerySeed(
	source: ImagerySource,
	tiles: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
	const w = new Writer();
	for (const c of IMAGERY_MAGIC) w.u8(c.charCodeAt(0));
	w.str(source);
	w.u32(tiles.size);
	for (const [id, b] of tiles) {
		w.str(id);
		w.u32(b.length);
		w.bytes(b);
	}
	return w.done();
}

export function decodeImagerySeed(
	bytes: Uint8Array,
	type: string,
): ImagerySeed {
	const r = new Reader(bytes);
	r.magic(IMAGERY_MAGIC);
	const source = r.str() as ImagerySource;
	const n = r.u32();
	const tiles = new Map<string, Blob>();
	for (let i = 0; i < n; i++) {
		const id = r.str();
		const len = r.u32();
		tiles.set(
			id,
			new Blob([r.bytes(len) as Uint8Array<ArrayBuffer>], { type }),
		);
	}
	return { source, tiles };
}

// ---------------- photos ----------------

/** The photos layout (uncompressed; the bake gzips it). Floats keep their exact bits. */
export function encodePhotoSeeds(
	photos: ReadonlyMap<string, PhotoSeed>,
): Uint8Array {
	const w = new Writer();
	for (const c of PHOTOS_MAGIC) w.u8(c.charCodeAt(0));
	w.u32(photos.size);
	for (const [id, p] of photos) {
		w.str(id);
		for (const v of [p.pose.yaw, p.pose.pitch, p.pose.roll, p.pose.vfov])
			w.f64(v);
		for (const v of p.eye) w.f64(v);
		w.u16(p.coarse.width);
		w.u16(p.coarse.height);
		w.bytes(new Uint8Array(p.coarse.data.slice().buffer));
		w.u8(p.clear.length);
		w.bytes(new Uint8Array(p.clear.slice().buffer));
	}
	return w.done();
}

export function decodePhotoSeeds(bytes: Uint8Array): Map<string, PhotoSeed> {
	const r = new Reader(bytes);
	r.magic(PHOTOS_MAGIC);
	const n = r.u32();
	const out = new Map<string, PhotoSeed>();
	const f32 = (count: number) =>
		new Float32Array(r.bytes(count * 4).slice().buffer, 0, count);
	for (let i = 0; i < n; i++) {
		const id = r.str();
		const pose = { yaw: r.f64(), pitch: r.f64(), roll: r.f64(), vfov: r.f64() };
		const eye: [number, number, number] = [r.f64(), r.f64(), r.f64()];
		const width = r.u16();
		const height = r.u16();
		const coarse = { width, height, data: f32(width * height) };
		const clear = f32(r.u8());
		out.set(id, { pose, eye, coarse, clear });
	}
	return out;
}

/** Does a photo seed belong to this pose and eye (the bake's own numbers, so exact up to 1e-9)? */
export function photoSeedMatches(
	s: PhotoSeed,
	pose: PhotoSeed["pose"],
	eye: readonly number[],
) {
	const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
	return (
		near(s.pose.yaw, pose.yaw) &&
		near(s.pose.pitch, pose.pitch) &&
		near(s.pose.roll, pose.roll) &&
		near(s.pose.vfov, pose.vfov) &&
		s.eye.every((v, i) => near(v, eye[i]))
	);
}

/** Fetch a file and gunzip it (DecompressionStream). */
export async function fetchGzip(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
	return new Uint8Array(
		await new Response(
			res.body.pipeThrough(new DecompressionStream("gzip")),
		).arrayBuffer(),
	);
}
