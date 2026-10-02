// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A level-of-detail tree over a flat Step Inside GaussianCloud, laid out the way luma.gl's
// SplatRADHierarchyManager (@luma.gl/splats, luma PR #3340, vendored rigi.6) walks a Spark RAD
// source: one row per node in breadth-first order, root at row 0, the children of every row
// contiguous (`childStarts` / `childCounts`), the original splats as the leaf rows.
//
// Step Inside clouds are single-shot lifts with no authored hierarchy (reports/negative-results.md
// LF6). This builds one so the progressive selection has something to select from: a kd split
// (median along the longest axis, three levels per node, so up to BRANCHING = 8 children) down to
// the splats, and every interior row is the moment-matched merge of its children:
//   weight   w = α · (sx·sy + sy·sz + sz·sx)   (opacity times a surface-area proxy)
//   mean     μ = Σ w μᵢ / Σ w
//   cov      Σ = Σ w (Σᵢ + (μᵢ − μ)(μᵢ − μ)ᵀ) / Σ w, then eigen-decomposed into scales + rotation
//   opacity  α = Σ w αᵢ / Σ w
//   colour   weighted mean in linear light, stored as sRGB bytes like the leaves
//   provenance the code of the heaviest child (the Truth tint of a coarse row)
// Leaves keep their own values bit for bit (positions, scales, rotations, colour bytes, α = byte/255).
// The selection then refines a row while its projected geometric error (luma's default: twice the
// mean scale) exceeds the screen-space limit and draws coarse rows only for small or far parts.
//
// Pure CPU, no luma import (node specs). Rows are cut into `pageSize` pages (luma's nominal RAD
// page, 65 536 rows): layers/splats-luma.ts uploads one GPUSplatData per page.

import type { GaussianCloud } from "./types";

/** Children per interior row (three binary kd splits). */
export const SPLAT_LOD_BRANCHING = 8;
/** luma's default nominal RAD page size (rows). */
export const SPLAT_LOD_PAGE_SIZE = 65_536;

export type SplatLodPage = { rowStart: number; rowCount: number };

export type SplatLod = {
	/** Rows: interior + leaf. */
	rowCount: number;
	/** Leaf rows = the cloud's splats. */
	leafCount: number;
	/** World (ENU) centres, 3 per row. */
	positions: Float32Array;
	/** Linear one-sigma scales, 3 per row. */
	scales: Float32Array;
	/** Unit quaternions (w, x, y, z), 4 per row. */
	rotations: Float32Array;
	/** sRGB RGBA bytes, 4 per row (alpha byte = opacity · 255, informational: luma reads `opacities`). */
	colors: Uint8Array;
	/** Linear opacity 0..1 per row. */
	opacities: Float32Array;
	/** PROVENANCE_CODE per row. */
	provenance: Uint8Array;
	/** Original splat index of a leaf row, −1 for interior rows. */
	leafIndex: Int32Array;
	/** Children per row (0 for leaves). */
	childCounts: Uint16Array;
	/** Global row of the first child (0 for leaves). */
	childStarts: Uint32Array;
	/** Tree depth (rows on the longest root-to-leaf path). */
	depth: number;
	pages: SplatLodPage[];
};

export type SplatLodOptions = {
	/** Rows per page (default SPLAT_LOD_PAGE_SIZE). */
	pageSize?: number;
};

/** One node of the build tree: an interior node over children, or a leaf (splat index). */
type BuildNode = { leaf: number; children: BuildNode[] | null };

// sRGB byte <-> linear float tables
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
	const c = i / 255;
	SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgbByte(v: number): number {
	const c = Math.min(1, Math.max(0, v));
	const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
	return Math.round(s * 255);
}

/**
 * Build the LoD tree. A cloud of one splat is a single leaf row; up to BRANCHING splats get one
 * root over them.
 */
