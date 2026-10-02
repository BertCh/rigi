// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Eye-rule data for /gipfelbuch/eye-rule: runs the real altitude-contour prior (src/lib/concord/priors/altitude.ts
 * eyePriorFromExif) on the 12 bundled Niederhorn fixes, against two DEMs (Terrarium z13 near the fix, and
 * Mapterhorn z15 when its tiles are reachable). Output: public/demo/gipfelbuch/eye-rule/eye-rule.json
 *
 *   npx tsx scripts/gipfelbuch/data-eye-rule.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
	EYE_PRIOR_DEFAULTS,
	eyePriorFromExif,
	floorEye,
} from "../../src/lib/concord/priors/altitude";
import { groundFromHeightAt } from "../../src/lib/concord/priors/ground";
import { DEM_SOURCES } from "../../src/lib/dem";
import { loadTerrain } from "../../src/lib/geo/terrain";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

const manifest = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public/demo/manifest.json"), "utf8"),
) as {
	photos: {
		id: string;
		lat: number;
		lon: number;
		alt: number;
		hAccuracy: number;
	}[];
};
const r1 = (v: number) => Math.round(v * 10) / 10;

async function run(name: "terrarium" | "mapterhorn") {
	const src = DEM_SOURCES[name];
	const load = demTileLoaderNode(src);
	const rows = [];
	for (const p of manifest.photos) {
		const terrain = await loadTerrain(
			p.lat,
			p.lon,
			load,
			src.levels,
			new Map(),
			16,
			src.tileSize,
		);
		const ground = groundFromHeightAt(p.lat, p.lon, (la, lo) =>
			terrain.ground(lo, la),
		);
		const g0 = ground(0, 0);
		if (!Number.isFinite(g0)) throw new Error(`${name}: no DEM at ${p.id}`);
		const prior = eyePriorFromExif(
			{ lat: p.lat, lon: p.lon, alt: p.alt, hAcc: p.hAccuracy },
			ground,
		);
		const floor = floorEye(p.alt, g0);
		rows.push({
			id: p.id,
			alt: p.alt,
			hAcc: p.hAccuracy,
			ground: r1(g0),
			floorEye: r1(floor),
			source: prior.source,
			bandFrac: Math.round(prior.bandFrac * 1000) / 1000,
			mapEye: prior.mapEye ? r1(prior.mapEye[2]) : null,
			mapShiftM: prior.mapEye
				? r1(Math.hypot(prior.mapEye[0], prior.mapEye[1]))
				: null,
			reason: prior.reason,
		});
	}
	return rows;
}

const out: Record<string, unknown> = {
	generated: new Date().toISOString().slice(0, 10),
	script: "scripts/gipfelbuch/data-eye-rule.ts",
	defaults: EYE_PRIOR_DEFAULTS,
	terrarium: await run("terrarium"),
	mapterhorn: null,
};
try {
	out.mapterhorn = await run("mapterhorn");
} catch (e) {
	console.warn("mapterhorn unavailable:", String(e));
}
fs.writeFileSync(
	path.join(ROOT, "public/demo/gipfelbuch/eye-rule/eye-rule.json"),
	JSON.stringify(out),
);
console.table(out.terrarium);
console.table(out.mapterhorn);
