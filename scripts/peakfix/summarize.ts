/**
 * PEAKFIX summary + registered verdicts (tools/research/peakfix/PROTOCOL.txt).
 *   npx tsx scripts/peakfix/summarize.ts [--tag x]
 */
import fs from "node:fs";
import path from "node:path";
import { median } from "../geocam/lib";

const tagI = process.argv.indexOf("--tag");
const tag = tagI >= 0 ? process.argv[tagI + 1] : "";
const ARMS = ["dense", "peak", "both"] as const;
type ArmRes = {
	err: number;
	nMatched: number;
	second: { ratio: number; e: number; n: number } | null;
	detail: { matched: { d: number }[] };
};
const load = (mode: string) => {
	const dir = path.join("out", "peakfix", `${mode}${tag}`);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
};
const lines: string[] = [];
const say = (s: string) => {
	lines.push(s);
	console.log(s);
};
for (const mode of ["pk1", "pk2"]) {
	const rs = load(mode);
	if (!rs.length) continue;
	say(`\n== ${mode.toUpperCase()} (n = ${rs.length})`);
	say(`photo      hAcc  ${ARMS.map((a) => `${a.padEnd(6)} err  nM  2nd-ratio`).join(" | ")} | nearest matched (peak arm)`);
	const errs: Record<string, number[]> = { dense: [], peak: [], both: [] };
	for (const r of rs.sort((a, b) => a.photo.localeCompare(b.photo))) {
		const cells = ARMS.map((a) => {
			const x = r.arms[a] as ArmRes;
			const noCall = a !== "dense" && x.nMatched < 3;
			errs[a].push(noCall ? 400 : x.err);
			return `${(noCall ? "NC " : "") + x.err.toFixed(0).padStart(4)} m ${String(x.nMatched).padStart(3)} ${x.second ? x.second.ratio.toFixed(2).padStart(6) : "     -"}`;
		});
		const near = Math.min(...(r.arms.peak as ArmRes).detail.matched.map((m) => m.d), Infinity);
		say(`${r.photo}  ${String(r.hAcc ?? "-").padStart(5)}  ${cells.join("    | ")} | ${Number.isFinite(near) ? `${(near / 1000).toFixed(1)} km` : "-"}`);
	}
	for (const a of ARMS) {
		const e = errs[a];
		say(`${a.padEnd(6)} median ${median(e).toFixed(1)} m · ≤25 m on ${e.filter((x) => x <= 25).length}/${e.length} · ≤40 m on ${e.filter((x) => x <= 40).length}/${e.length}`);
	}
	if (mode === "pk1") {
		const m = median(errs.peak);
		say(`PK1 gate (PEAK median ≤ 15 m): ${m <= 15 ? "PASS" : "FAIL"} (${m.toFixed(1)} m)`);
	} else {
		const dMed = median(errs.dense);
		for (const a of ["peak", "both"] as const) {
			const m = median(errs[a]);
			const c1 = m <= 40;
			const c2 = errs[a].filter((x) => x <= 25).length >= 5;
			const c3 = m <= 0.75 * dMed;
			say(`PK2 ${a}: median ≤ 40 ${c1 ? "✓" : "✗"} · ≤25 m on ≥5/10 ${c2 ? "✓" : "✗"} · ≤ 0.75×DENSE (${(0.75 * dMed).toFixed(1)}) ${c3 ? "✓" : "✗"} → ${c1 && c2 && c3 ? "SURVIVES" : "KILLED"}`);
		}
	}
}
fs.writeFileSync(path.join("out", "peakfix", `summary${tag}.txt`), `${lines.join("\n")}\n`);
