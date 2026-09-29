/**
 * Evaluates src/lib/sky on public/photos/*.jpg in node (onnxruntime-web, WASM).
 *
 *   npx tsx scripts/sky-eval.ts [IMG_xxxx ...] [--out DIR] [--model-long-side 512] [--threads N]
 *
 * For every photo: model mask + skyline, classical fallback mask + skyline,
 * and detectSkyline (geo/skyline.ts) for comparison. Writes overlays
 * (blue tint = P(sky); yellow = model skyline; cyan = fallback skyline;
 * magenta = detectSkyline; white = DEM skyline at the ground-truth pose) and
 * masks to --out (default: $SKY_EVAL_OUT or .cache/sky-eval), plus report.json/.md.
 *
 * Where data/ground-truth.json has a pose, the DEM skyline is projected at
 * that pose and median |Δrow| (px at 1024 wide) is reported on columns where
 * the DEM skyline is in frame.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as ort from "onnxruntime-web";
import { cameraFromAngles } from "../src/lib/geo/camera";
import { detectSkyline } from "../src/lib/geo/skyline";
import { projectSkylineRows } from "../src/lib/geo/solve";
import {
	classicalSky,
	refineToWorking,
	rgbPlanes,
	toBytes,
} from "../src/lib/sky/core";
import {
	createSkyModel,
	MODEL_FILE,
	MODEL_LONG_SIDE,
	runSkyModel,
} from "../src/lib/sky/model";
import { skylineFromSky, skylineFromSkyDP } from "../src/lib/sky/skyline";
import { IMG_DIR, loadRGBA, ROOT } from "./lib/node-io";
import { photoContext } from "./lib/pipeline-node";

const argv = process.argv.slice(2);
const flag = (k: string) => {
	const i = argv.indexOf(k);
	if (i < 0) return undefined;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};
const OUT = path.resolve(
	flag("--out") ??
		process.env.SKY_EVAL_OUT ??
		path.join(ROOT, ".cache", "sky-eval"),
);
const MODEL_LS = Number(flag("--model-long-side") ?? MODEL_LONG_SIDE.wasm);
const THREADS = Number(flag("--threads") ?? 0);
const MODEL = flag("--model");
const only = argv;
const WORK = 1024;
const DETECT_W = 800;
const PHOTOS = path.join(ROOT, "public", "photos");
const GT_FILE = path.join(ROOT, "data", "ground-truth.json");

interface GT {
	width: number;
	height: number;
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	quality: string;
}

type Rows = { rows: Float32Array; weight: Float32Array };

const median = (v: number[]) => {
	if (!v.length) return Number.NaN;
	const s = [...v].sort((a, b) => a - b);
	return s.length % 2
		? s[s.length >> 1]
		: (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function compare(dem: Float32Array, m: Rows, H: number, cols?: Set<number>) {
	const d: number[] = [];
	const wts: number[] = [];
	let demCols = 0;
	for (let x = 0; x < dem.length; x++) {
		if (!Number.isFinite(dem[x]) || dem[x] < 2 || dem[x] > H - 2) continue;
		if (cols && !cols.has(x)) continue;
		demCols++;
		if (!Number.isFinite(m.rows[x]) || m.weight[x] <= 0.05) continue;
		d.push(m.rows[x] - dem[x]);
		wts.push(m.weight[x]);
	}
	// Signed bias (pose error + DEM smoothing move the whole DEM line) and
	// the spread about it (shape agreement), besides the plain median |Δ|.
	const bias = median(d);
	const shape = median(d.map((v) => Math.abs(v - bias)));
	// Weighted outlier mass: share of the solver's weight on columns more
	// than 10 px off the (bias-corrected) DEM line — posts, chalets, heads.
	let wOut = 0;
	let wAll = 0;
	for (let i = 0; i < d.length; i++) {
		wAll += wts[i];
		if (Math.abs(d[i] - bias) > 10) wOut += wts[i];
	}
	for (let i = 0; i < d.length; i++) d[i] = Math.abs(d[i]);
	return {
		medianPx: +median(d).toFixed(2),
		biasPx: +bias.toFixed(2),
		shapePx: +shape.toFixed(2),
		outlierW: wAll ? +(wOut / wAll).toFixed(3) : 0,
		within3: d.length
			? +(d.filter((v) => v <= 3).length / d.length).toFixed(2)
			: 0,
		within10: d.length
			? +(d.filter((v) => v <= 10).length / d.length).toFixed(2)
			: 0,
		coverage: demCols ? +(d.length / demCols).toFixed(2) : 0,
		n: d.length,
	};
}

type Ctx2D = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;
function drawRows(
	ctx: Ctx2D,
	m: Rows,
	style: string,
	width: number,
	dash: number[] = [],
) {
	ctx.strokeStyle = style;
	ctx.lineWidth = width;
	ctx.setLineDash(dash);
	ctx.beginPath();
	let pen = false;
	for (let x = 0; x < m.rows.length; x++) {
		const y = m.rows[x];
		if (!Number.isFinite(y) || m.weight[x] <= 0.05) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo(x + 0.5, y);
		else ctx.moveTo(x + 0.5, y);
		pen = true;
	}
	ctx.stroke();
	ctx.setLineDash([]);
}

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	if (THREADS) ort.env.wasm.numThreads = THREADS;
	const gtAll: Record<string, GT> = fs.existsSync(GT_FILE)
		? JSON.parse(fs.readFileSync(GT_FILE, "utf8"))
		: {};
	const modelPath = MODEL
		? path.resolve(MODEL)
		: path.join(ROOT, "public", MODEL_FILE);
	if (!MODEL) {
		const sha = createHash("sha256")
			.update(fs.readFileSync(modelPath))
			.digest("hex");
		if (!modelPath.includes(`.${sha.slice(0, 8)}.`))
			throw new Error(
				`${modelPath}: filename hash ≠ content sha256 ${sha.slice(0, 8)}`,
			);
	}
	const tl = performance.now();
	const model = await createSkyModel(
		new Uint8Array(fs.readFileSync(modelPath)),
		["wasm"],
	);
	const loadMs = performance.now() - tl;
	console.log(
		`model ${path.basename(modelPath)} (${(fs.statSync(modelPath).size / 1e6).toFixed(1)} MB) loaded in ${loadMs.toFixed(0)} ms, input long side ${MODEL_LS}, threads ${ort.env.wasm.numThreads ?? "default"}`,
	);

	const names = fs
		.readdirSync(PHOTOS)
		.filter((f) => /\.jpg$/i.test(f))
		.map((f) => path.parse(f).name)
		.filter((n) => !only.length || only.some((o) => n.startsWith(o)))
		.sort();
	const report = [];
	for (const name of names) {
		const file = path.join(PHOTOS, `${name}.jpg`);
		const img = await loadRGBA(file, WORK);
		const W = img.width;
		const H = img.height;
		const rgb = rgbPlanes(img);

		const t0 = performance.now();
		const low = await runSkyModel(model, rgb, W, H, MODEL_LS);
		const t1 = performance.now();
		const pm = refineToWorking(rgb, W, H, low, true);
		const t2 = performance.now();
		const mask = { width: W, height: H, data: toBytes(pm) };
		const sky = skylineFromSky(mask);
		const dp = skylineFromSkyDP(mask, img);
		const dpNoImg = skylineFromSkyDP(mask);
		const t3 = performance.now();
		const unrefined = skylineFromSky({
			width: W,
			height: H,
			data: toBytes(refineToWorking(rgb, W, H, low, false)),
		});

		const t4 = performance.now();
		const fbLow = classicalSky(rgb, W, H);
		const fbMask = {
			width: W,
			height: H,
			data: toBytes(refineToWorking(rgb, W, H, fbLow, true)),
		};
		const fb = skylineFromSky(fbMask);
		const t5 = performance.now();

		const small = await loadRGBA(file, DETECT_W);
		const det = detectSkyline(small, { returnSky: false });
		const s = W / DETECT_W;
		const detRows: Rows = {
			rows: det.rows.map((v) => v * s),
			weight: det.weight,
		};
		// Upsample detectSkyline's per-column output to WORK columns.
		const detW: Rows = {
			rows: new Float32Array(W),
			weight: new Float32Array(W),
		};
		for (let x = 0; x < W; x++) {
			const xs = Math.min(DETECT_W - 1, Math.floor((x + 0.5) / s));
			detW.rows[x] = detRows.rows[xs];
			detW.weight[x] = detRows.weight[xs];
		}

		// Ground truth.
		const g = gtAll[name];
		let dem: Float32Array | undefined;
		const heic = path.join(IMG_DIR, `${name}.HEIC`);
		if (g && g.quality !== "none" && fs.existsSync(heic)) {
			const ctx = await photoContext(name, heic);
			const cam = cameraFromAngles({
				width: g.width,
				height: g.height,
				f: g.f,
				yaw: g.yaw,
				pitch: g.pitch,
				roll: g.roll,
			});
			if (Math.abs(g.width / g.height - W / H) > 0.01)
				console.warn(
					`${name}: GT aspect ${g.width}x${g.height} ≠ photo ${W}x${H}`,
				);
			dem = projectSkylineRows(cam, ctx.horizon, W);
		}
		let metrics: Record<string, unknown> | undefined;
		if (dem) {
			const common = new Set<number>();
			for (let x = 0; x < W; x++)
				if (
					Number.isFinite(sky.rows[x]) &&
					Number.isFinite(detW.rows[x]) &&
					detW.weight[x] > 0.05
				)
					common.add(x);
			metrics = {
				quality: g.quality,
				model: compare(dem, sky, H),
				dp: compare(dem, dp, H),
				dpNoImg: compare(dem, dpNoImg, H),
				modelUnrefined: compare(dem, unrefined, H),
				fallback: compare(dem, fb, H),
				detectSkyline: compare(dem, detW, H),
				commonModel: compare(dem, sky, H, common),
				commonDP: compare(dem, dp, H, common),
				commonDetect: compare(dem, detW, H, common),
			};
		}

		const row = {
			name,
			ms: {
				model: Math.round(t1 - t0),
				refine: Math.round(t2 - t1),
				skyline: Math.round(t3 - t2),
				fallbackTotal: Math.round(t5 - t4),
			},
			coverage: {
				model: +(sky.rows.filter(Number.isFinite).length / W).toFixed(2),
				fallback: +(fb.rows.filter(Number.isFinite).length / W).toFixed(2),
				detectSkyline: +(
					det.rows.filter(Number.isFinite).length / DETECT_W
				).toFixed(2),
			},
			metrics,
		};
		report.push(row);
		console.log(
			`${name}  model ${row.ms.model} ms + refine ${row.ms.refine} ms  fallback ${row.ms.fallbackTotal} ms  cov model ${row.coverage.model} fb ${row.coverage.fallback} det ${row.coverage.detectSkyline}` +
				(metrics
					? `  |Δrow| model ${(metrics.model as { medianPx: number }).medianPx} dp ${(metrics.dp as { medianPx: number }).medianPx} unref ${(metrics.modelUnrefined as { medianPx: number }).medianPx} fb ${(metrics.fallback as { medianPx: number }).medianPx} det ${(metrics.detectSkyline as { medianPx: number }).medianPx}`
					: ""),
		);

		// Overlays.
		const photo = await loadImage(file);
		const drawOverlay = async (
			m: typeof mask,
			lines: [Rows, string][],
			suffix: string,
		) => {
			const canvas = createCanvas(W, H);
			const c = canvas.getContext("2d");
			c.drawImage(photo, 0, 0, W, H);
			const id = c.getImageData(0, 0, W, H);
			for (let i = 0; i < W * H; i++) {
				const a = (m.data[i] / 255) * 0.45;
				id.data[4 * i] = id.data[4 * i] * (1 - a) + 30 * a;
				id.data[4 * i + 1] = id.data[4 * i + 1] * (1 - a) + 90 * a;
				id.data[4 * i + 2] = id.data[4 * i + 2] * (1 - a) + 255 * a;
			}
			c.putImageData(id, 0, 0);
			if (dem)
				drawRows(
					c,
					{ rows: dem, weight: new Float32Array(W).fill(1) },
					"rgba(255,255,255,0.9)",
					2,
					[6, 4],
				);
			for (const [r, col] of lines) drawRows(c, r, col, 1.5);
			c.font = "bold 16px sans-serif";
			c.fillStyle = "rgba(0,0,0,0.6)";
			c.fillRect(0, 0, W, 24);
			c.fillStyle = "white";
			c.fillText(
				`${name} ${suffix}` +
					(metrics
						? `  |Δrow| model ${(metrics.model as { medianPx: number }).medianPx}px  detect ${(metrics.detectSkyline as { medianPx: number }).medianPx}px  fallback ${(metrics.fallback as { medianPx: number }).medianPx}px`
						: ""),
				8,
				17,
			);
			fs.writeFileSync(
				path.join(OUT, `${name}${suffix ? `_${suffix}` : ""}.jpg`),
				await canvas.encode("jpeg", 88),
			);
		};
		await drawOverlay(
			mask,
			[
				[detW, "rgba(255,0,200,0.9)"],
				[sky, "rgba(255,230,0,1)"],
			],
			"",
		);
		await drawOverlay(fbMask, [[fb, "rgba(0,230,255,1)"]], "fallback");
		const mc = createCanvas(W, H);
		const mctx = mc.getContext("2d");
		const mid = mctx.createImageData(W, H);
		for (let i = 0; i < W * H; i++) {
			mid.data[4 * i] =
				mid.data[4 * i + 1] =
				mid.data[4 * i + 2] =
					mask.data[i];
			mid.data[4 * i + 3] = 255;
		}
		mctx.putImageData(mid, 0, 0);
		fs.writeFileSync(
			path.join(OUT, `${name}_mask.png`),
			await mc.encode("png"),
		);
	}

	fs.writeFileSync(
		path.join(OUT, "report.json"),
		JSON.stringify(report, null, 1),
	);
	const withGt = report.filter((r) => r.metrics);
	const md = [
		`Model load ${loadMs.toFixed(0)} ms; median model inference ${median(report.map((r) => r.ms.model))} ms, refine ${median(report.map((r) => r.ms.refine))} ms, fallback ${median(report.map((r) => r.ms.fallbackTotal))} ms (node, onnxruntime-web WASM).`,
		"",
		"Cells: median |Δrow| / median |Δrow − bias| (px @1024), weighted outlier mass (share of weight on columns > 10 px from the bias-corrected DEM line), coverage of in-frame DEM columns.",
		"",
		"| photo | GT | model | DP (+img) | DP (mask only) | model (unrefined) | fallback | detectSkyline | model (common cols) | DP (common) | detect (common cols) |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...withGt.map((r) => {
			const m = r.metrics as Record<
				string,
				{
					medianPx: number;
					shapePx: number;
					outlierW: number;
					coverage: number;
				}
			>;
			const f = (k: string) =>
				`${m[k].medianPx} / ${m[k].shapePx} px, out ${m[k].outlierW} (cov ${m[k].coverage})`;
			return `| ${r.name} | ${m.quality} | ${f("model")} | ${f("dp")} | ${f("dpNoImg")} | ${f("modelUnrefined")} | ${f("fallback")} | ${f("detectSkyline")} | ${f("commonModel")} | ${f("commonDP")} | ${f("commonDetect")} |`;
		}),
	];
	if (withGt.length) {
		const good = withGt.filter(
			(r) => (r.metrics as { quality: string }).quality === "good",
		);
		const agg = (
			set: typeof withGt,
			k: string,
			f: "medianPx" | "shapePx" | "outlierW",
		) =>
			median(
				set.map(
					(r) => (r.metrics as Record<string, Record<string, number>>)[k][f],
				),
			).toFixed(2);
		const all = (set: typeof withGt, f: "medianPx" | "shapePx" | "outlierW") =>
			`model ${agg(set, "model", f)}, DP+img ${agg(set, "dp", f)}, DP mask-only ${agg(set, "dpNoImg", f)}, unrefined ${agg(set, "modelUnrefined", f)}, fallback ${agg(set, "fallback", f)}, detectSkyline ${agg(set, "detectSkyline", f)}; common columns model ${agg(set, "commonModel", f)}, DP ${agg(set, "commonDP", f)} vs detect ${agg(set, "commonDetect", f)}`;
		for (const [label, set] of [
			["all", withGt],
			["quality=good", good],
		] as const) {
			if (!set.length) continue;
			md.push(
				"",
				`**${label} (${set.length} photos)** — median over photos of per-photo median |Δrow| (px @${WORK}): ${all(set, "medianPx")}.`,
				"",
				`Bias-removed (median |Δrow − median Δrow|): ${all(set, "shapePx")}.`,
				"",
				`Weighted outlier mass (> 10 px): ${all(set, "outlierW")}.`,
			);
		}
	}
	fs.writeFileSync(path.join(OUT, "report.md"), `${md.join("\n")}\n`);
	console.log(`\n${md.join("\n")}\nwrote ${OUT}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
