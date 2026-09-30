/**
 * Control-point pose solver: the user taps known features (peaks, notches)
 * in the photo; we solve yaw/pitch/roll (and optionally f) so the features'
 * known directions project onto the tapped pixels.
 */
import { DEG } from "../geodesy";
import {
	azimuthElevation,
	type Camera,
	cameraFromAngles,
	directionENU,
	project,
	unproject,
} from "./camera";
import { levenbergMarquardt } from "./lm";

export interface ControlPoint {
	/** Display pixels at the camera's width/height. */
	x: number;
	y: number;
	/** Degrees clockwise from true north. */
	azimuth: number;
	/** Apparent elevation angle, degrees. */
	elevation: number;
	label?: string;
}

/**
 * A pixel whose elevation angle is known but azimuth is not, e.g. a far
 * lake shore or sea horizon. Constrains pitch/roll (1 equation each).
 */
export interface LevelPoint {
	x: number;
	y: number;
	elevation: number;
	label?: string;
}

export interface ControlPointSolve {
	camera: Camera;
	rmsPx: number;
	residualsPx: number[];
	solvedFocal: boolean;
}

/** Residual used for points that end up behind the camera. */
const BEHIND_PX = 1e5;

/**
 * 1 point: yaw + pitch (roll, f kept). 2 points: yaw, pitch, roll (f kept).
 * ≥3 points: also f (unless solveFocal = false), with a weak Gaussian prior
 * (σ = 10 %) on f from the initial camera. `residualsPx` holds the pixel
 * distance per point, followed by the vertical miss (≈ f·Δelevation, px)
 * of each optional level point; a level point counts as half a point
 * towards unlocking roll / f.
 */
export function solveFromControlPoints(
	initial: Camera,
	points: ControlPoint[],
	opts: {
		solveFocal?: boolean;
		focalSigma?: number;
		levels?: LevelPoint[];
	} = {},
): ControlPointSolve {
	const levels = opts.levels ?? [];
	if (points.length === 0)
		return { camera: initial, rmsPx: 0, residualsPx: [], solvedFocal: false };
	const { width, height } = initial;
	const n = points.length + levels.length / 2;
	const solveRoll = n >= 2;
	const solvedFocal = n >= 3 && (opts.solveFocal ?? true);
	const dirs = points.map((p) => directionENU(p.azimuth, p.elevation));

	const build = (q: number[]) =>
		cameraFromAngles({
			width,
			height,
			yaw: ((q[0] % 360) + 360) % 360,
			pitch: q[1],
			roll: solveRoll ? q[2] : initial.roll,
			f: solvedFocal ? q[3] : initial.f,
		});
	const residuals = (q: number[]) => {
		const cam = build(q);
		const r: number[] = [];
		points.forEach((pt, i) => {
			const p = project(cam, dirs[i]);
			if (!p) r.push(BEHIND_PX, BEHIND_PX);
			else r.push(p[0] - pt.x, p[1] - pt.y);
		});
		for (const l of levels) {
			const [, el] = azimuthElevation(unproject(cam, l.x, l.y));
			r.push(cam.f * (el - l.elevation) * DEG);
		}
		return r;
	};

	const p0 = [initial.yaw, initial.pitch];
	const steps = [1e-5, 1e-5];
	if (solveRoll) {
		p0.push(initial.roll);
		steps.push(1e-5);
	}
	if (solvedFocal) {
		p0.push(initial.f);
		steps.push(initial.f * 1e-6);
	}
	// Prior on f only; angles get effectively-flat priors.
	const prior = solvedFocal
		? {
				mean: p0.map((v) => v),
				sigma: p0.map((_, i) =>
					i === 3
						? initial.f * (opts.focalSigma ?? 0.1)
						: Number.POSITIVE_INFINITY,
				),
			}
		: undefined;

	const res = levenbergMarquardt(residuals, p0, {
		steps,
		maxIterations: 100,
		prior,
	});
	const camera = build(res.params);
	const r = residuals(res.params);
	const residualsPx = [
		...points.map((_, i) => Math.hypot(r[2 * i], r[2 * i + 1])),
		...levels.map((_, i) => Math.abs(r[2 * points.length + i])),
	];
	const rmsPx = Math.sqrt(
		residualsPx.reduce((s, v) => s + v * v, 0) / residualsPx.length,
	);
	return { camera, rmsPx, residualsPx, solvedFocal };
}
