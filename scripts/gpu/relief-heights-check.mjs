#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { register as registerHooks } from "node:module";
// Node emulation check of the GPU relief height gather (src/lib/gpu/look/relief-heights.ts), no GPU:
// plans a synthetic DEM tile set (mixed zooms 12 / 13 / 14, sizes 128 / 256 / 512, a no-data corner,
// both yaw cases) with the real planner, runs emulateReliefHeights (the WGSL kernel's f32 twin) and
// compares with look/relief/heights.ts rasterizeHeights (the CPU reference, f64):
//   - extent / px equal reliefHeights' (the constants are mirrored in relief-heights.ts);
//   - hole pattern, and the max |difference| of the heights both fill.
//
//   node scripts/gpu/relief-heights-check.mjs
//
// Exit 1 when the extent differs, more than a few texels are a hole on one side only, more than 64
// texels differ by > 0.5 m (a tile-edge texel whose f32 inside test picks the neighbouring tile),
// or the rest differ by more than 0.05 m (synthetic terrain with 3 m per-pixel noise and steep
// ridges, so a 1e-3 px coordinate error is already centimetres).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const ROOT = path.resolve(import.meta.dirname, "../..");
const stub = `
export async function resolve(spec, ctx, next) {
	if (/\\?(url|raw|worker|inline)$/.test(spec)) return { url: "stub:" + spec, shortCircuit: true };
	return next(spec, ctx);
}
export async function load(url, ctx, next) {
	if (url.startsWith("stub:")) return { format: "module", source: "export default '';", shortCircuit: true };
	return next(url, ctx);
}`;
register({ tsconfig: path.join(ROOT, "tsconfig.json") });
registerHooks(`data:text/javascript,${encodeURIComponent(stub)}`);
const imp = (p) => import(pathToFileURL(path.join(ROOT, "src/lib", p)).href);
const { EnuFrame } = await imp("geodesy.ts");
const { lonToTileX, latToTileY } = await imp("dem/tiles.ts");
const { rasterizeHeights } = await imp("look/relief/heights.ts");
const { reliefHeights } = await imp("gpu/look/relief.ts");
const { planHeights, emulateReliefHeights } = await imp(
	"gpu/look/relief-heights.ts",
);

const HOLE = -1e6;
const frame = new EnuFrame(46.55, 8.05, 2200);
const hash = (a, b) => {
	let h =
		Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^
		Math.imul(b ^ 0x7f4a7c15, 0xc2b2ae35);
	h ^= h >>> 15;
	return (h >>> 0) / 4294967296;
};
// terrain: smooth ridges (global function of lon / lat) + per-pixel noise, the same under every tile
const field = (lon, lat) =>
	2200 +
	900 * Math.sin(lon * 90) * Math.cos(lat * 70) +
	350 * Math.sin(lon * 400 + lat * 310);
function mkTile(z, x, y, size) {
	const heights = new Float32Array(size * size);
	for (let j = 0; j < size; j++)
		for (let i = 0; i < size; i++) {
			const tx = (x + (i + 0.5) / size) / 2 ** z;
			const ty = (y + (j + 0.5) / size) / 2 ** z;
			const lon = tx * 360 - 180;
			const lat =
				(Math.atan(Math.sinh(Math.PI * (1 - 2 * ty))) * 180) / Math.PI;
			heights[j * size + i] = field(lon, lat) + 3 * hash(i + x * 7, j + y * 13);
		}
	return { key: { z, x, y }, size, heights };
}
const tiles = [];
const c12x = Math.floor(lonToTileX(8.05, 12));
const c12y = Math.floor(latToTileY(46.55, 12));
for (let dy = -5; dy <= 5; dy++)
	for (let dx = -5; dx <= 5; dx++) {
		if (dx >= 3 && dy >= 3) continue; // a no-data corner
		tiles.push(mkTile(12, c12x + dx, c12y + dy, 256));
	}
for (let dy = 0; dy < 2; dy++)
	for (let dx = 0; dx < 2; dx++)
		tiles.push(mkTile(13, 2 * c12x + dx, 2 * c12y + dy, 128));
for (let dy = 0; dy < 4; dy++)
	for (let dx = 0; dx < 4; dx++)
		tiles.push(mkTile(14, 4 * c12x + 2 + dx, 4 * c12y + 2 + dy, 512));

let bad = 0;
for (const yaw of [null, 0, 30, 210]) {
	const idx = new Map(tiles.map((t, i) => [t, i]));
	const plan = planHeights(tiles, frame, yaw, (t) => ({
		layer: idx.get(t),
		big: t.size > 256,
	}));
	const ref = reliefHeights(tiles, frame, yaw);
	const sameExtent =
		ref.extent.every((v, i) => v === plan.extent[i]) && ref.px === plan.px;
	const cpu = rasterizeHeights(tiles, frame, plan.extent, plan.res, HOLE);
	const emu = emulateReliefHeights(
		plan,
		(r) => tiles[plan.copies[r].layer].heights,
	);
	let maxd = 0;
	let holes = 0;
	let hole1 = 0;
	let n = 0;
	let over = 0; // |dh| > 0.01 m
	let flips = 0; // |dh| > 0.5 m: the f32 test picked the neighbouring tile on a tile edge
	let maxFine = 0; // max |dh| of the rest
	for (let q = 0; q < cpu.length; q++) {
		const a = cpu[q];
		const b = emu[q];
		if (a === HOLE) holes++;
		if ((a === HOLE) !== (b === HOLE)) hole1++;
		else if (a !== HOLE) {
			n++;
			const d = Math.abs(a - b);
			maxd = Math.max(maxd, d);
			if (d > 0.5) flips++;
			else maxFine = Math.max(maxFine, d);
			if (d > 0.01) over++;
		}
	}
	const ok = sameExtent && maxFine < 0.05 && hole1 <= 8 && flips <= 64;
	if (!ok) bad++;
	console.log(
		`${ok ? "ok  " : "FAIL"} yaw ${yaw}: rows ${plan.nRows} units ${plan.units} extent ${sameExtent ? "same" : "DIFFERENT"}; ` +
			`texels ${n} compared, ${holes} holes, ${hole1} winner/hole mismatches; max |dh| ${maxd.toExponential(2)} m; ` +
			`${over} texels > 0.01 m, ${flips} tile-edge flips (> 0.5 m), max |dh| elsewhere ${maxFine.toExponential(2)} m`,
	);
}
console.log(bad ? "FAIL" : "PASS");
process.exit(bad ? 1 : 0);
