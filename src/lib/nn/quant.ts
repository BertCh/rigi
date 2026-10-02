// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Quantized weights in safetensors: the download format of the larger browser models (int8 / int4,
// symmetric, one scale per group of a row). The loaders expand them once at load time (the GPU backend
// in a kernel, gpu/k-quant.ts; the CPU backend here) back to ordinary f16 / f32 weights, so model code,
// kernels and memory use are the same as for an fp16 file: quantization only shrinks the download.
// The GPU backend can instead keep int8 weights resident ("q8", `packResident` below) and dequantize
// inside the weight loads of the GEMM / conv kernels.
//
//   __metadata__.quant = JSON { [name]: { bits: 4 | 8, group, shape } }
//   <name>.qweight  U8 [ceil(numel · bits / 8)], the tensor flattened row-major:
//                   bits 8: q as a two's-complement byte; bits 4: q + 8 in a nibble, element 2k in the
//                   low nibble of byte k
//   <name>.qscale   F16 [rows, cols / group], rows = shape[0], cols = numel / rows
//   value = q · scale, q ∈ [-127, 127] (8) or [-8, 7] (4)
// Tensors without a `quant` row load as before.

import { floatToHalf, halfToFloat, type SafeTensorEntry } from "./safetensors";

export type QuantBits = 4 | 8;

export type QuantInfo = {
	bits: QuantBits;
	/** elements per scale along a row; divides cols */
	group: number;
	/** the dequantized tensor's shape */
	shape: number[];
};

export const QWEIGHT = ".qweight";
export const QSCALE = ".qscale";

/** The `quant` table of a file's metadata (empty when the file has none). */
export function readQuantTable(
	metadata: Record<string, string>,
): Map<string, QuantInfo> {
	const raw = metadata.quant;
	if (!raw) return new Map();
	const table = JSON.parse(raw) as Record<string, QuantInfo>;
	return new Map(Object.entries(table));
}

/** rows, cols and groups per row of a quantized tensor. */
export function quantLayout(info: QuantInfo): {
	rows: number;
	cols: number;
	groups: number;
	numel: number;
} {
	const numel = info.shape.reduce((a, v) => a * v, 1);
	const rows = info.shape[0] ?? 1;
	const cols = numel / rows;
	// a producer bug, not a runtime condition: the group must tile every row
	if (!Number.isInteger(cols) || cols % info.group)
		throw new Error(`quant: group ${info.group} does not divide ${cols}`);
	return { rows, cols, groups: cols / info.group, numel };
}

/** Packed byte count of `numel` elements at `bits`. */
export const packedBytes = (numel: number, bits: QuantBits) =>
	bits === 8 ? numel : Math.ceil(numel / 2);

/** The quantized value of element i (CPU reference of gpu/k-quant.ts). */
function quantAt(q: Uint8Array, i: number, bits: QuantBits): number {
	if (bits === 8) {
		const b = q[i];
		return b > 127 ? b - 256 : b;
	}
	const b = q[i >> 1];
	return (i & 1 ? b >> 4 : b & 15) - 8;
}

/** Expand one quantized tensor to f32 (the CPU backend's loader and the parity reference). */
export function dequantize(
	q: Uint8Array,
	scale: Float32Array,
	info: QuantInfo,
): Float32Array {
	const { numel, cols, groups } = quantLayout(info);
	const out = new Float32Array(numel);
	for (let i = 0; i < numel; i++) {
		const row = Math.floor(i / cols);
		const g = Math.floor((i - row * cols) / info.group);
		out[i] = quantAt(q, i, info.bits) * scale[row * groups + g];
	}
	return out;
}

/** Clip ratios tried per int4 group (the smallest squared error wins); int8 uses the plain absmax. */
const INT4_CLIPS = [1, 0.95, 0.9, 0.85, 0.8, 0.75];

/**
 * Quantize a row-major tensor (producers, specs). Scales are rounded to f16 before the values are
 * rounded against them, so `dequantize` of the result is exactly what a loader produces.
 */
