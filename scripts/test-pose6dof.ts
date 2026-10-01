// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Tests for src/lib/pose6dof: consistency with pose.ts, minimal solvers, synthetic sweep,
 * refinePosition, and the real hand-labelled control points.
 *
 *   npx tsx scripts/test-pose6dof.ts            # full run, writes out/lead/pose6dof/results.md
 *   npx tsx scripts/test-pose6dof.ts --quick    # fewer synthetic trials
 */
import fs from "node:fs";
import path from "node:path";
import {
	focalFromVfov,
	type Pose,
	projectPoint,
	unprojectDir,
} from "../src/lib/camera";
import { cameraFromAngles } from "../src/lib/geo/camera";
import { solveFromControlPoints } from "../src/lib/geo/control-points";
import { wrap180 } from "../src/lib/geodesy";
import {
	azElFromDir,
	azimuthCorr,
	bearing,
	type Correspondence,
	cameraFrame,
	dirCorr,
	dirFromAzEl,
	dlt,
	engineFrame,
	levelCorr,
	p3p,
	pointCorr,
	priorsFromPhoto,
	project,
	pxToUV,
	refinePosition,
	rotationFromBearings,
	skylineResidual,
	solvePose6dof,
	unproject,
} from "../src/lib/pose6dof";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "out/lead/pose6dof");
fs.mkdirSync(OUT, { recursive: true });
const QUICK = process.argv.includes("--quick");
const md: string[] = [];
const log = (s = "") => {
	console.log(s);
	md.push(s);
};
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
	log(`- ${ok ? "PASS" : "**FAIL**"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
};

// deterministic RNG
let seed = 12345;
const rnd = () => {
	seed = (seed + 0x6d2b79f5) >>> 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const U = (a: number, b: number) => a + (b - a) * rnd();
const N = () =>
	Math.sqrt(-2 * Math.log(rnd() + 1e-300)) * Math.cos(2 * Math.PI * rnd());
const pct = (a: number[], q: number) => {
	if (!a.length) return Number.NaN;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};
const f2 = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const randPose = (): Pose => ({
	yaw: U(0, 360),
	pitch: U(-12, 12),
	roll: U(-6, 6),
	vfov: U(25, 70),
});

log("# pose6dof test results");
log();
log(
	`Run: ${new Date().toISOString()} — \`npx tsx scripts/test-pose6dof.ts${QUICK ? " --quick" : ""}\``,
);
log();

// ---------------------------------------------------------------- 1. consistency
log("## 1. Consistency with src/lib/pose.ts");
log();
{
	let maxP = 0;
	let maxU = 0;
	let maxJ = 0;
	let nullMismatch = 0;
	for (let i = 0; i < 2000; i++) {
		const p = randPose();
		const aspect = rnd() < 0.5 ? 4 / 3 : 3 / 4;
		const eye: [number, number, number] = [U(-50, 50), U(-50, 50), U(-20, 20)];
		const pt: [number, number, number] = [
			U(-2e4, 2e4),
			U(-2e4, 2e4),
			U(-500, 3000),
		];
		const a = projectPoint(p, aspect, eye, pt);
		const b = project(p, aspect, eye, { world: pt }, true);
		if (!a !== !b) nullMismatch++;
		if (a && b) {
			maxP = Math.max(
				maxP,
				Math.abs(a.u - b.u),
				Math.abs(a.v - b.v),
				Math.abs(a.depth - b.depth) / a.depth,
			);
			// numeric Jacobian check
			const P0 = [eye[0], eye[1], eye[2], p.yaw, p.pitch, p.roll, p.vfov];
			for (let k = 0; k < 7; k++) {
				const h = k < 3 ? 1e-3 : 1e-6;
				const q1 = P0.slice();
				const q2 = P0.slice();
				q1[k] += h;
				q2[k] -= h;
				const pp = (q: number[]) =>
					project(
						{ yaw: q[3], pitch: q[4], roll: q[5], vfov: q[6] },
						aspect,
						q,
						{ world: pt },
					);
				const r1 = pp(q1);
				const r2 = pp(q2);
				if (!r1 || !r2 || !b.Ju || !b.Jv) continue;
				const nu = (r1.u - r2.u) / (2 * h);
				const nv = (r1.v - r2.v) / (2 * h);
				const scale = Math.max(1e-6, Math.abs(nu), Math.abs(nv));
				maxJ = Math.max(
					maxJ,
					Math.abs(nu - b.Ju[k]) / scale,
					Math.abs(nv - b.Jv[k]) / scale,
				);
			}
		}
		const uu = U(0, 1);
		const vv = U(0, 1);
		const d1 = unprojectDir(p, aspect, uu, vv);
		const d2 = unproject(p, aspect, uu, vv);
		maxU = Math.max(
			maxU,
			Math.abs(d1[0] - d2[0]),
			Math.abs(d1[1] - d2[1]),
			Math.abs(d1[2] - d2[2]),
		);
		// poseBasis handedness check vs basis()
	}
	check(
		"project() == camera projectPoint (2000 random)",
		maxP < 1e-12 && nullMismatch === 0,
		`max |Δ| ${maxP.toExponential(1)}, behind-mismatch ${nullMismatch}`,
	);
	check(
		"unproject() == camera unprojectDir",
		maxU < 1e-12,
		`max |Δ| ${maxU.toExponential(1)}`,
	);
	check(
		"analytic Jacobian vs central differences",
		maxJ < 1e-4,
		`max rel err ${maxJ.toExponential(1)}`,
	);
	// direction targets == far points
	const p = randPose();
	const d = dirFromAzEl(p.yaw + 3, p.pitch + 1);
	const a = project(p, 1.5, [10, 20, 5], { dir: d });
	const b = project(p, 1.5, [0, 0, 0], { world: d.map((x) => x * 1e12) });
	check(
		"direction target == point at infinity (independent of eye)",
		!!a && !!b && Math.abs(a.u - b.u) < 1e-9 && Math.abs(a.v - b.v) < 1e-9,
	);
	const [az, el] = azElFromDir(dirFromAzEl(123.4, -5.6));
	check(
		"azEl round trip",
		Math.abs(az - 123.4) < 1e-9 && Math.abs(el + 5.6) < 1e-9,
	);
	// cross-check angle convention against session 0f's camera.ts (same yaw/pitch/roll semantics)
	let maxC = 0;
	for (let i = 0; i < 200; i++) {
		const q = randPose();
		const W = 4032;
		const Hh = 3024;
		const cam = cameraFromAngles({
			width: W,
			height: Hh,
			f: focalFromVfov(q.vfov, Hh),
			yaw: q.yaw,
			pitch: q.pitch,
			roll: q.roll,
		});
		const dd = dirFromAzEl(q.yaw + U(-10, 10), q.pitch + U(-8, 8));
		const c = [0, 1, 2].map(
			(k) => cam.east[k] * dd[0] + cam.north[k] * dd[1] + cam.up[k] * dd[2],
		);
		const r = project(q, W / Hh, [0, 0, 0], { dir: dd });
		if (!r || c[2] <= 0) continue;
		const x = cam.cx + (cam.f * c[0]) / c[2];
		const y = cam.cy + (cam.f * c[1]) / c[2];
		maxC = Math.max(maxC, Math.abs(x - r.u * W), Math.abs(y - r.v * Hh));
	}
	check(
		"angles match session 0f's geo/camera.ts convention",
		maxC < 1e-6,
		`max |Δ| ${maxC.toExponential(1)} px`,
	);
}
log();

