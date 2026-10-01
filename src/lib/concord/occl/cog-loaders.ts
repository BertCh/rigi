// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.5: the loaders.gl COG reader (`GeoTIFFSourceLoader`, @loaders.gl/geotiff over geotiff.js) behind the
// swiss-cog.ts API. swiss-cog.ts imports this module dynamically (`openCog(…, { reader: "loaders" })`), so the
// dependency is only loaded when the reader is used.
//
// Transport: every byte range goes through the caller's RangeFetcher (in the app `cachedFetchRange`, so COG
// headers and tiles land in the persistent tile cache keyed by url + range), injected as the source's
// `fetch`. geotiff.js reads in 64 KiB blocks (its BlockedSource) and keeps them for the life of the source.
//
// Pixel exactness: `getRaster` picks an overview with geotiff.js's rule "the coarsest image whose
// resolution is strictly finer than the requested one" and resamples when the output size differs from the
// window. To read overview `level` exactly, the request asks for the level's own pixel count over a box
// one micro-pixel larger than the window (so the requested resolution is a hair coarser than the level's),
// which selects that level and rounds back to the same window: no resampling, the decoded Float32 samples
// as stored. A window that spans the whole image on both axes has no room to grow and is read as two row
// halves. Pixels outside the image are NaN (the own reader copies the edge tiles' padding there; ndsm.ts
// clamps its windows to the image, so the two agree on every read it makes).
import {
	type GeoTIFFRasterSource,
	GeoTIFFSourceLoader,
} from "@loaders.gl/geotiff";
import type {
	CogHeader,
	CogLevel,
	CogLoadersHandle,
	FetchStats,
	RangeFetcher,
} from "./swiss-cog";

/** The geotiff.js image surface this module reads (fileDirectory tags are parsed eagerly in geotiff 2.x). */
type TiffImage = {
	fileDirectory: Record<string, unknown>;
	getWidth(): number;
	getHeight(): number;
};
type TiffInit = { tiff: { littleEndian: boolean }; images: TiffImage[] };

/** Growth of the request box, in pixels of the level (far below the 0.5 px rounding of the window). */
const GROW_PX = 1e-6;

/**
 * The RangeFetcher as a fetch(): geotiff.js (through loaders.gl's range scheduler) asks for single ranges
 * with a `Range` header and needs a 206 with a Content-Range whose total is the file size. A RangeFetcher
 * does not report the size, so the total is the end of file once a read came back short, and unbounded
 * before that (geotiff.js uses it only to clamp block reads; a block past the true end comes back short).
 */
function fetchVia(
	fetcher: RangeFetcher,
	ctx: { stats?: FetchStats },
): (url: string, init?: RequestInit) => Promise<Response> {
	let size: number | null = null;
	return async (url, init) => {
		const range = new Headers(init?.headers).get("Range");
		const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
		// geotiff.js only issues single-range reads (maxRanges 0)
		if (!m) throw new Error(`${url}: expected one byte range, got ${range}`);
		const start = Number(m[1]);
		const end = Number(m[2]);
		const bytes = await fetcher(url, start, end, init?.signal ?? undefined);
		if (ctx.stats) {
			ctx.stats.requests++;
			ctx.stats.bytes += bytes.length;
		}
		if (bytes.length < end - start + 1) size = start + bytes.length;
		const total = size ?? Number.MAX_SAFE_INTEGER;
		return new Response(bytes as BodyInit, {
			status: 206,
			headers: {
				"Content-Range": `bytes ${start}-${start + bytes.length - 1}/${total}`,
			},
		});
	};
}

const tag = (fd: Record<string, unknown>, name: string, d: number): number => {
	const v = fd[name];
	if (typeof v === "number") return v;
	if (v && typeof (v as ArrayLike<number>)[0] === "number")
		return (v as ArrayLike<number>)[0];
	return d;
};
const tagArray = (fd: Record<string, unknown>, name: string): number[] => {
	const v = fd[name];
	return v && typeof v === "object" ? Array.from(v as ArrayLike<number>) : [];
};

/**
 * Open `url` with GeoTIFFSourceLoader and describe it as a CogHeader (same fields and conventions as
 * swiss-cog.ts openCog: masks skipped, resolutions relative to the full-res image, nodata from GDAL_NODATA),
 * with a `loaders` handle that readWindow uses instead of the own decoder.
 */
