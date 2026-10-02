// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Photo skylines for the propagation DEM-render check (METHOD.txt step 1).
 * The app's sky model exactly as scripts/sky-eval.ts runs it (node, src/lib/nn: Dawn WebGPU with DAWN_DIR, else the CPU backend).
 *
 *   npx tsx tools/nearfield/propagate/render_check/skyline.ts
 * Writes render_check/out/skyline_<id>.json {W, H, rows[], weight[]} and a mask PNG.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { loadRGBA, ROOT } from "../../../../scripts/lib/node-io";
import { createSkyModelNode } from "../../../../scripts/lib/sky-model-node";
import {
	refineToWorking,
	rgbPlanes,
	toBytes,
} from "../../../../src/lib/sky/core";
import { runSkyModel } from "../../../../src/lib/sky/model";
import { skylineFromSky } from "../../../../src/lib/sky/skyline";

const IDS = ["IMG_7059", "IMG_7063", "IMG_7068"];
const OUT = path.join(import.meta.dirname, "out");

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	const { model, longSide } = await createSkyModelNode();
	for (const id of IDS) {
		const file = path.join(ROOT, "public", "photos", `${id}.jpg`);
		const im0 = await loadImage(file);
		const w =
			im0.width >= im0.height
				? 1024
				: Math.round((1024 * im0.width) / im0.height);
		const img = await loadRGBA(file, w);
		const W = img.width;
		const H = img.height;
		const rgb = rgbPlanes(img);
		const low = await runSkyModel(model, rgb, W, H, longSide);
		const pm = refineToWorking(rgb, W, H, low, true);
		const mask = { width: W, height: H, data: toBytes(pm) };
		const sky = skylineFromSky(mask);
		fs.writeFileSync(
			path.join(OUT, `skyline_${id}.json`),
			JSON.stringify({
				id,
				W,
				H,
				W0: im0.width,
				H0: im0.height,
				rows: Array.from(sky.rows, (v) => (Number.isFinite(v) ? v : null)),
				weight: Array.from(sky.weight),
			}),
		);
		const c = createCanvas(W, H);
		const ctx = c.getContext("2d");
		const d = ctx.createImageData(W, H);
		for (let i = 0; i < W * H; i++) {
			d.data[4 * i] = d.data[4 * i + 1] = d.data[4 * i + 2] = mask.data[i];
			d.data[4 * i + 3] = 255;
		}
		ctx.putImageData(d, 0, 0);
		fs.writeFileSync(path.join(OUT, `mask_${id}.png`), await c.encode("png"));
		const valid = sky.rows.filter(
			(v, i) => Number.isFinite(v) && sky.weight[i] > 0.05,
		).length;
		console.log(`${id} ${W}x${H} valid columns ${valid}`);
	}
}
main();
