// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * npx tsx merge_verdicts.ts --out merged.json [--strict] verdicts_va.json verdicts_vb.json
 * Dual-verifier merge. Default rule = PROTOCOL (correct iff all correct; wrong if any wrong; else unsure).
 * --strict = any disagreement is unsure (bench-wild.md). Does not read the key.
 */
import fs from "node:fs";
import { mergeFiles, validateVerdictsFile } from "./lib";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const out = oi >= 0 ? args[oi + 1] : null;
const files = args
	.filter((a, i) => !a.startsWith("--") && i !== oi + 1)
	.map((f) => validateVerdictsFile(JSON.parse(fs.readFileSync(f, "utf8"))));
if (new Set(files.map((f) => f.verifier)).size < 2)
	throw new Error("merge needs two different verifiers");
const merged = mergeFiles(
	files,
	args.includes("--strict") ? "strict" : "protocol",
);
const text = JSON.stringify(merged, null, 1);
if (out) fs.writeFileSync(out, text);
else console.log(text);