// ---------------------------------------------------------------- 2. minimal solvers
log("## 2. Minimal solvers (noise-free)");
log();
{
	let p3pOk = 0;
	let dltOk = 0;
	let rotOk = 0;
	const T = 200;
	let p3pErr = 0;
	for (let t = 0; t < T; t++) {
		const pose = randPose();
		const aspect = 4 / 3;
		const eye: [number, number, number] = [U(-40, 40), U(-40, 40), U(-10, 10)];
		const mk = () => {
			const u = U(0.05, 0.95);
			const v = U(0.05, 0.95);
			const d = unproject(pose, aspect, u, v);
			const r = Math.exp(U(Math.log(500), Math.log(30000)));
			return {
				u,
				v,
				world: [eye[0] + d[0] * r, eye[1] + d[1] * r, eye[2] + d[2] * r] as [
					number,
					number,
					number,
				],
				d,
			};
		};
		const pts = Array.from({ length: 8 }, mk);
		// P3P
		const sols = p3p(
			pts.slice(0, 3).map((q) => bearing(q.u, q.v, pose.vfov, aspect)),
			pts.slice(0, 3).map((q) => q.world),
			pose.vfov,
		);
		const bestP = Math.min(
			...sols.map(
				(s) =>
					Math.hypot(s.eye[0] - eye[0], s.eye[1] - eye[1], s.eye[2] - eye[2]) +
					Math.abs(wrap180(s.pose.yaw - pose.yaw)) * 100,
			),
		);
		if (bestP < 1) p3pOk++;
		p3pErr = Math.max(p3pErr, Number.isFinite(bestP) ? 0 : 1);
		// DLT
		const r = dlt(pts, aspect);
		if (
			r &&
			Math.hypot(r.eye[0] - eye[0], r.eye[1] - eye[1], r.eye[2] - eye[2]) < 1 &&
			Math.abs(wrap180(r.pose.yaw - pose.yaw)) < 1e-3 &&
			Math.abs(r.pose.vfov - pose.vfov) < 1e-3
		)
			dltOk++;
		// rotation from 2 bearings (eye at origin → directions exact when using d)
		const rp = rotationFromBearings(
			pts.slice(0, 2).map((q) => [q.u, q.v] as [number, number]),
			pts.slice(0, 2).map((q) => q.d),
			pose.vfov,
			aspect,
		);
		if (
			Math.abs(wrap180(rp.yaw - pose.yaw)) < 1e-6 &&
			Math.abs(rp.pitch - pose.pitch) < 1e-6 &&
			Math.abs(rp.roll - pose.roll) < 1e-6
		)
			rotOk++;
	}
	check(
		"P3P (Grunert) recovers pose+eye",
		p3pOk >= T * 0.97,
		`${p3pOk}/${T} within 1 m (remaining are near-degenerate small-angle triangles)`,
	);
	check(
		"DLT (8 pts) recovers pose+eye+vfov",
		dltOk >= T * 0.95,
		`${dltOk}/${T}`,
	);
	check("2-point rotation (Horn) exact", rotOk === T, `${rotOk}/${T}`);
}
log();

