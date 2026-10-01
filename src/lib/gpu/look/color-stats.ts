// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU twin of look/color-stats.ts `reduceBands(...bandInputs(...))`: Oklab, masks and the per-band
// Σ / Σ² reduction on the GPU (color-stats.wgsl.ts), as core ComputeGraphs (color-stats-graph.ts).
// Default (?statsFold=gpu, since 2026-10-01): the per-workgroup partials are folded and finalized on the
// GPU too (color-stats-fold.ts: luma GPUProgramSpMV + BAND_FINALIZE, f32) and only the ColorStats
// (256 B) comes back. ?statsFold=f64: the 52 floats per workgroup come back and are folded here in
// float64, then finalizeBands.
// Subgroups (default on where the device has them, ?statsSubgroups=off): the per-workgroup reduction by
// subgroupAdd (BAND_STATS_SG), equal to the shared-memory tree up to float-sum reassociation, with a
// layout check whose failure re-runs the plain kernel.
import type { Device } from "@luma.gl/core";
import { getFlag } from "#/lib/flags";
import {
	type ColorStats,
	identityStats,
	N_BANDS,
} from "../../look/color-stats";
import { hasFeature } from "../device";
import { BAND_STATS, BAND_STATS_SG, STATS_VALUES } from "./color-stats.wgsl";
import {
	markFoldFailed,
	statsFoldOn,
	statsFromWords,
	subgroupLayoutFailed,
} from "./color-stats-fold";
import { defineKernel } from "./kernel";

const LAYOUT: Parameters<typeof defineKernel>[2] = [
	["prm", "uniform"],
	["photo", "read-only-storage"],
	["layer", "read-only-storage"],
	["range", "read-only-storage"],
	["fg", "read-only-storage"],
	["lut", "read-only-storage"],
	["partial", "storage"],
];
export const K_BAND_STATS = defineKernel("band-stats", BAND_STATS, LAYOUT);
/** Warm-up group of the kernels that need the "subgroups" feature (warmLook checks it). */
export const LOOK_SUBGROUP_GROUP = "look-subgroups";
export const K_BAND_STATS_SG = defineKernel(
	"band-stats-sg",
	BAND_STATS_SG,
	LAYOUT,
	{
		group: LOOK_SUBGROUP_GROUP,
	},
);

export type BandStatsOptions = {
	/** Use the subgroup reduction when the device has subgroups (default: ?statsSubgroups, on). */
	subgroups?: boolean;
	/** Where the partials are folded (default: ?statsFold, gpu). */
	fold?: "gpu" | "f64";
};

/** The subgroup reduction applies (the option, else the flag; and the device has subgroups). */
export const statsSubgroupsOn = (device: Device, opt?: boolean) =>
	(opt ?? getFlag("statsSubgroups") === "on") &&
	hasFeature(device, "subgroups");

/** BAND_STATS' parameter words (+ minCount for BAND_FINALIZE): 24 bytes. */
export function statsParamWords(
	w: number,
	h: number,
	hasFg: boolean,
	minRange: number,
	minCount: number,
): ArrayBuffer {
	const words = new ArrayBuffer(24);
	new Uint32Array(words, 0, 4).set([w, h, GROUPS * WG, hasFg ? 1 : 0]);
	new Float32Array(words, 16, 1)[0] = minRange;
	new Uint32Array(words, 20, 1)[0] = minCount;
	return words;
}

export type BandStatsInput = {
	/** sRGB RGBA bytes, w × h, row 0 = top. */
	photo: Uint8ClampedArray | Uint8Array;
	/** linear RGBA floats (alpha = coverage), row 0 = top. */
	layer: Float32Array;
	w: number;
	h: number;
	/** metres, row 0 = top; ≤ 0 or non-finite = sky. */
	range: Float32Array;
	/** people 0..1, row 0 = top. */
	fg?: Float32Array | null;
	/** nearer terrain doesn't count (bandInputs' minRange). */
	minRange?: number;
	/** reduceBands' minCount. */
	minCount?: number;
};

