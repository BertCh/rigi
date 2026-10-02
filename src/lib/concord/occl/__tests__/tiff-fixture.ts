// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Hand-built TIFF / COG byte fixtures for the swiss-cog reader specs (no network, no data files).
import { deflateSync } from "node:zlib";

export type FixtureLevel = {
	width: number;
	height: number;
	tileW: number;
	tileH: number;
	/** Row-major sample values, width*height (padded to whole tiles internally). */
	values: ArrayLike<number>;
	compression?: 1 | 5 | 8;
	predictor?: 1 | 2 | 3;
	/** 32 float, 16 int16 or 16 uint16 (sampleFormat follows). */
	kind?: "f32" | "i16" | "u16";
	/** Mark as a reduced-resolution overview (NewSubfileType 1). */
	overview?: boolean;
};

export type FixtureOpts = {
	levels: FixtureLevel[];
	/** CRS units per pixel of level 0. */
	pixel: number;
	originX: number;
	originY: number;
	nodata?: number;
	/** Bytes of padding before the IFDs, so tiles sit past the header prefix. */
	pad?: number;
};

const SIZE: Record<string, number> = { f32: 4, i16: 2, u16: 2 };

/** Encode literals only with a clear code every 200 codes (never widens the code size). */
export function lzwEncodeLiterals(src: Uint8Array): Uint8Array {
	const bits: number[] = [];
	const put = (code: number) => {
		for (let b = 8; b >= 0; b--) bits.push((code >> b) & 1);
	};
	put(256);
	for (let i = 0; i < src.length; i++) {
		if (i > 0 && i % 200 === 0) put(256);
		put(src[i]);
	}
	put(257);
	while (bits.length % 8) bits.push(0);
	const out = new Uint8Array(bits.length / 8);
	for (let i = 0; i < bits.length; i++) out[i >> 3] |= bits[i] << (7 - (i & 7));
	return out;
}

function encodeTile(lv: FixtureLevel, tx: number, ty: number): Uint8Array {
	const kind = lv.kind ?? "f32";
	const bps = SIZE[kind];
	const { tileW, tileH } = lv;
	const raw = new Uint8Array(tileW * tileH * bps);
	const dv = new DataView(raw.buffer);
	const vals = new Float64Array(tileW * tileH);
	for (let r = 0; r < tileH; r++)
		for (let c = 0; c < tileW; c++) {
			const x = tx * tileW + c;
			const y = ty * tileH + r;
			vals[r * tileW + c] =
				x < lv.width && y < lv.height ? lv.values[y * lv.width + x] : 0;
		}
	if (lv.predictor === 2) {
		for (let r = 0; r < tileH; r++)
			for (let c = tileW - 1; c >= 1; c--)
				vals[r * tileW + c] -= vals[r * tileW + c - 1];
	}
	for (let i = 0; i < vals.length; i++) {
		if (kind === "f32") dv.setFloat32(i * 4, vals[i], true);
		else if (kind === "i16") dv.setInt16(i * 2, vals[i], true);
		else dv.setUint16(i * 2, vals[i], true);
	}
	let b = raw;
	if (lv.predictor === 3) {
		// float predictor: byte planes (most significant first), then horizontal byte differences
		const out = new Uint8Array(raw.length);
		const rowB = tileW * bps;
		for (let r = 0; r < tileH; r++) {
			const tmp = new Uint8Array(rowB);
			for (let i = 0; i < tileW; i++)
				for (let k = 0; k < bps; k++)
					tmp[k * tileW + i] = raw[r * rowB + i * bps + (bps - 1 - k)];
			for (let i = rowB - 1; i >= 1; i--) tmp[i] = (tmp[i] - tmp[i - 1]) & 255;
			out.set(tmp, r * rowB);
		}
		b = out;
	}
	if (lv.compression === 5) return lzwEncodeLiterals(b);
	if (lv.compression === 8) return new Uint8Array(deflateSync(b));
	return b;
}

