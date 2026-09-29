/**
 * Skyline + OSM peak labels using the ground-truth camera when available
 * (data/ground-truth.json), else the EXIF prior.
 *
 *   npx tsx scripts/baseline-peaks.ts [IMG_7053 ...]
 *
 * Writes out/peaks/<name>.jpg.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { type Camera, cameraFromAngles } from "../src/lib/geo/camera";
import { layoutPeakLabels } from "../src/lib/geo/peaks";
import {
	drawCrosshair,
	drawLabel,
	drawSkyline,
	type EyeMode,
	GT_FILE,
	loadScene,
	readJson,
} from "./annotate-lib";
import { heicToJpeg, listPhotos, ROOT } from "./lib/node-io";

const OUT = path.join(ROOT, "out", "peaks");
const WIDTH = 1600;

interface GTEntry {
	width: number;
	height: number;
	yaw: number | null;
	pitch: number | null;
	roll: number | null;
	f: number | null;
	quality: string;
	eyeRule?: EyeMode;
}

async function main() {
	const gt = readJson<Record<string, GTEntry>>(GT_FILE, {});
	fs.mkdirSync(OUT, { recursive: true });
	for (const { name, heic } of listPhotos(process.argv.slice(2))) {
		const g = gt[name];
		const scene = await loadScene(name, heic, undefined, g?.eyeRule ?? "max");
		let cam: Camera = scene.prior;
		let source = "prior";
		if (g && g.yaw !== null && g.pitch !== null && g.roll !== null && g.f) {
			cam = cameraFromAngles({
				width: g.width,
				height: g.height,
				yaw: g.yaw,
				pitch: g.pitch,
				roll: g.roll,
				f: g.f,
			});
			source = `ground truth (${g.quality})`;
		}
		const labels = layoutPeakLabels(
			scene.views.filter((v) => v.peak.name),
			cam,
			{ maxLabels: 25, minSpacingPx: cam.width * 0.025 },
		);

		const img = await loadImage(heicToJpeg(heic, WIDTH));
		const s = img.width / cam.width;
		const canvas = createCanvas(img.width, img.height);
		const ctx = canvas.getContext("2d");
		ctx.drawImage(img, 0, 0);
		drawSkyline(
			ctx,
			cam,
			scene.horizon,
			{ s, ox: 0, oy: 0, w: img.width, h: img.height },
			{ width: 2 },
		);
		for (const l of labels) {
			const x = l.x * s;
			const y = l.y * s;
			drawCrosshair(ctx, x, y, 9, "yellow");
			ctx.save();
			ctx.translate(x, y - 12);
			ctx.rotate(-Math.PI / 3);
			const ele = l.peak.ele ? ` ${Math.round(l.peak.ele)} m` : "";
			drawLabel(
				ctx,
				`${l.peak.name}${ele} · ${(l.distance / 1000).toFixed(0)} km`,
				0,
				0,
				"yellow",
				13,
			);
			ctx.restore();
		}
		drawLabel(
			ctx,
			`${name}  ${source}: yaw ${cam.yaw.toFixed(2)}° pitch ${cam.pitch.toFixed(2)}° roll ${cam.roll.toFixed(2)}°  ${labels.length} peaks`,
			8,
			24,
			"white",
			18,
		);
		fs.writeFileSync(
			path.join(OUT, `${name}.jpg`),
			await canvas.encode("jpeg", 88),
		);
		console.log(`${name}: ${source}, ${labels.length} labels`);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
