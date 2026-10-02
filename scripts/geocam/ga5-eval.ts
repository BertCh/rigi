// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GA5 evaluation (reports/geometry-first-pose.md G6 + G7 / §5 GA5): solution-separation protection level
 * + viewshed veto on the FUND E1 hypotheses (true poses, wrong-basin and displaced-eye decoys).
 * Rule frozen in tools/research/geo/PROTOCOL.txt, SECTION GA5 (written before any number here).
 *
 *   npx tsx scripts/geocam/ga5-eval.ts [--no-eyefree] [wc_0002 ...]
 *
 * Input: out/geocam/decoys/<pid>.json (Agent C, format geocam-decoys/1), dev ids only (lib.assertWildDev).
 * Output: out/geocam/ga5/{hyps.json, summary.json}.
 */
import fs from "node:fs";
import path from "node:path";
import type { HeightFn } from "../../src/lib/concord/cues/raycast";
import { MAPTERHORN, type TerrainLevel } from "../../src/lib/dem";
import { loadTerrain } from "../../src/lib/geo/terrain";
import {
	type CameraX,
	IDX,
	type MapProblem,
	stateFromCameraX,
	type Vec3,
} from "../../src/lib/geocam/core";
import {
	bubbleTest,
	protectionLevel,
	type RowInfo,
	viewshedVeto,
} from "../../src/lib/geocam/integrity";
import {
	type Corr2D3D,
	gpsFactor,
	pointFactor,
	solveMap,
} from "../../src/lib/geocam/map";
import { DEG, destination } from "../../src/lib/geodesy";
import { demTileLoaderNode } from "../lib/node-io";
import {
	assertWildDev,
	FastSampler,
	GEO_OUT,
	median,
	R_EFF,
	writeJson,
} from "./lib";

const OUT = path.join(GEO_OUT, "ga5");
const DECOYS = path.join(GEO_OUT, "decoys");
const ALERT = { yaw: 1.0, pitch: 0.5, H: 50, V: 25 };
const MIN_ROWS = 24;
const NEG = ["NB-inh", "NB-con", "NB-dec", "NE-inh", "NE-dec"];

const args = process.argv.slice(2);
const noEyeFree = args.includes("--no-eyefree");
const summaryOnly = args.includes("--summary-only");
const onlyIds = args.filter((a) => a.startsWith("wc_"));

type Pose = { yaw: number; pitch: number; roll: number; vfov: number };
type Hyp = {
	id: string;
	kind: string;
	label: string;
	secondary: boolean;
	eyeEnu: Vec3;
	eyeOffsetM: Vec3;
	dispDistM: number | null;
	pose: Pose;
	nCorr: number;
	nKept: number;
	uv: [number, number][];
	xyz: Vec3[];
	dist: number[];
	e1: {
		log10NFA: number;
		T: number;
		Tfit: number;
		accept: Record<string, boolean>;
		misfitMedPx: number | null;
	};
};
type DecoyFile = {
	format: string;
	pid: string;
	stated: { lat: number; lon: number; h: number };
	W: number;
	H: number;
	hyps: Hyp[];
};

const mhTiles = new Map<string, Float32Array>();
const loadMH = demTileLoaderNode(MAPTERHORN);
async function heightFor(lat: number, lon: number): Promise<HeightFn> {
	const levels: TerrainLevel[] = [
		{ z: 17, maxDistance: 300 },
		...MAPTERHORN.levels,
	];
	const t = await loadTerrain(
		lat,
		lon,
		loadMH,
		levels,
		mhTiles,
		8,
		MAPTERHORN.tileSize,
	);
	const fs_ = new FastSampler(t);
	// app ENU frame with curvature (PROTOCOL GA5 frame probe): z = alt − dO²/2R_eff
	return (e, n, d) => {
		const dO = Math.hypot(e, n);
		const p =
			dO > 0 ? destination(lat, lon, Math.atan2(e, n) / DEG, dO) : { lat, lon };
		return fs_.sampleAt(p.lon, p.lat, d) - (dO * dO) / (2 * R_EFF);
	};
}

type Row = {
	pid: string;
	id: string;
	kind: string;
	label: string;
	nCorr: number;
	nKept: number;
	dispDistM: number | null;
	e1AC1: boolean;
	e1AC2: boolean;
	e1CUR: boolean;
	available: boolean;
	plYawDeg: number;
	plPitchDeg: number;
	worstYaw: string;
	worstPitch: string;
	integrityPass: boolean;
	integrityReasons: string[];
	vsOk: boolean;
	vsReasons: string[];
	aboveDemM: number;
	occludedFrac: number;
	reject: boolean;
	eyeFree?: {
		plH: number;
		plV: number;
		plYawDeg: number;
		pass: boolean;
		moveH: number;
		moveV: number;
		outsideBubble: boolean;
		bubbleH: number;
	};
	ms: number;
};

