// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The DKD soft-argmax and the SDDH patch / corner math of dkd.ts (the CPU reference), written as nn ops
 * so ALIKED runs as ONE forward with a fixed (padded) keypoint count: no readback between the top-k
 * and the descriptors. Every function works on K slots in parallel; slots past the real keypoint count
 * hold finite garbage (indices are clamped, the softmax has a 1 term) and are sliced off by the caller.
 * Keypoint-like tensors are [K, 1] so they broadcast against [1, N] tables and [K, P] offsets.
 * Index tensors are f32 holding integers (exact below 2^24).
 */
import type { Nn, Tensor } from "#/lib/nn";
import { DKD_RADIUS } from "./dkd";

const DKD_TEMPERATURE = 0.1;
const WINDOW = 2 * DKD_RADIUS + 1;
const PATCH = 3;

/** Small constant tables (build once per Nn, see aliked.ts). */
export interface DkdTables {
	/** [1, 25]: window dx (−2…2) and dy, row-major (dy, dx). */
	windowDx: Tensor;
	windowDy: Tensor;
	/** [1, 9]: SDDH 3×3 patch column and row offsets, row-major. */
	patchCol: Tensor;
	patchRow: Tensor;
}

export function createDkdTables(nn: Nn): DkdTables {
	const dx = new Float32Array(WINDOW * WINDOW);
	const dy = new Float32Array(WINDOW * WINDOW);
	for (let j = 0; j < dx.length; j++) {
		dx[j] = (j % WINDOW) - DKD_RADIUS;
		dy[j] = Math.floor(j / WINDOW) - DKD_RADIUS;
	}
	const col = new Float32Array(PATCH * PATCH);
	const row = new Float32Array(PATCH * PATCH);
	for (let j = 0; j < col.length; j++) {
		col[j] = j % PATCH;
		row[j] = Math.floor(j / PATCH);
	}
	return {
		windowDx: nn.fromArray(dx, [1, dx.length]),
		windowDy: nn.fromArray(dy, [1, dy.length]),
		patchCol: nn.fromArray(col, [1, col.length]),
		patchRow: nn.fromArray(row, [1, row.length]),
	};
}

export function disposeDkdTables(nn: Nn, t: DkdTables): void {
	nn.dispose([t.windowDx, t.windowDy, t.patchCol, t.patchRow]);
}

/**
 * dkd.ts softArgmax for K flat pixel indices [K] over the flat score map [H·W]: keypoints (x, y) in
 * score-map pixels and the bilinearly interpolated score, each [K, 1]. The score interpolation is the
 * window-wide tent form of the CPU's four-corner blend (identical weights).
 */
export function softArgmaxNn(
	nn: Nn,
	t: DkdTables,
	scoreFlat: Tensor,
	flatIndex: Tensor,
	width: number,
): { x: Tensor; y: Tensor; score: Tensor } {
	const k = flatIndex.shape[0];
	const last = scoreFlat.shape[0] - 1;
	const y0 = nn.unary("floor", nn.div(flatIndex, width));
	const x0 = nn.sub(flatIndex, nn.mul(y0, width));
	const around = nn.add(nn.mul(t.windowDy, width), t.windowDx); // [1, 25]
	// clamp: only the garbage slots can leave the map (real keypoints are ≥ 2 px inside the border)
	const indices = nn.clamp(
		nn.add(nn.reshape(flatIndex, [k, 1]), around),
		0,
		last,
	);
	const w = nn.reshape(
		nn.gather(scoreFlat, nn.reshape(indices, [k * WINDOW * WINDOW]), 0),
		[k, WINDOW * WINDOW],
	);
	const e = nn.unary(
		"exp",
		nn.div(nn.sub(w, nn.max(w, 1, true)), DKD_TEMPERATURE),
	);
	const s = nn.sum(e, 1, true);
	const rx = nn.div(nn.sum(nn.mul(e, t.windowDx), 1, true), s);
	const ry = nn.div(nn.sum(nn.mul(e, t.windowDy), 1, true), s);
	// score at the refined point: tent weights over the window == the bilinear blend of its corners
	const tent = (r: Tensor, d: Tensor) =>
		nn.relu(nn.sub(1, nn.unary("abs", nn.sub(r, d))));
	const score = nn.sum(
		nn.mul(w, nn.mul(tent(rx, t.windowDx), tent(ry, t.windowDy))),
		1,
		true,
	);
	return {
		x: nn.add(nn.reshape(x0, [k, 1]), rx),
		y: nn.add(nn.reshape(y0, [k, 1]), ry),
		score,
	};
}

