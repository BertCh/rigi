// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// loaders.gl-shaped loaders for the two splat formats we read: ".splat-v1" and a standard 3DGS binary
// ".ply". They follow the loaders.gl `LoaderWithParser` contract (name, id, module, version, extensions,
// mimeTypes, binary, tests, options, parse, parseSync) but import nothing from @loaders.gl at runtime,
// so a real `load(url, SplatV1Loader)` call works with them and no dependency is added. The output is
// our packed GaussianCloud; the parsing itself stays in splat-io.ts (these are thin, bit-identical wrappers).
//
// SPZ, KSPLAT (WAG W2.6) and plain ".splat" are sniffed here too, but parsed by @loaders.gl/splats in ./splat-loaders-ext.ts,
// which this module imports only when such a file is parsed. They are async-only (SPZ v4 inflates zstd
// streams): parse them with `parseSplat` (or the loader's `parse`), not `parseSplatSync`.
import { decodeGaussianPly, decodeSplatV1, SPLAT_V1_MAGIC } from "./splat-io";
import type { GaussianCloud } from "./types";

/** Structural stand-in for loaders.gl's `LoaderWithParser` (kept local; @loaders.gl is not a direct dependency). */
export type SplatLoader<Options extends object> = {
	readonly name: string;
	readonly id: string;
	readonly module: string;
	readonly version: string;
	readonly extensions: readonly string[];
	readonly mimeTypes: readonly string[];
	readonly binary: true;
	/** Magic-number sniffers: strings are compared with the file start, functions get the buffer. */
	readonly tests: readonly ((arrayBuffer: ArrayBuffer) => boolean)[];
	readonly options: Record<string, Options>;
	parse(
		arrayBuffer: ArrayBuffer,
		options?: { [key: string]: Options | undefined },
	): Promise<GaussianCloud>;
	parseSync(
		arrayBuffer: ArrayBuffer,
		options?: { [key: string]: Options | undefined },
	): GaussianCloud;
};

export type SplatPlyLoaderOptions = {
	frame?: GaussianCloud["frame"];
	provenance?: number;
};

/** A loader without `parseSync` (its parser is asynchronous or lazily imported). */
export type AsyncSplatLoader<Options extends object> = Omit<
	SplatLoader<Options>,
	"parseSync"
>;

/** Options of the SPZ / KSPLAT loaders (./splat-loaders-ext.ts). */
export type SplatExtLoaderOptions = {
	/** Frame label of the decoded cloud. Default "camera" (positions as stored, like the PLY loader). */
	frame?: GaussianCloud["frame"];
	/** PROVENANCE_CODE for every splat. Default reconstructed. */
	provenance?: number;
	/** SPZ only: @loaders.gl/splats axis conversion (`splats.source/targetCoordinateSystem`). Default none. */
	sourceCoordinateSystem?: "RUB" | "LUF" | "RUF" | "UNSPECIFIED";
	targetCoordinateSystem?: "RUB" | "LUF" | "RUF" | "UNSPECIFIED";
};

const LOADER_VERSION = "1.0.0";

const startsWith = (arrayBuffer: ArrayBuffer, text: string) => {
	if (arrayBuffer.byteLength < text.length) return false;
	const head = new Uint8Array(arrayBuffer, 0, text.length);
	for (let i = 0; i < text.length; i++)
		if (head[i] !== text.charCodeAt(i)) return false;
	return true;
};

export const SplatV1Loader: SplatLoader<Record<string, never>> = {
	name: "Rigi splat-v1",
	id: "splat-v1",
	module: "rigi",
	version: LOADER_VERSION,
	extensions: ["splat-v1"],
	mimeTypes: ["application/x-rigi-splat-v1"],
	binary: true,
	tests: [(buffer) => startsWith(buffer, SPLAT_V1_MAGIC)],
	options: { "splat-v1": {} },
	parseSync: (arrayBuffer) => decodeSplatV1(arrayBuffer),
	parse: async (arrayBuffer) => decodeSplatV1(arrayBuffer),
};

