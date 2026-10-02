// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Binary form of a ViewpointTerrain, for terrain baked ahead of time (scripts/demo/bake-pano-terrain.ts)
// and read back by the panorama strip instead of a live trace. Layout: u32 header length, the header
// as UTF-8 JSON (scalars, peaks, and each array's type and length), zero padding to 4 bytes, then the
// arrays back to back, each starting on a 4-byte boundary. Pure: no DOM or Node APIs.
import type { ViewpointTerrain } from "./ridgelines";

const ARRAYS = [
	["pts", Float32Array],
	["start", Uint32Array],
	["slab", Uint8Array],
	["ridge", Uint8Array],
	["cuePts", Float32Array],
	["cueStart", Uint32Array],
	["cueSlab", Uint8Array],
	["skyline", Float32Array],
] as const;

type ArrayKey = (typeof ARRAYS)[number][0];
type Header = Omit<ViewpointTerrain, ArrayKey> & {
	lengths: Record<ArrayKey, number>;
};

const pad4 = (n: number) => (n + 3) & ~3;

export function encodeTerrain(t: ViewpointTerrain): Uint8Array {
	const { eye, slabs, dMin, dMax, step, peaks } = t;
	const lengths = Object.fromEntries(
		ARRAYS.map(([k]) => [k, t[k].length]),
	) as Record<ArrayKey, number>;
	const head = new TextEncoder().encode(
		JSON.stringify({
			eye,
			slabs,
			dMin,
			dMax,
			step,
			peaks,
			lengths,
		} satisfies Header),
	);
	let size = pad4(4 + head.length);
	for (const [k] of ARRAYS) size = pad4(size + t[k].byteLength);
	const out = new Uint8Array(size);
	new DataView(out.buffer).setUint32(0, head.length, true);
	out.set(head, 4);
	let at = pad4(4 + head.length);
	for (const [k] of ARRAYS) {
		const a = t[k];
		out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
		at = pad4(at + a.byteLength);
	}
	return out;
}

export function decodeTerrain(buf: ArrayBuffer): ViewpointTerrain {
	const n = new DataView(buf).getUint32(0, true);
	const h = JSON.parse(
		new TextDecoder().decode(new Uint8Array(buf, 4, n)),
	) as Header;
	const { lengths, ...scalars } = h;
	let at = pad4(4 + n);
	const arrays: Record<string, ArrayLike<number>> = {};
	for (const [k, Type] of ARRAYS) {
		// copied out, so each array owns an aligned buffer it can be transferred with
		arrays[k] = new Type(
			buf.slice(at, at + lengths[k] * Type.BYTES_PER_ELEMENT),
		);
		at = pad4(at + lengths[k] * Type.BYTES_PER_ELEMENT);
	}
	return { ...scalars, ...arrays } as ViewpointTerrain;
}

/** The cache key of a viewpoint's terrain: its eye (viewpointTerrain.ts memoises and bakes are looked up by it). */
export const terrainKey = (r: {
	lat: number;
	lon: number;
	eyeAlt: number | null;
}) =>
	`${r.lat.toFixed(5)},${r.lon.toFixed(5)},${r.eyeAlt?.toFixed(1) ?? "dem"}`;
