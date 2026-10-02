// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WP-F: swisstopo surface/terrain model streaming — STAC resolve + minimal Cloud-Optimised GeoTIFF range reader.
//
// One API (openCog → CogHeader → readWindow / pickLevel) over a small TIFF/BigTIFF IFD parser, tiled/stripped layouts,
// compression none / LZW (5) / Deflate (8, 32946), predictor 1 / 2 / 3, float32/int16/uint16/… samples.
// That is exactly what swisstopo's COGs use (measured 2026-09-29: swissSURFACE3D Raster and swissALTI3D are
// float32, LZW, predictor 1, 512² resp. 128² internal tiles, nodata -9999, CRS LV95 / EPSG:2056). Plain
//     `fetch` with Range by default.
//
// Transport: data.geo.admin.ch sends `Access-Control-Allow-Origin: *`, answers the `Range` preflight
// (`access-control-allow-headers: range`) and returns 206 partial content, so this runs unchanged in the
// browser. Node (probe/eval scripts) injects a caching RangeFetcher.
//
// Data: swisstopo OGD (free incl. commercial use; attribution "© swisstopo").

import { LV95_PROJ_DEFINITION } from "../../geo/lv95";

// ---------------------------------------------------------------- LV95

const SEC = 3600;

/**
 * WGS84 → LV95 (E, N metres), swisstopo "approximate formulas" (≈1 m). Good enough for a 2 m DSM used as
 * an occluder: GPS eye error is 7–37 m on the evaluation set.
 */
export function wgs84ToLv95(lat: number, lon: number): [number, number] {
	const p = (lat * SEC - 169028.66) / 10000;
	const l = (lon * SEC - 26782.5) / 10000;
	const E =
		2600072.37 +
		211455.93 * l -
		10938.51 * l * p -
		0.36 * l * p * p -
		44.54 * l * l * l;
	const N =
		1200147.07 +
		308807.95 * p +
		3745.25 * l * l +
		76.63 * p * p -
		194.56 * l * l * p +
		119.79 * p * p * p;
	return [E, N];
}

/**
 * LV95 → WGS84 (lat, lon degrees), swisstopo approximate inverse (≈0.1″; up to about 4 m from the
 * rigorous EPSG:2056 transform over Switzerland, against under 1 m for the forward formulas).
 */
export function lv95ToWgs84(E: number, N: number): [number, number] {
	const y = (E - 2600000) / 1e6;
	const x = (N - 1200000) / 1e6;
	const l =
		2.6779094 +
		4.728982 * y +
		0.791484 * y * x +
		0.1306 * y * x * x -
		0.0436 * y * y * y;
	const p =
		16.9023892 +
		3.238272 * x -
		0.270978 * y * y -
		0.002528 * x * x -
		0.0447 * y * y * x -
		0.014 * x * x * x;
	return [(p * 100) / 36, (l * 100) / 36];
}

/** Rigorous EPSG:2056 transforms, same argument and result order as the approximate pair above. */
export type RigorousLv95 = {
	wgs84ToLv95: (lat: number, lon: number) => [number, number];
	lv95ToWgs84: (E: number, N: number) => [number, number];
};

let rigorousLv95Promise: Promise<RigorousLv95> | undefined;

/**
 * Lazily loads the rigorous path (@math.gl/proj4: Swiss oblique Mercator on Bessel plus the EPSG
 * 3-parameter Helmert; the approximate inverse above is up to about 4 m off). The dynamic import keeps
 * the projection code out of every eager chunk. Use it where metres matter (for example exporting
 * LV95 coordinates); the approximate pair stays the default for the 2 m DSM occluder, which is
 * about 60x cheaper per point.
 */
export function loadRigorousLv95(): Promise<RigorousLv95> {
	rigorousLv95Promise ??= import("@math.gl/proj4").then(({ Projection }) => {
		const projection = new Projection({
			from: "EPSG:4326",
			to: LV95_PROJ_DEFINITION,
		});
		return {
			wgs84ToLv95: (lat, lon) => {
				const [E, N] = projection.project([lon, lat]);
				return [E, N];
			},
			lv95ToWgs84: (E, N) => {
				const [lon, lat] = projection.unproject([E, N]);
				return [lat, lon];
			},
		};
	});
	return rigorousLv95Promise;
}

