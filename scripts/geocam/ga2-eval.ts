/**
 * GA2 evaluation (Agent D): does the per-photo CRLB σ_eye rank the actual eye error?
 * Rule: tools/research/geo/PROTOCOL.txt SECTION GA2 (frozen before scoring).
 *
 *   npx tsx scripts/geocam/ga2-eval.ts [--decoys-only | --gt-only]
 *
 * PRIMARY: E1 displaced-eye decoys (out/geocam/decoys, POS + NE-dec primary cut): MAP solve per hypothesis
 * (gps at the hypothesis eye σ 20 m, alt σ 5 m, focal, points), CRLB σ_eye at the solution vs the horizontal
 * eye error to the true eye; Spearman ρ, kill ρ < 0.5.
 * SECONDARY: GT dev photos, GA1 config P (copied build), CRLB σ per DoF + GPS-displaced runs.
 * Writes out/geocam/ga2/ga2-eval.json.
 */
import fs from "node:fs";
import path from "node:path";
import type { CameraX } from "../../src/lib/concord/core";
import { IDENTITY_INTRINSICS } from "../../src/lib/concord/core";
import type { JointCue } from "../../src/lib/concord/solve";
import { focalPx1600 } from "../../src/lib/concord/solve/joint";
import {
	type Factor,
	type GeoState,
	IDX,
	type MapProblem,
	type MapResult,
	stateFromCameraX,
} from "../../src/lib/geocam/core";
import {
	altFactor,
	compassFactor,
	focalFactor,
	gpsFactor,
	gravityFactor,
	groundFactor,
	pointFactor,
	skylineFactor,
	solveMap,
} from "../../src/lib/geocam/map";
import { crlb, type FisherReport } from "../../src/lib/geocam/observe";
import {
	assertWildDev,
	devGTPhotos,
	GEO_OUT,
	type PhotoSetup,
	photoSetup,
	writeJson,
} from "./lib";

const args = process.argv.slice(2);
const OUT = path.join(GEO_OUT, "ga2");
const DECOYS = path.join(GEO_OUT, "decoys");

// ---------------------------------------------------------------- stats

function ranks(a: number[]): number[] {
	const idx = a
		.map((v, i) => [v, i] as [number, number])
		.sort((x, y) => x[0] - y[0]);
	const r = new Array<number>(a.length);
	for (let i = 0; i < idx.length; ) {
		let j = i;
		while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
		for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
		i = j + 1;
	}
	return r;
}
export function spearman(x: number[], y: number[]): number {
	// NaN / null = missing; ±∞ is a valid extreme and ranks last / first
	const ok = x.map(
		(_, i) =>
			typeof x[i] === "number" &&
			typeof y[i] === "number" &&
			!Number.isNaN(x[i]) &&
			!Number.isNaN(y[i]),
	);
	const xs = x.filter((_, i) => ok[i]);
	const ys = y.filter((_, i) => ok[i]);
	if (xs.length < 3) return Number.NaN;
	const rx = ranks(xs);
	const ry = ranks(ys);
	const m = (rx.length + 1) / 2;
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < rx.length; i++) {
		sxy += (rx[i] - m) * (ry[i] - m);
		sxx += (rx[i] - m) ** 2;
		syy += (ry[i] - m) ** 2;
	}
	return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : Number.NaN;
}
const median = (a: number[]) => {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : Number.NaN;
};
let seed = 20260930;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
/** Bootstrap-by-group 95% interval of Spearman ρ. */
function bootRho(
	rows: { g: string; s: number; e: number }[],
	B = 2000,
): [number, number] {
	const groups = [...new Set(rows.map((r) => r.g))];
	const by = new Map(groups.map((g) => [g, rows.filter((r) => r.g === g)]));
	const vals: number[] = [];
	for (let b = 0; b < B; b++) {
		const pick: typeof rows = [];
		for (let k = 0; k < groups.length; k++)
			pick.push(...(by.get(groups[Math.floor(rnd() * groups.length)]) ?? []));
		const r = spearman(
			pick.map((p) => p.s),
			pick.map((p) => p.e),
		);
		if (Number.isFinite(r)) vals.push(r);
	}
	vals.sort((a, b) => a - b);
	return [
		vals[Math.floor(0.025 * vals.length)],
		vals[Math.floor(0.975 * vals.length)],
	];
}

/** JSON-safe rounding; +∞ (a singular CRLB: nothing determined) is stored as 1e9 so it ranks last. */
const r3 = (x: number) =>
	x === Number.POSITIVE_INFINITY
		? 1e9
		: Number.isFinite(x)
			? +x.toFixed(3)
			: null;
const sigmaRow = (fr: FisherReport) => ({
	sigma: Object.fromEntries(
		Object.entries(fr.sigma).map(([k, v]) => [k, r3(v)]),
	),
	sigmaEye: r3(fr.sigmaEye),
	sigmaU: r3(fr.sigmaU),
	cond: r3(fr.cond),
	byFamily: fr.byFamily.map((f) => ({
		family: f.family,
		n: f.n,
		share: r3(f.share),
		sigmaEyeAlone: r3(f.sigmaEyeAlone),
	})),
});

