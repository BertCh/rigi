// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Visual check of one smear grid: photo + label outlines (yellow, dashed = unsure) + per-cell drape state.
//   red    draped onto terrain with the feature ON (smear left, or ordinary terrain drape where unlabelled: faint)
//   green  draped OFF, masked ON (removed by the split)
//   blue   masked in both (people mask)
//   node tools/nearfield/smear/viz.mjs three IMG_7086 out.jpg
import fs, { existsSync as _ex, readFileSync as _rd } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createCanvas, loadImage } from "@napi-rs/canvas";

// grids are stored gzipped (grid-*.json.gz); plain .json still read
const readGrid = (f) =>
	_ex(f)
		? JSON.parse(_rd(f, "utf8"))
		: JSON.parse(gunzipSync(_rd(`${f}.gz`)).toString("utf8"));

const [, , renderer, id, out] = process.argv;
const dir = new URL(".", import.meta.url).pathname;
const g = readGrid(`${dir}grid-${renderer}-${id}.json`);
const labels = JSON.parse(fs.readFileSync(`${dir}labels.json`, "utf8")).photos[
	id
];
const img = await loadImage(fs.readFileSync(`public/photos/${id}.jpg`));
const W = 1000;
const H = Math.round((W * img.height) / img.width);
const c = createCanvas(W, H);
const x = c.getContext("2d");
x.drawImage(img, 0, 0, W, H);
const cw = W / g.GW;
const ch = H / g.GH;
for (let j = 0; j < g.GH; j++)
	for (let i = 0; i < g.GW; i++) {
		const k = j * g.GW + i;
		const draped = g.range[k] > g.minRange;
		if (!draped) continue;
		let col = null;
		if (g.off[k] && g.on[k]) col = "rgba(0,80,255,0.45)";
		else if (!g.off[k] && g.on[k]) col = "rgba(0,255,0,0.5)";
		else if (!g.on[k]) col = "rgba(255,0,0,0.18)";
		if (col) {
			x.fillStyle = col;
			x.fillRect(i * cw, j * ch, cw + 0.5, ch + 0.5);
		}
	}
x.lineWidth = 2;
for (const l of labels) {
	x.strokeStyle = l.cls === "person" ? "magenta" : "yellow";
	x.setLineDash(l.unsure ? [6, 4] : []);
	x.beginPath();
	if (l.box)
		x.rect(
			l.box[0] * W,
			l.box[1] * H,
			(l.box[2] - l.box[0]) * W,
			(l.box[3] - l.box[1]) * H,
		);
	else {
		l.poly.forEach(([px, py], n) => {
			if (n) x.lineTo(px * W, py * H);
			else x.moveTo(px * W, py * H);
		});
		x.closePath();
	}
	x.stroke();
}
fs.writeFileSync(out, c.toBuffer("image/jpeg", 80));
