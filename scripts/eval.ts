// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * End-to-end evaluation of the automatic baseline:
 *   prior (EXIF + gravity) → detectSkyline → solvePose
 * compared against hand-verified poses in data/ground-truth.json.
 *
 *   npx tsx scripts/eval.ts [IMG_xxxx ...]
 *
 * Writes out/eval/<name>.jpg (white = ground truth, magenta dashed = prior,
 * cyan = solved, yellow = detected photo skyline), out/eval/report.json and
 * out/eval/report.md.
 *
 * A/B variants (report only, no overlays, in out/eval-classic-<solver>[-fasth][-<dem>]/):
 *   HORIZON=classic|fast  computeHorizon (default) or d1's src/lib/horizon-fast
 *   DEM=terrarium|mapterhorn  elevation source (see terrain.ts DEM_SOURCES)
 *   SOLVER=solve|cascade|skyfirst
 *     solve     solvePose (default)
 *     cascade   solvePose → refinePose (src/lib/refine) on reject
 *     skyfirst  refinePose(crossCheck: ONNX sky-model skyline) if it accepts,
 *               else cascade
 * The photo skyline is always detectSkyline (the ONNX sky model is only the
 * skyfirst cross-check).
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
	type Camera,
	cameraFromAngles,
	resizeCamera,
} from "../src/lib/geo/camera";
import type { HorizonProfile } from "../src/lib/geo/horizon";
import { detectSkyline } from "../src/lib/geo/skyline";
import {
	projectSkylineRows,
	type SkylineRows,
	type SkylineSolveResult,
	solvePose,
} from "../src/lib/geo/solve";
import { heicToJpeg, listPhotos, loadRGBA, ROOT } from "./lib/node-io";
import { photoContext } from "./lib/pipeline-node";

const SOLVER = process.env.SOLVER ?? "solve";
const HORIZON = process.env.HORIZON ?? "classic";
const DEM_NAME = process.env.DEM ?? "terrarium";
const VARIANT =
	SOLVER !== "solve" || HORIZON !== "classic" || DEM_NAME !== "terrarium";
/** Solvers that also need the ONNX sky-model skyline as a cross-check. */
const NEEDS_CROSS = SOLVER === "skyfirst";
const OUT = path.join(
	ROOT,
	"out",
	VARIANT
		? `eval-classic-${SOLVER}${HORIZON === "classic" ? "" : `-${HORIZON}h`}${DEM_NAME === "terrarium" ? "" : `-${DEM_NAME}`}`
		: "eval",
);

type Detect = (img: {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}) => Promise<SkylineRows>;

/** ONNX sky-model skyline (argmax), the skyfirst cross-check. */
async function makeModelDetector(): Promise<Detect> {
	const { createSkyModel, MODEL_FILE, MODEL_LONG_SIDE, runSkyModel } =
		await import("../src/lib/sky/model");
	const { refineToWorking, rgbPlanes, toBytes } = await import(
		"../src/lib/sky/core"
	);
	const { skylineFromSky } = await import("../src/lib/sky/skyline");
	const model = await createSkyModel(
		new Uint8Array(fs.readFileSync(path.join(ROOT, "public", MODEL_FILE))),
		["wasm"],
	);
	return async (img) => {
		const rgb = rgbPlanes(img);
		const low = await runSkyModel(
			model,
			rgb,
			img.width,
			img.height,
			MODEL_LONG_SIDE.wasm,
		);
		const pm = refineToWorking(rgb, img.width, img.height, low, true);
		const mask = { width: img.width, height: img.height, data: toBytes(pm) };
		return skylineFromSky(mask);
	};
}

type Solve = (
	prior: Camera,
	horizon: HorizonProfile,
	sky: SkylineRows,
	gpsError?: number,
	cross?: SkylineRows,
) => SkylineSolveResult;

