// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tafel check. Run: npx tsx src/components/gipfelbuch/tafel/tafel.check.ts
// The projector against solvedRows for the 12 photos, and the bake JSON sanity when the bakes exist.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectAzEl } from "./project";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DIR = resolve(ROOT, "public/demo/gipfelbuch");
const errors: string[] = [];
const err = (m: string) => errors.push(m);

const quantile = (v: number[], q: number) => {
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

let bakes = 0;
for (let n = 1; n <= 12; n++) {
	const id = `demo-${String(n).padStart(2, "0")}`;
	const file = resolve(DIR, `${id}.json`);
	if (!existsSync(file)) {
		err(`${id}: ${file} missing`);
		continue;
	}
	const d = readJson(file);
	const w = d.photo.width;
	const h = d.photo.height;
	if (d.solved.accepted) {
		const diffs: number[] = [];
		for (const p of d.horizon.profile) {
			const [x, y] = projectAzEl(d.solved, w, h, p.az, p.el);
			const col = Math.round(x - 0.5);
			const row = d.solvedRows[col];
			if (row == null || col < 0 || col >= w) continue;
			diffs.push(Math.abs(y - row));
		}
		const med = quantile(diffs, 0.5);
		const p90 = quantile(diffs, 0.9);
		console.log(
			`${id}: projector vs solvedRows n=${diffs.length} median ${med.toFixed(2)} px, p90 ${p90.toFixed(2)} px`,
		);
		if (!(diffs.length >= 10))
			err(`${id}: only ${diffs.length} comparable columns`);
		if (!(med < 0.5)) err(`${id}: median ${med.toFixed(2)} >= 0.5`);
		if (!(p90 < 3)) err(`${id}: p90 ${p90.toFixed(2)} >= 3`);
	} else console.log(`${id}: not accepted, projector not checked`);

	const bakeFile = resolve(DIR, `tafel/${id}.json`);
	if (!existsSync(bakeFile)) continue;
	bakes++;
	const b = readJson(bakeFile);
	const aspect = (b.photo.w * b.width) / (b.photo.h * b.height);
	const want = w / h;
	if (Math.abs(aspect / want - 1) > 0.01)
		err(`${id}: bake photo aspect ${aspect.toFixed(4)} vs ${want.toFixed(4)}`);
	if (!(b.minContrast >= 3)) err(`${id}: minContrast ${b.minContrast} < 3`);
	const [b0, b1] = b.band;
	if (!(b0 >= 0 && b1 <= h && b1 > b0))
		err(`${id}: band [${b0}, ${b1}] outside the photo (0..${h})`);
	const ref = d.solved.accepted ? d.solved : d.app;
	if (!ref) err(`${id}: no camera to compare`);
	else {
		const want = d.solved.accepted ? "solved" : "app";
		if (b.camera.source !== want)
			err(`${id}: camera source ${b.camera.source}, expected ${want}`);
		for (const k of ["yaw", "pitch", "roll"] as const)
			if (Math.abs(b.camera[k] - ref[k]) > 0.05)
				err(`${id}: camera.${k} ${b.camera[k]} vs ${ref[k]}`);
	}
	console.log(`${id}: bake ok (minContrast ${b.minContrast})`);
}

if (bakes === 0)
	console.log(
		"SKIP: no bake files in public/demo/gipfelbuch/tafel (bake lane not run)",
	);
if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log(
	`tafel ok: projector on 12 photos${bakes ? `, ${bakes} bakes` : ""}`,
);
