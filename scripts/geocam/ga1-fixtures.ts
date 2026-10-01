// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GA1 real-data fixtures for the GTSAM parity test (Agent C: tools/research/geo/gtsam_ref.py parity).
 *
 *   npx tsx scripts/geocam/ga1-fixtures.ts [IMG_xxxx ...]      (default: IMG_7018 IMG_7063 IMG_5495; DEV only)
 *
 * Writes out/geocam/fixtures/<photo>_P.json in Agent C's format "geocam-map-fixture/1" (documented in the header of
 * tools/research/geo/gtsam_ref.py) with ONE additive extension for real DEM horizons:
 *
 *   {"type":"skyline", "samples":[{u,v,w}], "horizons":[{"eye":[E,N,U], "step":0.05, "k0":int, "el":[..], "d":[..]}],
 *    "sigmaPx":2, "sigmaK":0.05, "demSigma":"default", "loss":{kind:"cauchy",c:2}, "nEff":60, "eye":true,
 *    "stepM":5, "quantumM":0.25, "cluster":{} }
 *   `horizons` replaces `ridge`: the sector horizons (0.05° bins; bin index (k0 + k) mod 7200 holds el[k] (deg) and d[k]
 *   (m, horizon distance); every other bin is −90 = no data) at the 7 eyes a skyline relinearize() requests at the TS
 *   solution: eL = round(x_eye / quantumM)·quantumM and eL ± stepM along E, N, U (order: eL, +E, −E, +N, −N, +U, −U).
 *   x0 = the TS solution, so solveMap relinearises exactly there (one outer loop); a provider asked for any other eye
 *   must throw (the fixture cannot answer it).
 *
 * Other factors as in the base format: gps {E0,N0,sigmaH}; alt {alt,altBias,sigmaA}; ground {plane:{z0,gE,gN}, h,
 * sigmaAbove, sigmaBelow} (least-squares plane of the Mapterhorn ground over ±25 m around the solution eye: the TS
 * run itself uses the DEM, so TS-vs-GTSAM parity is on the plane, re-solved by ts_fixture_solve.ts); gravity
 * {pitch,roll,sigmaDeg}; compass {heading,sigmaNoiseDeg,sigmaBiasDeg,nu}; focal {fPx1600,sigmaPx1600}; point {name,
 * corrs:[{u,v,world,sigmaPx,depthM}], sigmaPx, demSigma:"default", loss, nEff, cluster:{}} (per-corr sigmaPx / depthM
 * are additive and override the factor-level values, as map/factors.ts pointFactor). Frame: the scene frame of
 * scripts/concord/lib.ts (ENU at the GT fix, z = alt − GT eye alt − d²/2R_eff). Also stored: "tsSolution"
 * {x, sigma, sigmaEN, mad} of the DEM-ground run (informative only).
 */
import path from "node:path";
import type { CameraX, Vec3 } from "../../src/lib/concord/core";
import { EYE_PRIOR_DEFAULTS } from "../../src/lib/concord/priors/altitude";
import { IDX, stateFromCameraX } from "../../src/lib/geocam/core";
import {
	altFactor,
	COMPASS_DEFAULTS,
	compassFactor,
	type Factor,
	focalFactor,
	focalPx1600,
	gpsFactor,
	gravityFactor,
	groundFactor,
	JOINT_DEFAULTS,
	pointFactor,
	skylineFactor,
	solveMap,
} from "../../src/lib/geocam/map";
import { devGTPhotos, GEO_OUT, photoSetup, writeJson } from "./lib";

const args = process.argv.slice(2).filter((a) => a.startsWith("IMG_"));
const photos = devGTPhotos(
	args.length ? args : ["IMG_7018", "IMG_7063", "IMG_5495"],
);
const OUT = path.join(GEO_OUT, "fixtures");