export const SplatPlyLoader: SplatLoader<SplatPlyLoaderOptions> = {
	name: "3DGS PLY (binary little endian)",
	id: "splat-ply",
	module: "rigi",
	version: LOADER_VERSION,
	extensions: ["ply"],
	mimeTypes: ["application/octet-stream"],
	binary: true,
	tests: [(buffer) => startsWith(buffer, "ply")],
	options: { "splat-ply": {} },
	parseSync: (arrayBuffer, options) =>
		decodeGaussianPly(arrayBuffer, options?.["splat-ply"] ?? {}),
	parse: async (arrayBuffer, options) =>
		decodeGaussianPly(arrayBuffer, options?.["splat-ply"] ?? {}),
};

export const SPLAT_LOADERS = [SplatV1Loader, SplatPlyLoader] as const;

// ---- SPZ / KSPLAT: sniffed here, parsed by @loaders.gl/splats in ./splat-loaders-ext.ts ----

/** SPZ v4 starts with "NGSP"; v2/v3 are a gzip stream (1f 8b) holding that header. */
export const isSpz = (arrayBuffer: ArrayBuffer) => {
	if (startsWith(arrayBuffer, "NGSP")) return true;
	if (arrayBuffer.byteLength < 2) return false;
	const head = new Uint8Array(arrayBuffer, 0, 2);
	return head[0] === 0x1f && head[1] === 0x8b;
};

/**
 * KSPLAT (GaussianSplats3D) has no magic: a 4096-byte header with version 0.≥1, compression level 0–2 at
 * byte 20 and 1024-byte section headers after it. Sniffed last, after every format with a magic.
 */
export const isKsplat = (arrayBuffer: ArrayBuffer) => {
	if (arrayBuffer.byteLength < 4096 + 1024) return false;
	const dv = new DataView(arrayBuffer, 0, 4096);
	const maxSections = dv.getUint32(4, true);
	return (
		dv.getUint8(0) === 0 &&
		dv.getUint8(1) >= 1 &&
		dv.getUint16(20, true) <= 2 &&
		maxSections >= 1 &&
		dv.getUint32(8, true) <= maxSections &&
		arrayBuffer.byteLength >= 4096 + maxSections * 1024
	);
};

/** Bytes per record of the plain ".splat" format (antimatter15): f32 xyz, f32 scale xyz, u8 rgba, u8 quaternion. */
export const SPLAT_RECORD_BYTES = 32;

/**
 * Plain ".splat" has no magic and no header: a bare array of 32-byte records. Sniffed after every other
 * format (it is the weakest test): a non-empty length that is a multiple of 32 and, in the first 64
 * records, finite positions with finite, strictly positive scales (linear, already exponentiated).
 */
export const isPlainSplat = (arrayBuffer: ArrayBuffer) => {
	const n = arrayBuffer.byteLength / SPLAT_RECORD_BYTES;
	if (n === 0 || !Number.isInteger(n)) return false;
	const dv = new DataView(arrayBuffer);
	for (let i = 0; i < Math.min(n, 64); i++) {
		const o = i * SPLAT_RECORD_BYTES;
		for (let k = 0; k < 3; k++) {
			if (!Number.isFinite(dv.getFloat32(o + 4 * k, true))) return false;
			const scale = dv.getFloat32(o + 12 + 4 * k, true);
			if (!(scale > 0 && scale < Number.POSITIVE_INFINITY)) return false;
		}
	}
	return true;
};

/** Shared metadata of the SPZ / KSPLAT / plain-splat loaders (the parsers live in ./splat-loaders-ext.ts). */
export const SPZ_LOADER_INFO = {
	name: "SPZ (@loaders.gl/splats)",
	id: "splat-spz",
	module: "rigi",
	version: LOADER_VERSION,
	extensions: ["spz"],
	mimeTypes: ["application/octet-stream"],
	binary: true,
	tests: [isSpz],
	options: { "splat-spz": {} },
} as const satisfies Omit<AsyncSplatLoader<SplatExtLoaderOptions>, "parse">;

export const KSPLAT_LOADER_INFO = {
	name: "KSPLAT (@loaders.gl/splats)",
	id: "splat-ksplat",
	module: "rigi",
	version: LOADER_VERSION,
	extensions: ["ksplat"],
	mimeTypes: ["application/octet-stream"],
	binary: true,
	tests: [isKsplat],
	options: { "splat-ksplat": {} },
} as const satisfies Omit<AsyncSplatLoader<SplatExtLoaderOptions>, "parse">;

