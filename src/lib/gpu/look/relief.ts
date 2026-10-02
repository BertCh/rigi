// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU twin of look/relief/field.ts buildReliefField: the heights are still rasterised on the CPU
// (rasterizeHeights, ~15 ms: tile lookups), then shadow, sky view, curvature and the generalised
// normal run as WGSL kernels (relief.wgsl.ts) and the two RGBA8 textures are read back. The passes
// run as one core ComputeGraph (relief-graph.ts; the pooled single-encoder path was removed on
// 2026-10-01): a warm call allocates nothing on the GPU. The normal's gradient is luma's
// GPUFiniteDifference2D on phase planes; the output is tolerance-checked against the CPU twin (a byte
// may differ by 1 on a rounding edge), scripts/gpu/relief-gradient-dawn.ts.
import type { Device } from "@luma.gl/core";
import type { EnuFrame } from "../../geodesy";
import type { Vec3 } from "../../look/atmosphere";
import type { ReliefField } from "../../look/relief/field";
import {
	type Extent,
	type HeightTile,
	rasterizeHeights,
} from "../../look/relief/heights";
import { defineKernel } from "./kernel";
import {
	RELIEF_DOWN,
	RELIEF_PACK,
	RELIEF_PHASE,
	RELIEF_SHADOW,
	RELIEF_SUM,
	RELIEF_SVF,
} from "./relief.wgsl";
import { RELIEF_PARAMS } from "./uniform-blocks";

export const K_RELIEF_SHADOW = defineKernel("relief-shadow", RELIEF_SHADOW, [
	["prm", "uniform"],
	["H", "read-only-storage"],
	["shadow", "storage"],
]);
export const K_RELIEF_DOWN = defineKernel("relief-down", RELIEF_DOWN, [
	["prm", "uniform"],
	["Hf", "read-only-storage"],
	["Hh", "storage"],
]);
export const K_RELIEF_SVF = defineKernel("relief-svf", RELIEF_SVF, [
	["prm", "uniform"],
	["Hh", "read-only-storage"],
	["hull", "storage"],
	["acc8", "storage"],
]);
export const K_RELIEF_SUM = defineKernel("relief-sum", RELIEF_SUM, [
	["prm", "uniform"],
	["acc8", "read-only-storage"],
	["acc", "storage"],
]);
export const K_RELIEF_PHASE = defineKernel("relief-phase", RELIEF_PHASE, [
	["prm", "uniform"],
	["H", "read-only-storage"],
	["phase", "storage"],
]);
export const K_RELIEF_PACK = defineKernel("relief-pack", RELIEF_PACK, [
	["prm", "uniform"],
	["H", "read-only-storage"],
	["shadow", "read-only-storage"],
	["acc", "read-only-storage"],
	["grad", "read-only-storage"],
	["field", "storage"],
	["gen", "storage"],
]);

// mirror of field.ts (keep in sync)
const RES = 1024;
const HALF = 20000;
const AHEAD = 12000;
const SVF_R = 3000;
const HOLE = -1e6;

/**
 * What the relief graph's shape depends on, read from the uniform words reliefWords built: the inner
 * ring radius `ra` (texels; the gradient's phase planes) and the texel size `px` (m; the gradient's
 * spacing is ra · px, baked into the graph).
 */
export function reliefGradientShape(words: ArrayBuffer) {
	// RELIEF_PARAMS: ra is word 12 (i32), pxH = 2 · px is word 11 (f32)
	return {
		ra: new Int32Array(words, 0, 16)[12],
		px: new Float32Array(words, 0, 16)[11] / 2,
	};
}

/** GPU twin of buildReliefField(tiles, frame, sunDir, yawDeg). */
export async function buildReliefFieldGpu(
	device: Device,
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	sunDir: Vec3,
	yawDeg: number | null,
): Promise<ReliefField> {
	const t0 = performance.now();
	const { res, extent, px, H } = reliefHeights(tiles, frame, yawDeg);
	const { field, gen } = await reliefPassesGpu(device, H, res, px, sunDir);
	return { res, extent, field, gen, ms: performance.now() - t0 };
}

/** buildReliefField's extent + rasterised heights (res², row 0 = south) for `yawDeg`. */
export function reliefHeights(
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	yawDeg: number | null,
) {
	const res = RES;
	const a = ((yawDeg ?? 0) * Math.PI) / 180;
	const c =
		yawDeg == null ? [0, 0] : [Math.sin(a) * AHEAD, Math.cos(a) * AHEAD];
	const extent: Extent = [c[0] - HALF, c[1] - HALF, c[0] + HALF, c[1] + HALF];
	const px = (2 * HALF) / res;
	const H = rasterizeHeights(tiles, frame, extent, res, HOLE);
	return { res, extent, px, H };
}

/** field.ts castShadow + skyView + curvatureAndNormal over heights `H` (res², row 0 = south). */
export async function reliefPassesGpu(
	device: Device,
	H: Float32Array,
	res: number,
	px: number,
	sun: Vec3,
): Promise<{ field: Uint8Array; gen: Uint8Array }> {
	const { words, degenerate } = reliefWords(res, px, sun);
	// relief-graph.ts imports this module's kernel specs (hence the dynamic import)
	return (await import("./relief-graph")).reliefGraphPasses(
		device,
		H,
		res,
		words,
		degenerate,
	);
}

/** The relief kernels' uniform block for (res, px, sun): castShadow's and curvatureAndNormal's constants. */
export function reliefWords(
	res: number,
	px: number,
	sun: Vec3,
): { words: ArrayBuffer; degenerate: boolean } {
	if (res > 2048 || res % 2) throw new Error(`relief res ${res} unsupported`);
	const resH = res >> 1;
	// castShadow's constants (f64 here, as the CPU)
	const hz = Math.hypot(sun[0], sun[1]);
	const degenerate = sun[2] <= -0.02 || hz < 1e-4;
	const xMajor = Math.abs(sun[0]) >= Math.abs(sun[1]);
	const major = xMajor ? sun[0] : sun[1];
	const slope = degenerate ? 0 : (xMajor ? sun[1] : sun[0]) / Math.abs(major);
	const tanEl = degenerate ? 0 : sun[2] / hz;
	const drop = px * Math.hypot(1, slope) * tanEl;
	// curvatureAndNormal's constants
	const ra = Math.max(1, Math.round(60 / px));
	const rb = Math.max(3, Math.round(250 / px));
	const da = Math.max(1, Math.round(ra / Math.SQRT2));
	const db = Math.max(1, Math.round(rb / Math.SQRT2));

	const words = RELIEF_PARAMS.pack({
		res,
		resH,
		sa: xMajor ? 1 : res,
		sb: xMajor ? res : 1,
		s: major > 0 ? 1 : -1,
		sFloor: Math.floor(slope), // b0 = b + floor(slope)
		sFrac: slope - Math.floor(slope), // the interpolation weight, constant along a row
		drop,
		w: Math.max(8, 0.6 * drop),
		bias: 0.6 + 0.15 * px,
		shadowConst: degenerate ? (sun[2] <= -0.02 ? 0 : 255) : -1,
		pxH: px * 2,
		ra,
		rb,
		da,
		db,
		ka: (0.55 / (ra * px * 0.35)) * 0.125,
		kb: (0.45 / (rb * px * 0.3)) * 0.125,
		g: 1 / (2 * ra * px),
		svfR: SVF_R,
	});
	return { words, degenerate };
}
