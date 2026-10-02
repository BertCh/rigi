// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * VSWEEP evaluation (tools/research/vsweep/PROTOCOL.txt): horizontal stage (H_geo solvePose,
 * H_app autoAlign) then the vertical arms V0 / VD / VP / VS / VPS, scored against
 * data/ground-truth.json. Node only (no browser, no GPU).
 *
 *   npx tsx scripts/vsweep/eval.ts [IMG_xxxx ...]      → out/vsweep/results.json + console table
 *   DEM=mapterhorn …                                    (pipeline-node DEM switch)
 */
import fs from "node:fs";
import path from "node:path";
import { autoAlign, edgeMapFg, edgeMapFromPixels } from "../../src/lib/align";
import { cameraToPose, poseToCamera } from "../../src/lib/camera";
import {
	type Camera,
	cameraFromAngles,
	perturbCamera,
	resizeCamera,
} from "../../src/lib/geo/camera";
import type { HorizonProfile } from "../../src/lib/geo/horizon";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { projectSkylineRows, solvePose } from "../../src/lib/geo/solve";
import { heicToJpeg, listPhotos, loadRGBA, ROOT } from "../lib/node-io";
import { DEM, photoContext } from "../lib/pipeline-node";
import {
	apexResiduals,
	denseResiduals,
	matchApexes,
	type Skyline,
	type SweepResult,
	VS_OPTS,
	verticalApex,
	verticalDense,
} from "./lib";

const BASIS = 1600;
const OUT = path.join(ROOT, "out", "vsweep");
const D = Math.PI / 180;
const PERTURB = [-1, -0.5, 0.5, 1];

type GT = {
	width: number;
	height: number;
	yaw: number;
	pitch: number;
	roll: number;
	f: number;
	quality: string;
	rmsPx1600?: number;
};
const gtAll: Record<string, GT> = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
);

const angleDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;
const median = (a: number[]) => {
	const s = a.filter(Number.isFinite).sort((x, y) => x - y);
	if (!s.length) return Number.NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Mean |row| and mean signed row difference (est − GT) of the DEM skyline at BASIS px. */
function skylineGap(a: Camera, b: Camera, h: HorizonProfile) {
	const ra = projectSkylineRows(a, h, BASIS);
	const rb = projectSkylineRows(b, h, BASIS);
	const height = (b.height * BASIS) / b.width;
	let s = 0;
	let sg = 0;
	let n = 0;
	for (let x = 0; x < BASIS; x++) {
		if (!Number.isFinite(ra[x]) || !Number.isFinite(rb[x])) continue;
		if (rb[x] < 0 || rb[x] > height) continue;
		s += Math.abs(ra[x] - rb[x]);
		sg += ra[x] - rb[x];
		n++;
	}
	return n ? { abs: s / n, signed: sg / n } : { abs: NaN, signed: NaN };
}

function horizonDirs(h: HorizonProfile) {
	const every = Math.max(1, Math.round(0.2 / h.step));
	const dl: number[] = [];
	for (let k = 0; k < h.elevation.length; k += every) {
		const el = h.elevation[k];
		if (!Number.isFinite(el)) continue;
		const az = k * h.step * D;
		dl.push(
			Math.sin(az) * Math.cos(el * D),
			Math.cos(az) * Math.cos(el * D),
			Math.sin(el * D),
		);
	}
	return new Float32Array(dl);
}

type ArmRow = {
	pitchErr: number;
	yawErr: number;
	gapAbs: number;
	gapSigned: number;
	dPitch: number;
	n: number;
	fallback: boolean;
	/** final |pitch err| from each perturbed start (PERTURB order) */
	perturbed: number[];
};

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const results: Record<string, unknown>[] = [];
	for (const { name, heic } of listPhotos(process.argv.slice(2))) {
		const g = gtAll[name];
		if (!g || g.quality === "none") continue;
		const t0 = performance.now();
		const ctx = await photoContext(name, heic);
		const jpg = heicToJpeg(heic, BASIS);
		const img800 = await loadRGBA(jpg, 800);
		const img1600 = await loadRGBA(jpg, BASIS);
		const img512 = await loadRGBA(jpg, 512);
		const sky800 = detectSkyline(img800, { returnSky: false });
		const sky1600: Skyline = detectSkyline(img1600, { returnSky: false });
		const gt = cameraFromAngles({
			width: g.width,
			height: g.height,
			f: g.f,
			yaw: g.yaw,
			pitch: g.pitch,
			roll: g.roll,
		});
		const gt16 = resizeCamera(gt, BASIS);
		const W = ctx.prior.width;
		const H = ctx.prior.height;

		// horizontal stages
		const geo = solvePose(ctx.prior, ctx.horizon, sky800);
		const priorPose = cameraToPose(ctx.prior);
		const edge = edgeMapFromPixels(
			img512.data,
			img512.width,
			img512.height,
			edgeMapFg(img512.width, img512.height),
		);
		const app = autoAlign(
			priorPose,
			img512.width / img512.height,
			horizonDirs(ctx.horizon),
			edge,
		);
		const stages: Record<string, Camera> = {
			H_geo: geo.camera,
			H_app: poseToCamera(app.pose, W, H),
		};

		const score = (c: Camera) => {
			const gap = skylineGap(c, gt16, ctx.horizon);
			return {
				pitchErr: c.pitch - g.pitch,
				yawErr: angleDiff(c.yaw, g.yaw),
				gapAbs: gap.abs,
				gapSigned: gap.signed,
			};
		};
		const arms: Record<
			string,
			(c: Camera) => SweepResult & { matches?: unknown[] }
		> = {
			V0: (c) => ({ cam: c, dPitch: 0, n: 0, fallback: false, cost: 0 }),
			VD: (c) => verticalDense(c, sky1600, ctx.horizon),
			VP: (c) => verticalApex(c, sky1600, ctx.horizon, ["peak"]),
			VS: (c) => verticalApex(c, sky1600, ctx.horizon, ["saddle"]),
			VPS: (c) => verticalApex(c, sky1600, ctx.horizon, ["peak", "saddle"]),
		};

		const perStage: Record<string, Record<string, ArmRow>> = {};
		for (const [sk, cam] of Object.entries(stages)) {
			const start = resizeCamera(cam, BASIS);
			perStage[sk] = {};
			for (const [ak, arm] of Object.entries(arms)) {
				const r = arm(start);
				const s = score(r.cam);
				const perturbed = PERTURB.map((dp) =>
					Math.abs(arm(perturbCamera(start, 0, dp)).cam.pitch - g.pitch),
				);
				perStage[sk][ak] = {
					...s,
					dPitch: r.dPitch,
					n: r.n,
					fallback: r.fallback,
					perturbed,
				};
			}
		}

		// diagnostic at the GT pose: signed photo − DEM residuals (px @1600)
		const pk = matchApexes(gt16, sky1600, ctx.horizon, "peak");
		const sd = matchApexes(gt16, sky1600, ctx.horizon, "saddle");
		const dense = denseResiduals(gt16, sky1600, ctx.horizon);
		const distOf = (x: number, y: number) => {
			const [az] = (() => {
				const d = gt16;
				const u = [(x - d.cx) / d.f, (y - d.cy) / d.f, 1];
				const e = [0, 1, 2].map(
					(i) => d.east[i] * u[0] + d.north[i] * u[1] + d.up[i] * u[2],
				);
				return [((Math.atan2(e[0], e[1]) / D + 360) % 360) as number];
			})();
			const i =
				Math.round(az / ctx.horizon.step) % ctx.horizon.elevation.length;
			return ctx.horizon.distance[i];
		};
		const diag = {
			peak: apexResiduals(gt16, pk).map((r, i) => ({
				r: +r.toFixed(2),
				prom: +pk[i].dem.prom.toFixed(1),
				dKm: +(distOf(pk[i].dem.x, pk[i].dem.y) / 1000).toFixed(1),
			})),
			saddle: apexResiduals(gt16, sd).map((r, i) => ({
				r: +r.toFixed(2),
				prom: +sd[i].dem.prom.toFixed(1),
				dKm: +(distOf(sd[i].dem.x, sd[i].dem.y) / 1000).toFixed(1),
			})),
			denseMedian: +median(dense.r).toFixed(2),
			denseN: dense.r.length,
		};

		const row = {
			name,
			quality: g.quality,
			gtRmsPx: g.rmsPx1600,
			geoAccepted: geo.accepted,
			appConfidence: +app.confidence.toFixed(2),
			pxPerDeg: +(gt16.f * D).toFixed(1),
			perStage,
			diag,
			ms: Math.round(performance.now() - t0),
		};
		results.push(row);
		const fmt = (a: ArmRow) =>
			`${a.pitchErr >= 0 ? "+" : ""}${a.pitchErr.toFixed(2)}${a.fallback ? "*" : ""}(${a.n})`;
		for (const sk of Object.keys(stages))
			console.log(
				`${name} ${sk.padEnd(5)} yaw ${perStage[sk].V0.yawErr.toFixed(2).padStart(6)} | ` +
					Object.entries(perStage[sk])
						.map(([k, a]) => `${k} ${fmt(a)}`)
						.join("  "),
			);
		console.log(
			`${name} diag@GT peaks ${diag.peak.map((p) => p.r).join(",")} | saddles ${diag.saddle.map((p) => p.r).join(",")} | dense med ${diag.denseMedian} (${row.ms} ms)`,
		);
	}
	const tag = process.env.VS_TAG ? `-${process.env.VS_TAG}` : "";
	const file = path.join(OUT, `results-${DEM.name}${tag}.json`);
	fs.writeFileSync(file, JSON.stringify({ opts: VS_OPTS, results }, null, 1));
	console.log(`wrote ${file}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