// ---------------------------------------------------------------- 3. synthetic sweep
log("## 3. Synthetic sweep");
log();
log(
	"Random pose (yaw 0–360°, pitch ±12°, roll ±6°, vfov 25–70°), 4:3 image 4032 px wide. Points 0.5–30 km (log-uniform) inside the frame;",
);
log(
	"pixel noise σ ~ U(0,3) px; outliers U(0,30 %) (uniform random pixel); GPS error: per-trial scale s ~ U(0,50) m, offset ~ N(0, s/√2) per horizontal axis and N(0, 0.75 s) vertical;",
);
log(
	"priors: position 0 with σH = max(s,5), σV = max(1.5 s,10); pitch/roll = truth + N(0,2°) σ 2°; yaw = truth + N(0,10°) σ 10°; vfov = truth·(1+N(0,3 %)) σ 3 %.",
);
log(
	'Success = |Δyaw|,|Δpitch|,|Δroll| < 0.5° and |Δvfov| < 1°. Errors are |estimate − truth|. "σ-cal" = share of angle errors within 2σ of the reported covariance.',
);
log();
type Trial = {
	n: number;
	ok: boolean;
	dy: number;
	dp: number;
	dr: number;
	dv: number;
	dpos: number;
	dposPrior: number;
	ms: number;
	cal: number;
	calN: number;
	outFrac: number;
	inlierRecall: number;
	outlierReject: number;
};
const trials: Trial[] = [];
{
	const W = 4032;
	const aspect = 4 / 3;
	const perN = QUICK ? 40 : 150;
	for (let n = 3; n <= 15; n++)
		for (let t = 0; t < perN; t++) {
			const pose = randPose();
			const s = U(0, 50);
			const eye: [number, number, number] = [
				(N() * s) / Math.SQRT2,
				(N() * s) / Math.SQRT2,
				N() * 0.75 * s,
			];
			const noise = U(0, 3);
			const outFrac = n >= 5 ? U(0, 0.3) : 0; // with ≤4 points outliers are unidentifiable
			const corrs: Correspondence[] = [];
			const isOut: boolean[] = [];
			for (let i = 0; i < n; i++) {
				let u = U(0.03, 0.97);
				let v = U(0.03, 0.97);
				const d = unproject(pose, aspect, u, v);
				const r = Math.exp(U(Math.log(500), Math.log(30000)));
				const world: [number, number, number] = [
					eye[0] + d[0] * r,
					eye[1] + d[1] * r,
					eye[2] + d[2] * r,
				];
				const out = rnd() < outFrac;
				if (out) {
					u = U(0, 1);
					v = U(0, 1);
				} else {
					u += (N() * noise) / W;
					v += (N() * noise) / (W / aspect);
				}
				isOut.push(out);
				corrs.push({ kind: "point", u, v, world });
			}
			const priors = {
				position: {
					value: [0, 0, 0] as [number, number, number],
					sigmaH: Math.max(s, 5),
					sigmaV: Math.max(1.5 * s, 10),
				},
				yaw: { value: pose.yaw + N() * 10, sigma: 10 },
				pitch: { value: pose.pitch + N() * 2, sigma: 2 },
				roll: { value: pose.roll + N() * 2, sigma: 2 },
				vfov: { value: pose.vfov * (1 + N() * 0.03), sigma: pose.vfov * 0.03 },
			};
			const t0 = performance.now();
			const res = solvePose6dof(corrs, priors, {
				aspect,
				imageWidth: W,
				sigmaPx: 2,
			});
			const ms = performance.now() - t0;
			const dy = Math.abs(wrap180(res.pose.yaw - pose.yaw));
			const dp = Math.abs(res.pose.pitch - pose.pitch);
			const dr = Math.abs(res.pose.roll - pose.roll);
			const dv = Math.abs(res.pose.vfov - pose.vfov);
			let cal = 0;
			let calN = 0;
			for (const [e, sg] of [
				[dy, res.sigma.yaw],
				[dp, res.sigma.pitch],
				[dr, res.sigma.roll],
			])
				if (Number.isFinite(sg)) {
					calN++;
					if (e <= 2 * sg) cal++;
				}
			const nIn = isOut.filter((x) => !x).length;
			const nOut = n - nIn;
			trials.push({
				n,
				ok: dy < 0.5 && dp < 0.5 && dr < 0.5 && dv < 1,
				dy,
				dp,
				dr,
				dv,
				dpos: Math.hypot(res.eyeOffset[0] - eye[0], res.eyeOffset[1] - eye[1]),
				dposPrior: Math.hypot(eye[0], eye[1]),
				ms,
				cal,
				calN,
				outFrac,
				inlierRecall: nIn
					? isOut.filter((o, i) => !o && res.inliers[i]).length / nIn
					: 1,
				outlierReject: nOut
					? isOut.filter((o, i) => o && !res.inliers[i]).length / nOut
					: 1,
			});
		}
	log(
		"| n pts | trials | success | med Δyaw° | p90 Δyaw° | med Δpitch° | med Δroll° | med Δvfov° | p90 Δvfov° | med ΔposH m (prior) | σ-cal | outlier reject | inlier recall | mean ms | p95 ms |",
	);
	log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	const buckets: [string, (t: Trial) => boolean][] = [
		...Array.from(
			{ length: 13 },
			(_, i) =>
				[`${i + 3}`, (t: Trial) => t.n === i + 3] as [
					string,
					(t: Trial) => boolean,
				],
		),
		["all", () => true],
	];
	for (const [name, f] of buckets) {
		const b = trials.filter(f);
		const m = (k: keyof Trial) => b.map((t) => t[k] as number);
		const calRate =
			b.reduce((a, t) => a + t.cal, 0) /
			Math.max(
				1,
				b.reduce((a, t) => a + t.calN, 0),
			);
		const oo = b.filter((t) => t.outFrac > 0);
		log(
			`| ${name} | ${b.length} | ${((100 * b.filter((t) => t.ok).length) / b.length).toFixed(1)}% | ${f2(pct(m("dy"), 0.5), 3)} | ${f2(pct(m("dy"), 0.9), 3)} | ${f2(pct(m("dp"), 0.5), 3)} | ${f2(pct(m("dr"), 0.5), 3)} | ${f2(pct(m("dv"), 0.5), 3)} | ${f2(pct(m("dv"), 0.9), 3)} | ${f2(pct(m("dpos"), 0.5), 1)} (${f2(pct(m("dposPrior"), 0.5), 1)}) | ${(100 * calRate).toFixed(0)}% | ${oo.length ? `${(100 * (oo.reduce((a, t) => a + t.outlierReject, 0) / oo.length)).toFixed(0)}%` : "—"} | ${(100 * (b.reduce((a, t) => a + t.inlierRecall, 0) / b.length)).toFixed(0)}% | ${f2(b.reduce((a, t) => a + t.ms, 0) / b.length, 1)} | ${f2(pct(m("ms"), 0.95), 1)} |`,
		);
	}
	log();
	const big = trials.filter((t) => t.n >= 6);
	const sr = big.filter((t) => t.ok).length / big.length;
	check(
		"synthetic success rate n ≥ 6 ≥ 95 %",
		sr >= 0.95,
		`${(100 * sr).toFixed(1)}%`,
	);
	const sm = trials.filter((t) => t.n === 4 || t.n === 5);
	const sr2 = sm.filter((t) => t.ok).length / sm.length;
	check(
		"synthetic success rate n = 4–5 ≥ 85 %",
		sr2 >= 0.85,
		`${(100 * sr2).toFixed(1)}%`,
	);
	// n = 3: position stays at GPS (ladder), so a GPS error e at the nearest point's range r costs ~e/r rad —
	// physically unrecoverable; require only that the reported σ accounts for it.
	const s3 = trials.filter((t) => t.n === 3);
	const cal3 =
		s3.reduce((a, t) => a + t.cal, 0) /
		Math.max(
			1,
			s3.reduce((a, t) => a + t.calN, 0),
		);
	check(
		"n = 3: reported σ covers the GPS-induced error (≥ 80 % of angle errors within 2σ)",
		cal3 >= 0.8,
		`${(100 * cal3).toFixed(0)}%`,
	);
	const calAll =
		trials.reduce((a, t) => a + t.cal, 0) /
		Math.max(
			1,
			trials.reduce((a, t) => a + t.calN, 0),
		);
	check(
		"σ calibration: ≥ 85 % of angle errors within 2σ (ideal 95 %)",
		calAll >= 0.85,
		`${(100 * calAll).toFixed(0)}%`,
	);
	const p95 = pct(
		trials.map((t) => t.ms),
		0.95,
	);
	check("p95 solve time < 50 ms", p95 < 50, `${p95.toFixed(1)} ms`);
}
log();

