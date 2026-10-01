// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const [, , id, out, x0 = 0, y0 = 0, x1 = 1, y1 = 1, W = 1200] = process.argv;
const img = await loadImage(fs.readFileSync(`public/photos/${id}.jpg`));
const sx = +x0 * img.width,
	sy = +y0 * img.height,
	sw = (+x1 - +x0) * img.width,
	sh = (+y1 - +y0) * img.height;
const w = +W,
	h = Math.round((w * sh) / sw);
const c = createCanvas(w, h),
	g = c.getContext("2d");
g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
g.font = "bold 13px sans-serif";
const step = +x1 - +x0 > 0.5 ? 0.1 : 0.02;
for (let v = Math.ceil(+x0 / step) * step; v <= +x1 + 1e-9; v += step) {
	const X = ((v - +x0) / (+x1 - +x0)) * w;
	g.strokeStyle = "rgba(255,0,255,0.6)";
	g.beginPath();
	g.moveTo(X, 0);
	g.lineTo(X, h);
	g.stroke();
	g.fillStyle = "yellow";
	g.fillText(v.toFixed(2), X + 2, 12);
}
for (let v = Math.ceil(+y0 / step) * step; v <= +y1 + 1e-9; v += step) {
	const Y = ((v - +y0) / (+y1 - +y0)) * h;
	g.strokeStyle = "rgba(0,255,255,0.6)";
	g.beginPath();
	g.moveTo(0, Y);
	g.lineTo(w, Y);
	g.stroke();
	g.fillStyle = "cyan";
	g.fillText(v.toFixed(2), 2, Y - 2);
}
fs.writeFileSync(out, c.toBuffer("image/jpeg", 80));
