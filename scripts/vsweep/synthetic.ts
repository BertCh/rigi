// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * VSWEEP synthetic sanity check: the "photo" skyline is the DEM horizon projected with the GT camera
 * (1600 px, Gaussian noise σ 1 px, every column weight 1). Each arm starts at GT pitch + δ
 * (δ ∈ ±0.25, ±0.5, ±1 deg) and must return within 0.03° of GT. Tests the solver, not the world.
 *   npx tsx scripts/vsweep/synthetic.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
	cameraFromAngles,
	perturbCamera,
	resizeCamera,
} from "../../src/lib/geo/camera";
import { projectSkylineRows } from "../../src/lib/geo/solve";
import { listPhotos, ROOT } from "../lib/node-io";
import { photoContext } from "../lib/pipeline-node";
import { verticalApex, verticalDense } from "./lib";

const gtAll = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
);
let seed = 0x9e3779b9;
const rand = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return (seed >>> 0) / 2 ** 32;
};
const gauss = () =>
	Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

const DELTAS = [-1, -0.5, -0.25, 0.25, 0.5, 1];
let fails = 0;
let total = 0;
async function main() {
	for (const { name, heic } of listPhotos(process.argv.slice(2))) {
		const g = gtAll[name];
		if (!g || g.quality === "none") continue;
		const ctx = await photoContext(name, heic);
		const gt = resizeCamera(cameraFromAngles(g), 1600);
		const rows = projectSkylineRows(gt, ctx.horizon, 1600).map((y) =>
			Number.isFinite(y) ? y + gauss() : Number.NaN,
		);
		const sky = {
			rows,
			weight: rows.map((y) => (Number.isFinite(y) ? 1 : 0)),
		};
		const errs: Record<string, string[]> = { VD: [], VP: [], VPS: [] };
		for (const d of DELTAS) {
			const start = perturbCamera(gt, 0, d);
			const res = {
				VD: verticalDense(start, sky, ctx.horizon),
				VP: verticalApex(start, sky, ctx.horizon, ["peak"]),
				VPS: verticalApex(start, sky, ctx.horizon, ["peak", "saddle"]),
			};
			for (const [k, r] of Object.entries(res)) {
				const e = r.cam.pitch - gt.pitch;
				const bad = !r.fallback && Math.abs(e) > 0.03;
				if (!r.fallback) total++;
				if (bad) fails++;
				errs[k].push(r.fallback ? "NC" : `${e.toFixed(2)}${bad ? "!" : ""}`);
			}
		}
		console.log(
			`${name}  ${Object.entries(errs)
				.map(([k, v]) => `${k} ${v.join(" ")}`)
				.join(" | ")}`,
		);
	}
	console.log(`synthetic: ${fails} of ${total} calls off by > 0.03°`);
}
main();
