// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Small-sample statistics for the accept rule (reports/steps-2026-10-02/accept-rule.md).
//
// The product rule is judged on a few dozen accepts, so "HIGH 17/17" is a point estimate with a wide
// interval. These helpers turn counts into one-sided exact (Clopper-Pearson) bounds, risk-coverage
// curves over a score, and a Learn-then-Test threshold (Angelopoulos et al. 2021, fixed-sequence
// testing) so that a threshold choice comes with a stated guarantee instead of a hand pick.
// Pure CPU, no data access: callers pass rows they are allowed to read (dev only, never a sealed half).

/** P(X ≤ k) for X ~ Binomial(n, p). */
export function binomialCdf(k: number, n: number, p: number): number {
	if (k < 0) return 0;
	if (k >= n) return 1;
	if (p <= 0) return 1;
	if (p >= 1) return 0;
	// sum the pmf in log space; n is small here (≤ a few thousand)
	const lp = Math.log(p);
	const lq = Math.log1p(-p);
	let logC = 0; // log C(n, 0)
	let sum = 0;
	for (let i = 0; i <= k; i++) {
		if (i > 0) logC += Math.log((n - i + 1) / i);
		sum += Math.exp(logC + i * lp + (n - i) * lq);
	}
	return Math.min(1, sum);
}

/** Root of a monotone decreasing f on [0, 1] with f(lo) ≥ target ≥ f(hi), by bisection. */
function bisectDecreasing(f: (p: number) => number, target: number): number {
	let lo = 0;
	let hi = 1;
	for (let it = 0; it < 80; it++) {
		const mid = (lo + hi) / 2;
		if (f(mid) >= target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * One-sided exact upper confidence bound on a rate, given `k` events in `n` trials: the largest p with
 * P(X ≤ k; n, p) ≥ alpha. With k = 0 this is 1 − alpha^(1/n) (the "rule of three" ≈ 3/n at alpha 0.05).
 * n = 0 gives 1 (no evidence).
 */
export function clopperPearsonUpper(
	k: number,
	n: number,
	alpha = 0.05,
): number {
	if (n <= 0 || k >= n) return 1;
	if (k === 0) return 1 - alpha ** (1 / n);
	return bisectDecreasing((p) => binomialCdf(k, n, p), alpha);
}

/** One-sided exact lower confidence bound on a rate, given `k` successes in `n` trials. */
export function clopperPearsonLower(
	k: number,
	n: number,
	alpha = 0.05,
): number {
	if (n <= 0 || k <= 0) return 0;
	return 1 - clopperPearsonUpper(n - k, n, alpha);
}

/** Lower (1 − alpha) bound on precision for `correct` right answers among `accepted` accepts. */
export function precisionLowerBound(
	correct: number,
	accepted: number,
	alpha = 0.05,
): number {
	return clopperPearsonLower(correct, accepted, alpha);
}

/**
 * Smallest number of accepts with at most `errors` wrong whose precision lower bound reaches `target`
 * at level `alpha`. Sizing for an evaluation set: with 0 errors, 0.95 at alpha 0.05 needs 59 accepts.
 */
export function acceptsNeeded(
	target: number,
	alpha = 0.05,
	errors = 0,
): number {
	for (let n = errors + 1; n < 100_000; n++)
		if (precisionLowerBound(n - errors, n, alpha) >= target) return n;
	return Number.POSITIVE_INFINITY;
}

/** One labelled decision: the gate's score (higher = more confident) and whether the pose was right. */
export type ScoredOutcome = {
	score: number | null;
	/** true = correct, false = wrong, null = unsure (counted as wrong: precision first) */
	correct: boolean | null;
};

export type RiskCoveragePoint = {
	/** accept when score ≥ threshold */
	threshold: number;
	accepted: number;
	/** wrong or unsure among the accepted */
	wrong: number;
	coverage: number;
	/** wrong / accepted (0 when nothing is accepted) */
	risk: number;
	/** one-sided Clopper-Pearson upper bound on the risk */
	riskUpper: number;
};

/**
 * Risk-coverage curve: one point per distinct finite score, thresholds descending. Rows without a
 * finite score are never accepted (fail closed) but count in the coverage denominator.
 */
export function riskCoverage(
	rows: ScoredOutcome[],
	alpha = 0.05,
): RiskCoveragePoint[] {
	const scored = rows
		.filter((r) => typeof r.score === "number" && Number.isFinite(r.score))
		.sort((a, b) => (b.score as number) - (a.score as number));
	const out: RiskCoveragePoint[] = [];
	let accepted = 0;
	let wrong = 0;
	for (let i = 0; i < scored.length; i++) {
		accepted++;
		if (scored[i].correct !== true) wrong++;
		const t = scored[i].score as number;
		// ties: one point after the last row with this score
		if (i + 1 < scored.length && scored[i + 1].score === t) continue;
		out.push({
			threshold: t,
			accepted,
			wrong,
			coverage: rows.length ? accepted / rows.length : 0,
			risk: wrong / accepted,
			riskUpper: clopperPearsonUpper(wrong, accepted, alpha),
		});
	}
	return out;
}

/** The risk-coverage point for "accept when score ≥ threshold" (one threshold, any value). */
export function riskAt(
	rows: ScoredOutcome[],
	threshold: number,
	alpha = 0.05,
): RiskCoveragePoint {
	let accepted = 0;
	let wrong = 0;
	for (const r of rows) {
		if (
			!(
				typeof r.score === "number" &&
				Number.isFinite(r.score) &&
				r.score >= threshold
			)
		)
			continue;
		accepted++;
		if (r.correct !== true) wrong++;
	}
	return {
		threshold,
		accepted,
		wrong,
		coverage: rows.length ? accepted / rows.length : 0,
		risk: accepted ? wrong / accepted : 0,
		riskUpper: clopperPearsonUpper(wrong, accepted, alpha),
	};
}

/** Default Learn-then-Test grid for a 0..1 score: 0.95, 0.90, …, 0.05 (fixed before seeing data). */
export const LTT_GRID: readonly number[] = Array.from(
	{ length: 19 },
	(_, i) => Math.round((0.95 - i * 0.05) * 100) / 100,
);

export type LearnThenTest = {
	/** loosest threshold certified, or null when not even the first one is */
	threshold: number | null;
	point: RiskCoveragePoint | null;
	/** how many grid thresholds were tested (fixed sequence, strictest first) */
	tested: number;
};

/**
 * Learn-then-Test threshold for a risk bound (Angelopoulos et al. 2021): walk a grid fixed BEFORE
 * looking at the rows, strictest first, and reject H0 "risk > maxRisk" while the exact binomial
 * p-value P(X ≤ wrong; accepted, maxRisk) ≤ delta; stop at the first failure (fixed-sequence testing
 * controls the family-wise error at delta). The returned threshold then has risk ≤ maxRisk with
 * probability ≥ 1 − delta on exchangeable new data. It is only as good as the calibration rows: they
 * must be held out from whatever was tuned on them, and a grid chosen after seeing them voids it.
 */
export function learnThenTest(
	rows: ScoredOutcome[],
	maxRisk: number,
	delta = 0.1,
	grid: readonly number[] = LTT_GRID,
): LearnThenTest {
	let best: RiskCoveragePoint | null = null;
	let tested = 0;
	for (const t of grid) {
		tested++;
		const pt = riskAt(rows, t);
		if (binomialCdf(pt.wrong, pt.accepted, maxRisk) > delta) break;
		best = pt;
	}
	return { threshold: best?.threshold ?? null, point: best, tested };
}
