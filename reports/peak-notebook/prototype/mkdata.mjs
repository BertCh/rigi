// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Writes data.js for the peak-notebook prototype from the measured Gipfelbuch data and the
// landing's demo-01 surround bake. Run from the repo root: node reports/peak-notebook/prototype/mkdata.mjs
import fs from "node:fs";
const ROOT = new URL("../../../", import.meta.url).pathname;
const out = {};
for (const id of ["demo-01", "demo-04", "demo-07", "demo-09", "demo-11", "demo-12"]) { // v3 page (v3.html)
	const d = JSON.parse(fs.readFileSync(`${ROOT}public/demo/gipfelbuch/${id}.json`));
	out[id] = {
		photo: d.photo, solved: d.solved, prior: d.prior, gps: d.gps, sensor: d.sensor,
		skyline: d.skyline, solvedRows: d.solvedRows, priorRows: d.priorRows, residual: d.residual, ms: d.ms,
		profile: d.horizon.profile, terrainProfile: d.terrainProfile,
		peaks: d.peaks.filter((p) => p.visible).map((p) => ({ name: p.name, ele: p.ele, az: p.az, el: p.el, distance: p.distance, labelled: p.labelled, solved: p.solved })),
	};
}
out.surround = JSON.parse(fs.readFileSync(`${ROOT}src/components/site/surround/demo-01.json`));
fs.writeFileSync(new URL("./data.js", import.meta.url), `window.DATA=${JSON.stringify(out)};`);
console.log("wrote data.js");