// ---------------------------------------------------------------- primary: E1 decoys

type Hyp = {
	id: string;
	kind: string;
	label: string;
	secondary: boolean;
	eyeEnu: [number, number, number];
	dispDistM: number | null;
	pose: { yaw: number; pitch: number; roll: number; vfov: number };
	uv: [number, number][];
	xyz: [number, number, number][];
	dist: number[];
};
type DecoyFile = {
	pid: string;
	W: number;
	H: number;
	f0Px: number;
	focalKnown: boolean;
	stated: { h: number };
	refs: { eyeEnu: [number, number, number] }[];
	hyps: Hyp[];
};

async function decoys() {
	const files = fs
		.readdirSync(DECOYS)
		.filter((f) => f.endsWith(".json"))
		.sort();
	const rows: Record<string, unknown>[] = [];
	for (const f of files) {
		const d: DecoyFile = JSON.parse(
			fs.readFileSync(path.join(DECOYS, f), "utf8"),
		);
		assertWildDev(d.pid);
		const truth = d.refs[0]?.eyeEnu ?? [0, 0, d.stated.h];
		const hyps = d.hyps.filter(
			(h) =>
				(h.label === "POS" && (h.kind === "POOL" || h.kind === "REF")) ||
				(h.label === "NE-dec" && !h.secondary),
		);
		for (const h of hyps) {
			const t0 = Date.now();
			const base: CameraX = {
				pose: { ...h.pose },
				eye: [...h.eyeEnu],
				aspect: d.W / d.H,
				intr: { ...IDENTITY_INTRINSICS },
			};
			const f0 = focalPx1600(base);
			const k1600 = 1600 / Math.max(d.W, d.H);
			const fPx = d.f0Px * k1600;
			const factors: Factor[] = [
				gpsFactor(h.eyeEnu[0], h.eyeEnu[1], 20),
				altFactor(h.eyeEnu[2], 0, 5),
				focalFactor(f0, fPx, fPx * (d.focalKnown ? 0.03 : 0.1)),
				pointFactor(
					base,
					h.uv.map((uv, i) => ({
						u: uv[0] / d.W,
						v: uv[1] / d.H,
						world: h.xyz[i],
						depthM: h.dist[i],
					})),
					{ nEff: 60, name: "e1" },
				),
			];
			const p: MapProblem = {
				base,
				f0Px1600: f0,
				factors,
				free: { rotation: true, focal: true, eye: true },
			};
			const x0 = stateFromCameraX(base);
			let r: MapResult;
			try {
				r = await solveMap(p, x0);
			} catch (e) {
				console.error(`${h.id}: ${(e as Error).message}`);
				continue;
			}
			const fr = await crlb(p, r.x);
			const err = Math.hypot(r.x[IDX.E] - truth[0], r.x[IDX.N] - truth[1]);
			const err0 = Math.hypot(h.eyeEnu[0] - truth[0], h.eyeEnu[1] - truth[1]);
			const row = {
				pid: d.pid,
				id: h.id,
				label: h.label,
				kind: h.kind,
				dispDistM: h.dispDistM,
				nPts: h.uv.length,
				minDistM: Math.round(Math.min(...h.dist)),
				medDistM: Math.round(median(h.dist)),
				err0: r3(err0),
				err: r3(err),
				eyeMove: r3(Math.hypot(r.x[IDX.E] - x0[IDX.E], r.x[IDX.N] - x0[IDX.N])),
				sigmaEyeLaplace: r3(r.sigmaEN),
				mad: r3(r.mad),
				converged: r.converged,
				...sigmaRow(fr),
				ms: Date.now() - t0,
			};
			rows.push(row);
			console.log(
				`${h.id.padEnd(26)} ${h.label.padEnd(6)} err0 ${err0.toFixed(0).padStart(4)} → ${err.toFixed(1).padStart(6)} m  σ_eye ${fr.sigmaEye.toFixed(1)} (Laplace ${r.sigmaEN.toFixed(1)}) m`,
			);
		}
	}
	return rows;
}

// ---------------------------------------------------------------- secondary: GT dev (GA1 config P, copied)

function buildP(
	S: PhotoSetup,
	base: CameraX,
	gpsShift: [number, number] = [0, 0],
) {
	const f0 = focalPx1600(base);
	const pr = S.eyePrior;
	const factors: Factor[] = [
		gpsFactor(S.fixEN[0] + gpsShift[0], S.fixEN[1] + gpsShift[1], pr.sigmaH),
		groundFactor(S.ground),
		focalFactor(f0, S.focal.fPx, S.focal.sigmaPx),
		skylineFactor(base, S.skyline, S.horizonsAtEyes, { eye: true }),
	];
	if (S.meta.alt !== null) factors.push(altFactor(S.meta.alt - S.s.eyeAlt));
	if (S.meta.pitch !== null && S.meta.roll !== null)
		factors.push(gravityFactor(S.meta.pitch, S.meta.roll));
	if (S.meta.heading !== null) factors.push(compassFactor(S.meta.heading));
	const pts = S.rematch.filter((c: JointCue) => c.kind === "point");
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
	const p: MapProblem = {
		base,
		f0Px1600: f0,
		factors,
		free: { rotation: true, focal: true, eye: true },
	};
	return { p, x0: stateFromCameraX(base) as GeoState };
}

