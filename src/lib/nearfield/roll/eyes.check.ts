// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Checks for the eye refinement (./eyes.ts). Run: npx tsx src/lib/nearfield/roll/eyes.check.ts
// Synthetic pairs with a known eye difference, the solver's constraints, and parity with the Python study
// (tools/nearfield/eyes/fixture_IMG_7059_IMG_7063.json, from export_fixture.py). Exits 1 on any failure.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pose } from "../../camera";
import { camToEnuMatrix } from "../lift";
import {
	dropInconsistent,
	type EyeCam,
	type EyePair,
	eyePairGate,
	pairTranslation,
	REFINE_EYES_DEFAULT,
	refineEyes,
	rodrigues,
	solveEyeOffsets,
	type Vec3,
} from "./eyes";

let failed = 0;
function ok(cond: boolean, msg: string) {
	if (!cond) {
		failed++;
		console.error(`FAIL ${msg}`);
	} else console.log(`ok   ${msg}`);
}

// deterministic PRNG
let seed = 7;
const rnd = () => {
	seed = (seed * 1103515245 + 12345) % 2 ** 31;
	return seed / 2 ** 31;
};

/** Project a world point into a camera (pixel coords, centre convention i + 0.5), null if behind / outside. */
function project(c: EyeCam, X: number[], fScale = 1, Rfix?: number[]) {
	const M = camToEnuMatrix(c.pose);
	let v = [0, 1, 2].map(
		(k) =>
			M[k] * (X[0] - c.eye[0]) +
			M[3 + k] * (X[1] - c.eye[1]) +
			M[6 + k] * (X[2] - c.eye[2]),
	);
	if (Rfix)
		v = [0, 1, 2].map(
			(k) =>
				Rfix[3 * k] * v[0] + Rfix[3 * k + 1] * v[1] + Rfix[3 * k + 2] * v[2],
		);
	if (!(v[2] > 0.1)) return null;
	const f = (c.height / 2 / Math.tan((c.pose.vfov * Math.PI) / 360)) * fScale;
	const x = c.width / 2 + (f * v[0]) / v[2];
	const y = c.height / 2 + (f * v[1]) / v[2];
	return x >= 0 && x < c.width && y >= 0 && y < c.height ? [x, y] : null;
}

function synthPair(
	tTrue: Vec3,
	o: {
		nNear: number;
		nFar: number;
		noisePx?: number;
		rotErrDeg?: number;
		focalErr?: number;
		depthErr?: number;
	},
) {
	const poseA: Pose = { yaw: 10, pitch: -5, roll: 1, vfov: 60 };
	const poseB: Pose = { yaw: 25, pitch: -4, roll: -1, vfov: 60 };
	const A: EyeCam = {
		id: "A",
		pose: poseA,
		eye: [0, 0, 1000],
		width: 1024,
		height: 768,
	};
	const Bt: EyeCam = {
		id: "B",
		pose: poseB,
		eye: [tTrue[0], tTrue[1], 1000 + tTrue[2]],
		width: 1024,
		height: 768,
	};
	// B's pose as "Rigi" knows it may carry a rotation error; the photo is taken with the TRUE pose
	const Rerr = rodrigues([0, ((o.rotErrDeg ?? 0) * Math.PI) / 180, 0]);
	const ka: number[] = [];
	const kb: number[] = [];
	const dA: number[] = [];
	const dB: number[] = [];
	const n = () => (rnd() - 0.5) * 2 * (o.noisePx ?? 0.5);
	let guard = 0;
	while (dA.length < o.nNear + o.nFar && guard++ < 100_000) {
		const far = dA.length >= o.nNear;
		const d = far ? 1500 + 2500 * rnd() : 6 + 40 * rnd();
		const yaw = ((12 + 20 * (rnd() - 0.5)) * Math.PI) / 180;
		const el = ((-8 + 10 * (rnd() - 0.5)) * Math.PI) / 180;
		const X = [
			d * Math.sin(yaw) * Math.cos(el),
			d * Math.cos(yaw) * Math.cos(el),
			1000 + d * Math.sin(el),
		];
		const pa = project(A, X);
		const pb = project(Bt, X, 1 + (o.focalErr ?? 0), Rerr);
		if (!pa || !pb) continue;
		ka.push(pa[0] + n(), pa[1] + n());
		kb.push(pb[0] + n(), pb[1] + n());
		const e = o.depthErr ?? 0;
		dA.push(Math.hypot(X[0], X[1], X[2] - 1000) * (1 + e * (rnd() - 0.5) * 2));
		const rb = Math.hypot(X[0] - Bt.eye[0], X[1] - Bt.eye[1], X[2] - Bt.eye[2]);
		dB.push(rb * (1 + e * (rnd() - 0.5) * 2));
	}
	// the solver is handed a WRONG GPS eye for B (the thing being corrected)
	const Bgps: EyeCam = {
		...Bt,
		eye: [Bt.eye[0] + 6, Bt.eye[1] - 4, Bt.eye[2]],
	};
	return { A, B: Bgps, m: { ka, kb, depthA: dA, depthB: dB } };
}

