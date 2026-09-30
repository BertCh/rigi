/**
 * GA3 render-only test (Agent D): is the T-junction residual surface convex with its minimum within 10 m
 * of the true eye, when the "photo" is the DEM itself?
 *
 * Synthetic photo edges = both-sided range-jump + sky boundary of a CPU ray cast (buildGeomBuffer,
 * long side 1600) at the reference camera and eye; predictions = layered horizon marches at candidate
 * eyes on a ±200 m grid at 10 m (U = DEM + reference height above ground). Scorer: ga3-common.ts.
 * Pass rule (tools/research/geo/PROTOCOL.txt, GA3): per eligible photo (≥ 3 predicted junctions with
 * near 200–3000 m at the true eye) argmin ≤ 10 m from truth AND ≥ 80% of 16 rays from the argmin are
 * non-decreasing (tolerance 2% of the surface range) out to 100 m; GA3-synth passes if ≥ 2/3 of eligible
 * photos pass.
 *
 *   npx tsx scripts/geocam/ga3-synth.ts [--photos IMG_5495,wc_0004] [--grid 200] [--step 10]
 *   npx tsx scripts/geocam/ga3-synth.ts --report
 */
import fs from "node:fs";
import path from "node:path";
import { buildGeomBuffer } from "../../src/lib/concord/cues";
import { boundaryMask, edgesFromMask } from "../../src/lib/geocam/tjunc";
import { loadGa3Photo, makeScorer, SCORER, writeJsonFile } from "./ga3-common";
import { GEO_OUT, GT_DEV } from "./lib";

const OUT = path.join(GEO_OUT, "ga3", "synth");
const args = process.argv.slice(2);
const arg = (k: string) => {
	const i = args.indexOf(`--${k}`);
	return i >= 0 ? args[i + 1] : undefined;
};

type Surface = {
	id: string;
	eligible: boolean;
	nRefJunctions: number;
	refJunctions: {
		nearD: number;
		farD: number;
		angleDeg: number;
		pxPer10m: number;
	}[];
	grid: number;
	step: number;
	E: number[];
	N: number[];
	cost: number[];
	costOraclePair: number[];
	costOracleDiff: number[];
	nJ: number[];
	msPerEye: number;
};

async function run(ids: string[], grid: number, step: number) {
	for (const id of ids) {
		const file = path.join(OUT, `${id}.json`);
		if (fs.existsSync(file) && !args.includes("--force")) {
			console.log(`${id}: cached`);
			continue;
		}
		const ph = await loadGa3Photo(id);
		if (!ph) {
			console.log(`${id}: no reference`);
			continue;
		}
		const cam = ph.cam;
		const W = cam.aspect >= 1 ? 1600 : Math.round(1600 * cam.aspect);
		const H = cam.aspect >= 1 ? Math.round(1600 / cam.aspect) : 1600;
		const t0 = Date.now();
		const g = buildGeomBuffer(cam, W, H, ph.raster.h, {
			azStepDeg: 0.01,
			minD: SCORER.minD,
		});
		const edges = edgesFromMask(boundaryMask(g.range, g.sky, W, H), W, H);
		const sc = makeScorer(ph, edges);
		const eligible = sc.refJunctions.length >= SCORER.minJunctions;
		console.log(
			`${id}: raster ${ph.raster.ms} ms, cast ${Date.now() - t0} ms, ${sc.refJunctions.length} ref junctions${eligible ? "" : " (ineligible)"}`,
		);
		const s: Surface = {
			id,
			eligible,
			nRefJunctions: sc.refJunctions.length,
			refJunctions: sc.refJunctions.map((j) => ({
				nearD: Math.round(j.nearD),
				farD: Math.round(j.farD),
				angleDeg: +j.angleDeg.toFixed(1),
				pxPer10m: +j.pxPer10m.toFixed(2),
			})),
			grid,
			step,
			E: [],
			N: [],
			cost: [],
			costOraclePair: [],
			costOracleDiff: [],
			nJ: [],
			msPerEye: 0,
		};
		if (eligible) {
			const t1 = Date.now();
			for (let N = -grid; N <= grid; N += step)
				for (let E = -grid; E <= grid; E += step) {
					const r = sc.score(E, N);
					s.E.push(E);
					s.N.push(N);
					s.cost.push(+r.cost.toFixed(3));
					s.costOraclePair.push(+r.costOraclePair.toFixed(3));
					s.costOracleDiff.push(+r.costOracleDiff.toFixed(3));
					s.nJ.push(r.nJ);
				}
			s.msPerEye = (Date.now() - t1) / s.E.length;
			const t = s.cost[s.E.findIndex((e, k) => e === 0 && s.N[k] === 0)];
			console.log(
				`${id}: ${s.E.length} eyes, ${s.msPerEye.toFixed(0)} ms/eye, cost(truth)=${t}`,
			);
		}
		writeJsonFile(file, s);
	}
}

