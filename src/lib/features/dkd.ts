// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The small, keypoint-count-sized parts of ALIKED's detector (DKD) and descriptor head (SDDH) that
 * run between graph submissions: threshold / limit selection over the top-k of the NMS map, the 5×5
 * soft-argmax refinement, and the SDDH patch / grid coordinates. Pure functions over K ≤ 4096 points
 * (the dense work, NMS and top-k stay on the nn graph). Formulas follow lightglue/aliked.py.
 */

export const DKD_RADIUS = 2;
const DKD_TEMPERATURE = 0.1;

/** 1 inside, 0 within `radius` of the border (DKD zeroes the NMS map there). */
export function borderMask(
	height: number,
	width: number,
	radius = DKD_RADIUS,
): Float32Array {
	const m = new Float32Array(height * width);
	for (let y = radius; y < height - radius; y++)
		m.fill(1, y * width + radius, (y + 1) * width - radius);
	return m;
}

/**
 * How many of the top-k NMS values (sorted descending) pass DKD's threshold mode: `nms > th`, or, when
 * nothing passes, `nms > mean(score map)` (ALIKED's fallback). `meanScore` is only consulted then.
 */
export function countAbove(
	values: Float32Array,
	threshold: number,
	meanScore?: () => number,
): { count: number; threshold: number } {
	let th = threshold;
	if (!(values.length > 0 && values[0] > th)) {
		if (!meanScore) return { count: 0, threshold: th };
		th = meanScore();
	}
	let n = 0;
	while (n < values.length && values[n] > th) n++;
	return { count: n, threshold: th };
}

/** Flat indices of the 5×5 windows around each flat pixel index (rows of 25, row-major dy, dx). */
export function windowIndices(
	flat: ArrayLike<number>,
	count: number,
	width: number,
	radius = DKD_RADIUS,
): Float32Array {
	const k = 2 * radius + 1;
	const out = new Float32Array(count * k * k);
	for (let i = 0; i < count; i++) {
		const p = flat[i];
		const y = Math.floor(p / width);
		const x = p - y * width;
		for (let dy = -radius; dy <= radius; dy++)
			for (let dx = -radius; dx <= radius; dx++)
				out[i * k * k + (dy + radius) * k + (dx + radius)] =
					(y + dy) * width + (x + dx);
	}
	return out;
}

/**
 * DKD sub-pixel refinement: soft-argmax (T = 0.1) over each 5×5 score window, and the score
 * bilinearly sampled at the refined point (the window holds every corner it needs). Returns
 * keypoints in score-map pixels (x, y) and their scores.
 */
export function softArgmax(
	windows: Float32Array,
	flat: ArrayLike<number>,
	count: number,
	width: number,
	radius = DKD_RADIUS,
): { keypoints: Float32Array; scores: Float32Array } {
	const k = 2 * radius + 1;
	const kk = k * k;
	const keypoints = new Float32Array(2 * count);
	const scores = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const w = windows.subarray(i * kk, (i + 1) * kk);
		let mx = Number.NEGATIVE_INFINITY;
		for (let j = 0; j < kk; j++) mx = Math.max(mx, w[j]);
		let sx = 0;
		let sy = 0;
		let s = 0;
		for (let j = 0; j < kk; j++) {
			const e = Math.exp((w[j] - mx) / DKD_TEMPERATURE);
			s += e;
			sx += e * ((j % k) - radius);
			sy += e * (Math.floor(j / k) - radius);
		}
		const rx = sx / s;
		const ry = sy / s;
		const p = flat[i];
		const y0 = Math.floor(p / width);
		const x0 = p - y0 * width;
		keypoints[2 * i] = x0 + rx;
		keypoints[2 * i + 1] = y0 + ry;
		// bilinear in window coordinates (centre at radius, radius)
		const u = rx + radius;
		const v = ry + radius;
		const iu = Math.min(Math.floor(u), k - 1);
		const iv = Math.min(Math.floor(v), k - 1);
		const fu = u - iu;
		const fv = v - iv;
		const at = (yy: number, xx: number) =>
			yy < k && xx < k ? w[yy * k + xx] : 0;
		scores[i] =
			at(iv, iu) * (1 - fu) * (1 - fv) +
			at(iv, iu + 1) * fu * (1 - fv) +
			at(iv + 1, iu) * (1 - fu) * fv +
			at(iv + 1, iu + 1) * fu * fv;
	}
	return { keypoints, scores };
}

