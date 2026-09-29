// Camera-roll spot fusion: merge per-photo ENU clouds and drop splats that another photo already covers
// (multi-resolution voxel hash). Pure TS.
//
// Every splat goes into a cubic cell whose size is about twice its in-plane std-dev, rounded to a power of
// two of `base`: level l = ceil(log2(2·s / base)), cell = base·2^l. Splats are visited from fine to coarse,
// so the closest observation of a surface wins. A kept splat adds coverage to its own cell (1) and to the
// enclosing cells of the next `spread` coarser levels ((c_l / c_m)², a surface patch covers that fraction of
// a coarser cell's face). A splat is dropped when the coverage of its cell from OTHER sources reaches
// `dropAt`. Splats of the same source never suppress each other: a lift already tiles the image without
// overlap, and neighbouring blocks share cells at this cell size.
import { selectSplats } from "../provenance";
import type { GaussianCloud } from "../types";

export type VoxelMergeOpts = {
	/** Finest cell size (m). Default 0.05. */
	base?: number;
	/** Cell size as a multiple of the splat's in-plane std-dev. Default 2. */
	cellPerStd?: number;
	/** Coverage from other sources at which a splat is dropped. Default 0.5. */
	dropAt?: number;
	/** Coarser levels a kept splat also covers. Default 3. */
	spread?: number;
};

export type VoxelMergeStats = {
	input: number;
	kept: number;
	dropped: number;
	/** Kept / input per source index. */
	perSource: { source: number; input: number; kept: number }[];
};

/** In-plane std-dev of splat i: the second-largest scale (a disc's radius, a sphere's radius). */
export function inPlaneStd(scales: ArrayLike<number>, i: number): number {
	const a = scales[3 * i];
	const b = scales[3 * i + 1];
	const c = scales[3 * i + 2];
	const hi = Math.max(a, b, c);
	const lo = Math.min(a, b, c);
	return a + b + c - hi - lo;
}

/**
 * Concatenate ENU clouds (each tagged with its own source index, or `sources[k]`, or k) and drop the
 * splats other sources already cover. Deterministic: ties keep input order.
 */
export function voxelMerge(
	clouds: GaussianCloud[],
	opts: VoxelMergeOpts & { sources?: number[] } = {},
): { cloud: GaussianCloud; stats: VoxelMergeStats } {
	const base = opts.base ?? 0.05;
	const per = opts.cellPerStd ?? 2;
	const dropAt = opts.dropAt ?? 0.5;
	const spread = Math.max(0, Math.round(opts.spread ?? 3));
	for (const c of clouds)
		if (c.frame !== "enu" && c.count > 0)
			throw new Error("voxelMerge: expects ENU clouds");
	const all = concatClouds(clouds, opts.sources);
	const n = all.count;
	const src = all.source ?? new Uint16Array(n);
	let nSrc = 0;
	for (let i = 0; i < n; i++) if (src[i] >= nSrc) nSrc = src[i] + 1;
	// visit order: fine → coarse
	const std = new Float64Array(n);
	for (let i = 0; i < n; i++) std[i] = inPlaneStd(all.scales, i);
	const order = Array.from({ length: n }, (_, i) => i).sort(
		(a, b) => std[a] - std[b] || a - b,
	);
	/** coverage per (level, cell, source) */
	const cov = new Map<string, number>();
	const P = all.positions;
	const key = (l: number, i: number, s: number) => {
		const c = base * 2 ** l;
		return `${l},${Math.floor(P[3 * i] / c)},${Math.floor(P[3 * i + 1] / c)},${Math.floor(P[3 * i + 2] / c)},${s}`;
	};
	const keep: number[] = [];
	const perSource = Array.from({ length: nSrc }, (_, s) => ({
		source: s,
		input: 0,
		kept: 0,
	}));
	for (const i of order) {
		const s = src[i];
		perSource[s].input++;
		const l = Math.max(
			0,
			Math.ceil(Math.log2(Math.max(1e-6, per * std[i]) / base)),
		);
		let c = 0;
		if (nSrc > 1)
			for (let o = 0; o < nSrc && c < dropAt; o++)
				if (o !== s) c += cov.get(key(l, i, o)) ?? 0;
		if (c >= dropAt) continue;
		keep.push(i);
		perSource[s].kept++;
		if (nSrc > 1)
			for (let m = l; m <= l + spread; m++) {
				const k = key(m, i, s);
				cov.set(k, (cov.get(k) ?? 0) + 4 ** (l - m));
			}
	}
	keep.sort((a, b) => a - b);
	return {
		cloud: selectSplats(all, keep),
		stats: { input: n, kept: keep.length, dropped: n - keep.length, perSource },
	};
}

/** Concatenate clouds of one frame; `source` = sources[k] (default: the cloud's own source, else k). */
export function concatClouds(
	clouds: GaussianCloud[],
	sources?: number[],
): GaussianCloud {
	const n = clouds.reduce((a, c) => a + c.count, 0);
	const frame = clouds.find((c) => c.count > 0)?.frame ?? "enu";
	const out: GaussianCloud = {
		count: n,
		frame,
		positions: new Float32Array(3 * n),
		scales: new Float32Array(3 * n),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n),
		provenance: new Uint8Array(n),
		source: new Uint16Array(n),
	};
	let o = 0;
	clouds.forEach((c, k) => {
		out.positions.set(c.positions.subarray(0, 3 * c.count), 3 * o);
		out.scales.set(c.scales.subarray(0, 3 * c.count), 3 * o);
		out.rotations.set(c.rotations.subarray(0, 4 * c.count), 4 * o);
		out.colors.set(c.colors.subarray(0, 4 * c.count), 4 * o);
		out.provenance.set(c.provenance.subarray(0, c.count), o);
		const src = out.source as Uint16Array;
		if (sources) src.fill(sources[k], o, o + c.count);
		else if (c.source) src.set(c.source.subarray(0, c.count), o);
		else src.fill(k, o, o + c.count);
		o += c.count;
	});
	return out;
}