export function buildSplatLod(
	cloud: GaussianCloud,
	options: SplatLodOptions = {},
): SplatLod {
	const n = cloud.count;
	const pageSize = options.pageSize ?? SPLAT_LOD_PAGE_SIZE;
	const P = cloud.positions;
	const order = new Uint32Array(n);
	for (let i = 0; i < n; i++) order[i] = i;
	const keys = new Float32Array(n);

	/** kd-split order[lo, hi) into `parts` groups (a power of two) by median cuts. */
	const split = (lo: number, hi: number, parts: number, out: number[]) => {
		if (parts <= 1 || hi - lo <= 1) {
			out.push(lo, hi);
			return;
		}
		let minX = Infinity;
		let minY = Infinity;
		let minZ = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		let maxZ = -Infinity;
		for (let k = lo; k < hi; k++) {
			const i = order[k] * 3;
			const x = P[i];
			const y = P[i + 1];
			const z = P[i + 2];
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
			if (z < minZ) minZ = z;
			if (z > maxZ) maxZ = z;
		}
		const ex = maxX - minX;
		const ey = maxY - minY;
		const ez = maxZ - minZ;
		const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
		for (let k = lo; k < hi; k++) keys[k] = P[order[k] * 3 + axis];
		const mid = (lo + hi) >>> 1;
		quickselect(order, keys, lo, hi - 1, mid);
		split(lo, mid, parts >> 1, out);
		split(mid, hi, parts >> 1, out);
	};

	/** Build the subtree over order[lo, hi). */
	const build = (lo: number, hi: number): BuildNode => {
		const size = hi - lo;
		if (size === 1) return { leaf: order[lo], children: null };
		if (size <= SPLAT_LOD_BRANCHING) {
			const children: BuildNode[] = [];
			for (let k = lo; k < hi; k++)
				children.push({ leaf: order[k], children: null });
			return { leaf: -1, children };
		}
		const ranges: number[] = [];
		split(lo, hi, SPLAT_LOD_BRANCHING, ranges);
		const children: BuildNode[] = [];
		for (let r = 0; r < ranges.length; r += 2)
			if (ranges[r + 1] > ranges[r])
				children.push(build(ranges[r], ranges[r + 1]));
		return { leaf: -1, children };
	};

	const root: BuildNode = n === 0 ? { leaf: -1, children: [] } : build(0, n);

	// breadth-first rows: the children of each row are contiguous and come after it
	const rows: BuildNode[] = [root];
	const levelOf: number[] = [1];
	const childStartOf: number[] = [];
	let depth = 1;
	for (let r = 0; r < rows.length; r++) {
		const node = rows[r];
		if (!node.children?.length) continue;
		childStartOf[r] = rows.length;
		for (const c of node.children) {
			rows.push(c);
			levelOf.push(levelOf[r] + 1);
			if (levelOf[r] + 1 > depth) depth = levelOf[r] + 1;
		}
	}
	const rowCount = n === 0 ? 0 : rows.length;

	const positions = new Float32Array(rowCount * 3);
	const scales = new Float32Array(rowCount * 3);
	const rotations = new Float32Array(rowCount * 4);
	const colors = new Uint8Array(rowCount * 4);
	const opacities = new Float32Array(rowCount);
	const provenance = new Uint8Array(rowCount);
	const leafIndex = new Int32Array(rowCount).fill(-1);
	const childCounts = new Uint16Array(rowCount);
	const childStarts = new Uint32Array(rowCount);

	// per-row moments for the merge: weight, mean (3), covariance (6: xx xy xz yy yz zz), linear rgb, α
	const W = new Float64Array(rowCount);
	const M = new Float64Array(rowCount * 3);
	const C = new Float64Array(rowCount * 6);
	const L = new Float64Array(rowCount * 3);
	const A = new Float64Array(rowCount);
	const S = cloud.scales;
	const Q = cloud.rotations;
	const col = cloud.colors;
	const prov = cloud.provenance;

	// leaves
	for (let r = 0; r < rowCount; r++) {
		const node = rows[r];
		if (node.children) continue;
		const i = node.leaf;
		leafIndex[r] = i;
		positions.set(P.subarray(3 * i, 3 * i + 3), 3 * r);
		scales.set(S.subarray(3 * i, 3 * i + 3), 3 * r);
		rotations.set(Q.subarray(4 * i, 4 * i + 4), 4 * r);
		colors.set(col.subarray(4 * i, 4 * i + 4), 4 * r);
		const alpha = col[4 * i + 3] / 255;
		opacities[r] = alpha;
		provenance[r] = prov[i] ?? 0;
		const sx = S[3 * i];
		const sy = S[3 * i + 1];
		const sz = S[3 * i + 2];
		W[r] = Math.max(alpha * (sx * sy + sy * sz + sz * sx), 1e-30);
		M[3 * r] = P[3 * i];
		M[3 * r + 1] = P[3 * i + 1];
		M[3 * r + 2] = P[3 * i + 2];
		covarianceOf(Q, 4 * i, sx, sy, sz, C, 6 * r);
		L[3 * r] = SRGB_TO_LINEAR[col[4 * i]];
		L[3 * r + 1] = SRGB_TO_LINEAR[col[4 * i + 1]];
		L[3 * r + 2] = SRGB_TO_LINEAR[col[4 * i + 2]];
		A[r] = alpha;
	}

	// interior rows, deepest first (BFS order reversed: children always have larger rows)
	const eig = new Float64Array(12);
	for (let r = rowCount - 1; r >= 0; r--) {
		const node = rows[r];
		if (!node.children) continue;
		const first = childStartOf[r];
		const count = node.children.length;
		childStarts[r] = first;
		childCounts[r] = count;
		let w = 0;
		let mx = 0;
		let my = 0;
		let mz = 0;
		let lr = 0;
		let lg = 0;
		let lb = 0;
		let a = 0;
		let heaviest = first;
		for (let c = first; c < first + count; c++) {
			const wc = W[c];
			w += wc;
			mx += wc * M[3 * c];
			my += wc * M[3 * c + 1];
			mz += wc * M[3 * c + 2];
			lr += wc * L[3 * c];
			lg += wc * L[3 * c + 1];
			lb += wc * L[3 * c + 2];
			a += wc * A[c];
			if (wc > W[heaviest]) heaviest = c;
		}
		mx /= w;
		my /= w;
		mz /= w;
		let cxx = 0;
		let cxy = 0;
		let cxz = 0;
		let cyy = 0;
		let cyz = 0;
		let czz = 0;
		for (let c = first; c < first + count; c++) {
			const wc = W[c];
			const dx = M[3 * c] - mx;
			const dy = M[3 * c + 1] - my;
			const dz = M[3 * c + 2] - mz;
			const o = 6 * c;
			cxx += wc * (C[o] + dx * dx);
			cxy += wc * (C[o + 1] + dx * dy);
			cxz += wc * (C[o + 2] + dx * dz);
			cyy += wc * (C[o + 3] + dy * dy);
			cyz += wc * (C[o + 4] + dy * dz);
			czz += wc * (C[o + 5] + dz * dz);
		}
		W[r] = w;
		M[3 * r] = mx;
		M[3 * r + 1] = my;
		M[3 * r + 2] = mz;
		const o = 6 * r;
		C[o] = cxx / w;
		C[o + 1] = cxy / w;
		C[o + 2] = cxz / w;
		C[o + 3] = cyy / w;
		C[o + 4] = cyz / w;
		C[o + 5] = czz / w;
		L[3 * r] = lr / w;
		L[3 * r + 1] = lg / w;
		L[3 * r + 2] = lb / w;
		A[r] = a / w;

		positions[3 * r] = mx;
		positions[3 * r + 1] = my;
		positions[3 * r + 2] = mz;
		symmetricEigen3(C, o, eig);
		// eig: values [0..2], column-major eigenvectors [3..11]
		for (let k = 0; k < 3; k++)
			scales[3 * r + k] = Math.sqrt(Math.max(eig[k], 1e-12));
		quaternionFromColumns(eig, 3, rotations, 4 * r);
		colors[4 * r] = linearToSrgbByte(L[3 * r]);
		colors[4 * r + 1] = linearToSrgbByte(L[3 * r + 1]);
		colors[4 * r + 2] = linearToSrgbByte(L[3 * r + 2]);
		colors[4 * r + 3] = Math.round(Math.min(1, A[r]) * 255);
		opacities[r] = Math.min(1, A[r]);
		provenance[r] = provenance[heaviest];
	}

	const pages: SplatLodPage[] = [];
	for (let start = 0; start < rowCount; start += pageSize)
		pages.push({
			rowStart: start,
			rowCount: Math.min(pageSize, rowCount - start),
		});

	return {
		rowCount,
		leafCount: n,
		positions,
		scales,
		rotations,
		colors,
		opacities,
		provenance,
		leafIndex,
		childCounts,
		childStarts,
		depth: n === 0 ? 0 : depth,
		pages,
	};
}

