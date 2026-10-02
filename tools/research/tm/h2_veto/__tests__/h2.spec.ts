// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptDecoys, adaptGa5 } from "../adapt";
import {
	assertInputs,
	calibrate,
	DECOYS_SCHEMA,
	type DecoysInput,
	evaluate,
	FEATURE_SCHEMA,
	type FeatureFile,
	type HardNegInput,
	RefusalError,
	type RuleFile,
	validateRule,
	vetoes,
	wilson,
} from "../lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pad = (n: number) => String(n).padStart(4, "0");
const DEV = new Set(Array.from({ length: 60 }, (_, i) => `wc_${pad(i + 1)}`));

const rule: RuleFile = validateRule(
	JSON.parse(fs.readFileSync(path.join(HERE, "..", "rule.json"), "utf8")),
);

/** 40 hard negatives, 30 verified-correct (odd+even), 56 decoys, features separating them cleanly. */
function fixture() {
	const hard = Array.from({ length: 40 }, (_, i) => ({
		id: `blind:wc_${pad(i + 1)}_k001`,
		source:
			i < 20 ? "blind-wrong" : i < 30 ? "wrong-construct" : "inherited-wrong",
		pid: `wc_${pad(i + 1)}`,
	}));
	const correct = Array.from({ length: 30 }, (_, i) => ({
		id: `inherited:wc_${pad(i + 1)}_k000`,
		source: "inherited-correct",
		pid: `wc_${pad(i + 1)}`,
	}));
	const hn: HardNegInput = {
		schema: "h1-hardneg/1",
		generatedAt: "2026-11-01T00:00:00Z",
		hardNegatives: hard,
		verifiedCorrect: correct,
	};
	const decoys: DecoysInput = {
		schema: DECOYS_SCHEMA,
		source: "synthetic",
		items: Array.from({ length: 56 }, (_, i) => ({
			id: `wc_${pad((i % 30) + 1)}_dispd150b${i}`,
			pid: `wc_${pad((i % 30) + 1)}`,
		})),
	};
	const mk = (
		feature: string,
		direction: FeatureFile["direction"],
		good: number,
		bad: number,
	): FeatureFile => {
		const values: Record<string, number | null> = {};
		correct.forEach((c, i) => {
			values[c.id.split(":")[1]] =
				good + (direction === "higher-is-better" ? i * 0.001 : -i * 0.001);
		});
		for (const h of hard) values[h.id.split(":")[1]] = bad;
		for (const d of decoys.items) values[d.id] = bad;
		return { schema: FEATURE_SCHEMA, feature, version: "t", direction, values };
	};
	const features = [
		mk("moge_depth_agreement", "higher-is-better", 0.8, 0.3),
		mk("pnp_shift", "lower-is-better", 1, 20),
		mk("three_strip_agreement", "lower-is-better", 1, 20),
		mk("xoftr_depth", "higher-is-better", 0.8, 0.3),
	];
	return { hn, decoys, features };
}
const code = (fn: () => void) => {
	try {
		fn();
	} catch (e) {
		return e instanceof RefusalError ? e.code : `other:${String(e)}`;
	}
	return null;
};

describe("wilson", () => {
	it("matches known values", () => {
		const [lo, hi] = wilson(5, 10) as [number, number];
		expect(lo).toBeCloseTo(0.2366, 3);
		expect(hi).toBeCloseTo(0.7634, 3);
		const z = wilson(0, 56) as [number, number];
		expect(z[0]).toBe(0);
		expect(z[1]).toBeCloseTo(0.0642, 3);
		expect((wilson(56, 56) as [number, number])[0]).toBeCloseTo(0.9358, 3);
		expect(wilson(0, 0)).toBeNull();
	});
});

describe("rule file", () => {
	it("committed rule.json validates and keeps the hard-negative floor", () => {
		expect(rule.criteria.minHardNegatives).toBeGreaterThanOrEqual(30);
		const bad = structuredClone(rule);
		bad.criteria.minHardNegatives = 29;
		expect(code(() => validateRule(bad))).toBe("bad-rule");
		const unknown = structuredClone(rule);
		unknown.primary = { name: "x", kind: "any", features: ["nope"] };
		expect(code(() => validateRule(unknown))).toBe("bad-rule");
	});
	it("vetoes honours direction and missing values", () => {
		expect(vetoes(0.1, 0.5, "higher-is-better")).toBe(true);
		expect(vetoes(0.9, 0.5, "higher-is-better")).toBe(false);
		expect(vetoes(9, 5, "lower-is-better")).toBe(true);
		expect(vetoes(null, 0.5, "higher-is-better")).toBeNull();
	});
});