async function gtDev() {
	const rows: Record<string, unknown>[] = [];
	for (const photo of devGTPhotos()) {
		const t0 = Date.now();
		const S = await photoSetup(photo, { start: "app", dem: "mh" });
		const base: CameraX = { ...S.start, intr: { ...S.start.intr, fScale: 1 } };
		const { p, x0 } = buildP(S, base);
		const r = await solveMap(p, x0);
		const fr = await crlb(p, r.x);
		const runs = [];
		for (const b of [0, 90, 180, 270]) {
			const sh: [number, number] = [
				150 * Math.sin((b * Math.PI) / 180),
				150 * Math.cos((b * Math.PI) / 180),
			];
			const q = buildP(S, base, sh);
			const x1 = Float64Array.from(q.x0);
			x1[IDX.E] = sh[0];
			x1[IDX.N] = sh[1];
			const rr = await solveMap(q.p, x1);
			const ff = await crlb(q.p, rr.x);
			runs.push({
				bearing: b,
				err: r3(Math.hypot(rr.x[IDX.E], rr.x[IDX.N])),
				sigmaEye: r3(ff.sigmaEye),
				sigmaEyeLaplace: r3(rr.sigmaEN),
			});
		}
		rows.push({
			photo,
			eyeFromFix: r3(Math.hypot(r.x[IDX.E], r.x[IDX.N])),
			sigmaEyeLaplace: r3(r.sigmaEN),
			...sigmaRow(fr),
			runs,
			ms: Date.now() - t0,
		});
		console.log(
			`${photo}: σ_eye ${fr.sigmaEye.toFixed(1)} m (Laplace ${r.sigmaEN.toFixed(1)}), σ yaw ${fr.sigma.yaw.toFixed(3)}° pitch ${fr.sigma.pitch.toFixed(3)}°; displaced errs ${runs.map((u) => u.err).join(",")}`,
		);
	}
	return rows;
}

// ---------------------------------------------------------------- main

const out: Record<string, unknown> = {};
if (!args.includes("--gt-only")) {
	const rows = (await decoys()) as {
		pid: string;
		label: string;
		err: number;
		sigmaEye: number;
		sigmaEyeLaplace: number;
	}[];
	const s = rows.map((r) => r.sigmaEye);
	const e = rows.map((r) => r.err);
	const ne = rows.filter((r) => r.label === "NE-dec");
	const rho = spearman(s, e);
	const conf = ne.filter((r) => r.err > 50 && r.sigmaEye < 15).length;
	out.decoys = {
		n: rows.length,
		nPOS: rows.filter((r) => r.label === "POS").length,
		nNEdec: ne.length,
		rho,
		rhoCI: bootRho(rows.map((r) => ({ g: r.pid, s: r.sigmaEye, e: r.err }))),
		rhoNEdec: spearman(
			ne.map((r) => r.sigmaEye),
			ne.map((r) => r.err),
		),
		rhoLaplace: spearman(
			rows.map((r) => r.sigmaEyeLaplace),
			e,
		),
		median: Object.fromEntries(
			["POS", "NE-dec"].map((l) => {
				const q = rows.filter((r) => r.label === l);
				return [
					l,
					{
						sigmaEye: median(q.map((r) => r.sigmaEye)),
						err: median(q.map((r) => r.err)),
					},
				];
			}),
		),
		confidentlyWrong: {
			k: conf,
			n: ne.length,
			frac: ne.length ? conf / ne.length : Number.NaN,
		},
		verdict: Number.isFinite(rho)
			? rho < 0.5
				? "KILLED"
				: "PASS"
			: "UNTESTABLE",
		rows,
	};
	console.log(
		JSON.stringify({ ...(out.decoys as object), rows: undefined }, null, 1),
	);
}
if (!args.includes("--decoys-only")) {
	const rows = (await gtDev()) as {
		runs: { err: number; sigmaEye: number }[];
	}[];
	const runs = rows.flatMap((r) => r.runs);
	out.gt = {
		rhoDisplaced: spearman(
			runs.map((r) => r.sigmaEye),
			runs.map((r) => r.err),
		),
		rows,
	};
	console.log(
		`GT displaced ρ = ${(out.gt as { rhoDisplaced: number }).rhoDisplaced}`,
	);
}
const file = path.join(
	OUT,
	args.includes("--gt-only")
		? "ga2-eval-gt.json"
		: args.includes("--decoys-only")
			? "ga2-eval-decoys.json"
			: "ga2-eval.json",
);
writeJson(file, out);
console.log(`wrote ${file}`);