async function evalHyp(
	pid: string,
	d: DecoyFile,
	h: Hyp,
	height: HeightFn,
): Promise<Row> {
	const t0 = Date.now();
	const base: CameraX = {
		pose: { ...h.pose },
		eye: [h.eyeEnu[0], h.eyeEnu[1], h.eyeEnu[2]],
		aspect: d.W / d.H,
		intr: { fScale: 1, k1: 0, cx: 0, cy: 0 },
	};
	const corrs: Corr2D3D[] = h.uv.map((q, i) => ({
		u: q[0] / d.W,
		v: q[1] / d.H,
		world: h.xyz[i],
		depthM: h.dist[i],
	}));
	const split = corrs.length ? median(corrs.map((c) => c.depthM as number)) : 0;
	const rowInfo: RowInfo[] = [];
	for (const c of corrs) {
		rowInfo.push({ u: c.u, depthM: c.depthM as number });
		rowInfo.push({ u: c.u, depthM: c.depthM as number });
	}
	const pf = pointFactor(base, corrs, { sigmaPx: 3 });
	const row: Row = {
		pid,
		id: h.id,
		kind: h.kind,
		label: h.label,
		nCorr: h.nCorr,
		nKept: h.nKept,
		dispDistM: h.dispDistM,
		e1AC1: !!h.e1?.accept?.AC1,
		e1AC2: !!h.e1?.accept?.AC2,
		e1CUR: !!h.e1?.accept?.CUR,
		available: false,
		plYawDeg: Number.POSITIVE_INFINITY,
		plPitchDeg: Number.POSITIVE_INFINITY,
		worstYaw: "",
		worstPitch: "",
		integrityPass: false,
		integrityReasons: [],
		vsOk: true,
		vsReasons: [],
		aboveDemM: Number.NaN,
		occludedFrac: Number.NaN,
		reject: true,
		ms: 0,
	};
	// PRIMARY: rotation only, eye + focal fixed at the hypothesis
	const x0 = stateFromCameraX(base);
	if (corrs.length * 2 >= MIN_ROWS) {
		const p: MapProblem = {
			base,
			f0Px1600: 1,
			factors: [pf],
			free: { rotation: true, focal: false, eye: false },
		};
		const full = await solveMap(p, x0);
		const pl = await protectionLevel(p, full, {
			rowInfo: (f) => (f === pf ? rowInfo : undefined),
			bandSplitM: split,
			minRows: MIN_ROWS,
			alertYawDeg: ALERT.yaw,
			alertPitchDeg: ALERT.pitch,
		});
		row.available = pl.subsets.length > 0 && pl.subsets.every((s) => s.ok);
		row.plYawDeg = pl.plYawDeg;
		row.plPitchDeg = pl.plPitchDeg;
		row.worstYaw = pl.worst.yaw;
		row.worstPitch = pl.worst.pitch;
		row.integrityPass = pl.pass;
		row.integrityReasons = pl.reasons;
		// SECONDARY: eye free with a prior centred on the hypothesis eye
		if (!noEyeFree) {
			const e = h.eyeEnu;
			const altF = {
				family: "alt" as const,
				name: "altHyp",
				dim: 1,
				loss: { kind: "l2" as const },
				prior: true,
				residual: (x: Float64Array) => Float64Array.of((x[IDX.U] - e[2]) / 10),
			};
			const pE: MapProblem = {
				base,
				f0Px1600: 1,
				factors: [pf, gpsFactor(e[0], e[1], 20), altF],
				free: { rotation: true, focal: false, eye: true },
			};
			const fullE = await solveMap(pE, full.x);
			const plE = await protectionLevel(pE, fullE, {
				rowInfo: (f) => (f === pf ? rowInfo : undefined),
				bandSplitM: split,
				minRows: MIN_ROWS,
				alertH: ALERT.H,
				alertV: ALERT.V,
				alertYawDeg: ALERT.yaw,
				alertPitchDeg: ALERT.pitch,
			});
			const bt = bubbleTest(x0, fullE, plE);
			row.eyeFree = {
				plH: plE.plH,
				plV: plE.plV,
				plYawDeg: plE.plYawDeg,
				pass: plE.pass,
				moveH: bt.dH,
				moveV: bt.dV,
				outsideBubble: bt.outside,
				bubbleH: bt.bubbleH,
			};
		}
	} else
		row.integrityReasons = [`unavailable: ${corrs.length} correspondences`];
	const vs = viewshedVeto({ height }, base.eye, h.xyz);
	row.vsOk = vs.ok;
	row.vsReasons = vs.reasons;
	row.aboveDemM = vs.aboveDemM;
	row.occludedFrac = vs.occludedFrac;
	row.reject = !row.integrityPass || !row.vsOk;
	row.ms = Date.now() - t0;
	return row;
}