describe("refusals", () => {
	const frozen = "2026-10-15T00:00:00Z";
	it("accepts the clean fixture", () => {
		const f = fixture();
		expect(
			code(() => assertInputs(rule, f.hn, f.decoys, f.features, DEV, frozen)),
		).toBeNull();
	});
	it("refuses fewer than 30 hard negatives", () => {
		const f = fixture();
		f.hn.hardNegatives = f.hn.hardNegatives.slice(0, 29);
		expect(
			code(() => assertInputs(rule, f.hn, f.decoys, f.features, DEV, frozen)),
		).toBe("too-few-hard-negatives");
	});
	it("refuses a missing or short decoy set", () => {
		const f = fixture();
		expect(
			code(() => assertInputs(rule, f.hn, null, f.features, DEV, frozen)),
		).toBe("no-decoys");
		f.decoys.items = f.decoys.items.slice(0, 55);
		expect(
			code(() => assertInputs(rule, f.hn, f.decoys, f.features, DEV, frozen)),
		).toBe("too-few-decoys");
	});
	it("refuses non-dev ids anywhere", () => {
		let f = fixture();
		f.hn.hardNegatives[0] = { ...f.hn.hardNegatives[0], pid: "wc_0999" };
		expect(
			code(() => assertInputs(rule, f.hn, f.decoys, f.features, DEV, frozen)),
		).toBe("non-dev-id");
		f = fixture();
		f.decoys.items[0] = { ...f.decoys.items[0], pid: "wc_0999" };
		expect(
			code(() => assertInputs(rule, f.hn, f.decoys, f.features, DEV, frozen)),
		).toBe("non-dev-id");
		f = fixture();
		f.features[0].values.wc_0777_k000 = 0.5;
		expect(
			code(() => assertInputs(rule, f.hn, f.decoys, f.features, DEV, frozen)),
		).toBe("non-dev-id");
	});
	it("refuses labels generated before the freeze, a missing primary feature, or a direction mismatch", () => {
		const f = fixture();
		expect(
			code(() =>
				assertInputs(
					rule,
					f.hn,
					f.decoys,
					f.features,
					DEV,
					"2026-12-01T00:00:00Z",
				),
			),
		).toBe("rule-not-frozen-first");
		expect(
			code(() =>
				assertInputs(rule, f.hn, f.decoys, f.features.slice(1), DEV, frozen),
			),
		).toBe("missing-feature");
		const g = fixture();
		g.features[1].direction = "higher-is-better";
		expect(
			code(() => assertInputs(rule, g.hn, g.decoys, g.features, DEV, frozen)),
		).toBe("bad-input");
	});
	it("refuses to calibrate from too few verified-correct points", () => {
		const f = fixture();
		const few = { ...f.hn, verifiedCorrect: f.hn.verifiedCorrect.slice(0, 8) };
		expect(
			code(() =>
				calibrate(rule.features[0], f.features[0], few.verifiedCorrect),
			),
		).toBe("too-few-calibration-points");
	});
});

