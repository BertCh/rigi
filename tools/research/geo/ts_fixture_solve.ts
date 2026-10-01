// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GEO parity harness, TS side: run Agent B's GA1 solveMap (src/lib/geocam/map) on "geocam-map-fixture/1"
// JSON fixtures and write the result next to each fixture as <name>.ts.json for gtsam_ref.py to compare.
// Read-only use of src/**; the fixture format is documented in gtsam_ref.py's header.
//
//   npx tsx tools/research/geo/ts_fixture_solve.ts out/geocam/python/fixtures/*.json
//
// Output <name>.ts.json: { x, cov (49, row-major), sigma, sigmaEN, mad, converged, iterations, outer, ms,
//   perFamily: [{family, n, nEff, chi2}],
//   relin: [[7] ...]      // the state of every solveMap relinAll() pass, in order (last = covariance state)
//   sky: [{eL, sigmas, h0}]  // skyline factor state after each pass (sigmas px@1600, h0 = horizon elevation) }
import { readFileSync, writeFileSync } from "node:fs";
import type { CameraX, Vec3 } from "../../../src/lib/concord/core";
import {
	altFactor,
	compassFactor,
	type Factor,
	focalFactor,
	gpsFactor,
	gravityFactor,
	groundFactor,
	type Loss,
	type MapProblem,
	pointFactor,
	skylineFactor,
	solveMap,
} from "../../../src/lib/geocam/map";
import type { EyeHorizon, HorizonsAtEyes } from "../../../src/lib/pose6dof/eye";

const D = Math.PI / 180;

type FixFactor = Record<string, unknown> & { type: string };
type Fixture = {
	format: string;
	name: string;
	base: CameraX;
	f0Px1600: number;
	free: MapProblem["free"];
	x0: number[];
	opts: {
		madRescale?: boolean;
		trustM?: number;
		maxOuter?: number;
		maxIter?: number;
		relinM?: number;
	};
	factors: FixFactor[];
};

/** Horizon (0.05° bins, −90 = no data) of a ridge polyline seen from an eye (map.check.ts horizonOf). */
export function horizonOf(R: Vec3[], eye: Vec3): EyeHorizon {
	const step = 0.05;
	const n = 7200;
	const elevation = new Float32Array(n).fill(-90);
	const distance = new Float32Array(n);
	const az = R.map(
		(p) => (((Math.atan2(p[0] - eye[0], p[1] - eye[1]) / D) % 360) + 360) % 360,
	);
	for (let i = 0; i + 1 < R.length; i++) {
		const a0 = az[i];
		let a1 = az[i + 1];
		if (a1 - a0 > 180) a1 -= 360;
		if (a0 - a1 > 180) a1 += 360;
		const lo = Math.ceil(Math.min(a0, a1) / step);
		const hi = Math.floor(Math.max(a0, a1) / step);
		for (let k = lo; k <= hi; k++) {
			const t = a1 === a0 ? 0 : (k * step - a0) / (a1 - a0);
			const p = [0, 1, 2].map((j) => R[i][j] + t * (R[i + 1][j] - R[i][j]));
			const dh = Math.hypot(p[0] - eye[0], p[1] - eye[1]);
			const el = Math.atan2(p[2] - eye[2], dh) / D;
			const b = ((k % n) + n) % n;
			if (el > elevation[b]) {
				elevation[b] = el;
				distance[b] = dh;
			}
		}
	}
	return { step, elevation, distance };
}

const num = (v: unknown) => v as number;