/** Σ = R diag(s²) Rᵀ of the quaternion at Q[q] (w, x, y, z; normalised here) into out[o..o+5]. */
function covarianceOf(
	Q: Float32Array,
	q: number,
	sx: number,
	sy: number,
	sz: number,
	out: Float64Array,
	o: number,
) {
	let w = Q[q];
	let x = Q[q + 1];
	let y = Q[q + 2];
	let z = Q[q + 3];
	const qn = Math.hypot(w, x, y, z) || 1;
	w /= qn;
	x /= qn;
	y /= qn;
	z /= qn;
	const r00 = 1 - 2 * (y * y + z * z);
	const r01 = 2 * (x * y - w * z);
	const r02 = 2 * (x * z + w * y);
	const r10 = 2 * (x * y + w * z);
	const r11 = 1 - 2 * (x * x + z * z);
	const r12 = 2 * (y * z - w * x);
	const r20 = 2 * (x * z - w * y);
	const r21 = 2 * (y * z + w * x);
	const r22 = 1 - 2 * (x * x + y * y);
	const m00 = r00 * sx;
	const m01 = r01 * sy;
	const m02 = r02 * sz;
	const m10 = r10 * sx;
	const m11 = r11 * sy;
	const m12 = r12 * sz;
	const m20 = r20 * sx;
	const m21 = r21 * sy;
	const m22 = r22 * sz;
	out[o] = m00 * m00 + m01 * m01 + m02 * m02;
	out[o + 1] = m00 * m10 + m01 * m11 + m02 * m12;
	out[o + 2] = m00 * m20 + m01 * m21 + m02 * m22;
	out[o + 3] = m10 * m10 + m11 * m11 + m12 * m12;
	out[o + 4] = m10 * m20 + m11 * m21 + m12 * m22;
	out[o + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}

/**
 * Cyclic Jacobi eigen-decomposition of the symmetric 3×3 at c[o..o+5] (xx xy xz yy yz zz).
 * out[0..2] = eigenvalues, out[3..11] = the eigenvectors as columns (column-major), a proper
 * rotation (determinant +1).
 */
export function symmetricEigen3(
	c: ArrayLike<number>,
	o: number,
	out: Float64Array,
) {
	const a = [
		[c[o], c[o + 1], c[o + 2]],
		[c[o + 1], c[o + 3], c[o + 4]],
		[c[o + 2], c[o + 4], c[o + 5]],
	];
	const v = [
		[1, 0, 0],
		[0, 1, 0],
		[0, 0, 1],
	];
	for (let sweep = 0; sweep < 32; sweep++) {
		const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
		const scale = a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + off;
		if (off <= 1e-30 * Math.max(scale, 1e-300)) break;
		for (let p = 0; p < 2; p++)
			for (let q = p + 1; q < 3; q++) {
				const apq = a[p][q];
				if (Math.abs(apq) < 1e-300) continue;
				const theta = (a[q][q] - a[p][p]) / (2 * apq);
				const t =
					Math.sign(theta || 1) /
					(Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const cs = 1 / Math.sqrt(t * t + 1);
				const sn = t * cs;
				for (let k = 0; k < 3; k++) {
					const akp = a[k][p];
					const akq = a[k][q];
					a[k][p] = cs * akp - sn * akq;
					a[k][q] = sn * akp + cs * akq;
				}
				for (let k = 0; k < 3; k++) {
					const apk = a[p][k];
					const aqk = a[q][k];
					a[p][k] = cs * apk - sn * aqk;
					a[q][k] = sn * apk + cs * aqk;
				}
				for (let k = 0; k < 3; k++) {
					const vkp = v[k][p];
					const vkq = v[k][q];
					v[k][p] = cs * vkp - sn * vkq;
					v[k][q] = sn * vkp + cs * vkq;
				}
			}
	}
	out[0] = a[0][0];
	out[1] = a[1][1];
	out[2] = a[2][2];
	// columns of v are the eigenvectors; make it a proper rotation
	const det =
		v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) -
		v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) +
		v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
	const flip = det < 0 ? -1 : 1;
	for (let col = 0; col < 3; col++)
		for (let row = 0; row < 3; row++)
			out[3 + col * 3 + row] = v[row][col] * (col === 2 ? flip : 1);
}

