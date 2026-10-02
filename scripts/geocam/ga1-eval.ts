// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GA1 evaluation: MAP solve with priors + Laplace covariance on the DEV GT photos (CPU only, no renders).
 * Rule: tools/research/geo/PROTOCOL.txt SECTION GA1 (frozen before scoring).
 *
 *   npx tsx scripts/geocam/ga1-eval.ts [--draws 4] [--no-cues] [--dem mh|terrarium] [--tag x] [IMG_xxxx ...]
 *
 * Configs per photo (start = the app's automatic solve):
 *   P  priors (gps, alt, ground, gravity, compass, focal) + skyline (eye-linearised) + re-match points; free all
 *   R  P with the eye fixed at the app eye
 *   C  P + WP-C cues (edge / level / shore at the app camera; edge offset −2 px)
 *   Pd P with the gps factor's mean displaced by δ ~ N(0, σH²·I₂) (eye calibration; `--draws` per photo)
 * Writes out/geocam/ga1/ga1-eval.json (+ console table). REPORT_GA1.txt is written by hand from it.
 */
import path from "node:path";
import { vfovFromFocal } from "../../src/lib/camera";
import type { CameraX } from "../../src/lib/concord/core";
import { unprojectDirX } from "../../src/lib/concord/core";
import {
	cameraXFromState,
	dAngle,
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	type MapResult,
	NP,
	stateFromCameraX,
} from "../../src/lib/geocam/core";
import {
	altFactor,
	compassFactor,
	concordCueFactors,
	focalFactor,
	focalPx1600,
	gpsFactor,
	gravityFactor,
	groundFactor,
	horizonEl,
	type JointCue,
	pointFactor,
	skylineFactor,
	solveMap,
} from "../../src/lib/geocam/map";
import { DEG as D, wrap360 } from "../../src/lib/geodesy";
import type { EyeHorizon } from "../../src/lib/pose6dof/eye";
import {
	devGTPhotos,
	GEO_OUT,
	hzStats,
	loadGT,
	median,
	type PhotoSetup,
	photoSetup,
	R_EFF,
	writeJson,
} from "./lib";

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	if (i < 0) return d;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const flag = (k: string) => {
	const i = args.indexOf(k);
	if (i < 0) return false;
	args.splice(i, 1);
	return true;
};
const nDraws = Number(opt("--draws", "4"));
const noCues = flag("--no-cues");
// PROTOCOL primary = Mapterhorn; --dem terrarium is a labelled post-hoc secondary (the DEM of GT + app)
const dem = opt("--dem", "mh") as "mh" | "terrarium";
const tag = opt("--tag", dem === "mh" ? "" : `-${dem}`);
const photos = devGTPhotos(args.filter((a) => a.startsWith("IMG_")));

let seed = 1;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const randn = () =>
	Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) *
	Math.cos(2 * Math.PI * rnd());

// ---------------------------------------------------------------- problem

function horizonDist(h: EyeHorizon, az: number) {
	if (!h.distance) return Number.NaN;
	const n = h.distance.length;
	const i = Math.round(wrap360(az) / h.step) % n;
	return h.distance[i] > 0 ? h.distance[i] : Number.NaN;
}

type Built = { p: MapProblem; x0: GeoState; nPts: number; nCues: number };

function build(
	S: PhotoSetup,
	base: CameraX,
	o: { eye: boolean; cues?: JointCue[]; gpsShift?: [number, number] },
): Built {
	const f0 = focalPx1600(base);
	const pr = S.eyePrior;
	const sh = o.gpsShift ?? [0, 0];
	const factors: Factor[] = [
		gpsFactor(S.fixEN[0] + sh[0], S.fixEN[1] + sh[1], pr.sigmaH),
		groundFactor(S.ground),
		focalFactor(f0, S.focal.fPx, S.focal.sigmaPx),
		skylineFactor(base, S.skyline, S.horizonsAtEyes, { eye: o.eye }),
	];
	if (S.meta.alt !== null) factors.push(altFactor(S.meta.alt - S.s.eyeAlt));
	if (S.meta.pitch !== null && S.meta.roll !== null)
		factors.push(gravityFactor(S.meta.pitch, S.meta.roll));
	if (S.meta.heading !== null) factors.push(compassFactor(S.meta.heading));
	const pts = S.rematch.filter((c) => c.kind === "point");
	if (pts.length)
		factors.push(
			pointFactor(
				base,
				pts.map((c) => ({
					u: c.u,
					v: c.v,
					world: (c as { world: [number, number, number] }).world,
					sigmaPx: c.sigmaPx,
					depthM: c.depthM,
				})),
				{ nEff: 60, name: "rematch" },
			),
		);
	let nCues = 0;
	if (o.cues?.length) {
		const fs = concordCueFactors(
			base,
			o.cues.filter((c) => c.kind !== "point"),
			{ frame: { alt0: S.s.eyeAlt, rEff: R_EFF }, edgeBiasPx: -2 },
		);
		nCues = fs.reduce((a, f) => a + f.dim, 0);
		factors.push(...fs);
	}
	return {
		p: {
			base,
			f0Px1600: f0,
			factors,
			free: { rotation: true, focal: true, eye: o.eye },
		},
		x0: stateFromCameraX(base),
		nPts: pts.length,
		nCues,
	};
}