async function run(path: string) {
	const fx = JSON.parse(readFileSync(path, "utf8")) as Fixture;
	if (fx.format !== "geocam-map-fixture/1")
		throw new Error(`${path}: format ${fx.format}`);
	const base: CameraX = fx.base;
	const factors: Factor[] = [];
	const relin: number[][] = [];
	const sky: unknown[] = [];
	let first: Factor | null = null;
	const record = (f: Factor) => {
		// record the state once per relinAll pass (the first relinearising factor sees every pass)
		const orig = f.relinearize?.bind(f);
		if (!orig) return;
		first ??= f;
		f.relinearize = async (x) => {
			if (f === first) relin.push(Array.from(x));
			await orig(x);
		};
	};
	for (const f of fx.factors) {
		switch (f.type) {
			case "gps":
				factors.push(gpsFactor(num(f.E0), num(f.N0), num(f.sigmaH)));
				break;
			case "alt":
				factors.push(altFactor(num(f.alt), num(f.altBias), num(f.sigmaA)));
				break;
			case "ground": {
				const p = f.plane as { z0: number; gE: number; gN: number };
				factors.push(
					groundFactor(
						(e, n) => p.z0 + p.gE * e + p.gN * n,
						num(f.h),
						num(f.sigmaAbove),
						num(f.sigmaBelow),
					),
				);
				break;
			}
			case "gravity":
				factors.push(gravityFactor(num(f.pitch), num(f.roll), num(f.sigmaDeg)));
				break;
			case "compass":
				factors.push(
					compassFactor(num(f.heading), {
						sigmaNoiseDeg: num(f.sigmaNoiseDeg),
						sigmaBiasDeg: num(f.sigmaBiasDeg),
						nu: num(f.nu),
					}),
				);
				break;
			case "focal":
				factors.push(
					focalFactor(fx.f0Px1600, num(f.fPx1600), num(f.sigmaPx1600)),
				);
				break;
			case "point":
				factors.push(
					pointFactor(
						base,
						f.corrs as { u: number; v: number; world: Vec3 }[],
						{
							sigmaPx: num(f.sigmaPx),
							demSigmaM: f.demSigma === null ? null : undefined,
							loss: f.loss as Loss,
							nEff: f.nEff === null ? undefined : num(f.nEff),
							name: (f.name as string) ?? "point",
							cluster: f.cluster as
								| { rho?: number; sectorDeg?: number }
								| null
								| undefined,
						},
					),
				);
				if (factors[factors.length - 1].relinearize)
					record(factors[factors.length - 1]);
				break;
			case "skyline": {
				const R = f.ridge as Vec3[];
				const hz: HorizonsAtEyes = async (eyes) =>
					eyes.map((e) => horizonOf(R, e));
				const sf = skylineFactor(
					base,
					f.samples as { u: number; v: number; w: number }[],
					hz,
					{
						sigmaPx: num(f.sigmaPx),
						sigmaK: num(f.sigmaK),
						loss: f.loss as Loss,
						nEff: num(f.nEff),
						eye: f.eye as boolean,
						stepM: num(f.stepM),
						quantumM: num(f.quantumM),
						cluster: f.cluster as
							| { rho?: number; sectorDeg?: number }
							| null
							| undefined,
					},
				);
				record(sf);
				const inner = sf.relinearize?.bind(sf);
				sf.relinearize = async (x) => {
					await inner?.(x);
					const L = sf.lin();
					if (!L) return;
					sky.push({
						eL: L.eL,
						sigmas: Array.from(sf.sigmas()),
						h0: Array.from(L.h0.elevation),
					});
				};
				factors.push(sf);
				break;
			}
			default:
				throw new Error(`unknown factor type ${f.type}`);
		}
	}
	const p: MapProblem = { base, f0Px1600: fx.f0Px1600, factors, free: fx.free };
	const r = await solveMap(p, Float64Array.from(fx.x0), {
		madRescale: fx.opts.madRescale,
		trustM: fx.opts.trustM,
		maxOuter: fx.opts.maxOuter,
		maxIter: fx.opts.maxIter,
		relinM: fx.opts.relinM,
	});
	const out = {
		name: fx.name,
		x: Array.from(r.x),
		cov: Array.from(r.cov),
		sigma: r.sigma,
		sigmaEN: r.sigmaEN,
		mad: r.mad,
		converged: r.converged,
		iterations: r.iterations,
		outer: r.outer,
		ms: r.ms,
		perFamily: r.perFamily.map(({ family, n, nEff, chi2 }) => ({
			family,
			n,
			nEff,
			chi2,
		})),
		relin,
		sky,
	};
	const dst = path.replace(/\.json$/, ".ts.json");
	writeFileSync(dst, JSON.stringify(out));
	console.log(
		`${fx.name}: x=[${out.x.map((v) => v.toFixed(4)).join(", ")}] outer=${r.outer} mad=${r.mad.toFixed(3)} -> ${dst}`,
	);
}

const files = process.argv
	.slice(2)
	.filter((f) => f.endsWith(".json") && !f.endsWith(".ts.json"));
if (!files.length) {
	console.error(
		"usage: npx tsx tools/research/geo/ts_fixture_solve.ts <fixture.json>...",
	);
	process.exit(2);
}
for (const f of files) await run(f);
