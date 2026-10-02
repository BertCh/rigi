// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Fit a rigged body (./anny.ts) to one person: 2D keypoints (./vitpose.ts) under the photo intrinsics, plus — when
// the people grid of src/lib/nearfield/complete/people.ts is given — the observed front depth and the silhouette.
// Damped Gauss-Newton (Levenberg–Marquardt) on finite-difference Jacobians, all CPU, tens to a few hundred ms.
//
// Unknowns: global rotation ω (axis-angle in the camera frame, applied after FACING_CAMERA), translation t (m), log s, the
// shape β (Anny phenotype offsets from the adult base) and an axis-angle per articulated joint (rest axes).
// Residuals (each divided by its σ):
//   keypoints  ray-angle error (x/z, y/z) of every confident keypoint inside the photo frame, σ = keypointSigmaM at the
//              body's depth. Keypoints below `minScore` or within `edgeMargin` of the frame are absent: a body cut by
//              the frame (legs below the picture) is never dragged into view; its hidden parts follow the pose prior.
//   depth      visible mesh vertices (z-buffer on the grid) against the observed front z of their cell, robust
//              (Cauchy, IRLS), on the instance eroded by one cell (edge-ramp depth is unreliable). This anchors the
//              placement. With depthScale "metric" it also fixes the body's size (stronger than the stature prior);
//              with "free" (default) a scene scale s is solved too: the body keeps its prior size and the mesh is
//              scaled by s about the camera centre, which leaves every projection unchanged (monocular near-field
//              depth is often off in scale while its shape is fine).
//   silhouette every vertex that projects inside the photo but outside the instance, by its chamfer distance (cells)
//   priors     stature (statureM ± statureSigmaM), β, per-joint angles (hinge model for knees and elbows with a
//              one-sided flexion limit), torso upright in the camera (the photo is levelled).
// Two stages: A (keypoints + a torso-depth anchor, rigid β = 0) from a few yaw starts (the person may face away),
// the best start then B (everything, β free).
import type { IntrinsicsNorm } from "#/lib/nearfield/geom";
import {
	applyShape,
	type BodyModel,
	forwardKinematics,
	rotationFromAxisAngle,
	skinPoints,
} from "./anny";
import { rasterDepthRange } from "./raster";

/** Body (Anny: x left, y back, z up) → camera (x right, y down, z forward) for an upright person facing the camera. */
export const FACING_CAMERA: readonly number[] = [1, 0, 0, 0, 0, -1, 0, 1, 0];

/** COCO-17 keypoints (photo-normalised) with confidences. */
export type Keypoints2D = {
	u: ArrayLike<number>;
	v: ArrayLike<number>;
	score: ArrayLike<number>;
};

/** The person's cells on people.ts' grid (PersonGridInstance without the inflation). */
export type GridObservation = {
	gridWidth: number;
	gridHeight: number;
	cells: readonly number[];
	/** front z per cell (camera frame, m); NaN where unknown */
	frontZ: Float32Array;
};

export type BodyFitOptions = {
	/** Expected standing height (m). Default 1.70. */
	statureM?: number;
	statureSigmaM?: number;
	/** Keypoints below this confidence are ignored. Default 0.3. */
	minScore?: number;
	/** Keypoints closer than this to the photo frame (normalised) are ignored. Default 0.01. */
	edgeMargin?: number;
	/** Keypoint σ in metres at the body. Default 0.03. */
	keypointSigmaM?: number;
	/** Depth σ (m) and the Cauchy scale of its robust weight. Defaults 0.03, 0.06. */
	depthSigmaM?: number;
	depthRobustM?: number;
	/** Total weight of the depth term in keypoint units. Default 12. */
	depthWeight?: number;
	/** Silhouette σ (cells) and total weight. Defaults 1.5, 6. */
	silhouetteSigmaCells?: number;
	silhouetteWeight?: number;
	/** β prior σ per shape (phenotype units). Default 0.35. */
	shapeSigma?: number;
	/** Initial yaws (rad) about the camera's vertical. Default [0, π]. */
	yawStarts?: readonly number[];
	/** LM iterations of stage A per start and of stage B. Defaults 25, 30. */
	iterationsA?: number;
	iterationsB?: number;
	/** Initial distance when no grid is given (m). */
	initialDepthM?: number;
	/**
	 * "free" (default): the observed depth fixes placement and the relative depth, up to one scene scale factor; the
	 * body's metric size comes from the stature prior, and the mesh is scaled about the camera centre into the scene
	 * (projection-invariant), so a near field whose depth scale is off by 30 % still gets human proportions and a
	 * back surface consistent with its own splats. "metric": the depth is trusted as metres, the body grows or shrinks
	 * to match it (the stature prior is then outweighed).
	 */
	depthScale?: "free" | "metric";
};

