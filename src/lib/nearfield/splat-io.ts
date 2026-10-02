// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Gaussian cloud (de)serialisation: the ".splat-v1" wire format shared with the Python service
// (tools/nearfield) and a minimal reader for standard 3DGS binary .ply files. Pure TS, no DOM.
//
// .splat-v1 (little-endian):
//   bytes 0..7 ASCII "RIGISPL1"; u32 count N; u32 flags (bit0 = frame is ENU else camera;
//   bit1 = has source array); f64 originLat, f64 originLon, f64 originH (0 if camera frame);
//   f32 positions[3N], f32 scales[3N] (linear metres), f32 rotations[4N] (w,x,y,z),
//   u8 colors[4N] (RGBA), u8 provenance[N], zero pad to a 4-byte boundary, u16 source[N] if bit1.
import { type GaussianCloud, PROVENANCE_CODE } from "./types";

export const SPLAT_V1_MAGIC = "RIGISPL1";
const HEADER_BYTES = 8 + 4 + 4 + 3 * 8; // 40
const FLAG_ENU = 1;
const FLAG_SOURCE = 2;

/** WGS84 origin of an ENU cloud (Renderer.frame lat/lon/h). */
export type GeoOrigin = { lat: number; lon: number; h: number };

// arithmetic, not `& ~3`: a hostile count must not wrap the size check at 2^31
const pad4 = (n: number) => Math.ceil(n / 4) * 4;

function splatV1Size(count: number, hasSource: boolean) {
	const body = count * (12 + 12 + 16 + 4 + 1);
	const end = pad4(HEADER_BYTES + body);
	return hasSource ? end + count * 2 : end;
}

/** Serialise a cloud. `origin` is written only for ENU clouds (camera clouds store 0,0,0). */
export function encodeSplatV1(
	cloud: GaussianCloud,
	origin?: GeoOrigin | null,
): ArrayBuffer {
	const n = cloud.count;
	const hasSource = !!cloud.source;
	const buf = new ArrayBuffer(splatV1Size(n, hasSource));
	const dv = new DataView(buf);
	for (let i = 0; i < 8; i++) dv.setUint8(i, SPLAT_V1_MAGIC.charCodeAt(i));
	dv.setUint32(8, n, true);
	const enu = cloud.frame === "enu";
	dv.setUint32(12, (enu ? FLAG_ENU : 0) | (hasSource ? FLAG_SOURCE : 0), true);
	dv.setFloat64(16, enu && origin ? origin.lat : 0, true);
	dv.setFloat64(24, enu && origin ? origin.lon : 0, true);
	dv.setFloat64(32, enu && origin ? origin.h : 0, true);
	let o = HEADER_BYTES;
	const putF32 = (a: Float32Array, len: number) => {
		for (let i = 0; i < len; i++, o += 4) dv.setFloat32(o, a[i], true);
	};
	putF32(cloud.positions, 3 * n);
	putF32(cloud.scales, 3 * n);
	putF32(cloud.rotations, 4 * n);
	new Uint8Array(buf, o, 4 * n).set(cloud.colors.subarray(0, 4 * n));
	o += 4 * n;
	new Uint8Array(buf, o, n).set(cloud.provenance.subarray(0, n));
	o = pad4(o + n);
	if (cloud.source)
		for (let i = 0; i < n; i++, o += 2) dv.setUint16(o, cloud.source[i], true);
	return buf;
}

function header(buf: ArrayBuffer | ArrayBufferView) {
	const bytes =
		buf instanceof ArrayBuffer
			? new Uint8Array(buf)
			: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	if (bytes.byteLength < HEADER_BYTES) throw new Error("splat-v1: truncated");
	for (let i = 0; i < 8; i++)
		if (bytes[i] !== SPLAT_V1_MAGIC.charCodeAt(i))
			throw new Error("splat-v1: bad magic");
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = dv.getUint32(8, true);
	const flags = dv.getUint32(12, true);
	return { bytes, dv, count, flags };
}

/** Origin stored in a .splat-v1 buffer (null for a camera-frame cloud). Throws on a malformed buffer. */
export function readSplatV1Origin(
	buf: ArrayBuffer | ArrayBufferView,
): GeoOrigin | null {
	const { dv, flags } = header(buf);
	if (!(flags & FLAG_ENU)) return null;
	return {
		lat: dv.getFloat64(16, true),
		lon: dv.getFloat64(24, true),
		h: dv.getFloat64(32, true),
	};
}