/** Rough LV95 extent of Switzerland + Liechtenstein (swisstopo tile coverage). */
export function inSwissExtent(lat: number, lon: number): boolean {
	if (lat < 45.7 || lat > 47.9 || lon < 5.8 || lon > 10.6) return false;
	const [E, N] = wgs84ToLv95(lat, lon);
	return E > 2480000 && E < 2840000 && N > 1070000 && N < 1300000;
}

// ---------------------------------------------------------------- transport

/** Fetch bytes [start, end] (inclusive) of url. */
export type RangeFetcher = (
	url: string,
	start: number,
	end: number,
	signal?: AbortSignal,
) => Promise<Uint8Array>;

/** Transfer accounting (bytes = payload bytes received; ms = wall time of the whole load). */
export type FetchStats = {
	requests: number;
	bytes: number;
	stacRequests: number;
	stacBytes: number;
};
export const newStats = (): FetchStats => ({
	requests: 0,
	bytes: 0,
	stacRequests: 0,
	stacBytes: 0,
});

export const httpRangeFetcher: RangeFetcher = async (
	url,
	start,
	end,
	signal,
) => {
	const r = await fetch(url, {
		headers: { Range: `bytes=${start}-${end}` },
		signal,
	});
	if (r.status !== 206 && r.status !== 200)
		throw new Error(`${url}: HTTP ${r.status}`);
	const buf = new Uint8Array(await r.arrayBuffer());
	// a server ignoring Range (200) sends the whole file: slice what was asked
	return r.status === 200 ? buf.subarray(start, end + 1) : buf;
};

/** JSON GET (STAC). Injectable for node caching. */
export type JsonFetcher = (
	url: string,
	signal?: AbortSignal,
) => Promise<unknown>;
export const httpJsonFetcher: JsonFetcher = async (url, signal) => {
	const r = await fetch(url, { signal });
	if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
	return r.json();
};

// ---------------------------------------------------------------- STAC

export const STAC_ROOT = "https://data.geo.admin.ch/api/stac/v0.9";
export const DSM_COLLECTION = "ch.swisstopo.swisssurface3d-raster";
export const DTM_COLLECTION = "ch.swisstopo.swissalti3d";

export type SwissTile = {
	/** LV95 km of the lower-left corner, e.g. 2624, 1172 ⇒ E 2624000–2625000, N 1172000–1173000. */
	kx: number;
	ky: number;
	year: number;
	/** Asset ground sampling distance (m): 0.5 (DSM, DTM) or 2 (DTM). */
	gsd: number;
	href: string;
};

type StacAsset = { href: string; type?: string; "eo:gsd"?: number };
type StacItem = {
	id: string;
	properties?: { datetime?: string };
	assets: Record<string, StacAsset>;
};
type StacPage = {
	features?: StacItem[];
	links?: { rel: string; href: string }[];
};

/**
 * All items of `collection` intersecting the WGS84 bbox, newest year per km tile, one COG asset per item
 * (the gsd closest to `gsd`). Follows `next` links.
 */
export async function stacTiles(
	collection: string,
	bbox: [number, number, number, number],
	gsd: number,
	opts: { json?: JsonFetcher; signal?: AbortSignal; stats?: FetchStats } = {},
): Promise<SwissTile[]> {
	const json = opts.json ?? httpJsonFetcher;
	let url: string | undefined =
		`${STAC_ROOT}/collections/${collection}/items?bbox=${bbox.map((v) => v.toFixed(6)).join(",")}&limit=100`;
	const best = new Map<string, SwissTile>();
	for (let page = 0; url && page < 20; page++) {
		const j = (await json(url, opts.signal)) as StacPage;
		if (opts.stats) {
			opts.stats.stacRequests++;
			opts.stats.stacBytes += JSON.stringify(j).length;
		}
		for (const it of j.features ?? []) {
			const m = it.id.match(/_(\d{4})_(\d{4})-(\d{4})$/);
			if (!m) continue;
			const year = Number(m[1]);
			const kx = Number(m[2]);
			const ky = Number(m[3]);
			let pick: SwissTile | null = null;
			for (const a of Object.values(it.assets)) {
				if (!/\.tif$/i.test(a.href)) continue;
				const g = a["eo:gsd"] ?? Number(a.href.match(/_([\d.]+)_2056_/)?.[1]);
				if (!Number.isFinite(g)) continue;
				if (!pick || Math.abs(g - gsd) < Math.abs(pick.gsd - gsd))
					pick = { kx, ky, year, gsd: g, href: a.href };
			}
			if (!pick) continue;
			const key = `${kx}-${ky}`;
			const prev = best.get(key);
			if (!prev || prev.year < year) best.set(key, pick);
		}
		url = j.links?.find((l) => l.rel === "next")?.href;
	}
	return [...best.values()];
}

