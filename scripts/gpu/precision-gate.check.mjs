#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The precision gate's scoring (precision-gate-score.mjs) on synthetic harness rows, plus the blind
// verdict table built from the tracked verification files. Run: node scripts/gpu/precision-gate.check.mjs
import path from "node:path";
import {
	decide,
	diffModes,
	loadVerifiedPoses,
	nearPose,
	scorePhoto,
	verdictOf,
} from "./precision-gate-score.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
let failures = 0;
const ok = (c, m) => {
	console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
	if (!c) failures++;
};

const P = (yaw, pitch = 0, roll = 0, vfov = 20) => ({ yaw, pitch, roll, vfov });
const run = (pose, sil = 0.3) => ({
	pose,
	score: 0.2,
	confidence: 0.5,
	alternatives: [{ pose, score: 0.2, sil, total: 0.2 + 0.5 * sil }],
});
const mode = (pose, accepted, sil = 0.3) => ({
	pose,
	shownPose: accepted ? pose : P(0),
	accepted,
	acceptKind: accepted ? "confident" : "prior",
	confidence: accepted ? 0.5 : 0.1,
	native: { pose },
	runs: [run(pose, sil)],
});
const verified = [
	{ photo: "a", pose: P(100), verdict: "correct", source: "t" },
	{ photo: "b", pose: P(200), verdict: "wrong", source: "t" },
	{ photo: "c", pose: P(50), verdict: "correct", source: "t" },
	{ photo: "c", pose: P(50.2), verdict: "wrong", source: "t2" },
];

ok(nearPose(P(100), P(100.4, 0.3)), "within tolerance");
ok(!nearPose(P(100), P(100.6)), "0.6° yaw apart is another pose");
ok(nearPose(P(359.8), P(0.1)), "yaw wraps");
ok(verdictOf(verified, "a", P(100.1)) === "correct", "verdict: correct");
ok(verdictOf(verified, "a", P(120)) === "unverified", "verdict: unverified");
ok(verdictOf(verified, "c", P(50.1)) === "unsure", "conflicting → unsure");

// identity: one sil differs on base vs base2 → noise; cand differs the same way → within noise
{
	const base = mode(P(100), true, 0.3);
	const base2 = mode(P(100), true, 0.31);
	const cand = mode(P(100), true, 0.31);
	ok(diffModes(base, base).length === 0, "a mode equals itself");
	const r = scorePhoto("a", { base, cand, base2 }, verified);
	ok(r.status === "within-noise", `within f64 noise (${r.status})`);
	const r2 = scorePhoto("a", { base, cand: base, base2: base }, verified);
	ok(r2.status === "identical", "identical");
}

