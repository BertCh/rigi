// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// People completion (experiment, research_notes/frontend_completion_models_2026-10.md): a lifted person is a
// front shell only, right from the photo eye and cardboard from the side. This closes each person into a
// volume by silhouette inflation, model-free and instant, so it also serves as the fallback for a learned
// body fit (a keypoint net plus a parametric body model can replace `thickness` later):
//   1. bin the observed splats inside the people mask onto a photo-space grid (front z, colour);
//   2. split the grid into person instances (8-connected components);
//   3. thickness: solve the Poisson problem lap(f) = -2 on each instance (f = 0 outside) in metres; a
//      strip of width 2R gives f = R^2 - x^2, so h = sqrt(f) is a circular cross-section that follows the
//      local width (thin arms, wide torso). h is scaled by `depthRatio` (a body is flatter than round);
//   4. back surface on the same photo ray at z_back = smooth(z_front) + 2h, so the shape is unchanged from
//      the photo eye; side layers close the seam between the front and back sheets at the silhouette rim;
//   5. colour by through-projection (the front splat's colour on the same ray). In the head band the back
//      takes the row's rim colour instead, so the back of a head is hair, not a mirrored face.
// Everything added is `generated` (display-only) and goes through appendCompletionSplats.
import type { Pose } from "../../camera";
import type { IntrinsicsNorm, MaskLike } from "../geom";
import { maskSampler } from "../geom";
import { camToEnuMatrix, toEnu } from "../lift";
import { type GaussianCloud, PROVENANCE_CODE } from "../types";

export type PeopleCompletionOpts = {
	/** Grid columns over the photo width (rows follow the aspect). Default 192. */
	gridWidth?: number;
	/** Depth / width ratio of a body cross-section (1 = round). Default 0.7. */
	depthRatio?: number;
	/** Cap on the half-thickness h in metres. Default 0.2. */
	maxHalfThicknessM?: number;
	/** Instances with fewer grid cells are skipped. Default 40. */
	minCells?: number;
	/** Top fraction of an instance's height treated as the head band. Default 0.14. */
	headBand?: number;
	/** Back colour multiplier (self-shadow). Default 0.82. */
	backShade?: number;
	/** Box-blur radius (cells) of the front depth before it is offset to the back. Default 2. */
	smoothCells?: number;
	/** SOR iterations of the Poisson solve. Default 400. */
	iterations?: number;
	/**
	 * Learned back surface (e.g. a body model fitted to keypoints, src/lib/body): per instance, the back z per
	 * grid cell (camera frame, metres; NaN = keep the inflation value there). Null = inflation only.
	 */
	backDepth?: BackDepthProvider | null;
};

/** What a learned back-surface provider sees of one person instance. */
export type PersonGridInstance = {
	/** Grid cell indices (k = row * gridWidth + col) of the instance. */
	cells: readonly number[];
	gridWidth: number;
	gridHeight: number;
	K: IntrinsicsNorm;
	/** Front z per grid cell (camera frame, metres; NaN where no person; other instances may be set). */
	frontZ: Float32Array;
	/** Inflation back z per grid cell (NaN outside this instance), for blending or fallback. */
	inflatedBackZ: Float32Array;
};

export type BackDepthProvider = (
	instance: PersonGridInstance,
) => Float32Array | null;

export type PeopleCompletionInput = {
	/** The scene's observed cloud in ENU. */
	cloud: GaussianCloud;
	pose: Pose;
	eye: { x: number; y: number; z: number };
	K: IntrinsicsNorm;
	/** Photo aspect (width / height): the grid's row count. */
	aspect: number;
	/** People mask (soft 0..255 or 0/1). Ignored when `select` is given. */
	peopleMask?: MaskLike | null;
	/** Alternative selector of person splats (index, photo u, v, camera z) for callers without a mask. */
	select?: (i: number, u: number, v: number, z: number) => boolean;
};

export type PersonInstance = {
	/** Grid bbox (inclusive) and cell count. */
	bbox: [number, number, number, number];
	cells: number;
	/** Median front z (m, camera frame). */
	medianZ: number;
	/** Max half-thickness (m) after scaling and capping. */
	maxHalfThicknessM: number;
};

export type PeopleCompletionResult = {
	/** Added splats in ENU, all `generated`; empty when nothing qualified. */
	added: GaussianCloud;
	instances: PersonInstance[];
	/**
	 * Observed splat indices (into `cloud`) behind an instance's inferred back surface: edge-ramp strays that
	 * smear a person sideways. The caller may drop them (selectSplats); dropping observed data invents nothing.
	 */
	strays: Uint32Array;
	gridWidth: number;
	gridHeight: number;
};

