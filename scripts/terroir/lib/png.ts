// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Minimal PNG decode/encode on node:zlib (8-bit gray / gray+alpha / RGB / RGBA / palette, non-interlaced).
import { deflateSync, inflateSync } from "node:zlib";

export type Raster = {
	width: number;
	height: number;
	channels: number;
	data: Uint8Array;
};

export function decodePng(buf: Uint8Array): Raster {
	const b = Buffer.from(buf);
	if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	let p = 8;
	let w = 0,
		h = 0,
		depth = 8,
		ctype = 2,
		interlace = 0;
	const idat: Buffer[] = [];
	let plte: Buffer | null = null;
	while (p < b.length) {
		const len = b.readUInt32BE(p);
		const type = b.toString("latin1", p + 4, p + 8);
		const d = b.subarray(p + 8, p + 8 + len);
		if (type === "IHDR") {
			w = d.readUInt32BE(0);
			h = d.readUInt32BE(4);
			depth = d[8];
			ctype = d[9];
			interlace = d[12];
		} else if (type === "PLTE") plte = Buffer.from(d);
		else if (type === "IDAT") idat.push(Buffer.from(d));
		else if (type === "IEND") break;
		p += 12 + len;
	}
	if (depth !== 8 || interlace)
		throw new Error(`unsupported PNG depth=${depth} interlace=${interlace}`);
	const ch =
		ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = w * ch;
	const out = new Uint8Array(h * stride);
	for (let y = 0; y < h; y++) {
		const ft = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const o = y * stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= ch ? out[o + x - ch] : 0;
			const up = y > 0 ? out[o - stride + x] : 0;
			const c = x >= ch && y > 0 ? out[o - stride + x - ch] : 0;
			let v = raw[src + x];
			if (ft === 1) v += a;
			else if (ft === 2) v += up;
			else if (ft === 3) v += (a + up) >> 1;
			else if (ft === 4) {
				const pa = Math.abs(up - c),
					pb = Math.abs(a - c),
					pc = Math.abs(a + up - 2 * c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
			}
			out[o + x] = v & 255;
		}
	}
	if (ctype === 3 && plte) {
		const rgb = new Uint8Array(w * h * 3);
		for (let i = 0; i < w * h; i++)
			for (let k = 0; k < 3; k++) rgb[i * 3 + k] = plte[out[i] * 3 + k];
		return { width: w, height: h, channels: 3, data: rgb };
	}
	return { width: w, height: h, channels: ch, data: out };
}

const CRC = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
const crc32 = (b: Buffer) => {
	let c = 0xffffffff;
	for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
};

/** Encode 8-bit gray (channels 1) or RGB (3), filter type 1 (Sub) for compressibility. */
export function encodePng(
	width: number,
	height: number,
	channels: 1 | 3,
	data: Uint8Array,
): Buffer {
	const stride = width * channels;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 2; // Up
		for (let x = 0; x < stride; x++) {
			const up = y > 0 ? data[(y - 1) * stride + x] : 0;
			raw[y * (stride + 1) + 1 + x] = (data[y * stride + x] - up) & 255;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = channels === 1 ? 0 : 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}