/** (pixel + pad) · 2/(size − 1) − 1: toPaddedGrid for one axis. */
export function toPaddedCoord(
	nn: Nn,
	pixels: Tensor,
	pad: number,
	paddedSize: number,
): Tensor {
	return nn.sub(nn.scale(nn.add(pixels, pad), 2 / (paddedSize - 1)), 1);
}

/** Stacks two same-shaped coordinate tensors on a new last axis, then reshapes to `shape` (ends in 2). */
function stackXy(
	nn: Nn,
	x: Tensor,
	y: Tensor,
	shape: readonly number[],
): Tensor {
	const col = (t: Tensor) => nn.reshape(t, [...t.shape, 1]);
	return nn.reshape(nn.concat([col(x), col(y)], x.shape.length), shape);
}

/**
 * dkd.ts patchNodes ∘ toPaddedGrid: the 3×3 patch nodes of each keypoint as a grid_sample grid
 * [1, 1, K·9, 2] on the padded maps (keypoint-major, then row, column).
 */
export function patchGridNn(
	nn: Nn,
	t: DkdTables,
	x: Tensor,
	y: Tensor,
	height: number,
	width: number,
	pads: {
		left: number;
		top: number;
		paddedWidth: number;
		paddedHeight: number;
	},
): Tensor {
	const k = x.shape[0];
	// trunc(floor(v) − 1.5 + 1) = floor(v) − 1 above 0, and clamps to 0 below
	const corner = (v: Tensor, size: number) =>
		nn.clamp(nn.sub(nn.unary("floor", v), 1), 0, size - 1 - PATCH);
	const px = nn.add(corner(x, width), t.patchCol); // [K, 9]
	const py = nn.add(corner(y, height), t.patchRow);
	return stackXy(
		nn,
		toPaddedCoord(nn, px, pads.left, pads.paddedWidth),
		toPaddedCoord(nn, py, pads.top, pads.paddedHeight),
		[1, 1, k * PATCH * PATCH, 2],
	);
}

/**
 * dkd.ts sddhCorners ∘ toPaddedGrid: keypoints [K, 1] + SDDH offsets [K, 2P] (P x-offsets, then P
 * y-offsets) → the four integer corners of each sample as a grid [1, K, P·4, 2] on the padded maps and
 * their bilinear weights [K, P, 4] (0 for corners outside the unpadded map, whose node is 0).
 */
export function sddhCornersNn(
	nn: Nn,
	x: Tensor,
	y: Tensor,
	offsets: Tensor,
	positions: number,
	height: number,
	width: number,
	pads: {
		left: number;
		top: number;
		paddedWidth: number;
		paddedHeight: number;
	},
): { grid: Tensor; weights: Tensor } {
	const k = x.shape[0];
	const px = nn.add(x, nn.slice(offsets, 1, 0, positions)); // [K, P]
	const py = nn.add(y, nn.slice(offsets, 1, positions, 2 * positions));
	const x0 = nn.unary("floor", px);
	const y0 = nn.unary("floor", py);
	const fx = nn.sub(px, x0);
	const fy = nn.sub(py, y0);
	const nodesX: Tensor[] = [];
	const nodesY: Tensor[] = [];
	const weights: Tensor[] = [];
	for (let c = 0; c < 4; c++) {
		const bx = c & 1;
		const by = c >> 1;
		const cx = bx ? nn.add(x0, 1) : x0;
		const cy = by ? nn.add(y0, 1) : y0;
		const inside = nn.mul(
			nn.mul(nn.compare("ge", cx, 0), nn.compare("lt", cx, width)),
			nn.mul(nn.compare("ge", cy, 0), nn.compare("lt", cy, height)),
		);
		nodesX.push(nn.mul(cx, inside));
		nodesY.push(nn.mul(cy, inside));
		weights.push(
			nn.mul(inside, nn.mul(bx ? fx : nn.sub(1, fx), by ? fy : nn.sub(1, fy))),
		);
	}
	const stack = (ts: Tensor[]) =>
		nn.concat(
			ts.map((t) => nn.reshape(t, [k, positions, 1])),
			2,
		); // [K, P, 4]
	return {
		grid: stackXy(
			nn,
			toPaddedCoord(nn, stack(nodesX), pads.left, pads.paddedWidth),
			toPaddedCoord(nn, stack(nodesY), pads.top, pads.paddedHeight),
			[1, k, positions * 4, 2],
		),
		weights: stack(weights),
	};
}