/** Surface analysis for one cost array. */
export function analyse(s: Surface, cost: number[]) {
	const k0 = cost.reduce((b, c, k) => (c < cost[b] ? k : b), 0);
	const aE = s.E[k0];
	const aN = s.N[k0];
	const argminErr = Math.hypot(aE, aN);
	const lo = Math.min(...cost);
	const hi = Math.max(...cost);
	const tol = 0.02 * (hi - lo);
	const at = (E: number, N: number) => {
		const k = s.E.findIndex(
			(e, i) => Math.abs(e - E) < 1e-6 && Math.abs(s.N[i] - N) < 1e-6,
		);
		return k >= 0 ? cost[k] : Number.NaN;
	};
	let mono = 0;
	let rays = 0;
	for (let a = 0; a < 16; a++) {
		const th = (a * Math.PI) / 8;
		let prev = cost[k0];
		let ok = true;
		let n = 0;
		for (let r = s.step; r <= 100 + 1e-6; r += s.step) {
			// nearest grid node along the ray
			const E = aE + Math.round((r * Math.sin(th)) / s.step) * s.step;
			const N = aN + Math.round((r * Math.cos(th)) / s.step) * s.step;
			const c = at(E, N);
			if (!Number.isFinite(c)) continue;
			n++;
			if (c < prev - tol) ok = false;
			prev = Math.max(prev, c);
		}
		if (n) {
			rays++;
			if (ok) mono++;
		}
	}
	const truth = at(0, 0);
	return {
		argminE: aE,
		argminN: aN,
		argminErr,
		monoFrac: rays ? mono / rays : 0,
		costTruth: truth,
		costMin: lo,
		costMax: hi,
		pass: argminErr <= 10 && rays > 0 && mono / rays >= 0.8,
	};
}

function report() {
	const files = fs.existsSync(OUT)
		? fs
				.readdirSync(OUT)
				.filter((f) => f.endsWith(".json") && !f.startsWith("_"))
		: [];
	const rows: Record<string, unknown>[] = [];
	for (const f of files) {
		const s: Surface = JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8"));
		if (!s.eligible) {
			rows.push({ id: s.id, eligible: false, nRefJunctions: s.nRefJunctions });
			continue;
		}
		rows.push({
			id: s.id,
			eligible: true,
			nRefJunctions: s.nRefJunctions,
			medPxPer10m: median(s.refJunctions.map((j) => j.pxPer10m)),
			primary: analyse(s, s.cost),
			oraclePair: analyse(s, s.costOraclePair),
			oracleDiff: analyse(s, s.costOracleDiff),
			msPerEye: Math.round(s.msPerEye),
		});
	}
	const el = rows.filter((r) => r.eligible) as {
		id: string;
		primary: { pass: boolean; argminErr: number; monoFrac: number };
		oraclePair: { pass: boolean; argminErr: number; monoFrac: number };
		oracleDiff: { pass: boolean; argminErr: number; monoFrac: number };
	}[];
	const frac = (k: "primary" | "oraclePair" | "oracleDiff") =>
		el.length ? el.filter((r) => r[k].pass).length / el.length : 0;
	const summary = {
		photos: rows.length,
		eligible: el.length,
		passPrimary: el.filter((r) => r.primary.pass).length,
		passFracPrimary: frac("primary"),
		passFracOraclePair: frac("oraclePair"),
		passFracOracleDiff: frac("oracleDiff"),
		medArgminErrPrimary: median(el.map((r) => r.primary.argminErr)),
		verdict: el.length && frac("primary") >= 2 / 3 ? "PASS" : "FAIL",
	};
	writeJsonFile(path.join(GEO_OUT, "ga3", "synth-summary.json"), {
		summary,
		rows,
	});
	console.log(JSON.stringify(summary, null, 1));
	for (const r of el)
		console.log(
			`${r.id.padEnd(9)} primary err ${r.primary.argminErr.toFixed(1)} m mono ${r.primary.monoFrac.toFixed(2)} ${r.primary.pass ? "PASS" : "fail"} | oracle pair ${r.oraclePair.argminErr.toFixed(1)} m ${r.oraclePair.monoFrac.toFixed(2)} | oracle diff ${r.oracleDiff.argminErr.toFixed(1)} m ${r.oracleDiff.monoFrac.toFixed(2)}`,
		);
}

function median(a: number[]) {
	const s = [...a].sort((x, y) => x - y);
	const m = s.length >> 1;
	return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : Number.NaN;
}

if (args.includes("--report")) report();
else {
	const ids = arg("photos")?.split(",") ?? [...GT_DEV];
	await run(ids, Number(arg("grid") ?? 200), Number(arg("step") ?? 10));
}
