// npx tsx src/lib/picker/candidates.check.ts — pure checks of the picker maths (no browser).
import { solvePins } from "#/lib/align";
import { type Pose, projectPoint } from "#/lib/camera";
import {
	type Candidate,
	isAutoHigh,
	nearbyPeaks,
	type PoolPeak,
	poseSepDeg,
	rerankWithTaps,
	TAP_MAX_PX,
	topDistinct,
} from "./candidates";
import { parsePickerFlag } from "./flags";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
	if (!cond) fails++;
};

const truth: Pose = { yaw: 132.4, pitch: 2.1, roll: -0.8, vfov: 42 };
const aspect = 4 / 3;
const eye: [number, number, number] = [0, 0, 1500];

// separation / dedupe
ok(poseSepDeg(truth, truth) < 1e-4, "sep(self) = 0");
ok(
	Math.abs(
		poseSepDeg(truth, { ...truth, yaw: truth.yaw + 3 }) -
			3 * Math.cos(2.1 * (Math.PI / 180)),
	) < 0.01,
	"sep(yaw+3) ≈ 3·cos(pitch)",
);
ok(
	Math.abs(poseSepDeg(truth, { ...truth, roll: truth.roll + 1 }) - 1) < 1e-9,
	"sep(roll+1) = 1",
);
const c = (p: Partial<Pose>, i: number): Candidate => ({
	pose: { ...truth, ...p },
	score: 1 - i * 0.1,
	source: "align",
	sourceRank: i,
});
const ranked = [
	c({}, 0),
	c({ yaw: truth.yaw + 0.3 }, 1), // duplicate of 0
	c({ yaw: truth.yaw + 6 }, 2),
	c({ yaw: truth.yaw + 6.2 }, 3), // duplicate of 2
	c({ yaw: truth.yaw - 11 }, 4),
	c({ yaw: truth.yaw + 20 }, 5),
];
const top = topDistinct(ranked, 3);
ok(
	top.map((t) => t.sourceRank).join() === "0,2,4",
	`topDistinct keeps ranks 0,2,4 (got ${top.map((t) => t.sourceRank).join()})`,
);

// a synthetic ridge of peaks; project the "tapped" one under the truth pose
const peak = (
	name: string,
	az: number,
	distKm: number,
	ele: number,
	prom = 300,
): PoolPeak => ({
	name,
	ele,
	prominence: prom,
	world: [
		Math.sin((az * Math.PI) / 180) * distKm * 1000,
		Math.cos((az * Math.PI) / 180) * distKm * 1000,
		ele,
	],
});
const pool = [
	peak("Alpha", 125, 18, 3100),
	peak("Bravo", 131, 22, 3420, 900),
	peak("Charlie", 133.5, 30, 3300),
	peak("Delta", 142, 12, 2600),
	peak("Echo", 200, 15, 2900), // behind / far off
];
const bravo = pool[1];
const q = projectPoint(truth, aspect, eye, bravo.world);
if (!q) throw new Error("Bravo not in view");
// the shown pose is 7° off in yaw: under it the tap ray points 7° away from Bravo
const shown: Pose = { ...truth, yaw: truth.yaw + 7 };
const offered = nearbyPeaks(pool, eye, aspect, q.u, q.v, [shown, truth]);
ok(
	offered[0]?.name === "Bravo",
	`nearbyPeaks: Bravo first (got ${offered.map((o) => o.name).join(",")})`,
);
ok(
	!offered.some((o) => o.name === "Echo"),
	"nearbyPeaks: far-off Echo excluded",
);
const offeredShownOnly = nearbyPeaks(pool, eye, aspect, q.u, q.v, [shown]);
ok(
	offeredShownOnly.some((o) => o.name === "Bravo"),
	"nearbyPeaks: Bravo still offered from the wrong pose alone (15° window)",
);

// re-solve from every start with the tap constraint (align.ts pin solver, as the engine does)
const taps = [{ world: bravo.world, u: q.u, v: q.v }];
const starts: Candidate[] = [
	{ pose: shown, score: null, source: "shown", sourceRank: 0 },
	c({ yaw: truth.yaw - 11, roll: truth.roll + 2 }, 1),
];
const res = rerankWithTaps(
	starts,
	taps,
	(from) => solvePins(from, aspect, eye, taps, 4032, 3024, false),
	{ aspect, eye, skyline: (p) => -poseSepDeg(p, truth) },
);
ok(res.length >= 1, "rerankWithTaps returns solutions");
ok(
	res[0].tapPx <= TAP_MAX_PX,
	`best solution fits the tap (${res[0].tapPx.toFixed(2)} px)`,
);
ok(
	Math.abs(res[0].pose.yaw - truth.yaw) < 0.3,
	`one tap recovers yaw: ${res[0].pose.yaw.toFixed(2)} vs ${truth.yaw} (from ${shown.yaw})`,
);

// two taps fix roll too
const charlie = pool[2];
const q2 = projectPoint(truth, aspect, eye, charlie.world);
if (q2) {
	const taps2 = [...taps, { world: charlie.world, u: q2.u, v: q2.v }];
	const res2 = rerankWithTaps(
		[
			{
				pose: { ...shown, roll: 3 },
				score: null,
				source: "shown",
				sourceRank: 0,
			},
		],
		taps2,
		(from) => solvePins(from, aspect, eye, taps2, 4032, 3024, false),
		{ aspect, eye },
	);
	ok(
		poseSepDeg(res2[0].pose, truth) < 0.5,
		`two taps recover the rotation within 0.5° (sep ${poseSepDeg(res2[0].pose, truth).toFixed(3)}°)`,
	);
}

// HIGH gate: user states never HIGH
ok(isAutoHigh("accepted", null), "accepted is HIGH");
ok(isAutoHigh("auto", "verified"), "auto+verified is HIGH");
ok(!isAutoHigh("auto", "kept"), "auto+kept is not HIGH");
ok(!isAutoHigh("manual", "verified"), "manual (a user pick) is never HIGH");
ok(!isAutoHigh("pinned", null), "pinned is not HIGH");
ok(!isAutoHigh("unverified", null), "unverified is not HIGH");

// flag parsing
ok(parsePickerFlag("") === "off", "no flag → off");
ok(parsePickerFlag("?picker=on") === "on", "?picker=on → on");
ok(
	parsePickerFlag("?renderer=deck&picker=always") === "always",
	"?picker=always",
);
ok(parsePickerFlag("?picker=off") === "off", "?picker=off → off");

console.log(fails ? `${fails} FAILED` : "all picker checks passed");
process.exit(fails ? 1 : 0);
