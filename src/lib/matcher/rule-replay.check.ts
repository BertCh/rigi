// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/matcher/rule-replay.check.ts — replays the recorded T6 runs (tools/bench/final/out/B/*.json,
// gitignored) through the TypeScript rule and compares selection, level and pose with what the Python
// service recorded. Equality only, never tuning: by default only ids of the frozen dev split are replayed;
// REPLAY_ALLOW_TEST=1 includes the test split. RIGI_MAIN=/path/to/main/checkout looks there when the
// worktree has no recordings. SKIPs (exit 0) when there are no recorded runs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confidence, select, type T6Record } from "./rule";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const roots = [repoRoot, process.env.RIGI_MAIN].filter((r): r is string => !!r);
const runsDir = roots
	.map((r) => join(r, "tools/bench/final/out/B"))
	.find((d) => existsSync(d));
const splitPath = roots
	.map((r) => join(r, "tools/bench/split.json"))
	.find((p) => existsSync(p));

function skip(why: string): never {
	console.log(`SKIP rule-replay: ${why}`);
	process.exit(0);
}

if (!runsDir) skip("no recorded runs");
const files = readdirSync(runsDir).filter((f) => /^wc_\d+\.json$/.test(f));
if (!files.length) skip("no recorded runs");

// The split is read from tools/bench/split.json (the frozen dev/test lists; manifest.json has no split).
const split = splitPath
	? (JSON.parse(readFileSync(splitPath, "utf8")) as {
			dev: string[];
			test: string[];
		})
	: null;
const allowTest = process.env.REPLAY_ALLOW_TEST === "1";
const allowed = new Set<string>(
	split ? [...split.dev, ...(allowTest ? split.test : [])] : [],
);

const POSE_KEYS = ["yaw", "pitch", "roll", "vfov"] as const;
const TOL = 1e-6;
let n = 0;
let selEq = 0;
let lvlEq = 0;
let poseEq = 0;
const mismatches: string[] = [];

for (const f of files.sort()) {
	const id = f.replace(/\.json$/, "");
	if (!split || !allowed.has(id)) continue;
	const run = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as {
		raw?: T6Record;
		confidenceLevel?: string;
		source?: string;
		pose?: Record<string, number>;
	};
	if (!run.raw?.candidates || !run.pose) continue;
	n++;
	const sel = select(run.raw);
	if (!sel) {
		mismatches.push(`${id}: no selection`);
		continue;
	}
	const [level] = confidence(run.raw, sel);
	const ok = {
		sel: sel.source === run.source,
		lvl: level === run.confidenceLevel,
		pose: POSE_KEYS.every(
			(k) => Math.abs(sel.fused.pose[k] - (run.pose?.[k] ?? Number.NaN)) <= TOL,
		),
	};
	if (ok.sel) selEq++;
	else mismatches.push(`${id}: source ${sel.source} != ${run.source}`);
	if (ok.lvl) lvlEq++;
	else mismatches.push(`${id}: level ${level} != ${run.confidenceLevel}`);
	if (ok.pose) poseEq++;
	else mismatches.push(`${id}: fused pose differs from recorded pose`);
}

if (!n) skip(`no recorded runs in the ${allowTest ? "dev+test" : "dev"} split`);
console.log(
	`rule-replay: ${n} records, selection equal ${selEq}/${n}, level equal ${lvlEq}/${n}, pose equal ${poseEq}/${n}`,
);
for (const m of mismatches) console.log(`  MISMATCH ${m}`);
process.exit(mismatches.length ? 1 : 0);