export type BodyFit = {
	beta: Float64Array;
	/** axis-angle per joint [J · 3] (joint 0 unused: the global rotation is `rotation`) */
	pose: Float64Array;
	/** body → camera, row-major 3 × 3 */
	rotation: Float64Array;
	/** scene-frame translation of the body origin (scene units = sceneScale × body metres) */
	translation: [number, number, number];
	/** scene units per body metre: how far the observed depth is from the body's metric size (1 in metric mode) */
	sceneScale: number;
	/** posed mesh in the camera (scene) frame [V · 3] */
	vertices: Float64Array;
	/** posed keypoints in the camera (scene) frame [K · 3] */
	keypoints: Float64Array;
	/** which input keypoints took part */
	used: boolean[];
	/** standing height of the fitted shape (body metres; × sceneScale in the scene) */
	stature: number;
	/** final cost (½ Σ r²) of stage B */
	cost: number;
	keypointRms: number;
	/** the yaw start (rad) the fit came from */
	yawStart: number;
	iterations: number;
};

const KEYPOINT_WEIGHT = [
	0.6, 0.5, 0.5, 0.35, 0.35, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];
/** shoulders and hips: the torso depth anchor of stage A */
const TORSO = [5, 6, 11, 12];

type JointPrior = {
	sigma: number;
	/** hinge axis (rest frame) of a knee / elbow: flexion is the component along it */
	hinge?: [number, number, number];
	flexSigma?: number;
};

function jointPriors(model: BodyModel): JointPrior[] {
	const J = model.jointCount;
	const name = (j: number) => model.jointNames[j] ?? "";
	const jp = (j: number): [number, number, number] => [
		model.joints[3 * j],
		model.joints[3 * j + 1],
		model.joints[3 * j + 2],
	];
	const out: JointPrior[] = [];
	for (let j = 0; j < J; j++) {
		const n = name(j);
		if (n.startsWith("lowerleg")) {
			// knee: flexion about +x moves the shin backwards (+y)
			out.push({ sigma: 0.15, hinge: [1, 0, 0], flexSigma: 1.2 });
		} else if (n.startsWith("lowerarm")) {
			// elbow: hinge ⟂ upper arm and the forward direction (−y); positive flexion brings the forearm forward
			const p = model.parents[j];
			const a = jp(p);
			const b = jp(j);
			const d = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
			// d × (0, −1, 0)
			const h = norm3([d[2], 0, -d[0]]);
			out.push({ sigma: 0.3, hinge: h, flexSigma: 1.5 });
		} else if (n.startsWith("upperleg")) out.push({ sigma: 0.6 });
		else if (n.startsWith("upperarm")) out.push({ sigma: 0.9 });
		else if (n.startsWith("spine")) out.push({ sigma: 0.25 });
		else if (n === "neck01" || n === "head") out.push({ sigma: 0.35 });
		else out.push({ sigma: 0.3 });
	}
	return out;
}

type Ctx = {
	model: BodyModel;
	K: IntrinsicsNorm;
	S: number;
	J: number;
	nParams: number;
	active: Uint8Array;
	priors: JointPrior[];
	kp: { k: number; x: number; y: number; w: number }[];
	kpSigma: number;
	statureM: number;
	statureSigma: number;
	shapeSigma: number;
	torsoDepth: number | null;
	stageB: boolean;
	// stage B, frozen per iteration
	depthIdx: Int32Array;
	depthTarget: Float64Array;
	depthW: Float64Array;
	depthSigma: number;
	silDist: Float32Array | null;
	silScale: number;
	silSigma: number;
	grid: GridObservation | null;
};

const P_T = 3;
/** log of the scene scale (free depth scale only) */
const P_SCALE = 6;
const P_BETA = 7;

function poseIndex(ctx: { S: number }, j: number) {
	return P_BETA + ctx.S + 3 * (j - 1);
}