/** Parse a .splat-v1 buffer (copies into fresh aligned arrays). Throws on a malformed buffer. */
export function decodeSplatV1(
	buf: ArrayBuffer | ArrayBufferView,
): GaussianCloud {
	const { bytes, dv, count: n, flags } = header(buf);
	const hasSource = !!(flags & FLAG_SOURCE);
	if (bytes.byteLength < splatV1Size(n, hasSource))
		throw new Error("splat-v1: truncated");
	let o = HEADER_BYTES;
	const getF32 = (len: number) => {
		const a = new Float32Array(len);
		for (let i = 0; i < len; i++, o += 4) a[i] = dv.getFloat32(o, true);
		return a;
	};
	const positions = getF32(3 * n);
	const scales = getF32(3 * n);
	const rotations = getF32(4 * n);
	const colors = bytes.slice(o, o + 4 * n);
	o += 4 * n;
	const provenance = bytes.slice(o, o + n);
	o = pad4(o + n);
	const cloud: GaussianCloud = {
		count: n,
		frame: flags & FLAG_ENU ? "enu" : "camera",
		positions,
		scales,
		rotations,
		colors,
		provenance,
	};
	if (hasSource) {
		const s = new Uint16Array(n);
		for (let i = 0; i < n; i++, o += 2) s[i] = dv.getUint16(o, true);
		cloud.source = s;
	}
	return cloud;
}

// ---- standard 3DGS .ply (binary_little_endian) ----

const PLY_TYPES: Record<string, [number, (dv: DataView, o: number) => number]> =
	{
		char: [1, (d, o) => d.getInt8(o)],
		int8: [1, (d, o) => d.getInt8(o)],
		uchar: [1, (d, o) => d.getUint8(o)],
		uint8: [1, (d, o) => d.getUint8(o)],
		short: [2, (d, o) => d.getInt16(o, true)],
		int16: [2, (d, o) => d.getInt16(o, true)],
		ushort: [2, (d, o) => d.getUint16(o, true)],
		uint16: [2, (d, o) => d.getUint16(o, true)],
		int: [4, (d, o) => d.getInt32(o, true)],
		int32: [4, (d, o) => d.getInt32(o, true)],
		uint: [4, (d, o) => d.getUint32(o, true)],
		uint32: [4, (d, o) => d.getUint32(o, true)],
		float: [4, (d, o) => d.getFloat32(o, true)],
		float32: [4, (d, o) => d.getFloat32(o, true)],
		double: [8, (d, o) => d.getFloat64(o, true)],
		float64: [8, (d, o) => d.getFloat64(o, true)],
	};

/** Degree-0 spherical-harmonic constant: display colour = 0.5 + SH_C0 · f_dc. */
export const SH_C0 = 0.28209479177387814;
/** A 0..1 value as a clamped, rounded unorm8. */
export const to8 = (x: number) =>
	Math.max(0, Math.min(255, Math.round(x * 255))) | 0;

/**
 * Minimal reader for a standard 3DGS binary .ply (vertex element with x,y,z, f_dc_0..2, opacity (logit),
 * scale_0..2 (log), rot_0..3 (w,x,y,z)). Higher SH bands are ignored. Colour = 0.5 + C0·f_dc; alpha =
 * sigmoid(opacity); scales = exp; rotations normalised. Frame is "camera" unless told otherwise.
 * Only the first element may precede the vertex element if it has no list properties.
 */