describe("evaluate", () => {
	it("PASSes when the features separate cleanly; calibrates on odd ids only", () => {
		const f = fixture();
		const r = evaluate(rule, f.hn, f.decoys, f.features);
		expect(r.status).toBe("PASS");
		expect(r.primary.decoys.vetoed).toMatchObject({ k: 56, n: 56 });
		expect(r.primary.hardNeg.vetoed).toMatchObject({ k: 40, n: 40 });
		expect(r.primary.correctKills.all.k).toBe(0);
		expect(r.primary.hardNeg.bySource["wrong-construct"].k).toBe(10);
		// moge tau = min over ODD correct ids (wc_0001, 3, ...) = 0.8 + 0*0.001 for wc_0001
		expect(r.thresholds.moge_depth_agreement.tau).toBeCloseTo(0.8, 6);
		expect(r.thresholds.moge_depth_agreement.nCalibration).toBe(15);
		expect(r.skippedFeatures).toEqual(
			expect.arrayContaining(["ga5_integrity", "basin_gap"]),
		);
	});
	it("FAILs when decoys slip through", () => {
		const f = fixture();
		for (const d of f.decoys.items.slice(0, 10))
			for (const ft of f.features)
				ft.values[d.id] = ft.direction === "higher-is-better" ? 0.95 : 0.1;
		const r = evaluate(rule, f.hn, f.decoys, f.features);
		expect(r.status).toBe("FAIL");
		expect(r.primary.decoys.vetoed.k).toBe(46);
		expect(r.reasons.join(" ")).toMatch(/decoys vetoed 46\/56/);
	});
	it("counts a held-out (even-id) verified-correct kill and fails", () => {
		const f = fixture();
		f.features[0].values.wc_0002_k000 = 0.1; // even id, below the odd-calibrated tau
		const r = evaluate(rule, f.hn, f.decoys, f.features);
		expect(r.primary.correctKills.heldOutEven.k).toBe(1);
		expect(r.primary.correctKills.calibrationOdd.k).toBe(0);
		expect(r.status).toBe("FAIL");
		expect(r.reasons.join(" ")).toMatch(
			/held-out verified-correct kills 1 > 0/,
		);
		// single-feature view shows which feature did it
		expect(
			r.perFeature.find((x) => x.name === "moge_depth_agreement")?.correctKills
				.all.k,
		).toBe(1);
		expect(
			r.perFeature.find((x) => x.name === "pnp_shift")?.correctKills.all.k,
		).toBe(0);
	});
	it("treats missing values as no veto (and reports them)", () => {
		const f = fixture();
		for (const ft of f.features)
			for (const h of f.hn.hardNegatives.slice(0, 20))
				ft.values[h.id.split(":")[1]] = null;
		const r = evaluate(rule, f.hn, f.decoys, f.features);
		expect(r.primary.hardNeg.vetoed.k).toBe(20);
		expect(r.primary.hardNeg.missing).toBe(20);
		expect(r.status).toBe("PASS"); // 20/40 = 0.5 meets the utility floor exactly
		for (const h of f.hn.hardNegatives.slice(20, 25))
			for (const ft of f.features) ft.values[h.id.split(":")[1]] = null;
		expect(evaluate(rule, f.hn, f.decoys, f.features).status).toBe("FAIL");
	});
	it("GA5 fixed threshold joins as an optional feature and k-of-n counts agreement", () => {
		const f = fixture();
		const values: Record<string, number | null> = {};
		for (const c of f.hn.verifiedCorrect) values[c.id.split(":")[1]] = 1;
		for (const c of f.hn.verifiedCorrect.slice(0, 12))
			values[c.id.split(":")[1]] = 0; // 12 integrity rejects of correct
		for (const h of f.hn.hardNegatives) values[h.id.split(":")[1]] = 0;
		for (const d of f.decoys.items) values[d.id] = 0;
		const ga5: FeatureFile = {
			schema: FEATURE_SCHEMA,
			feature: "ga5_integrity",
			version: "t",
			direction: "higher-is-better",
			values,
		};
		const r = evaluate(rule, f.hn, f.decoys, [...f.features, ga5]);
		expect(r.status).toBe("PASS"); // primary excludes ga5
		expect(
			r.descriptive.find((d) => d.name === "ga5")?.correctKills.all.k,
		).toBe(12);
		// 2-of-5: correct poses are only vetoed by ga5 (1 vote) -> no kills
		expect(
			r.descriptive.find((d) => d.name === "2-of-5")?.correctKills.all.k,
		).toBe(0);
	});
	it("flags a threshold that repeats straddle (N4 run-to-run noise)", () => {
		const f = fixture();
		const reps: Record<string, number[]> = {};
		for (const c of f.hn.verifiedCorrect)
			reps[c.id.split(":")[1]] = [0.79, 0.81]; // straddles tau = 0.8
		f.features[0].repeats = reps;
		const r = evaluate(rule, f.hn, f.decoys, f.features);
		expect(r.straddle.moge_depth_agreement.fraction).toBeGreaterThan(0.9);
		expect(r.status).toBe("FAIL");
		expect(r.reasons.join(" ")).toMatch(/straddled/);
	});
});

describe("adapters", () => {
	it("keeps only primary NE-dec decoys and maps GA5 pass/fail/unavailable", () => {
		const d = adaptDecoys([
			{
				format: "geocam-decoys/1",
				pid: "wc_0002",
				hyps: [
					{ id: "wc_0002_dispd150b1", label: "NE-dec", secondary: false },
					{ id: "wc_0002_dispd400b1", label: "NE-dec", secondary: true },
					{ id: "wc_0002_k000", label: "POS", secondary: false },
				],
			},
		]);
		expect(d.items).toEqual([{ id: "wc_0002_dispd150b1", pid: "wc_0002" }]);
		expect(() =>
			adaptDecoys([{ format: "other", pid: "x", hyps: [] }]),
		).toThrow();
		const g = adaptGa5([
			{ id: "a", integrityPass: true },
			{ id: "b", integrityPass: false },
			{ id: "c", available: false },
		]);
		expect(g.values).toEqual({ a: 1, b: 0, c: null });
	});
});
