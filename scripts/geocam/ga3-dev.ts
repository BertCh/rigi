/**
 * GA3 on real photos (Agent D): can T-junctions recover a displaced eye?
 *
 * Photos: 10 GT dev + wild dev with a correct C0 ref; scored = eligible (≥ 3 predicted junctions with near
 * 200–3000 m at the reference camera). Real photo edges (photoEdgesFromRGBA, long side 1600). Starts: truth +
 * {25, 50, 100} m × bearings {0, 90, 180, 270}. Search (amendment B): lattice 5 m offset (+1.7, −2.3) m within ±150 m
 * of the start, argmin, then a 5 × 5 refinement at 1 m. Scorer: ga3-common.ts (rule + amendment A in
 * tools/research/geo/PROTOCOL.txt, section GA3).
 *
 *   npx tsx scripts/geocam/ga3-dev.ts --census            eligibility only (geometry, no photo evidence)
 *   npx tsx scripts/geocam/ga3-dev.ts [--photos a,b]      score (eligible photos of the list)
 *   npx tsx scripts/geocam/ga3-dev.ts --report
 */
import fs from "node:fs";
import path from "node:path";
import { loadGa3Photo, makeScorer, SCORER, writeJsonFile } from "./ga3-common";
import { GEO_OUT, GT_DEV, wildDev, wildDevIds } from "./lib";

const OUT = path.join(GEO_OUT, "ga3", "dev");
const args = process.argv.slice(2);
const arg = (k: string) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : undefined;
};

// AMENDMENT GA3-B: 5 m lattice offset (+1.7, −2.3) m, 1 m refinement (was 12.5 m / (+3.7, −5.1) / 2.5 m)
const LAT = { sp: 5, oE: 1.7, oN: -2.3, win: 150, refSp: 1 };
const DISPS = [25, 50, 100];
const BEARINGS = [0, 90, 180, 270];
const NON_TRUE_M = 25;
type CostKey = "cost" | "costOraclePair" | "costOracleDiff";
const KEYS: CostKey[] = ["cost", "costOraclePair", "costOracleDiff"];

function allIds(): string[] {
	const wild = wildDevIds().filter((p) => {
		const w = wildDev(p);
		return !!w && w.meta.correct_refs.length > 0;
	});
	return [...GT_DEV, ...wild];
}

async function census() {
	const rows = [];
	for (const id of allIds()) {
		const ph = await loadGa3Photo(id);
		if (!ph) continue;
		const dummy = {
			w: 8,
			h: 8,
			mag: new Float32Array(64),
			ori: new Float32Array(64),
		};
		const sc = makeScorer(ph, dummy);
		const r = {
			id,
			nJ: sc.refJunctions.length,
			eligible: sc.refJunctions.length >= SCORER.minJunctions,
			hag: +sc.hag.toFixed(2),
			junctions: sc.refJunctions.map((j) => ({
				nearD: Math.round(j.nearD),
				farD: Math.round(j.farD),
				angleDeg: +j.angleDeg.toFixed(1),
				pxPer10m: +j.pxPer10m.toFixed(2),
			})),
		};
		console.log(`${id}: ${r.nJ} junctions${r.eligible ? " ELIGIBLE" : ""}`);
		rows.push(r);
	}
	writeJsonFile(path.join(GEO_OUT, "ga3", "census.json"), rows);
}