// ---------------------------------------------------------------- TIFF

export type CogLevel = {
	width: number;
	height: number;
	tileW: number;
	tileH: number;
	/** Tile (or strip) byte offsets / counts, row-major. */
	offsets: number[];
	counts: number[];
	bitsPerSample: number;
	sampleFormat: number; // 1 uint, 2 int, 3 float
	samplesPerPixel: number;
	compression: number;
	predictor: number;
	/** Ground resolution (m) relative to the full-resolution image. */
	resX: number;
	resY: number;
};

export type CogHeader = {
	url: string;
	littleEndian: boolean;
	levels: CogLevel[];
	/** Top-left corner of the full-res image (CRS units) from ModelTiepoint/PixelScale. */
	originX: number;
	originY: number;
	nodata: number | null;
	/** The file prefix already fetched (header, IFDs, and whatever `headBytes` pulled in). */
	prefix: Uint8Array;
};

const TYPE_SIZE: Record<number, number> = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 1,
	7: 1,
	8: 2,
	9: 4,
	10: 8,
	11: 4,
	12: 8,
	16: 8,
	17: 8,
	18: 8,
};

/** A growable prefix buffer of the file, fetched on demand (header + IFDs + out-of-line arrays). */
class HeadBuf {
	buf = new Uint8Array(0);
	constructor(
		private url: string,
		private fetcher: RangeFetcher,
		private stats?: FetchStats,
		private signal?: AbortSignal,
	) {}
	/** Make bytes [0, end) available, fetching up to `atLeast` bytes (EOF before `end` throws). */
	async ensure(end: number, atLeast = end) {
		if (end <= this.buf.length) return;
		const want = Math.max(end, atLeast, this.buf.length * 2, 4096);
		const more = await this.fetcher(
			this.url,
			this.buf.length,
			want - 1,
			this.signal,
		);
		if (this.stats) {
			this.stats.requests++;
			this.stats.bytes += more.length;
		}
		const n = new Uint8Array(this.buf.length + more.length);
		n.set(this.buf);
		n.set(more, this.buf.length);
		this.buf = n;
		if (this.buf.length < end) throw new Error(`${this.url}: short read`);
	}
}

/**
 * Parse the IFD chain (all overview levels) of a COG. Reads only the header prefix; the default fetcher is plain fetch.
 */
export async function openCog(
	url: string,
	fetcher?: RangeFetcher,
	stats?: FetchStats,
	signal?: AbortSignal,
	/**
	 * First read size. GDAL COGs store the smallest overview
	 * right after the header, so a prefix that covers it saves a round trip (readWindow reuses the prefix).
	 * Default 16 KiB.
	 */
	headBytes = 16384,
): Promise<CogHeader> {
	return openCogOwn(url, fetcher ?? httpRangeFetcher, stats, signal, headBytes);
}

