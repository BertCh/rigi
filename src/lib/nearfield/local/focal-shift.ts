// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe's affine point map → camera space (moge/utils/geometry_torch.py recover_focal_shift and
// geometry_numpy.py solve_optimal_focal_shift, as MoGe-2 infer() calls them): the network predicts
// points up to an unknown z shift; the focal (relative to half the image diagonal) and the shift are
// the least-squares fit of focal · xy / (z + shift) to the view-plane uv over the masked pixels of a
// 64 × 64 nearest-neighbour downsample. MoGe solves the 1-D shift with scipy's Levenberg–Marquardt
// (ftol 1e-3) and the focal in closed form; this is the same objective with a damped Gauss–Newton
// on the shift run to a tighter tolerance, so it lands on the same minimum (or slightly past
// scipy's early stop).

/** MoGe normalized_view_plane_uv: the image plane spans ±aspect/√(1+aspect²) × ±1/√(1+aspect²). */
export function viewPlaneUv(
	i: number,
	j: number,
	width: number,
	height: number,
): [number, number] {
	const a = width / height;
	const d = Math.sqrt(1 + a * a);
	return [
		((a / d) * (2 * i + 1 - width)) / width,
		((1 / d) * (2 * j + 1 - height)) / height,
	];
}

/** torch F.interpolate(mode="nearest") source index of output index `dst` (in → out samples). */
export const nearestIndex = (dst: number, out: number, inSize: number) =>
	Math.min(inSize - 1, Math.floor((dst * inSize) / out));

/**
 * The masked samples of MoGe's 64 × 64 nearest downsample: `points` ([oh, ow, 3]) and `mask`
 * ([oh, ow], > 0.5 = geometry) are the downsampled maps of a W × H point map, and each sample's uv is
 * the full-resolution view-plane uv at its nearest source pixel (recover_focal_shift resizes the uv
 * grid the same way).
 */
export function focalShiftSamples(
	points: Float32Array,
	mask: Float32Array,
	width: number,
	height: number,
	size: readonly [number, number] = [64, 64],
): { uv: Float64Array; xyz: Float64Array; n: number } {
	const [oh, ow] = size;
	const uv = new Float64Array(2 * oh * ow);
	const xyz = new Float64Array(3 * oh * ow);
	let n = 0;
	for (let y = 0; y < oh; y++) {
		const j = nearestIndex(y, oh, height);
		for (let x = 0; x < ow; x++) {
			const k = y * ow + x;
			if (!(mask[k] > 0.5)) continue;
			const px = points[3 * k];
			const py = points[3 * k + 1];
			const pz = points[3 * k + 2];
			if (!Number.isFinite(px + py + pz)) continue;
			const [u, v] = viewPlaneUv(nearestIndex(x, ow, width), j, width, height);
			uv[2 * n] = u;
			uv[2 * n + 1] = v;
			xyz[3 * n] = px;
			xyz[3 * n + 1] = py;
			xyz[3 * n + 2] = pz;
			n++;
		}
	}
	return { uv, xyz, n };
}

/** Closed-form focal and the residual cost 0.5·|f·xy/(z+s) − uv|² for a given shift (NaN when z+s ≤ 0 somewhere). */
function focalAndCost(
	uv: Float64Array,
	xyz: Float64Array,
	n: number,
	shift: number,
): { focal: number; cost: number } {
	let num = 0;
	let den = 0;
	for (let k = 0; k < n; k++) {
		const w = xyz[3 * k + 2] + shift;
		const px = xyz[3 * k] / w;
		const py = xyz[3 * k + 1] / w;
		num += px * uv[2 * k] + py * uv[2 * k + 1];
		den += px * px + py * py;
	}
	const focal = num / den;
	let cost = 0;
	for (let k = 0; k < n; k++) {
		const w = xyz[3 * k + 2] + shift;
		const ex = (focal * xyz[3 * k]) / w - uv[2 * k];
		const ey = (focal * xyz[3 * k + 1]) / w - uv[2 * k + 1];
		cost += ex * ex + ey * ey;
	}
	return { focal, cost: 0.5 * cost };
}

/**
 * min over shift of |focal(shift) · xy / (z + shift) − uv|, focal in closed form (MoGe
 * solve_optimal_focal_shift). Starts at shift 0 like MoGe; a step that raises the cost (or crosses a
 * pole) is halved, so the shift never jumps over z + shift = 0.
 */