/**
 * SDDH's 3×3 patch nodes per keypoint (get_patches: corner = trunc(floor(kp) − 0.5) clamped to
 * [0, size − 4]), as (x, y) pixel pairs of the unpadded map, keypoint-major then row, column.
 */
export function patchNodes(
	keypoints: Float32Array,
	count: number,
	height: number,
	width: number,
	size = 3,
): Float32Array {
	const out = new Float32Array(count * size * size * 2);
	for (let i = 0; i < count; i++) {
		const cx = Math.min(
			Math.max(Math.trunc(Math.floor(keypoints[2 * i]) - size / 2 + 1), 0),
			width - 1 - size,
		);
		const cy = Math.min(
			Math.max(Math.trunc(Math.floor(keypoints[2 * i + 1]) - size / 2 + 1), 0),
			height - 1 - size,
		);
		for (let a = 0; a < size; a++)
			for (let b = 0; b < size; b++) {
				const o = ((i * size + a) * size + b) * 2;
				out[o] = cx + b;
				out[o + 1] = cy + a;
			}
	}
	return out;
}

/**
 * Pixel (x, y) pairs of the unpadded map → grid_sample (align_corners) coordinates on the padded
 * maps: every ALIKED branch is upsampled with align_corners to the padded size, so one normalised
 * grid addresses all four.
 */
export function toPaddedGrid(
	pixels: Float32Array,
	left: number,
	top: number,
	paddedWidth: number,
	paddedHeight: number,
): Float32Array {
	const out = new Float32Array(pixels.length);
	const sx = 2 / (paddedWidth - 1);
	const sy = 2 / (paddedHeight - 1);
	for (let i = 0; i < pixels.length; i += 2) {
		out[i] = (pixels[i] + left) * sx - 1;
		out[i + 1] = (pixels[i + 1] + top) * sy - 1;
	}
	return out;
}

/**
 * SDDH sample corners: keypoint (x, y) + offset (offsets [K, 2P]: P x-offsets then P y-offsets), as the
 * four integer corners (x0, y0), (x0+1, y0), (x0, y0+1), (x0+1, y0+1) of each sample with their
 * bilinear weights; corners outside the unpadded map weigh 0 (grid_sample zeros padding).
 * nodes: K×P×4 (x, y) pairs; weights: K×P×4.
 */
export function sddhCorners(
	keypoints: Float32Array,
	offsets: Float32Array,
	count: number,
	positions: number,
	height: number,
	width: number,
): { nodes: Float32Array; weights: Float32Array } {
	const nodes = new Float32Array(count * positions * 8);
	const weights = new Float32Array(count * positions * 4);
	for (let i = 0; i < count; i++)
		for (let p = 0; p < positions; p++) {
			const x = keypoints[2 * i] + offsets[i * 2 * positions + p];
			const y =
				keypoints[2 * i + 1] + offsets[i * 2 * positions + positions + p];
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const fx = x - x0;
			const fy = y - y0;
			const o = (i * positions + p) * 4;
			for (let c = 0; c < 4; c++) {
				const cx = x0 + (c & 1);
				const cy = y0 + (c >> 1);
				const inside = cx >= 0 && cx < width && cy >= 0 && cy < height;
				weights[o + c] = inside
					? (c & 1 ? fx : 1 - fx) * (c >> 1 ? fy : 1 - fy)
					: 0;
				nodes[2 * (o + c)] = inside ? cx : 0;
				nodes[2 * (o + c) + 1] = inside ? cy : 0;
			}
		}
	return { nodes, weights };
}
