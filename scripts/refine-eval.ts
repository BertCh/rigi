// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Evaluates the alternative refinement (src/lib/refine) against the baseline
 * solver (src/lib/geo/solve.ts) on the photos in data/ground-truth.json.
 *
 *   npx tsx scripts/refine-eval.ts [IMG_xxxx ...] [--no-sky] [--no-robust]
 *
 * Per photo: prior (EXIF + gravity) → detectSkyline (baseline, 800 wide) →
 *   (a) solvePose (baseline)
 *   (b) refinePose (this module)
 *   (c) refinePose on the sky-model skyline (src/lib/sky, U²-Net in node via
 *       onnxruntime-web WASM, 1024 wide), when the model loads
 * Errors are vs data/ground-truth.json; skyline px error is the mean |Δrow|
 * of the DEM skyline at 1600 wide (as scripts/eval.ts). Robustness: the prior
 * yaw is perturbed by ±5/±10/±15° and a run counts as converged when its yaw
 * error is < 0.5°.
 *
 * Writes (scratch) $REFINE_OUT or /private/tmp/.../scratchpad/refine:
 * report.md, report.json, overlays <name>.jpg (white = GT, cyan = (a),
 * green = (b), orange = (c), yellow = detected skyline); and
 * out/refine/results.json (one row per photo for the leaderboard).
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { vfovFromFocal } from "../src/lib/camera";
import {
	type Camera,
	cameraFromAngles,
	perturbCamera,
	resizeCamera,
} from "../src/lib/geo/camera";
import type { HorizonProfile } from "../src/lib/geo/horizon";
import { detectSkyline, type SkylineObservation } from "../src/lib/geo/skyline";
import {
	projectSkylineRows,
	type SkylineRows,
	solvePose,
} from "../src/lib/geo/solve";
import { type RefineResult, refinePose } from "../src/lib/refine/index";
import { fuseSkylines, rejectSpikes } from "../src/lib/refine/skyline-clean";
import { heicToJpeg, listPhotos, loadRGBA, ROOT } from "./lib/node-io";
import { photoContext } from "./lib/pipeline-node";

const argv = process.argv.slice(2);
const has = (k: string) => {
	const i = argv.indexOf(k);
	if (i >= 0) argv.splice(i, 1);
	return i >= 0;
};
const NO_SKY = has("--no-sky");
const NO_ROBUST = has("--no-robust");
const SCRATCH =
	process.env.REFINE_OUT ??
	"/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/a1611531-32b0-4db2-a884-e5bbc3808e2d/scratchpad/refine";
const OUT_RESULTS = path.join(ROOT, "out", "refine");
const GT_FILE = path.join(ROOT, "data", "ground-truth.json");
const WORK_WIDTH = Number(process.env.REFINE_WORK ?? 800);
const SKY_WIDTH = 1024;
const VIEW_WIDTH = 1600;
const PERTURB = [-15, -10, -5, 5, 10, 15];
/** Experiment hook: REFINE_OPTS='{"robust":{"fitEye":false}}' is passed as refinePose options. */
const OPTS = process.env.REFINE_OPTS
	? JSON.parse(process.env.REFINE_OPTS)
	: undefined;
/**
 * Variant (c): the sky-model skyline takes trees, buildings and posts on the
 * crest as skyline, so it is cross-checked against detectSkyline (only
 * agreeing columns survive, weighted by both) and narrow spikes are removed.
 * Early one-sided rejection (robust.oneSidedEarly) was tried and hurt: on
 * near terrain the smoothed DEM sits below the photo almost everywhere.
 * REFINE_FUSE='{...}' overrides the fusion options.
 */
const FUSE = process.env.REFINE_FUSE ? JSON.parse(process.env.REFINE_FUSE) : {};
const C_OPTS = OPTS;
const CONVERGED_DEG = 0.5;

interface GroundTruth {
	width: number;
	height: number;
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	quality: "good" | "approx" | "none";
}

const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;
const r3 = (v: number) => (Number.isFinite(v) ? +v.toFixed(3) : null);

