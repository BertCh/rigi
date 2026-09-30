// GA1 MAP solve: priors + image factors, outer re-linearisation of eye-dependent predictors, Laplace
// covariance at the solution (reports/geometry-first-pose.md G3; plan §1 map/solve.ts).
//
// Outer loop (as the removed concord/solve/joint.ts): every factor with `relinearize` rebuilds its eye-dependent
// predictor (horizons at eye ± δ, junctions, lake cues) at the current x; the inner LM solves the
// linearised problem; stop when the eye moves less than relinM (or maxOuter). Unlike joint.ts there is
// no proximal prior on the eye (a proximal term that is still active when the loop stops shrinks the
// estimate towards the start: measured 30 % on the Monte Carlo check); instead an eye step longer than
// trustM is clipped to trustM before re-linearising. The covariance is taken after a final
// re-linearisation at the solution.
//
// Nothing here moves an app pose (guard-rail §4.1): the caller decides what a σ permits.
import {
	cameraXFromState,
	type GeoState,
	IDX,
	type MapOpts,
	type MapProblem,
	type MapResult,
} from "../core";
import { laplaceCovariance } from "./covariance";
import { freeMask, lmSolve } from "./lm";

export const MAP_DEFAULTS = {
	maxIter: 50,
	maxOuter: 8,
	relinM: 0.5,
	/** Longest eye step (m) taken on one linearisation. */
	trustM: 25,
};

export type MapSolveOpts = MapOpts & { trustM?: number };

async function relinAll(p: MapProblem, x: GeoState) {
	for (const f of p.factors) if (f.relinearize) await f.relinearize(x);
}

export async function solveMap(
	p: MapProblem,
	x0: GeoState,
	o: MapSolveOpts = {},
): Promise<MapResult> {
	const t0 = Date.now();
	const maxIter = o.maxIter ?? MAP_DEFAULTS.maxIter;
	const maxOuter = o.maxOuter ?? MAP_DEFAULTS.maxOuter;
	const relinM = o.relinM ?? MAP_DEFAULTS.relinM;
	const trustM = o.trustM ?? MAP_DEFAULTS.trustM;
	const mask = freeMask(p.free);
	let x: GeoState = Float64Array.from(x0);
	let iterations = 0;
	let outer = 0;
	let converged = false;
	for (; outer < maxOuter; outer++) {
		if (o.signal?.aborted) throw new Error("aborted");
		await relinAll(p, x);
		const eL: [number, number, number] = [x[IDX.E], x[IDX.N], x[IDX.U]];
		const r = lmSolve(p.factors, x, mask, { maxIter, signal: o.signal });
		iterations += r.iterations;
		x = r.x;
		converged = r.converged;
		if (!p.free.eye) break;
		const d = [x[IDX.E] - eL[0], x[IDX.N] - eL[1], x[IDX.U] - eL[2]];
		const mv = Math.hypot(d[0], d[1], d[2]);
		if (mv < relinM) break;
		if (mv > trustM) {
			// the linearised predictors are not trusted this far: step the eye trustM towards the
			// solution and re-linearise there (rotation / focal follow in the next inner solve)
			const k = trustM / mv;
			x[IDX.E] = eL[0] + k * d[0];
			x[IDX.N] = eL[1] + k * d[1];
			x[IDX.U] = eL[2] + k * d[2];
		}
		if (outer === maxOuter - 1) converged = false;
	}
	await relinAll(p, x);
	const c = laplaceCovariance(p.factors, x, mask, {
		madRescale: o.madRescale,
	});
	return {
		x,
		cam: cameraXFromState(p.base, x),
		cov: c.cov,
		sigma: c.sigma,
		sigmaEN: c.sigmaEN,
		perFamily: c.perFamily,
		mad: c.mad,
		iterations,
		outer: Math.min(outer + 1, maxOuter),
		converged,
		ms: Date.now() - t0,
	};
}