export function decodeGaussianPly(
	buf: ArrayBuffer | ArrayBufferView,
	opts: { frame?: GaussianCloud["frame"]; provenance?: number } = {},
): GaussianCloud {
	const bytes =
		buf instanceof ArrayBuffer
			? new Uint8Array(buf)
			: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	// header is ASCII, ends with "end_header\n"
	const probe = new TextDecoder("latin1").decode(
		bytes.subarray(0, Math.min(bytes.length, 65536)),
	);
	const endTok = "end_header";
	const endAt = probe.indexOf(endTok);
	if (!probe.startsWith("ply") || endAt < 0) throw new Error("ply: bad header");
	let bodyStart = endAt + endTok.length;
	if (probe[bodyStart] === "\r") bodyStart++;
	if (probe[bodyStart] === "\n") bodyStart++;
	const lines = probe.slice(0, endAt).split(/\r?\n/);
	if (!lines.some((l) => l.trim() === "format binary_little_endian 1.0"))
		throw new Error("ply: only binary_little_endian is supported");
	type Elem = {
		name: string;
		count: number;
		props: { name: string; type: string; list?: [string, string] }[];
	};
	const elems: Elem[] = [];
	for (const l of lines) {
		const t = l.trim().split(/\s+/);
		if (t[0] === "element")
			elems.push({ name: t[1], count: Number(t[2]), props: [] });
		else if (t[0] === "property" && elems.length) {
			const e = elems[elems.length - 1];
			if (t[1] === "list")
				e.props.push({ name: t[4], type: t[3], list: [t[2], t[3]] });
			else e.props.push({ name: t[2], type: t[1] });
		}
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let o = bodyStart;
	for (const e of elems) {
		if (e.name !== "vertex") {
			if (e.props.some((p) => p.list))
				throw new Error("ply: list properties before vertex unsupported");
			const stride = e.props.reduce((s, p) => s + PLY_TYPES[p.type][0], 0);
			o += stride * e.count;
			continue;
		}
		const n = e.count;
		const offs: Record<string, number> = {};
		const readers: Record<string, (d: DataView, o: number) => number> = {};
		let stride = 0;
		for (const p of e.props) {
			if (p.list) throw new Error("ply: list property in vertex unsupported");
			const t = PLY_TYPES[p.type];
			if (!t) throw new Error(`ply: unknown type ${p.type}`);
			offs[p.name] = stride;
			readers[p.name] = t[1];
			stride += t[0];
		}
		if (o + stride * n > bytes.byteLength) throw new Error("ply: truncated");
		const need = (k: string) => {
			if (!(k in offs)) throw new Error(`ply: missing property ${k}`);
			return k;
		};
		const px = need("x");
		const py = need("y");
		const pz = need("z");
		const has = (k: string) => k in offs;
		const val = (row: number, k: string, dflt: number) =>
			has(k) ? readers[k](dv, row + offs[k]) : dflt;
		const positions = new Float32Array(3 * n);
		const scales = new Float32Array(3 * n);
		const rotations = new Float32Array(4 * n);
		const colors = new Uint8Array(4 * n);
		const provenance = new Uint8Array(n).fill(
			opts.provenance ?? PROVENANCE_CODE.reconstructed,
		);
		for (let i = 0; i < n; i++) {
			const row = o + i * stride;
			positions[3 * i] = readers[px](dv, row + offs[px]);
			positions[3 * i + 1] = readers[py](dv, row + offs[py]);
			positions[3 * i + 2] = readers[pz](dv, row + offs[pz]);
			for (let k = 0; k < 3; k++) {
				scales[3 * i + k] = Math.exp(val(row, `scale_${k}`, Math.log(0.01)));
				const dc = val(row, `f_dc_${k}`, Number.NaN);
				colors[4 * i + k] = Number.isNaN(dc)
					? val(row, ["red", "green", "blue"][k], 128)
					: to8(0.5 + SH_C0 * dc);
			}
			const op = val(row, "opacity", 10);
			colors[4 * i + 3] = to8(1 / (1 + Math.exp(-op)));
			let w = val(row, "rot_0", 1);
			let x = val(row, "rot_1", 0);
			let y = val(row, "rot_2", 0);
			let z = val(row, "rot_3", 0);
			const h = Math.hypot(w, x, y, z);
			let q = h || 1; // all-zero stays zero (divisor 1), as before
			// a NaN or infinite quaternion becomes the identity
			if (!Number.isFinite(h)) {
				w = 1;
				x = y = z = 0;
				q = 1;
			}
			rotations[4 * i] = w / q;
			rotations[4 * i + 1] = x / q;
			rotations[4 * i + 2] = y / q;
			rotations[4 * i + 3] = z / q;
		}
		return {
			count: n,
			frame: opts.frame ?? "camera",
			positions,
			scales,
			rotations,
			colors,
			provenance,
		};
	}
	throw new Error("ply: no vertex element");
}