// ---- 3b. direction-only + level points
log(
	"### 3b. Mixed direction-only / level / azimuth-only correspondences (position fixed by construction)",
);
log();
{
	const W = 4032;
	const aspect = 4 / 3;
	let ok = 0;
	let ok3 = 0;
	let n3 = 0;
	const T = QUICK ? 60 : 200;
	const errs: number[] = [];
	for (let t = 0; t < T; t++) {
		const pose = randPose();
		const n = 3 + Math.floor(rnd() * 6);
		const corrs: Correspondence[] = [];
		for (let i = 0; i < n; i++) {
			const u = U(0.03, 0.97);
			const v = U(0.03, 0.97);
			const d = unproject(pose, aspect, u, v);
			const [az, el] = azElFromDir(d);
			const nu = u + (N() * 1.5) / W;
			const nv = v + (N() * 1.5) / (W / aspect);
			if (i < 2 && rnd() < 0.5) corrs.push(levelCorr(el, nu, nv));
			else if (i === 2 && rnd() < 0.4) corrs.push(azimuthCorr(az, nu, nv));
			else corrs.push(dirCorr(az, el, nu, nv));
		}
		const priors = {
			yaw: { value: pose.yaw + N() * 10, sigma: 10 },
			pitch: { value: pose.pitch + N() * 2, sigma: 2 },
			roll: { value: pose.roll + N() * 2, sigma: 2 },
			vfov: { value: pose.vfov * (1 + N() * 0.03), sigma: pose.vfov * 0.03 },
		};
		const r = solvePose6dof(corrs, priors, {
			aspect,
			imageWidth: W,
			sigmaPx: 1.5,
		});
		const e = Math.max(
			Math.abs(wrap180(r.pose.yaw - pose.yaw)),
			Math.abs(r.pose.pitch - pose.pitch),
			Math.abs(r.pose.roll - pose.roll),
		);
		errs.push(e);
		const good = e < 0.5;
		if (good) ok++;
		const nEff = corrs.reduce((a, c) => a + (c.kind === "dir" ? 1 : 0.5), 0);
		if (nEff >= 3) {
			n3++;
			if (good) ok3++;
		}
	}
	log(
		`- all ${T} trials: ${ok}/${T} within 0.5°; median max-angle err ${f2(pct(errs, 0.5), 3)}°, p90 ${f2(pct(errs, 0.9), 3)}° (misses have < 3 effective points, so vfov stays at its ±3 % prior as the ladder prescribes)`,
	);
	check(
		"dir/level/azimuth, ≥ 3 effective points: rotation < 0.5° in ≥ 95 %",
		ok3 >= n3 * 0.95,
		`${ok3}/${n3}`,
	);
	// unknown compass
	let ok2 = 0;
	for (let t = 0; t < 100; t++) {
		const pose = randPose();
		const corrs: Correspondence[] = [];
		for (let i = 0; i < 4; i++) {
			const u = U(0.05, 0.95);
			const v = U(0.05, 0.95);
			const d = unproject(pose, aspect, u, v);
			corrs.push({
				kind: "point",
				u: u + N() / W,
				v: v + N() / (W / aspect),
				world: [d[0] * 8000, d[1] * 8000, d[2] * 8000],
			});
		}
		const r = solvePose6dof(
			corrs,
			{
				yaw: { value: 0 },
				pitch: { value: pose.pitch + N(), sigma: 2 },
				roll: { value: pose.roll + N(), sigma: 2 },
				vfov: { value: pose.vfov, sigma: pose.vfov * 0.03 },
			},
			{ aspect, imageWidth: W, sigmaPx: 1 },
		);
		if (Math.abs(wrap180(r.pose.yaw - pose.yaw)) < 0.3) ok2++;
	}
	check(
		"unknown compass (yaw prior absent), 4 points",
		ok2 >= 97,
		`${ok2}/100`,
	);
	// 1 and 2 pins: ladder
	const pose = { yaw: 100, pitch: 2, roll: 1, vfov: 50 };
	const d1 = unproject(pose, aspect, 0.3, 0.4);
	const r1 = solvePose6dof(
		[{ kind: "dir", u: 0.3, v: 0.4, dir: d1 }],
		{
			yaw: { value: 90, sigma: 10 },
			pitch: { value: 1, sigma: 2 },
			roll: { value: 1, sigma: 2 },
			vfov: { value: 50, sigma: 1.5 },
		},
		{ aspect, imageWidth: W },
	);
	check(
		"1 pin → yaw+pitch only",
		r1.activeParams.join() === "yaw,pitch" && r1.residualsPx[0] < 0.1,
		`active ${r1.activeParams.join()}, res ${r1.residualsPx[0].toExponential(1)} px`,
	);
}
log();