type Eval = {
	R: Float64Array;
	t: [number, number, number];
	beta: Float64Array;
	pose: Float64Array;
	kpCam: Float64Array;
	vCam: Float64Array | null;
	stature: number;
	/** scene units per body metre (1 in metric mode) */
	scale: number;
};

function evaluate(ctx: Ctx, p: Float64Array, withVertices: boolean): Eval {
	const { model, S, J } = ctx;
	const Rw = rotationFromAxisAngle(p[0], p[1], p[2]);
	const R = mul3(Rw, FACING_CAMERA);
	const t: [number, number, number] = [p[P_T], p[P_T + 1], p[P_T + 2]];
	const beta = p.slice(P_BETA, P_BETA + S);
	const pose = new Float64Array(3 * J);
	for (let j = 1; j < J; j++)
		for (let c = 0; c < 3; c++) pose[3 * j + c] = p[poseIndex(ctx, j) + c];
	const restJ = applyShape(model.joints, model.shapeJoints, beta);
	const fk = forwardKinematics(model, restJ, pose);
	const restK = applyShape(model.keypoints, model.shapeKeypoints, beta);
	const kpB = skinPoints(
		restK,
		model.keypointIndex,
		model.keypointWeight,
		model.influences,
		fk.skin,
	);
	const kpCam = toCamera(kpB, R, t);
	let vCam: Float64Array | null = null;
	if (withVertices) {
		const restV = applyShape(model.vertices, model.shapeVertices, beta);
		vCam = toCamera(
			skinPoints(
				restV,
				model.skinIndex,
				model.skinWeight,
				model.influences,
				fk.skin,
			),
			R,
			t,
		);
	}
	let stature = model.stature;
	for (let s = 0; s < S; s++) stature += beta[s] * (model.shapeStature[s] ?? 0);
	return {
		R,
		t,
		beta,
		pose,
		kpCam,
		vCam,
		stature,
		scale: Math.exp(p[P_SCALE]),
	};
}

function residuals(ctx: Ctx, p: Float64Array, out: number[]): number {
	out.length = 0;
	const e = evaluate(ctx, p, ctx.stageB);
	const { K } = ctx;
	// keypoints: ray-angle error
	let kpCost = 0;
	for (const o of ctx.kp) {
		const X = e.kpCam[3 * o.k];
		const Y = e.kpCam[3 * o.k + 1];
		const Z = Math.max(0.05, e.kpCam[3 * o.k + 2]);
		const s = Math.sqrt(o.w) / ctx.kpSigma;
		const rx = (X / Z - o.x) * s;
		const ry = (Y / Z - o.y) * s;
		out.push(rx, ry);
		kpCost += rx * rx + ry * ry;
	}
	// stage A depth anchor: the torso keypoints sit ~9 cm behind the observed front
	if (!ctx.stageB && ctx.torsoDepth !== null) {
		let z = 0;
		for (const k of TORSO) z += e.kpCam[3 * k + 2] / TORSO.length;
		out.push((e.scale * (z + 0.09) - ctx.torsoDepth) / 0.05);
	}
	// stature and shape priors
	if (ctx.S > 0 && ctx.active[P_BETA]) {
		out.push((e.stature - ctx.statureM) / ctx.statureSigma);
		for (let s = 0; s < ctx.S; s++) out.push(e.beta[s] / ctx.shapeSigma);
	}
	// joint priors
	for (let j = 1; j < ctx.J; j++) {
		const pr = ctx.priors[j];
		const x = e.pose[3 * j];
		const y = e.pose[3 * j + 1];
		const z = e.pose[3 * j + 2];
		if (pr.hinge) {
			const [hx, hy, hz] = pr.hinge;
			const flex = x * hx + y * hy + z * hz;
			out.push(
				(x - flex * hx) / pr.sigma,
				(y - flex * hy) / pr.sigma,
				(z - flex * hz) / pr.sigma,
				flex / (pr.flexSigma ?? 1),
				Math.min(0, flex + 0.05) / 0.03,
			);
		} else out.push(x / pr.sigma, y / pr.sigma, z / pr.sigma);
	}
	// upright: the body's up axis (column 2 of R) close to the camera's −y
	out.push(e.R[2] / 0.3, e.R[8] / 0.6);
	if (ctx.stageB && e.vCam) {
		const v = e.vCam;
		const n = ctx.depthIdx.length;
		for (let i = 0; i < n; i++) {
			const z = e.scale * v[3 * ctx.depthIdx[i] + 2];
			out.push(((z - ctx.depthTarget[i]) * ctx.depthW[i]) / ctx.depthSigma);
		}
		const g = ctx.grid;
		if (g && ctx.silDist) {
			const V = v.length / 3;
			for (let i = 0; i < V; i++) {
				const Z = v[3 * i + 2];
				if (!(Z > 0.05)) {
					out.push(0);
					continue;
				}
				const gx = (K.cx + (K.fx * v[3 * i]) / Z) * g.gridWidth - 0.5;
				const gy = (K.cy + (K.fy * v[3 * i + 1]) / Z) * g.gridHeight - 0.5;
				const d = sampleBilinear(
					ctx.silDist,
					g.gridWidth,
					g.gridHeight,
					gx,
					gy,
				);
				out.push((Math.max(0, d - 0.5) * ctx.silScale) / ctx.silSigma);
			}
		}
	}
	return kpCost;
}

