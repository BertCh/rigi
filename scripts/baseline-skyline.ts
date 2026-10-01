// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Runs the photo skyline detector over img/*.HEIC and renders overlays.
 *
 *   npx tsx scripts/baseline-skyline.ts [IMG_7033 ...]
 *
 * Writes out/skyline/<name>.jpg: the photo (800 px wide) with the sky
 * mask (probability > 0.5) tinted cyan and the detected boundary drawn per column —
 * thick yellow where confident, thin red where weak.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { detectSkyline } from "../src/lib/geo/skyline";
import { heicToJpeg, listPhotos, loadRGBA, ROOT } from "./lib/node-io";

const OUT = path.join(ROOT, "out", "skyline");
const WORK_WIDTH = 800;

async function main() {
	fs.mkdirSync(OUT, { recursive: true });
	for (const { name, heic } of listPhotos(process.argv.slice(2))) {
		const img = await loadRGBA(heicToJpeg(heic, 1600), WORK_WIDTH);
		detectSkyline(img); // warm-up so timing reflects steady state
		const t0 = performance.now();
		const obs = detectSkyline(img);
		const ms = performance.now() - t0;

		const { width: w, height: h, rows, weight } = obs;
		let valid = 0;
		let wsum = 0;
		for (let x = 0; x < w; x++) {
			if (!Number.isNaN(rows[x])) valid++;
			wsum += weight[x];
		}

		// Photo with sky probability tinted.
		const px = new Uint8ClampedArray(img.data);
		if (obs.sky) {
			for (let i = 0; i < w * h; i++) {
				const a = obs.sky[i] > 128 ? 0.3 : 0;
				px[4 * i] = px[4 * i] * (1 - a);
				px[4 * i + 1] = px[4 * i + 1] * (1 - a) + 255 * a;
				px[4 * i + 2] = px[4 * i + 2] * (1 - a) + 255 * a;
			}
		}
		const canvas = createCanvas(w, h);
		const ctx = canvas.getContext("2d");
		ctx.putImageData(new ImageData(px, w, h), 0, 0);

		for (let x = 0; x < w - 1; x++) {
			const y0 = rows[x];
			const y1 = rows[x + 1];
			if (Number.isNaN(y0) || Number.isNaN(y1) || Math.abs(y1 - y0) > 8)
				continue;
			const wt = Math.min(weight[x], weight[x + 1]);
			const hue = 60 * wt; // red → yellow
			ctx.strokeStyle = `hsla(${hue}, 100%, 55%, ${0.5 + 0.5 * wt})`;
			ctx.lineWidth = 1 + 3 * wt;
			ctx.beginPath();
			ctx.moveTo(x + 0.5, y0);
			ctx.lineTo(x + 1.5, y1);
			ctx.stroke();
		}

		const label = `${name}  ${ms.toFixed(0)} ms  valid ${((100 * valid) / w).toFixed(0)}%  mean w ${(wsum / w).toFixed(2)}`;
		ctx.font = "bold 16px sans-serif";
		ctx.fillStyle = "rgba(0,0,0,0.6)";
		ctx.fillRect(0, 0, w, 24);
		ctx.fillStyle = "white";
		ctx.fillText(label, 8, 17);
		fs.writeFileSync(
			path.join(OUT, `${name}.jpg`),
			await canvas.encode("jpeg", 85),
		);
		console.log(label);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
