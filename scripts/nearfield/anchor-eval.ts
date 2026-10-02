// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Offline gate for DEM anchoring: runs the REAL src/lib/nearfield/anchor.ts fitAnchor on the DEV photos' dumped inputs
// (tools/nearfield/spike/dump_anchor_inputs.py) and reports the PLACEMENT.txt terrain residual, so an anchoring change
// is measured without a browser. Nothing here touches sealed data: the dumps are DEV ids only.
//
//   <venv python> tools/nearfield/spike/dump_anchor_inputs.py            # once; needs the gitignored TM render cache
//   npx tsx scripts/nearfield/anchor-eval.ts [--variant app|scale|affine|noOctave|cliff|edge15|octFloor1|…] [--stride N] [--dir DIR] [--json out.json]
//
// --stride 1 fits on every grid cell like place.py (the app thins to <= ~40k candidates: stride 3 on a 512x384 grid).
// Metric (tools/nearfield/spike/PLACEMENT.txt): median |log(anchoredRange(fit, modelRay) / DEM)| over non-Object,
// non-sky cells with DEM 15-500 m (and the 15-50 / 50-150 / 150-500 m bands); the aggregate is the median over photos.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnchorOpts } from "../../src/lib/nearfield/anchor";
import {
	ANCHOR_LOW_TRUST,
	anchoredRange,
	fitAnchor,
} from "../../src/lib/nearfield/anchor";
import {
	fractionBelow,
	medianOfPhotos,
	terrainResiduals,
} from "../../src/lib/nearfield/anchor-metrics";
import { gridDemRange, rayFactor } from "../../src/lib/nearfield/geom";
import {
	ANCHOR_MIN_QUALITY,
	type NearFieldDepth,
} from "../../src/lib/nearfield/types";

const DEFAULT_DIR = "out/anchor-inputs";

/** Named AnchorOpts variants. "app" = what scene.ts passes (defaults + sky mask; the dumper's sky mask is added below). */
export const VARIANTS: Record<string, AnchorOpts> = {
	app: {},
	scale: { mode: "scale" },
	affine: { mode: "affine" },
	noOctave: { curve: { octaveWeights: false } },
	cliff: { cliffLip: true },
	// opt-in knobs from 6ad885d (default off); promote only on a dev-table win (reports/archive/steps-2026-10-02/dem-anchoring.md U3)
	edge13: { edgeGuard: Math.log(1.3) },
	edge15: { edgeGuard: Math.log(1.5) },
	edge20: { edgeGuard: Math.log(2) },
	octFloor1: { curve: { octaveMinShare: 0.01 } },
	octFloor3: { curve: { octaveMinShare: 0.03 } },
	edge15octFloor1: {
		edgeGuard: Math.log(1.5),
		curve: { octaveMinShare: 0.01 },
	},
};

type Dump = {
	id: string;
	width: number;
	height: number;
	K: { fx: number; fy: number; cx: number; cy: number };
	isObj: boolean;
	depth: Float32Array;
	dem: Float32Array;
	valid: Uint8Array;
	sky: Uint8Array;
	object: Uint8Array;
};

/** Layout of <pid>.bin: see dump_anchor_inputs.py (depth f32, dem f32, valid u8, sky u8, object u8). */
function loadDump(dir: string, id: string): Dump {
	const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
	const buf = readFileSync(join(dir, `${id}.bin`));
	const { width, height } = meta;
	const n = width * height;
	if (buf.length !== n * 11)
		throw new Error(`${id}.bin: ${buf.length} bytes, expected ${n * 11}`);
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
	return {
		id,
		width,
		height,
		K: meta.K,
		isObj: !!meta.isObj,
		depth: new Float32Array(ab, 0, n),
		dem: new Float32Array(ab, n * 4, n),
		valid: new Uint8Array(ab, n * 8, n),
		sky: new Uint8Array(ab, n * 9, n),
		object: new Uint8Array(ab, n * 10, n),
	};
}

type Row = {
	id: string;
	isObj: boolean;
	n: number;
	fitted: boolean;
	quality: number;
	inlierFrac: number;
	residualLogAll: number | null;
	resid: number | null;
	bands: (number | null)[];
};

