// Synthetic acceptance checks for the joint solver + gate (WP-D):
//   1. cue residual conventions (point, edge, level, shore) are zero at the truth and signed as documented;
//   2. a 15 m horizontal eye / 1.5 % focal perturbation is recovered to < 2 m / 0.2 % from skyline +
//      interior point cues (analytic terrain, sector ray-march horizons);
//   3. the same with a 5 m vertical error added;
//   4. freedom rules: far-only cues keep the eye fixed; k1 stays fixed without ≥ 6 corner cues;
//   5. gate: no holdout evidence ⇒ reject; held-out pins that improve ⇒ accept; skyline regressions
//      ⇒ reject; the 2-fold cue cross-check passes on the synthetic scene;
//   6. concordRefine refuses at LOW confidence and returns the input camera.
//
//   npx tsx src/lib/concord/solve/joint.check.ts
import type { Pose } from "../../camera";
import type { EyeHorizon, SkylineSample } from "../../pose6dof/eye";
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
	unprojectDirX,
	type Vec3,
} from "../core";
import type { EyePrior } from "../priors/altitude";
import { cueCrossCheck, gate } from "./gate";
import {
	basisPx,
	cueResidualPx,
	horizonEl,
	type JointCue,
	type JointInput,
	solveJoint,
} from "./joint";
import { concordRefine } from "./refine";

const DEG = Math.PI / 180;
let seed = 4242;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const gauss = () => {
	const u = Math.max(1e-12, rnd());
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
};
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
	if (!ok) failed++;
};

// ---------------------------------------------------------------- synthetic world

const YAW = 30;
const dirOf = (az: number): [number, number] => [
	Math.sin(az * DEG),
	Math.cos(az * DEG),
];
const hills: { e: number; n: number; a: number; s: number }[] = [];
for (const [d, daz, a, s] of [
	[450, -12, 35, 70],
	[700, 14, 60, 120],
	[1100, -4, 130, 180],
	[1600, 20, 180, 260],
	[2600, -22, 380, 450],
	[4200, 6, 700, 800],
	[8000, -15, 1400, 1500],
	[14000, 18, 2200, 2600],
	[26000, 0, 3000, 4500],
] as const) {
	const [x, y] = dirOf(YAW + daz);
	hills.push({ e: x * d, n: y * d, a, s });
}
const terrainZ = (e: number, n: number) => {
	let z = -1.6;
	for (const h of hills)
		z += h.a * Math.exp(-((e - h.e) ** 2 + (n - h.n) ** 2) / (2 * h.s * h.s));
	return z;
};

/** Sector ray-march horizon at an eye (the same function the solver is given). */
const SECTOR: [number, number] = [YAW - 55, YAW + 55];
const STEP = 0.05;
let hzCalls = 0;
function horizonAt(eye: Vec3): EyeHorizon {
	hzCalls++;
	const n = Math.round(360 / STEP);
	const elevation = new Float32Array(n).fill(-90);
	const ds: number[] = [];
	for (let d = 20; d < 50_000; d += Math.max(5, d * 0.004)) ds.push(d);
	for (let az = SECTOR[0]; az <= SECTOR[1]; az += STEP) {
		const i = Math.round((((az % 360) + 360) % 360) / STEP) % n;
		const a = i * STEP * DEG;
		const sx = Math.sin(a);
		const cy = Math.cos(a);
		let best = -90;
		for (const d of ds) {
			const z = terrainZ(eye[0] + sx * d, eye[1] + cy * d);
			const el = Math.atan2(z - eye[2], d) / DEG;
			if (el > best) best = el;
		}
		elevation[i] = best;
	}
	return { step: STEP, elevation };
}
const horizonsAtEyes = async (eyes: Vec3[]) => eyes.map(horizonAt);

/** First terrain hit of the ray through (u, v) from cam; null = sky. */
function castRay(cam: CameraX, u: number, v: number): Vec3 | null {
	const d = unprojectDirX(cam, u, v);
	const h = Math.hypot(d[0], d[1]);
	let prev = 0;
	for (let t = 5; t < 60_000; t += Math.max(2, t * 0.003)) {
		const p: Vec3 = [
			cam.eye[0] + d[0] * t,
			cam.eye[1] + d[1] * t,
			cam.eye[2] + d[2] * t,
		];
		if (p[2] <= terrainZ(p[0], p[1])) {
			let a = prev;
			let b = t;
			for (let k = 0; k < 30; k++) {
				const m = (a + b) / 2;
				const z = cam.eye[2] + d[2] * m;
				if (z <= terrainZ(cam.eye[0] + d[0] * m, cam.eye[1] + d[1] * m)) b = m;
				else a = m;
			}
			void h;
			return [
				cam.eye[0] + d[0] * b,
				cam.eye[1] + d[1] * b,
				cam.eye[2] + d[2] * b,
			];
		}
		prev = t;
	}
	return null;
}