/** Mean |row difference| (px at `width`) between two cameras' DEM skylines (as scripts/eval.ts). */
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

interface Err {
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	skylinePx: number;
}

function errors(
	c: Camera,
	gt: Camera | undefined,
	h: HorizonProfile,
): Err | undefined {
	if (!gt) return undefined;
	return {
		yaw: angleDiff(c.yaw, gt.yaw),
		pitch: c.pitch - gt.pitch,
		roll: c.roll - gt.roll,
		f: c.f / gt.f - 1,
		skylinePx: skylineDistance(c, gt, h, VIEW_WIDTH),
	};
}

type SkyFn = (jpg: string) => Promise<SkylineObservation>;

/** Loads the sky model for variant (c); undefined if it can't run in node. */
async function loadSkyVariant(): Promise<SkyFn | undefined> {
	if (NO_SKY) return undefined;
	try {
		const core = await import("../src/lib/sky/core");
		const model = await import("../src/lib/sky/model");
		const { skylineFromSky } = await import("../src/lib/sky/skyline");
		// The model lives next to the sky code (older layout: public/).
		const file = [
			path.join(ROOT, "src", "lib", "sky", model.MODEL_FILE),
			path.join(ROOT, "public", model.MODEL_FILE),
		].find((f) => fs.existsSync(f));
		if (!file) return undefined;
		const ls = model.MODEL_LONG_SIDE as unknown;
		const longSide =
			typeof ls === "number" ? ls : (ls as { wasm: number }).wasm;
		const m = await model.createSkyModel(
			new Uint8Array(fs.readFileSync(file)),
			["wasm"],
		);
		return async (jpg: string) => {
			const img = await loadRGBA(jpg, SKY_WIDTH);
			const rgb = core.rgbPlanes(img);
			const low = await model.runSkyModel(
				m,
				rgb,
				img.width,
				img.height,
				longSide,
			);
			const mask = core.toBytes(
				core.refineToWorking(rgb, img.width, img.height, low, true),
			);
			return skylineFromSky({
				width: img.width,
				height: img.height,
				data: mask,
			});
		};
	} catch (e) {
		console.warn("sky variant (c) unavailable:", (e as Error).message);
		return undefined;
	}
}

type Ctx2D = ReturnType<ReturnType<typeof createCanvas>["getContext"]>;
function drawRows(
	ctx: Ctx2D,
	rows: Float32Array,
	scale: number,
	style: string,
	width: number,
) {
	ctx.strokeStyle = style;
	ctx.lineWidth = width;
	ctx.beginPath();
	let pen = false;
	for (let x = 0; x < rows.length; x++) {
		const y = rows[x];
		if (!Number.isFinite(y)) {
			pen = false;
			continue;
		}
		if (pen) ctx.lineTo((x + 0.5) * scale, y * scale);
		else ctx.moveTo((x + 0.5) * scale, y * scale);
		pen = true;
	}
	ctx.stroke();
}

const fmt = (v: number | null | undefined, d = 2) =>
	v === null || v === undefined || !Number.isFinite(v) ? "–" : v.toFixed(d);