export function solveFocalShift(
	uv: Float64Array,
	xyz: Float64Array,
	n: number,
): { focal: number; shift: number } {
	if (n < 2) return { focal: 1, shift: 0 };
	let shift = 0;
	let cur = focalAndCost(uv, xyz, n, shift);
	if (!Number.isFinite(cur.cost)) return { focal: 1, shift: 0 };
	let lambda = 1e-3;
	for (let it = 0; it < 100; it++) {
		// Gauss–Newton on r(s) with a central-difference Jacobian (r is 2n long; J is a column)
		const h = 1e-6 * Math.max(1, Math.abs(shift));
		const fp = focalAndCost(uv, xyz, n, shift + h).focal;
		const fm = focalAndCost(uv, xyz, n, shift - h).focal;
		const f0 = cur.focal;
		let jtj = 0;
		let jtr = 0;
		for (let k = 0; k < n; k++) {
			const x = xyz[3 * k];
			const y = xyz[3 * k + 1];
			const z = xyz[3 * k + 2];
			const w0 = z + shift;
			const rx = (f0 * x) / w0 - uv[2 * k];
			const ry = (f0 * y) / w0 - uv[2 * k + 1];
			const jx =
				((fp * x) / (z + shift + h) - (fm * x) / (z + shift - h)) / (2 * h);
			const jy =
				((fp * y) / (z + shift + h) - (fm * y) / (z + shift - h)) / (2 * h);
			jtj += jx * jx + jy * jy;
			jtr += jx * rx + jy * ry;
		}
		if (!(jtj > 0)) break;
		let accepted = false;
		for (let tries = 0; tries < 30; tries++) {
			const step = -jtr / (jtj * (1 + lambda));
			const next = focalAndCost(uv, xyz, n, shift + step);
			if (Number.isFinite(next.cost) && next.cost <= cur.cost) {
				const gain = cur.cost - next.cost;
				shift += step;
				cur = next;
				lambda = Math.max(1e-9, lambda / 3);
				accepted = true;
				if (
					gain <= 1e-10 * Math.max(cur.cost, 1e-30) ||
					Math.abs(step) < 1e-9 * Math.max(1, Math.abs(shift))
				)
					return { focal: cur.focal, shift };
				break;
			}
			lambda *= 4;
		}
		if (!accepted) break;
	}
	return { focal: cur.focal, shift };
}

/** Residual cost 0.5·|f·xy/(z+s) − uv|² of a fixed focal at a shift (Infinity when z+s ≤ 0 somewhere). */
function fixedFocalCost(
	uv: Float64Array,
	xyz: Float64Array,
	n: number,
	focal: number,
	shift: number,
): number {
	let cost = 0;
	for (let k = 0; k < n; k++) {
		const w = xyz[3 * k + 2] + shift;
		if (!(w > 0)) return Number.POSITIVE_INFINITY;
		const ex = (focal * xyz[3 * k]) / w - uv[2 * k];
		const ey = (focal * xyz[3 * k + 1]) / w - uv[2 * k + 1];
		cost += ex * ex + ey * ey;
	}
	return 0.5 * cost;
}

/**
 * The z shift alone for a KNOWN focal (a camera whose field of view is known: /live, EXIF): min over
 * shift of |focal · xy / (z + shift) − uv|, damped Gauss–Newton from shift 0 with the same pole guard as
 * solveFocalShift. At low token counts the net's own focal is poor (26% median at 256 tokens), the shift
 * is far better conditioned once the focal is fixed.
 */
export function solveShiftKnownFocal(
	uv: Float64Array,
	xyz: Float64Array,
	n: number,
	focal: number,
): { focal: number; shift: number } {
	if (n < 2 || !(focal > 0)) return { focal: focal > 0 ? focal : 1, shift: 0 };
	let shift = 0;
	let cost = fixedFocalCost(uv, xyz, n, focal, shift);
	if (!Number.isFinite(cost)) return { focal, shift: 0 };
	let lambda = 1e-3;
	for (let it = 0; it < 100; it++) {
		let jtj = 0;
		let jtr = 0;
		for (let k = 0; k < n; k++) {
			const w = xyz[3 * k + 2] + shift;
			const rx = (focal * xyz[3 * k]) / w - uv[2 * k];
			const ry = (focal * xyz[3 * k + 1]) / w - uv[2 * k + 1];
			const jx = (-focal * xyz[3 * k]) / (w * w);
			const jy = (-focal * xyz[3 * k + 1]) / (w * w);
			jtj += jx * jx + jy * jy;
			jtr += jx * rx + jy * ry;
		}
		if (!(jtj > 0)) break;
		let accepted = false;
		for (let tries = 0; tries < 30; tries++) {
			const step = -jtr / (jtj * (1 + lambda));
			const next = fixedFocalCost(uv, xyz, n, focal, shift + step);
			if (next <= cost) {
				const gain = cost - next;
				shift += step;
				cost = next;
				lambda = Math.max(1e-9, lambda / 3);
				accepted = true;
				if (
					gain <= 1e-10 * Math.max(cost, 1e-30) ||
					Math.abs(step) < 1e-9 * Math.max(1, Math.abs(shift))
				)
					return { focal, shift };
				break;
			}
			lambda *= 4;
		}
		if (!accepted) break;
	}
	return { focal, shift };
}

/**
 * MoGe's focal (relative to half the image diagonal) of a pinhole camera with vertical field of view
 * `vfovDegrees` on a `width` × `height` image: the inverse of intrinsicsFromFocal's fy.
 */
export function focalFromVfov(
	vfovDegrees: number,
	width: number,
	height: number,
): number {
	const a = width / height;
	const d = Math.sqrt(1 + a * a);
	return 1 / (Math.tan((vfovDegrees * Math.PI) / 360) * d);
}

/** MoGe's focal from a normalised fy (intrinsicsFromFocal / geom.intrinsicsFromPose: fy = 0.5 / tan(vfov / 2)). */
export function focalFromFy(fy: number, width: number, height: number): number {
	const a = width / height;
	return (2 * fy) / Math.sqrt(1 + a * a);
}

/** Normalised intrinsics from MoGe's focal (relative to half the image diagonal); centre (0.5, 0.5). */
export function intrinsicsFromFocal(
	focal: number,
	width: number,
	height: number,
): { fx: number; fy: number; cx: number; cy: number } {
	const a = width / height;
	const d = Math.sqrt(1 + a * a);
	return { fx: ((focal / 2) * d) / a, fy: (focal / 2) * d, cx: 0.5, cy: 0.5 };
}