// quality: same verified-correct accepts → PASS
{
	const rows = [
		scorePhoto(
			"a",
			{
				base: mode(P(100), true),
				cand: mode(P(100.05), true),
				base2: mode(P(100), true),
			},
			verified,
		),
		scorePhoto(
			"b",
			{
				base: mode(P(200), false),
				cand: mode(P(200), false),
				base2: mode(P(200), false),
			},
			verified,
		),
	];
	const d = decide({ rows, evalArm: null, vacuous: [] });
	ok(d.verdict === "PASS", `different but equally good → PASS (${d.verdict})`);
	ok(d.identity.differs.includes("a"), "the difference is reported");
}
// cand accepts a verified-wrong pose → FAIL
{
	const rows = [
		scorePhoto(
			"b",
			{
				base: mode(P(200), false),
				cand: mode(P(200.1), true),
				base2: mode(P(200), false),
			},
			verified,
		),
	];
	const d = decide({ rows, evalArm: null, vacuous: [] });
	ok(
		d.verdict === "FAIL" && d.quality.cand.wrong === 1,
		`false accept → FAIL (${d.verdict})`,
	);
}
// cand loses a verified-correct accept → FAIL
{
	const rows = [
		scorePhoto(
			"a",
			{
				base: mode(P(100), true),
				cand: mode(P(100), false),
				base2: mode(P(100), true),
			},
			verified,
		),
	];
	ok(
		decide({ rows, evalArm: null, vacuous: [] }).verdict === "FAIL",
		"lost correct accept → FAIL",
	);
}
// new accept nobody verified → NEEDS-VERIFY
{
	const rows = [
		scorePhoto(
			"a",
			{
				base: mode(P(140), false),
				cand: mode(P(140), true),
				base2: mode(P(140), false),
			},
			verified,
		),
	];
	const d = decide({ rows, evalArm: null, vacuous: [] });
	ok(
		d.verdict === "NEEDS-VERIFY",
		`unverified new accept → NEEDS-VERIFY (${d.verdict})`,
	);
}
// a new false accept traded against one lost on another photo: the totals are equal, still FAIL
{
	const v = [
		...verified,
		{ photo: "d", pose: P(300), verdict: "wrong", source: "t" },
	];
	const rows = [
		scorePhoto(
			"b",
			{
				base: mode(P(200), false),
				cand: mode(P(200), true),
				base2: mode(P(200), false),
			},
			v,
		),
		scorePhoto(
			"d",
			{
				base: mode(P(300), true),
				cand: mode(P(300), false),
				base2: mode(P(300), true),
			},
			v,
		),
	];
	const d = decide({ rows, evalArm: null, vacuous: [] });
	ok(
		d.verdict === "FAIL" && d.quality.cand.wrong === d.quality.base.wrong,
		`traded false accept → FAIL per photo (${d.verdict})`,
	);
}
// f64 noise: base2 accepts the same verified-wrong pose → not cand's false accept
{
	const rows = [
		scorePhoto(
			"b",
			{
				base: mode(P(200), false),
				cand: mode(P(200), true),
				base2: mode(P(200), true),
			},
			verified,
		),
	];
	const d = decide({ rows, evalArm: null, vacuous: [] });
	ok(
		!rows[0].falseAccept && !d.reasons.some((x) => x.startsWith("new")),
		"a wrong accept f64 also gives (base2) is noise, not a per-photo false accept",
	);
}
// both accept, cand moves to an unverified pose → NEEDS-VERIFY
{
	const rows = [
		scorePhoto(
			"a",
			{
				base: mode(P(100), true),
				cand: mode(P(130), true),
				base2: mode(P(100), true),
			},
			verified,
		),
	];
	const d = decide({ rows, evalArm: null, vacuous: [] });
	ok(
		d.verdict === "FAIL" && rows[0].changedAccept,
		`moved accept that loses a verified-correct pose → FAIL (${d.verdict})`,
	);
	const rows2 = [
		scorePhoto(
			"e",
			{
				base: mode(P(10), true),
				cand: mode(P(40), true),
				base2: mode(P(10), true),
			},
			verified,
		),
	];
	ok(
		decide({ rows: rows2, evalArm: null, vacuous: [] }).verdict ===
			"NEEDS-VERIFY",
		"moved accept to an unverified pose → NEEDS-VERIFY",
	);
}
// eval arm worse → FAIL; error / vacuous → INCONCLUSIVE
{
	const rows = [
		scorePhoto(
			"a",
			{ base: mode(P(100), true), cand: mode(P(100), true) },
			verified,
		),
	];
	ok(
		decide({
			rows,
			evalArm: { within1deg: [12, 11], medianAutoErr: [3, 3] },
			vacuous: [],
		}).verdict === "FAIL",
		"GT-12 within 1° drops → FAIL",
	);
	ok(
		decide({
			rows,
			evalArm: { within1deg: [12, 12], medianAutoErr: [3, 3.2] },
			vacuous: [],
		}).verdict === "PASS",
		"GT-12 equal → PASS",
	);
	ok(
		decide({
			rows: [...rows, { id: "x", status: "error", issues: [] }],
			evalArm: null,
			vacuous: [],
		}).verdict === "INCONCLUSIVE",
		"error row → INCONCLUSIVE",
	);
	ok(
		decide({ rows, evalArm: null, vacuous: ["align: none"] }).verdict ===
			"INCONCLUSIVE",
		"vacuous → INCONCLUSIVE",
	);
}

// the tracked blind verdicts
{
	const v = loadVerifiedPoses(ROOT);
	const photos = new Set(v.map((x) => x.photo));
	const by = (s) => v.filter((x) => x.source.startsWith(s)).length;
	console.log(
		`verified poses: ${v.length} on ${photos.size} photos (gt/wild v2 ${by("gt/wild")}, t5 ${by("t5")}, final ${by("gt/final")})`,
	);
	if (v.length) {
		ok(
			v.every((x) => ["correct", "wrong", "unsure"].includes(x.verdict)),
			"every verdict is correct / wrong / unsure",
		);
		ok(by("gt/wild") > 0, "gt/wild v2 verdicts loaded");
	} else console.log("SKIP  no tracked verification files");
}

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nprecision gate scoring check: ok");
