// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * H2 veto evaluation CLI (see PREREG_DRAFT.txt).
 *
 *   npx tsx tools/research/tm/h2_veto/run.ts --freeze                      # owner sign-off: writes FROZEN.json
 *   npx tsx tools/research/tm/h2_veto/run.ts --hardneg hardneg.json --decoys decoys.json \
 *        --features dir/ [--out result.json] [--allow-unfrozen]
 *
 * --features is a directory of h2-feature/1 JSON files (one per feature). Without FROZEN.json matching rule.json
 * the run refuses unless --allow-unfrozen (the output is then stamped DRAFT, never a result).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertInputs,
	type DecoysInput,
	evaluate,
	type FeatureFile,
	type HardNegInput,
	RefusalError,
	type RuleFile,
	validateRule,
} from "./lib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULE = path.join(HERE, "rule.json");
const FROZEN = path.join(HERE, "FROZEN.json");
const args = process.argv.slice(2);
const opt = (n: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const readJson = <T>(f: string): T =>
	JSON.parse(fs.readFileSync(f, "utf8")) as T;
const sha1 = (f: string) =>
	createHash("sha1").update(fs.readFileSync(f)).digest("hex");

/** Only the "dev" list is read from split.json; the test half is never touched. */
export function loadDevIds(): Set<string> {
	const split = readJson<{ dev: string[] }>(
		path.join(HERE, "..", "..", "..", "bench", "split.json"),
	);
	return new Set(split.dev);
}

function main() {
	if (args.includes("--freeze")) {
		if (fs.existsSync(FROZEN))
			throw new RefusalError(
				"already-frozen",
				`${FROZEN} exists; delete it only with owner sign-off for a new prereg`,
			);
		fs.writeFileSync(
			FROZEN,
			`${JSON.stringify({ ruleSha1: sha1(RULE), frozenAt: new Date().toISOString() }, null, 1)}\n`,
		);
		console.log(`froze rule.json ${sha1(RULE)}`);
		return;
	}
	const rule = validateRule(readJson<RuleFile>(RULE));
	let frozenAt: string | null = null;
	if (fs.existsSync(FROZEN)) {
		const f = readJson<{ ruleSha1: string; frozenAt: string }>(FROZEN);
		if (f.ruleSha1 !== sha1(RULE))
			throw new RefusalError(
				"rule-changed-after-freeze",
				"rule.json differs from FROZEN.json",
			);
		frozenAt = f.frozenAt;
	} else if (!args.includes("--allow-unfrozen"))
		throw new RefusalError(
			"rule-not-frozen",
			"run --freeze (owner sign-off) first, or --allow-unfrozen for a DRAFT dry run",
		);
	const hn = readJson<HardNegInput>(path.resolve(opt("hardneg") ?? ""));
	const decoysPath = opt("decoys");
	const decoys = decoysPath
		? readJson<DecoysInput>(path.resolve(decoysPath))
		: null;
	const dir = path.resolve(opt("features") ?? "");
	const features = fs
		.readdirSync(dir)
		.filter((n) => n.endsWith(".json"))
		.map((n) => readJson<FeatureFile>(path.join(dir, n)));
	assertInputs(rule, hn, decoys, features, loadDevIds(), frozenAt);
	const res = evaluate(rule, hn, decoys as DecoysInput, features);
	const out = { draft: frozenAt === null, ruleSha1: sha1(RULE), ...res };
	if (opt("out"))
		fs.writeFileSync(
			path.resolve(opt("out") as string),
			JSON.stringify(out, null, 1),
		);
	console.log(
		JSON.stringify(
			{
				draft: out.draft,
				status: res.status,
				reasons: res.reasons,
				counts: res.counts,
			},
			null,
			1,
		),
	);
	process.exitCode = res.status === "PASS" ? 0 : 1;
}

try {
	main();
} catch (e) {
	if (e instanceof RefusalError) {
		console.error(`REFUSED ${e.message}`);
		process.exit(2);
	}
	throw e;
}
