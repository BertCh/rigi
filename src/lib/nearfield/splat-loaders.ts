// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// loaders.gl-shaped loaders for the two splat formats we read: ".splat-v1" and a standard 3DGS binary
// ".ply". They follow the loaders.gl `LoaderWithParser` contract (name, id, module, version, extensions,
// mimeTypes, binary, tests, options, parse, parseSync) but import nothing from @loaders.gl at runtime,
// so a real `load(url, SplatV1Loader)` call works with them and no dependency is added. The output is
// our packed GaussianCloud; the parsing itself stays in splat-io.ts (these are thin, bit-identical wrappers).
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

/** Pick the loader whose `tests` match the buffer (magic sniffing), or null. */
export function selectSplatLoader(
	arrayBuffer: ArrayBuffer,
): (typeof SPLAT_LOADERS)[number] | null {
	for (const loader of SPLAT_LOADERS)
		if (loader.tests.some((test) => test(arrayBuffer))) return loader;
	return null;
}

/** Parse either format by magic sniffing. Throws when neither matches. */
export function parseSplatSync(
	arrayBuffer: ArrayBuffer,
	plyOptions: SplatPlyLoaderOptions = {},
): GaussianCloud {
	const loader = selectSplatLoader(arrayBuffer);
	if (!loader) throw new Error("nearfield: unknown gaussian format");
	return loader === SplatV1Loader
		? SplatV1Loader.parseSync(arrayBuffer)
		: SplatPlyLoader.parseSync(arrayBuffer, { "splat-ply": plyOptions });
}