// ---- 3c. Regression tests from review (frame/eye, inlier mask, held priors, refine grid, position unlock)
const seedBefore3c = seed;
log(
	"### 3c. Review regressions: engine frame + eye, inlier mask < 5 pts, σ = 0 priors, refine grid, position unlock",
);
log();
{
	const W = 1600;
	const aspect = 4 / 3;
	const truth: Pose = { yaw: 65, pitch: -2, roll: -0.3, vfov: 52 };
	// (a) the app's engine frame: EnuFrame(lat, lon, 0), eye at (0, 0, eyeAlt) — here 560 m
	const eyeE: [number, number, number] = [0, 0, 560];
	const uvs = [
		[0.2, 0.35],
		[0.45, 0.42],
		[0.7, 0.3],
		[0.85, 0.45],
	];
	const ranges = [9000, 14000, 22000, 6000];
	const mk = (
		eye: number[],
		pose: Pose,
		uv: number[][],
		rs: number[],
	): Correspondence[] =>
		uv.map(([u, v], i) => {
			const d = unproject(pose, aspect, u, v);
			return {
				kind: "point",
				u,
				v,
				world: [
					eye[0] + d[0] * rs[i],
					eye[1] + d[1] * rs[i],
					eye[2] + d[2] * rs[i],
				],
			};
		});
	const corrsE = mk(eyeE, truth, uvs, ranges);
	const photo = { hAccuracy: 10, heading: 60, pitch: -1, roll: 0.5, vfov: 50 };
	const good = solvePose6dof(corrsE, priorsFromPhoto(photo, { eye: eyeE }), {
		aspect,
		imageWidth: W,
		sigmaPx: 2,
	});
	const bad = solvePose6dof(corrsE, priorsFromPhoto(photo), {
		aspect,
		imageWidth: W,
		sigmaPx: 2,
	});
	const angErr = (r: { pose: Pose }) =>
		Math.max(
			Math.abs(wrap180(r.pose.yaw - truth.yaw)),
			Math.abs(r.pose.pitch - truth.pitch),
			Math.abs(r.pose.roll - truth.roll),
		);
	const dEye = Math.hypot(
		good.eyeOffset[0] - eyeE[0],
		good.eyeOffset[1] - eyeE[1],
		good.eyeOffset[2] - eyeE[2],
	);
	check(
		"engine frame (h=0, eye z=560) with priorsFromPhoto(photo, {eye}): exact pose, eyeOffset is the absolute eye, all inliers",
		angErr(good) < 0.01 && dEye < 1 && good.inliers.every(Boolean),
		`max angle err ${angErr(good).toExponential(1)}°, eyeOffset [${good.eyeOffset.map((x) => x.toFixed(2)).join(", ")}]`,
	);
	log(
		`- info: same input with the default position prior [0,0,0] (wrong frame for the engine) → max angle err ${f2(angErr(bad), 2)}° — why API.md requires {eye}`,
	);
	// engineFrame vs cameraFrame(lat, lon, eyeAlt): same pose from the same geo inputs
	{
		const lat = 46.5;
		const lon = 8.0;
		const alt = 1800;
		const peaks = [
			[46.6, 8.06, 3200],
			[46.58, 7.95, 2900],
			[46.65, 8.0, 3500],
			[46.62, 7.96, 2600],
			[46.7, 8.05, 3000],
		]; // all north of the eye
		const fE = engineFrame(lat, lon);
		const fC = cameraFrame(lat, lon, alt);
		const tp: Pose = { yaw: 0, pitch: 3, roll: 1, vfov: 60 };
		// project peaks from the engine eye to get pixels
		const eyeA = [0, 0, alt];
		const px = peaks.map(([la, lo, h]) =>
			projectPoint(tp, aspect, eyeA, fE.fromGeo(la, lo, h)),
		);
		const ok = px.every((p) => p && p.u > 0 && p.u < 1 && p.v > 0 && p.v < 1);
		const cE = peaks.map(([la, lo, h], i) =>
			pointCorr(fE, la, lo, h, px[i]!.u, px[i]!.v),
		);
		const cC = peaks.map(([la, lo, h], i) =>
			pointCorr(fC, la, lo, h, px[i]!.u, px[i]!.v),
		);
		const ph = { hAccuracy: 10, heading: 5, pitch: 2, roll: 0, vfov: 58 };
		const rE = solvePose6dof(cE, priorsFromPhoto(ph, { eye: eyeA }), {
			aspect,
			imageWidth: W,
		});
		const rC = solvePose6dof(cC, priorsFromPhoto(ph), {
			aspect,
			imageWidth: W,
		});
		const dd = Math.max(
			Math.abs(wrap180(rE.pose.yaw - rC.pose.yaw)),
			Math.abs(rE.pose.pitch - rC.pose.pitch),
			Math.abs(rE.pose.roll - rC.pose.roll),
		);
		check(
			"engineFrame + {eye:[0,0,alt]} ≡ cameraFrame(lat, lon, alt) + default prior (geo peaks)",
			ok && dd < 0.01 && Math.abs(wrap180(rE.pose.yaw - tp.yaw)) < 0.01,
			`Δ between frames ${dd.toExponential(1)}°, yaw err ${Math.abs(wrap180(rE.pose.yaw - tp.yaw)).toExponential(1)}°`,
		);
	}
	// (b) < 5 points: nothing rejected, so inliers / RMS cover all 4, overThreshold flags the miss
	const c4 = corrsE.map((c) => ({ ...c })) as Correspondence[];
	c4[3] = { ...c4[3], u: c4[3].u + 60 / W };
	const r4 = solvePose6dof(c4, priorsFromPhoto(photo, { eye: eyeE }), {
		aspect,
		imageWidth: W,
		sigmaPx: 2,
	});
	const rmsAll = Math.sqrt(
		r4.residualsPx.reduce((a, x) => a + x * x, 0) / r4.residualsPx.length,
	);
	check(
		"< 5 effective points: inliers all-true, RMS over all fitted points (not hiding the miss), overThreshold flags it",
		r4.inliers.every(Boolean) &&
			Math.abs(r4.rmsPx - rmsAll) < 1e-9 &&
			r4.overThreshold[3] &&
			r4.rmsPx > 10,
		`inliers ${r4.inliers.map(Number).join("")}, over ${r4.overThreshold.map(Number).join("")}, res ${r4.residualsPx.map((x) => x.toFixed(1)).join(" ")}, rms ${r4.rmsPx.toFixed(2)}`,
	);
	// ≥ 5 points: a real outlier is rejected and inliers == the fitted set
	{
		const uv6 = [...uvs, [0.3, 0.6], [0.6, 0.55]];
		const c6 = mk(eyeE, truth, uv6, [...ranges, 11000, 17000]);
		c6[1] = { ...c6[1], v: c6[1].v + 80 / (W / aspect) };
		const r6 = solvePose6dof(c6, priorsFromPhoto(photo, { eye: eyeE }), {
			aspect,
			imageWidth: W,
			sigmaPx: 2,
		});
		check(
			"≥ 5 points: outlier rejected, inliers = !overThreshold, pose exact",
			!r6.inliers[1] &&
				r6.inliers.filter(Boolean).length === 5 &&
				r6.inliers.every((x, i) => x === !r6.overThreshold[i]) &&
				angErr(r6) < 0.01,
			`inliers ${r6.inliers.map(Number).join("")}, err ${angErr(r6).toExponential(1)}°`,
		);
	}
	// (c) σ = 0 holds the parameter exactly; position σ 0 gives finite σ elsewhere; negative σ throws
	const two = corrsE.slice(0, 2);
	const pz = priorsFromPhoto(photo, { eye: eyeE });
	const rz = solvePose6dof(
		two,
		{ ...pz, yaw: { value: 63, sigma: 0 } },
		{ aspect, imageWidth: W },
	);
	check(
		"yaw prior σ 0 → yaw held exactly, not active, σ 0",
		rz.pose.yaw === 63 &&
			!rz.activeParams.includes("yaw") &&
			rz.sigma.yaw === 0,
		`yaw ${rz.pose.yaw}, active ${rz.activeParams.join()}, σyaw ${rz.sigma.yaw}`,
	);
	const six = mk(
		eyeE,
		truth,
		[...uvs, [0.3, 0.6], [0.6, 0.55]],
		[800, 1200, 2000, 600, 900, 1500],
	);
	const rp = solvePose6dof(
		six,
		{ ...pz, position: { value: eyeE, sigmaH: 0, sigmaV: 0 } },
		{ aspect, imageWidth: W, minParallaxPx: 0 },
	);
	const sv = Object.values(rp.sigma);
	check(
		"position σH = σV = 0 → eye held, position inactive, every σ finite",
		sv.every(Number.isFinite) &&
			rp.eyeOffset.every((x, i) => x === eyeE[i]) &&
			!rp.activeParams.includes("dx") &&
			rp.sigma.dx === 0 &&
			angErr(rp) < 0.01,
		`σ ${sv.map((x) => f2(x, 3)).join("/")}, active ${rp.activeParams.join()}`,
	);
	let threw = false;
	try {
		solvePose6dof(
			two,
			{ ...pz, pitch: { value: 0, sigma: -1 } },
			{ aspect, imageWidth: W },
		);
	} catch {
		threw = true;
	}
	check("negative prior σ throws RangeError", threw);
	// (d) refinePosition grid only moves refined axes
	{
		const resid = (pose: Pose, eye: [number, number, number]) =>
			corrsE.flatMap((c) => {
				const p = projectPoint(
					pose,
					aspect,
					eye,
					(c as { world: number[] }).world,
				);
				return p
					? [(p.u - c.u) * W, ((p.v - c.v) * W) / aspect]
					: [Number.NaN, Number.NaN];
			});
		const start: Pose = { ...truth, yaw: truth.yaw + 0.3 };
		const ry = await refinePosition(start, eyeE, resid, {
			params: ["yaw"],
			grid: { radius: 20, step: 10, dz: [-10, 0, 10] },
		});
		check(
			"refinePosition(params [yaw], grid) leaves the eye untouched and fixes yaw",
			ry.eye.every((x, i) => x === eyeE[i]) &&
				Math.abs(wrap180(ry.pose.yaw - truth.yaw)) < 1e-3,
			`eye [${ry.eye.join(", ")}], yaw err ${Math.abs(wrap180(ry.pose.yaw - truth.yaw)).toExponential(1)}°, ${ry.evaluations} evals`,
		);
		const rxy = await refinePosition(truth, eyeE, resid, {
			params: ["dx", "dy"],
			grid: { radius: 20, step: 10, dz: [-10, 0, 10] },
		});
		check(
			"refinePosition(params [dx,dy], grid with dz) never moves dz",
			rxy.eye[2] === eyeE[2],
			`eye [${rxy.eye.map((x) => x.toFixed(2)).join(", ")}]`,
		);
	}
	// (e) position must unlock: near finite points (0.4–3 km), 30 m GPS error, 1 px noise
	{
		let unlocked = 0;
		let good6 = 0;
		const T = QUICK ? 20 : 60;
		const errs: number[] = [];
		for (let t = 0; t < T; t++) {
			const pose = randPose();
			const gps: [number, number, number] = [N() * 21, N() * 21, N() * 15];
			const trueEye: [number, number, number] = [
				eyeE[0] + gps[0],
				eyeE[1] + gps[1],
				eyeE[2] + gps[2],
			];
			const corrs: Correspondence[] = [];
			for (let i = 0; i < 8; i++) {
				const u = U(0.05, 0.95);
				const v = U(0.05, 0.95);
				const d = unproject(pose, aspect, u, v);
				const r = Math.exp(U(Math.log(400), Math.log(3000)));
				corrs.push({
					kind: "point",
					u: u + N() / W,
					v: v + N() / (W / aspect),
					world: [
						trueEye[0] + d[0] * r,
						trueEye[1] + d[1] * r,
						trueEye[2] + d[2] * r,
					],
				});
			}
			const r = solvePose6dof(
				corrs,
				{
					position: { value: eyeE, sigmaH: 30, sigmaV: 30 },
					yaw: { value: pose.yaw + N() * 10, sigma: 10 },
					pitch: { value: pose.pitch + N() * 2, sigma: 2 },
					roll: { value: pose.roll + N() * 2, sigma: 2 },
					vfov: {
						value: pose.vfov * (1 + N() * 0.03),
						sigma: pose.vfov * 0.03,
					},
				},
				{ aspect, imageWidth: W, sigmaPx: 1 },
			);
			if (r.activeParams.includes("dx")) unlocked++;
			const de = Math.hypot(
				r.eyeOffset[0] - trueEye[0],
				r.eyeOffset[1] - trueEye[1],
				r.eyeOffset[2] - trueEye[2],
			);
			errs.push(de);
			if (
				de < 5 &&
				Math.max(
					Math.abs(wrap180(r.pose.yaw - pose.yaw)),
					Math.abs(r.pose.pitch - pose.pitch),
					Math.abs(r.pose.roll - pose.roll),
				) < 0.2
			)
				good6++;
		}
		seed = seedBefore3c; // 3c must not shift the RNG stream of later sections
		check(
			"near-field (0.4–3 km, 8 pts, ~30 m GPS error): position unlocks and eye < 5 m, angles < 0.2° in ≥ 90 %",
			unlocked === T && good6 >= 0.9 * T,
			`unlocked ${unlocked}/${T}, good ${good6}/${T}, median eye err ${f2(pct(errs, 0.5), 2)} m (prior error ~${f2(Math.hypot(21, 21, 15), 0)} m)`,
		);
	}
}
log();

