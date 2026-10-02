// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Tafel sheets check. Run: npx tsx src/components/gipfelbuch/tafel/sheets.check.ts
// All 16 sheets are present, the chapters cover every node exactly once, every ledger path resolves to
// the formatted number on all 12 photos, and value() and band() never throw or print NaN.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GIPFELBUCH_NODES } from "../../../lib/gipfelbuch/graph";
import {
	GIPFELBUCH_PHOTO_IDS,
	type GipfelbuchPhotoData,
	type GipfelbuchPhotoId,
} from "../viz/real";
import { CHAPTERS } from "./chapters";
import { SHEETS } from "./sheets";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const errors: string[] = [];
const err = (m: string) => errors.push(m);

const all: Partial<Record<GipfelbuchPhotoId, GipfelbuchPhotoData>> = {};
for (const id of GIPFELBUCH_PHOTO_IDS)
	all[id] = JSON.parse(
		readFileSync(resolve(ROOT, `public/demo/gipfelbuch/${id}.json`), "utf8"),
	);

// ---- coverage
const nodeIds = GIPFELBUCH_NODES.map((n) => n.id);
for (const id of nodeIds) {
	if (!SHEETS[id]) err(`${id}: missing from SHEETS`);
	const n = CHAPTERS.filter((c) => c.ids.includes(id)).length;
	if (n !== 1) err(`${id}: appears in ${n} chapters (want 1)`);
}
for (const id of Object.keys(SHEETS))
	if (!nodeIds.includes(id))
		err(`${id}: in SHEETS but not a GIPFELBUCH_NODES id`);
for (const c of CHAPTERS)
	for (const id of c.ids)
		if (!nodeIds.includes(id)) err(`chapter ${c.numeral}: unknown id ${id}`);
const NO_TAFEL = [
	"dem-source",
	"eye-rule",
	"terrain-snapping",
	"dem-anchoring",
	"step-inside",
];
for (const id of NO_TAFEL)
	if (SHEETS[id] && SHEETS[id].tafel !== null)
		err(`${id}: tafel should be null`);

const UNIT_SCALE: Record<string, number> = { "%": 100, km: 0.001 };
const read = (o: unknown, path: string): unknown => {
	let v = o;
	for (const k of path.split(".")) v = (v as Record<string, unknown>)?.[k];
	return v;
};

let ledgerItems = 0;
let bands = 0;
for (const pid of GIPFELBUCH_PHOTO_IDS) {
	const d = all[pid] as GipfelbuchPhotoData;
	for (const id of nodeIds) {
		const sheet = SHEETS[id];
		if (!sheet) continue;
		const where = `${id}/${pid}`;
		try {
			// ledger
			const items = sheet.ledger(d);
			if (items.length !== 3)
				err(`${where}: ledger has ${items.length} items (want 3)`);
			for (const it of items) {
				ledgerItems++;
				const raw = read(d, it.path);
				if (typeof raw !== "number" || !Number.isFinite(raw)) {
					err(
						`${where}: ledger path ${it.path} is not a number (${String(raw)})`,
					);
					continue;
				}
				const shown = Number.parseFloat(it.value);
				if (!Number.isFinite(shown)) {
					err(`${where}: ledger value "${it.value}" is not numeric`);
					continue;
				}
				const dec = it.value.split(".")[1]?.length ?? 0;
				const want = raw * (it.unit ? (UNIT_SCALE[it.unit] ?? 1) : 1);
				const tol = 0.5 * 10 ** -dec + 1e-9;
				// km-native fields (demPatch.halfKm) show as stored; metre fields show /1000.
				if (Math.abs(shown - want) > tol && Math.abs(shown - raw) > tol)
					err(
						`${where}: ${it.path} = ${raw}, shown "${it.value}${it.unit ?? ""}"`,
					);
				if (shown === 0 && raw !== 0)
					err(
						`${where}: ${it.path} = ${raw} formats to zero ("${it.value}${it.unit ?? ""}")`,
					);
				if (it.unit === "km" && raw >= 1000 && Math.abs(shown - raw) <= tol)
					err(`${where}: ${it.path} = ${raw} m shown unconverted as km`);
				if (!it.label) err(`${where}: ledger item ${it.path} has no label`);
			}
			// value line
			const v = sheet.value(d);
			if (!v || /NaN|undefined/.test(v)) err(`${where}: value "${v}"`);
			// band and tafel layer render without NaN
			const band = renderToStaticMarkup(
				createElement(
					"svg",
					null,
					sheet.band({ d, all, w: 400, h: 150 }) as never,
				),
			);
			bands++;
			if (/NaN|undefined|Infinity/.test(band))
				err(`${where}: band has NaN/undefined`);
			if (sheet.tafel) {
				const layer = renderToStaticMarkup(
					createElement("svg", null, sheet.tafel({ d, s: 1.2 }) as never),
				);
				if (/NaN|undefined|Infinity/.test(layer))
					err(`${where}: tafel layer has NaN`);
			}
		} catch (e) {
			err(`${where}: threw ${(e as Error).message}`);
		}
	}
}

if (errors.length) {
	console.error(errors.slice(0, 60).join("\n"));
	console.error(`FAIL: ${errors.length} problem(s)`);
	process.exit(1);
}
console.log(
	`OK: ${nodeIds.length} sheets, ${CHAPTERS.length} chapters, ${ledgerItems} ledger items and ${bands} bands checked on ${GIPFELBUCH_PHOTO_IDS.length} photos`,
);
