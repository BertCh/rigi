// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Persistent per-photo depth cache for Step Inside (the former near-field service kept ~1 GB of depth
// results on disk; the in-memory WeakMap in ./client.ts did not survive a reload).
//   key    = SHA-256 of [CACHE_FORMAT, weights file, depth grid long side, tokens] + the photo's bytes.
//   record = a small JSON header (grid, intrinsics, focal / shift, model, seconds) + depth as f16
//            (relative error <= 2^-11) + the valid mask as 1 bit per pixel + normals octahedral-encoded
//            as 2 x int8 per pixel (max angle error OCT_MAX_ANGLE_DEG, measured in the spec), wrapped in a
//            one-byte envelope that gzips the record when that saves >= 10 %. The photo's RGBA is NOT
//            stored: a hit decodes the blob again (cheap next to the network).
//   store  = Cache Storage "rigi-nearfield-depth-v1" under synthetic URLs, plus one JSON index entry
//            {key, bytes, lastUsed} for a byte-budget LRU (DEPTH_CACHE_BUDGET). Any storage failure
//            (private mode, quota, no `caches` in node) degrades to "no cache", never an error.
// The encode / decode / evictLru functions are pure; the storage sits behind DepthCacheBackend so specs
// use an in-memory fake.
import { floatToHalf, halfToFloat32 } from "#/lib/nn/safetensors";
import type { NearFieldDepth } from "../types";

/** Bump on any change of the record layout or of what the key covers. */
export const CACHE_FORMAT = 1;
export const DEPTH_CACHE_NAME = "rigi-nearfield-depth-v1";
/** Byte budget of all records (the LRU evicts the least recently used beyond it). */
export const DEPTH_CACHE_BUDGET = 256 * 1024 * 1024;
/** Worst octahedral int8 angle error over the sphere (degrees); the spec measures it. */
export const OCT_MAX_ANGLE_DEG = 1;
const INDEX_KEY = "__index__";
const URL_PREFIX = "https://rigi.local/nearfield-depth/";
/** gzip is kept only when it shrinks the record by at least this fraction. */
const GZIP_MIN_SAVING = 0.1;

export type DepthWithFit = NearFieldDepth & { focal: number; shift: number };

/** Byte storage the cache sits on (Cache Storage in the browser, a Map in specs). */
export type DepthCacheBackend = {
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, bytes: Uint8Array): Promise<void>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
};

export type IndexEntry = { key: string; bytes: number; lastUsed: number };
export type DepthCacheOpts = {
	backend?: DepthCacheBackend | null;
	budget?: number;
};

// ---------- octahedral normals -------------------------------------------------------------------

/** "No normal" (the zero vector) as a code pair: int8 -128 is never produced by the encoder (it clamps to +-127). */
const OCT_NONE = -128;

/** Unit vector → two int8 snorm codes (octahedral map); the zero / non-finite vector → [-128, -128]. */
export function octEncode(
	x: number,
	y: number,
	z: number,
	out: Int8Array | number[] = [0, 0],
	at = 0,
): void {
	const l = Math.abs(x) + Math.abs(y) + Math.abs(z);
	if (!(l > 0) || !Number.isFinite(l)) {
		out[at] = OCT_NONE;
		out[at + 1] = OCT_NONE;
		return;
	}
	let u = x / l;
	let v = y / l;
	if (z < 0) {
		const a = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
		const b = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
		u = a;
		v = b;
	}
	out[at] = Math.max(-127, Math.min(127, Math.round(u * 127)));
	out[at + 1] = Math.max(-127, Math.min(127, Math.round(v * 127)));
}

/** Inverse of octEncode: a unit vector, or [0, 0, 0] for the "none" code. */
export function octDecode(
	a: number,
	b: number,
	out: Float32Array | number[] = [0, 0, 0],
	at = 0,
): void {
	if (a === OCT_NONE && b === OCT_NONE) {
		out[at] = 0;
		out[at + 1] = 0;
		out[at + 2] = 0;
		return;
	}
	const u = a / 127;
	const v = b / 127;
	const z = 1 - Math.abs(u) - Math.abs(v);
	let x = u;
	let y = v;
	if (z < 0) {
		x = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
		y = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
	}
	const n = Math.hypot(x, y, z) || 1;
	out[at] = x / n;
	out[at + 1] = y / n;
	out[at + 2] = z / n;
}

