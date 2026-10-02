// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * VSWEEP summary: medians per stage × arm and the protocol's decision rule.
 *   npx tsx scripts/vsweep/summarize.ts [out/vsweep/results-terrarium.json] [--yaw-ok 1]
 * --yaw-ok N restricts to photos whose H yaw error is ≤ N° (descriptive only; not the frozen rule).
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
const yi = argv.indexOf("--yaw-ok");
const YAW_OK =
	yi >= 0 ? Number(argv.splice(yi, 2)[1]) : Number.POSITIVE_INFINITY;
const file = argv[0] ?? "out/vsweep/results-terrarium.json";
type Arm = {
	pitchErr: number;
	yawErr: number;
	gapAbs: number;
	gapSigned: number;
	n: number;
	fallback: boolean;
	perturbed: number[];
};
type Row = { name: string; perStage: Record<string, Record<string, Arm>> };
const { results } = JSON.parse(fs.readFileSync(file, "utf8")) as {
	results: Row[];
};
const median = (a: number[]) => {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (!s.length) return Number.NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f2 = (v: number) => v.toFixed(2);

for (const stage of ["H_geo", "H_app"]) {
	const rows = results.filter(
		(r) => Math.abs(r.perStage[stage].V0.yawErr) <= YAW_OK,
	);
	console.log(
		`\n== ${stage} (n = ${rows.length}${Number.isFinite(YAW_OK) ? `, |yaw err| ≤ ${YAW_OK}°` : ""})`,
	);
	console.log(
		"arm   med|pitch|  med gap px  calls  worse>0.15  better>0.05  perturbed med|pitch| (−1,−.5,+.5,+1)",
	);
	const v0 = rows.map((r) => Math.abs(r.perStage[stage].V0.pitchErr));
	const meds: Record<string, number> = {};
	for (const arm of Object.keys(rows[0].perStage[stage])) {
		const a = rows.map((r) => r.perStage[stage][arm]);
		const pe = a.map((x) => Math.abs(x.pitchErr));
		meds[arm] = median(pe);
		const worse = pe.filter((v, i) => v - v0[i] > 0.15).length;
		const better = pe.filter((v, i) => v0[i] - v > 0.05).length;
		const calls = a.filter((x) => !x.fallback).length;
		const pert = [0, 1, 2, 3].map((k) =>
			f2(median(a.map((x) => x.perturbed[k]))),
		);
		console.log(
			`${arm.padEnd(5)} ${f2(meds[arm]).padStart(9)}  ${f2(median(a.map((x) => x.gapAbs))).padStart(10)}  ${String(calls).padStart(5)}  ${String(worse).padStart(10)}  ${String(better).padStart(11)}  ${pert.join(" ")}`,
		);
	}
	const vpWorse = rows.some(
		(r, i) => Math.abs(r.perStage[stage].VP.pitchErr) - v0[i] > 0.15,
	);
	const vdWorse = rows.some(
		(r, i) => Math.abs(r.perStage[stage].VD.pitchErr) - v0[i] > 0.15,
	);
	console.log(
		`rule VP: (1) ${meds.VP <= meds.V0 - 0.05 ? "✓" : "✗"} median ${f2(meds.VP)} vs V0 ${f2(meds.V0)}  (2) ${vpWorse ? "✗" : "✓"} no photo worse >0.15  (3) ${meds.VP <= meds.VD ? "✓" : "✗"} VP ≤ VD (${f2(meds.VD)})`,
	);
	console.log(
		`rule VD: (1) ${meds.VD <= meds.V0 - 0.05 ? "✓" : "✗"}  (2) ${vdWorse ? "✗" : "✓"}`,
	);
}
