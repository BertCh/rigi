// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Mat3, Vec3 } from "#/lib/ontology/core/geometry";
// Small dense linear algebra for the solvers: row-major number[][] (n ≤ 12) and, for the
// Cholesky routines, flat row-major Float64Array.

export type { Mat3, Vec3 };

export const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
	a[0] - b[0],
	a[1] - b[1],
	a[2] - b[2],
];
export const scale3 = (a: ArrayLike<number>, s: number): Vec3 => [
	a[0] * s,
	a[1] * s,
	a[2] * s,
];
export const norm3 = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
export const unit3 = (a: ArrayLike<number>): Vec3 => scale3(a, 1 / norm3(a));
export const cross3 = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];

// ---- 3×3 (row-major, length 9) ----
type Out9 = number[] | Float64Array;

/** C = A · B for row-major 3×3. `out` (not aliasing A or B) is filled and returned; without it a Mat3 tuple. */
export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Mat3;
export function mul3<T extends Out9>(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	out: T,
): T;
export function mul3(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	out: Out9 = new Array(9).fill(0),
): Out9 {
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			out[r * 3 + c] =
				a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
	return out;
}

/** Aᵀ for row-major 3×3; `out` must not alias A. */
export function transpose3(a: ArrayLike<number>): Mat3;
export function transpose3<T extends Out9>(a: ArrayLike<number>, out: T): T;
export function transpose3(
	a: ArrayLike<number>,
	out: Out9 = new Array(9).fill(0),
): Out9 {
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++) out[c * 3 + r] = a[r * 3 + c];
	return out;
}

/** Rodrigues: exp([w]×) as a row-major 3×3 (Taylor branch below 1e-8 rad). `out` is filled and returned. */
export function expSO3(wx: number, wy: number, wz: number): Mat3;
export function expSO3<T extends Out9>(
	wx: number,
	wy: number,
	wz: number,
	out: T,
): T;
export function expSO3(
	wx: number,
	wy: number,
	wz: number,
	out: Out9 = new Array(9).fill(0),
): Out9 {
	const th2 = wx * wx + wy * wy + wz * wz;
	const th = Math.sqrt(th2);
	let a: number;
	let b: number;
	if (th < 1e-8) {
		a = 1 - th2 / 6;
		b = 0.5 - th2 / 24;
	} else {
		a = Math.sin(th) / th;
		b = (1 - Math.cos(th)) / th2;
	}
	out[0] = 1 - b * (wy * wy + wz * wz);
	out[1] = -a * wz + b * wx * wy;
	out[2] = a * wy + b * wx * wz;
	out[3] = a * wz + b * wx * wy;
	out[4] = 1 - b * (wx * wx + wz * wz);
	out[5] = -a * wx + b * wy * wz;
	out[6] = -a * wy + b * wx * wz;
	out[7] = a * wx + b * wy * wz;
	out[8] = 1 - b * (wx * wx + wy * wy);
	return out;
}

/** Rotation matrix of a rotation vector w (axis · angle, radians), row-major. */
export const rodrigues = (w: ArrayLike<number>): Mat3 =>
	expSO3(w[0], w[1], w[2]);

/** Rotation angle of a row-major 3×3 rotation in radians, acos((tr − 1) / 2) clamped. */
export function rotationAngle(R: ArrayLike<number>): number {
	return Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)));
}

/** Solve A x = b by Gaussian elimination with partial pivoting. Returns null if singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (!(Math.abs(M[p][c]) > 1e-300)) return null;
		if (p !== c) [M[p], M[c]] = [M[c], M[p]];
		for (let r = c + 1; r < n; r++) {
			const f = M[r][c] / M[c][c];
			if (f === 0) continue;
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	const x = new Array<number>(n).fill(0);
	for (let r = n - 1; r >= 0; r--) {
		let s = M[r][n];
		for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
		x[r] = s / M[r][r];
	}
	return x.every(Number.isFinite) ? x : null;
}

/**
 * Solve A x = b by Gauss–Jordan elimination with partial pivoting. With `pivotTol`, null when a
 * pivot's magnitude is below it; without, never null (zero pivots are replaced by 1e-12).
 */
export function gaussJordan(A: number[][], b: number[]): number[];
export function gaussJordan(
	A: number[][],
	b: number[],
	pivotTol: number,
): number[] | null;
export function gaussJordan(
	A: number[][],
	b: number[],
	pivotTol?: number,
): number[] | null {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]]);
	const clamp = pivotTol === undefined;
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
		if (!clamp && Math.abs(M[piv][c]) < pivotTol) return null;
		[M[c], M[piv]] = [M[piv], M[c]];
		const d = clamp ? M[c][c] || 1e-12 : M[c][c];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / d;
			for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((row, i) => row[n] / (clamp ? row[i] || 1e-12 : row[i]));
}

