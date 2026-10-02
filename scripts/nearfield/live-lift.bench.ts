// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live Step Inside lift (src/lib/nearfield/live): parity of the all-GPU live depth run against the current
// production path (liftGaussiansGpu → buildNearFieldScene without grounding), and the per-frame GPU time
// of the live depth run and of the colour-only refresh, over Dawn in node.
//
// Inputs are pre-decoded (node has no JPEG decoder): `--dir` holds index.json
// ([{ name, W, H, file }]) and `<file>` = RGB8 at W × H, e.g. made with PIL (the demo photos cropped to
// 1024 × 683 and 512 × 341). The net runs on the nn GPU backend (MoGe-2 ViT-S, `--weights q8lite|q8|fp16`).
// The DEM is synthetic (a flat ground plane under an eye 1.6 m up, pose pitch 0, vfov 55°), so the Object
// split has real content; both paths share the anchor fit of the reference scene.
//
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nearfield/live-lift.bench.ts --dir <dir> [--weights q8lite] [--reps 15] [--json out.json]
//
// Exit 1 when a parity budget is exceeded (positions, counts, colours), 0 otherwise, SKIP without Dawn.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Texture } from "@luma.gl/core";
import {
	intrinsicsFromPose,
	sampleDemGrid,
} from "../../src/lib/nearfield/geom";
import { camToEnuMatrix } from "../../src/lib/nearfield/lift";
import { LiveNearField } from "../../src/lib/nearfield/live/session";
import { composeDepth } from "../../src/lib/nearfield/local/compose";
import {
	FOCAL_GRID,
	MOGE2_WEIGHTS,
	MogeDepthNet,
	type MogeWeights,
	tokenGrid,
} from "../../src/lib/nearfield/local/depth-net";
import { liftGaussiansGpu } from "../../src/lib/nearfield/local/lift-gpu";
import { buildNearFieldScene } from "../../src/lib/nearfield/scene";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { dawnDevice } from "../nn/dawn";