const vfov = (2 * Math.atan(1512 / 3085)) / DEG;
const pose: Pose = { yaw: YAW, pitch: -2, roll: 0.5, vfov };
const truth: CameraX = {
	pose,
	eye: [0, 0, 0],
	aspect: 4 / 3,
	intr: { ...IDENTITY_INTRINSICS },
};
const { W, H } = basisPx(truth.aspect);

// skyline samples from the true horizon (bisection on v per column) + 0.5 px noise
const hTrue = horizonAt(truth.eye);
const skyline: SkylineSample[] = [];
for (let u = 0.01; u < 1; u += 0.004) {
	const g = (v: number) => {
		const d = unprojectDirX(truth, u, v);
		const az = (((Math.atan2(d[0], d[1]) / DEG) % 360) + 360) % 360;
		return Math.asin(d[2]) / DEG - horizonEl(hTrue, az);
	};
	let a = 0;
	let b = 1;
	if (!(g(a) > 0 && g(b) < 0)) continue;
	for (let k = 0; k < 40; k++) {
		const m = (a + b) / 2;
		if (g(m) > 0) a = m;
		else b = m;
	}
	skyline.push({ u, v: (a + b) / 2 + (0.5 * gauss()) / H, w: 1 });
}

// interior point cues: observed pixels (noise 0.5 px) of true terrain points
function pointCues(
	n: number,
	dMin: number,
	dMax: number,
	noisePx = 0.5,
): JointCue[] {
	const out: JointCue[] = [];
	for (let tries = 0; out.length < n && tries < 50 * n; tries++) {
		const u = 0.02 + 0.96 * rnd();
		const v = 0.3 + 0.68 * rnd();
		const w = castRay(truth, u, v);
		if (!w) continue;
		const dep = Math.hypot(w[0], w[1]);
		if (dep < dMin || dep > dMax) continue;
		out.push({
			kind: "point",
			u: u + (noisePx * gauss()) / W,
			v: v + (noisePx * gauss()) / H,
			world: w,
			depthM: dep,
			sigmaPx: 1,
			source: "synthetic",
		});
	}
	return out;
}

const flatPrior = (eye0: Vec3, sigmaH: number, sigmaV: number): EyePrior => ({
	eye0,
	sigmaH,
	sigmaV,
	source: "gps+dem-floor",
	g0: -1.6,
	reason: "synthetic",
	bandFrac: 0,
});

// ---------------------------------------------------------------- 1. conventions
{
	const w = castRay(truth, 0.4, 0.62) as Vec3;
	const q = projectX(truth, w) as { u: number; v: number };
	const dep = Math.hypot(w[0], w[1]);
	const pt: JointCue = {
		kind: "point",
		u: q.u,
		v: q.v,
		world: w,
		depthM: dep,
		sigmaPx: 1,
		source: "t",
	};
	const edge: JointCue = {
		kind: "edge",
		u: q.u,
		v: q.v,
		nu: 0,
		nv: -1,
		world: w,
		depthM: dep,
		sigmaPx: 1,
		source: "t",
		residualPx: 2,
	};
	const lvl: JointCue = {
		kind: "level",
		u: q.u,
		v: q.v,
		el: 0,
		world: w,
		depthM: dep,
		sigmaPx: 1,
		source: "t",
	};
	// straight east–west shoreline through w at lake level w[2]
	const shore: JointCue = {
		kind: "shore",
		u: q.u,
		v: q.v,
		lakeM: 0,
		shoreDist: (_e, n) => w[1] - n,
		world: [w[0], w[1], w[2]],
		depthM: dep,
		sigmaPx: 1,
		source: "t",
	};
	const shoreDown: JointCue = { ...shore, v: q.v + 1 / H };
	const rp = cueResidualPx(truth, pt);
	const re = cueResidualPx(truth, edge)[0];
	const reb = cueResidualPx(truth, edge, 0.5)[0];
	const rl = cueResidualPx(truth, lvl)[0];
	const rs = cueResidualPx(truth, shore)[0];
	const rsd = cueResidualPx(truth, shoreDown)[0];
	check(
		"cue residual conventions",
		Math.hypot(...rp) < 1e-6 &&
			Math.abs(re - 2) < 1e-6 &&
			Math.abs(reb - 1.5) < 1e-6 &&
			Math.abs(rl) < 1e-6 &&
			Math.abs(rs) < 1e-6 &&
			Math.abs(Math.abs(rsd) - 1) < 0.1,
		`point ${Math.hypot(...rp).toExponential(1)}, edge ${re.toFixed(3)} (r0=2) / ${reb.toFixed(3)} (bias 0.5), level ${rl.toExponential(1)}, shore ${rs.toExponential(1)}, shore 1 px down ${rsd.toFixed(3)} px`,
	);
}