/** Unit quaternion (w, x, y, z) of the rotation whose columns are m[o..o+8] (column-major). */
function quaternionFromColumns(
	m: Float64Array,
	o: number,
	out: Float32Array,
	q: number,
) {
	const r00 = m[o];
	const r10 = m[o + 1];
	const r20 = m[o + 2];
	const r01 = m[o + 3];
	const r11 = m[o + 4];
	const r21 = m[o + 5];
	const r02 = m[o + 6];
	const r12 = m[o + 7];
	const r22 = m[o + 8];
	const trace = r00 + r11 + r22;
	let w: number;
	let x: number;
	let y: number;
	let z: number;
	if (trace > 0) {
		const s = Math.sqrt(trace + 1) * 2;
		w = s / 4;
		x = (r21 - r12) / s;
		y = (r02 - r20) / s;
		z = (r10 - r01) / s;
	} else if (r00 > r11 && r00 > r22) {
		const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
		w = (r21 - r12) / s;
		x = s / 4;
		y = (r01 + r10) / s;
		z = (r02 + r20) / s;
	} else if (r11 > r22) {
		const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
		w = (r02 - r20) / s;
		x = (r01 + r10) / s;
		y = s / 4;
		z = (r12 + r21) / s;
	} else {
		const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
		w = (r10 - r01) / s;
		x = (r02 + r20) / s;
		y = (r12 + r21) / s;
		z = s / 4;
	}
	const l = Math.hypot(w, x, y, z) || 1;
	out[q] = w / l;
	out[q + 1] = x / l;
	out[q + 2] = y / l;
	out[q + 3] = z / l;
}

