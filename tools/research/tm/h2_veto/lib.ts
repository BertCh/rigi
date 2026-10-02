// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * H2 veto threshold-rule evaluator (R2). Pure functions; run.ts does the I/O. See PREREG_DRAFT.txt.
 *
 * Inputs: (a) the h1-hardneg/1 file from ../h1_mine/verify/score_verdicts.ts (hard negatives + verified-correct
 * dev poses), (b) one h2-feature/1 file per veto feature, (c) the E1 displaced-eye decoys (h2-decoys/1) as a
 * REQUIRED pass set, (d) the frozen rule (rule.json). Computes nothing from images or models.
 */

export const FEATURE_SCHEMA = "h2-feature/1";
export const DECOYS_SCHEMA = "h2-decoys/1";
export const RULE_SCHEMA = "h2-rule/1";
/** The floor below which the evaluator refuses to run, whatever the rule file says (roadmap R2). */
export const MIN_HARD_NEGATIVES_FLOOR = 30;

export class RefusalError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "RefusalError";
	}
}

export type Direction = "higher-is-better" | "lower-is-better";
export type Threshold =
	| { kind: "calibrate-min-correct-odd" } // tau = worst value among verified-correct poses of ODD photo ids
	| { kind: "fixed"; tau: number };

export interface FeatureRule {
	name: string;
	direction: Direction;
	threshold: Threshold;
	/** Minimum verified-correct values needed to calibrate (calibrated thresholds only). */
	minCalibrationPoints?: number;
}

export type Combo =
	| { name: string; kind: "any"; features: string[] }
	| { name: string; kind: "k-of-n"; k: number; features: string[] }
	| { name: string; kind: "single"; features: [string] };

export interface RuleFile {
	schema: typeof RULE_SCHEMA;
	features: FeatureRule[];
	/** The one combination that decides PASS/FAIL. */
	primary: Combo;
	/** Reported, never decisive. */
	descriptive: Combo[];
	criteria: {
		minHardNegatives: number;
		minDecoys: number;
		/** Point estimate of decoys vetoed, required. */
		decoyVetoRateMin: number;
		/** Verified-correct poses vetoed (held-out = even ids, as calibration uses odd ids). */
		maxCorrectKillsHeldOut: number;
		maxCorrectKillsAll: number;
		/** Hard negatives vetoed (utility floor). */
		hardNegVetoRateMin: number;
		/** For features carrying repeats: share of items whose repeat range straddles the threshold. */
		maxThresholdStraddleFrac: number;
	};
}

export interface FeatureFile {
	schema: typeof FEATURE_SCHEMA;
	feature: string;
	version: string;
	direction: Direction;
	/** hypothesis key (hardneg id without its "<source>:" prefix, e.g. wc_0001_k000) -> value; null = not computed. */
	values: Record<string, number | null>;
	/** Optional independent repeats of the same measurement (N4 run-to-run noise). */
	repeats?: Record<string, number[]>;
}

export interface HardNegInput {
	schema: "h1-hardneg/1";
	generatedAt?: string;
	hardNegatives: { id: string; source: string; pid: string }[];
	verifiedCorrect: { id: string; source: string; pid: string }[];
}
export interface DecoysInput {
	schema: typeof DECOYS_SCHEMA;
	source: string;
	items: { id: string; pid: string }[];
}

// ---- statistics ---------------------------------------------------------------------------------

export interface Rate {
	k: number;
	n: number;
	rate: number | null;
	wilson95: [number, number] | null;
}

