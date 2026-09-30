// Synthetic checks for the GA2 observability package:
//   1. crlb σ_E, σ_N match the Monte-Carlo spread of solveMap (100 noise draws) within ±20 % (near scene);
//   2. far-only scene: σ_eye ≥ 0.8·σ_GPS and the GPS prior carries > 80 % of the E/N variance; near scene:
//      σ_eye ≪ σ_GPS and the points carry most of it; shares sum to 1; a free focal + eye with far points
//      only is (nearly) singular (large cond);
//   3. heldOutFamily: two consistent near families → the held-out one confirms the move off a displaced GPS
//      fix; a family that agrees with the wrong fix does not;
//   4. eyeMayMove: opens only with σ_eye < 15 m + a confirming held-out family + GA5 pass; fails closed.
//
//   npx tsx src/lib/geocam/observe/observe.check.ts
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
	type Vec3,
} from "../../concord/core";
import {
	type CueFamily,
	cameraXFromState,
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	NP,
	stateFromCameraX,
} from "../core";
import { gpsFactor, pointFactor, solveMap } from "../map";
import { crlb } from "./fisher";
import { eyeMayMove } from "./gate";
import { heldOutFamily } from "./heldout";

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
	if (!ok) failed++;
};
let seed = 777;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const randn = () =>
	Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) *
	Math.cos(2 * Math.PI * rnd());

const base: CameraX = {
	pose: { yaw: 30, pitch: 2, roll: 0, vfov: 50 },
	eye: [0, 0, 0],
	aspect: 1.5,
	intr: { ...IDENTITY_INTRINSICS },
};
const W = 1600;
const H = 1600 / 1.5;

/** World points at distances [d0, d1] seen inside the frame from `eye`. */
function points(n: number, d0: number, d1: number): Vec3[] {
	const out: Vec3[] = [];
	while (out.length < n) {
		const az = base.pose.yaw + (rnd() - 0.5) * 60;
		const el = base.pose.pitch + (rnd() - 0.5) * 30;
		const d = d0 * (d1 / d0) ** rnd();
		const w: Vec3 = [
			d * Math.sin((az * Math.PI) / 180),
			d * Math.cos((az * Math.PI) / 180),
			d * Math.tan((el * Math.PI) / 180),
		];
		const p = projectX(base, w);
		if (p && p.u > 0.02 && p.u < 0.98 && p.v > 0.02 && p.v < 0.98) out.push(w);
	}
	return out;
}
/** Observations of `pts` from camera `cam` with σ px noise (px @1600). */
const observe = (pts: Vec3[], cam: CameraX, s = 1) =>
	pts.map((w) => {
		const p = projectX(cam, w) as { u: number; v: number };
		return { u: p.u + (s * randn()) / W, v: p.v + (s * randn()) / H, world: w };
	});
const ptF = (
	corrs: ReturnType<typeof observe>,
	family: CueFamily = "point",
	sigmaPx = 1,
): Factor => ({
	...pointFactor(base, corrs, {
		sigmaPx,
		demSigmaM: null,
		cluster: null,
		loss: { kind: "l2" },
	}),
	family,
});
const uPrior = (u0: number, s: number): Factor => ({
	family: "alt",
	name: "alt",
	dim: 1,
	loss: { kind: "l2" },
	prior: true,
	residual: (x) => Float64Array.of((x[IDX.U] - u0) / s),
});
const x0 = stateFromCameraX(base);
const problem = (factors: Factor[], focal = false): MapProblem => ({
	base,
	f0Px1600: H / 2 / Math.tan((25 * Math.PI) / 180),
	factors,
	free: { rotation: true, focal, eye: true },
});

const near = points(40, 300, 2000);
const far = points(30, 50_000, 120_000);

// 1. CRLB vs Monte Carlo
{
	const mk = () =>
		problem([gpsFactor(0, 0, 30), uPrior(0, 5), ptF(observe(near, base))]);
	const fr = await crlb(mk(), x0);
	const eE: number[] = [];
	const eN: number[] = [];
	for (let k = 0; k < 100; k++) {
		const r = await solveMap(mk(), x0, { madRescale: false });
		eE.push(r.x[IDX.E]);
		eN.push(r.x[IDX.N]);
	}
	const sd = (a: number[]) => {
		const m = a.reduce((s, v) => s + v, 0) / a.length;
		return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
	};
	const rE = sd(eE) / fr.sigma.E;
	const rN = sd(eN) / fr.sigma.N;
	check(
		"crlb σ_E, σ_N = Monte-Carlo spread ±20 %",
		Math.abs(rE - 1) < 0.2 && Math.abs(rN - 1) < 0.2,
		`σ_E ${fr.sigma.E.toFixed(2)} (MC ${sd(eE).toFixed(2)}), σ_N ${fr.sigma.N.toFixed(2)} (MC ${sd(eN).toFixed(2)}) m`,
	);
}

