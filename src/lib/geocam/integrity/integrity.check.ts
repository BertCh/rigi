// Synthetic checks for GA5 integrity (integrity/separation.ts, integrity/viewshed.ts):
//   1. true camera, eye fixed, point correspondences at 0.3–15 km: every leave-out subset agrees,
//      PL_yaw / PL_pitch below 1° / 0.5° ⇒ pass;
//   2. WRONG eye (150 m sideways) whose rotation is re-solved on the same correspondences — it fits the
//      far field — must get a large rotation PL (near vs far parallax) ⇒ fail;
//   3. eye-free variant with the prior centred on the wrong eye: the MAP corrects the eye (near + mid
//      bands observe it), its PL is small, and the proposed wrong eye lies outside the bubble;
//   4. no evidence redundancy (all rows in one band) ⇒ the band subset is unavailable ⇒ fail;
//   5. viewshed: true eye sees its points; an eye behind the near hill has most points occluded; an
//      eye 5 m under the DEM is vetoed;
//   6. maskFactor: masked rows NaN, nEff scaled by the kept fraction.
//
//   npx tsx src/lib/geocam/integrity/integrity.check.ts
import { projectX } from "../../concord/core";
import { buildGeomBuffer, type HeightFn } from "../../concord/cues/raycast";
import {
	type CameraX,
	cameraXFromState,
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	NP,
	stateFromCameraX,
	type Vec3,
} from "../core";
import { solveMap } from "../map/solve";
import {
	bubbleTest,
	defaultSubsets,
	maskFactor,
	protectionLevel,
	type RowInfo,
} from "./separation";
import { viewshedVeto } from "./viewshed";

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
const gauss = () =>
	Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// terrain (scene frame, eye at the origin 2 m above the valley floor at z = −2):
// a near hill 1 km north, a mid ridge at 3–4 km, a high far ridge at 10–14 km
const height: HeightFn = (e, n) => {
	const hill =
		140 * Math.exp(-((e - 150) ** 2 + (n - 1000) ** 2) / (2 * 260 ** 2));
	const mid =
		450 *
		Math.exp(-((n - 3500) ** 2) / (2 * 500 ** 2)) *
		(1 + 0.3 * Math.sin(e / 700));
	const far =
		1800 *
		Math.exp(-((n - 12000) ** 2) / (2 * 2000 ** 2)) *
		(1 + 0.25 * Math.sin(e / 1500));
	return -2 + hill + mid + far + 0.004 * n;
};

const truth: CameraX = {
	pose: { yaw: 5, pitch: 4, roll: 0.5, vfov: 42 },
	eye: [0, 0, 0],
	aspect: 4 / 3,
	intr: { fScale: 1, k1: 0, cx: 0, cy: 0 },
};
const W = 1600;
const H = 1200;

type Corr = { u: number; v: number; X: Vec3; d: number };
function correspondences(): Corr[] {
	const g = buildGeomBuffer(truth, 200, 150, height);
	const out: Corr[] = [];
	for (let j = 3; j < g.h; j += 6)
		for (let i = 3; i < g.w; i += 6) {
			const k = j * g.w + i;
			if (g.sky[k]) continue;
			const X: Vec3 = [g.xyz[3 * k], g.xyz[3 * k + 1], g.xyz[3 * k + 2]];
			const q = projectX(truth, X);
			if (!q) continue;
			const d = Math.hypot(X[0], X[1]);
			if (d < 250) continue;
			out.push({
				u: q.u + (0.5 * gauss()) / W,
				v: q.v + (0.5 * gauss()) / H,
				X,
				d,
			});
		}
	return out;
}

/** 2 rows per correspondence (du, dv px @1600 / σ), Cauchy c = 3. */
function pointFactor(base: CameraX, cs: Corr[], sigmaPx = 1): Factor {
	return {
		family: "point",
		name: "pts",
		dim: 2 * cs.length,
		loss: { kind: "cauchy", c: 3 },
		residual(x: GeoState) {
			const cam = cameraXFromState(base, x);
			const r = new Float64Array(2 * cs.length);
			cs.forEach((c, i) => {
				const q = projectX(cam, c.X);
				r[2 * i] = q ? ((q.u - c.u) * W) / sigmaPx : Number.NaN;
				r[2 * i + 1] = q ? ((q.v - c.v) * H) / sigmaPx : Number.NaN;
			});
			return r;
		},
	};
}
const rowInfoOf = (cs: Corr[]) => {
	const ri: RowInfo[] = [];
	for (const c of cs) {
		ri.push({ u: c.u, depthM: c.d });
		ri.push({ u: c.u, depthM: c.d });
	}
	return ri;
};
const eyePrior = (c: Vec3, sH: number, sV: number): Factor => ({
	family: "gps",
	name: "eyePrior",
	dim: 3,
	loss: { kind: "l2" },
	prior: true,
	residual: (x) =>
		Float64Array.of(
			(x[IDX.E] - c[0]) / sH,
			(x[IDX.N] - c[1]) / sH,
			(x[IDX.U] - c[2]) / sV,
		),
});

