// GA2 held-out family test (guard-rail §4.1 of reports/geometry-first-pose.md: "a held-out cue family must
// confirm the move"). The concord joint solve moved 7130's eye 200 m while the skyline improved, because
// the gate scored the cues it had just fitted; here the family under test is NOT in the fit.
//
// heldOutFamily(p, full, family, {x0}):
//   1. re-solve the problem without `family` from x0 (the pre-move state) → xWithout;
//   2. score the family (mean robust cost ρ over its valid rows, each factor re-linearised at the state) at
//      x0 ("before") and at xWithout ("after");
//   3. improved ⇔ enough rows at both states AND after < (1 − minGain)·before.
// `full` (the MAP result with every factor) only supplies the move being judged: eyeMoveM = |eye(full) −
// eye(x0)|, and whether the solve without the family moves the eye the same way (agreeM).
import {
	type CueFamily,
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	type MapResult,
	PRIOR_FAMILIES,
} from "../core";
import { lossRho } from "../map/lm";
import { solveMap } from "../map/solve";

export type HeldOut = {
	family: CueFamily;
	/** Mean robust cost of the family's rows at x0 / at the solve without it. */
	before: number;
	after: number;
	/** Valid rows at x0 / at xWithout. */
	nBefore: number;
	nAfter: number;
	improved: boolean;
	xWithout: GeoState;
	/** |eye(full) − eye(x0)| (m): the move being judged. */
	eyeMoveM: number;
	/** |eye(full) − eye(xWithout)| (m): how far the fit without the family lands from the full fit. */
	agreeM: number;
};

export type HeldOutOpts = {
	/** The pre-move state (the start of the full solve). */
	x0: GeoState;
	/** Relative cost reduction required. Default 0.1. */
	minGain?: number;
	/** Rows required at both states. Default 5. */
	minRows?: number;
	/** Solver (default solveMap). */
	solve?: (p: MapProblem, x0: GeoState) => Promise<MapResult>;
};

/** Mean robust cost of a set of factors at x (re-linearised there). */
export async function familyCost(
	fs: Factor[],
	x: GeoState,
): Promise<{ cost: number; n: number }> {
	let s = 0;
	let n = 0;
	for (const f of fs) {
		if (f.relinearize) await f.relinearize(x);
		const r = f.residual(x);
		for (const z of r)
			if (Number.isFinite(z)) {
				s += lossRho(f.loss, z);
				n++;
			}
	}
	return { cost: n ? s / n : Number.NaN, n };
}

const eyeDist = (a: GeoState, b: GeoState) =>
	Math.hypot(a[IDX.E] - b[IDX.E], a[IDX.N] - b[IDX.N], a[IDX.U] - b[IDX.U]);

export async function heldOutFamily(
	p: MapProblem,
	full: MapResult,
	family: CueFamily,
	o: HeldOutOpts,
): Promise<HeldOut> {
	const minGain = o.minGain ?? 0.1;
	const minRows = o.minRows ?? 5;
	const held = p.factors.filter((f) => f.family === family);
	const rest = p.factors.filter((f) => f.family !== family);
	const solve = o.solve ?? ((q, x) => solveMap(q, x));
	const without = await solve({ ...p, factors: rest }, o.x0);
	const b = await familyCost(held, o.x0);
	const a = await familyCost(held, without.x);
	const improved =
		!PRIOR_FAMILIES.includes(family) &&
		b.n >= minRows &&
		a.n >= minRows &&
		a.cost < (1 - minGain) * b.cost;
	return {
		family,
		before: b.cost,
		after: a.cost,
		nBefore: b.n,
		nAfter: a.n,
		improved,
		xWithout: without.x,
		eyeMoveM: eyeDist(full.x, o.x0),
		agreeM: eyeDist(full.x, without.x),
	};
}