export const SRGB_LUT = Float32Array.from({ length: 256 }, (_, i) => {
	const c = i / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export const GROUPS = 32;
export const WG = 64;

/** reduceBands(bandInputs(photo, layer, w, h, range, fg, minRange), w·h, minCount) on the GPU. */
export async function bandStatsGpu(
	device: Device,
	o: BandStatsInput,
	opts: BandStatsOptions = {},
): Promise<ColorStats> {
	const { w, h } = o;
	const n = w * h;
	// bandInputs' range sanitising (≤ 0 or non-finite = sky = 0)
	const R = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const r = o.range[i];
		R[i] = r > 0 && Number.isFinite(r) ? r : 0;
	}
	const minCount = o.minCount ?? 60;
	const words = statsParamWords(w, h, !!o.fg, o.minRange ?? 0, minCount);
	const sg = statsSubgroupsOn(device, opts.subgroups);
	// color-stats-graph.ts imports this module's specs and constants (hence the dynamic import)
	const graphs = await import("./color-stats-graph");
	if (statsFoldOn(device, opts.fold))
		try {
			let d = await graphs.bandFoldedGraph(device, o, words, R, sg);
			// BAND_STATS_SG's layout check failed (valid = -1): the plain reduction
			if (sg && subgroupLayoutFailed(d))
				d = await graphs.bandFoldedGraph(device, o, words, R, false);
			return statsFromWords(d);
		} catch (e) {
			// a lost device is not a fold fault (the f64 run below rejects too)
			if (device.isLost) throw e;
			// the fold graph faulted: the f64 fold below (and from now on, on this device)
			markFoldFailed(device, e);
		}
	const partials = graphs.bandPartialsGraph;
	let p = await partials(device, o, words, R, sg);
	// BAND_STATS_SG writes -1e20 partials (a negative count) when the subgroup layout isn't what it assumes
	if (sg && hasNegativeCount(p)) p = await partials(device, o, words, R, false);
	// per band: count, Σp(3), Σp²(3), Σl(3), Σl²(3) → reduceBands' acc layout (Σp, Σp², Σl, Σl²)
	const acc = new Float64Array(N_BANDS * 12);
	const cnt = new Uint32Array(N_BANDS);
	for (let g = 0; g < GROUPS; g++)
		for (let b = 0; b < N_BANDS; b++) {
			const s = g * STATS_VALUES + b * 13;
			cnt[b] += Math.round(p[s]);
			for (let v = 0; v < 12; v++) acc[b * 12 + v] += p[s + 1 + v];
		}
	return finalizeBands(acc, cnt, minCount);
}

const hasNegativeCount = (p: Float32Array) => {
	for (let g = 0; g < GROUPS; g++)
		for (let b = 0; b < N_BANDS; b++)
			if (p[g * STATS_VALUES + b * 13] < 0) return true;
	return false;
};

/** reduceBands' tail (color-stats.ts and color-stats-fold.wgsl.ts BAND_FINALIZE; keep in sync): means, floored stds, empty-band back-fill. */
export function finalizeBands(
	acc: Float64Array,
	cnt: Uint32Array,
	minCount: number,
): ColorStats {
	const s = identityStats();
	s.count = cnt;
	const ok = Array.from(cnt, (c) => c >= minCount);
	s.valid = ok.some(Boolean);
	if (!s.valid) return s;
	for (let k = 0; k < N_BANDS; k++) {
		let src = k;
		if (!ok[k]) {
			for (let dk = 1; dk < N_BANDS; dk++) {
				if (k - dk >= 0 && ok[k - dk]) {
					src = k - dk;
					break;
				}
				if (k + dk < N_BANDS && ok[k + dk]) {
					src = k + dk;
					break;
				}
			}
		}
		const o = src * 12;
		const N = cnt[src];
		for (let c = 0; c < 3; c++) {
			const pm = acc[o + c] / N;
			const lm = acc[o + 6 + c] / N;
			s.photoMean[k * 3 + c] = pm;
			s.layerMean[k * 3 + c] = lm;
			const floor = c === 0 ? 0.01 : 0.004;
			s.photoStd[k * 3 + c] = Math.max(
				floor,
				Math.sqrt(Math.max(0, acc[o + 3 + c] / N - pm * pm)),
			);
			s.layerStd[k * 3 + c] = Math.max(
				floor,
				Math.sqrt(Math.max(0, acc[o + 9 + c] / N - lm * lm)),
			);
		}
	}
	return s;
}
