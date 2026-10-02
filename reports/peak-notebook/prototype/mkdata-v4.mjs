// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Writes data-v4.js for sheet.html and index.html (the decision rig) from all 12 measured demo photos,
// the landing's demo-01 surround bake and the Gipfelbuch node list. Run from the repo root:
// npx tsx reports/peak-notebook/prototype/mkdata-v4.mjs
import fs from "node:fs";
import { GIPFELBUCH_NODES } from "../../../src/lib/gipfelbuch/graph";
const ROOT = new URL("../../../", import.meta.url).pathname;
const r1 = (v) => Math.round(v * 10) / 10;
const out = { photos: {} };
for (let i = 1; i <= 12; i++) {
	const id = `demo-${String(i).padStart(2, "0")}`;
	const d = JSON.parse(fs.readFileSync(`${ROOT}public/demo/gipfelbuch/${id}.json`));
	out.photos[id] = {
		w: d.photo.width, h: d.photo.height, takenAt: d.photo.takenAt, gps: d.gps, sensor: d.sensor,
		solved: d.solved, prior: d.prior, residual: d.residual, ms: d.ms,
		rows: d.skyline.rows.map(r1), weight: d.skyline.weight.map((v) => Math.round(v * 100) / 100),
		solvedRows: d.solvedRows.map(r1), priorRows: d.priorRows.map(r1),
		profile: d.horizon.profile.map((p) => ({ az: p.az, el: p.el, d: p.d, ridges: p.ridges })),
		peaks: d.peaks.filter((p) => p.visible && p.distance > 1500).map((p) => ({ name: p.name, ele: p.ele, az: p.az, el: p.el, distance: p.distance, labelled: p.labelled, solved: p.solved, prior: p.prior })),
		terrain: d.terrainProfile, dem: d.demPatch,
	};
}
out.surround = JSON.parse(fs.readFileSync(`${ROOT}src/components/site/surround/demo-01.json`));
out.nodes = GIPFELBUCH_NODES.map((n, i) => ({ i: i + 1, id: n.id, title: n.title, group: n.group, tagline: n.tagline, status: n.status }));
fs.writeFileSync(new URL("./data-v4.js", import.meta.url), `window.DATA=${JSON.stringify(out)};`);
console.log("wrote data-v4.js");