for (const photo of photos) {
	const S = await photoSetup(photo, { start: "app", dem: "mh" });
	const base: CameraX = { ...S.start, intr: { ...S.start.intr, fScale: 1 } };
	const f0 = focalPx1600(base);
	const pts = S.rematch
		.filter((c) => c.kind === "point")
		.map((c) => ({
			u: c.u,
			v: c.v,
			world: (c as { world: Vec3 }).world,
			sigmaPx: c.sigmaPx,
			depthM: c.depthM,
		}));
	const factors: Factor[] = [
		gpsFactor(S.fixEN[0], S.fixEN[1], S.eyePrior.sigmaH),
		groundFactor(S.ground),
		focalFactor(f0, S.focal.fPx, S.focal.sigmaPx),
		skylineFactor(base, S.skyline, S.horizonsAtEyes),
	];
	if (S.meta.alt !== null) factors.push(altFactor(S.meta.alt - S.s.eyeAlt));
	if (S.meta.pitch !== null && S.meta.roll !== null)
		factors.push(gravityFactor(S.meta.pitch, S.meta.roll));
	if (S.meta.heading !== null) factors.push(compassFactor(S.meta.heading));
	if (pts.length)
		factors.push(pointFactor(base, pts, { nEff: 60, name: "rematch" }));
	const p = {
		base,
		f0Px1600: f0,
		factors,
		free: { rotation: true as const, focal: true, eye: true },
	};
	const r = await solveMap(p, stateFromCameraX(base));
	// horizons at the solution's linearisation eyes
	const q = (v: number) => Math.round(v / 0.25) * 0.25;
	const eL: Vec3 = [q(r.x[IDX.E]), q(r.x[IDX.N]), q(r.x[IDX.U])];
	const eyes: Vec3[] = [eL];
	for (let k = 0; k < 3; k++)
		for (const s of [1, -1]) {
			const e: Vec3 = [eL[0], eL[1], eL[2]];
			e[k] += s * 5;
			eyes.push(e);
		}
	const hs = await S.horizonsAtEyes(eyes);
	const horizons = hs.map((h, i) => {
		let k0 = -1;
		const el: number[] = [];
		const d: number[] = [];
		const n = h.elevation.length;
		// the sector: the contiguous run of bins > −90 (it may wrap through 0°)
		let start = 0;
		for (let k = 0; k < n; k++)
			if (h.elevation[k] > -89 && !(h.elevation[(k - 1 + n) % n] > -89)) {
				start = k;
				break;
			}
		for (let j = 0; j < n; j++) {
			const k = (start + j) % n;
			if (!(h.elevation[k] > -89)) break;
			if (k0 < 0) k0 = k;
			el.push(+h.elevation[k].toFixed(5));
			d.push(Math.round(h.distance ? h.distance[k] : 0));
		}
		return { eye: eyes[i], step: h.step, k0, el, d };
	});
	// local ground plane around the solution eye
	let sEE = 0;
	let sNN = 0;
	let sEN = 0;
	let sEz = 0;
	let sNz = 0;
	let sz = 0;
	let m = 0;
	for (let i = -5; i <= 5; i++)
		for (let j = -5; j <= 5; j++) {
			const de = i * 5;
			const dn = j * 5;
			const z = S.ground(eL[0] + de, eL[1] + dn);
			if (!Number.isFinite(z)) continue;
			sEE += de * de;
			sNN += dn * dn;
			sEN += de * dn;
			sEz += de * z;
			sNz += dn * z;
			sz += z;
			m++;
		}
	const det = sEE * sNN - sEN * sEN;
	const gE = (sEz * sNN - sNz * sEN) / det;
	const gN = (sNz * sEE - sEz * sEN) / det;
	const zc = sz / m;
	const plane = { z0: zc - gE * eL[0] - gN * eL[1], gE, gN };
	const F: Record<string, unknown>[] = [
		{ type: "gps", E0: S.fixEN[0], N0: S.fixEN[1], sigmaH: S.eyePrior.sigmaH },
		{
			type: "ground",
			plane,
			h: EYE_PRIOR_DEFAULTS.eyeAboveGround,
			sigmaAbove: JOINT_DEFAULTS.groundSigmaM,
			sigmaBelow: JOINT_DEFAULTS.groundBelowSigmaM,
		},
		{ type: "focal", fPx1600: S.focal.fPx, sigmaPx1600: S.focal.sigmaPx },
		{
			type: "skyline",
			samples: S.skyline,
			horizons,
			sigmaPx: JOINT_DEFAULTS.skylineSigmaPx,
			sigmaK: 0.05,
			demSigma: "default",
			loss: { kind: "cauchy", c: 2 },
			nEff: JOINT_DEFAULTS.skylineEff,
			eye: true,
			stepM: 5,
			quantumM: 0.25,
			cluster: {},
		},
	];
	if (S.meta.alt !== null)
		F.push({
			type: "alt",
			alt: S.meta.alt - S.s.eyeAlt,
			altBias: EYE_PRIOR_DEFAULTS.altBias,
			sigmaA: EYE_PRIOR_DEFAULTS.sigmaA,
		});
	if (S.meta.pitch !== null && S.meta.roll !== null)
		F.push({
			type: "gravity",
			pitch: S.meta.pitch,
			roll: S.meta.roll,
			sigmaDeg: 1.5,
		});
	if (S.meta.heading !== null)
		F.push({
			type: "compass",
			heading: S.meta.heading,
			sigmaNoiseDeg: COMPASS_DEFAULTS.sigmaNoiseDeg,
			sigmaBiasDeg: COMPASS_DEFAULTS.sigmaBiasDeg,
			nu: COMPASS_DEFAULTS.nu,
		});
	if (pts.length)
		F.push({
			type: "point",
			name: "rematch",
			corrs: pts,
			sigmaPx: 2,
			demSigma: "default",
			loss: { kind: "cauchy", c: 2.5 },
			nEff: 60,
			cluster: {},
		});
	const file = path.join(OUT, `${photo}_P.json`);
	writeJson(file, {
		format: "geocam-map-fixture/1",
		name: `${photo}_P`,
		note: `GA1 config P (priors + skyline${pts.length ? " + re-match points" : ""}) on DEV ${photo}, Mapterhorn; x0 = TS solution; skyline horizons precomputed (extension "horizons")`,
		base,
		f0Px1600: f0,
		free: p.free,
		x0: Array.from(r.x),
		truth: null,
		opts: { madRescale: true },
		factors: F,
		tsSolution: {
			x: Array.from(r.x),
			sigma: r.sigma,
			sigmaEN: r.sigmaEN,
			mad: r.mad,
			converged: r.converged,
		},
	});
	console.log(
		`${photo}: wrote ${file} (sky ${S.skyline.length}, pts ${pts.length}, σEN ${r.sigmaEN.toFixed(2)}, eL [${eL.join(", ")}])`,
	);
}