// ---------------------------------------------------------------- 2/3. recovery
async function recovery(
	name: string,
	dEye: Vec3,
	fErr: number,
	noisePx = 0.5,
	outlierFrac = 0,
) {
	const cues = [
		...pointCues(120, 300, 2000, noisePx),
		...pointCues(120, 2000, 30000, noisePx),
	];
	// gross outliers (wrong matches): observed pixel displaced by 15–60 px
	for (const c of cues)
		if (rnd() < outlierFrac) {
			const m = 15 + 45 * rnd();
			const t = 2 * Math.PI * rnd();
			c.u += (m * Math.cos(t)) / W;
			c.v += (m * Math.sin(t)) / H;
		}
	const start: CameraX = {
		pose: { ...pose, yaw: YAW + 0.4, pitch: -2.3, roll: 0.3 },
		eye: dEye,
		aspect: truth.aspect,
		intr: { ...IDENTITY_INTRINSICS, fScale: 1 + fErr },
	};
	const f1 = H / 2 / Math.tan((vfov * DEG) / 2);
	const inp: JointInput = {
		cam0: start,
		eyePrior: flatPrior(dEye, 15, 10),
		ground: (e, n) => terrainZ(e, n),
		skyline,
		horizonsAtEyes,
		cues,
		// the "EXIF" focal: the perturbed one, σ 2 %
		focal: { fPx: f1 * (1 + fErr), sigmaPx: f1 * (1 + fErr) * 0.02 },
		free: { eye: true, fScale: true, k1: false },
	};
	hzCalls = 0;
	const r = await solveJoint(inp);
	const eErr = Math.hypot(
		r.cam.eye[0] - truth.eye[0],
		r.cam.eye[1] - truth.eye[1],
		r.cam.eye[2] - truth.eye[2],
	);
	const fe = Math.abs(r.cam.intr.fScale - 1);
	check(
		name,
		eErr < 2 && fe < 0.002,
		`start |Δeye| ${Math.hypot(...dEye).toFixed(1)} m, f ${(100 * fErr).toFixed(1)} % → |Δeye| ${eErr.toFixed(2)} m [${r.cam.eye.map((x) => x.toFixed(2)).join(", ")}], |Δf| ${(100 * fe).toFixed(3)} %, rot err ${Math.abs(r.cam.pose.yaw - YAW).toFixed(4)}/${Math.abs(r.cam.pose.pitch + 2).toFixed(4)}/${Math.abs(r.cam.pose.roll - 0.5).toFixed(4)}°, σ eE ${r.sigma.eE?.toFixed(2)} eU ${r.sigma.eU?.toFixed(2)} fScale ${r.sigma.fScale?.toExponential(1)}; skyline ${r.skylineRmsBefore.toFixed(2)} → ${r.skylineRmsAfter.toFixed(2)} px, cues ${r.cueRmsBefore.toFixed(2)} → ${r.cueRmsAfter.toFixed(2)} px; outer ${r.outer}, it ${r.iterations}, horizons ${hzCalls}, ${r.ms} ms`,
	);
	return { r, inp, cues };
}

const a = await recovery(
	"recover 15 m horizontal eye + 1.5 % focal",
	[10.6, -10.6, 0],
	0.015,
);
await recovery(
	"recover 15 m horizontal + 5 m vertical eye + 1.5 % focal",
	[-9, 12, 5],
	-0.015,
);
await recovery(
	"recover 15 m / 1.5 % with 1.5 px noise + 15 % gross outliers",
	[0, 15, 0],
	0.015,
	1.5,
	0.15,
);