const cs = correspondences();
const nNear = cs.filter((c) => c.d < 2000).length;
console.log(`synthetic scene: ${cs.length} correspondences, ${nNear} < 2 km`);

// 1. true camera, eye fixed
{
	const base = truth;
	const pf = pointFactor(base, cs);
	const p: MapProblem = {
		base,
		f0Px1600: 1,
		factors: [pf],
		free: { rotation: true, focal: false, eye: false },
	};
	const full = await solveMap(p, stateFromCameraX(base));
	const pl = await protectionLevel(p, full, {
		rowInfo: (f) => (f === pf ? rowInfoOf(cs) : undefined),
		alertPitchDeg: 0.5,
	});
	check(
		"true camera passes (eye fixed)",
		pl.pass,
		`PL_yaw ${pl.plYawDeg.toFixed(3)}° PL_pitch ${pl.plPitchDeg.toFixed(3)}° subsets ${pl.subsets.map((s) => s.name).join(",")} ${pl.reasons.join("; ")}`,
	);
}

// 2. wrong eye 150 m sideways (east, across the view), rotation re-solved: fits the far field
let wrongFull: GeoState | null = null;
{
	const wrongEye: Vec3 = [150, 0, height(150, 0, 0) + 2];
	const base: CameraX = { ...truth, eye: wrongEye };
	const pf = pointFactor(base, cs);
	const p: MapProblem = {
		base,
		f0Px1600: 1,
		factors: [pf],
		free: { rotation: true, focal: false, eye: false },
	};
	const full = await solveMap(p, stateFromCameraX(base));
	wrongFull = full.x;
	// far-field fit of the wrong camera
	const cam = cameraXFromState(base, full.x);
	const farRes: number[] = [];
	const nearRes: number[] = [];
	for (const c of cs) {
		const q = projectX(cam, c.X);
		if (!q) continue;
		const px = Math.hypot((q.u - c.u) * W, (q.v - c.v) * H);
		(c.d > 8000 ? farRes : nearRes).push(px);
	}
	const med = (a: number[]) =>
		a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
	const pl = await protectionLevel(p, full, {
		rowInfo: (f) => (f === pf ? rowInfoOf(cs) : undefined),
		alertPitchDeg: 0.5,
	});
	check(
		"wrong eye (150 m) fitting the far field gets a large rotation PL",
		!pl.pass && Math.max(pl.plYawDeg, pl.plPitchDeg / 0.5) > 1.5,
		`far med ${med(farRes).toFixed(1)} px, near med ${med(nearRes).toFixed(1)} px; PL_yaw ${pl.plYawDeg.toFixed(2)}° (${pl.worst.yaw}) PL_pitch ${pl.plPitchDeg.toFixed(2)}° (${pl.worst.pitch})`,
	);
}

