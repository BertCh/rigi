// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// safetensors parsing (https://github.com/huggingface/safetensors): an 8-byte little-endian header
// length, a JSON header { name: { dtype, shape, data_offsets: [begin, end] }, __metadata__? }, then
// the raw little-endian tensor bytes. F16 tensors stay as raw half words (the GPU backend keeps them
// f16 when the device has shader-f16), U8 tensors as raw bytes (packed quantized weights, ./quant.ts);
// everything else is widened to f32.

export type SafeTensorEntry = {
	name: string;
	shape: number[];
	/** storage after parsing: "f16" = raw half words in `half`, "u8" = raw bytes in `bytes`, otherwise f32 in `data` */
	dtype: "f32" | "f16" | "u8";
	data?: Float32Array;
	half?: Uint16Array;
	bytes?: Uint8Array;
};

export type SafeTensors = {
	entries: Map<string, SafeTensorEntry>;
	metadata: Record<string, string>;
};

/** IEEE half bits → number (handles subnormals, inf, NaN). */
export function halfToFloat(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Half words → Float32Array. */
export function halfToFloat32(half: Uint16Array): Float32Array {
	const out = new Float32Array(half.length);
	const u = new Uint32Array(out.buffer);
	for (let i = 0; i < half.length; i++) {
		const h = half[i];
		const s = (h & 0x8000) << 16;
		const e = (h >> 10) & 0x1f;
		const m = h & 0x3ff;
		if (e === 0) out[i] = (h & 0x8000 ? -1 : 1) * m * 2 ** -24;
		else if (e === 31) u[i] = s | 0x7f800000 | (m << 13);
		else u[i] = s | ((e + 112) << 23) | (m << 13);
	}
	return out;
}

/** f32 → half bits, round to nearest even (for tests and producers). */
export function floatToHalf(v: number): number {
	const f = new Float32Array([v]);
	const x = new Uint32Array(f.buffer)[0];
	const s = (x >>> 16) & 0x8000;
	const e = (x >>> 23) & 0xff;
	let m = x & 0x7fffff;
	if (e === 0xff) return s | 0x7c00 | (m ? 0x200 : 0);
	let he = e - 127 + 15;
	if (he >= 31) return s | 0x7c00;
	if (he <= 0) {
		if (he < -10) return s;
		m |= 0x800000;
		const shift = 14 - he;
		let hm = m >> shift;
		const rem = m & ((1 << shift) - 1);
		const half = 1 << (shift - 1);
		if (rem > half || (rem === half && hm & 1)) hm++;
		return s | hm;
	}
	let hm = m >> 13;
	const rem = m & 0x1fff;
	if (rem > 0x1000 || (rem === 0x1000 && hm & 1)) {
		hm++;
		if (hm === 0x400) {
			hm = 0;
			he++;
			if (he >= 31) return s | 0x7c00;
		}
	}
	return s | (he << 10) | hm;
}

const BYTES: Record<string, number> = {
	F64: 8,
	F32: 4,
	F16: 2,
	BF16: 2,
	I64: 8,
	I32: 4,
	I16: 2,
	I8: 1,
	U8: 1,
	BOOL: 1,
};

/** Parse a safetensors file. Data is copied out of `bytes` (the buffer may be dropped after). */
export function parseSafetensors(bytes: ArrayBuffer | Uint8Array): SafeTensors {
	const u8 =
		bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
	if (u8.byteLength < 8) throw new Error("safetensors: truncated");
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const headerLen = Number(dv.getBigUint64(0, true));
	if (8 + headerLen > u8.byteLength)
		throw new Error("safetensors: header length past the end");
	const header = JSON.parse(
		new TextDecoder().decode(u8.subarray(8, 8 + headerLen)),
	) as Record<
		string,
		{ dtype: string; shape: number[]; data_offsets: [number, number] }
	> & { __metadata__?: Record<string, string> };
	const base = 8 + headerLen;
	const entries = new Map<string, SafeTensorEntry>();
	for (const [name, info] of Object.entries(header)) {
		if (name === "__metadata__") continue;
		const t = info as {
			dtype: string;
			shape: number[];
			data_offsets: [number, number];
		};
		const [b, e] = t.data_offsets;
		const width = BYTES[t.dtype];
		if (!width) throw new Error(`safetensors: dtype ${t.dtype} (${name})`);
		const n = t.shape.reduce((a, v) => a * v, 1);
		if (e - b !== n * width || base + e > u8.byteLength)
			throw new Error(`safetensors: bad offsets for ${name}`);
		// copy so the result is aligned and independent of the source buffer (Uint8Array's slice: a node
		// Buffer's own slice is a view, whose .buffer would be the whole file)
		const raw = Uint8Array.prototype.slice.call(u8, base + b, base + e);
		const rv = new DataView(raw.buffer);
		const entry: SafeTensorEntry = { name, shape: [...t.shape], dtype: "f32" };
		switch (t.dtype) {
			case "F32":
				entry.data = new Float32Array(raw.buffer);
				break;
			case "F16":
				entry.dtype = "f16";
				entry.half = new Uint16Array(raw.buffer);
				break;
			case "U8":
				entry.dtype = "u8";
				entry.bytes = raw;
				break;
			default: {
				const out = new Float32Array(n);
				for (let i = 0; i < n; i++) {
					const o = i * width;
					switch (t.dtype) {
						case "F64":
							out[i] = rv.getFloat64(o, true);
							break;
						case "BF16":
							out[i] = new Float32Array(
								new Uint32Array([rv.getUint16(o, true) << 16]).buffer,
							)[0];
							break;
						case "I64":
							out[i] = Number(rv.getBigInt64(o, true));
							break;
						case "I32":
							out[i] = rv.getInt32(o, true);
							break;
						case "I16":
							out[i] = rv.getInt16(o, true);
							break;
						case "I8":
							out[i] = rv.getInt8(o);
							break;
						default:
							out[i] = rv.getUint8(o);
					}
				}
				entry.data = out;
			}
		}
		entries.set(name, entry);
	}
	return { entries, metadata: header.__metadata__ ?? {} };
}

/** f32 view of an entry (widening f16 and u8). */
export const entryF32 = (e: SafeTensorEntry): Float32Array =>
	e.data ??
	(e.half ? halfToFloat32(e.half) : Float32Array.from(e.bytes as Uint8Array));

/** Build a safetensors file (tests, producers in TS). */
export function encodeSafetensors(
	tensors: Record<
		string,
		{
			shape: number[];
			data: Float32Array | Uint16Array | Uint8Array;
			dtype?: "F32" | "F16" | "U8";
		}
	>,
	metadata?: Record<string, string>,
): Uint8Array {
	const header: Record<string, unknown> = {};
	if (metadata) header.__metadata__ = metadata;
	let off = 0;
	const parts: Uint8Array[] = [];
	for (const [name, t] of Object.entries(tensors)) {
		const dtype =
			t.dtype ??
			(t.data instanceof Uint16Array
				? "F16"
				: t.data instanceof Uint8Array
					? "U8"
					: "F32");
		const bytes = new Uint8Array(
			t.data.buffer.slice(
				t.data.byteOffset,
				t.data.byteOffset + t.data.byteLength,
			),
		);
		header[name] = {
			dtype,
			shape: t.shape,
			data_offsets: [off, off + bytes.byteLength],
		};
		parts.push(bytes);
		off += bytes.byteLength;
	}
	let json = JSON.stringify(header);
	while ((8 + json.length) % 8) json += " ";
	const hj = new TextEncoder().encode(json);
	const out = new Uint8Array(8 + hj.byteLength + off);
	new DataView(out.buffer).setBigUint64(0, BigInt(hj.byteLength), true);
	out.set(hj, 8);
	let p = 8 + hj.byteLength;
	for (const b of parts) {
		out.set(b, p);
		p += b.byteLength;
	}
	return out;
}