async function run(ids: string[]) {
	for (const id of ids) {
		const file = path.join(OUT, `${id}.json`);
		if (fs.existsSync(file) && !args.includes("--force")) {
			console.log(`${id}: cached`);
			continue;
		}
		const ph = await loadGa3Photo(id);
		if (!ph) continue;
		const edges = await ph.edges();
		const sc = makeScorer(ph, edges);
		if (sc.refJunctions.length < SCORER.minJunctions) {
			writeJsonFile(file, { id, eligible: false, nJ: sc.refJunctions.length });
			console.log(`${id}: ineligible`);
			continue;
		}
		const memo = new Map<string, ReturnType<typeof sc.score>>();
		const at = (E: number, N: number) => {
			const k = `${E.toFixed(2)},${N.toFixed(2)}`;
			let r = memo.get(k);
			if (!r) {
				r = sc.score(E, N);
				memo.set(k, r);
			}
			return r;
		};
		const t0 = Date.now();
		const truth = at(0, 0);
		const cases = [];
		for (const d of DISPS)
			for (const b of BEARINGS) {
				const sE = d * Math.sin((b * Math.PI) / 180);
				const sN = d * Math.cos((b * Math.PI) / 180);
				const i0 = Math.ceil((sE - LAT.win - LAT.oE) / LAT.sp);
				const i1 = Math.floor((sE + LAT.win - LAT.oE) / LAT.sp);
				const j0 = Math.ceil((sN - LAT.win - LAT.oN) / LAT.sp);
				const j1 = Math.floor((sN + LAT.win - LAT.oN) / LAT.sp);
				const nodes: [number, number][] = [];
				for (let i = i0; i <= i1; i++)
					for (let j = j0; j <= j1; j++)
						nodes.push([LAT.oE + i * LAT.sp, LAT.oN + j * LAT.sp]);
				const res: Record<string, unknown> = { d, b, sE, sN };
				for (const key of KEYS) {
					const best = (pts: [number, number][]) => {
						let bk: [number, number] = pts[0];
						let bc = Infinity;
						let bd = Infinity;
						for (const p of pts) {
							const c = at(p[0], p[1])[key];
							const dd = Math.hypot(p[0] - sE, p[1] - sN);
							if (c < bc - 1e-9 || (Math.abs(c - bc) <= 1e-9 && dd < bd)) {
								bk = p;
								bc = c;
								bd = dd;
							}
						}
						return { p: bk, c: bc };
					};
					const a = best(nodes);
					const ref: [number, number][] = [];
					for (let u = -2; u <= 2; u++)
						for (let v = -2; v <= 2; v++)
							ref.push([a.p[0] + u * LAT.refSp, a.p[1] + v * LAT.refSp]);
					const f = best(ref);
					const dRec = Math.hypot(f.p[0], f.p[1]);
					res[key] = {
						E: f.p[0],
						N: f.p[1],
						cost: f.c,
						dRec: +dRec.toFixed(2),
						improvement: +(1 - dRec / d).toFixed(4),
						success: dRec <= 0.5 * d,
						nonTrueWin: dRec > NON_TRUE_M,
						nJ: at(f.p[0], f.p[1]).nJ,
						nMatched: at(f.p[0], f.p[1]).nMatched,
					};
				}
				res.costAtStart = at(sE, sN).cost;
				cases.push(res);
				const p = res.cost as { dRec: number; improvement: number };
				console.log(
					`${id} d=${d} b=${b}: rec ${p.dRec.toFixed(1)} m (impr ${p.improvement.toFixed(2)}) [${memo.size} evals]`,
				);
			}
		writeJsonFile(file, {
			id,
			kind: ph.kind,
			eligible: true,
			nJ: sc.refJunctions.length,
			refJunctions: sc.refJunctions.map((j) => ({
				nearD: Math.round(j.nearD),
				farD: Math.round(j.farD),
				angleDeg: +j.angleDeg.toFixed(1),
				pxPer10m: +j.pxPer10m.toFixed(2),
			})),
			truth: {
				cost: truth.cost,
				costOraclePair: truth.costOraclePair,
				costOracleDiff: truth.costOracleDiff,
				nMatched: truth.nMatched,
				nJ: truth.nJ,
				dRotDeg: truth.dRotDeg,
			},
			cases,
			evals: [...memo.values()].map((r) => ({
				E: +r.E.toFixed(2),
				N: +r.N.toFixed(2),
				c: +r.cost.toFixed(3),
				cp: +r.costOraclePair.toFixed(3),
				cd: +r.costOracleDiff.toFixed(3),
				nJ: r.nJ,
				m: r.nMatched,
			})),
			ms: Date.now() - t0,
		});
	}
}