const dist = (a: number[], b: number[]) =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 1. exact data, no nuisance: t recovered
{
	const t: Vec3 = [1.2, -0.8, 0.3];
	const s = synthPair(t, { nNear: 60, nFar: 150, noisePx: 0.3 });
	const p = pairTranslation(s.A, s.B, s.m, { calib: "none" });
	ok(
		dist(p.t, t) < 0.1,
		`calib none: t ${p.t.map((v) => v.toFixed(2))} vs ${t} (err ${dist(p.t, t).toFixed(3)} m)`,
	);
	eyePairGate(p);
	ok(
		p.gate === true,
		`gate passes a clean pair (inliers ${p.inliers}, near ${p.nearInliers}, med ${p.medPx.toFixed(2)} px)`,
	);
}
// 2. relative rotation error + focal error: fixed rotations read them as translation, the nuisance fit does not
{
	const t: Vec3 = [0.5, 0.4, 0];
	const s = synthPair(t, {
		nNear: 60,
		nFar: 250,
		noisePx: 0.5,
		rotErrDeg: 1.5,
		focalErr: 0.04,
	});
	const fixed = pairTranslation(s.A, s.B, s.m, { calib: "none" });
	const cal = pairTranslation(s.A, s.B, s.m, { calib: "rot+f" });
	ok(
		dist(cal.t, t) < 0.25,
		`rot+f: t err ${dist(cal.t, t).toFixed(3)} m (rot corr ${cal.relRotCorrDeg.toFixed(2)} deg, f ${cal.focalScale.map((v) => v.toFixed(3))})`,
	);
	ok(
		dist(fixed.t, t) > 2 * dist(cal.t, t),
		`fixed rotations are worse (${dist(fixed.t, t).toFixed(2)} m)`,
	);
}
// 3. zero baseline (same spot, GPS says 7 m apart): t ~ 0
{
	const s = synthPair([0, 0, 0], {
		nNear: 50,
		nFar: 200,
		noisePx: 0.5,
		rotErrDeg: 1,
		depthErr: 0.3,
	});
	const p = pairTranslation(s.A, s.B, s.m);
	ok(
		p.baselineM < 0.3,
		`zero baseline recovered: ${p.baselineM.toFixed(3)} m (GPS ${p.gpsDist.toFixed(1)} m)`,
	);
}
// 4. far-only pair: no near evidence -> gated out
{
	const s = synthPair([30, 10, 0], { nNear: 0, nFar: 200, noisePx: 0.5 });
	const p = pairTranslation(s.A, s.B, s.m);
	eyePairGate(p);
	ok(
		p.gate === false && p.why === "no near evidence",
		`far-only pair ungated (${p.why})`,
	);
}
// 5. solver: two photos 0.2 m apart by the pair, GPS 7 m apart; mean kept, z on the DEM
{
	const slope = (e: number, n: number) => 1000 + 0.1 * e - 0.05 * n;
	const eyes: Record<string, Vec3> = {
		a: [0, 0, slope(0, 0) + 1.6],
		b: [3, 6, slope(3, 6) + 1.6],
		c: [80, 20, slope(80, 20) + 1.6],
	};
	const pair: EyePair = {
		a: "a",
		b: "b",
		ok: true,
		t: [0.2, 0, 0],
		info: [1e4, 0, 0, 0, 1e4, 0, 0, 0, 1e4],
		baselineM: 0.2,
		used: 100,
		inliers: 100,
		nearInliers: 50,
		medPx: 1,
		relRotCorrDeg: 0,
		focalScale: [1, 1],
		gpsDist: 6.7,
		gate: true,
	};
	const s = solveEyeOffsets(eyes, [pair], slope);
	const ea = s.eyes.a;
	const eb = s.eyes.b;
	ok(
		dist([eb[0] - ea[0], eb[1] - ea[1], 0], [0.2, 0, 0]) < 0.4,
		`pair honoured: b - a = ${[eb[0] - ea[0], eb[1] - ea[1]].map((v) => v.toFixed(2))}`,
	);
	ok(
		Math.abs((ea[0] + eb[0]) / 2 - 1.5) < 0.05 &&
			Math.abs((ea[1] + eb[1]) / 2 - 3) < 0.05,
		"component mean xy kept at the GPS mean",
	);
	ok(
		Math.abs(ea[2] - (slope(ea[0], ea[1]) + 1.6)) < 0.3 &&
			Math.abs(eb[2] - (slope(eb[0], eb[1]) + 1.6)) < 0.3,
		"eye z follows the DEM",
	);
	ok(dist(s.eyes.c, eyes.c) < 0.05, "a photo without pairs keeps its eye");
	// triplet gate: an inconsistent third pair is dropped
	const mk = (a: string, b: string, t: Vec3, near: number): EyePair => ({
		...pair,
		a,
		b,
		t,
		baselineM: Math.hypot(...t),
		nearInliers: near,
		gate: true,
	});
	const ps = [
		mk("a", "b", [0.2, 0, 0], 50),
		mk("b", "c", [77, 14, 0], 30),
		mk("a", "c", [2, 1, 0], 3),
	];
	dropInconsistent(ps);
	ok(
		ps[2].gate === false && !!ps[0].gate && !!ps[1].gate,
		"triplet closure drops the weakest inconsistent pair",
	);
	ok(
		refineEyes(eyes, [{ ...pair, nearInliers: 0 }], slope) === null,
		"refineEyes: nothing to do without a gated pair",
	);
}
ok(REFINE_EYES_DEFAULT === false, "default off (one pair of evidence)");