async function openCogOwn(
	url: string,
	fetcher: RangeFetcher,
	stats: FetchStats | undefined,
	signal: AbortSignal | undefined,
	headBytes: number,
): Promise<CogHeader> {
	const hb = new HeadBuf(url, fetcher, stats, signal);
	await hb.ensure(16, headBytes);
	let dv = new DataView(hb.buf.buffer, hb.buf.byteOffset, hb.buf.byteLength);
	const le = hb.buf[0] === 0x49;
	const u16 = (o: number) => dv.getUint16(o, le);
	const u32 = (o: number) => dv.getUint32(o, le);
	const u64 = (o: number) => Number(dv.getBigUint64(o, le));
	const magic = u16(2);
	const big = magic === 43;
	if (magic !== 42 && !big) throw new Error(`${url}: not a TIFF`);
	const offSize = big ? 8 : 4;
	const readOff = (o: number) => (big ? u64(o) : u32(o));
	let ifd = big ? u64(8) : u32(4);
	const refresh = async (end: number) => {
		await hb.ensure(end);
		dv = new DataView(hb.buf.buffer, hb.buf.byteOffset, hb.buf.byteLength);
	};
	const raw: Map<number, number[] | string>[] = [];
	for (let guard = 0; ifd && guard < 32; guard++) {
		await refresh(ifd + (big ? 8 : 2));
		const n = big ? u64(ifd) : u16(ifd);
		const es = big ? 20 : 12;
		const p0 = ifd + (big ? 8 : 2);
		await refresh(p0 + n * es + offSize);
		const tags = new Map<number, number[] | string>();
		for (let i = 0; i < n; i++) {
			const e = p0 + i * es;
			const tag = u16(e);
			const typ = u16(e + 2);
			const cnt = big ? u64(e + 4) : u32(e + 4);
			const size = (TYPE_SIZE[typ] ?? 1) * cnt;
			const inline = size <= offSize;
			let at = e + (big ? 12 : 8);
			if (!inline) {
				at = readOff(at);
				// big arrays we do not need (e.g. GDAL metadata XML) are skipped unless small
				if (tag !== 324 && tag !== 325 && tag !== 273 && tag !== 279) {
					if (size > 65536) continue;
				}
				await refresh(at + size);
			}
			if (typ === 2) {
				tags.set(
					tag,
					new TextDecoder()
						.decode(hb.buf.subarray(at, at + cnt))
						.replace(/\0+$/, ""),
				);
				continue;
			}
			const vals: number[] = new Array(cnt);
			for (let k = 0; k < cnt; k++) {
				const o = at + k * (TYPE_SIZE[typ] ?? 1);
				vals[k] =
					typ === 3 || typ === 8
						? typ === 3
							? u16(o)
							: dv.getInt16(o, le)
						: typ === 4
							? u32(o)
							: typ === 9
								? dv.getInt32(o, le)
								: typ === 16 || typ === 18
									? u64(o)
									: typ === 11
										? dv.getFloat32(o, le)
										: typ === 12
											? dv.getFloat64(o, le)
											: hb.buf[o];
			}
			tags.set(tag, vals);
		}
		raw.push(tags);
		ifd = readOff(p0 + n * es);
	}
	const num = (t: Map<number, number[] | string>, k: number, d: number) => {
		const v = t.get(k);
		return Array.isArray(v) ? v[0] : d;
	};
	const arr = (t: Map<number, number[] | string>, k: number) => {
		const v = t.get(k);
		return Array.isArray(v) ? v : [];
	};
	const t0 = raw[0];
	if (!t0) throw new Error(`${url}: no IFD`);
	const W0 = num(t0, 256, 0);
	const scale = arr(t0, 33550);
	const tie = arr(t0, 33922);
	const nd = t0.get(42113);
	const levels: CogLevel[] = [];
	for (const t of raw) {
		// skip masks (subfile type bit 2)
		if (num(t, 254, 0) & 4) continue;
		const width = num(t, 256, 0);
		const height = num(t, 257, 0);
		const tiled = t.has(322);
		const rps = num(t, 278, height);
		levels.push({
			width,
			height,
			tileW: tiled ? num(t, 322, 0) : width,
			tileH: tiled ? num(t, 323, 0) : rps,
			offsets: tiled ? arr(t, 324) : arr(t, 273),
			counts: tiled ? arr(t, 325) : arr(t, 279),
			bitsPerSample: num(t, 258, 8),
			sampleFormat: num(t, 339, 1),
			samplesPerPixel: num(t, 277, 1),
			compression: num(t, 259, 1),
			predictor: num(t, 317, 1),
			resX: ((scale[0] ?? 1) * W0) / width,
			resY: ((scale[1] ?? scale[0] ?? 1) * W0) / width,
		});
	}
	return {
		url,
		littleEndian: le,
		levels,
		originX: (tie[3] ?? 0) - (tie[0] ?? 0) * (scale[0] ?? 1),
		originY: (tie[4] ?? 0) + (tie[1] ?? 0) * (scale[1] ?? 1),
		prefix: hb.buf,
		nodata: typeof nd === "string" && nd.trim() !== "" ? Number(nd) : null,
	};
}

// ---------------------------------------------------------------- codecs