// ---------------------------------------------------------------- stats

/** ln Γ(x) (Lanczos, g = 7). */
function lgamma(x: number): number {
	const c = [
		0.99999999999980993, 676.5203681218851, -1259.1392167224028,
		771.32342877765313, -176.61502916214059, 12.507343278686905,
		-0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
	];
	if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
	const xx = x - 1;
	let a = c[0];
	const t = xx + 7.5;
	for (let i = 1; i < 9; i++) a += c[i] / (xx + i);
	return (
		0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a)
	);
}

/** Clopper–Pearson 95 % interval for k/n (bisection on the binomial tails, log-space pmf). */
function cp(k: number, n: number): [number, number] {
	if (!n) return [0, 1];
	/** P(X ≤ kk) for X ~ Bin(n, p). */
	const cdf = (p: number, kk: number) => {
		if (kk < 0) return 0;
		if (kk >= n) return 1;
		if (p <= 0) return 1;
		if (p >= 1) return 0;
		const lc = lgamma(n + 1);
		let s = 0;
		for (let i = 0; i <= kk; i++)
			s += Math.exp(
				lc -
					lgamma(i + 1) -
					lgamma(n - i + 1) +
					i * Math.log(p) +
					(n - i) * Math.log1p(-p),
			);
		return Math.min(1, s);
	};
	const bisect = (inc: (p: number) => number, target: number) => {
		// inc is increasing in p: the p where it crosses target
		let a = 0;
		let b = 1;
		for (let it = 0; it < 60; it++) {
			const m = (a + b) / 2;
			if (inc(m) < target) a = m;
			else b = m;
		}
		return (a + b) / 2;
	};
	const lo = k === 0 ? 0 : bisect((p) => 1 - cdf(p, k - 1), 0.025);
	const hi = k === n ? 1 : bisect((p) => 1 - cdf(p, k), 0.975);
	return [lo, hi];
}

const rate = (rows: Row[], pred: (r: Row) => boolean) => {
	const k = rows.filter(pred).length;
	return {
		k,
		n: rows.length,
		rate: rows.length ? k / rows.length : Number.NaN,
		cp95: cp(k, rows.length),
	};
};

function summarise(rows: Row[], rejectFn: (r: Row) => boolean) {
	const pos = rows.filter((r) => r.label === "POS");
	const neg = rows.filter((r) => NEG.includes(r.label));
	const nonTrivial = neg.filter((r) => r.nCorr >= 30);
	const byLabel = Object.fromEntries(
		[...NEG, "POS"].map((l) => [
			l,
			rate(
				rows.filter((r) => r.label === l),
				rejectFn,
			),
		]),
	);
	return {
		posLoss: rate(pos, rejectFn),
		posLossCurAccepted: rate(
			pos.filter((r) => r.e1CUR),
			rejectFn,
		),
		negAll: rate(neg, rejectFn),
		negNonTrivial: rate(nonTrivial, rejectFn),
		neDec: rate(
			rows.filter((r) => r.label === "NE-dec"),
			rejectFn,
		),
		neDecAC1: rate(
			rows.filter((r) => r.label === "NE-dec" && r.e1AC1),
			rejectFn,
		),
		neDecAC2: rate(
			rows.filter((r) => r.label === "NE-dec" && r.e1AC2),
			rejectFn,
		),
		byLabel,
	};
}