/** Pose solver for the chosen SOLVER variant, adapted to SolveResult. */
async function makeSolver(): Promise<Solve> {
	if (SOLVER === "solve") return (p, h, s) => solvePose(p, h, s);
	const { refinePose } = await import("../src/lib/refine/index");
	const refine: Solve = (prior, horizon, skyline, gpsError, cross) => {
		const r = refinePose({
			camera: prior,
			horizon,
			skyline,
			crossCheck: cross,
			gpsAccuracy: gpsError,
		});
		return {
			camera: r.camera,
			confidence: r.confidence.score,
			accepted: r.confidence.accept,
			rejectReason: r.confidence.accept ? undefined : "low-confidence",
			residualPx: Number.NaN,
			inlierFraction: r.modes[0]?.inlierFraction ?? Number.NaN,
			coverage: Number.NaN,
			ambiguity: Number.NaN,
			horizonRelief: Number.NaN,
			delta: {
				yaw: angleDiff(r.camera.yaw, prior.yaw),
				pitch: r.camera.pitch - prior.pitch,
				roll: r.camera.roll - prior.roll,
				focal: r.camera.f / prior.f,
			},
			coarse: { yaw: 0, pitch: 0 },
			search: "local",
		};
	};
	/**
	 * Chains results: the first accepted one wins. If none accepts, return
	 * the FIRST result (solvePose's candidate is usually the better seed;
	 * refine's rejected pose can be 130–175° off with no heading), with
	 * every candidate attached. Same rule as the /baseline worker.
	 */
	const chain = (
		results: [string, SkylineSolveResult][],
	): SkylineSolveResult => {
		const candidates = results.map(([method, r]) => ({
			method,
			camera: r.camera,
			confidence: r.confidence,
			accepted: r.accepted,
		}));
		const winner = results.find(([, r]) => r.accepted)?.[1] ?? results[0][1];
		return { ...winner, candidates };
	};
	// Cascade: cheap solvePose first; escalate rejects to refinePose.
	const cascade: Solve = (prior, horizon, skyline, gpsError) => {
		const first = solvePose(prior, horizon, skyline);
		if (first.accepted) return first;
		return chain([
			["solve", first],
			["refine", refine(prior, horizon, skyline, gpsError)],
		]);
	};
	if (SOLVER === "cascade") return cascade;
	if (SOLVER === "skyfirst")
		return (prior, horizon, skyline, gpsError, cross) => {
			const sky = refine(prior, horizon, skyline, gpsError, cross);
			return sky.accepted ? sky : cascade(prior, horizon, skyline, gpsError);
		};
	throw new Error(`Unknown SOLVER=${SOLVER}`);
}
const GT_FILE = path.join(ROOT, "data", "ground-truth.json");
const WORK_WIDTH = 800;
const VIEW_WIDTH = 1600;

interface GroundTruth {
	width: number;
	height: number;
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	quality: "good" | "approx" | "none";
	notes?: string;
}

const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/** Mean |row difference| (px at `width`) between two cameras' DEM skylines. */
function skylineDistance(
	a: Camera,
	b: Camera,
	h: HorizonProfile,
	width: number,
) {
	const ra = projectSkylineRows(a, h, width);
	const rb = projectSkylineRows(b, h, width);
	const height = (a.height * width) / a.width;
	let s = 0;
	let n = 0;
	for (let x = 0; x < width; x++) {
		if (!Number.isFinite(ra[x]) || !Number.isFinite(rb[x])) continue;
		if (rb[x] < 0 || rb[x] > height) continue;
		s += Math.abs(ra[x] - rb[x]);
		n++;
	}
	return n > 0 ? s / n : Number.NaN;
}

function drawRows(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	rows: Float32Array,
	scale: number,
	style: string,
	width: number,
	dash: number[] = [],
) {
	ctx.strokeStyle = style;
	ctx.lineWidth = width;
	ctx.setLineDash(dash);
	ctx.beginPath();
	let pen = false;
	for (let x = 0; x < rows.length; x++) {
		const y = rows[x];
		if (!Number.isFinite(y)) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(x * scale, y * scale);
		else ctx.moveTo(x * scale, y * scale);
		pen = true;
	}
	ctx.stroke();
	ctx.setLineDash([]);
}