// 3. eye free, prior centred on the wrong eye
{
	const wrongEye: Vec3 = [150, 0, height(150, 0, 0) + 2];
	const base: CameraX = { ...truth, eye: wrongEye };
	const pf = pointFactor(base, cs);
	const p: MapProblem = {
		base,
		f0Px1600: 1,
		factors: [pf, eyePrior(wrongEye, 30, 10)],
		free: { rotation: true, focal: false, eye: true },
	};
	const x0 = Float64Array.from(wrongFull ?? stateFromCameraX(base));
	const full = await solveMap(p, x0);
	const pl = await protectionLevel(p, full, {
		rowInfo: (f) => (f === pf ? rowInfoOf(cs) : undefined),
	});
	const bt = bubbleTest(x0, full, pl);
	check(
		"eye free, prior on the wrong eye: MAP corrects it, hypothesis outside the bubble",
		Math.hypot(full.x[IDX.E], full.x[IDX.N]) < 10 && bt.outside,
		`full eye (${full.x[IDX.E].toFixed(1)}, ${full.x[IDX.N].toFixed(1)}, ${full.x[IDX.U].toFixed(1)}); PL_H ${pl.plH.toFixed(1)} m (${pl.worst.H}); hyp dH ${bt.dH.toFixed(0)} m > bubble ${bt.bubbleH.toFixed(1)} m`,
	);
	// the same on the TRUE eye (info): here the mid ridge keeps the eye observable without the near band
	const pT: MapProblem = {
		base: truth,
		f0Px1600: 1,
		factors: [pointFactor(truth, cs), eyePrior([0, 0, 0], 30, 10)],
		free: { rotation: true, focal: false, eye: true },
	};
	const fullT = await solveMap(pT, stateFromCameraX(truth));
	const plT = await protectionLevel(pT, fullT, {
		rowInfo: (f) => (f === pT.factors[0] ? rowInfoOf(cs) : undefined),
	});
	console.log(
		`INFO  eye free, true eye: PL_H ${plT.plH.toFixed(1)} m (${plT.worst.H}), dH ${plT.subsets.map((s) => `${s.name}:${s.dH.toFixed(1)}/${s.sepH.toFixed(1)}`).join(" ")} (dH/σsep per subset; PL grows with K·σsep when one band alone carries the eye)`,
	);
}

// 4. no redundancy: all rows far ⇒ "-far" subset unavailable
{
	const far = cs.filter((c) => c.d >= 2000);
	const pf = pointFactor(truth, far);
	const p: MapProblem = {
		base: truth,
		f0Px1600: 1,
		factors: [pf],
		free: { rotation: true, focal: false, eye: false },
	};
	const full = await solveMap(p, stateFromCameraX(truth));
	const pl = await protectionLevel(p, full, {
		rowInfo: (f) => (f === pf ? rowInfoOf(far) : undefined),
	});
	const sub = pl.subsets.find((s) => s.name === "-far");
	check(
		"no near rows ⇒ -far unavailable ⇒ fail",
		!pl.pass && !!sub && !sub.ok,
		`${sub?.why ?? "?"}`,
	);
}

// 5. viewshed
{
	const pts = cs.map((c) => c.X);
	const vTrue = viewshedVeto({ height }, truth.eye, pts);
	const behind: Vec3 = [150, 1500, height(150, 1500, 0) + 1.6];
	const vBehind = viewshedVeto(
		{ height },
		behind,
		pts.filter((X) => X[1] > 1000 || true),
	);
	const under: Vec3 = [0, 0, height(0, 0, 0) - 5];
	const vUnder = viewshedVeto({ height }, under, pts);
	check(
		"viewshed: true eye sees its points",
		vTrue.ok && vTrue.occludedFrac < 0.02,
		`occluded ${(100 * vTrue.occludedFrac).toFixed(1)}% of ${vTrue.nTested}, above DEM ${vTrue.aboveDemM.toFixed(1)} m`,
	);
	check(
		"viewshed: eye behind the hill vetoed",
		!vBehind.ok && vBehind.occludedFrac > 0.2,
		`occluded ${(100 * vBehind.occludedFrac).toFixed(1)}%`,
	);
	check(
		"viewshed: eye under the DEM vetoed",
		!vUnder.ok && vUnder.eyeBelowGround,
		vUnder.reasons.join("; "),
	);
}

// 6. maskFactor + defaultSubsets
{
	const pf = pointFactor(truth, cs.slice(0, 10));
	pf.nEff = 8;
	const m = maskFactor(pf, (i) => i < 5, "t");
	const r = m.residual(stateFromCameraX(truth));
	const nNaN = r.filter((v) => Number.isNaN(v)).length;
	check(
		"maskFactor rows + nEff",
		nNaN === 15 && Math.abs((m.nEff ?? 0) - 2) < 1e-9 && m.dim === 20,
		`NaN ${nNaN}, nEff ${m.nEff}`,
	);
	const sky: Factor = {
		...pointFactor(truth, cs.slice(0, 3)),
		family: "skyline",
	};
	const names = defaultSubsets({
		base: truth,
		f0Px1600: 1,
		factors: [pf, sky, eyePrior([0, 0, 0], 20, 5)],
		free: { rotation: true, focal: false, eye: true },
	}).map((s) => s.name);
	check(
		"defaultSubsets: skyline vs matches",
		names.join(",") === "-point,-skyline",
		names.join(","),
	);
}

void NP;
if (failed) {
	console.log(`${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("all integrity checks passed");