function evaluate(d: Dump, opts: AnchorOpts): Row {
	const { width: W, height: H } = d;
	const depth: NearFieldDepth = {
		width: W,
		height: H,
		depth: d.depth,
		valid: d.valid,
		intrinsicsNorm: undefined,
		model: "moge-2-vitl",
		seconds: 0,
	};
	const demAt = gridDemRange(d.dem, W, H);
	const skyMask = { width: W, height: H, data: d.sky };
	const fit = fitAnchor(depth, demAt, d.K, {
		skyMask,
		peopleMask: null,
		...opts,
	});
	const fitted = Number.isFinite(fit.residualLogAll ?? fit.residualLog);
	const row: Row = {
		id: d.id,
		isObj: d.isObj,
		n: fit.n,
		fitted,
		quality: fit.quality,
		inlierFrac: fit.inlierFrac,
		residualLogAll: fit.residualLogAll ?? null,
		resid: null,
		bands: [null, null, null],
	};
	if (!fitted) return row;
	const placed = new Float32Array(W * H).fill(Number.NaN);
	const excluded = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const z = d.depth[k];
			// excluded: Object (place.py's fixed mask), sky, or no model depth
			if (d.object[k] || d.sky[k] || !d.valid[k] || !(z > 0)) {
				excluded[k] = 1;
				continue;
			}
			const ray = z * rayFactor(d.K, (i + 0.5) / W, (j + 0.5) / H);
			placed[k] = anchoredRange(fit, ray);
		}
	const r = terrainResiduals(placed, d.dem, excluded);
	row.resid = r.all;
	row.bands = r.bands;
	return row;
}

const f3 = (v: number | null | undefined) =>
	v == null || Number.isNaN(v) ? "  -  " : v.toFixed(3);

function main() {
	const args = process.argv.slice(2);
	const arg = (name: string, dflt?: string) => {
		const i = args.indexOf(name);
		return i >= 0 ? args[i + 1] : dflt;
	};
	const variant = arg("--variant", "app") as string;
	const dir = arg("--dir", DEFAULT_DIR) as string;
	const jsonOut = arg("--json");
	const stride = arg("--stride");
	const base = VARIANTS[variant];
	const opts = base && stride ? { ...base, stride: Number(stride) } : base;
	if (!opts) {
		console.error(
			`unknown variant "${variant}"; one of ${Object.keys(VARIANTS).join(", ")}`,
		);
		process.exit(2);
	}
	if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".bin"))) {
		console.log(
			`SKIP anchor-eval: no dumps in ${dir} (run tools/nearfield/spike/dump_anchor_inputs.py; needs the gitignored TM render cache)`,
		);
		return;
	}
	const ids = readdirSync(dir)
		.filter((f) => f.endsWith(".bin"))
		.map((f) => f.slice(0, -4))
		.sort();
	const rows: Row[] = [];
	for (const id of ids) rows.push(evaluate(loadDump(dir, id), opts));

	console.log(`variant ${variant}  dir ${dir}`);
	console.log(
		"id       obj      n  quality  inlier  resAll   resid  15-50  50-150 150-500",
	);
	for (const r of rows)
		console.log(
			`${r.id} ${r.isObj ? "OBJ" : "   "} ${String(r.n).padStart(7)}  ${f3(r.quality)}   ${f3(r.inlierFrac)}  ${f3(r.residualLogAll)}  ${f3(r.resid)}  ${r.bands.map(f3).join("  ")}`,
		);
	const fitted = rows.filter((r) => r.fitted);
	const count = (rs: Row[], t: number) =>
		rs.filter((r) => r.quality >= t).length;
	const objs = fitted.filter((r) => r.isObj);
	const agg = {
		variant,
		photos: rows.length,
		fitted: fitted.length,
		residMedian: medianOfPhotos(fitted.map((r) => r.resid)),
		fracBelow01: fractionBelow(
			fitted.map((r) => r.resid),
			0.1,
		),
		bandMedians: [0, 1, 2].map((b) =>
			medianOfPhotos(fitted.map((r) => r.bands[b])),
		),
		residualLogAllMedian: medianOfPhotos(fitted.map((r) => r.residualLogAll)),
		residPhotos: fitted.filter((r) => r.resid != null).length,
		qualityMin: {
			all: count(fitted, ANCHOR_MIN_QUALITY),
			obj: count(objs, ANCHOR_MIN_QUALITY),
			nObj: objs.length,
		},
		qualityLow: {
			all: count(fitted, ANCHOR_LOW_TRUST),
			obj: count(objs, ANCHOR_LOW_TRUST),
		},
	};
	console.log(
		`AGG ${variant}: resid15-500 median ${f3(agg.residMedian)} (${agg.residPhotos} photos)  frac<0.1 ${f3(agg.fracBelow01)}  ` +
			`bands 15-50/50-150/150-500 ${agg.bandMedians.map(f3).join("/")}  residAll median ${f3(agg.residualLogAllMedian)}`,
	);
	console.log(
		`AGG ${variant}: fitted ${agg.fitted}/${agg.photos}  q>=${ANCHOR_MIN_QUALITY}: ${agg.qualityMin.all} (OBJ ${agg.qualityMin.obj}/${agg.qualityMin.nObj})  q>=${ANCHOR_LOW_TRUST}: ${agg.qualityLow.all} (OBJ ${agg.qualityLow.obj})`,
	);
	if (jsonOut)
		writeFileSync(jsonOut, JSON.stringify({ aggregate: agg, rows }, null, 1));
}

main();
