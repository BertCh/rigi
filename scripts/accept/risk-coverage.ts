// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Accept-rule evidence on the wild DEV half only (reports/steps-2026-10-02/accept-rule.md).
//
//   npx tsx scripts/accept/risk-coverage.ts [--json]
//
// Reads tools/bench/score/cascade_mt_scores.json, keeps rows with dev === true and drops everything
// else before any arithmetic (the test half is spent and stays unread). Prints, for the cascade
// confidence and the fused HIGH flag, the risk-coverage curve with one-sided 95% Clopper-Pearson
// bounds, a Learn-then-Test threshold, and how many accepts a sealed set needs to certify a precision.
// These are DEV numbers: planning evidence for the R2 / v3 preregistrations, never a result.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	acceptsNeeded,
	learnThenTest,
	precisionLowerBound,
	riskAt,
	type ScoredOutcome,
} from "../../src/lib/accept/bounds";

type Row = {
	id: string;
	dev: boolean;
	/** blind verdict of the cascade pose */
	verdict: "correct" | "wrong" | "unsure";
	conf: number | null;
	fusedHigh: boolean;
	/** blind verdict of the fused (matcher) pose */
	fusedV: "correct" | "wrong" | "unsure";
	exif: boolean;
};

const FILE = resolve(
	import.meta.dirname,
	"../../tools/bench/score/cascade_mt_scores.json",
);
const all = JSON.parse(readFileSync(FILE, "utf8")) as Row[];
const dev = all.filter((r) => r.dev === true);
all.length = 0; // nothing below may see a non-dev row

const outcome = (v: Row["verdict"]): boolean | null =>
	v === "correct" ? true : v === "wrong" ? false : null;

const cascade: ScoredOutcome[] = dev.map((r) => ({
	score: r.conf,
	correct: outcome(r.verdict),
}));
const fused: ScoredOutcome[] = dev.map((r) => ({
	score: r.fusedHigh ? 1 : 0,
	correct: outcome(r.fusedV),
}));
const fusedExif: ScoredOutcome[] = dev
	.filter((r) => r.exif)
	.map((r) => ({ score: r.fusedHigh ? 1 : 0, correct: outcome(r.fusedV) }));

const gate = (name: string, rows: ScoredOutcome[], t: number) => {
	const p = riskAt(rows, t);
	return {
		gate: name,
		n: rows.length,
		accepted: p.accepted,
		wrongOrUnsure: p.wrong,
		coverage: +p.coverage.toFixed(3),
		precision: p.accepted ? +(1 - p.risk).toFixed(3) : null,
		precisionLower95: +precisionLowerBound(
			p.accepted - p.wrong,
			p.accepted,
		).toFixed(3),
	};
};

const report = {
	note: "wild DEV half only (tools/bench/split.json); planning evidence, not a result",
	rows: dev.length,
	gates: [
		gate("cascade conf ≥ 0.5", cascade, 0.5),
		gate("cascade conf ≥ 0.75 (yaw-unknown bar)", cascade, 0.75),
		gate("fused HIGH", fused, 1),
		gate("fused HIGH, EXIF-GPS photos", fusedExif, 1),
	],
	learnThenTest: [0.05, 0.1].map((maxRisk) => ({
		maxRisk,
		delta: 0.1,
		cascade: learnThenTest(cascade, maxRisk, 0.1).threshold,
	})),
	acceptsNeeded: [0.9, 0.95, 0.99].map((target) => ({
		precisionLower95: target,
		zeroWrong: acceptsNeeded(target),
		oneWrong: acceptsNeeded(target, 0.05, 1),
	})),
};

if (process.argv.includes("--json"))
	console.log(JSON.stringify(report, null, 2));
else {
	console.log(`accept-rule evidence: ${report.note} (${report.rows} rows)\n`);
	console.table(report.gates);
	console.log("Learn-then-Test (δ 0.1, grid 0.95 … 0.05), cascade threshold:");
	console.table(report.learnThenTest);
	console.log("Accepts a sealed set needs (one-sided 95% lower bound):");
	console.table(report.acceptsNeeded);
}
