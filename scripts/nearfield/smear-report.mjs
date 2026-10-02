#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Summarise tools/nearfield/smear/grid-<renderer>-<id>.json against the blind labels (labels.json).
// See smear-measure.mjs for the smear definition. No browser.
//   node scripts/nearfield/smear-report.mjs [--renderer=deck] [--band=0.02]
// Writes tools/nearfield/smear/summary-<renderer>.json and prints a table.
import {
	existsSync as _ex,
	readFileSync as _rd,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

// grids are stored gzipped (grid-*.json.gz); smear-measure writes plain .json, read as well
const readGrid = (f) =>
	_ex(f)
		? JSON.parse(_rd(f, "utf8"))
		: JSON.parse(gunzipSync(_rd(`${f}.gz`)).toString("utf8"));
const gridExists = (f) => _ex(f) || _ex(`${f}.gz`);

const ROOT = resolve(import.meta.dirname, "../..");
const DIR = join(ROOT, "tools/nearfield/smear");
const arg = (k, d) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const renderer = arg("renderer", "deck");
const BAND = Number(arg("band", "0.02")); // label-edge band excluded from collateral (fraction of width)
const labels = JSON.parse(readFileSync(join(DIR, "labels.json"), "utf8"));
const CLASSES = [
	"person",
	"building",
	"tree",
	"pole",
	"structure",
	"vehicle",
	"animal",
	"rock",
];

const inPoly = (poly, x, y) => {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
};
const inShape = (l, x, y) =>
	l.box
		? x >= l.box[0] && x <= l.box[2] && y >= l.box[1] && y <= l.box[3]
		: inPoly(l.poly, x, y);
const bbox = (l) => {
	if (l.box) return l.box;
	const xs = l.poly.map((p) => p[0]);
	const ys = l.poly.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

const zero = () => ({
	lab: 0, // labelled cells
	sky: 0, // no terrain behind (range 0): never draped
	nearCut: 0, // terrain behind within minProjectRange: never draped
	smearOff: 0,
	smearOnProduct: 0, // quality gate respected: a gated photo shows nothing, so on == off
	smearOnForced: 0, // the split's mask applied even below the gate
	obj: 0, // split says Object at this cell
	v300: 0, // smear left with the diagnostic nearRadius=300 rebuild (forced)
	v500: 0,
	vN: 0, // smearOff counted only on photos that carry the variants
});
const add = (a, b) => {
	for (const k of Object.keys(a)) a[k] += b[k];
};
const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "  -  ");
const removal = (s, key) =>
	s.smearOff ? (s.smearOff - s[key]) / s.smearOff : Number.NaN;

const vr = (s) =>
	s.vN
		? `${pct((s.vN - s.v300) / s.vN)} / ${pct((s.vN - s.v500) / s.vN)}`
		: "-";
const perPhoto = {};
const pooled = { sure: {}, all: {} };
for (const c of CLASSES) {
	pooled.sure[c] = zero();
	pooled.all[c] = zero();
}
const coll = {
	product: { draped: 0, removed: 0, removedBand: 0, drapedBand: 0 },
	forced: { draped: 0, removed: 0, removedBand: 0, drapedBand: 0 },
};
for (const [id, list] of Object.entries(labels.photos)) {
	const f = join(DIR, `grid-${renderer}-${id}.json`);
	if (!gridExists(f)) continue;
	const g = readGrid(f);
	if (g.error) {
		perPhoto[id] = { error: g.error };
		continue;
	}
	const { GW, GH, range, off, on, cls, minRange } = g;
	const gated = !g.hasScene || g.forced;
	const pp = { quality: g.quality, gated, sure: {}, all: {} };
	for (const c of CLASSES) {
		pp.sure[c] = zero();
		pp.all[c] = zero();
	}
	const boxes = list.map(bbox);
	for (let j = 0; j < GH; j++)
		for (let i = 0; i < GW; i++) {
			const k = j * GW + i;
			const x = (i + 0.5) / GW;
			const y = (j + 0.5) / GH;
			// person wins overlaps, then the first listed label
			let hit = null;
			for (let t = 0; t < list.length; t++) {
				const l = list[t];
				const b = boxes[t];
				if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
				if (!inShape(l, x, y)) continue;
				if (!hit || (l.cls === "person" && hit.cls !== "person")) hit = l;
			}
			const draped = range[k] > minRange;
			const sOff = draped && !off[k];
			const sForced = draped && !on[k];
			const sProd = gated ? sOff : sForced;
			if (hit) {
				const s = {
					lab: 1,
					sky: range[k] > 0 ? 0 : 1,
					nearCut: range[k] > 0 && !draped ? 1 : 0,
					smearOff: sOff ? 1 : 0,
					smearOnProduct: sProd ? 1 : 0,
					smearOnForced: sForced ? 1 : 0,
					obj: cls[k] === 2 ? 1 : 0,
					v300: g.variants?.[300] && draped && !g.variants[300].on[k] ? 1 : 0,
					v500: g.variants?.[500] && draped && !g.variants[500].on[k] ? 1 : 0,
					vN: g.variants?.[300] && sOff ? 1 : 0,
				};
				add(pp.all[hit.cls], s);
				if (!hit.unsure) add(pp.sure[hit.cls], s);
				continue;
			}
			// unlabelled: collateral = draped with the feature off, masked with it on
			let nearLabel = false;
			for (const b of boxes)
				if (
					x > b[0] - BAND &&
					x < b[2] + BAND &&
					y > b[1] - BAND * (GW / GH) &&
					y < b[3] + BAND * (GW / GH)
				) {
					nearLabel = true;
					break;
				}
			if (!sOff) continue;
			for (const R of [300, 500]) {
				const vv = g.variants?.[R];
				if (!vv) continue;
				coll[`v${R}`] ??= {
					draped: 0,
					removed: 0,
					removedBand: 0,
					drapedBand: 0,
				};
				const c = coll[`v${R}`];
				if (nearLabel) {
					c.drapedBand++;
					if (vv.on[k]) c.removedBand++;
				} else {
					c.draped++;
					if (vv.on[k]) c.removed++;
				}
			}
			for (const [key, removed] of [
				["product", !sProd],
				["forced", !sForced],
			]) {
				const c = coll[key];
				pp.coll ??= {
					product: { draped: 0, removed: 0, removedBand: 0, drapedBand: 0 },
					forced: { draped: 0, removed: 0, removedBand: 0, drapedBand: 0 },
				};
				const cc = pp.coll[key];
				if (nearLabel) {
					c.drapedBand++;
					cc.drapedBand++;
					if (removed) {
						c.removedBand++;
						cc.removedBand++;
					}
				} else {
					c.draped++;
					cc.draped++;
					if (removed) {
						c.removed++;
						cc.removed++;
					}
				}
			}
		}
	for (const c of CLASSES) {
		add(pooled.sure[c], pp.sure[c]);
		add(pooled.all[c], pp.all[c]);
	}
	perPhoto[id] = pp;
}

const lines = [];
const P = (s) => lines.push(s);
P(
	`renderer=${renderer}  (cells of a 320-wide grid; smear = labelled cell draped onto terrain)`,
);
for (const which of ["sure", "all"]) {
	P(
		`\nPOOLED, ${which === "sure" ? "confident labels only" : "all labels incl. unsure"}`,
	);
	P(
		"class      labelled  noTerrain nearCut  smearOff  smearOn(prod) removal(prod)  smearOn(forced) removal(forced)  splitObject  | diag removal nearRadius 300 / 500",
	);
	const tot = zero();
	const nonPerson = zero();
	for (const c of CLASSES) {
		const s = pooled[which][c];
		if (!s.lab) continue;
		add(tot, s);
		if (c !== "person") add(nonPerson, s);
		P(
			`${c.padEnd(10)} ${String(s.lab).padStart(8)} ${String(s.sky).padStart(9)} ${String(s.nearCut).padStart(7)} ${String(s.smearOff).padStart(9)} ${String(s.smearOnProduct).padStart(13)} ${pct(removal(s, "smearOnProduct")).padStart(13)} ${String(s.smearOnForced).padStart(16)} ${pct(removal(s, "smearOnForced")).padStart(15)} ${pct(s.obj / s.lab).padStart(12)}  | ${vr(s)}`,
		);
	}
	for (const [n, s] of [
		["non-person", nonPerson],
		["ALL", tot],
	])
		P(
			`${n.padEnd(10)} ${String(s.lab).padStart(8)} ${String(s.sky).padStart(9)} ${String(s.nearCut).padStart(7)} ${String(s.smearOff).padStart(9)} ${String(s.smearOnProduct).padStart(13)} ${pct(removal(s, "smearOnProduct")).padStart(13)} ${String(s.smearOnForced).padStart(16)} ${pct(removal(s, "smearOnForced")).padStart(15)} ${pct(s.obj / s.lab).padStart(12)}  | ${vr(s)}`,
		);
}
P(
	"\nCOLLATERAL (unlabelled cells draped with the feature off but masked with it on)",
);
for (const key of ["product", "forced", "v300", "v500"]) {
	const c = coll[key];
	if (!c) continue;
	P(
		`${key.padEnd(8)} away from labels: ${c.removed}/${c.draped} = ${pct(c.removed / c.draped)}   within ${BAND} of a label box: ${c.removedBand}/${c.drapedBand} = ${pct(c.removedBand / c.drapedBand)}`,
	);
}
P(
	"\nPER PHOTO (confident labels; smearOff -> smearOn forced, removal; collateral forced away-from-labels)",
);
for (const [id, pp] of Object.entries(perPhoto)) {
	if (pp.error) {
		P(`${id} ERROR ${pp.error.slice(0, 100)}`);
		continue;
	}
	const parts = [];
	for (const c of CLASSES) {
		const s = pp.sure[c];
		if (!s.lab) continue;
		parts.push(
			`${c} ${s.smearOff}->${s.smearOnForced} (${pct(removal(s, "smearOnForced"))})`,
		);
	}
	const cc = pp.coll?.forced;
	P(
		`${id} q=${pp.quality == null ? "none" : pp.quality.toFixed(2)}${pp.gated ? " GATED" : ""} | ${parts.join("; ")} | collateral ${cc ? `${cc.removed}/${cc.draped} ${pct(cc.removed / cc.draped)}` : "0"}`,
	);
}
const text = lines.join("\n");
console.log(text);
writeFileSync(
	join(DIR, `summary-${renderer}.json`),
	JSON.stringify(
		{ renderer, band: BAND, pooled, collateral: coll, perPhoto },
		null,
		1,
	),
);
writeFileSync(join(DIR, `summary-${renderer}.txt`), `${text}\n`);