const argv = process.argv.slice(2);
const arg = (k: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const dir = arg("--dir");
if (!dir) {
	console.error(
		"usage: live-lift.bench.ts --dir <dir> [--weights q8lite] [--reps 15] [--json out.json]",
	);
	process.exit(2);
}
const weights = (arg("--weights") ?? "q8lite") as MogeWeights;
const REPS = Number(arg("--reps") ?? 15);
const device = await dawnDevice("live-lift-bench");
if (!device) {
	console.log("SKIP live-lift: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const nn = new GpuNn(device);
const MODELS = path.resolve(import.meta.dirname, "../../public/models");
const net = new MogeDepthNet(
	nn,
	nn.weightsFromBytes(
		new Uint8Array(readFileSync(path.join(MODELS, MOGE2_WEIGHTS[weights]))),
	),
);
await nn.sync();
console.log(
	`weights ${weights} (normal head ${net.hasNormalHead ? "yes" : "no"})`,
);

type Entry = { name: string; W: number; H: number; file: string };
const entries = JSON.parse(
	readFileSync(path.join(dir, "index.json"), "utf8"),
) as Entry[];
const wanted = arg("--only") ? new Set(arg("--only")?.split(",")) : null;

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const pct = (xs: number[], p: number) =>
	[...xs].sort((a, b) => a - b)[
		Math.min(xs.length - 1, Math.floor(p * xs.length))
	];

/** Bilinear resize of RGB8 → planar float 0..1 at (ow, oh). */
function planesAt(
	rgb: Uint8Array,
	W: number,
	H: number,
	ow: number,
	oh: number,
) {
	const out = new Float32Array(3 * ow * oh);
	for (let y = 0; y < oh; y++) {
		const fy = Math.min(H - 1, Math.max(0, ((y + 0.5) * H) / oh - 0.5));
		const y0 = Math.floor(fy);
		const y1 = Math.min(H - 1, y0 + 1);
		const ty = fy - y0;
		for (let x = 0; x < ow; x++) {
			const fx = Math.min(W - 1, Math.max(0, ((x + 0.5) * W) / ow - 0.5));
			const x0 = Math.floor(fx);
			const x1 = Math.min(W - 1, x0 + 1);
			const tx = fx - x0;
			for (let c = 0; c < 3; c++) {
				const a = rgb[3 * (y0 * W + x0) + c];
				const b = rgb[3 * (y0 * W + x1) + c];
				const d = rgb[3 * (y1 * W + x0) + c];
				const e = rgb[3 * (y1 * W + x1) + c];
				out[c * ow * oh + y * ow + x] =
					((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty) /
					255;
			}
		}
	}
	return out;
}

const POSE = { yaw: 0, pitch: 0, roll: 0, vfov: 55 };
const EYE = { x: 0, y: 0, z: 1.6 };
const wall = async () => {
	await (device.handle as GPUDevice).queue.onSubmittedWorkDone();
};

const results: Record<string, unknown>[] = [];
let failed = 0;
for (const e of entries) {
	if (wanted && !wanted.has(`${e.name}@${e.W}x${e.H}`) && !wanted.has(e.name))
		continue;
	const { W, H } = e;
	const rgb = new Uint8Array(readFileSync(path.join(dir, e.file)));
	const rgba = new Uint8Array(4 * W * H);
	for (let k = 0; k < W * H; k++) {
		rgba[4 * k] = rgb[3 * k];
		rgba[4 * k + 1] = rgb[3 * k + 1];
		rgba[4 * k + 2] = rgb[3 * k + 2];
		rgba[4 * k + 3] = 255;
	}
	const [bh, bw] = tokenGrid(1200, W / H);
	const image = nn.fromArray(planesAt(rgb, W, H, bw * 14, bh * 14), [
		1,
		3,
		bh * 14,
		bw * 14,
	]);
	const out = await net.run(image, W / H, [H, W]);
	const headNormals = argv.includes("--head-normals") && !!out.normal;
	const [z, mask, normal, points64, mask64, scale] = await Promise.all([
		nn.read(out.z),
		nn.read(out.mask),
		headNormals && out.normal ? nn.read(out.normal) : null,
		nn.read(out.points64),
		nn.read(out.mask64),
		nn.read(out.metricScale),
	]);
	// default: the live kernel derives normals from the depth; so does the reference (normal: null);
	// --head-normals feeds the fp16 / q8 normal head to both
	const arrays = {
		width: W,
		height: H,
		z,
		mask,
		normal,
		points64,
		mask64,
		focalGrid: FOCAL_GRID,
		metricScale: scale[0],
	};
	const tCompose = performance.now();
	const depth = composeDepth(arrays, "bench");
	const composeMs = performance.now() - tCompose;
	const K = depth.intrinsicsNorm as NonNullable<typeof depth.intrinsicsNorm>;

	// synthetic DEM range: a flat ground plane under the eye
	const Kp = intrinsicsFromPose(POSE, W / H);
	const R = camToEnuMatrix(POSE);
	const demGrid = sampleDemGrid(W, H, (u, v) => {
		const x = (u - Kp.cx) / Kp.fx;
		const y = (v - Kp.cy) / Kp.fy;
		const dz = R[6] * x + R[7] * y + R[8];
		const len = Math.hypot(x, y, 1);
		if (!(dz < -1e-3)) return null;
		return ((EYE.z / -dz) * len) / 1;
	});

	// reference: the production lift (GPU records, CPU compaction) + buildNearFieldScene (no grounding)
	const tLift = performance.now();
	const cloud = await liftGaussiansGpu(device, {
		width: W,
		height: H,
		depth: depth.depth,
		valid: depth.valid,
		normal: depth.normal ?? null,
		rgba,
		K,
	});
	const liftMs = performance.now() - tLift;
	const tScene = performance.now();
	const scene = buildNearFieldScene({
		photoId: e.name,
		depth,
		cloud,
		cloudIntrinsics: K,
		renderer: { pose: POSE, aspect: W / H, eye: EYE, sampleAt: () => null },
		demGrid,
		ground: false,
		farObjects: false,
		split: { objectMargin: 0.5, nearRadius: 150, minGapM: 3 },
	});
	const sceneMs = performance.now() - tScene;

	// live
	const live = new LiveNearField({
		device,
		width: W,
		height: H,
		demGrid,
		writeCloud: true,
	});
	live.setCamera({ camToEnu: R, eye: [EYE.x, EYE.y, EYE.z], K: Kp });
	live.setCalibration({
		focal: depth.focal,
		shift: depth.shift,
		metricScale: scale[0],
		K,
		anchor: scene.anchor,
		usable: true,
	});
	const video = device.createTexture({
		id: "bench-video",
		format: "rgba8unorm",
		width: W,
		height: H,
		usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER,
	});
	video.writeData(rgba);
	await live.warm(video, "depth", headNormals);
	await live.warm(video, "colour");
	const bufferOf = (t: unknown) => nn.bufferOf(t as never);
	const inputs = {
		z: bufferOf(out.z),
		mask: bufferOf(out.mask),
		normal: headNormals && out.normal ? bufferOf(out.normal) : null,
		metricScale: bufferOf(out.metricScale),
	};
	if (!live.runDepth(inputs, video))
		throw new Error("live depth run did not start");
	const got = await live.readCloud();

	// match by cell: project the reference splats back to their depth-grid cell
	const stride = live.grid.stride;
	const refCell = (i: number) => {
		const px = scene.splats.positions[3 * i] - EYE.x;
		const py = scene.splats.positions[3 * i + 1] - EYE.y;
		const pz = scene.splats.positions[3 * i + 2] - EYE.z;
		// camera = Rᵀ (p - eye)
		const x = R[0] * px + R[3] * py + R[6] * pz;
		const y = R[1] * px + R[4] * py + R[7] * pz;
		const zc = R[2] * px + R[5] * py + R[8] * pz;
		const u = Kp.cx + (Kp.fx * x) / zc;
		const v = Kp.cy + (Kp.fy * y) / zc;
		const gi = Math.floor((u * W - 0.5) / stride);
		const gj = Math.floor((v * H - 0.5) / stride);
		return gj * live.grid.gw + gi;
	};
	const refByCell = new Map<number, number>();
	for (let i = 0; i < scene.splats.count; i++) refByCell.set(refCell(i), i);
	const relPos: number[] = [];
	const scaleErr: number[] = [];
	const quatDeg: number[] = [];
	let colourBad = 0;
	let matched = 0;
	let onlyLive = 0;
	for (let j = 0; j < got.count; j++) {
		const i = refByCell.get(got.cells[j]);
		if (i === undefined) {
			onlyLive++;
			continue;
		}
		matched++;
		const dx = got.positions[3 * j] - scene.splats.positions[3 * i];
		const dy = got.positions[3 * j + 1] - scene.splats.positions[3 * i + 1];
		const dz = got.positions[3 * j + 2] - scene.splats.positions[3 * i + 2];
		const r = Math.hypot(
			scene.splats.positions[3 * i] - EYE.x,
			scene.splats.positions[3 * i + 1] - EYE.y,
			scene.splats.positions[3 * i + 2] - EYE.z,
		);
		relPos.push(Math.hypot(dx, dy, dz) / r);
		let s = 0;
		for (let a = 0; a < 3; a++)
			s = Math.max(
				s,
				Math.abs(got.scales[3 * j + a] / scene.splats.scales[3 * i + a] - 1),
			);
		scaleErr.push(s);
		let dot = 0;
		for (let a = 0; a < 4; a++)
			dot += got.rotations[4 * j + a] * scene.splats.rotations[4 * i + a];
		quatDeg.push((2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI);
		for (let a = 0; a < 3; a++)
			if (
				Math.abs(got.colors[4 * j + a] - scene.splats.colors[4 * i + a]) > 1
			) {
				colourBad++;
				break;
			}
	}
	const refCount = scene.splats.count;
	const onlyRef = refCount - matched;
	const countDiffPct = (100 * (got.count - refCount)) / Math.max(1, refCount);

	// timing: the live depth run (depth → lift → finalize → colour) and the colour-only refresh
	const depthMs: number[] = [];
	const colourMs: number[] = [];
	for (let r = 0; r < REPS + 2; r++) {
		await wall();
		const t = performance.now();
		live.runDepth(inputs, video);
		await wall();
		if (r >= 2) depthMs.push(performance.now() - t);
	}
	for (let r = 0; r < REPS + 2; r++) {
		await wall();
		const t = performance.now();
		live.refreshColour(video);
		await wall();
		if (r >= 2) colourMs.push(performance.now() - t);
	}
	// GPU time per node (timestamp queries), median over the reps
	const nodeMs: Record<string, number[]> = {};
	for (let r = 0; r < REPS; r++) {
		const nodes = await live.profileDepth(inputs, video);
		for (const [id, ms] of Object.entries(nodes)) {
			nodeMs[id] = nodeMs[id] ?? [];
			nodeMs[id].push(ms);
		}
	}
	const gpuNodeMs = Object.fromEntries(
		Object.entries(nodeMs).map(([id, v]) => [id, +med(v).toFixed(3)]),
	);
	const row = {
		photo: e.name,
		grid: `${W}x${H}`,
		refCount,
		liveCount: got.count,
		countDiffPct: +countDiffPct.toFixed(2),
		matched,
		onlyRef,
		onlyLive,
		relPosMedian: med(relPos),
		relPosP99: pct(relPos, 0.99),
		relPosMax: Math.max(...relPos, 0),
		scaleErrP99: pct(scaleErr, 0.99),
		quatDegP99: pct(quatDeg, 0.99),
		quatDegMax: Math.max(...quatDeg, 0),
		colourMismatch: colourBad,
		liveDepthRunMs: +med(depthMs).toFixed(2),
		liveColourMs: +med(colourMs).toFixed(2),
		gpuNodeMs,
		current: {
			composeCpuMs: +composeMs.toFixed(1),
			liftGpuPlusReadbackMs: +liftMs.toFixed(1),
			sceneCpuMs: +sceneMs.toFixed(1),
		},
	};
	results.push(row);
	console.log(JSON.stringify(row));
	// budgets: tolerance-level parity (user preference), flips at thresholds allowed
	const flips = (onlyRef + onlyLive) / Math.max(1, refCount);
	const bad =
		!(row.relPosP99 < 1e-3) ||
		!(Math.abs(countDiffPct) < 3) ||
		flips > 0.04 ||
		colourBad > 0.001 * matched ||
		!(row.quatDegP99 < 1);
	if (bad) {
		failed++;
		console.log(`FAIL ${e.name} ${W}x${H}`);
	}
	// the scheduled path: calibrate from one read-back, frame() with depth every 3 frames, an async refit
	const sched = new LiveNearField({
		device,
		width: W,
		height: H,
		demGrid,
		writeCloud: true,
		schedule: { depthEvery: 3, refitEvery: 2 },
	});
	sched.setCamera({ camToEnu: R, eye: [EYE.x, EYE.y, EYE.z], K: Kp });
	const cal = sched.calibrate(arrays);
	// the synthetic DEM can fail the quality gate; the smoke needs the splats either way
	sched.setCalibration({ ...cal, usable: true });
	await sched.warm(video);
	await sched.warm(video, "colour");
	let ran = 0;
	let refits = 0;
	for (let f = 0; f < 12; f++) {
		const plan = sched.frame(() => inputs, video);
		if (plan.runDepth) ran++;
		if (plan.refit) {
			refits += (await sched.refit(async () => arrays)) ? 1 : 0;
		}
		await wall();
	}
	const schedCount = await sched.readCount();
	console.log(
		`  scheduled: calibrate quality ${cal.anchor ? cal.anchor.quality.toFixed(2) : "n/a"} focal ${cal.focal.toFixed(3)} shift ${cal.shift.toFixed(3)}; 12 frames -> ${ran} depth runs (${sched.stats.depthRuns} executed), ${sched.stats.colourRuns} colour runs, ${refits} refits, ${schedCount} splats`,
	);
	if (ran !== 4 || sched.stats.colourRuns !== 8) {
		failed++;
		console.log("FAIL scheduled run counts");
	}
	sched.dispose();
	live.dispose();
	video.destroy();
	nn.dispose([image, ...Object.values(out).filter((x) => x !== null)]);
}
if (arg("--json"))
	writeFileSync(arg("--json") as string, JSON.stringify(results, null, 1));
console.log(failed ? `${failed} over budget` : "ok");
process.exit(failed ? 1 : 0);
