// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Thresholds over the synthetic tracker evidence (scripts/track/synthetic.eval.ts): 12 s at 15 fps,
// the nominal (biased compass, clouds, occluders) and no-sensor scenarios. Synthetic only: it says the
// tracker works on rendered skylines, not that it meets the recorded-clip gate
// (reports/tracker-gate-draft.md). No GPU, no browser.
//
//   npx tsx scripts/track/synthetic.check.ts

import { runScenario, SCENARIOS } from "./synthetic.eval";

const limits = {
	medianErrDeg: 0.6,
	p90ErrDeg: 1.0,
	endMinusStartDeg: 0.3,
	timeToFirstTrackS: 2,
	trackedFraction: 0.9,
};

let failed = false;
for (const name of ["nominal", "no-sensor"]) {
	const sc = SCENARIOS.find((s) => s.name === name);
	if (!sc) throw new Error(`scenario ${name} missing`);
	const r = await runScenario(sc, { seconds: 12, fps: 15 });
	const checks: [string, boolean, string][] = [
		[
			"median",
			r.medianErrDeg < limits.medianErrDeg,
			`${r.medianErrDeg.toFixed(2)} deg`,
		],
		["p90", r.p90ErrDeg < limits.p90ErrDeg, `${r.p90ErrDeg.toFixed(2)} deg`],
		[
			"drift",
			r.endMedianDeg - r.startMedianDeg < limits.endMinusStartDeg,
			`${r.startMedianDeg.toFixed(2)} -> ${r.endMedianDeg.toFixed(2)} deg`,
		],
		[
			"first track",
			r.timeToFirstTrackS < limits.timeToFirstTrackS,
			`${r.timeToFirstTrackS.toFixed(2)} s`,
		],
		[
			"tracked",
			r.posesTracked / r.frames > limits.trackedFraction,
			`${r.posesTracked}/${r.frames}`,
		],
		["no LOST", r.lostEvents === 0, `${r.lostEvents}`],
	];
	for (const [what, ok, value] of checks) {
		console.log(
			`${ok ? "PASS" : "FAIL"} track-synthetic ${name} ${what}: ${value}`,
		);
		if (!ok) failed = true;
	}
}
process.exit(failed ? 1 : 0);