async function main() {
	let files = fs
		.readdirSync(DECOYS)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.replace(/\.json$/, ""))
		.sort();
	if (onlyIds.length) files = files.filter((f) => onlyIds.includes(f));
	const rows: Row[] = summaryOnly
		? (
				JSON.parse(
					fs.readFileSync(path.join(OUT, "hyps.json"), "utf8"),
				) as Row[]
			).map((r) => ({
				...r,
				plYawDeg: r.plYawDeg ?? Number.POSITIVE_INFINITY,
				plPitchDeg: r.plPitchDeg ?? Number.POSITIVE_INFINITY,
			}))
		: [];
	if (summaryOnly) files = [];
	for (const pid of files) {
		assertWildDev(pid);
		const d = JSON.parse(
			fs.readFileSync(path.join(DECOYS, `${pid}.json`), "utf8"),
		) as DecoyFile;
		if (d.format !== "geocam-decoys/1")
			throw new Error(`${pid}: format ${d.format}`);
		const height = await heightFor(d.stated.lat, d.stated.lon);
		const t0 = Date.now();
		for (const h of d.hyps) {
			if (h.secondary || h.label === "UNL" || h.label === "AMB") continue;
			rows.push(await evalHyp(pid, d, h, height));
		}
		const mine = rows.filter((r) => r.pid === pid);
		const pos = mine.filter((r) => r.label === "POS");
		const ne = mine.filter((r) => r.label === "NE-dec");
		console.log(
			`${pid}: ${mine.length} hyps ${((Date.now() - t0) / 1000).toFixed(0)} s | POS rejected ${pos.filter((r) => r.reject).length}/${pos.length} [${pos.map((r) => `${r.plYawDeg.toFixed(2)}/${r.plPitchDeg.toFixed(2)}${r.vsOk ? "" : " VS"}`).join(" ")}] | NE-dec rejected ${ne.filter((r) => r.reject).length}/${ne.length} [${ne.map((r) => `${r.plYawDeg.toFixed(2)}/${r.plPitchDeg.toFixed(2)}${r.vsOk ? "" : " VS"}`).join(" ")}]`,
		);
		writeJson(path.join(OUT, "hyps.json"), rows);
	}
	if (!summaryOnly) writeJson(path.join(OUT, "hyps.json"), rows);

	const primary = summarise(rows, (r) => r.reject);
	const integrityOnly = summarise(rows, (r) => !r.integrityPass);
	const viewshedOnly = summarise(rows, (r) => !r.vsOk);
	const eyeFree = noEyeFree
		? null
		: {
				pl: summarise(rows, (r) => !(r.eyeFree?.pass ?? false) || !r.vsOk),
				bubble: summarise(rows, (r) =>
					r.eyeFree ? r.eyeFree.outsideBubble : true,
				),
			};
	// oracle sweep (label-tuned; upper bound)
	const sweep: {
		a: number;
		posLoss: number;
		posLossCur: number;
		negAll: number;
		negNonTrivial: number;
		neDec: number;
		neDecAC1: string;
		neDecAC2: string;
	}[] = [];
	for (let a = 0.25; a <= 64; a *= 2) {
		const rj = (r: Row) =>
			!r.available ||
			!(r.plYawDeg < a * ALERT.yaw && r.plPitchDeg < a * ALERT.pitch) ||
			!r.vsOk;
		const s = summarise(rows, rj);
		sweep.push({
			a,
			posLoss: s.posLoss.rate,
			posLossCur: s.posLossCurAccepted.rate,
			negAll: s.negAll.rate,
			negNonTrivial: s.negNonTrivial.rate,
			neDec: s.neDec.rate,
			neDecAC1: `${s.neDecAC1.k}/${s.neDecAC1.n}`,
			neDecAC2: `${s.neDecAC2.k}/${s.neDecAC2.n}`,
		});
	}
	const okSweep = sweep.filter((s) => s.posLoss * 100 <= 2);
	const best =
		okSweep.sort((x, y) => y.negNonTrivial - x.negNonTrivial)[0] ?? null;
	// POST HOC (not in the protocol): the same oracle with the loss counted over the POS that E1's CUR rule
	// accepts (GA5 as an extra veto on top of the current gate)
	const bestCur =
		sweep
			.filter((s) => s.posLossCur * 100 <= 2)
			.sort((x, y) => y.negNonTrivial - x.negNonTrivial)[0] ?? null;
	const lossPts = primary.posLoss.rate * 100;
	const verdictPass =
		lossPts <= 2 &&
		primary.negAll.rate >= 0.3 &&
		primary.negNonTrivial.rate >= 0.3;
	const summary = {
		protocol: "tools/research/geo/PROTOCOL.txt SECTION GA5",
		alert: ALERT,
		nHyps: rows.length,
		primary,
		integrityOnly,
		viewshedOnly,
		eyeFree,
		oracleSweep: sweep,
		oracleBestAtLossLe2: best,
		postHocOracleBestAtCurLossLe2: bestCur,
		verdict: verdictPass ? "PASS" : "KILLED",
		verdictWhy: `POS loss ${lossPts.toFixed(1)} pts; reject all-neg ${(100 * primary.negAll.rate).toFixed(1)}%, non-trivial ${(100 * primary.negNonTrivial.rate).toFixed(1)}%, NE-dec ${(100 * primary.neDec.rate).toFixed(1)}%`,
		posRejected: rows
			.filter((r) => r.label === "POS" && r.reject)
			.map((r) => ({
				id: r.id,
				plYaw: r.plYawDeg,
				plPitch: r.plPitchDeg,
				vs: r.vsReasons,
				why: r.integrityReasons,
			})),
		neDecAC1: rows
			.filter((r) => r.label === "NE-dec" && r.e1AC1)
			.map((r) => ({
				id: r.id,
				reject: r.reject,
				plYaw: r.plYawDeg,
				plPitch: r.plPitchDeg,
				vs: r.vsReasons,
				e1AC2: r.e1AC2,
			})),
	};
	writeJson(path.join(OUT, "summary.json"), summary);
	console.log(JSON.stringify({ ...summary, oracleSweep: undefined }, null, 1));
	console.log(JSON.stringify(sweep));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
