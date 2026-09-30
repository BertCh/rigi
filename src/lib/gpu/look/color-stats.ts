// GPU twin of look/color-stats.ts `reduceBands(...bandInputs(...))`: Oklab, masks and the per-band
// Σ / Σ² reduction on the GPU (color-stats.wgsl.ts); only 52 floats per workgroup come back.
// Buffers are pooled (lease "look-stats"). Opt-in ({subgroups: true}, on a device with subgroups):
// the per-workgroup reduction by subgroupAdd (BAND_STATS_SG), equal to the shared-memory tree up to
// float-sum reassociation (look-bench reports the difference). Off by default: it measured no
// faster at 1 ms and isn't bit-identical.
import type { Device } from "@luma.gl/core";
import {
	type ColorStats,
	identityStats,
	N_BANDS,
} from "../../look/color-stats";
import { hasFeature } from "../device";
import { BAND_STATS, BAND_STATS_SG, STATS_VALUES } from "./color-stats.wgsl";
import {
	defineKernel,
	dispatch,
	kernel,
	pooledStorage,
	pooledUniform,
	stageReads,
	submit,
	withLease,
} from "./kernel";

const LAYOUT: Parameters<typeof defineKernel>[2] = [
	["prm", "uniform"],
	["photo", "read-only-storage"],
	["layer", "read-only-storage"],
	["range", "read-only-storage"],
	["fg", "read-only-storage"],
	["lut", "read-only-storage"],
	["partial", "storage"],
];
const K_BAND_STATS = defineKernel("band-stats", BAND_STATS, LAYOUT);
/** Warm-up group of the kernels that need the "subgroups" feature (warmLook checks it). */
export const LOOK_SUBGROUP_GROUP = "look-subgroups";
const K_BAND_STATS_SG = defineKernel("band-stats-sg", BAND_STATS_SG, LAYOUT, {
	group: LOOK_SUBGROUP_GROUP,
});

export type BandStatsOptions = {
	/** Use the subgroup reduction when the device has subgroups (default false). */
	subgroups?: boolean;
};

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

const SRGB_LUT = Float32Array.from({ length: 256 }, (_, i) => {
	const c = i / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const GROUPS = 32;
const WG = 64;

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
	const words = new ArrayBuffer(20);
	new Uint32Array(words, 0, 4).set([w, h, GROUPS * WG, o.fg ? 1 : 0]);
	new Float32Array(words, 16, 1)[0] = o.minRange ?? 0;
	const sg = (opts.subgroups ?? false) && hasFeature(device, "subgroups");
	let p = await bandPartials(device, o, words, R, sg);
	// BAND_STATS_SG writes -1 partials (a negative count) when the subgroup layout isn't what it assumes
	if (sg && hasNegativeCount(p))
		p = await bandPartials(device, o, words, R, false);
	// per band: count, Σp(3), Σp²(3), Σl(3), Σl²(3) → reduceBands' acc layout (Σp, Σp², Σl, Σl²)
	const acc = new Float64Array(N_BANDS * 12);
	const cnt = new Uint32Array(N_BANDS);
	for (let g = 0; g < GROUPS; g++)
		for (let b = 0; b < N_BANDS; b++) {
			const s = g * STATS_VALUES + b * 13;
			cnt[b] += Math.round(p[s]);
			for (let v = 0; v < 12; v++) acc[b * 12 + v] += p[s + 1 + v];
		}
	return finalizeBands(acc, cnt, o.minCount ?? 60);
}

const hasNegativeCount = (p: Float32Array) => {
	for (let g = 0; g < GROUPS; g++)
		for (let b = 0; b < N_BANDS; b++)
			if (p[g * STATS_VALUES + b * 13] < 0) return true;
	return false;
};

/** One BAND_STATS(_SG) dispatch: the GROUPS × STATS_VALUES per-workgroup partials. */
function bandPartials(
	device: Device,
	o: BandStatsInput,
	words: ArrayBuffer,
	R: Float32Array,
	sg: boolean,
): Promise<Float32Array> {
	const k = kernel(device, sg ? K_BAND_STATS_SG : K_BAND_STATS);
	return withLease("look-stats", async () => {
		const up = (key: string, data: ArrayBufferView | number) =>
			pooledStorage(device, `look-stats/${key}`, data);
		const prm = pooledUniform(device, "look-stats/prm", words);
		const photo = up("photo", o.photo);
		const layer = up("layer", o.layer);
		const range = up("range", R);
		const fg = up("fg", o.fg ?? 4);
		const lut = up("lut", SRGB_LUT);
		// every workgroup writes its 52 partials
		const partial = pooledStorage(
			device,
			"look-stats/partial",
			GROUPS * STATS_VALUES * 4,
			{ zero: false },
		);
		const enc = device.createCommandEncoder({ id: "look-band-stats" });
		dispatch(enc, k, { prm, photo, layer, range, fg, lut, partial }, GROUPS);
		const rd = stageReads(device, enc, [
			{ buffer: partial, size: GROUPS * STATS_VALUES * 4 },
		]);
		submit(device, enc);
		return new Float32Array((await rd.read())[0]);
	});
}

/** reduceBands' tail (color-stats.ts; keep in sync): means, floored stds, empty-band back-fill. */
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
