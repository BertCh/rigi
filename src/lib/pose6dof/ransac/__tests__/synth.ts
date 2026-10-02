// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Synthetic correspondence sets for the RANSAC specs, the Dawn check and the parity check.
// The first ⌊N · outlierFrac⌋ correspondences are outliers.
import { expSO3 } from "../rot3";

const gauss = (rnd: () => number) =>
	Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/** Bearings b1 = R b0 (+ noise of `noise` rad per component), N×3 unit each. */
export function synthRotation(
	n: number,
	outlierFrac: number,
	rnd: () => number,
	noise = 0.0005,
) {
	const R = expSO3(
		(rnd() - 0.5) * 0.6,
		(rnd() - 0.5) * 1.2,
		(rnd() - 0.5) * 0.2,
	);
	const b0 = new Float64Array(n * 3);
	const b1 = new Float64Array(n * 3);
	const nOut = Math.floor(n * outlierFrac);
	for (let i = 0; i < n; i++) {
		const v = [gauss(rnd) * 0.4, gauss(rnd) * 0.3, 1];
		const l = Math.hypot(v[0], v[1], v[2]);
		const a = v.map((x) => x / l);
		b0.set(a, i * 3);
		let w =
			i < nOut
				? [gauss(rnd) * 0.4, gauss(rnd) * 0.3, 1]
				: [
						R[0] * a[0] + R[1] * a[1] + R[2] * a[2],
						R[3] * a[0] + R[4] * a[1] + R[5] * a[2],
						R[6] * a[0] + R[7] * a[1] + R[8] * a[2],
					];
		w = w.map((x) => x + gauss(rnd) * noise);
		const l2 = Math.hypot(w[0], w[1], w[2]);
		b1.set(
			w.map((x) => x / l2),
			i * 3,
		);
	}
	return { R, b0, b1, nOut };
}

/**
 * A 1024×768 pinhole (f 1000) looking at terrain-like points 0.5–5.5 km away, 1 px noise; outliers
 * are uniform in the image. World units are metres; the eye sits near (2000, −3000, 1500).
 */
export function synthAbsolute(
	n: number,
	outlierFrac: number,
	rnd: () => number,
	noisePx = 1,
) {
	const f = 1000;
	const cx = 512;
	const cy = 384;
	const R = expSO3(
		Math.PI / 2 + (rnd() - 0.5) * 0.3,
		(rnd() - 0.5) * 0.3,
		(rnd() - 0.5) * 0.1,
	);
	const eye = [2000 + rnd() * 100, -3000 + rnd() * 100, 1500 + rnd() * 50];
	// t = −R eye
	const t = new Float64Array(
		[0, 1, 2].map(
			(r) =>
				-(R[r * 3] * eye[0] + R[r * 3 + 1] * eye[1] + R[r * 3 + 2] * eye[2]),
		),
	);
	const p2 = new Float64Array(n * 2);
	const p3 = new Float64Array(n * 3);
	const nOut = Math.floor(n * outlierFrac);
	for (let i = 0; i < n; i++) {
		const z = 500 + rnd() * 5000;
		const u = rnd() * 1024;
		const v = rnd() * 768;
		const pc = [((u - cx) / f) * z, ((v - cy) / f) * z, z];
		const q = [pc[0] - t[0], pc[1] - t[1], pc[2] - t[2]];
		p3.set(
			[
				R[0] * q[0] + R[3] * q[1] + R[6] * q[2],
				R[1] * q[0] + R[4] * q[1] + R[7] * q[2],
				R[2] * q[0] + R[5] * q[1] + R[8] * q[2],
			],
			i * 3,
		);
		p2[i * 2] = i < nOut ? rnd() * 1024 : u + gauss(rnd) * noisePx;
		p2[i * 2 + 1] = i < nOut ? rnd() * 768 : v + gauss(rnd) * noisePx;
	}
	return { R, t, eye, f, cx, cy, p2, p3, nOut };
}