/** TIFF LZW (MSB-first, early change). `outLen` = expected decoded size. */
export function lzwDecode(src: Uint8Array, outLen: number): Uint8Array {
	const out = new Uint8Array(outLen);
	// code ≥ 258 ⇒ the string already sits in `out` at pos[code], len[code] bytes (no string table)
	const pos = new Int32Array(4096);
	const len = new Int32Array(4096);
	let op = 0;
	let bitBuf = 0;
	let bitCnt = 0;
	let sp = 0;
	let width = 9;
	let next = 258;
	let prevStart = -1;
	let prevLen = 0;
	while (op < outLen) {
		while (bitCnt < width) {
			if (sp >= src.length) return out;
			bitBuf = ((bitBuf << 8) | src[sp++]) & 0xffffff;
			bitCnt += 8;
		}
		const code = (bitBuf >>> (bitCnt - width)) & ((1 << width) - 1);
		bitCnt -= width;
		if (code === 257) break;
		if (code === 256) {
			width = 9;
			next = 258;
			prevStart = -1;
			continue;
		}
		const start = op;
		if (code < 256) out[op++] = code;
		else {
			let from: number;
			let n: number;
			if (code < next) {
				from = pos[code];
				n = len[code];
			} else {
				// KwKwK: prev string + its own first byte (the overlapping forward copy yields exactly that)
				if (prevStart < 0) throw new Error("LZW: bad code");
				from = prevStart;
				n = prevLen + 1;
			}
			const end = Math.min(outLen, op + n);
			for (let k = 0; op < end; k++) out[op++] = out[from + k];
		}
		if (prevStart >= 0 && next < 4096) {
			pos[next] = prevStart;
			len[next] = prevLen + 1;
			next++;
		}
		prevStart = start;
		prevLen = op - start;
		if (next >= (1 << width) - 1 && width < 12) width++;
	}
	return out;
}