// ---------- record encode / decode ---------------------------------------------------------------

type Header = {
	format: number;
	width: number;
	height: number;
	intrinsicsNorm: NearFieldDepth["intrinsicsNorm"] | null;
	focal: number;
	shift: number;
	model: string;
	seconds: number;
	hasNormal: boolean;
};

const MAGIC = [0x52, 0x44, 0x43]; // "RDC"

/**
 * Layout: "RDC" format(u8) headerLen(u32 LE) header(JSON) | depth f16 (n x 2) | valid bits (ceil(n/8)) |
 * normals int8 (n x 2, only when hasNormal). Depth keeps NaN / <= 0 as 0 and clamps to the f16 range.
 */
export function encodeDepthRecord(d: DepthWithFit): Uint8Array {
	const n = d.width * d.height;
	const header: Header = {
		format: CACHE_FORMAT,
		width: d.width,
		height: d.height,
		intrinsicsNorm: d.intrinsicsNorm ?? null,
		focal: Number.isFinite(d.focal) ? d.focal : 0,
		shift: Number.isFinite(d.shift) ? d.shift : 0,
		model: d.model,
		seconds: d.seconds,
		hasNormal: !!d.normal,
	};
	const head = new TextEncoder().encode(JSON.stringify(header));
	const maskBytes = (n + 7) >> 3;
	const normalBytes = d.normal ? 2 * n : 0;
	const out = new Uint8Array(8 + head.length + 2 * n + maskBytes + normalBytes);
	out.set(MAGIC, 0);
	out[3] = CACHE_FORMAT;
	const dv = new DataView(out.buffer);
	dv.setUint32(4, head.length, true);
	out.set(head, 8);
	let o = 8 + head.length;
	for (let k = 0; k < n; k++) {
		const v = d.depth[k];
		const h = v > 0 ? floatToHalf(Math.min(v, 65504)) : 0;
		out[o + 2 * k] = h & 0xff;
		out[o + 2 * k + 1] = h >> 8;
	}
	o += 2 * n;
	for (let k = 0; k < n; k++) if (d.valid[k]) out[o + (k >> 3)] |= 1 << (k & 7);
	o += maskBytes;
	if (d.normal) {
		const codes = new Int8Array(out.buffer, o, 2 * n);
		for (let k = 0; k < n; k++)
			octEncode(
				d.normal[3 * k],
				d.normal[3 * k + 1],
				d.normal[3 * k + 2],
				codes,
				2 * k,
			);
	}
	return out;
}

/** The record's depth, or null for anything that is not a complete record of this format. */
export function decodeDepthRecord(bytes: Uint8Array): DepthWithFit | null {
	try {
		if (bytes.length < 8) return null;
		if (MAGIC.some((m, i) => bytes[i] !== m) || bytes[3] !== CACHE_FORMAT)
			return null;
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const headLen = dv.getUint32(4, true);
		if (8 + headLen > bytes.length) return null;
		const h = JSON.parse(
			new TextDecoder().decode(bytes.subarray(8, 8 + headLen)),
		) as Header;
		if (h.format !== CACHE_FORMAT) return null;
		const { width, height } = h;
		if (!(width > 0 && height > 0 && Number.isInteger(width * height)))
			return null;
		const n = width * height;
		const maskBytes = (n + 7) >> 3;
		const need = 8 + headLen + 2 * n + maskBytes + (h.hasNormal ? 2 * n : 0);
		if (bytes.length !== need) return null;
		let o = 8 + headLen;
		const half = new Uint16Array(n);
		for (let k = 0; k < n; k++)
			half[k] = bytes[o + 2 * k] | (bytes[o + 2 * k + 1] << 8);
		const depth = halfToFloat32(half);
		o += 2 * n;
		const valid = new Uint8Array(n);
		for (let k = 0; k < n; k++) valid[k] = (bytes[o + (k >> 3)] >> (k & 7)) & 1;
		o += maskBytes;
		let normal: Float32Array | undefined;
		if (h.hasNormal) {
			normal = new Float32Array(3 * n);
			for (let k = 0; k < n; k++)
				octDecode(
					(bytes[o + 2 * k] << 24) >> 24,
					(bytes[o + 2 * k + 1] << 24) >> 24,
					normal,
					3 * k,
				);
		}
		return {
			width,
			height,
			depth,
			valid,
			...(normal ? { normal } : {}),
			...(h.intrinsicsNorm ? { intrinsicsNorm: h.intrinsicsNorm } : {}),
			model: h.model,
			seconds: h.seconds,
			focal: h.focal ?? 0,
			shift: h.shift ?? 0,
		};
	} catch {
		return null;
	}
}