export async function openCogLoaders(
	url: string,
	fetcher: RangeFetcher,
	stats?: FetchStats,
	signal?: AbortSignal,
): Promise<CogHeader> {
	const ctx: { stats?: FetchStats } = { stats };
	const source = GeoTIFFSourceLoader.createDataSource(url, {
		core: { loadOptions: { core: { fetch: fetchVia(fetcher, ctx) } } },
	});
	if (signal?.aborted) throw signal.reason;
	const md = await source.getMetadata();
	if (!md.boundingBox) throw new Error(`${url}: no georeferencing`);
	// the per-level tile tables (byte counts drive ndsm.ts's transfer budget) are not part of the public
	// metadata: read them from the dataset the source opened (private `_getInitPromise`, loaders.gl alpha.7)
	const init = await (
		source as unknown as { _getInitPromise(): Promise<TiffInit> }
	)._getInitPromise();
	const fd0 = init.images[0].fileDirectory;
	const W0 = init.images[0].getWidth();
	const scale = tagArray(fd0, "ModelPixelScale");
	const tie = tagArray(fd0, "ModelTiepoint");
	const levels: CogLevel[] = [];
	for (const im of init.images) {
		const fd = im.fileDirectory;
		// a mask (subfile bit 2) would also be an overview candidate for geotiff.js: not supported here
		if (tag(fd, "NewSubfileType", 0) & 4)
			throw new Error(`${url}: COG with mask IFDs (use the own reader)`);
		const width = im.getWidth();
		const height = im.getHeight();
		const tiled = fd.TileWidth !== undefined;
		levels.push({
			width,
			height,
			tileW: tiled ? tag(fd, "TileWidth", 0) : width,
			tileH: tiled ? tag(fd, "TileLength", 0) : tag(fd, "RowsPerStrip", height),
			offsets: tagArray(fd, tiled ? "TileOffsets" : "StripOffsets"),
			counts: tagArray(fd, tiled ? "TileByteCounts" : "StripByteCounts"),
			bitsPerSample: tag(fd, "BitsPerSample", 8),
			sampleFormat: tag(fd, "SampleFormat", 1),
			samplesPerPixel: tag(fd, "SamplesPerPixel", 1),
			compression: tag(fd, "Compression", 1),
			predictor: tag(fd, "Predictor", 1),
			resX: ((scale[0] ?? 1) * W0) / width,
			resY: ((scale[1] ?? scale[0] ?? 1) * W0) / width,
		});
	}
	const nd = fd0.GDAL_NODATA;
	const ndText = typeof nd === "string" ? nd.replace(/\0+$/, "").trim() : "";
	const [[minX, minY], [maxX, maxY]] = md.boundingBox;
	const box = { minX, minY, maxX, maxY };
	const hdr: CogHeader = {
		url,
		littleEndian: init.tiff.littleEndian,
		levels,
		originX: (tie[3] ?? 0) - (tie[0] ?? 0) * (scale[0] ?? 1),
		originY: (tie[4] ?? 0) + (tie[1] ?? 0) * (scale[1] ?? 1),
		nodata: ndText !== "" ? Number(ndText) : null,
		prefix: new Uint8Array(0),
	};
	const handle: CogLoadersHandle = {
		read: (level, x0, y0, w, h, readStats) => {
			if (readStats) ctx.stats = readStats;
			return readWindowLoaders(source, hdr, box, level, x0, y0, w, h);
		},
	};
	hdr.loaders = handle;
	return hdr;
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** readWindow semantics (band 0, row-major, nodata / ≤ −9998 / outside the image ⇒ NaN) over getRaster. */
async function readWindowLoaders(
	source: GeoTIFFRasterSource,
	hdr: CogHeader,
	box: Box,
	level: number,
	x0: number,
	y0: number,
	w: number,
	h: number,
): Promise<Float32Array> {
	const lv = hdr.levels[level];
	const out = new Float32Array(w * h).fill(Number.NaN);
	const ix0 = Math.max(0, x0);
	const iy0 = Math.max(0, y0);
	const ix1 = Math.min(lv.width, x0 + w);
	const iy1 = Math.min(lv.height, y0 + h);
	if (ix1 <= ix0 || iy1 <= iy0) return out;
	const nd = hdr.nodata;
	const put = (
		data: ArrayLike<number>,
		rx0: number,
		ry0: number,
		rw: number,
		rh: number,
	) => {
		for (let r = 0; r < rh; r++) {
			const o = (ry0 - y0 + r) * w + (rx0 - x0);
			for (let c = 0; c < rw; c++) {
				const v = data[r * rw + c];
				out[o + c] =
					Number.isNaN(v) || (nd !== null && v === nd) || v <= -9998
						? Number.NaN
						: v;
			}
		}
	};
	const read = async (rx0: number, ry0: number, rw: number, rh: number) => {
		// pixel-edge box of the window at this level (geotiff.js maps it back with the same origin / res)
		const px = (box.maxX - box.minX) / lv.width;
		const py = (box.maxY - box.minY) / lv.height;
		let e0 = box.minX + rx0 * px;
		let e1 = box.minX + (rx0 + rw) * px;
		let n1 = box.maxY - ry0 * py;
		let n0 = box.maxY - (ry0 + rh) * py;
		const gx = GROW_PX * px;
		const gy = GROW_PX * py;
		if (e1 + gx <= box.maxX) e1 += gx;
		else if (e0 - gx >= box.minX) e0 -= gx;
		else if (n0 - gy >= box.minY) n0 -= gy;
		else if (n1 + gy <= box.maxY) n1 += gy;
		else if (rh >= 2) {
			// whole image on both axes: two row halves, each with room to grow
			const top = Math.floor(rh / 2);
			await Promise.all([
				read(rx0, ry0, rw, top),
				read(rx0, ry0 + top, rw, rh - top),
			]);
			return;
		} else
			throw new Error(`${hdr.url}: cannot address a 1-row whole-image window`);
		const r = await source.getRaster({
			viewport: {
				id: `${hdr.url}#${level}:${rx0},${ry0},${rw},${rh}`,
				width: rw,
				height: rh,
				zoom: 0,
				center: [(e0 + e1) / 2, (n0 + n1) / 2],
				bounds: [
					[e0, n0],
					[e1, n1],
				],
				// getRaster reads `bounds` only; a deck.gl viewport would project with these
				project: (p) => p,
				unprojectPosition: (p) => [p[0], p[1], p[2] ?? 0],
			},
			bands: [0],
			resampleMethod: "nearest",
		});
		const data = (
			Array.isArray(r.data) ? r.data[0] : r.data
		) as ArrayLike<number>;
		// geotiff.js picked another level or resampled: the request geometry above is wrong for this file
		if (r.width !== rw || r.height !== rh || data.length !== rw * rh)
			throw new Error(
				`${hdr.url}: loaders read ${r.width}×${r.height} for a ${rw}×${rh} window`,
			);
		put(data, rx0, ry0, rw, rh);
	};
	await read(ix0, iy0, ix1 - ix0, iy1 - iy0);
	return out;
}