// 6. parity with the Python study on the real pair
{
	const fx = resolve(
		import.meta.dirname,
		"../../../../tools/nearfield/eyes/fixture_IMG_7059_IMG_7063.json",
	);
	if (!existsSync(fx)) console.log("skip parity (no fixture)");
	else {
		const F = JSON.parse(readFileSync(fx, "utf8"));
		const t0 = performance.now();
		const p = pairTranslation(F.A, F.B, {
			ka: F.ka,
			kb: F.kb,
			depthA: F.depthA,
			depthB: F.depthB,
		});
		const ms = performance.now() - t0;
		const py = F.python;
		ok(
			dist(p.t, py.t) < 0.05,
			`parity t: ts ${p.t.map((v) => v.toFixed(3))} py ${py.t} (${ms.toFixed(0)} ms)`,
		);
		ok(
			Math.abs(p.inliers - py.inliers) <= 5 &&
				Math.abs(p.nearInliers - py.nearInliers) <= 5,
			`parity inliers ${p.inliers}/${py.inliers}, near ${p.nearInliers}/${py.nearInliers}`,
		);
		ok(
			Math.abs(p.relRotCorrDeg - py.relRotCorrDeg) < 0.1,
			`parity rot corr ${p.relRotCorrDeg.toFixed(3)} / ${py.relRotCorrDeg}`,
		);
		eyePairGate(p);
		ok(p.gate === true, "real pair gated in");
	}
}

if (failed) {
	console.error(`${failed} check(s) failed`);
	process.exit(1);
}
console.log("all eye checks passed");