// ---------------------------------------------------------------- per photo

const r4 = (x: number, d = 4) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const summary = (r: MapResult, base: CameraX, gt: CameraX) => ({
	x: Array.from(r.x).map((v) => r4(v, 5)),
	sigma: Object.fromEntries(
		Object.entries(r.sigma).map(([k, v]) => [k, +v.toPrecision(3)]),
	),
	sigmaEN: r4(r.sigmaEN, 2),
	mad: r4(r.mad, 2),
	converged: r.converged,
	iterations: r.iterations,
	outer: r.outer,
	ms: r.ms,
	err: rotErr(r.cam, gt),
	eyeShift: [0, 1, 2].map((k) => r4(r.cam.eye[k] - base.eye[k], 2)),
	fRatioGT: r4(focalPx1600(r.cam) / focalPx1600(gt), 5),
	perFamily: r.perFamily.map((f) => ({
		family: f.family,
		n: f.n,
		nEff: r4(f.nEff, 1),
		chi2: r4(f.chi2, 1),
	})),
});
const rotErr = (c: CameraX, gt: CameraX) => ({
	yaw: dAngle(c.pose.yaw, gt.pose.yaw),
	pitch: c.pose.pitch - gt.pose.pitch,
	roll: dAngle(c.pose.roll, gt.pose.roll),
});

const rows: Record<string, unknown>[] = [];
for (const photo of photos) {
	const T0 = Date.now();
	seed = 1000 + Number(photo.slice(4));
	const S = await photoSetup(photo, { start: "app", dem });
	const base: CameraX = { ...S.start, intr: { ...S.start.intr, fScale: 1 } };
	const g = loadGT()[photo];
	const gt: CameraX = {
		...S.gt,
		pose: { ...S.gt.pose, vfov: vfovFromFocal(g.f as number, g.height) },
	};
	// all-far classification at the app camera / eye
	const q = (v: number) => Math.round(v / 0.25) * 0.25;
	const [h0] = await S.horizonsAtEyes([
		[q(base.eye[0]), q(base.eye[1]), q(base.eye[2])],
	]);
	const dists = S.skyline.map((s) => {
		const d = unprojectDirX(base, s.u, s.v);
		const az = wrap360(Math.atan2(d[0], d[1]) / D);
		return Number.isFinite(horizonEl(h0, az))
			? horizonDist(h0, az)
			: Number.NaN;
	});
	const dOk = dists.filter(Number.isFinite);
	const farFrac = dOk.length
		? dOk.filter((d) => d >= 3000).length / dOk.length
		: 0;
	const ptMin = Math.min(
		...S.rematch.map((c) => c.depthM),
		Number.POSITIVE_INFINITY,
	);
	const allFar = farFrac >= 0.9 && ptMin >= 3000;

	const P = build(S, base, { eye: true });
	const rP = await solveMap(P.p, P.x0);
	const R = build(S, base, { eye: false });
	const rR = await solveMap(R.p, R.x0);
	let rC: MapResult | null = null;
	let nCues = 0;
	if (!noCues) {
		const cues = await S.cuesAt(base);
		const C = build(S, base, { eye: true, cues });
		nCues = C.nCues;
		rC = await solveMap(C.p, C.x0);
	}
	// eye calibration: displaced GPS mean
	const draws: Record<string, unknown>[] = [];
	for (let k = 0; k < nDraws; k++) {
		const dl: [number, number] = [
			S.eyePrior.sigmaH * randn(),
			S.eyePrior.sigmaH * randn(),
		];
		const Pd = build(S, base, { eye: true, gpsShift: dl });
		const r = await solveMap(Pd.p, Pd.x0);
		const e = [r.x[IDX.E], r.x[IDX.N]]; // truth = GT eye (0, 0)
		const cEE = r.cov[IDX.E * NP + IDX.E];
		const cEN = r.cov[IDX.E * NP + IDX.N];
		const cNN = r.cov[IDX.N * NP + IDX.N];
		const det = cEE * cNN - cEN * cEN;
		const z2 =
			det > 0
				? (cNN * e[0] * e[0] - 2 * cEN * e[0] * e[1] + cEE * e[1] * e[1]) /
					det /
					2
				: Number.NaN;
		draws.push({
			delta: dl.map((v) => r4(v, 2)),
			eyeEN: e.map((v) => r4(v, 2)),
			errEN: r4(Math.hypot(e[0], e[1]), 2),
			sigmaEN: r4(r.sigmaEN, 2),
			z2: r4(z2, 3),
			converged: r.converged,
		});
	}
	const eApp = rotErr(base, gt);
	const row = {
		photo,
		sigmaGPS: S.eyePrior.sigmaH,
		prior: `${S.eyePrior.source} σH ${S.eyePrior.sigmaH.toFixed(1)}; alt ${S.meta.alt !== null}; heading ${S.meta.heading !== null}; focal ${S.focal.lens ?? "default"} ×${S.focal.fScale.toFixed(4)}`,
		nSky: S.skyline.length,
		nPts: P.nPts,
		nCues,
		farFrac: r4(farFrac, 3),
		ptMinM: Number.isFinite(ptMin) ? Math.round(ptMin) : null,
		allFar,
		appEyeU: r4(base.eye[2], 2),
		app: { err: eApp },
		P: summary(rP, base, gt),
		R: summary(rR, base, gt),
		C: rC ? summary(rC, base, gt) : null,
		draws,
		ms: Date.now() - T0,
	};
	rows.push(row);
	const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
	console.log(
		`${photo}: sky ${S.skyline.length} pts ${P.nPts} cues ${nCues} far ${f(farFrac, 2)}${allFar ? " ALL-FAR" : ""} | pitch err app ${f(eApp.pitch)} P ${f(row.P.err.pitch)} R ${f(row.R.err.pitch)}${rC ? ` C ${f(row.C?.err.pitch as number)}` : ""} | σ pitch ${f(rP.sigma.pitch, 4)} yaw ${f(rP.sigma.yaw, 4)} roll ${f(rP.sigma.roll, 4)} | σEN ${f(rP.sigmaEN, 1)} / σGPS ${f(S.eyePrior.sigmaH, 1)} | eye shift [${row.P.eyeShift.join(", ")}] | mad ${f(rP.mad, 2)} | ${row.ms} ms (hz ${hzStats.computed}, ${(hzStats.ms / 1000).toFixed(0)} s)`,
	);
}