async function main() {
	const gtAll: Record<string, GroundTruth> = fs.existsSync(GT_FILE)
		? JSON.parse(fs.readFileSync(GT_FILE, "utf8"))
		: {};
	const solve = await makeSolver();
	fs.mkdirSync(OUT, { recursive: true });
	const detect: Detect = async (img) => detectSkyline(img);
	const detectCross = NEEDS_CROSS ? await makeModelDetector() : undefined;
	console.log(`variant: SOLVER=${SOLVER} → ${OUT}`);
	const rows = [];

	for (const { name, heic } of listPhotos(process.argv.slice(2))) {
		const ctx = await photoContext(name, heic);
		const jpg = heicToJpeg(heic, VIEW_WIDTH);
		const img = await loadRGBA(jpg, WORK_WIDTH);

		const t0 = performance.now();
		const sky = await detect(img);
		const t1 = performance.now();
		const cross = detectCross ? await detectCross(img) : undefined;
		const res = solve(ctx.prior, ctx.horizon, sky, ctx.meta.gpsError, cross);
		const t2 = performance.now();

		const g = gtAll[name];
		const gt =
			g && g.quality !== "none"
				? cameraFromAngles({
						width: g.width,
						height: g.height,
						f: g.f,
						yaw: g.yaw,
						pitch: g.pitch,
						roll: g.roll,
					})
				: undefined;
		const err = (c: Camera) =>
			gt
				? {
						yaw: +angleDiff(c.yaw, gt.yaw).toFixed(2),
						pitch: +(c.pitch - gt.pitch).toFixed(2),
						roll: +(c.roll - gt.roll).toFixed(2),
						f: +(c.f / gt.f - 1).toFixed(3),
						skylinePx: +skylineDistance(c, gt, ctx.horizon, VIEW_WIDTH).toFixed(
							1,
						),
					}
				: undefined;

		const row = {
			name,
			gtQuality: g?.quality ?? "missing",
			confidence: +res.confidence.toFixed(2),
			accepted: res.accepted,
			search: res.search,
			rejectReason: res.rejectReason,
			inlierFraction: +res.inlierFraction.toFixed(2),
			coverage: +res.coverage.toFixed(2),
			ambiguity: +res.ambiguity.toFixed(2),
			relief: +res.horizonRelief.toFixed(2),
			residualPx: +res.residualPx.toFixed(1),
			delta: {
				yaw: +res.delta.yaw.toFixed(2),
				pitch: +res.delta.pitch.toFixed(2),
				roll: +res.delta.roll.toFixed(2),
				focal: +res.delta.focal.toFixed(3),
			},
			priorError: err(ctx.prior),
			solvedError: err(res.camera),
			/** What the pipeline would actually show: solved if accepted, else prior. */
			finalError: err(res.accepted ? res.camera : ctx.prior),
			ms: { skyline: Math.round(t1 - t0), solve: Math.round(t2 - t1) },
		};
		rows.push(row);
		const pe = row.priorError;
		const se = row.solvedError;
		console.log(
			`${name}  conf ${row.confidence} ${res.accepted ? "ACCEPT" : `reject(${res.rejectReason})`}  Δyaw ${row.delta.yaw} Δpitch ${row.delta.pitch}  ` +
				(pe && se
					? `yaw err ${pe.yaw} → ${se.yaw}  pitch ${pe.pitch} → ${se.pitch}  skyline px ${pe.skylinePx} → ${se.skylinePx}`
					: "(no ground truth)") +
				`  [${row.ms.skyline}+${row.ms.solve} ms]`,
		);

		if (VARIANT) continue; // variants: report only, keep disk use small

		// Overlay.
		const photo = await loadImage(jpg);
		const canvas = createCanvas(photo.width, photo.height);
		const c2 = canvas.getContext("2d");
		c2.drawImage(photo, 0, 0);
		const s = photo.width / WORK_WIDTH;
		const skyRows = new Float32Array(sky.rows.length);
		for (let x = 0; x < skyRows.length; x++)
			skyRows[x] = sky.weight[x] > 0.05 ? sky.rows[x] : Number.NaN;
		drawRows(c2, skyRows, s, "rgba(255,230,0,0.9)", 2);
		const at = (c: Camera) => resizeCamera(c, WORK_WIDTH);
		if (gt)
			drawRows(
				c2,
				projectSkylineRows(at(gt), ctx.horizon, WORK_WIDTH),
				s,
				"rgba(255,255,255,0.95)",
				4,
			);
		drawRows(
			c2,
			projectSkylineRows(at(ctx.prior), ctx.horizon, WORK_WIDTH),
			s,
			"rgba(255,40,200,0.9)",
			2,
			[10, 8],
		);
		drawRows(
			c2,
			projectSkylineRows(at(res.camera), ctx.horizon, WORK_WIDTH),
			s,
			"rgba(0,230,255,0.95)",
			2.5,
		);
		c2.font = "bold 22px sans-serif";
		c2.fillStyle = "rgba(0,0,0,0.6)";
		c2.fillRect(0, 0, photo.width, 34);
		c2.fillStyle = "white";
		c2.fillText(
			`${name}  conf ${row.confidence}  Δyaw ${row.delta.yaw}° Δpitch ${row.delta.pitch}°` +
				(se ? `  err yaw ${se.yaw}° sky ${se.skylinePx}px` : ""),
			10,
			24,
		);
		fs.writeFileSync(
			path.join(OUT, `${name}.jpg`),
			await canvas.encode("jpeg", 85),
		);
	}

	fs.writeFileSync(
		path.join(OUT, "report.json"),
		JSON.stringify(rows, null, 1),
	);
	const md = [
		"| photo | GT | conf | accepted | Δyaw | prior yaw err | solved yaw err | prior pitch err | solved pitch err | prior sky px | solved sky px | final sky px |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|",
		...rows.map(
			(r) =>
				`| ${r.name} | ${r.gtQuality} | ${r.confidence} | ${r.accepted ? "yes" : (r.rejectReason ?? "no")} | ${r.delta.yaw} | ${r.priorError?.yaw ?? "–"} | ${r.solvedError?.yaw ?? "–"} | ${r.priorError?.pitch ?? "–"} | ${r.solvedError?.pitch ?? "–"} | ${r.priorError?.skylinePx ?? "–"} | ${r.solvedError?.skylinePx ?? "–"} | ${r.finalError?.skylinePx ?? "–"} |`,
		),
	];
	const withGt = rows.filter((r) => r.solvedError);
	if (withGt.length) {
		const med = (v: number[]) => {
			const s = [...v].sort((a, b) => a - b);
			return s[Math.floor(s.length / 2)];
		};
		const summary = (k: "priorError" | "solvedError" | "finalError") => {
			const e = withGt.map((r) => r[k] as NonNullable<typeof r.solvedError>);
			return `median |yaw| ${med(e.map((x) => Math.abs(x.yaw)))}°, median |pitch| ${med(e.map((x) => Math.abs(x.pitch)))}°, median skyline ${med(e.map((x) => x.skylinePx))} px, ≤10 px: ${e.filter((x) => x.skylinePx <= 10).length}/${e.length}`;
		};
		md.push(
			"",
			`Prior: ${summary("priorError")}`,
			"",
			`Solved (always): ${summary("solvedError")}`,
			"",
			`Final (solved if accepted, else prior): ${summary("finalError")}; accepted ${withGt.filter((r) => r.accepted).length}/${withGt.length}`,
		);
	}
	fs.writeFileSync(path.join(OUT, "report.md"), `${md.join("\n")}\n`);
	console.log(`\n${md.slice(-5).join("\n")}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
