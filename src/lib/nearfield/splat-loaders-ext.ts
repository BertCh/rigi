// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.6: SPZ (Niantic Spatial) and KSPLAT (GaussianSplats3D) import through @loaders.gl/splats, decoded to
// our GaussianCloud. ./splat-loaders.ts sniffs both formats and imports this module only when one is parsed.
//
// The packages' loaders return a loaders.gl Mesh Arrow table (POSITION xyz, f_dc_0..2, opacity, scale_0..2,
// rot_0..3, f_rest_*); their activations are already applied: scales are linear standard deviations, rot is
// a unit quaternion (w, x, y, z), opacity is linear (alpha / 255; LoD formats may exceed 1), f_dc is the
// spherical-harmonic DC coefficient (SPZ stores it directly, KSPLAT's RGB bytes are converted to it). Our
// cloud keeps the same conventions (types.ts: scales linear metres, quaternion w, x, y, z) and RGBA u8 colours,
// so the conversion is: colour = to8(0.5 + SH_C0 · f_dc) (as decodeGaussianPly does), alpha = to8(opacity),
// everything else copied bit for bit. Higher SH bands are dropped (degree 0 only, as for PLY). Positions are
// taken as stored (frame "camera" unless told otherwise); SPZ axis conversions are the package's own
// (`sourceCoordinateSystem` / `targetCoordinateSystem`, none by default).
import { KSPLATLoader, SPZLoader } from "@loaders.gl/splats";
import { SH_C0, to8 } from "./splat-io";
import {
	type AsyncSplatLoader,
	KSPLAT_LOADER_INFO,
	SPZ_LOADER_INFO,
	type SplatExtLoaderOptions,
} from "./splat-loaders";
import { type GaussianCloud, PROVENANCE_CODE } from "./types";

/** The slice of an Apache Arrow column this module reads (a chunked vector of Float32 or fixed-size lists). */
type ArrowData = {
	length: number;
	values?: Float32Array;
	children: ArrowData[];
};
type ArrowColumn = { data: ArrowData[]; length: number };
type ArrowTable = {
	numRows: number;
	getChild(name: string): ArrowColumn | null;
};
type MeshTable = { shape: string; data: ArrowTable };

/** A Float32 column (`size` = 1) or fixed-size-list column of Float32 as one interleaved array. */
function column(table: ArrowTable, name: string, size: number): Float32Array {
	const col = table.getChild(name);
	if (!col) throw new Error(`splats: column ${name} missing`);
	const out = new Float32Array(col.length * size);
	let o = 0;
	for (const chunk of col.data) {
		// Arrow JS slices a chunk's buffers (and a list's child) to the chunk, so values start at its row 0
		const values = (size === 1 ? chunk : chunk.children[0]).values;
		if (!(values instanceof Float32Array))
			throw new Error(`splats: column ${name} is not float32`);
		out.set(values.subarray(0, chunk.length * size), o);
		o += chunk.length * size;
	}
	return out;
}

/** Interleave `size` scalar columns `${prefix}_0..` into one array. */
function interleave(table: ArrowTable, prefix: string, size: number) {
	const n = table.numRows;
	const out = new Float32Array(n * size);
	for (let k = 0; k < size; k++) {
		const c = column(table, `${prefix}_${k}`, 1);
		for (let i = 0; i < n; i++) out[i * size + k] = c[i];
	}
	return out;
}

/** A loaders.gl Gaussian-splats Arrow table as our GaussianCloud. */
export function cloudFromSplatsTable(
	mesh: MeshTable,
	options: SplatExtLoaderOptions = {},
): GaussianCloud {
	if (mesh.shape !== "arrow-table")
		throw new Error(`splats: unexpected shape ${mesh.shape}`);
	const table = mesh.data;
	const n = table.numRows;
	const positions = column(table, "POSITION", 3);
	const dc = interleave(table, "f_dc", 3);
	const opacity = column(table, "opacity", 1);
	const colors = new Uint8Array(4 * n);
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < 3; k++)
			colors[4 * i + k] = to8(0.5 + SH_C0 * dc[3 * i + k]);
		colors[4 * i + 3] = to8(opacity[i]);
	}
	return {
		count: n,
		frame: options.frame ?? "camera",
		positions,
		scales: interleave(table, "scale", 3),
		rotations: interleave(table, "rot", 4),
		colors,
		provenance: new Uint8Array(n).fill(
			options.provenance ?? PROVENANCE_CODE.reconstructed,
		),
	};
}

type ParserLoader = {
	parse(arrayBuffer: ArrayBuffer, options?: object): Promise<unknown>;
};

/** The parser-bearing loader behind a metadata loader (loaders.gl `preload`), resolved once. */
function parserOf(loader: { preload(): Promise<unknown> }) {
	let p: Promise<ParserLoader> | null = null;
	return () => {
		p ??= loader.preload() as Promise<ParserLoader>;
		return p;
	};
}
const spzParser = parserOf(SPZLoader);
const ksplatParser = parserOf(KSPLATLoader);

export const SplatSpzLoader: AsyncSplatLoader<SplatExtLoaderOptions> = {
	...SPZ_LOADER_INFO,
	parse: async (arrayBuffer, options) => {
		const o = options?.["splat-spz"] ?? {};
		const splats: Record<string, string> = { shape: "arrow-table" };
		if (o.sourceCoordinateSystem)
			splats.sourceCoordinateSystem = o.sourceCoordinateSystem;
		if (o.targetCoordinateSystem)
			splats.targetCoordinateSystem = o.targetCoordinateSystem;
		const mesh = await (await spzParser()).parse(arrayBuffer, { splats });
		return cloudFromSplatsTable(mesh as MeshTable, o);
	},
};

export const SplatKsplatLoader: AsyncSplatLoader<SplatExtLoaderOptions> = {
	...KSPLAT_LOADER_INFO,
	parse: async (arrayBuffer, options) => {
		const mesh = await (await ksplatParser()).parse(arrayBuffer);
		return cloudFromSplatsTable(
			mesh as MeshTable,
			options?.["splat-ksplat"] ?? {},
		);
	},
};