/** Hoare quickselect: order/keys[lo..hi] partitioned so position k holds the k-th smallest key. */
function quickselect(
	order: Uint32Array,
	keys: Float32Array,
	lo: number,
	hi: number,
	k: number,
) {
	while (hi > lo) {
		const pivot = keys[(lo + hi) >>> 1];
		let i = lo;
		let j = hi;
		while (i <= j) {
			while (keys[i] < pivot) i++;
			while (keys[j] > pivot) j--;
			if (i <= j) {
				const tk = keys[i];
				keys[i] = keys[j];
				keys[j] = tk;
				const to = order[i];
				order[i] = order[j];
				order[j] = to;
				i++;
				j--;
			}
		}
		if (k <= j) hi = j;
		else if (k >= i) lo = i;
		else return;
	}
}

/**
 * Colours per row for the Truth toggle: each row's sRGB colour mixed toward its provenance tint
 * (sRGB 0..1, a = mix), as the WebGL / Rigi WebGPU shaders do per fragment. Alpha bytes unchanged.
 */
export function tintedLodColors(
	lod: SplatLod,
	tints: readonly (readonly number[])[],
	out = new Uint8Array(lod.colors.length),
): Uint8Array {
	const c = lod.colors;
	for (let r = 0; r < lod.rowCount; r++) {
		const t = tints[lod.provenance[r]] ?? tints[tints.length - 1];
		const m = t[3];
		for (let k = 0; k < 3; k++)
			out[4 * r + k] = Math.round(
				(c[4 * r + k] / 255) * (1 - m) * 255 + t[k] * m * 255,
			);
		out[4 * r + 3] = c[4 * r + 3];
	}
	return out;
}