/** Wilson score interval (z = 1.96). */
export function wilson(
	k: number,
	n: number,
	z = 1.96,
): [number, number] | null {
	if (n === 0) return null;
	const p = k / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const centre = (p + z2 / (2 * n)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function rate(k: number, n: number): Rate {
	return { k, n, rate: n === 0 ? null : k / n, wilson95: wilson(k, n) };
}

// ---- guards -------------------------------------------------------------------------------------

export function validateRule(r: RuleFile): RuleFile {
	if (r.schema !== RULE_SCHEMA)
		throw new RefusalError("bad-rule", `schema must be ${RULE_SCHEMA}`);
	if (r.criteria.minHardNegatives < MIN_HARD_NEGATIVES_FLOOR)
		throw new RefusalError(
			"bad-rule",
			`criteria.minHardNegatives must be >= ${MIN_HARD_NEGATIVES_FLOOR}`,
		);
	const names = new Set(r.features.map((f) => f.name));
	for (const c of [r.primary, ...r.descriptive])
		for (const f of c.features)
			if (!names.has(f))
				throw new RefusalError(
					"bad-rule",
					`combo ${c.name} uses unknown feature ${f}`,
				);
	if (
		r.primary.kind === "k-of-n" &&
		(r.primary.k < 1 || r.primary.k > r.primary.features.length)
	)
		throw new RefusalError("bad-rule", "primary k out of range");
	return r;
}

const PID_IN_KEY = /^(wc_\d+)(?:_|$)/;
export const keyOfId = (id: string): string => id.slice(id.indexOf(":") + 1);

/** Refuses any id (hardneg, correct, decoy or feature key) whose photo is not in split.json "dev". */
export function assertDev(
	pids: Iterable<string>,
	dev: ReadonlySet<string>,
	what: string,
): void {
	for (const p of pids)
		if (!dev.has(p))
			throw new RefusalError(
				"non-dev-id",
				`${what}: ${p} is not a dev id (tools/bench/split.json)`,
			);
}

export function assertInputs(
	rule: RuleFile,
	hn: HardNegInput,
	decoys: DecoysInput | null,
	features: readonly FeatureFile[],
	dev: ReadonlySet<string>,
	frozenAt: string | null,
): void {
	if (hn.schema !== "h1-hardneg/1")
		throw new RefusalError("bad-input", "hardneg schema must be h1-hardneg/1");
	if (frozenAt !== null && (!hn.generatedAt || hn.generatedAt <= frozenAt))
		throw new RefusalError(
			"rule-not-frozen-first",
			"hard-negative labels must be generated after the rule was frozen (generatedAt > frozenAt)",
		);
	const nHard = hn.hardNegatives.length;
	const need = Math.max(
		rule.criteria.minHardNegatives,
		MIN_HARD_NEGATIVES_FLOOR,
	);
	if (nHard < need)
		throw new RefusalError("too-few-hard-negatives", `${nHard} < ${need}`);
	if (!decoys || decoys.schema !== DECOYS_SCHEMA)
		throw new RefusalError(
			"no-decoys",
			"the E1 displaced-eye decoy set is required",
		);
	if (decoys.items.length < rule.criteria.minDecoys)
		throw new RefusalError(
			"too-few-decoys",
			`${decoys.items.length} < ${rule.criteria.minDecoys}`,
		);
	assertDev(
		hn.hardNegatives.map((x) => x.pid),
		dev,
		"hard negatives",
	);
	assertDev(
		hn.verifiedCorrect.map((x) => x.pid),
		dev,
		"verified correct",
	);
	assertDev(
		decoys.items.map((x) => x.pid),
		dev,
		"decoys",
	);
	for (const f of features) {
		const want = rule.features.find((r) => r.name === f.feature);
		if (!want)
			throw new RefusalError(
				"bad-input",
				`feature file ${f.feature} is not in the rule`,
			);
		if (f.schema !== FEATURE_SCHEMA)
			throw new RefusalError("bad-input", `feature ${f.feature}: schema`);
		if (f.direction !== want.direction)
			throw new RefusalError(
				"bad-input",
				`feature ${f.feature}: direction ${f.direction} != rule ${want.direction}`,
			);
		const pids = [...Object.keys(f.values), ...Object.keys(f.repeats ?? {})]
			.map((k) => PID_IN_KEY.exec(k)?.[1])
			.filter((x): x is string => !!x);
		assertDev(pids, dev, `feature ${f.feature}`);
	}
	// Only the primary combination's features are mandatory; other features without a file are skipped.
	for (const name of rule.primary.features)
		if (!features.some((f) => f.feature === name))
			throw new RefusalError("missing-feature", `no feature file for ${name}`);
}

// ---- evaluation ---------------------------------------------------------------------------------

const pidNumber = (pid: string): number => Number(pid.replace(/\D/g, ""));
export const isOddPid = (pid: string): boolean => pidNumber(pid) % 2 === 1;

export function vetoes(
	value: number | null | undefined,
	tau: number,
	dir: Direction,
): boolean | null {
	if (value === null || value === undefined || Number.isNaN(value)) return null; // cannot veto what was not measured
	return dir === "higher-is-better" ? value < tau : value > tau;
}

export interface Item {
	id: string;
	pid: string;
	source: string;
}

export function calibrate(
	fr: FeatureRule,
	ff: FeatureFile,
	correct: readonly Item[],
): { tau: number; nCalibration: number } {
	if (fr.threshold.kind === "fixed")
		return { tau: fr.threshold.tau, nCalibration: 0 };
	const vals = correct
		.filter((c) => isOddPid(c.pid))
		.map((c) => ff.values[keyOfId(c.id)])
		.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
	const min = fr.minCalibrationPoints ?? 10;
	if (vals.length < min)
		throw new RefusalError(
			"too-few-calibration-points",
			`${fr.name}: ${vals.length} < ${min} verified-correct odd-id values`,
		);
	// Worst verified-correct value is the threshold: zero calibration kills by construction (X2 veto.py convention).
	return {
		tau:
			fr.direction === "higher-is-better"
				? Math.min(...vals)
				: Math.max(...vals),
		nCalibration: vals.length,
	};
}

export type FlagMap = Map<string, boolean | null>; // item id -> vetoed (null = missing)

function combine(
	c: Combo,
	per: Map<string, FlagMap>,
	ids: readonly string[],
): FlagMap {
	const out: FlagMap = new Map();
	for (const id of ids) {
		const flags = c.features.map((f) => per.get(f)?.get(id) ?? null);
		const nVeto = flags.filter((x) => x === true).length;
		const known = flags.filter((x) => x !== null).length;
		if (c.kind === "k-of-n")
			out.set(id, nVeto >= c.k ? true : known === 0 ? null : false);
		else out.set(id, nVeto > 0 ? true : known === 0 ? null : false);
	}
	return out;
}

function tally(
	flags: FlagMap,
	items: readonly Item[],
): { vetoed: Rate; missing: number } {
	let k = 0;
	let missing = 0;
	for (const it of items) {
		const v = flags.get(it.id);
		if (v === true) k++;
		else if (v === null || v === undefined) missing++;
	}
	return { vetoed: rate(k, items.length), missing };
}

export interface ComboResult {
	name: string;
	hardNeg: { vetoed: Rate; missing: number; bySource: Record<string, Rate> };
	decoys: { vetoed: Rate; missing: number };
	correctKills: {
		all: Rate;
		heldOutEven: Rate;
		calibrationOdd: Rate;
		missing: number;
	};
}

export interface Result {
	status: "PASS" | "FAIL";
	reasons: string[];
	thresholds: Record<
		string,
		{ tau: number; direction: Direction; nCalibration: number }
	>;
	primary: ComboResult;
	descriptive: ComboResult[];
	perFeature: ComboResult[];
	skippedFeatures: string[];
	straddle: Record<
		string,
		{
			items: number;
			straddling: number;
			fraction: number | null;
			medianRepeatSd: number | null;
		}
	>;
	counts: { hardNegatives: number; verifiedCorrect: number; decoys: number };
}

function median(a: number[]): number | null {
	if (!a.length) return null;
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const sd = (a: number[]) => {
	const m = a.reduce((s, x) => s + x, 0) / a.length;
	return Math.sqrt(
		a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1),
	);
};

export function evaluate(
	rule: RuleFile,
	hn: HardNegInput,
	decoys: DecoysInput,
	features: readonly FeatureFile[],
): Result {
	const correct: Item[] = hn.verifiedCorrect;
	const hard: Item[] = hn.hardNegatives;
	const dec: Item[] = decoys.items.map((d) => ({ ...d, source: "decoy" }));
	const allItems = [...hard, ...correct, ...dec];
	const thresholds: Result["thresholds"] = {};
	const per = new Map<string, FlagMap>();
	const skipped = new Set<string>();
	for (const fr of rule.features) {
		const ff = features.find((f) => f.feature === fr.name);
		if (!ff) {
			skipped.add(fr.name);
			continue;
		}
		let cal: { tau: number; nCalibration: number };
		try {
			cal = calibrate(fr, ff, correct);
		} catch (e) {
			if (rule.primary.features.includes(fr.name)) throw e;
			skipped.add(fr.name); // an optional feature that cannot be calibrated is left out, not guessed
			continue;
		}
		const { tau, nCalibration } = cal;
		thresholds[fr.name] = { tau, direction: fr.direction, nCalibration };
		const m: FlagMap = new Map();
		for (const it of allItems)
			m.set(it.id, vetoes(ff.values[keyOfId(it.id)], tau, fr.direction));
		per.set(fr.name, m);
	}
	const ids = allItems.map((i) => i.id);
	const resultFor = (name: string, flags: FlagMap): ComboResult => {
		const sources = [...new Set(hard.map((h) => h.source))].sort();
		const bySource: Record<string, Rate> = {};
		for (const s of sources)
			bySource[s] = tally(
				flags,
				hard.filter((h) => h.source === s),
			).vetoed;
		const odd = correct.filter((c) => isOddPid(c.pid));
		const even = correct.filter((c) => !isOddPid(c.pid));
		const all = tally(flags, correct);
		return {
			name,
			hardNeg: { ...tally(flags, hard), bySource },
			decoys: tally(flags, dec),
			correctKills: {
				all: all.vetoed,
				heldOutEven: tally(flags, even).vetoed,
				calibrationOdd: tally(flags, odd).vetoed,
				missing: all.missing,
			},
		};
	};
	const primary = resultFor(rule.primary.name, combine(rule.primary, per, ids));
	const descriptive = rule.descriptive
		.filter((c) => c.features.every((f) => !skipped.has(f)))
		.map((c) => resultFor(c.name, combine(c, per, ids)));
	const perFeature = rule.features
		.filter((f) => !skipped.has(f.name))
		.map((f) => resultFor(f.name, per.get(f.name) as FlagMap));

	const straddle: Result["straddle"] = {};
	for (const f of features) {
		if (!f.repeats || !thresholds[f.feature]) continue;
		const tau = thresholds[f.feature].tau;
		const reps = Object.values(f.repeats).filter((r) => r.length >= 2);
		const straddling = reps.filter(
			(r) => Math.min(...r) < tau && Math.max(...r) > tau,
		).length;
		straddle[f.feature] = {
			items: reps.length,
			straddling,
			fraction: reps.length ? straddling / reps.length : null,
			medianRepeatSd: median(reps.map(sd)),
		};
	}

	const reasons: string[] = [];
	const c = rule.criteria;
	const pr = primary;
	if ((pr.decoys.vetoed.rate ?? 0) < c.decoyVetoRateMin)
		reasons.push(
			`decoys vetoed ${pr.decoys.vetoed.k}/${pr.decoys.vetoed.n} below ${c.decoyVetoRateMin}`,
		);
	if (pr.correctKills.heldOutEven.k > c.maxCorrectKillsHeldOut)
		reasons.push(
			`held-out verified-correct kills ${pr.correctKills.heldOutEven.k} > ${c.maxCorrectKillsHeldOut}`,
		);
	if (pr.correctKills.all.k > c.maxCorrectKillsAll)
		reasons.push(
			`verified-correct kills ${pr.correctKills.all.k} > ${c.maxCorrectKillsAll}`,
		);
	if ((pr.hardNeg.vetoed.rate ?? 0) < c.hardNegVetoRateMin)
		reasons.push(
			`hard negatives vetoed ${pr.hardNeg.vetoed.k}/${pr.hardNeg.vetoed.n} below ${c.hardNegVetoRateMin}`,
		);
	for (const f of rule.primary.features) {
		const s = straddle[f];
		if (
			s?.fraction !== null &&
			s?.fraction !== undefined &&
			s.fraction > c.maxThresholdStraddleFrac
		)
			reasons.push(
				`${f}: threshold straddled by ${(s.fraction * 100).toFixed(0)}% of repeated items (run-to-run noise)`,
			);
	}
	return {
		status: reasons.length ? "FAIL" : "PASS",
		reasons,
		thresholds,
		primary,
		descriptive,
		perFeature,
		skippedFeatures: [...skipped],
		straddle,
		counts: {
			hardNegatives: hard.length,
			verifiedCorrect: correct.length,
			decoys: dec.length,
		},
	};
}
