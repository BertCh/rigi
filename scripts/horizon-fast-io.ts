/**
 * Node-only DEM source for src/lib/horizon-fast: Mapterhorn 512 px WebP
 * Terrarium tiles with a disk cache (HF_TILE_CACHE; default: this session's
 * scratchpad, since .cache/ belongs to the baseline owner).
 */
import fs from "node:fs";
import path from "node:path";
import { MAPTERHORN, type TileKey, tileId } from "../src/lib/dem";
import type { TileSource } from "../src/lib/horizon-fast/mosaic";
import { fileHeights } from "./lib/node-io";

export const HF_OUT =
	process.env.HF_OUT ??
	"/private/tmp/claude-501/-Users-robertchristie-Documents-GitHub-mt-image/a1611531-32b0-4db2-a884-e5bbc3808e2d/scratchpad/horizon-fast";
export const MAPTERHORN_CACHE =
	process.env.HF_TILE_CACHE ?? path.join(HF_OUT, "tiles");

async function fetchTile(k: TileKey, force: boolean) {
	const file = path.join(MAPTERHORN_CACHE, `${tileId(k)}.webp`);
	const missing = `${file}.404`;
	if (!force && fs.existsSync(missing)) return null;
	if (force || !fs.existsSync(file)) {
		let res: Response | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				res = await fetch(MAPTERHORN.url(k));
				if (res.ok || res.status === 404) break;
			} catch {
				res = undefined;
			}
			await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
		}
		if (!res) return undefined;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		if (res.status === 404 || res.status === 204) {
			fs.writeFileSync(missing, "");
			return null;
		}
		if (!res.ok) return undefined;
		fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	}
	try {
		return await fileHeights(file, MAPTERHORN.tileSize);
	} catch (e) {
		// Truncated / non-image body: drop it and refetch once.
		fs.rmSync(file, { force: true });
		if (force) throw e;
		return fetchTile(k, true);
	}
}

export const mapterhornNode: TileSource = {
	tileSize: MAPTERHORN.tileSize,
	maxZoom: MAPTERHORN.maxZoom,
	load: (k) => fetchTile(k, false),
	reload: (k) => fetchTile(k, true),
};