/** Solves the SPD system A x = b (n×n, row-major) by Cholesky; null if not SPD. */
export function choleskySolve(
	A: Float64Array,
	b: Float64Array,
	n: number,
): Float64Array | null {
	const L = new Float64Array(n * n);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j <= i; j++) {
			let s = A[i * n + j];
			for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
			if (i === j) {
				if (!(s > 0)) return null;
				L[i * n + i] = Math.sqrt(s);
			} else L[i * n + j] = s / L[j * n + j];
		}
	}
	const y = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let s = b[i];
		for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
		y[i] = s / L[i * n + i];
	}
	const x = new Float64Array(n);
	for (let i = n - 1; i >= 0; i--) {
		let s = y[i];
		for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
		x[i] = s / L[i * n + i];
	}
	return x;
}

/** Inverse of an SPD matrix (n×n row-major); null if singular. */
export function invertSPD(A: Float64Array, n: number): Float64Array | null {
	const inv = new Float64Array(n * n);
	for (let j = 0; j < n; j++) {
		const e = new Float64Array(n);
		e[j] = 1;
		const x = choleskySolve(A, e, n);
		if (!x) return null;
		for (let i = 0; i < n; i++) inv[i * n + j] = x[i];
	}
	return inv;
}

/** Inverse of a symmetric positive (semi)definite matrix via Jacobi eigendecomposition (pseudo-inverse). */
export function invSym(A: number[][], rcond = 1e-12): number[][] {
	const n = A.length;
	const { values, vectors } = jacobiEigen(A);
	const vmax = Math.max(...values.map(Math.abs), 1e-300);
	const out = Array.from({ length: n }, () => new Array<number>(n).fill(0));
	for (let k = 0; k < n; k++) {
		if (Math.abs(values[k]) <= rcond * vmax) continue;
		const inv = 1 / values[k];
		for (let i = 0; i < n; i++)
			for (let j = 0; j < n; j++)
				out[i][j] += vectors[i][k] * vectors[j][k] * inv;
	}
	return out;
}

/**
 * Covariance from an information matrix: the pseudo-inverse invSym, except that a parameter with a
 * component in the null space (unobservable: its eigenvalue is ≤ rcond·λmax) gets variance +Infinity on
 * the diagonal instead of the pseudo-inverse's 0 or understated value (CR-49), so σ tests fail closed.
 * Off-diagonal entries are the pseudo-inverse's. Identical to invSym for a full-rank A.
 */
export function invSymCov(
	A: number[][],
	rcond = 1e-12,
	nullTol = 1e-6,
): number[][] {
	const n = A.length;
	const { values, vectors } = jacobiEigen(A);
	const vmax = Math.max(...values.map(Math.abs), 1e-300);
	const out = invSym(A, rcond);
	for (let k = 0; k < n; k++) {
		if (Math.abs(values[k]) > rcond * vmax) continue;
		for (let i = 0; i < n; i++)
			if (Math.abs(vectors[i][k]) > nullTol)
				out[i][i] = Number.POSITIVE_INFINITY;
	}
	return out;
}

/**
 * Cyclic Jacobi eigendecomposition of a symmetric matrix. Eigenvalues ascending;
 * `vectors[i][k]` is component i of eigenvector k.
 */
export function jacobiEigen(S: number[][]): {
	values: number[];
	vectors: number[][];
} {
	const n = S.length;
	const a = S.map((r) => r.slice());
	const v: number[][] = Array.from({ length: n }, (_, i) =>
		Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
	);
	for (let sweep = 0; sweep < 60; sweep++) {
		let off = 0;
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
		if (off < 1e-30) break;
		for (let p = 0; p < n; p++)
			for (let q = p + 1; q < n; q++) {
				const apq = a[p][q];
				if (Math.abs(apq) < 1e-300) continue;
				const theta = (a[q][q] - a[p][p]) / (2 * apq);
				const t =
					Math.sign(theta || 1) /
					(Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < n; k++) {
					const akp = a[k][p];
					const akq = a[k][q];
					a[k][p] = c * akp - s * akq;
					a[k][q] = s * akp + c * akq;
				}
				for (let k = 0; k < n; k++) {
					const apk = a[p][k];
					const aqk = a[q][k];
					a[p][k] = c * apk - s * aqk;
					a[q][k] = s * apk + c * aqk;
				}
				for (let k = 0; k < n; k++) {
					const vkp = v[k][p];
					const vkq = v[k][q];
					v[k][p] = c * vkp - s * vkq;
					v[k][q] = s * vkp + c * vkq;
				}
			}
	}
	const idx = Array.from({ length: n }, (_, i) => i).sort(
		(i, j) => a[i][i] - a[j][j],
	);
	return {
		values: idx.map((i) => a[i][i]),
		vectors: v.map((row) => idx.map((i) => row[i])),
	};
}