/** zlib/Deflate via the platform DecompressionStream (browser + node ≥ 18). */
export async function inflate(src: Uint8Array): Promise<Uint8Array> {
	const ds = new DecompressionStream("deflate");
	const stream = new Blob([src as BlobPart]).stream().pipeThrough(ds);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeTile(
	lv: CogLevel,
	bytes: Uint8Array,
	le: boolean,
	rows: number,
): Promise<Float32Array> {
	const bps = lv.bitsPerSample / 8;
	const spp = lv.samplesPerPixel;
	const n = lv.tileW * rows * spp;
	const size = n * bps;
	let b: Uint8Array;
	if (lv.compression === 1) b = bytes;
	else if (lv.compression === 5) b = lzwDecode(bytes, size);
	else if (lv.compression === 8 || lv.compression === 32946)
		b = await inflate(bytes);
	else throw new Error(`TIFF compression ${lv.compression} unsupported`);
	if (lv.predictor === 3) {
		// floating-point predictor: byte-wise horizontal diff, then de-interleave the byte planes
		const rowB = lv.tileW * spp * bps;
		const tmp = new Uint8Array(rowB);
		const o = new Uint8Array(size);
		for (let r = 0; r < rows; r++) {
			const row = b.subarray(r * rowB, (r + 1) * rowB);
			for (let i = spp; i < rowB; i++) row[i] = (row[i] + row[i - spp]) & 255;
			tmp.set(row);
			const w = lv.tileW * spp;
			for (let i = 0; i < w; i++)
				for (let k = 0; k < bps; k++)
					o[r * rowB + i * bps + (le ? bps - 1 - k : k)] = tmp[k * w + i];
		}
		b = o;
	}
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const out = new Float32Array(n);
	const f = lv.sampleFormat;
	for (let i = 0; i < n && (i + 1) * bps <= b.length; i++) {
		const o = i * bps;
		out[i] =
			f === 3
				? bps === 4
					? dv.getFloat32(o, le)
					: dv.getFloat64(o, le)
				: bps === 1
					? f === 2
						? dv.getInt8(o)
						: dv.getUint8(o)
					: bps === 2
						? f === 2
							? dv.getInt16(o, le)
							: dv.getUint16(o, le)
						: f === 2
							? dv.getInt32(o, le)
							: dv.getUint32(o, le);
	}
	if (lv.predictor === 2) {
		for (let r = 0; r < rows; r++)
			for (let i = spp; i < lv.tileW * spp; i++)
				out[r * lv.tileW * spp + i] += out[r * lv.tileW * spp + i - spp];
	}
	return out;
}

/**
 * Read a pixel window [x0, x0+w) × [y0, y0+h) of `level` (band 0) into a Float32Array (row-major, nodata ⇒
 * NaN). Only the internal tiles that intersect the window are fetched, one request per tile run.
 */
export async function readWindow(
	hdr: CogHeader,
	level: number,
	x0: number,
	y0: number,
	w: number,
	h: number,
	fetcher: RangeFetcher = httpRangeFetcher,
	stats?: FetchStats,
	signal?: AbortSignal,
): Promise<Float32Array> {
	const lv = hdr.levels[level];
	const out = new Float32Array(w * h).fill(Number.NaN);
	const tx0 = Math.max(0, Math.floor(x0 / lv.tileW));
	const ty0 = Math.max(0, Math.floor(y0 / lv.tileH));
	const tx1 = Math.min(
		Math.ceil(lv.width / lv.tileW) - 1,
		Math.floor((x0 + w - 1) / lv.tileW),
	);
	const ty1 = Math.min(
		Math.ceil(lv.height / lv.tileH) - 1,
		Math.floor((y0 + h - 1) / lv.tileH),
	);
	const across = Math.ceil(lv.width / lv.tileW);
	const jobs: Promise<void>[] = [];
	const nd = hdr.nodata;
	for (let ty = ty0; ty <= ty1; ty++) {
		// merge horizontally adjacent tiles whose bytes are contiguous into one request
		let tx = tx0;
		while (tx <= tx1) {
			const first = tx;
			let end =
				hdr.levels[level].offsets[ty * across + tx] +
				lv.counts[ty * across + tx];
			while (
				tx + 1 <= tx1 &&
				lv.offsets[ty * across + tx + 1] === end &&
				lv.counts[ty * across + tx + 1] > 0
			) {
				tx++;
				end += lv.counts[ty * across + tx];
			}
			const last = tx;
			tx++;
			const start = lv.offsets[ty * across + first];
			if (!(end > start)) continue;
			const tyy = ty;
			jobs.push(
				(async () => {
					const bytes = await rangeVia(
						hdr,
						start,
						end - 1,
						fetcher,
						stats,
						signal,
					);
					for (let t = first; t <= last; t++) {
						const k = tyy * across + t;
						const o = lv.offsets[k] - start;
						const rows =
							lv.tileW === lv.width && lv.tileH !== lv.height
								? Math.min(lv.tileH, lv.height - tyy * lv.tileH)
								: lv.tileH;
						const tile = await decodeTile(
							lv,
							bytes.subarray(o, o + lv.counts[k]),
							hdr.littleEndian,
							rows,
						);
						const spp = lv.samplesPerPixel;
						for (let r = 0; r < rows; r++) {
							const gy = tyy * lv.tileH + r - y0;
							if (gy < 0 || gy >= h) continue;
							for (let c = 0; c < lv.tileW; c++) {
								const gx = t * lv.tileW + c - x0;
								if (gx < 0 || gx >= w) continue;
								const v = tile[(r * lv.tileW + c) * spp];
								out[gy * w + gx] =
									(nd !== null && v === nd) || v <= -9998 ? Number.NaN : v;
							}
						}
					}
				})(),
			);
		}
	}
	await Promise.all(jobs);
	return out;
}

/** Bytes [a, b] of the COG, reusing the fetched prefix where it covers them. */
async function rangeVia(
	hdr: CogHeader,
	a: number,
	b: number,
	fetcher: RangeFetcher,
	stats?: FetchStats,
	signal?: AbortSignal,
): Promise<Uint8Array> {
	const p = hdr.prefix;
	if (b < p.length) return p.subarray(a, b + 1);
	const from = Math.max(a, p.length);
	const more = await fetcher(hdr.url, from, b, signal);
	if (stats) {
		stats.requests++;
		stats.bytes += more.length;
	}
	if (from === a) return more;
	const out = new Uint8Array(b - a + 1);
	out.set(p.subarray(a));
	out.set(more, p.length - a);
	return out;
}

/** Index of the level whose resolution is closest to `resM` (never finer than needed when tied). */
export function pickLevel(hdr: CogHeader, resM: number): number {
	let best = 0;
	for (let i = 1; i < hdr.levels.length; i++) {
		const a = Math.abs(Math.log(hdr.levels[i].resX / resM));
		const b = Math.abs(Math.log(hdr.levels[best].resX / resM));
		if (a < b - 1e-9) best = i;
	}
	return best;
}