function cost(r: number[]): number {
	let c = 0;
	for (const x of r) c += x * x;
	return 0.5 * c;
}

/** Freeze the stage-B data terms for the current parameters: visible vertices, their targets, IRLS weights. */
function refreshStageB(
	ctx: Ctx,
	p: Float64Array,
	o: Required<Pick<BodyFitOptions, "depthWeight" | "depthRobustM">>,
	eroded: Uint8Array | null,
) {
	const g = ctx.grid;
	if (!g || !eroded) {
		ctx.depthIdx = new Int32Array(0);
		return;
	}
	const e = evaluate(ctx, p, true);
	const v = e.vCam as Float64Array;
	const { K } = ctx;
	const range = rasterDepthRange(
		v,
		ctx.model.faces,
		K,
		g.gridWidth,
		g.gridHeight,
	);
	const idx: number[] = [];
	const tgt: number[] = [];
	const res: number[] = [];
	const V = v.length / 3;
	for (let i = 0; i < V; i++) {
		const Z = v[3 * i + 2];
		if (!(Z > 0.05)) continue;
		const ci = Math.round((K.cx + (K.fx * v[3 * i]) / Z) * g.gridWidth - 0.5);
		const cj = Math.round(
			(K.cy + (K.fy * v[3 * i + 1]) / Z) * g.gridHeight - 0.5,
		);
		if (ci < 0 || cj < 0 || ci >= g.gridWidth || cj >= g.gridHeight) continue;
		const k = cj * g.gridWidth + ci;
		if (!eroded[k] || !Number.isFinite(g.frontZ[k])) continue;
		// visible: within 3 cm of the mesh's nearest surface on that ray
		if (!(Z <= range.near[k] + 0.03)) continue;
		idx.push(i);
		tgt.push(g.frontZ[k]);
		res.push(e.scale * Z - g.frontZ[k]);
	}
	const n = idx.length;
	ctx.depthIdx = Int32Array.from(idx);
	ctx.depthTarget = Float64Array.from(tgt);
	ctx.depthW = new Float64Array(n);
	const scale = n ? Math.sqrt(o.depthWeight / n) : 0;
	for (let i = 0; i < n; i++) {
		const u = res[i] / o.depthRobustM;
		ctx.depthW[i] = scale / Math.sqrt(1 + u * u);
	}
}