// ---------------------------------------------------------------- 4. freedom rules
{
	const far = pointCues(80, 3000, 30000);
	const inp: JointInput = {
		...a.inp,
		cues: far,
		free: { eye: true, fScale: true, k1: true },
	};
	const r = await solveJoint(inp);
	check(
		"far-only cues keep the eye fixed; k1 needs corner cues",
		!r.freed.eye &&
			r.eyeShift.every((x) => x === 0) &&
			(r.counts.corner >= 6 ? r.freed.k1 : !r.freed.k1) &&
			r.reasons.some((s) => s.startsWith("eye fixed")),
		`freed ${JSON.stringify(r.freed)}, near ${r.counts.near}, corner ${r.counts.corner}; reasons: ${r.reasons.join("; ")}`,
	);
	const noCorner = far.filter(
		(c) => Math.hypot((c.u - 0.5) * (4 / 3), c.v - 0.5) < 0.45,
	);
	const r2 = await solveJoint({ ...inp, cues: noCorner });
	check(
		"k1 fixed without corner cues",
		!r2.freed.k1 && r2.cam.intr.k1 === 0,
		`corner ${r2.counts.corner}, k1 ${r2.cam.intr.k1}`,
	);
}

// ---------------------------------------------------------------- 5. gate
{
	const r = a.r;
	const g0 = gate(r);
	check(
		"gate: no holdout evidence ⇒ reject",
		!g0.accepted && g0.reasons.some((s) => s.includes("no holdout evidence")),
		g0.reasons.join("; "),
	);
	const pins = pointCues(12, 300, 5000, 0);
	const score = (cam: CameraX) => {
		const v = pins
			.map((p) => Math.hypot(...cueResidualPx(cam, p)))
			.sort((x, y) => x - y);
		return { medPx: v[v.length >> 1], p90Px: v[Math.ceil(0.9 * v.length) - 1] };
	};
	const g1 = gate(r, score);
	check(
		"gate: held-out pins improve ⇒ accept",
		g1.accepted,
		g1.reasons.join("; "),
	);
	const g2 = gate({ ...r, skylineRmsAfter: r.skylineRmsBefore + 0.8 }, score);
	check(
		"gate: skyline +0.8 px ⇒ reject",
		!g2.accepted && g2.reasons.some((s) => s.includes("skyline")),
		g2.reasons.filter((s) => s.startsWith("REJECT")).join("; "),
	);
	const g3 = gate(r, () => 5);
	check(
		"gate: held-out not improving ⇒ reject",
		!g3.accepted,
		g3.reasons.filter((s) => s.startsWith("REJECT")).join("; "),
	);
	const cc = await cueCrossCheck(a.inp);
	check("cue cross-check passes on the synthetic scene", cc.pass, cc.reason);
	const g4 = gate(r, undefined, { crossCheck: cc });
	check("gate with cross-check ⇒ accept", g4.accepted, g4.reasons.join("; "));
}

// ---------------------------------------------------------------- 6. concordRefine
{
	const out = await concordRefine({
		cam: a.inp.cam0,
		confidence: { accepted: true, confidence: 0.3 },
		eyePrior: a.inp.eyePrior,
		skyline,
		horizonsAtEyes,
		focal: a.inp.focal,
		cuesAt: () => a.cues,
	});
	check(
		"concordRefine refuses at LOW confidence",
		!out.accepted && out.cam === a.inp.cam0 && out.result === null,
		out.reasons.join("; "),
	);
	const ok = await concordRefine({
		cam: a.inp.cam0,
		confidence: { accepted: true, confidence: 0.9, level: "high" },
		eyePrior: a.inp.eyePrior,
		ground: a.inp.ground,
		skyline,
		horizonsAtEyes,
		focal: a.inp.focal,
		cuesAt: () => a.cues,
	});
	const eErr = Math.hypot(...ok.cam.eye);
	check(
		"concordRefine end-to-end (2 rounds + cross-check gate)",
		ok.accepted && eErr < 2 && Math.abs(ok.cam.intr.fScale - 1) < 0.002,
		`accepted ${ok.accepted}, |Δeye| ${eErr.toFixed(2)} m, fScale ${ok.cam.intr.fScale.toFixed(5)}, ${ok.ms} ms; ${ok.reasons.join("; ")}`,
	);
}

if (failed) {
	console.log(`${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("all joint checks passed");