export function quantize(
	x: Float32Array,
	shape: readonly number[],
	bits: QuantBits,
	group: number,
): { q: Uint8Array; scale: Uint16Array; info: QuantInfo } {
	const info: QuantInfo = { bits, group, shape: [...shape] };
	const { numel, rows, groups } = quantLayout(info);
	const q = new Uint8Array(packedBytes(numel, bits));
	const scale = new Uint16Array(rows * groups);
	const qmax = bits === 8 ? 127 : 7;
	const qmin = bits === 8 ? -127 : -8;
	const clips = bits === 8 ? [1] : INT4_CLIPS;
	for (let r = 0; r < rows * groups; r++) {
		const o = r * group;
		let amax = 0;
		for (let k = 0; k < group; k++) amax = Math.max(amax, Math.abs(x[o + k]));
		let best = 0;
		let bestErr = Number.POSITIVE_INFINITY;
		for (const c of clips) {
			const h = floatToHalf((c * amax) / qmax);
			const s = halfToFloat(h);
			let err = 0;
			for (let k = 0; k < group; k++) {
				const v = x[o + k];
				const qq =
					s > 0 ? Math.min(qmax, Math.max(qmin, Math.round(v / s))) : 0;
				err += (v - qq * s) ** 2;
			}
			if (err < bestErr) {
				bestErr = err;
				best = h;
			}
		}
		scale[r] = best;
		const s = halfToFloat(best);
		for (let k = 0; k < group; k++) {
			const i = o + k;
			const qq =
				s > 0 ? Math.min(qmax, Math.max(qmin, Math.round(x[i] / s))) : 0;
			if (bits === 8) q[i] = qq & 255;
			else q[i >> 1] |= (qq + 8) << ((i & 1) * 4);
		}
	}
	return { q, scale, info };
}

/** One quantized tensor of a parsed file: its packed bytes and scale entry. */
export type QuantEntry = {
	name: string;
	info: QuantInfo;
	q: Uint8Array;
	scale: SafeTensorEntry;
};

/**
 * Splits a parsed file into plain entries and quantized ones (the `.qweight` / `.qscale` pairs named in
 * the metadata). Plain entries keep their order.
 */
export function splitQuantized(
	entries: Map<string, SafeTensorEntry>,
	metadata: Record<string, string>,
): { plain: SafeTensorEntry[]; quantized: QuantEntry[] } {
	const table = readQuantTable(metadata);
	const quantized: QuantEntry[] = [];
	const used = new Set<string>();
	for (const [name, info] of table) {
		const q = entries.get(name + QWEIGHT);
		const scale = entries.get(name + QSCALE);
		if (!q?.bytes || !scale)
			throw new Error(`quant: ${name} has no ${QWEIGHT} / ${QSCALE} pair`);
		quantized.push({ name, info, q: q.bytes, scale });
		used.add(name + QWEIGHT);
		used.add(name + QSCALE);
	}
	const plain = [...entries.values()].filter((e) => !used.has(e.name));
	return { plain, quantized };
}

/** Header words of a resident q8 buffer: cols, group, scale word offset, groups per row. */
export const RESIDENT_HEADER_WORDS = 4;

/** Whether `info` can stay resident as q8: int8, and cols and group multiples of 4 (4-byte-aligned vec4 reads). */
export function canStayResident(info: QuantInfo): boolean {
	if (info.bits !== 8 || info.shape.length < 2) return false;
	const { cols } = quantLayout(info);
	return cols % 4 === 0 && info.group % 4 === 0;
}

/**
 * The self-describing GPU buffer of a resident int8 weight, in u32 words:
 *   [0] cols  [1] group  [2] word offset of the scales  [3] groups per row (cols / group)
 *   [4 ..)  the int8 values (RESIDENT_HEADER_WORDS words in), 4 per word (byte i = bits (i & 3) · 8 of word i >> 2)
 *   [scales ..)  the f16 scales, two per word (scale s = half s & 1 of word s >> 1), row-major
 * so the kernel needs no extra meta words or bindings, and the scales stay bit-identical to the file.
 */
export function packResident(
	q: Uint8Array,
	scaleHalf: Uint16Array,
	info: QuantInfo,
): Uint32Array {
	if (!canStayResident(info)) throw new Error("quant: not resident-eligible");
	const { numel, cols, rows, groups } = quantLayout(info);
	if (q.length !== numel || scaleHalf.length !== rows * groups)
		throw new Error("quant: packed sizes do not match the quant row");
	const byteWords = numel / 4;
	const scaleOffset = RESIDENT_HEADER_WORDS + byteWords;
	const out = new Uint32Array(scaleOffset + Math.ceil(scaleHalf.length / 2));
	out[0] = cols;
	out[1] = info.group;
	out[2] = scaleOffset;
	out[3] = groups;
	new Uint8Array(out.buffer, RESIDENT_HEADER_WORDS * 4, numel).set(q);
	new Uint16Array(out.buffer, scaleOffset * 4, scaleHalf.length).set(scaleHalf);
	return out;
}