async function pipeBytes(
	bytes: Uint8Array,
	stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
	const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Envelope: byte 0 = 0 raw / 1 gzip; gzip only when CompressionStream exists and saves >= 10 %. */
export async function packRecord(record: Uint8Array): Promise<Uint8Array> {
	let body = record;
	let kind = 0;
	if (typeof CompressionStream !== "undefined") {
		try {
			const z = await pipeBytes(record, new CompressionStream("gzip"));
			if (z.length <= record.length * (1 - GZIP_MIN_SAVING)) {
				body = z;
				kind = 1;
			}
		} catch {
			// raw
		}
	}
	const out = new Uint8Array(1 + body.length);
	out[0] = kind;
	out.set(body, 1);
	return out;
}

export async function unpackRecord(
	packed: Uint8Array,
): Promise<Uint8Array | null> {
	try {
		if (packed.length < 2) return null;
		const body = packed.subarray(1);
		if (packed[0] === 0) return body;
		if (packed[0] === 1 && typeof DecompressionStream !== "undefined")
			return await pipeBytes(body, new DecompressionStream("gzip"));
		return null;
	} catch {
		return null;
	}
}

// ---------- LRU ----------------------------------------------------------------------------------

/**
 * The least recently used entries to drop so that the rest fits `budget` bytes (oldest first; ties keep
 * index order). `keep` is never evicted by this call (the record just written).
 */
export function evictLru(
	index: readonly IndexEntry[],
	budget: number,
	keep?: string,
): string[] {
	let total = 0;
	for (const e of index) total += e.bytes;
	const evicted: string[] = [];
	const order = index
		.map((e, i) => ({ e, i }))
		.sort((a, b) => a.e.lastUsed - b.e.lastUsed || a.i - b.i);
	for (const { e } of order) {
		if (total <= budget) break;
		if (e.key === keep) continue;
		evicted.push(e.key);
		total -= e.bytes;
	}
	return evicted;
}

// ---------- backend: Cache Storage ---------------------------------------------------------------

/** Cache Storage as a backend, or null where `caches` does not exist (node, insecure contexts). */
export function cacheStorageBackend(
	name = DEPTH_CACHE_NAME,
): DepthCacheBackend | null {
	if (typeof caches === "undefined") return null;
	let opened: Promise<Cache> | null = null;
	const open = () => {
		opened ??= caches.open(name);
		return opened;
	};
	const url = (key: string) => `${URL_PREFIX}${key}`;
	return {
		async get(key) {
			const res = await (await open()).match(url(key));
			return res ? new Uint8Array(await res.arrayBuffer()) : null;
		},
		async put(key, bytes) {
			await (await open()).put(
				url(key),
				new Response(bytes as BodyInit, {
					headers: { "content-type": "application/octet-stream" },
				}),
			);
		},
		async delete(key) {
			await (await open()).delete(url(key));
		},
		async keys() {
			return (await (await open()).keys()).map((r) =>
				r.url.slice(URL_PREFIX.length),
			);
		},
	};
}

let sharedBackend: DepthCacheBackend | null | undefined;
function resolveBackend(opts: DepthCacheOpts): DepthCacheBackend | null {
	if (opts.backend !== undefined) return opts.backend;
	if (sharedBackend === undefined) sharedBackend = cacheStorageBackend();
	return sharedBackend;
}

// ---------- index (serialised per backend) -------------------------------------------------------

const chains = new WeakMap<DepthCacheBackend, Promise<unknown>>();
/** Index read-modify-writes of one backend run one after the other (re-read each time: other tabs write too). */
function withIndex<T>(
	backend: DepthCacheBackend,
	fn: (index: IndexEntry[], save: () => Promise<void>) => Promise<T>,
): Promise<T> {
	const run = async () => {
		let index: IndexEntry[] = [];
		try {
			const raw = await backend.get(INDEX_KEY);
			if (raw) {
				const parsed = JSON.parse(new TextDecoder().decode(raw));
				if (Array.isArray(parsed)) index = parsed as IndexEntry[];
			}
		} catch {
			index = [];
		}
		const save = () =>
			backend.put(INDEX_KEY, new TextEncoder().encode(JSON.stringify(index)));
		return fn(index, save);
	};
	const next = (chains.get(backend) ?? Promise.resolve()).then(run, run);
	chains.set(
		backend,
		next.catch(() => {}),
	);
	return next;
}

const nextStamp = (index: readonly IndexEntry[]) =>
	Math.max(Date.now(), ...index.map((e) => e.lastUsed + 1));

// ---------- public API ---------------------------------------------------------------------------

export type DepthCacheKeyParts = {
	/** the weights variant file name (client.weightsFile) */
	weights: string;
	/** the depth grid's long side (maxSide) */
	size: number;
	tokens: number;
};

/** SHA-256 hex of the key parts and the photo's bytes; null where crypto.subtle is missing. */
export async function depthCacheKey(
	blob: Blob,
	parts: DepthCacheKeyParts,
): Promise<string | null> {
	try {
		const subtle = globalThis.crypto?.subtle;
		if (!subtle) return null;
		const head = new TextEncoder().encode(
			`${CACHE_FORMAT}|${parts.weights}|${parts.size}|${parts.tokens}|`,
		);
		const body = new Uint8Array(await blob.arrayBuffer());
		const all = new Uint8Array(head.length + body.length);
		all.set(head, 0);
		all.set(body, head.length);
		const digest = new Uint8Array(await subtle.digest("SHA-256", all));
		return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}

/** The cached depth for `key` (touching it for the LRU), or null on a miss, a corrupt record or any storage failure. */
export async function getCachedDepth(
	key: string,
	opts: DepthCacheOpts = {},
): Promise<DepthWithFit | null> {
	const backend = resolveBackend(opts);
	if (!backend) return null;
	try {
		const packed = await backend.get(key);
		if (!packed) return null;
		const record = await unpackRecord(packed);
		const depth = record ? decodeDepthRecord(record) : null;
		if (!depth) {
			void backend.delete(key).catch(() => {});
			void withIndex(backend, async (index, save) => {
				const at = index.findIndex((e) => e.key === key);
				if (at >= 0) {
					index.splice(at, 1);
					await save();
				}
			}).catch(() => {});
			return null;
		}
		// touch (fire and forget): only an entry the index still lists
		void withIndex(backend, async (index, save) => {
			const e = index.find((x) => x.key === key);
			if (!e) return;
			e.lastUsed = nextStamp(index);
			await save();
		}).catch(() => {});
		return depth;
	} catch {
		return null;
	}
}

/** Store the depth under `key` and evict least recently used records beyond the budget. Never throws. */
export async function putCachedDepth(
	key: string,
	depth: DepthWithFit,
	opts: DepthCacheOpts = {},
): Promise<void> {
	const backend = resolveBackend(opts);
	if (!backend) return;
	const budget = opts.budget ?? DEPTH_CACHE_BUDGET;
	try {
		const packed = await packRecord(encodeDepthRecord(depth));
		if (packed.length > budget) return;
		await withIndex(backend, async (index, save) => {
			const old = index.findIndex((e) => e.key === key);
			if (old >= 0) index.splice(old, 1);
			await backend.put(key, packed);
			index.push({ key, bytes: packed.length, lastUsed: nextStamp(index) });
			const evicted = evictLru(index, budget, key);
			for (const k of evicted) {
				index.splice(
					index.findIndex((e) => e.key === k),
					1,
				);
				await backend.delete(k).catch(() => {});
			}
			await save();
		});
	} catch {
		// no cache
	}
}

/** Drop every record and the index. Never throws. */
export async function clearDepthCache(
	opts: DepthCacheOpts = {},
): Promise<void> {
	const backend = resolveBackend(opts);
	if (!backend) return;
	try {
		await withIndex(backend, async () => {
			for (const k of await backend.keys()) await backend.delete(k);
		});
	} catch {
		// nothing to clear
	}
}