async function main() {
	const gtAll: Record<string, GroundTruth> = fs.existsSync(GT_FILE)
		? JSON.parse(fs.readFileSync(GT_FILE, "utf8"))
		: {};
	fs.mkdirSync(SCRATCH, { recursive: true });
	fs.mkdirSync(OUT_RESULTS, { recursive: true });
	const skyFn = await loadSkyVariant();
	console.log(`variant (c) sky model: ${skyFn ? "available" : "skipped"}`);

	const rows: Record<string, unknown>[] = [];
	const results: Record<string, unknown>[] = [];
	const robust: { name: string; method: string; dYaw: number; err: number }[] =
		[];

	for (const { name, heic } of listPhotos(argv)) {
		const ctx = await photoContext(name, heic);
		const jpg = heicToJpeg(heic, VIEW_WIDTH);
		const img = await loadRGBA(jpg, WORK_WIDTH);
		const sky = detectSkyline(img);
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

		let t = performance.now();
		const a = solvePose(ctx.prior, ctx.horizon, sky as SkylineRows);
		const msA = performance.now() - t;
		t = performance.now();
		const b = refinePose({
			camera: ctx.prior,
			horizon: ctx.horizon,
			skyline: sky,
			gpsAccuracy: ctx.meta.gpsError,
			options: OPTS,
		});
		const msB = performance.now() - t;
		let c: RefineResult | undefined;
		let skyC: SkylineObservation | undefined;
		let msSky = 0;
		if (skyFn) {
			t = performance.now();
			// Same as refinePose({ ..., crossCheck: sky }) with default fusion options.
			skyC = rejectSpikes(
				fuseSkylines(await skyFn(jpg), sky, FUSE),
			) as SkylineObservation;
			msSky = performance.now() - t;
			c = refinePose({
				camera: ctx.prior,
				horizon: ctx.horizon,
				skyline: skyC,
				gpsAccuracy: ctx.meta.gpsError,
				options: C_OPTS,
			});
		}

		const eP = errors(ctx.prior, gt, ctx.horizon);
		const eA = errors(a.camera, gt, ctx.horizon);
		const eB = errors(b.camera, gt, ctx.horizon);
		const eC = c ? errors(c.camera, gt, ctx.horizon) : undefined;
		const row = {
			name,
			gt: g?.quality ?? "missing",
			prior: eP,
			a: { err: eA, confidence: a.confidence, accepted: a.accepted, ms: msA },
			b: {
				err: eB,
				score: b.confidence.score,
				accepted: b.confidence.accept,
				sigmaDeg: b.confidence.sigmaDeg,
				reasons: b.confidence.reasons,
				metrics: b.confidence.metrics,
				dEye: b.dEye,
				k: b.k,
				kFitted: b.kFitted,
				eyeFitted: b.eyeFitted,
				eyeSensitivityPx: b.eyeSensitivityPx,
				farFraction: b.farFraction,
				ransac: b.ransac,
				modes: b.modes.map((m) => ({
					yaw: +m.yaw.toFixed(3),
					pitch: +m.pitch.toFixed(3),
					cost: +m.cost.toFixed(2),
					support: +m.support.toFixed(1),
					seed: m.seed,
				})),
				iterations: b.iterations,
				ms: msB,
				initMs: b.init.ms,
			},
			c: c
				? {
						modes: c.modes.map((m) => ({
							yaw: +m.yaw.toFixed(3),
							pitch: +m.pitch.toFixed(3),
							cost: +m.cost.toFixed(2),
							support: +m.support.toFixed(1),
							inl: +m.inlierFraction.toFixed(2),
							seed: m.seed,
						})),
						metrics: c.confidence.metrics,
						err: eC,
						score: c.confidence.score,
						accepted: c.confidence.accept,
						dEye: c.dEye,
						ms: c.ms,
						skyMs: msSky,
						reasons: c.confidence.reasons,
					}
				: undefined,
		};
		rows.push(row);
		const resultRow = (
			method: string,
			res: RefineResult,
			ms: number,
			e?: Err,
		) => ({
			id: name,
			method,
			yaw: r3(res.camera.yaw),
			pitch: r3(res.camera.pitch),
			roll: r3(res.camera.roll),
			vfov: r3(vfovFromFocal(res.camera.f, res.camera.height)),
			confidence: r3(res.confidence.score),
			accepted: res.confidence.accept,
			ms: Math.round(ms),
			errYaw: e ? r3(e.yaw) : null,
			errPitch: e ? r3(e.pitch) : null,
			errRoll: e ? r3(e.roll) : null,
			dEye: r3(res.dEye),
		});
		results.push(resultRow("refine", b, msB, eB));
		if (c) results.push(resultRow("refine+sky", c, msSky + c.ms, eC));
		console.log(
			`${name} [${row.gt}]  prior yaw ${fmt(eP?.yaw)}  | (a) yaw ${fmt(eA?.yaw)} pitch ${fmt(eA?.pitch)} roll ${fmt(eA?.roll)} sky ${fmt(eA?.skylinePx, 1)}px conf ${a.confidence.toFixed(2)} ${Math.round(msA)}ms` +
				`  | (b) yaw ${fmt(eB?.yaw)} pitch ${fmt(eB?.pitch)} roll ${fmt(eB?.roll)} f ${fmt(eB?.f, 3)} sky ${fmt(eB?.skylinePx, 1)}px score ${b.confidence.score.toFixed(2)}${b.confidence.accept ? "✓" : "✗"} dEye ${b.dEye.toFixed(0)}${b.eyeFitted ? "" : "(fixed)"}[sens ${b.eyeSensitivityPx.toFixed(1)}px σ ${b.confidence.metrics.sigmaEye.toFixed(0)}m] k ${b.k.toFixed(2)}${b.kFitted ? "" : "(fixed)"} ${Math.round(msB)}ms` +
				(c
					? `  | (c) yaw ${fmt(eC?.yaw)} pitch ${fmt(eC?.pitch)} sky ${fmt(eC?.skylinePx, 1)}px score ${c.confidence.score.toFixed(2)}`
					: ""),
		);
		if (b.confidence.reasons.length)
			console.log(`    (b) reasons: ${b.confidence.reasons.join("; ")}`);

		// Robustness to the compass.
		if (gt && !NO_ROBUST) {
			for (const dy of PERTURB) {
				const pr = perturbCamera(ctx.prior, dy);
				const ra = solvePose(pr, ctx.horizon, sky as SkylineRows);
				const rb = refinePose({
					camera: pr,
					horizon: ctx.horizon,
					skyline: sky,
					gpsAccuracy: ctx.meta.gpsError,
					options: OPTS,
				});
				robust.push({
					name,
					method: "a",
					dYaw: dy,
					err: angleDiff(ra.camera.yaw, gt.yaw),
				});
				robust.push({
					name,
					method: "b",
					dYaw: dy,
					err: angleDiff(rb.camera.yaw, gt.yaw),
				});
				if (skyC) {
					const rc = refinePose({
						camera: pr,
						horizon: ctx.horizon,
						skyline: skyC,
						gpsAccuracy: ctx.meta.gpsError,
						options: C_OPTS,
					});
					robust.push({
						name,
						method: "c",
						dYaw: dy,
						err: angleDiff(rc.camera.yaw, gt.yaw),
					});
				}
			}
		}

		// Overlay.
		const photo = await loadImage(jpg);
		const canvas = createCanvas(photo.width, photo.height);
		const c2 = canvas.getContext("2d");
		c2.drawImage(photo, 0, 0);
		const s = photo.width / WORK_WIDTH;
		const det = new Float32Array(sky.rows.length);
		for (let x = 0; x < det.length; x++)
			det[x] = sky.weight[x] > 0.05 ? sky.rows[x] : Number.NaN;
		drawRows(c2, det, s, "rgba(255,230,0,0.9)", 2);
		const at = (cam: Camera) =>
			projectSkylineRows(
				resizeCamera(cam, WORK_WIDTH),
				ctx.horizon,
				WORK_WIDTH,
			);
		if (gt) drawRows(c2, at(gt), s, "rgba(255,255,255,0.95)", 4);
		drawRows(c2, at(a.camera), s, "rgba(0,230,255,0.95)", 2);
		drawRows(c2, at(b.camera), s, "rgba(0,255,90,0.95)", 2);
		if (c) drawRows(c2, at(c.camera), s, "rgba(255,140,0,0.95)", 2);
		c2.font = "bold 20px sans-serif";
		c2.fillStyle = "rgba(0,0,0,0.6)";
		c2.fillRect(0, 0, photo.width, 30);
		c2.fillStyle = "white";
		c2.fillText(
			`${name}  (a) yaw ${fmt(eA?.yaw)} sky ${fmt(eA?.skylinePx, 1)}px   (b) yaw ${fmt(eB?.yaw)} sky ${fmt(eB?.skylinePx, 1)}px score ${b.confidence.score.toFixed(2)}`,
			8,
			21,
		);
		fs.writeFileSync(
			path.join(SCRATCH, `${name}.jpg`),
			await canvas.encode("jpeg", 85),
		);
	}

	// ---- Report.
	type Row = (typeof rows)[number] & Record<string, any>;
	const R = rows as Row[];
	const withGt = R.filter((r) => r.b.err);
	const md: string[] = [];
	md.push(
		"| photo | GT | prior yaw | (a) yaw | (a) pitch | (a) roll | (a) sky px | (a) conf | (b) yaw | (b) pitch | (b) roll | (b) f | (b) sky px | (b) score | (b) σyaw/σpitch | dEye m | (b) ms | (c) yaw | (c) pitch | (c) sky px | (c) score |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	);
	for (const r of R) {
		const eA: Err | undefined = r.a.err;
		const eB: Err | undefined = r.b.err;
		const eC: Err | undefined = r.c?.err;
		md.push(
			`| ${r.name} | ${r.gt} | ${fmt(r.prior?.yaw)} | ${fmt(eA?.yaw)} | ${fmt(eA?.pitch)} | ${fmt(eA?.roll)} | ${fmt(eA?.skylinePx, 1)} | ${fmt(r.a.confidence)}${r.a.accepted ? "✓" : "✗"} | ${fmt(eB?.yaw)} | ${fmt(eB?.pitch)} | ${fmt(eB?.roll)} | ${fmt(eB?.f, 3)} | ${fmt(eB?.skylinePx, 1)} | ${fmt(r.b.score)}${r.b.accepted ? "✓" : "✗"} | ${fmt(r.b.sigmaDeg.yaw, 3)}/${fmt(r.b.sigmaDeg.pitch, 3)} | ${r.b.eyeFitted ? fmt(r.b.dEye, 0) : "fixed"} | ${Math.round(r.b.ms)} | ${fmt(eC?.yaw)} | ${fmt(eC?.pitch)} | ${fmt(eC?.skylinePx, 1)} | ${r.c ? `${fmt(r.c.score)}${r.c.accepted ? "✓" : "✗"}` : "–"} |`,
		);
	}
	const stat = (k: "a" | "b" | "c" | "prior") => {
		const es = withGt
			.map((r) => (k === "prior" ? r.prior : r[k]?.err) as Err | undefined)
			.filter((e): e is Err => !!e);
		if (!es.length) return undefined;
		const mean = (f: (e: Err) => number) =>
			es.reduce((s, e) => s + Math.abs(f(e)), 0) / es.length;
		const max = (f: (e: Err) => number) =>
			Math.max(...es.map((e) => Math.abs(f(e))));
		const med = (f: (e: Err) => number) => {
			const v = es.map((e) => Math.abs(f(e))).sort((x, y) => x - y);
			return v.length % 2
				? v[v.length >> 1]
				: 0.5 * (v[v.length / 2 - 1] + v[v.length / 2]);
		};
		return {
			n: es.length,
			yaw: {
				mean: mean((e) => e.yaw),
				median: med((e) => e.yaw),
				max: max((e) => e.yaw),
			},
			pitch: {
				mean: mean((e) => e.pitch),
				median: med((e) => e.pitch),
				max: max((e) => e.pitch),
			},
			roll: {
				mean: mean((e) => e.roll),
				median: med((e) => e.roll),
				max: max((e) => e.roll),
			},
			sky: {
				mean: mean((e) => e.skylinePx),
				median: med((e) => e.skylinePx),
				max: max((e) => e.skylinePx),
			},
		};
	};
	const summary = {
		prior: stat("prior"),
		a: stat("a"),
		b: stat("b"),
		c: stat("c"),
	};
	md.push(
		"",
		"| method | n | yaw mean / median / max | pitch mean / median / max | roll mean / median / max | sky px mean / median / max |",
		"|---|---|---|---|---|---|",
	);
	for (const [k, v] of Object.entries(summary)) {
		if (!v) continue;
		const f3 = (o: { mean: number; median: number; max: number }, d = 2) =>
			`${fmt(o.mean, d)} / ${fmt(o.median, d)} / ${fmt(o.max, d)}`;
		md.push(
			`| ${k} | ${v.n} | ${f3(v.yaw)} | ${f3(v.pitch)} | ${f3(v.roll)} | ${f3(v.sky, 1)} |`,
		);
	}
	// What the pipeline would do: use the result only when accepted (else manual).
	md.push(
		"",
		"Accepted results only (rejected ones go to the manual tap-a-peak flow); bad = accepted with |yaw| or |pitch| > 0.5°:",
		"",
		"| method | accepted | yaw mean / max | pitch mean / max | sky px mean / max | bad accepts |",
		"|---|---|---|---|---|---|",
	);
	for (const k of ["a", "b", "c"] as const) {
		const acc = withGt.filter((r) => r[k]?.accepted && r[k]?.err);
		const all = withGt.filter((r) => r[k]?.err);
		if (!all.length) continue;
		const es = acc.map((r) => r[k].err as Err);
		const mean = (f: (e: Err) => number) =>
			es.length
				? es.reduce((q, e) => q + Math.abs(f(e)), 0) / es.length
				: Number.NaN;
		const max = (f: (e: Err) => number) =>
			es.length ? Math.max(...es.map((e) => Math.abs(f(e)))) : Number.NaN;
		const bad = es.filter(
			(e) => Math.abs(e.yaw) > 0.5 || Math.abs(e.pitch) > 0.5,
		).length;
		md.push(
			`| ${k} | ${acc.length}/${all.length} | ${fmt(mean((e) => e.yaw))} / ${fmt(max((e) => e.yaw))} | ${fmt(mean((e) => e.pitch))} / ${fmt(max((e) => e.pitch))} | ${fmt(
				mean((e) => e.skylinePx),
				1,
			)} / ${fmt(
				max((e) => e.skylinePx),
				1,
			)} | ${bad} |`,
		);
	}
	if (robust.length) {
		md.push(
			"",
			`Robustness (prior yaw perturbed by ${PERTURB.join(", ")}°; converged = |yaw err| < ${CONVERGED_DEG}°):`,
			"",
			"| method | ±5° | ±10° | ±15° | all |",
			"|---|---|---|---|---|",
		);
		for (const m of ["a", "b", "c"]) {
			const rs = robust.filter((r) => r.method === m);
			if (!rs.length) continue;
			const rate = (sel: typeof rs) =>
				`${sel.filter((r) => Math.abs(r.err) < CONVERGED_DEG).length}/${sel.length}`;
			md.push(
				`| ${m} | ${rate(rs.filter((r) => Math.abs(r.dYaw) === 5))} | ${rate(rs.filter((r) => Math.abs(r.dYaw) === 10))} | ${rate(rs.filter((r) => Math.abs(r.dYaw) === 15))} | ${rate(rs)} |`,
			);
		}
	}
	const msB = R.map((r) => r.b.ms as number).sort((x, y) => x - y);
	const msA = R.map((r) => r.a.ms as number).sort((x, y) => x - y);
	md.push(
		"",
		`Runtime (node, 800-wide skyline): (a) median ${Math.round(msA[msA.length >> 1])} ms, max ${Math.round(msA[msA.length - 1])} ms; (b) median ${Math.round(msB[msB.length >> 1])} ms, max ${Math.round(msB[msB.length - 1])} ms.`,
	);

	fs.writeFileSync(path.join(SCRATCH, "report.md"), `${md.join("\n")}\n`);
	fs.writeFileSync(
		path.join(SCRATCH, "report.json"),
		JSON.stringify({ rows, summary, robust }, null, 1),
	);
	fs.writeFileSync(
		path.join(OUT_RESULTS, "results.json"),
		JSON.stringify(results, null, 1),
	);
	console.log(`\n${md.join("\n")}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
