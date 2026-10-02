// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The sample trip's people masks, baked once by scripts/demo/bake-people-masks.mjs with the roll
// map's own path (#/lib/segment segmentForeground on its 1024 px working copy of the full-size
// photo), so the landing's live map never downloads the segmentation weights. One gzip'd file, decoded here; no import of #/lib/segment.
//
// Layout (little-endian, before gzip): "RPM1", u32 count, then per mask: u8 id length, the id
// (ASCII), u16 width, u16 height (0 × 0 = segmentForeground returned null), width·height bytes.
import type { ForegroundMask } from "../segment";

export const PEOPLE_MASKS_URL = "/demo/masks/people-masks.bin";
const MAGIC = "RPM1";

export type PeopleMasks = Map<string, ForegroundMask | null>;

/** Parse the uncompressed layout above. */
export function decodePeopleMasks(bytes: Uint8Array): PeopleMasks {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// a wrong magic means a stale or foreign file: the caller falls back to live segmentation
	if (String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC)
		throw new Error("people masks: bad magic");
	const count = view.getUint32(4, true);
	const out: PeopleMasks = new Map();
	let at = 8;
	for (let i = 0; i < count; i++) {
		const idLength = bytes[at++];
		const id = String.fromCharCode(...bytes.subarray(at, at + idLength));
		at += idLength;
		const width = view.getUint16(at, true);
		const height = view.getUint16(at + 2, true);
		at += 4;
		if (!width || !height) {
			out.set(id, null);
			continue;
		}
		out.set(id, {
			width,
			height,
			data: bytes.slice(at, at + width * height),
		});
		at += width * height;
	}
	return out;
}

/** Build the uncompressed layout above (the bake script gzips it). */
export function encodePeopleMasks(masks: PeopleMasks): Uint8Array {
	let size = 8;
	for (const [id, m] of masks)
		size += 1 + id.length + 4 + (m ? m.data.length : 0);
	const bytes = new Uint8Array(size);
	const view = new DataView(bytes.buffer);
	for (let k = 0; k < 4; k++) bytes[k] = MAGIC.charCodeAt(k);
	view.setUint32(4, masks.size, true);
	let at = 8;
	for (const [id, m] of masks) {
		bytes[at++] = id.length;
		for (let k = 0; k < id.length; k++) bytes[at++] = id.charCodeAt(k);
		view.setUint16(at, m?.width ?? 0, true);
		view.setUint16(at + 2, m?.height ?? 0, true);
		at += 4;
		if (m) {
			bytes.set(m.data, at);
			at += m.data.length;
		}
	}
	return bytes;
}

let loaded: Promise<PeopleMasks> | null = null;

/** Fetch and decode the baked masks once (gunzip via DecompressionStream). */
export function loadDemoPeopleMasks(): Promise<PeopleMasks> {
	loaded ??= fetch(PEOPLE_MASKS_URL)
		.then((r) => {
			if (!r.ok || !r.body) throw new Error(`people masks: HTTP ${r.status}`);
			return new Response(
				r.body.pipeThrough(new DecompressionStream("gzip")),
			).arrayBuffer();
		})
		.then((b) => decodePeopleMasks(new Uint8Array(b)))
		.catch((e) => {
			loaded = null;
			throw e;
		});
	return loaded;
}
