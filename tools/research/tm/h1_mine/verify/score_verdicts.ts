// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * AFTER verification only (this reads the key):
 *   npx tsx score_verdicts.ts --key ../key/key.json --pool ../pool.json --out hardneg.json [--strict] va.json vb.json
 * Joins the two verifiers' verdicts with the key and pool and writes the h1-hardneg/1 file the H2 veto
 * evaluator (../../h2_veto) reads: hard negatives (3-way split: blind-wrong / wrong-construct / inherited-wrong),
 * verified-correct poses, and the QC lists (duplicate disagreements, failed controls, accepted decoys).
 */
import fs from "node:fs";
import {
	type KeyFile,
	type PoolRecord,
	scoreVerdicts,
	validateVerdictsFile,
} from "./lib";

const args = process.argv.slice(2);
const val = (n: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const used = new Set(
	["--key", "--pool", "--out"].flatMap((f) =>
		args.includes(f) ? [args.indexOf(f) + 1] : [],
	),
);
const files = args
	.filter((a, i) => !a.startsWith("--") && !used.has(i))
	.map((f) => validateVerdictsFile(JSON.parse(fs.readFileSync(f, "utf8"))));
const keyPath = val("key");
const poolPath = val("pool");
if (!keyPath || !poolPath) throw new Error("--key and --pool are required");
if (new Set(files.map((f) => f.verifier)).size < 2)
	throw new Error(
		"score needs two verifiers' verdict files (single-verifier scoring is not allowed)",
	);
const res = scoreVerdicts(
	files,
	JSON.parse(fs.readFileSync(keyPath, "utf8")) as KeyFile,
	JSON.parse(fs.readFileSync(poolPath, "utf8")) as PoolRecord[],
	args.includes("--strict") ? "strict" : "protocol",
);
const out = val("out");
if (out)
	fs.writeFileSync(
		out,
		JSON.stringify({ generatedAt: new Date().toISOString(), ...res }, null, 1),
	);
console.log(
	JSON.stringify(
		{
			counts: res.counts,
			qc: {
				...res.qc,
				constructCheck: {
					packed: res.qc.constructCheck.packed,
					agreedWrong: res.qc.constructCheck.agreedWrong,
				},
			},
		},
		null,
		1,
	),
);
if (res.counts.hardNegativesTotal < 30)
	console.log("NOTE: fewer than 30 hard negatives; H2 will refuse to run.");