/** LM on the active parameters with the context frozen. Returns the final cost. */
function levenbergMarquardt(
	ctx: Ctx,
	p: Float64Array,
	iterations: number,
	refresh?: () => void,
): { cost: number; iterations: number } {
	const act: number[] = [];
	for (let i = 0; i < ctx.nParams; i++) if (ctx.active[i]) act.push(i);
	const n = act.length;
	let lambda = 1e-2;
	const r0: number[] = [];
	const r1: number[] = [];
	let it = 0;
	let c0 = 0;
	for (; it < iterations; it++) {
		refresh?.();
		residuals(ctx, p, r0);
		c0 = cost(r0);
		const m = r0.length;
		// forward-difference Jacobian [m × n]
		const Jm = new Float64Array(m * n);
		for (let a = 0; a < n; a++) {
			const i = act[a];
			const h = 1e-4;
			const keep = p[i];
			p[i] = keep + h;
			residuals(ctx, p, r1);
			p[i] = keep;
			for (let q = 0; q < m; q++) Jm[q * n + a] = (r1[q] - r0[q]) / h;
		}
		const A = new Float64Array(n * n);
		const g = new Float64Array(n);
		for (let q = 0; q < m; q++) {
			const row = q * n;
			const rq = r0[q];
			for (let a = 0; a < n; a++) {
				const ja = Jm[row + a];
				if (ja === 0) continue;
				g[a] += ja * rq;
				for (let b = a; b < n; b++) A[a * n + b] += ja * Jm[row + b];
			}
		}
		for (let a = 0; a < n; a++)
			for (let b = 0; b < a; b++) A[a * n + b] = A[b * n + a];
		let improved = false;
		for (let tries = 0; tries < 6; tries++) {
			const M = A.slice();
			for (let a = 0; a < n; a++)
				M[a * n + a] += lambda * (A[a * n + a] + 1e-6);
			const d = solveSpd(M, g, n);
			if (!d) {
				lambda *= 10;
				continue;
			}
			const trial = p.slice();
			for (let a = 0; a < n; a++) trial[act[a]] -= d[a];
			residuals(ctx, trial, r1);
			const c1 = cost(r1);
			if (c1 < c0) {
				p.set(trial);
				lambda = Math.max(1e-7, lambda / 3);
				improved = c0 - c1 > 1e-7 * c0;
				c0 = c1;
				break;
			}
			lambda *= 4;
		}
		if (!improved) break;
	}
	return { cost: c0, iterations: it };
}

/**
 * Fit the body to one person. `keypoints` are photo-normalised COCO-17; `grid` (optional) adds the depth and
 * silhouette terms. Null when fewer than 4 keypoints are usable.
 */