// ---------------------------------------------------------------- 4. refinePosition
log("## 4. refinePosition (near-field silhouette, generic residual callback)");
log();
{
	const W = 1600;
	const aspect = 4 / 3;
	const Hh = W / aspect;
	const truth: Pose = { yaw: 40, pitch: -3, roll: 1, vfov: 53 };
	const trueEye: [number, number, number] = [18, -25, 6];
	// two silhouette layers: a near cliff edge 100–400 m away and a far range 11–19 km away
	const layers: [number, number, number][][] = [[], []];
	for (let i = 0; i <= 160; i++) {
		const d = dirFromAzEl(truth.yaw - 40 + i * 0.5, 0);
		const rN = 250 + 150 * Math.sin(i * 0.05);
		const hN = -20 + 25 * Math.sin(i * 0.09) + 10 * Math.sin(i * 0.23);
		layers[0].push([
			trueEye[0] + d[0] * rN,
			trueEye[1] + d[1] * rN,
			trueEye[2] + hN,
		]);
		const rF = 15000 + 4000 * Math.sin(i * 0.03);
		const hF = 900 + 300 * Math.sin(i * 0.07);
		layers[1].push([
			trueEye[0] + d[0] * rF,
			trueEye[1] + d[1] * rF,
			trueEye[2] + hF,
		]);
	}
	// predicted skyline at columns us = topmost (min v) of the projected layer polylines —
	// stands in for 9e's horizon render at a shifted eye
	const predictV = (
		pose: Pose,
		eye: [number, number, number],
		us: number[],
	) => {
		const polys = layers.map((L) =>
			L.map((w) => project(pose, aspect, eye, { world: w })).filter(
				(p): p is NonNullable<typeof p> => !!p,
			),
		);
		return us.map((u) => {
			let best: number | null = null;
			for (const P of polys)
				for (let i = 0; i + 1 < P.length; i++) {
					const a = P[i];
					const b = P[i + 1];
					if ((a.u - u) * (b.u - u) <= 0 && a.u !== b.u) {
						const v = a.v + ((u - a.u) / (b.u - a.u)) * (b.v - a.v);
						if (best === null || v < best) best = v;
					}
				}
			return best;
		});
	};
	const obsU = Array.from({ length: 120 }, (_, i) => 0.02 + (i / 119) * 0.96);
	const obsV = predictV(truth, trueEye, obsU);
	const samples = obsU
		.map((u, i) => ({ u, v: (obsV[i] ?? Number.NaN) + (N() * 0.7) / Hh }))
		.filter((s) => Number.isFinite(s.v));
	const fn = skylineResidual(samples, predictV, Hh);
	const startPose = {
		...truth,
		yaw: truth.yaw + 0.4,
		pitch: truth.pitch - 0.3,
	};
	const res = await refinePosition(startPose, [0, 0, 0], fn, {
		params: ["dx", "dy", "dz", "yaw", "pitch", "roll"],
		priors: { position: { value: [0, 0, 0], sigmaH: 30, sigmaV: 30 } },
		huber: 3,
		steps: { dx: 0.5, dy: 0.5, dz: 0.5, yaw: 0.005, pitch: 0.005, roll: 0.005 },
		grid: { radius: 45, step: 7.5, dz: [-10, 0, 10] },
		maxIterations: 60,
		central: true,
	});
	const dPos = Math.hypot(
		res.eye[0] - trueEye[0],
		res.eye[1] - trueEye[1],
		res.eye[2] - trueEye[2],
	);
	const rmsStart = Math.sqrt(res.initialCost / samples.length);
	const rmsEnd = Math.sqrt(res.cost / samples.length);
	log(
		`start eye error ${Math.hypot(...trueEye).toFixed(1)} m (near layer 100–400 m), rot error 0.4°/0.3°, grid ±45 m @7.5 m then LM → eye error ${dPos.toFixed(2)} m, Δyaw ${wrap180(res.pose.yaw - truth.yaw).toFixed(3)}°, Δpitch ${(res.pose.pitch - truth.pitch).toFixed(3)}°; ` +
			`cost-RMS ${rmsStart.toFixed(1)} → ${rmsEnd.toFixed(2)} px; ${res.iterations} it, ${res.evaluations} residual evals; σ dx ${f2(res.sigma.dx ?? Number.NaN)} m`,
	);
	check(
		"refinePosition recovers a 31 m eye offset from a near-field skyline (< 1.5 m, |Δyaw| < 0.1°, converged)",
		dPos < 1.5 &&
			res.converged &&
			Math.abs(wrap180(res.pose.yaw - truth.yaw)) < 0.1,
		`${dPos.toFixed(2)} m, ${res.evaluations - 13 * 13 * 3} LM evals after the grid`,
	);
}
log();

