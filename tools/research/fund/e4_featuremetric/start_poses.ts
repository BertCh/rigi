// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * FUND E4: the current pipeline's start pose per primary photo (scripts/eval.ts cascade logic, node, no browser),
 * plus the app's GT skyline and the photo skyline for the renderer validation.
 *
 *   DEM=mapterhorn HORIZON=fast npx tsx tools/research/fund/e4_featuremetric/start_poses.ts
 *
 * Writes out/start_poses.json next to this file.
 */
import fs from "node:fs";
import path from "node:path";
import {
	type Camera,
	cameraFromAngles,
	resizeCamera,
} from "../../../../src/lib/geo/camera";
import { detectSkyline } from "../../../../src/lib/geo/skyline";
import {
	projectSkylineRows,
	type SkylineSolveResult,
	solvePose,
} from "../../../../src/lib/geo/solve";
import { refinePose } from "../../../../src/lib/refine/index";
import {
	heicToJpeg,
	listPhotos,
	loadRGBA,
	ROOT,
} from "../../../../scripts/lib/node-io";
import { photoContext } from "../../../../scripts/lib/pipeline-node";

const HERE = path.join(ROOT, "tools/research/fund/e4_featuremetric");
const GT = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
);
const WORK = 800;
const VIEW = 1600;
const VAL_W = 588;

const inSwiss = (lat: number, lon: number) =>
	lat >= 45.82 && lat <= 47.81 && lon >= 5.96 && lon <= 10.49;

const camJson = (c: Camera) => ({
	width: c.width,
	height: c.height,
	f: c.f,
	yaw: c.yaw,
	pitch: c.pitch,
	roll: c.roll,
});

function cascade(
	prior: Camera,
	ctx: Awaited<ReturnType<typeof photoContext>>,
	sky: Parameters<typeof solvePose>[2],
): SkylineSolveResult {
	const first = solvePose(prior, ctx.horizon, sky);
	if (first.accepted) return first;
	const r = refinePose({
		camera: prior,
		horizon: ctx.horizon,
		skyline: sky,
		gpsAccuracy: ctx.meta.gpsError,
	});
	if (!r.confidence.accept) return first; // eval.ts chain(): first result when none accepts
	return {
		...first,
		camera: r.camera,
		confidence: r.confidence.score,
		accepted: true,
		rejectReason: undefined,
	};
}

async function main() {
	const out: Record<string, unknown> = {};
	for (const { name, heic } of listPhotos([])) {
		const g = GT[name];
		if (!g || g.yaw == null || !inSwiss(g.lat, g.lon)) continue;
		const ctx = await photoContext(name, heic);
		const jpg = heicToJpeg(heic, VIEW);
		const img = await loadRGBA(jpg, WORK);
		const sky = await detectSkyline(img);
		const res = cascade(ctx.prior, ctx, sky);
		const gt = cameraFromAngles({
			width: g.width,
			height: g.height,
			f: g.f,
			yaw: g.yaw,
			pitch: g.pitch,
			roll: g.roll,
		});
		const img2 = await loadRGBA(jpg, VAL_W);
		const sky2 = await detectSkyline(img2);
		const gtRows = projectSkylineRows(resizeCamera(gt, VAL_W), ctx.horizon, VAL_W);
		out[name] = {
			lat: g.lat,
			lon: g.lon,
			eye: g.eye,
			pipelineEye: ctx.eye,
			gtQuality: g.quality,
			gt: camJson(gt),
			prior: camJson(ctx.prior),
			solved: camJson(res.camera),
			accepted: res.accepted,
			confidence: res.confidence,
			rejectReason: res.rejectReason ?? null,
			start: camJson(res.accepted ? res.camera : ctx.prior),
			horizon: {
				step: ctx.horizon.step,
				distance: Array.from(ctx.horizon.distance, (v) => Math.round(v)),
			},
			skyline: {
				width: VAL_W,
				gtRows: Array.from(gtRows, (v) => (Number.isFinite(v) ? +v.toFixed(1) : null)),
				photoRows: Array.from(sky2.rows, (v, i) => (sky2.weight[i] > 0.05 ? +v.toFixed(1) : null)),
			},
		};
		console.log(name, res.accepted ? "accepted" : `rejected(${res.rejectReason})`, "start yaw", (res.accepted ? res.camera : ctx.prior).yaw.toFixed(2), "gt", g.yaw);
	}
	fs.mkdirSync(path.join(HERE, "out"), { recursive: true });
	fs.writeFileSync(path.join(HERE, "out/start_poses.json"), JSON.stringify(out));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