const median = (a: number[]) => {
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : Number.NaN;
};
/** Wilson 95% interval for k/n. */
const wilson = (k: number, n: number): [number, number] => {
	if (!n) return [Number.NaN, Number.NaN];
	const z = 1.96;
	const p = k / n;
	const den = 1 + (z * z) / n;
	const c = (p + (z * z) / (2 * n)) / den;
	const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
	return [+(c - h).toFixed(3), +(c + h).toFixed(3)];
};

function report() {
	const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".json"));
	const photos = files.map((f) =>
		JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")),
	);
	const el = photos.filter((p) => p.eligible);
	type C = {
		dRec: number;
		improvement: number;
		success: boolean;
		nonTrueWin: boolean;
	};
	const summarise = (
		key: CostKey,
		filt: (p: { kind: string }) => boolean = () => true,
	) => {
		const cs: (C & { d: number })[] = el.filter(filt).flatMap((p) =>
			p.cases.map((c: Record<string, unknown>) => ({
				...(c[key] as C),
				d: c.d as number,
			})),
		);
		const n = cs.length;
		const succ = cs.filter((c) => c.success).length;
		const ntw = cs.filter((c) => c.nonTrueWin).length;
		const byD = Object.fromEntries(
			DISPS.map((d) => {
				const s = cs.filter((c) => c.d === d);
				return [
					d,
					{
						n: s.length,
						medImprovement: median(s.map((c) => c.improvement)),
						medDRec: median(s.map((c) => c.dRec)),
						success: s.filter((c) => c.success).length,
					},
				];
			}),
		);
		return {
			n,
			medImprovement: median(cs.map((c) => c.improvement)),
			medDRec: median(cs.map((c) => c.dRec)),
			successRate: n ? succ / n : Number.NaN,
			successCI: wilson(succ, n),
			nonTrueWinRate: n ? ntw / n : Number.NaN,
			nonTrueWinCI: wilson(ntw, n),
			byD,
		};
	};
	const primary = summarise("cost");
	const killed =
		primary.n === 0
			? "UNTESTABLE"
			: primary.medImprovement < 0.2 || primary.nonTrueWinRate > 0.15
				? "KILLED"
				: "PASS";
	const perPhoto = el.map((p) => ({
		id: p.id,
		kind: p.kind,
		nJ: p.nJ,
		medPxPer10m: median(
			p.refJunctions.map((j: { pxPer10m: number }) => j.pxPer10m),
		),
		truthCost: p.truth.cost,
		truthMatched: `${p.truth.nMatched}/${p.truth.nJ}`,
		medImprovement: median(p.cases.map((c: { cost: C }) => c.cost.improvement)),
		medDRec: median(p.cases.map((c: { cost: C }) => c.cost.dRec)),
		success: p.cases.filter((c: { cost: C }) => c.cost.success).length,
		nonTrueWin: p.cases.filter((c: { cost: C }) => c.cost.nonTrueWin).length,
		oraclePairMedImpr: median(
			p.cases.map((c: { costOraclePair: C }) => c.costOraclePair.improvement),
		),
		oracleDiffMedImpr: median(
			p.cases.map((c: { costOracleDiff: C }) => c.costOracleDiff.improvement),
		),
	}));
	const out = {
		photosTotal: photos.length,
		eligible: el.length,
		verdict: killed,
		primary,
		primaryGT: summarise("cost", (p) => p.kind === "gt"),
		primaryWild: summarise("cost", (p) => p.kind === "wild"),
		oraclePair: summarise("costOraclePair"),
		oracleDiff: summarise("costOracleDiff"),
		perPhoto,
	};
	writeJsonFile(path.join(GEO_OUT, "ga3", "dev-summary.json"), out);
	console.log(JSON.stringify({ ...out, perPhoto: undefined }, null, 1));
	for (const r of perPhoto) console.log(JSON.stringify(r));
}

if (args.includes("--census")) await census();
else if (args.includes("--report")) report();
else await run(arg("photos")?.split(",") ?? allIds());