/** Front z of a grid cell = this percentile of its splats' camera z. */
const FRONT_PERCENTILE = 0.3;
/** Splats within this of the front z give the cell its colour (m). */
const FRONT_BAND_M = 0.08;
/** Observed person splats further than this behind the inferred back surface are dropped (m). */
const STRAY_MARGIN_M = 0.08;

const EMPTY = (): GaussianCloud => ({
	count: 0,
	frame: "enu",
	positions: new Float32Array(0),
	scales: new Float32Array(0),
	rotations: new Float32Array(0),
	colors: new Uint8Array(0),
	provenance: new Uint8Array(0),
});

/** Close each person's front shell into a volume (see the file comment). Pure; the input is not modified. */
export function completePeople(
	input: PeopleCompletionInput,
	opts: PeopleCompletionOpts = {},
): PeopleCompletionResult {
	const GW = Math.max(16, Math.round(opts.gridWidth ?? 192));
	const GH = Math.max(16, Math.round(GW / input.aspect));
	const depthRatio = opts.depthRatio ?? 0.7;
	const maxH = opts.maxHalfThicknessM ?? 0.2;
	const minCells = opts.minCells ?? 40;
	const headBand = opts.headBand ?? 0.14;
	const shade = opts.backShade ?? 0.82;
	const smoothR = Math.max(0, Math.round(opts.smoothCells ?? 2));
	const iterations = opts.iterations ?? 400;
	const { cloud, pose, eye, K } = input;
	const strays: number[] = [];
	const result = (instances: PersonInstance[], added = EMPTY()) => ({
		added,
		instances,
		strays: Uint32Array.from(strays),
		gridWidth: GW,
		gridHeight: GH,
	});

	// 1. bin person splats: camera frame p = M^T (p_enu - eye)
	const m = camToEnuMatrix(pose);
	const inMask = input.select ? null : maskSampler(input.peopleMask);
	if (!input.select && !inMask) return result([]);
	const N = GW * GH;
	const members: number[][] = Array.from({ length: N }, () => []);
	const camZ = new Float32Array(cloud.count).fill(Number.NaN);
	const P = cloud.positions;
	for (let i = 0; i < cloud.count; i++) {
		if (cloud.provenance[i] === PROVENANCE_CODE.generated) continue;
		const dx = P[3 * i] - eye.x;
		const dy = P[3 * i + 1] - eye.y;
		const dz = P[3 * i + 2] - eye.z;
		const x = m[0] * dx + m[3] * dy + m[6] * dz;
		const y = m[1] * dx + m[4] * dy + m[7] * dz;
		const z = m[2] * dx + m[5] * dy + m[8] * dz;
		if (!(z > 0)) continue;
		const u = K.cx + (K.fx * x) / z;
		const v = K.cy + (K.fy * y) / z;
		if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) continue;
		if (input.select ? !input.select(i, u, v, z) : !inMask?.(u, v)) continue;
		members[Math.floor(v * GH) * GW + Math.floor(u * GW)].push(i);
		camZ[i] = z;
	}
	// per cell: the front z is a low percentile (edge-ramp "flying" splats sit behind the person), the colour
	// the mean of the splats within FRONT_BAND of it
	const hits = new Uint32Array(N);
	const zF = new Float32Array(N).fill(Number.NaN);
	const col = new Float32Array(3 * N);
	for (let k = 0; k < N; k++) {
		const idx = members[k];
		if (!idx.length) continue;
		const zs = idx.map((i) => camZ[i]).sort((a, b) => a - b);
		const z0 = zs[Math.floor(FRONT_PERCENTILE * (zs.length - 1))];
		const c = [0, 0, 0];
		let n = 0;
		for (const i of idx) {
			if (Math.abs(camZ[i] - z0) > FRONT_BAND_M) continue;
			for (let t = 0; t < 3; t++) c[t] += cloud.colors[4 * i + t];
			n++;
		}
		if (!n) continue;
		hits[k] = n;
		zF[k] = z0;
		for (let t = 0; t < 3; t++) col[3 * k + t] = c[t] / n;
	}
	// fill one-cell gaps (the lift's stride and dropped edge blocks leave pinholes): a cell with no hit but
	// at least 5 of 8 hit neighbours takes their mean
	const filled = zF.slice();
	for (let j = 1; j < GH - 1; j++)
		for (let i = 1; i < GW - 1; i++) {
			const k = j * GW + i;
			if (hits[k]) continue;
			let n = 0;
			let zs = 0;
			const cs = [0, 0, 0];
			for (let dj = -1; dj <= 1; dj++)
				for (let di = -1; di <= 1; di++) {
					const q = k + dj * GW + di;
					if (q === k || !hits[q]) continue;
					n++;
					zs += zF[q];
					for (let c = 0; c < 3; c++) cs[c] += col[3 * q + c];
				}
			if (n >= 5) {
				filled[k] = zs / n;
				for (let c = 0; c < 3; c++) col[3 * k + c] = cs[c] / n;
			}
		}
	const occ = new Uint8Array(N);
	for (let k = 0; k < N; k++) occ[k] = Number.isFinite(filled[k]) ? 1 : 0;

	// 2. instances
	const label = new Int32Array(N).fill(-1);
	const comps: number[][] = [];
	const stack: number[] = [];
	for (let s = 0; s < N; s++) {
		if (!occ[s] || label[s] >= 0) continue;
		const id = comps.length;
		const cells: number[] = [];
		label[s] = id;
		stack.push(s);
		while (stack.length) {
			const k = stack.pop() as number;
			cells.push(k);
			const i = k % GW;
			const j = (k - i) / GW;
			for (let dj = -1; dj <= 1; dj++)
				for (let di = -1; di <= 1; di++) {
					const ii = i + di;
					const jj = j + dj;
					if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
					const q = jj * GW + ii;
					if (occ[q] && label[q] < 0) {
						label[q] = id;
						stack.push(q);
					}
				}
		}
		comps.push(cells);
	}

	const pos: number[] = [];
	const scl: number[] = [];
	const rot: number[] = [];
	const rgba: number[] = [];
	const instances: PersonInstance[] = [];
	const cellU = 1 / GW;
	const cellV = 1 / GH;
	const ray = (k: number): [number, number] => {
		const i = k % GW;
		const j = (k - i) / GW;
		return [
			((i + 0.5) * cellU - K.cx) / K.fx,
			((j + 0.5) * cellV - K.cy) / K.fy,
		];
	};
	const push = (
		k: number,
		z: number,
		s: number,
		n: [number, number, number],
		c: [number, number, number],
		flat: number,
	) => {
		const [rx, ry] = ray(k);
		pos.push(rx * z, ry * z, z);
		scl.push(s, s, s * flat);
		rot.push(...quatFromZ(n[0], n[1], n[2]));
		rgba.push(clampByte(c[0]), clampByte(c[1]), clampByte(c[2]), 255);
	};

	for (const cells of comps) {
		if (cells.length < minCells) continue;
		const zs = cells.map((k) => filled[k]).sort((a, b) => a - b);
		const medZ = zs[zs.length >> 1];
		// metres per cell at the instance's depth (x and y differ by the pixel aspect; use the mean)
		const sx = (cellU / K.fx) * medZ;
		const sy = (cellV / K.fy) * medZ;
		const sM = 0.5 * (sx + sy);
		let i0 = GW;
		let j0 = GH;
		let i1 = 0;
		let j1 = 0;
		for (const k of cells) {
			const i = k % GW;
			const j = (k - i) / GW;
			i0 = Math.min(i0, i);
			i1 = Math.max(i1, i);
			j0 = Math.min(j0, j);
			j1 = Math.max(j1, j);
		}
		const id = label[cells[0]];
		const inside = (k: number) => label[k] === id;

		// 3. Poisson inflation, SOR on the instance cells (Dirichlet 0 outside)
		const f = new Float64Array(N);
		const rhs = 2 * sM * sM;
		const omega = 1.9;
		for (let it = 0; it < iterations; it++)
			for (const k of cells) {
				const i = k % GW;
				const j = (k - i) / GW;
				// the photo frame is a cut through the body, not its outline: mirror (Neumann) there
				const fl = i === 0 ? f[k] : inside(k - 1) ? f[k - 1] : 0;
				const fr = i === GW - 1 ? f[k] : inside(k + 1) ? f[k + 1] : 0;
				const fu = j === 0 ? f[k] : inside(k - GW) ? f[k - GW] : 0;
				const fd = j === GH - 1 ? f[k] : inside(k + GW) ? f[k + GW] : 0;
				const g = (fl + fr + fu + fd + rhs) / 4;
				f[k] += omega * (g - f[k]);
			}
		const h = new Float32Array(N);
		let hMax = 0;
		for (const k of cells) {
			h[k] = Math.min(maxH, depthRatio * Math.sqrt(Math.max(0, f[k])));
			hMax = Math.max(hMax, h[k]);
		}

		// 4. back depth = box-blurred front depth (inside the instance) + 2h
		const zBack = new Float32Array(N).fill(Number.NaN);
		for (const k of cells) {
			const i = k % GW;
			const j = (k - i) / GW;
			let acc = 0;
			let n = 0;
			for (let dj = -smoothR; dj <= smoothR; dj++)
				for (let di = -smoothR; di <= smoothR; di++) {
					const ii = i + di;
					const jj = j + dj;
					if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
					const q = jj * GW + ii;
					if (!inside(q)) continue;
					acc += filled[q];
					n++;
				}
			zBack[k] = acc / n + 2 * h[k];
		}

		if (opts.backDepth) {
			const learned = opts.backDepth({
				cells,
				gridWidth: GW,
				gridHeight: GH,
				K,
				frontZ: filled,
				inflatedBackZ: zBack,
			});
			// a learned back never comes in front of the observed front
			if (learned)
				for (const k of cells)
					if (Number.isFinite(learned[k]))
						zBack[k] = Math.max(learned[k], filled[k] + 0.02);
		}
		for (const k of cells)
			for (const i of members[k])
				if (camZ[i] > zBack[k] + STRAY_MARGIN_M) strays.push(i);

		// 5. head band rim colour: per row, the mean of the two outermost cells on each side
		const headRows = Math.max(1, Math.round(headBand * (j1 - j0 + 1)));
		const rimColour = new Map<number, [number, number, number]>();
		for (let j = j0; j < j0 + headRows; j++) {
			const row: number[] = [];
			for (let i = i0; i <= i1; i++)
				if (inside(j * GW + i)) row.push(j * GW + i);
			if (row.length < 3) continue;
			const pick = [row[0], row[1], row[row.length - 2], row[row.length - 1]];
			const c: [number, number, number] = [0, 0, 0];
			for (const q of pick)
				for (let t = 0; t < 3; t++) c[t] += col[3 * q + t] / 4;
			rimColour.set(j, c);
		}

		for (const k of cells) {
			const i = k % GW;
			const j = (k - i) / GW;
			const zb = zBack[k];
			// back normal: away from the camera, tilted by the back surface's slope (camera frame, metres)
			const gx =
				((inside(k + 1) ? zBack[k + 1] : zb) -
					(inside(k - 1) ? zBack[k - 1] : zb)) /
				(2 * sx);
			const gy =
				((inside(k + GW) ? zBack[k + GW] : zb) -
					(inside(k - GW) ? zBack[k - GW] : zb)) /
				(2 * sy);
			const n = normalise([-gx, -gy, 1]);
			const front: [number, number, number] = [
				col[3 * k],
				col[3 * k + 1],
				col[3 * k + 2],
			];
			const base = rimColour.get(j) ?? front;
			const c: [number, number, number] = [
				base[0] * shade,
				base[1] * shade,
				base[2] * shade,
			];
			const footprint = 0.7 * sM * (zb / medZ);
			const tilt = Math.min(2, 1 / Math.max(0.35, Math.abs(n[2])));
			push(k, zb, footprint * Math.sqrt(tilt), n, c, 0.2);

			// side seam: at rim cells, layers between the front and back sheets facing outwards in the image
			// plane (away from the instance)
			let ox = 0;
			let oy = 0;
			for (const [di, dj] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const ii = i + di;
				const jj = j + dj;
				// no seam towards the photo frame (the body continues out of the picture)
				if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue;
				if (!inside(jj * GW + ii)) {
					ox += di;
					oy += dj;
				}
			}
			if (ox === 0 && oy === 0) continue;
			const zf = filled[k];
			const gap = zb - zf;
			const step = 0.8 * footprint;
			const layers = Math.floor(gap / step);
			if (layers < 1) continue;
			const sideN = normalise([ox, oy, 0]);
			for (let l = 1; l <= layers; l++) {
				const t = l / (layers + 1);
				// the seam darkens towards the back, matching the back shade
				const g = 1 - (1 - shade) * t;
				push(
					k,
					zf + t * gap,
					footprint,
					sideN,
					[front[0] * g, front[1] * g, front[2] * g],
					0.3,
				);
			}
		}
		instances.push({
			bbox: [i0, j0, i1, j1],
			cells: cells.length,
			medianZ: medZ,
			maxHalfThicknessM: hMax,
		});
	}

	const count = pos.length / 3;
	if (!count) return result(instances);
	const cam: GaussianCloud = {
		count,
		frame: "camera",
		positions: Float32Array.from(pos),
		scales: Float32Array.from(scl),
		rotations: Float32Array.from(rot),
		colors: Uint8Array.from(rgba),
		provenance: new Uint8Array(count).fill(PROVENANCE_CODE.generated),
	};
	return result(instances, toEnu(cam, pose, eye));
}

function clampByte(x: number): number {
	return Math.max(0, Math.min(255, Math.round(x)));
}

function normalise(v: [number, number, number]): [number, number, number] {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

/** Shortest-arc unit quaternion (w,x,y,z) rotating +z onto the unit vector (x,y,z) (as lift.ts). */
function quatFromZ(
	x: number,
	y: number,
	z: number,
): [number, number, number, number] {
	if (z < -0.999999) return [0, 1, 0, 0];
	const w = 1 + z;
	const l = Math.hypot(w, y, x);
	return [w / l, -y / l, x / l, 0];
}