export const SPLAT_PLAIN_LOADER_INFO = {
	name: "Plain .splat (@loaders.gl/splats)",
	id: "splat-plain",
	module: "rigi",
	version: LOADER_VERSION,
	extensions: ["splat"],
	mimeTypes: ["application/octet-stream"],
	binary: true,
	tests: [isPlainSplat],
	options: { "splat-plain": {} },
} as const satisfies Omit<AsyncSplatLoader<SplatExtLoaderOptions>, "parse">;

const ext = () => import("./splat-loaders-ext");

/** SPZ loader that imports @loaders.gl/splats on first parse (see SplatSpzLoader in ./splat-loaders-ext.ts). */
export const SplatSpzLoaderLazy: AsyncSplatLoader<SplatExtLoaderOptions> = {
	...SPZ_LOADER_INFO,
	parse: async (arrayBuffer, options) =>
		(await ext()).SplatSpzLoader.parse(arrayBuffer, options),
};

/** KSPLAT loader that imports @loaders.gl/splats on first parse. */
export const SplatKsplatLoaderLazy: AsyncSplatLoader<SplatExtLoaderOptions> = {
	...KSPLAT_LOADER_INFO,
	parse: async (arrayBuffer, options) =>
		(await ext()).SplatKsplatLoader.parse(arrayBuffer, options),
};

/** Plain .splat loader that imports @loaders.gl/splats on first parse. */
export const SplatPlainLoaderLazy: AsyncSplatLoader<SplatExtLoaderOptions> = {
	...SPLAT_PLAIN_LOADER_INFO,
	parse: async (arrayBuffer, options) =>
		(await ext()).SplatPlainLoader.parse(arrayBuffer, options),
};

export const SPLAT_EXT_LOADERS = [
	SplatSpzLoaderLazy,
	SplatKsplatLoaderLazy,
	SplatPlainLoaderLazy,
] as const;

type AnySplatLoader =
	| (typeof SPLAT_LOADERS)[number]
	| (typeof SPLAT_EXT_LOADERS)[number];

/** Pick the loader whose `tests` match the buffer (magic sniffing; v1, PLY, SPZ, KSPLAT, then plain .splat), or null. */
export function selectSplatLoader(
	arrayBuffer: ArrayBuffer,
): AnySplatLoader | null {
	for (const loader of [...SPLAT_LOADERS, ...SPLAT_EXT_LOADERS])
		if (loader.tests.some((test) => test(arrayBuffer))) return loader;
	return null;
}

/** Parse .splat-v1 or PLY by magic sniffing. Throws when neither matches (SPZ / KSPLAT / .splat: use parseSplat). */
export function parseSplatSync(
	arrayBuffer: ArrayBuffer,
	plyOptions: SplatPlyLoaderOptions = {},
): GaussianCloud {
	const loader = selectSplatLoader(arrayBuffer);
	if (!loader) throw new Error("nearfield: unknown gaussian format");
	if (loader === SplatV1Loader) return SplatV1Loader.parseSync(arrayBuffer);
	if (loader === SplatPlyLoader)
		return SplatPlyLoader.parseSync(arrayBuffer, { "splat-ply": plyOptions });
	throw new Error(
		`nearfield: ${loader.name} parses asynchronously (use parseSplat)`,
	);
}

/** Parse any of the five formats by magic sniffing. `options` apply to PLY, SPZ, KSPLAT and plain .splat. */
export async function parseSplat(
	arrayBuffer: ArrayBuffer,
	options: SplatExtLoaderOptions = {},
): Promise<GaussianCloud> {
	const loader = selectSplatLoader(arrayBuffer);
	if (!loader) throw new Error("nearfield: unknown gaussian format");
	if (loader === SplatV1Loader) return SplatV1Loader.parseSync(arrayBuffer);
	if (loader === SplatPlyLoader) {
		const { frame, provenance } = options;
		return SplatPlyLoader.parseSync(arrayBuffer, {
			"splat-ply": { frame, provenance },
		});
	}
	// what is left is SPZ, KSPLAT or plain .splat
	const extLoader = loader as AsyncSplatLoader<SplatExtLoaderOptions>;
	return extLoader.parse(arrayBuffer, { [extLoader.id]: options });
}