/** Classic little-endian TIFF: tile data first, then out-of-line values, then the IFD chain. */
export function buildTiff(o: FixtureOpts): Uint8Array {
	const chunks: Uint8Array[] = [];
	let pos = 8 + (o.pad ?? 0);
	const place = (u: Uint8Array) => {
		const at = pos;
		chunks.push(u);
		pos += u.length;
		return at;
	};
	const tileInfo = o.levels.map((lv) => {
		const across = Math.ceil(lv.width / lv.tileW);
		const down = Math.ceil(lv.height / lv.tileH);
		const offsets: number[] = [];
		const counts: number[] = [];
		for (let ty = 0; ty < down; ty++)
			for (let tx = 0; tx < across; tx++) {
				const t = encodeTile(lv, tx, ty);
				offsets.push(place(t));
				counts.push(t.length);
			}
		return { offsets, counts };
	});
	type Entry = { tag: number; type: number; vals: number[] | string };
	const ifds = o.levels.map((lv, i) => {
		const kind = lv.kind ?? "f32";
		const e: Entry[] = [];
		if (lv.overview) e.push({ tag: 254, type: 4, vals: [1] });
		e.push({ tag: 256, type: 4, vals: [lv.width] });
		e.push({ tag: 257, type: 4, vals: [lv.height] });
		e.push({ tag: 258, type: 3, vals: [SIZE[kind] * 8] });
		e.push({ tag: 259, type: 3, vals: [lv.compression ?? 1] });
		e.push({ tag: 277, type: 3, vals: [1] });
		e.push({ tag: 317, type: 3, vals: [lv.predictor ?? 1] });
		e.push({ tag: 322, type: 4, vals: [lv.tileW] });
		e.push({ tag: 323, type: 4, vals: [lv.tileH] });
		e.push({ tag: 324, type: 4, vals: tileInfo[i].offsets });
		e.push({ tag: 325, type: 4, vals: tileInfo[i].counts });
		e.push({
			tag: 339,
			type: 3,
			vals: [kind === "f32" ? 3 : kind === "i16" ? 2 : 1],
		});
		if (i === 0) {
			e.push({ tag: 33550, type: 12, vals: [o.pixel, o.pixel, 0] });
			e.push({
				tag: 33922,
				type: 12,
				vals: [0, 0, 0, o.originX, o.originY, 0],
			});
			if (o.nodata !== undefined)
				e.push({ tag: 42113, type: 2, vals: String(o.nodata) });
		}
		return e.sort((a, b) => a.tag - b.tag);
	});
	// out-of-line values
	const blobs = new Map<Entry, number>();
	const enc = (e: Entry): Uint8Array => {
		if (typeof e.vals === "string") {
			const u = new Uint8Array(e.vals.length + 1);
			for (let i = 0; i < e.vals.length; i++) u[i] = e.vals.charCodeAt(i);
			return u;
		}
		const sz = e.type === 3 ? 2 : e.type === 4 ? 4 : 8;
		const u = new Uint8Array(e.vals.length * sz);
		const dv = new DataView(u.buffer);
		e.vals.forEach((v, i) => {
			if (e.type === 3) dv.setUint16(i * 2, v, true);
			else if (e.type === 4) dv.setUint32(i * 4, v, true);
			else dv.setFloat64(i * 8, v, true);
		});
		return u;
	};
	for (const ifd of ifds)
		for (const e of ifd) {
			const u = enc(e);
			if (u.length > 4) blobs.set(e, place(u));
		}
	const ifdBytes = ifds.map((ifd) => 2 + ifd.length * 12 + 4);
	const ifdAt: number[] = [];
	let p2 = pos;
	for (const n of ifdBytes) {
		ifdAt.push(p2);
		p2 += n;
	}
	ifds.forEach((ifd, i) => {
		const u = new Uint8Array(ifdBytes[i]);
		const dv = new DataView(u.buffer);
		dv.setUint16(0, ifd.length, true);
		ifd.forEach((e, k) => {
			const at = 2 + k * 12;
			dv.setUint16(at, e.tag, true);
			dv.setUint16(at + 2, e.type, true);
			const bytes = enc(e);
			const sz = e.type === 2 ? 1 : e.type === 3 ? 2 : e.type === 4 ? 4 : 8;
			dv.setUint32(at + 4, bytes.length / sz, true);
			const off = blobs.get(e);
			if (off !== undefined) dv.setUint32(at + 8, off, true);
			else u.set(bytes, at + 8);
		});
		dv.setUint32(ifdBytes[i] - 4, i + 1 < ifds.length ? ifdAt[i + 1] : 0, true);
		chunks.push(u);
	});
	pos = p2;
	const out = new Uint8Array(pos);
	const head = new DataView(out.buffer);
	out[0] = 0x49;
	out[1] = 0x49;
	head.setUint16(2, 42, true);
	head.setUint32(4, ifdAt[0], true);
	let w = 8 + (o.pad ?? 0);
	for (const c of chunks) {
		out.set(c, w);
		w += c.length;
	}
	return out;
}

/** A RangeFetcher over in-memory files that counts calls. */
export function memoryFetcher(files: Record<string, Uint8Array>) {
	const calls: { url: string; start: number; end: number }[] = [];
	const fetcher = async (url: string, start: number, end: number) => {
		calls.push({ url, start, end });
		const f = files[url];
		if (!f) throw new Error(`${url}: HTTP 404`);
		return f.slice(start, Math.min(end + 1, f.length));
	};
	return { fetcher, calls };
}
