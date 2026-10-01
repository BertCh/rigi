// Main-thread client for the viewpoint ridgelines (ridgelines.ts, in ridgelines.worker.ts). Tiles go
// through dem's fetchDemBytes (shared tile cache, missing-tile policy, 0 requests on a warm load); one
// worker runs at a time (each holds ~100 MB of mosaics), results are memoised per eye for the session.
import { tilePriority } from "#/lib/cache";
import { fetchDemBytes, MAPTERHORN, tileId } from "#/lib/dem";
import { realmGpuOptions } from "#/lib/gpu/core/realm";
import {
	LITE_RINGS,
	mosaicTileKeys,
	resolveRings,
} from "#/lib/horizon-fast/mosaic";
import { loadRegion } from "#/lib/photos";
import type { Roll, Viewpoint } from "../types";
import type { PeakInput, ViewpointTerrain } from "./ridgelines";
import type { RidgeWorkerIn, RidgeWorkerOut } from "./ridgelines.worker";

/** Far enough for the big ranges, near enough to keep the full-circle mosaics ~100 MB. */
const MAX_DISTANCE = 120_000;

export type TerrainRequest = {
	lat: number;
	lon: number;
	eyeAlt: number | null;
	/** Region ids whose OSM peaks may be labelled. */
	regions: string[];
	/** Trace the ridges on the GPU in the worker (falls back to the CPU); default on, false forces the CPU. */
	gpu?: boolean;
};

/** The eye a viewpoint's photos share: its centroid, at the median known eye altitude. */
export function viewpointEye(roll: Roll, vp: Viewpoint): TerrainRequest {
	const ids = new Set(vp.photoIds);
	const photos = roll.photos.filter((p) => ids.has(p.meta.id));
	const alts = photos
		.map((p) => p.eyeAlt)
		.filter((a): a is number => a != null)
		.sort((a, b) => a - b);
	return {
		lat: vp.lat,
		lon: vp.lon,
		eyeAlt: alts.length ? alts[alts.length >> 1] : null,
		regions: [...new Set(photos.map((p) => p.meta.region).filter(Boolean))],
	};
}

/** A worker's ridge kernel failed for good (not a device loss): later viewpoints trace on the CPU. */
let gpuBroken = false;

const memo = new Map<string, Promise<ViewpointTerrain>>();
let queue: Promise<unknown> = Promise.resolve();

export function viewpointTerrain(r: TerrainRequest): Promise<ViewpointTerrain> {
	const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)},${r.eyeAlt?.toFixed(1) ?? "dem"}`;
	let p = memo.get(key);
	if (!p) {
		p = queue.then(() => run(r));
		queue = p.catch(() => {});
		memo.set(key, p);
		p.catch(() => memo.delete(key));
	}
	return p;
}

async function run(r: TerrainRequest): Promise<ViewpointTerrain> {
	const [spans, peaks] = await Promise.all([
		resolveRings(LITE_RINGS, r.lat, r.lon, MAX_DISTANCE),
		regionPeaks(r.regions),
	]);
	const seen = new Set<string>();
	const keys = spans.flatMap((s) =>
		mosaicTileKeys(r.lat, r.lon, [s], MAPTERHORN.tileSize)
			.filter((k) => !seen.has(tileId(k)) && !!seen.add(tileId(k)))
			.map((key) => ({ key, near: s.minDistance })),
	);
	const tiles = await Promise.all(
		keys.map(async ({ key, near }) => {
			// behind the photo textures and the map's terrain in the shared queue
			const got = await fetchDemBytes(key, {
				priority: tilePriority(near, key.z) + 1,
			});
			return { key, source: got?.source ?? null, buf: got?.buf ?? null };
		}),
	);
	const worker = new Worker(
		new URL("./ridgelines.worker.ts", import.meta.url),
		{
			type: "module",
		},
	);
	const gpu = (r.gpu ?? true) && !gpuBroken;
	try {
		return await new Promise<ViewpointTerrain>((resolve, reject) => {
			worker.onmessage = (e: MessageEvent<RidgeWorkerOut>) => {
				if (e.data.type !== "done") return reject(new Error(e.data.error));
				// a kernel/pipeline failure is per device, not per viewpoint: later workers go straight to the CPU
				if (e.data.gpuFailed) gpuBroken = true;
				resolve(e.data.terrain);
			};
			worker.onerror = (e) =>
				reject(new Error(`ridgelines worker: ${e.message}`));
			worker.postMessage(
				{
					lat: r.lat,
					lon: r.lon,
					eyeAlt: r.eyeAlt,
					spans,
					tiles,
					peaks,
					gpu,
					gpuOpts: gpu ? realmGpuOptions() : undefined,
				} satisfies RidgeWorkerIn,
				tiles.flatMap((t) => (t.buf ? [t.buf] : [])),
			);
		});
	} finally {
		worker.terminate();
	}
}

async function regionPeaks(ids: string[]): Promise<PeakInput[]> {
	const lists = await Promise.all(
		ids.map((id) =>
			loadRegion(id)
				.then((d) => (d?.peaks ?? []) as PeakInput[])
				.catch(() => []),
		),
	);
	const byName = new Map<string, PeakInput>();
	for (const p of lists.flat())
		if (p.name && Number.isFinite(p.ele))
			byName.set(`${p.name}@${p.lat.toFixed(3)}`, p);
	return [...byName.values()];
}
