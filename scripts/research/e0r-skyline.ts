// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * FUND E0r: unclipped 360 degree skyline per dev photo from the app's horizon-fast march
 * (Mapterhorn tiles), at the stated eye = max(GPS altitude, ground + 1.6 m).
 * Protocol: tools/research/fund/e0r_rotation/PROTOCOL.txt.
 *
 *   npx tsx scripts/research/e0r-skyline.ts [wc_0002 ...]
 *
 * Reads tools/bench/data/manifest.json (lat, lon, altitudeM) and the E0 dev id list
 * (tools/research/fund/e0_observability/results.json). Tiles come read-only from the main tree's
 * .cache/dem-mapterhorn (E0R_TILE_RO, default <repo>/.cache/dem-mapterhorn, then the checkout's
 * own) and anything missing is fetched into out/research/e0r/tiles.
 * Writes out/research/e0r/<id>.json: { id, lat, lon, altitudeM, ground, eyeH, step, elevation[3600] }.
 */
import fs from "node:fs";
import path from "node:path";
import { MAPTERHORN, type TileKey, tileId } from "../../src/lib/dem";
import {
	DEFAULT_RINGS,
	type TileSource,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import { horizonFromStore, prepare } from "../lib/horizon-fast/engine";
import { fileHeights, ROOT } from "../lib/node-io";

const EYE_ABOVE_GROUND = 1.6; // src/lib/geo/pipeline.ts
const STEP = 0.1;
const OUT = path.join(ROOT, "out", "research", "e0r");
const OWN_TILES = path.join(OUT, "tiles");
const RO_TILES = [
	process.env.E0R_TILE_RO ??
		"/Users/robertchristie/Documents/GitHub/mt-image/.cache/dem-mapterhorn",
	path.join(ROOT, ".cache", "dem-mapterhorn"),
];

async function loadTile(k: TileKey): Promise<Float32Array | null | undefined> {
	const rel = `${tileId(k)}.webp`;
	for (const dir of [...RO_TILES, OWN_TILES]) {
		const f = path.join(dir, rel);
		if (fs.existsSync(f)) return fileHeights(f, MAPTERHORN.tileSize);
	}
	const miss = path.join(OWN_TILES, `${rel}.404`);
	if (fs.existsSync(miss)) return null;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch(MAPTERHORN.url(k));
			if (res.status === 404 || res.status === 204) {
				fs.mkdirSync(path.dirname(miss), { recursive: true });
				fs.writeFileSync(miss, "");
				return null;
			}
			if (res.ok) {
				const f = path.join(OWN_TILES, rel);
				fs.mkdirSync(path.dirname(f), { recursive: true });
				fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
				return fileHeights(f, MAPTERHORN.tileSize);
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
	}
	return undefined;
}

const source: TileSource = {
	tileSize: MAPTERHORN.tileSize,
	maxZoom: MAPTERHORN.maxZoom,
	load: loadTile,
};

interface ManifestPhoto {
	id: string;
	lat: number;
	lon: number;
	altitudeM?: number | null;
}

async function main() {
	const manifest: ManifestPhoto[] = JSON.parse(
		fs.readFileSync(path.join(ROOT, "tools/bench/data/manifest.json"), "utf8"),
	);
	const e0 = JSON.parse(
		fs.readFileSync(
			path.join(ROOT, "tools/research/fund/e0_observability/results.json"),
			"utf8",
		),
	);
	const devIds: string[] = e0.per_photo.map((r: { pid: string }) => r.pid);
	const ids = process.argv.length > 2 ? process.argv.slice(2) : devIds;
	fs.mkdirSync(OUT, { recursive: true });
	const store = new TileStore(source);
	for (const id of ids) {
		if (!devIds.includes(id)) throw new Error(`${id} is not an E0 dev id`);
		const p = manifest.find((m) => m.id === id);
		if (!p) throw new Error(`${id} not in manifest`);
		const prov = await prepare(store, { lat: p.lat, lon: p.lon, h: 0 });
		const ground = store.heightAt(p.lon, p.lat, prov.spans[0].z);
		const groundEye = ground + EYE_ABOVE_GROUND;
		const eyeH =
			p.altitudeM == null ? groundEye : Math.max(p.altitudeM, groundEye);
		const prof = await horizonFromStore(
			store,
			{ lat: p.lat, lon: p.lon, h: eyeH },
			{ step: STEP, noRidges: true, rings: DEFAULT_RINGS },
		);
		const rec = {
			id,
			lat: p.lat,
			lon: p.lon,
			altitudeM: p.altitudeM ?? null,
			ground,
			eyeH,
			step: STEP,
			elevation: Array.from(prof.elevation, (v) => Math.round(v * 1e4) / 1e4),
		};
		fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(rec));
		console.log(
			id,
			`ground ${ground.toFixed(1)} eye ${eyeH.toFixed(3)} el[min,max] ${Math.min(...rec.elevation).toFixed(2)} ${Math.max(...rec.elevation).toFixed(2)} ${(prof.timings.totalMs / 1000).toFixed(1)}s`,
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
