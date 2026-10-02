// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Allocation-light 3×3 rotation helpers on row-major Float64Array(9), for the RANSAC hot loops.
// Convention: y = R x (R maps the first frame into the second).

import {
	expSO3 as linalgExpSO3,
	mul3 as linalgMul3,
	transpose3 as linalgTranspose3,
} from "#/lib/linalg";
import type { Mat3F64 } from "#/lib/ontology/core/geometry";

export type { Mat3F64 };

export const identity3 = (): Mat3F64 =>
	new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** out = A · B (out may not alias A or B). */
export const mul3 = (
	A: ArrayLike<number>,
	B: ArrayLike<number>,
	out: Mat3F64 = new Float64Array(9),
): Mat3F64 => linalgMul3(A, B, out);

export const transpose3 = (
	A: ArrayLike<number>,
	out: Mat3F64 = new Float64Array(9),
): Mat3F64 => linalgTranspose3(A, out);

/** Geodesic angle of a rotation matrix, degrees (run_propagate.rot_angle, stable near 0). */
export function rotationAngleDeg(R: ArrayLike<number>): number {
	return rotationDistanceDeg(R, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

/**
 * Angle between two rotations, degrees. From the Frobenius distance ‖A − B‖ = 2√2 sin(θ/2), which
 * (unlike acos of the trace) keeps its precision for small angles.
 */
export function rotationDistanceDeg(
	A: ArrayLike<number>,
	B: ArrayLike<number>,
): number {
	let s = 0;
	for (let i = 0; i < 9; i++) s += (A[i] - B[i]) ** 2;
	return (
		(2 * Math.asin(Math.min(1, Math.sqrt(s) / (2 * Math.SQRT2))) * 180) /
		Math.PI
	);
}

/** Rodrigues: out = exp([w]×). */
export const expSO3 = (
	wx: number,
	wy: number,
	wz: number,
	out: Mat3F64 = new Float64Array(9),
): Mat3F64 => linalgExpSO3(wx, wy, wz, out);

const N4 = new Float64Array(16);
const V4 = new Float64Array(16);

/**
 * Largest-eigenvalue eigenvector of a symmetric 4×4 (cyclic Jacobi in place on module scratch).
 * Returns [q0, qx, qy, qz] into `q`.
 */
function topEigen4(q: Float64Array) {
	const a = N4;
	const v = V4;
	v.fill(0);
	v[0] = v[5] = v[10] = v[15] = 1;
	for (let sweep = 0; sweep < 30; sweep++) {
		let off = 0;
		let diag = 0;
		for (let i = 0; i < 4; i++) {
			diag += a[i * 5] * a[i * 5];
			for (let j = i + 1; j < 4; j++) off += a[i * 4 + j] * a[i * 4 + j];
		}
		if (off <= 1e-30 * (diag + 1e-300)) break;
		for (let p = 0; p < 4; p++)
			for (let r = p + 1; r < 4; r++) {
				const apq = a[p * 4 + r];
				if (Math.abs(apq) < 1e-300) continue;
				const theta = (a[r * 5] - a[p * 5]) / (2 * apq);
				const t =
					Math.sign(theta || 1) /
					(Math.abs(theta) + Math.sqrt(theta * theta + 1));
				const c = 1 / Math.sqrt(t * t + 1);
				const s = t * c;
				for (let k = 0; k < 4; k++) {
					const akp = a[k * 4 + p];
					const akq = a[k * 4 + r];
					a[k * 4 + p] = c * akp - s * akq;
					a[k * 4 + r] = s * akp + c * akq;
				}
				for (let k = 0; k < 4; k++) {
					const apk = a[p * 4 + k];
					const aqk = a[r * 4 + k];
					a[p * 4 + k] = c * apk - s * aqk;
					a[r * 4 + k] = s * apk + c * aqk;
				}
				for (let k = 0; k < 4; k++) {
					const vkp = v[k * 4 + p];
					const vkq = v[k * 4 + r];
					v[k * 4 + p] = c * vkp - s * vkq;
					v[k * 4 + r] = s * vkp + c * vkq;
				}
			}
	}
	let best = 0;
	for (let i = 1; i < 4; i++) if (a[i * 5] > a[best * 5]) best = i;
	for (let k = 0; k < 4; k++) q[k] = v[k * 4 + best];
}

const Q = new Float64Array(4);

/**
 * Least-squares rotation (Horn's quaternion method, equal to Kabsch with the det fix) from the
 * cross-covariance S[a·3+b] = Σ w x_a y_b: R minimises Σ w |y − R x|². Proper rotation always.
 */
export function rotationFromCovariance(
	S: ArrayLike<number>,
	out: Mat3F64 = new Float64Array(9),
): Mat3F64 {
	const xx = S[0];
	const xy = S[1];
	const xz = S[2];
	const yx = S[3];
	const yy = S[4];
	const yz = S[5];
	const zx = S[6];
	const zy = S[7];
	const zz = S[8];
	const a = N4;
	a[0] = xx + yy + zz;
	a[1] = a[4] = yz - zy;
	a[2] = a[8] = zx - xz;
	a[3] = a[12] = xy - yx;
	a[5] = xx - yy - zz;
	a[6] = a[9] = xy + yx;
	a[7] = a[13] = zx + xz;
	a[10] = -xx + yy - zz;
	a[11] = a[14] = yz + zy;
	a[15] = -xx - yy + zz;
	topEigen4(Q);
	const [q0, qx, qy, qz] = Q;
	const n = q0 * q0 + qx * qx + qy * qy + qz * qz || 1;
	out[0] = (q0 * q0 + qx * qx - qy * qy - qz * qz) / n;
	out[1] = (2 * (qx * qy - q0 * qz)) / n;
	out[2] = (2 * (qx * qz + q0 * qy)) / n;
	out[3] = (2 * (qy * qx + q0 * qz)) / n;
	out[4] = (q0 * q0 - qx * qx + qy * qy - qz * qz) / n;
	out[5] = (2 * (qy * qz - q0 * qx)) / n;
	out[6] = (2 * (qz * qx - q0 * qy)) / n;
	out[7] = (2 * (qz * qy + q0 * qx)) / n;
	out[8] = (q0 * q0 - qx * qx - qy * qy + qz * qz) / n;
	return out;
}

/** Kabsch over the rows `idx` (or all) of N×3 arrays: R with y ≈ R x. */
export function kabsch(
	x: ArrayLike<number>,
	y: ArrayLike<number>,
	idx?: ArrayLike<number>,
	out: Mat3F64 = new Float64Array(9),
): Mat3F64 {
	const S = new Float64Array(9);
	const n = idx ? idx.length : x.length / 3;
	for (let j = 0; j < n; j++) {
		const i = idx ? idx[j] : j;
		const x0 = x[i * 3];
		const x1 = x[i * 3 + 1];
		const x2 = x[i * 3 + 2];
		const y0 = y[i * 3];
		const y1 = y[i * 3 + 1];
		const y2 = y[i * 3 + 2];
		S[0] += x0 * y0;
		S[1] += x0 * y1;
		S[2] += x0 * y2;
		S[3] += x1 * y0;
		S[4] += x1 * y1;
		S[5] += x1 * y2;
		S[6] += x2 * y0;
		S[7] += x2 * y1;
		S[8] += x2 * y2;
	}
	return rotationFromCovariance(S, out);
}