// ---------------------------------------------------------------- criteria

type Row = (typeof rows)[number] & {
	app: { err: { yaw: number; pitch: number; roll: number } };
	P: ReturnType<typeof summary>;
	R: ReturnType<typeof summary>;
	C: ReturnType<typeof summary> | null;
	allFar: boolean;
	sigmaGPS: number;
	draws: { z2: number }[];
};
const R_ = rows as Row[];
const medAbs = (v: number[]) => median(v.map(Math.abs));
const pitch = {
	app: medAbs(R_.map((r) => r.app.err.pitch)),
	P: medAbs(R_.map((r) => r.P.err.pitch)),
	R: medAbs(R_.map((r) => r.R.err.pitch)),
	C: R_.every((r) => r.C)
		? medAbs(R_.map((r) => (r.C as ReturnType<typeof summary>).err.pitch))
		: null,
};
const pitchPass = pitch.P <= pitch.app + 0.02;
const z2rot = (cfg: "P" | "R" | "C", gtSig = 0) =>
	R_.flatMap((r) => {
		const s = r[cfg];
		if (!s) return [];
		return (["yaw", "pitch", "roll"] as const).map(
			(k) => s.err[k] ** 2 / (s.sigma[k] ** 2 + gtSig ** 2),
		);
	});
const zP = z2rot("P");
const zPg = z2rot("P", 0.03);
const zEye = R_.flatMap((r) => r.draws.map((d) => d.z2)).filter(
	Number.isFinite,
);
const far = R_.filter((r) => r.allFar);
const farRes = far.map((r) => ({
	photo: r.photo,
	sigmaEN: r.P.sigmaEN,
	sigmaGPS: r.sigmaGPS,
	ratio: (r.P.sigmaEN as number) / r.sigmaGPS,
}));
const crit = {
	pitch: { ...pitch, pass: pitchPass, kill: !pitchPass },
	allFar: {
		n: far.length,
		photos: farRes,
		pass: far.length ? farRes.every((f) => f.ratio >= 0.8) : null,
		kill: farRes.some((f) => f.ratio < 1 / 3),
	},
	calibration: {
		rotMedianZ2: median(zP),
		rotMedianZ2_gt003: median(zPg),
		rotPerParam: Object.fromEntries(
			(["yaw", "pitch", "roll"] as const).map((k, j) => [
				k,
				median(zP.filter((_, i) => i % 3 === j)),
			]),
		),
		eyeMedianZ2: median(zEye),
		nRot: zP.length,
		nEye: zEye.length,
		passRot: median(zP) >= 0.5 && median(zP) <= 2,
		passEye: median(zEye) >= 0.5 && median(zEye) <= 2,
		kill: median(zP) > 9 || median(zEye) > 9,
	},
};
console.log("\nGA1 criteria:", JSON.stringify(crit, null, 1));
writeJson(path.join(GEO_OUT, "ga1", `ga1-eval${tag}.json`), {
	args: process.argv.slice(2),
	dem,
	protocol: "tools/research/geo/PROTOCOL.txt SECTION GA1 (2026-09-30T03:12Z)",
	rows,
	criteria: crit,
});
console.log(`wrote ${path.join(GEO_OUT, "ga1", `ga1-eval${tag}.json`)}`);
void cameraXFromState;