export function fitBody(
	model: BodyModel,
	K: IntrinsicsNorm,
	keypoints: Keypoints2D,
	grid: GridObservation | null = null,
	options: BodyFitOptions = {},
): BodyFit | null {
	const o = {
		statureM: options.statureM ?? 1.7,
		statureSigmaM: options.statureSigmaM ?? 0.1,
		minScore: options.minScore ?? 0.3,
		edgeMargin: options.edgeMargin ?? 0.01,
		keypointSigmaM: options.keypointSigmaM ?? 0.03,
		depthSigmaM: options.depthSigmaM ?? 0.03,
		depthRobustM: options.depthRobustM ?? 0.06,
		depthWeight: options.depthWeight ?? 12,
		silhouetteSigmaCells: options.silhouetteSigmaCells ?? 1.5,
		silhouetteWeight: options.silhouetteWeight ?? 6,
		shapeSigma: options.shapeSigma ?? 0.35,
		yawStarts: options.yawStarts ?? [0, Math.PI],
		iterationsA: options.iterationsA ?? 25,
		iterationsB: options.iterationsB ?? 30,
		depthScale: options.depthScale ?? "free",
	};
	const S = model.shapeStature.length;
	const J = model.jointCount;
	const nParams = P_BETA + S + 3 * (J - 1);
	// usable keypoints → normalised rays
	const used: boolean[] = [];
	const kp: Ctx["kp"] = [];
	const nk = Math.min(model.keypointCount, keypoints.u.length);
	for (let k = 0; k < nk; k++) {
		const u = keypoints.u[k];
		const v = keypoints.v[k];
		const ok =
			keypoints.score[k] >= o.minScore &&
			u > o.edgeMargin &&
			u < 1 - o.edgeMargin &&
			v > o.edgeMargin &&
			v < 1 - o.edgeMargin;
		used.push(ok);
		if (ok)
			kp.push({
				k,
				x: (u - K.cx) / K.fx,
				y: (v - K.cy) / K.fy,
				w: (KEYPOINT_WEIGHT[k] ?? 1) * Math.min(1, keypoints.score[k]),
			});
	}
	if (kp.length < 4) return null;

	// observed depth: median front z of the instance
	let medianZ = options.initialDepthM ?? Number.NaN;
	let eroded: Uint8Array | null = null;
	let silDist: Float32Array | null = null;
	if (grid) {
		const zs = grid.cells
			.map((k) => grid.frontZ[k])
			.filter((z) => Number.isFinite(z))
			.sort((a, b) => a - b);
		if (zs.length) medianZ = zs[zs.length >> 1];
		const inside = new Uint8Array(grid.gridWidth * grid.gridHeight);
		for (const k of grid.cells) inside[k] = 1;
		eroded = erode(inside, grid.gridWidth, grid.gridHeight);
		silDist = chamfer(inside, grid.gridWidth, grid.gridHeight);
	}
	if (!Number.isFinite(medianZ)) medianZ = 3;

	// torso (or all keypoints) centre ray, and the body's own distance from its torso length: shoulder-hip ≈ 0.29 ×
	// stature for the mid-shoulder to mid-hip keypoints
	let cu = 0;
	let cv = 0;
	let cn = 0;
	for (const q of kp)
		if (TORSO.includes(q.k)) {
			cu += q.x;
			cv += q.y;
			cn++;
		}
	if (!cn)
		for (const q of kp) {
			cu += q.x;
			cv += q.y;
			cn++;
		}
	cu /= cn;
	cv /= cn;
	const ray = (k: number) => kp.find((q) => q.k === k);
	const [ls, rs, lh, rh] = TORSO.map(ray);
	const free = o.depthScale === "free" && grid !== null;
	let zBody = medianZ + 0.12;
	if (free && ls && rs && lh && rh) {
		const torso = Math.hypot(
			(ls.x + rs.x - lh.x - rh.x) / 2,
			(ls.y + rs.y - lh.y - rh.y) / 2,
		);
		if (torso > 1e-3) zBody = (0.29 * o.statureM) / torso;
	}

	const ctx: Ctx = {
		model,
		K,
		S,
		J,
		nParams,
		active: new Uint8Array(nParams),
		priors: jointPriors(model),
		kp,
		kpSigma: o.keypointSigmaM / zBody,
		statureM: o.statureM,
		statureSigma: o.statureSigmaM,
		shapeSigma: o.shapeSigma,
		torsoDepth: grid ? medianZ : null,
		stageB: false,
		depthIdx: new Int32Array(0),
		depthTarget: new Float64Array(0),
		depthW: new Float64Array(0),
		depthSigma: o.depthSigmaM,
		silDist,
		silScale: grid ? Math.sqrt(o.silhouetteWeight / model.vertexCount) : 0,
		silSigma: o.silhouetteSigmaCells,
		grid,
	};

	const z0 = zBody;
	// the scene scale is a parameter only when the depth scale is free
	const setActive = (stage: "A" | "rigid" | "B") => {
		ctx.active.fill(1);
		if (stage !== "B") ctx.active.fill(0, P_BETA, P_BETA + S);
		if (stage === "rigid") ctx.active.fill(0, P_BETA);
		if (!free) ctx.active[P_SCALE] = 0;
	};

	let best: { p: Float64Array; cost: number; yaw: number } | null = null;
	for (const yaw of o.yawStarts) {
		const p = new Float64Array(nParams);
		p[1] = yaw;
		const R = mul3(rotationFromAxisAngle(0, yaw, 0), FACING_CAMERA);
		// torso centre ≈ 0.22 m above the root in the body frame
		p[P_T] = cu * z0 - R[2] * 0.22;
		p[P_T + 1] = cv * z0 - R[5] * 0.22;
		p[P_T + 2] = z0 - R[8] * 0.22;
		p[P_SCALE] = free ? Math.log((medianZ + 0.12) / z0) : 0;
		ctx.stageB = false;
		// rigid first (rotation, translation, scene scale), then the joints
		setActive("rigid");
		levenbergMarquardt(ctx, p, 8);
		setActive("A");
		const r = levenbergMarquardt(ctx, p, o.iterationsA);
		if (!best || r.cost < best.cost) best = { p, cost: r.cost, yaw };
	}
	if (!best) return null;
	const p = best.p;
	setActive("B");
	ctx.stageB = true;
	const fin = levenbergMarquardt(ctx, p, o.iterationsB, () =>
		refreshStageB(ctx, p, o, eroded),
	);
	const e = evaluate(ctx, p, true);
	const rk: number[] = [];
	const kpCost = residuals(ctx, p, rk);
	const scaled = (a: Float64Array) => a.map((x) => x * e.scale);
	return {
		beta: e.beta,
		pose: e.pose,
		rotation: e.R,
		translation: [e.t[0] * e.scale, e.t[1] * e.scale, e.t[2] * e.scale],
		sceneScale: e.scale,
		vertices: scaled(e.vCam as Float64Array),
		keypoints: scaled(e.kpCam),
		used,
		stature: e.stature,
		cost: fin.cost,
		// in body metres
		keypointRms:
			Math.sqrt(kpCost / Math.max(1, 2 * kp.length)) * o.keypointSigmaM,
		yawStart: best.yaw,
		iterations: fin.iterations,
	};
}

