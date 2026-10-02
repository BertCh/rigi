// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Yaw-search data for the gipfelbuch pose pages (/gipfelbuch/baseline-pipeline, /gipfelbuch/accept-rule): the real
 * coarse-stage cost of solvePose (src/lib/geo/solve.ts planCoarse + coarseCost, truncated L1 + priors, best pitch
 * per yaw) on the 12 bundled Niederhorn photos, local search (±25° of the compass) and full circle (±180°).
 * Also the ambiguity, the winning and runner-up minima and the DEM skyline rows at the runner-up pose.
 *
 *   npx tsx scripts/gipfelbuch/data-pose-solve.ts
 *
 * Writes public/demo/gipfelbuch/pose-solve/pose-solve.json. Same inputs as scripts/gipfelbuch/build-data.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { DEM_SOURCES } from "../../src/lib/dem";
import { cameraFromAngles } from "../../src/lib/geo/camera";
import { computeHorizon } from "../../src/lib/geo/horizon";
import { EYE_ABOVE_GROUND } from "../../src/lib/geo/pipeline";
import { detectSkyline } from "../../src/lib/geo/skyline";
import {
	coarseCost,
	DEFAULT_SIGMA,
	planCoarse,
	projectSkylineRows,
	type SolveOptions,
	solvePose,
} from "../../src/lib/geo/solve";
import { loadTerrain } from "../../src/lib/geo/terrain";
import { demTileLoaderNode, loadRGBA, ROOT } from "../lib/node-io";

const WORK = 800;
const DEM = DEM_SOURCES.terrarium;
const loadTile = demTileLoaderNode(DEM);
const tiles = new Map<string, Float32Array>();
const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public/demo/manifest.json"), "utf8"),
) as {
	photos: {
		id: string;
		src: string;
		lat: number;
		lon: number;
		alt: number;
		heading: number;
		vfov: number;
		pitch: number;
		roll: number;
	}[];
};
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

async function run() {
	const out: Record<string, unknown> = {};
	for (const p of manifest.photos) {
		const img = await loadRGBA(
			path.join(ROOT, "public", p.src.replace(/^\//, "")),
			WORK,
		);
		const H = img.height;
		const prior = cameraFromAngles({
			width: WORK,
			height: H,
			f: H / 2 / Math.tan((p.vfov * Math.PI) / 360),
			yaw: p.heading,
			pitch: p.pitch,
			roll: p.roll,
		});
		const terrain = await loadTerrain(
			p.lat,
			p.lon,
			loadTile,
			DEM.levels,
			tiles,
			16,
			DEM.tileSize,
		);
		const eye = Math.max(
			p.alt,
			terrain.ground(p.lon, p.lat) + EYE_ABOVE_GROUND,
		);
		const horizon = computeHorizon(terrain, p.lat, p.lon, eye);
		detectSkyline(img);
		const sky = detectSkyline(img);

		const curve = (opts: SolveOptions, stride: number) => {
			const plan = planCoarse(prior, horizon, sky, opts);
			if (!plan) return null;
			// the cost at each yaw offset: best pitch offset, as coarseStage does
			const pts = plan.dys.map((dy) => {
				let best = { dp: 0, c: Number.POSITIVE_INFINITY };
				for (const dp of plan.dps) {
					const c = coarseCost(plan, dy, dp);
					if (c < best.c) best = { dp, c };
				}
				return { dy, ...best };
			});
			// local minima, as coarseStage finds them; runner-up = best minimum > 2° from the winner
			const minima = pts
				.filter(
					(v, i) =>
						(i === 0 || v.c <= pts[i - 1].c) &&
						(i === pts.length - 1 || v.c <= pts[i + 1].c),
				)
				.sort((a, b) => a.c - b.c);
			const win = minima[0];
			const run = minima.find((m) => Math.abs(m.dy - win.dy) > 2);
			const sorted = pts.map((v) => v.c).sort((a, b) => a - b);
			const median = sorted[sorted.length >> 1];
			const ambiguity =
				run && median - win.c > 0
					? Math.max(0, Math.min(1, 1 - (run.c - win.c) / (median - win.c)))
					: 0;
			const thin = pts.filter((_, i) => i % stride === 0);
			return {
				truncDeg: r3(plan.trunc),
				dy: thin.map((v) => r2(v.dy)),
				cost: thin.map((v) => r3(v.c)),
				win: { dy: r2(win.dy), dp: r2(win.dp), cost: r3(win.c) },
				runner: run
					? { dy: r2(run.dy), dp: r2(run.dp), cost: r3(run.c) }
					: null,
				median: r3(median),
				ambiguity: r3(ambiguity),
				nObs: plan.az.length,
			};
		};
		const local = curve({}, 1);
		const full = curve(
			{ yawRange: 180, sigma: { ...DEFAULT_SIGMA, yaw: 1e6 } },
			4,
		);
		let runnerRows: (number | null)[] | null = null;
		if (local?.runner) {
			const cam = cameraFromAngles({
				width: WORK,
				height: H,
				f: prior.f,
				yaw: prior.yaw + local.runner.dy,
				pitch: prior.pitch + local.runner.dp,
				roll: prior.roll,
			});
			runnerRows = Array.from(projectSkylineRows(cam, horizon, WORK), (v) =>
				Number.isFinite(v) ? Math.round(v * 10) / 10 : null,
			);
		}
		const s = solvePose(prior, horizon, sky);
		out[p.id] = {
			priorYaw: r2(prior.yaw),
			solveAmbiguity: r3(s.ambiguity),
			solveCoarse: s.coarse,
			local,
			full,
			runnerRows,
		};
		console.log(
			p.id,
			"ambiguity",
			local?.ambiguity,
			"solve",
			r3(s.ambiguity),
			"win",
			local?.win.dy,
			"runner",
			local?.runner?.dy,
		);
	}
	const dir = path.join(ROOT, "public/demo/gipfelbuch/pose-solve");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "pose-solve.json"),
		JSON.stringify({
			generated: new Date().toISOString().slice(0, 10),
			script: "scripts/gipfelbuch/data-pose-solve.ts",
			dem: "terrarium",
			photos: out,
		}),
	);
}
run();