// ---------------------------------------------------------------- 5. real control points
log("## 5. Real hand-labelled control points (data/control-points.json)");
log();
type StoredPoint = {
	x: number;
	y: number;
	peak?: string;
	az?: number;
	el?: number;
	level?: boolean;
	lat?: number;
	lon?: number;
	h?: number;
	label?: string;
};
type Entry = {
	basis: number;
	solveFocal?: boolean;
	quality?: string;
	points: StoredPoint[];
};
type Photo = {
	id: string;
	width: number;
	height: number;
	lat: number;
	lon: number;
	alt: number;
	hAccuracy?: number;
	heading?: number;
	pitch?: number;
	roll?: number;
	vfov: number;
	region: string;
};
type Peak = { name: string; lat: number; lon: number; ele: number };
{
	const cps = JSON.parse(
		fs.readFileSync(path.join(ROOT, "data/control-points.json"), "utf8"),
	) as Record<string, Entry>;
	const gt = JSON.parse(
		fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
	) as Record<
		string,
		{
			width: number;
			height: number;
			yaw: number;
			pitch: number;
			roll: number;
			f: number;
			rmsPx1600?: number;
			eye?: number;
		}
	>;
	const gtSkipped: string[] = [];
	const photos = JSON.parse(
		fs.readFileSync(path.join(ROOT, "public/photos/photos.json"), "utf8"),
	) as Photo[];
	const regions = new Map<string, Peak[]>();
	const regionPeaks = (id: string) => {
		if (!regions.has(id))
			regions.set(
				id,
				(
					JSON.parse(
						fs.readFileSync(
							path.join(ROOT, `public/photos/${id}.json`),
							"utf8",
						),
					) as { peaks: Peak[] }
				).peaks,
			);
		return regions.get(id) as Peak[];
	};
	log(
		"Priors from photos.json (GPS σH = max(hAccuracy,5) m, σV = max(1.5σH,10) m, gravity σ 2°, compass σ 10°, vfov σ 3 %); pixel σ 3 px on the 1600-px basis (hand labels), Huber k = 2σ, inlier threshold 25 px.",
	);
	log(
		"Peaks: OSM lat/lon/ele from public/photos/region-*.json → ENU via geodesy.ts (k=0.13 refraction). az/el points → direction-only; `level` → elevation-only.",
	);
	log(
		'"fixed" = position held at GPS (rotation+focal only); "6dof" = full ladder (position unlocks at ≥4 effective points with ≥3 finite peaks, and only if a 1σ GPS shift moves some peak by ≥2σ px); "6dof-forced" = same without the parallax test (shown for ≥3 peaks); "LS" = plain least squares, flat angle priors, no Huber.',
	);
	log(
		'"0f" = session 0f\'s solveFromControlPoints (rotation+focal, peaks as directions from the GPS eye) on the same inputs, for cross-checking.',
	);
	log();
	log(
		"| photo | pts (peak/dir/level/az) | mode | yaw | pitch | roll | vfov | Δyaw vs GT | Δpitch vs GT | Δroll vs GT | RMS px@1600 | eye shift [E,N,U] m | σ yaw/pitch/roll ° | inliers |",
	);
	log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	const realRows: string[] = [];
	const gtStats: {
		id: string;
		mode: string;
		d: number[];
		s: number[];
		shift: number;
	}[] = [];
	for (const [id, e] of Object.entries(cps)) {
		const ph = photos.find((p) => p.id === id);
		if (!ph) {
			log(`| ${id} | — | skipped: not in photos.json | | | | | | | | | | | |`);
			continue;
		}
		const aspect = ph.width / ph.height;
		// the app's engine frame (origin at h = 0) with the eye at the photo altitude, as API.md prescribes
		const frame = engineFrame(ph.lat, ph.lon);
		// eye height: 0f's GT eye (max(GPS, DEM + 1.6), like engine.ts) when present, else GPS altitude
		const eyeP: [number, number, number] = [0, 0, gt[id]?.eye ?? ph.alt];
		const peaks = regionPeaks(ph.region);
		const corrs: Correspondence[] = [];
		const missing: string[] = [];
		for (const sp of e.points) {
			const { u, v } = pxToUV(sp.x, sp.y, e.basis, aspect);
			if (sp.peak) {
				const cands = peaks.filter((p) => p.name === sp.peak);
				if (!cands.length) {
					missing.push(sp.peak);
					continue;
				}
				const pk = cands
					.map((p) => ({
						p,
						d: Math.hypot(...frame.fromGeo(p.lat, p.lon, p.ele).slice(0, 2)),
					}))
					.sort((a, b) => a.d - b.d)[0].p;
				corrs.push(pointCorr(frame, pk.lat, pk.lon, pk.ele, u, v, sp.peak));
			} else if (
				sp.lat !== undefined &&
				sp.lon !== undefined &&
				sp.h !== undefined
			) {
				corrs.push(pointCorr(frame, sp.lat, sp.lon, sp.h, u, v, sp.label));
			} else if (sp.level && sp.el !== undefined)
				corrs.push(levelCorr(sp.el, u, v, sp.label));
			else if (sp.az !== undefined && sp.el !== undefined)
				corrs.push(dirCorr(sp.az, sp.el, u, v, sp.label));
			else if (sp.az !== undefined)
				corrs.push(azimuthCorr(sp.az, u, v, sp.label));
			else missing.push(sp.label ?? `${sp.x},${sp.y}`);
		}
		const counts = `${corrs.filter((c) => c.kind === "point").length}/${corrs.filter((c) => c.kind === "dir").length}/${corrs.filter((c) => c.kind === "level").length}/${corrs.filter((c) => c.kind === "azimuth").length}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`;
		const priors = priorsFromPhoto(ph, { eye: eyeP });
		const g = gt[id];
		// GT entries with null angles (e.g. unsolved photos) are skipped
		const gtPose =
			g &&
			[g.yaw, g.pitch, g.roll].every(
				(x) => typeof x === "number" && Number.isFinite(x),
			)
				? { yaw: g.yaw, pitch: g.pitch, roll: g.roll }
				: null;
		const opt = {
			aspect,
			imageWidth: 1600,
			sigmaPx: 3,
			solveFov: e.solveFocal ?? true,
			inlierPx: 25,
		};
		const row = (
			mode: string,
			pose: Pose,
			rms: number,
			shift: number[] | null,
			sig: string,
			inl: string,
		) => {
			const d = gtPose
				? [
						wrap180(pose.yaw - gtPose.yaw),
						pose.pitch - gtPose.pitch,
						pose.roll - gtPose.roll,
					].map((x) => (x >= 0 ? "+" : "") + x.toFixed(3))
				: ["", "", ""];
			const s = `| ${id} | ${counts} | ${mode} | ${pose.yaw.toFixed(3)} | ${pose.pitch.toFixed(3)} | ${pose.roll.toFixed(3)} | ${pose.vfov.toFixed(2)} | ${d[0]} | ${d[1]} | ${d[2]} | ${rms.toFixed(2)} | ${shift ? shift.map((x) => x.toFixed(1)).join(", ") : "—"} | ${sig} | ${inl} |`;
			log(s);
			realRows.push(s);
		};
		log(
			`| ${id} | ${counts} | prior (EXIF) | ${ph.heading?.toFixed(3)} | ${ph.pitch?.toFixed(3)} | ${ph.roll?.toFixed(3)} | ${ph.vfov.toFixed(2)} | ${gtPose && ph.heading !== undefined ? f2(wrap180(ph.heading - gtPose.yaw), 3) : ""} | ${gtPose && ph.pitch !== undefined ? f2(ph.pitch - gtPose.pitch, 3) : ""} | ${gtPose && ph.roll !== undefined ? f2(ph.roll - gtPose.roll, 3) : ""} | | | | |`,
		);
		if (!corrs.length) continue;
		// only well-determined, fully resolved label sets are compared with 0f's GT (n_eff ≥ 3; labels
		// referring to OSM node ids not in the region file cannot be resolved here)
		const nEffAll = corrs.reduce(
			(a, c) => a + (c.kind === "point" || c.kind === "dir" ? 1 : 0.5),
			0,
		);
		const gtUsable = !!gtPose && !missing.length && nEffAll >= 3;
		if (gtPose && !gtUsable)
			gtSkipped.push(
				`${id} (${missing.length ? `${missing.length} unresolved label(s)` : `n_eff ${nEffAll}`})`,
			);
		const nFin = corrs.filter((c) => c.kind === "point").length;
		for (const mode of [
			"fixed",
			"6dof",
			...(nFin >= 3 ? ["6dof-forced"] : []),
			"LS",
		] as ("fixed" | "6dof" | "6dof-forced" | "LS")[]) {
			// LS = plain least squares with flat angle priors (what 0f's solver does), for comparison
			const pr =
				mode === "LS"
					? {
							...priors,
							yaw: { value: priors.yaw.value },
							pitch: { value: priors.pitch.value },
							roll: { value: priors.roll.value },
							vfov: {
								value: priors.vfov.value,
								sigma: priors.vfov.value * 0.1,
							},
						}
					: priors;
			const r = solvePose6dof(corrs, pr, {
				...opt,
				solvePosition: mode.startsWith("6dof"),
				...(mode === "LS" ? { huberK: 1e9 } : {}),
				...(mode === "6dof-forced" ? { minParallaxPx: 0 } : {}),
			});
			const shiftV = r.eyeOffset.map((x, k) => x - eyeP[k]);
			if (
				(mode === "fixed" || mode === "6dof" || mode === "LS") &&
				gtPose &&
				gtUsable
			)
				gtStats.push({
					id,
					mode,
					d: [
						wrap180(r.pose.yaw - gtPose.yaw),
						r.pose.pitch - gtPose.pitch,
						r.pose.roll - gtPose.roll,
					],
					s: [r.sigma.yaw, r.sigma.pitch, r.sigma.roll],
					shift: Math.hypot(...shiftV),
				});
			row(
				`${mode} [${r.activeParams.join(",")}] (${r.init}, ${r.iterations} it)`,
				r.pose,
				r.rmsPx,
				mode.startsWith("6dof") ? shiftV : null,
				`${f2(r.sigma.yaw, 3)}/${f2(r.sigma.pitch, 3)}/${f2(r.sigma.roll, 3)}${mode === "fixed" ? "" : ""}${mode.startsWith("6dof") && r.activeParams.includes("dx") ? `; σE,N,U ${f2(r.sigma.dx, 0)},${f2(r.sigma.dy, 0)},${f2(r.sigma.dz, 0)} m` : ""}`,
				`${r.inliers.filter(Boolean).length}/${corrs.length}${r.overThreshold.some(Boolean) ? ` (${r.overThreshold.filter(Boolean).length} > th)` : ""}; res ${r.residualsPx.map((x) => x.toFixed(1)).join(" ")}`,
			);
		}
		// 0f's solver as a cross-check (directions from the GPS eye); it has no azimuth-only points
		if (!corrs.some((c) => c.kind === "azimuth"))
			try {
				const W = 1600;
				const Hh = W / aspect;
				const cam = cameraFromAngles({
					width: W,
					height: Hh,
					f: focalFromVfov(ph.vfov, Hh),
					yaw: ph.heading ?? 0,
					pitch: ph.pitch ?? 0,
					roll: ph.roll ?? 0,
				});
				const pts = corrs
					.filter((c) => c.kind === "point" || c.kind === "dir")
					.map((c) => {
						const [az, el] = azElFromDir(
							c.kind === "point" ? c.world : (c as { dir: number[] }).dir,
						);
						return { x: c.u * W, y: c.v * Hh, azimuth: az, elevation: el };
					});
				const levels = corrs
					.filter((c) => c.kind === "level")
					.map((c) => ({
						x: c.u * W,
						y: c.v * Hh,
						elevation: (c as { el: number }).el,
					}));
				const s0 = solveFromControlPoints(cam, pts, {
					solveFocal: e.solveFocal ?? true,
					levels,
				});
				row(
					"0f solver",
					{
						yaw: s0.camera.yaw,
						pitch: s0.camera.pitch,
						roll: s0.camera.roll,
						vfov: (2 * Math.atan(Hh / 2 / s0.camera.f) * 180) / Math.PI,
					},
					s0.rmsPx,
					null,
					"",
					"",
				);
			} catch (err) {
				log(
					`| ${id} | | 0f solver failed: ${(err as Error).message} | | | | | | | | | | | |`,
				);
			}
	}
	log();
	// data/ground-truth.json was produced by session 0f's plain-LS rotation solver on the SAME labels
	// (with DEM-refined peak heights). This is therefore a CONSISTENCY check against 0f, not an
	// independent accuracy measurement. Fixed tolerance 0.2° (not 2σ, which is loose where σ ≈ 1–2°).
	log(
		"### Consistency with data/ground-truth.json (session 0f, same labels — not independent accuracy)",
	);
	log();
	const TOL = 0.2;
	if (gtSkipped.length)
		log(
			`Not compared (under-determined or unresolved labels): ${gtSkipped.join(", ")}.`,
		);
	log();
	log(
		`| mode | photos | median abs Δyaw ° | median abs Δpitch ° | median abs Δroll ° | max abs Δ ° | within ${TOL}° | max eye shift m |`,
	);
	log("|---|---|---|---|---|---|---|---|");
	for (const mode of ["LS", "fixed", "6dof"]) {
		const st = gtStats.filter((x) => x.mode === mode);
		if (!st.length) continue;
		const within = st.filter((x) =>
			x.d.every((d) => Math.abs(d) <= TOL),
		).length;
		const mx = Math.max(...st.flatMap((x) => x.d.map(Math.abs)));
		log(
			`| ${mode} | ${st.length} | ${[0, 1, 2]
				.map((k) =>
					f2(
						pct(
							st.map((x) => Math.abs(x.d[k])),
							0.5,
						),
						3,
					),
				)
				.join(
					" | ",
				)} | ${f2(mx, 3)} | ${within}/${st.length} | ${f2(Math.max(...st.map((x) => x.shift)), 1)} |`,
		);
		const outside = st
			.filter((x) => !x.d.every((d) => Math.abs(d) <= TOL))
			.map((x) => `${x.id} (${x.d.map((d) => f2(d, 2)).join("/")})`);
		// LS reproduces 0f's own method, so it must agree tightly; robust modes may legitimately move
		// away from 0f's LS where Huber down-weights a poor label.
		const need = mode === "LS" ? 1 : 0.8;
		check(
			`${mode}: ≥ ${need * 100} % of GT photos within ${TOL}° of 0f on yaw, pitch and roll`,
			within >= need * st.length,
			`${within}/${st.length}${outside.length ? `; outside: ${outside.join(", ")}` : ""}`,
		);
	}
}
log();
log(
	`**${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}**`,
);
fs.writeFileSync(path.join(OUT, "results.md"), `${md.join("\n")}\n`);
console.log(`\nwrote ${path.relative(ROOT, path.join(OUT, "results.md"))}`);
process.exit(failures ? 1 : 0);
