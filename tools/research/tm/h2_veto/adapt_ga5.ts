// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * npx tsx tools/research/tm/h2_veto/adapt_ga5.ts --decoys out/geocam/decoys --ga5 out/geocam/ga5/hyps.json --out <dir>
 * Writes <dir>/decoys.json and <dir>/features/ga5_integrity.json. Conversion only, no scoring.
 */
import fs from "node:fs";
import path from "node:path";
import {
	adaptDecoys,
	adaptGa5,
	type Ga5Hyp,
	type GeocamDecoyDoc,
} from "./adapt";

const args = process.argv.slice(2);
const opt = (n: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const decoyDir = path.resolve(opt("decoys") ?? "out/geocam/decoys");
const ga5 = path.resolve(opt("ga5") ?? "out/geocam/ga5/hyps.json");
const out = path.resolve(opt("out") ?? "");
if (!opt("out")) throw new Error("--out <dir> is required");
const docs = fs
	.readdirSync(decoyDir)
	.filter((n) => n.endsWith(".json"))
	.map(
		(n) =>
			JSON.parse(
				fs.readFileSync(path.join(decoyDir, n), "utf8"),
			) as GeocamDecoyDoc,
	);
fs.mkdirSync(path.join(out, "features"), { recursive: true });
const decoys = adaptDecoys(docs);
fs.writeFileSync(
	path.join(out, "decoys.json"),
	JSON.stringify(decoys, null, 1),
);
fs.writeFileSync(
	path.join(out, "features", "ga5_integrity.json"),
	JSON.stringify(
		adaptGa5(JSON.parse(fs.readFileSync(ga5, "utf8")) as Ga5Hyp[]),
		null,
		1,
	),
);
console.log(`decoys ${decoys.items.length}; wrote ${out}`);
