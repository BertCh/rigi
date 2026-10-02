// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { wrap360 } from "#/lib/geodesy";
// Spatially correlated DEM error for far evidence (GA1; the "all-far ⇒ eye unobserved" criterion).
//
// A DEM error that is common to a patch of terrain (a ridge, a tile, the smoothing of a coarse zoom
// level) moves every point of that patch by the same world offset b — and a world offset b is exactly an
// eye offset −b for those rows. Treating the DEM error as independent per row lets 200 far skyline
// samples "observe" the eye to a few metres; the E0/E3 audits say they cannot. So each factor splits its
// DEM σ(d) into an independent part √(1−ρ)·σ(d) (in the row σ) and a cluster part √ρ·σ(d): a 3D offset
// b_c ~ N(0, ρσ(d_c)²·I) shared by the rows of cluster c (azimuth sector × distance band), marginalised
// analytically. With G_c the rows' (row-σ whitened) eye Jacobian, the rows' covariance is
// I + σc²·G_c G_cᵀ and the factor returns Σ^{-1/2}·r:
//   G = U S Vᵀ (thin SVD via the 3×3 eigen of GᵀG),  Σ^{-1/2} r = r + U·diag(1/√(1 + σc² s²) − 1)·Uᵀ r.
// G is taken at the factor's linearisation point and held fixed (a constant linear map per solve).
import { distanceBand } from "../../concord/core";
import { jacobiEigen } from "../../linalg";

export type ClusterOpts = {
	/** Share of the DEM variance that is common to a cluster (0 = independent rows). Default 0.5. */
	rho?: number;
	/** Azimuth sector width (deg). Default 15. */
	sectorDeg?: number;
};
export const CLUSTER_DEFAULTS = { rho: 0.5, sectorDeg: 15 };

/** Cluster key of a row seen at azimuth az (deg) and distance d (m). */
export const clusterKey = (az: number, d: number, sectorDeg: number) =>
	`${Math.floor(wrap360(az) / sectorDeg)}|${distanceBand(d)}`;

export type ClusterWhitener = {
	/**
	 * In place: r ← Σ^{-1/2} r over each cluster's rows (NaN rows are skipped and stay NaN). With `keep`,
	 * rows with keep(i) = false are set to NaN first and Σ is the covariance of the kept rows only (the
	 * whitener is rebuilt over them), so a masked row cannot leak into the kept ones (CR-17).
	 */
	apply(r: Float64Array, keep?: (row: number) => boolean): Float64Array;
	/** Number of clusters with a non-trivial correction. */
	n: number;
};

type WhitenBlock = { rows: number[]; U: Float64Array; k: number[] };

function whitenBlocks(
	G: Float64Array,
	clusters: { rows: number[]; sigmaM: number }[],
): WhitenBlock[] {
	const blks: WhitenBlock[] = [];
	for (const c of clusters) {
		if (!(c.sigmaM > 0) || !c.rows.length) continue;
		const m = c.rows.length;
		const M = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		];
		for (const i of c.rows)
			for (let a = 0; a < 3; a++)
				for (let b = 0; b < 3; b++) M[a][b] += G[i * 3 + a] * G[i * 3 + b];
		const { values, vectors } = jacobiEigen(M);
		const vmax = Math.max(...values, 0);
		const cols: number[] = [];
		for (let k = 0; k < 3; k++)
			if (values[k] > 1e-12 * vmax && values[k] > 0) cols.push(k);
		if (!cols.length) continue;
		const U = new Float64Array(m * cols.length);
		const kk: number[] = [];
		cols.forEach((k, j) => {
			const s = Math.sqrt(values[k]);
			kk.push(1 / Math.sqrt(1 + c.sigmaM * c.sigmaM * values[k]) - 1);
			c.rows.forEach((i, r) => {
				let v = 0;
				for (let a = 0; a < 3; a++) v += G[i * 3 + a] * vectors[a][k];
				U[r * cols.length + j] = v / s;
			});
		});
		blks.push({ rows: c.rows, U, k: kk });
	}
	return blks;
}

function applyBlocks(blks: WhitenBlock[], r: Float64Array): Float64Array {
	for (const b of blks) {
		const nc = b.k.length;
		const c = new Float64Array(nc);
		b.rows.forEach((i, ri) => {
			const v = r[i];
			if (!Number.isFinite(v)) return;
			for (let j = 0; j < nc; j++) c[j] += b.U[ri * nc + j] * v;
		});
		for (let j = 0; j < nc; j++) c[j] *= b.k[j];
		b.rows.forEach((i, ri) => {
			if (!Number.isFinite(r[i])) return;
			let s = 0;
			for (let j = 0; j < nc; j++) s += b.U[ri * nc + j] * c[j];
			r[i] += s;
		});
	}
	return r;
}

/**
 * @param G     n×3 row-major eye Jacobian of the (row-σ whitened) residual rows
 * @param rows  cluster rows: row indices and the cluster's offset σ (m)
 */
export function clusterWhitener(
	G: Float64Array,
	clusters: { rows: number[]; sigmaM: number }[],
): ClusterWhitener {
	const blks = whitenBlocks(G, clusters);
	// per-mask whiteners, keyed by the keep function (maskFactor passes one stable function per subset)
	const masked = new WeakMap<(row: number) => boolean, WhitenBlock[]>();
	return {
		n: blks.length,
		apply(r, keep) {
			if (!keep) return applyBlocks(blks, r);
			for (let i = 0; i < r.length; i++) if (!keep(i)) r[i] = Number.NaN;
			let mb = masked.get(keep);
			if (!mb) {
				mb = whitenBlocks(
					G,
					clusters.map((c) => ({
						rows: c.rows.filter((i) => keep(i)),
						sigmaM: c.sigmaM,
					})),
				);
				masked.set(keep, mb);
			}
			return applyBlocks(mb, r);
		},
	};
}