/** Real roots of a polynomial (coeffs highest degree first) via Durand–Kerner, polished by Newton. */
export function realRoots(coeffs: number[], imagTol = 1e-6): number[] {
	let c = coeffs.slice();
	while (c.length > 1 && Math.abs(c[0]) < 1e-14 * Math.max(...c.map(Math.abs)))
		c = c.slice(1);
	const n = c.length - 1;
	if (n < 1) return [];
	const a = c.map((x) => x / c[0]);
	if (n === 1) return [-a[1]];
	// bound on root magnitude
	const R = 1 + Math.max(...a.slice(1).map(Math.abs));
	let re = Array.from(
		{ length: n },
		(_, k) => R * 0.9 * Math.cos((2 * Math.PI * k) / n + 0.4),
	);
	let im = Array.from(
		{ length: n },
		(_, k) => R * 0.9 * Math.sin((2 * Math.PI * k) / n + 0.4),
	);
	for (let it = 0; it < 500; it++) {
		let delta = 0;
		const nre = re.slice();
		const nim = im.slice();
		for (let i = 0; i < n; i++) {
			// p(z)
			let pr = 1;
			let pi = 0;
			for (let k = 1; k <= n; k++) {
				const tr = pr * re[i] - pi * im[i] + a[k];
				const ti = pr * im[i] + pi * re[i];
				pr = tr;
				pi = ti;
			}
			// prod (z_i - z_j)
			let qr = 1;
			let qi = 0;
			for (let j = 0; j < n; j++) {
				if (j === i) continue;
				const dr = re[i] - re[j];
				const di = im[i] - im[j];
				const tr = qr * dr - qi * di;
				const ti = qr * di + qi * dr;
				qr = tr;
				qi = ti;
			}
			const den = qr * qr + qi * qi || 1e-300;
			const wr = (pr * qr + pi * qi) / den;
			const wi = (pi * qr - pr * qi) / den;
			nre[i] = re[i] - wr;
			nim[i] = im[i] - wi;
			delta = Math.max(delta, Math.hypot(wr, wi));
		}
		re = nre;
		im = nim;
		if (delta < 1e-14 * R) break;
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		if (Math.abs(im[i]) > imagTol * Math.max(1, Math.abs(re[i]))) continue;
		let x = re[i];
		for (let k = 0; k < 5; k++) {
			let p = 1;
			let dp = 0;
			for (let j = 1; j <= n; j++) {
				dp = dp * x + p;
				p = p * x + a[j];
			}
			if (dp === 0) break;
			x -= p / dp;
		}
		out.push(x);
	}
	return out;
}

/**
 * Unit quaternion (w, x, y, z) of a proper rotation matrix (row-major 3×3, Shepperd branches).
 * `positiveW` flips the sign so that w ≥ 0 (the COLMAP qvec convention); without it the branch's own
 * sign is kept (the splat-rotation call site, where q and −q are the same rotation).
 */
export function mat3ToQuat(
	m: ArrayLike<number>,
	positiveW = false,
): [number, number, number, number] {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m as number[];
	const tr = m00 + m11 + m22;
	let w: number;
	let x: number;
	let y: number;
	let z: number;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s;
		x = (m21 - m12) / s;
		y = (m02 - m20) / s;
		z = (m10 - m01) / s;
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		w = (m21 - m12) / s;
		x = 0.25 * s;
		y = (m01 + m10) / s;
		z = (m02 + m20) / s;
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		w = (m02 - m20) / s;
		x = (m01 + m10) / s;
		y = 0.25 * s;
		z = (m12 + m21) / s;
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		w = (m10 - m01) / s;
		x = (m02 + m20) / s;
		y = (m12 + m21) / s;
		z = 0.25 * s;
	}
	const n = Math.hypot(w, x, y, z) * (positiveW && w < 0 ? -1 : 1);
	return [w / n, x / n, y / n, z / n];
}