// 2. far vs near observability, shares, conditioning
{
	const frFar = await crlb(
		problem([
			gpsFactor(0, 0, 30),
			uPrior(0, 5),
			ptF(observe(far, base, 2), "point", 2),
		]),
		x0,
	);
	const gpsFar = frFar.byFamily.find((f) => f.family === "gps")?.share ?? 0;
	const sumFar = frFar.byFamily.reduce((s, f) => s + f.share, 0);
	check(
		"far-only: σ_eye ≥ 0.8·σ_GPS, GPS share > 0.8",
		frFar.sigmaEye >= 0.8 * 30 && gpsFar > 0.8 && Math.abs(sumFar - 1) < 1e-6,
		`σ_eye ${frFar.sigmaEye.toFixed(1)} m, gps share ${gpsFar.toFixed(3)}, Σshare ${sumFar.toFixed(6)}`,
	);
	const frNear = await crlb(
		problem([gpsFactor(0, 0, 30), uPrior(0, 5), ptF(observe(near, base))]),
		x0,
	);
	const ptNear = frNear.byFamily.find((f) => f.family === "point");
	check(
		"near: σ_eye ≪ σ_GPS, points carry the eye",
		frNear.sigmaEye < 3 &&
			(ptNear?.share ?? 0) > 0.8 &&
			(ptNear?.sigmaEyeAlone ?? 99) < 3,
		`σ_eye ${frNear.sigmaEye.toFixed(2)} m, point share ${ptNear?.share.toFixed(3)}, alone ${ptNear?.sigmaEyeAlone.toFixed(2)} m, cond ${frNear.cond.toExponential(1)}`,
	);
	const frSing = await crlb(
		problem([ptF(observe(far, base, 2), "point", 2)], true),
		x0,
	);
	check(
		"far points only, eye + focal free: ill-conditioned",
		frSing.cond > 1e4 ||
			!Number.isFinite(frSing.sigmaEye) ||
			frSing.sigmaEye > 100,
		`cond ${frSing.cond.toExponential(1)}, σ_eye ${frSing.sigmaEye.toFixed(0)} m`,
	);
}

// 3 + 4. held-out family and the gate
{
	const fix: GeoState = Float64Array.from(x0);
	fix[IDX.E] = 40; // GPS fix 40 m off the true eye
	const camFix = cameraXFromState(base, fix);
	const nearB = points(40, 300, 2000);
	const mk = (bAgreesWithFix: boolean) =>
		problem([
			gpsFactor(40, 0, 50),
			uPrior(0, 5),
			ptF(observe(near, base), "point"),
			ptF(observe(nearB, bAgreesWithFix ? camFix : base), "edge"),
		]);
	const pOk = mk(false);
	const full = await solveMap(pOk, fix);
	const hB = await heldOutFamily(pOk, full, "edge", { x0: fix });
	const hA = await heldOutFamily(pOk, full, "point", { x0: fix });
	check(
		"held-out: consistent family confirms the move",
		hB.improved && hA.improved && full.x[IDX.E] < 5,
		`eye ${full.x[IDX.E].toFixed(1)} m; edge ${hB.before.toFixed(1)}→${hB.after.toFixed(1)}, point ${hA.before.toFixed(1)}→${hA.after.toFixed(1)}`,
	);
	const pBad = mk(true);
	const fullBad = await solveMap(pBad, fix);
	const hBad = await heldOutFamily(pBad, fullBad, "edge", { x0: fix });
	check(
		"held-out: a family agreeing with the wrong fix does not confirm",
		!hBad.improved,
		`eye ${fullBad.x[IDX.E].toFixed(1)} m; edge ${hBad.before.toFixed(2)}→${hBad.after.toFixed(2)}`,
	);
	const fr = await crlb(pOk, full.x);
	const g1 = eyeMayMove(fr, [hB], { integrity: { pass: true } });
	const g2 = eyeMayMove(fr, [hB], {});
	const g3 = eyeMayMove(fr, [hBad], { integrity: { pass: true } });
	const frFar = await crlb(
		problem([
			gpsFactor(0, 0, 30),
			uPrior(0, 5),
			ptF(observe(far, base, 2), "point", 2),
		]),
		x0,
	);
	const g4 = eyeMayMove(frFar, [hB], { integrity: { pass: true } });
	check(
		"gate: open only with σ + held-out + GA5; fails closed",
		g1.ok && !g2.ok && !g3.ok && !g4.ok,
		`ok=${g1.ok}; noGA5=${g2.reasons.join("; ")}; bad=${g3.reasons[0]}; far=${g4.reasons[0]}`,
	);
}
void NP;

if (failed) {
	console.log(`${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("all observe checks passed");