// ---------------- small helpers ----------------

function mul3(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
	const o = new Float64Array(9);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			o[3 * r + c] =
				a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
	return o;
}

function toCamera(
	p: Float64Array,
	R: ArrayLike<number>,
	t: readonly number[],
): Float64Array {
	const n = p.length / 3;
	const o = new Float64Array(p.length);
	for (let i = 0; i < n; i++) {
		const x = p[3 * i];
		const y = p[3 * i + 1];
		const z = p[3 * i + 2];
		o[3 * i] = R[0] * x + R[1] * y + R[2] * z + t[0];
		o[3 * i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
		o[3 * i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
	}
	return o;
}

function norm3(v: [number, number, number]): [number, number, number] {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}

/** Cholesky solve of a symmetric positive definite n × n system; null if not SPD. */
export function solveSpd(
	A: Float64Array,
	b: Float64Array,
	n: number,
): Float64Array | null {
	const L = new Float64Array(n * n);
	for (let i = 0; i < n; i++)
		for (let j = 0; j <= i; j++) {
			let s = A[i * n + j];
			for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
			if (i === j) {
				if (!(s > 0)) return null;
				L[i * n + i] = Math.sqrt(s);
			} else L[i * n + j] = s / L[j * n + j];
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

/** 4-neighbour erosion (cells on the photo frame keep their value: the frame is a cut, not an outline). */
function erode(m: Uint8Array, W: number, H: number): Uint8Array {
	const o = new Uint8Array(m.length);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			if (!m[k]) continue;
			const l = i === 0 || m[k - 1];
			const r = i === W - 1 || m[k + 1];
			const u = j === 0 || m[k - W];
			const d = j === H - 1 || m[k + W];
			o[k] = l && r && u && d ? 1 : 0;
		}
	return o;
}

/** Chamfer (3-4) distance in cells to the nearest set cell; 0 inside. */
export function chamfer(m: Uint8Array, W: number, H: number): Float32Array {
	const BIG = 1e9;
	const d = new Float32Array(m.length);
	for (let k = 0; k < m.length; k++) d[k] = m[k] ? 0 : BIG;
	const relax = (k: number, q: number, w: number) => {
		if (d[q] + w < d[k]) d[k] = d[q] + w;
	};
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			if (i > 0) relax(k, k - 1, 3);
			if (j > 0) {
				relax(k, k - W, 3);
				if (i > 0) relax(k, k - W - 1, 4);
				if (i < W - 1) relax(k, k - W + 1, 4);
			}
		}
	for (let j = H - 1; j >= 0; j--)
		for (let i = W - 1; i >= 0; i--) {
			const k = j * W + i;
			if (i < W - 1) relax(k, k + 1, 3);
			if (j < H - 1) {
				relax(k, k + W, 3);
				if (i < W - 1) relax(k, k + W + 1, 4);
				if (i > 0) relax(k, k + W - 1, 4);
			}
		}
	for (let k = 0; k < d.length; k++) d[k] = d[k] >= BIG ? 1e4 : d[k] / 3;
	return d;
}

/** Bilinear sample of a W × H grid at cell coordinates (centres on integers); 0 outside the grid. */
function sampleBilinear(
	g: Float32Array,
	W: number,
	H: number,
	x: number,
	y: number,
): number {
	if (!(x >= 0 && y >= 0 && x <= W - 1 && y <= H - 1)) return 0;
	const x0 = Math.min(W - 2, Math.floor(x));
	const y0 = Math.min(H - 2, Math.floor(y));
	const tx = x - x0;
	const ty = y - y0;
	const k = y0 * W + x0;
	return (
		(1 - ty) * ((1 - tx) * g[k] + tx * g[k + 1]) +
		ty * ((1 - tx) * g[k + W] + tx * g[k + W + 1])
	);
}
