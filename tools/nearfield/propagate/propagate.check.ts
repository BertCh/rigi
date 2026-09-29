// Checks src/lib/nearfield/propagate.ts against the Python study (convention parity + gate).
// Run: npx tsx tools/nearfield/propagate/propagate.check.ts   (needs tools/nearfield/propagate/raw.json)
import { readFileSync } from "node:fs";
import type { Pose } from "../../../src/lib/camera";
import {
	type Mat3,
	mul3,
	overlapFraction,
	poseToR,
	proposePose,
	relRFromPoses,
	rotAngleDeg,
	rToPose,
} from "../../../src/lib/nearfield/propagate";

let fails = 0;
const ok = (c: boolean, msg: string) => {
	if (!c) {
		fails++;
		console.error("FAIL", msg);
	}
};
const wrap = (a: number) => ((a + 540) % 360) - 180;

// 1. round trip pose -> R -> pose
for (const p of [
	{ yaw: 10, pitch: -4, roll: 2, vfov: 50 },
	{ yaw: 350, pitch: 20, roll: -7, vfov: 60 },
	{ yaw: 181, pitch: -1, roll: 0.3, vfov: 30 },
] as Pose[]) {
	const q = rToPose(poseToR(p), p.vfov);
	ok(
		Math.abs(wrap(q.yaw - p.yaw)) < 1e-9 &&
			Math.abs(q.pitch - p.pitch) < 1e-9 &&
			Math.abs(q.roll - p.roll) < 1e-9,
		`round trip ${JSON.stringify(p)} -> ${JSON.stringify(q)}`,
	);
}

// 2. exact relR reproduces the target pose; identity overlap = 1
const A: Pose = { yaw: 20, pitch: -3, roll: 1, vfov: 50 };
const B: Pose = { yaw: 41, pitch: 2, roll: -2, vfov: 45 };
const s = proposePose(
	A,
	relRFromPoses(A, B),
	B.vfov,
	{ a: 4 / 3, b: 4 / 3 },
	{ method: "rot" },
);
ok(
	Math.abs(wrap(s.pose.yaw - B.yaw)) < 1e-9 &&
		Math.abs(s.pose.roll - B.roll) < 1e-9,
	"compose exact",
);
ok(
	s.kind === "suggestion" && !s.gated,
	"no evidence -> not gated, still a suggestion",
);
const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
ok(
	overlapFraction(I, { vfov: 50, aspect: 1.5 }, { vfov: 50, aspect: 1.5 }) ===
		1,
	"identity overlap",
);

// 3. parity with the Python study on the real viewpoint pairs (same relR -> same pose)
type Row = {
	A: string;
	B: string;
	rot?: { relR: number[][]; pose: Pose; inliers: number; rmsPx: number } | null;
	rotBwd?: { relR: number[][] } | null;
	gravityB: { pitch: number; roll: number };
	overlap: number;
};
const raw = JSON.parse(
	readFileSync(new URL("./raw.json", import.meta.url), "utf8"),
);
const gt = raw.realGt as Record<string, Pose>;
let n = 0;
let gated = 0;
let overlapping = 0;
for (const r of raw.real as Row[]) {
	if (!r.rot) continue;
	const relR = r.rot.relR.flat() as Mat3;
	const bwd = r.rotBwd ? (r.rotBwd.relR.flat() as Mat3) : null;
	const fwdBwd = bwd ? rotAngleDeg(mul3(bwd, relR)) : undefined;
	const asp = (id: string) => (id === "IMG_7068" ? 0.75 : 4 / 3);
	const sug = proposePose(
		gt[r.A],
		relR,
		r.rot.pose.vfov,
		{ a: asp(r.A), b: asp(r.B) },
		{
			method: "rot",
			inliers: r.rot.inliers,
			rmsPx: r.rot.rmsPx,
			fwdBwdDeg: fwdBwd,
			gravity: r.gravityB,
		},
	);
	n++;
	if (r.overlap > 0) overlapping++;
	// the gate must pass exactly the GT-overlapping pairs (6/6 pass, 0/14 non-overlapping)
	ok(
		sug.gated === r.overlap > 0,
		`gate ${r.A}->${r.B}: gated=${sug.gated} but GT overlap ${r.overlap.toFixed(2)} (${sug.reasons.join("; ")})`,
	);
	ok(
		Math.abs(wrap(sug.pose.yaw - r.rot.pose.yaw)) < 1e-6 &&
			Math.abs(sug.pose.pitch - r.rot.pose.pitch) < 1e-6 &&
			Math.abs(wrap(sug.pose.roll - r.rot.pose.roll)) < 1e-6,
		`python parity ${r.A}->${r.B}`,
	);
	if (sug.gated) {
		gated++;
		// geodesic error (all three axes) vs GT target orientation
		const e = rotAngleDeg(relRFromPoses(sug.pose, gt[r.B]));
		ok(
			e < 5,
			`gated real pair ${r.A}->${r.B} within 5 deg (geodesic ${e.toFixed(2)})`,
		);
	}
}
console.log(
	`real pairs: ${n} checked, ${gated} gated, ${overlapping} GT-overlapping`,
);
ok(n === 20 && gated === 6 && overlapping === 6, "expected 20 pairs, 6 gated");
if (fails) {
	console.error(`${fails} failure(s)`);
	process.exit(1);
}
console.log("propagate checks OK");
