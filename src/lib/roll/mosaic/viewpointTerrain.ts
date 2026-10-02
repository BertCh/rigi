// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Main-thread client for the viewpoint ridgelines (ridgelines.ts, in ridgelines.worker.ts). Tiles go
// through dem's fetchDemBytes (shared tile cache, missing-tile policy, 0 requests on a warm load); one
// worker runs at a time (each holds ~100 MB of mosaics), results are memoised per eye for the session.
// Cancellation: callers share one memo entry per eye; a queued trace whose callers all aborted is skipped
// when it reaches the head of the queue, a started one finishes (and stays memoised). No signal = permanent.
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
import type { RidgelinePeakInput, ViewpointTerrain } from "./ridgelines";
import type { RidgeWorkerIn, RidgeWorkerOut } from "./ridgelines.worker";
import { terrainKey } from "./terrainCodec";

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

/** One memo entry per terrainKey; `interest` counts callers still waiting (a caller without a signal never leaves). */
type MemoEntry = { promise: Promise<ViewpointTerrain>; interest: number };
const memo = new Map<string, MemoEntry>();
let queue: Promise<unknown> = Promise.resolve();

/** Terrain baked ahead of time, by terrainKey: null (or a failure) means trace it live. */
export type BakedTerrainLookup = (
	key: string,
) => Promise<ViewpointTerrain | null>;
let baked: BakedTerrainLookup | null = null;

/** Look viewpoints up here before tracing them (the sample trip ships its terrain, src/lib/demo). */
export function setBakedTerrain(lookup: BakedTerrainLookup) {
	baked = lookup;
}

const abortError = () => new DOMException("aborted", "AbortError");

export function viewpointTerrain(
	r: TerrainRequest,
	signal?: AbortSignal,
): Promise<ViewpointTerrain> {
	if (signal?.aborted) return Promise.reject(abortError());
	const key = terrainKey(r);
	let entry = memo.get(key);
	if (!entry) {
		const created: MemoEntry = {
			promise: undefined as unknown as Promise<ViewpointTerrain>,
			interest: 0,
		};
		const lookup = baked;
		created.promise = lookup
			? lookup(key)
					.catch(() => null)
					.then((t) => t ?? traced(r, created))
			: traced(r, created);
		memo.set(key, created);
		created.promise.catch(() => {
			if (memo.get(key) === created) memo.delete(key);
		});
		entry = created;
	}
	const shared = entry;
	if (!signal) {
		shared.interest++; // permanent
		return shared.promise;
	}
	shared.interest++;
	return new Promise<ViewpointTerrain>((resolve, reject) => {
		const onAbort = () => {
			shared.interest--;
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const done = () => signal.removeEventListener("abort", onAbort);
		shared.promise.then(
			(t) => {
				done();
				resolve(t);
			},
			(e) => {
				done();
				reject(e);
			},
		);
	});
}

/** One live trace at a time (each worker holds ~100 MB of mosaics). */
function traced(
	r: TerrainRequest,
	entry: MemoEntry,
): Promise<ViewpointTerrain> {
	const p = queue.then(() => {
		// every caller left while this waited its turn: don't fetch tiles or spawn a worker
		if (entry.interest <= 0) throw abortError();
		return run(r);
	});
	queue = p.catch(() => {});
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

async function regionPeaks(ids: string[]): Promise<RidgelinePeakInput[]> {
	const lists = await Promise.all(
		ids.map((id) =>
			loadRegion(id)
				.then((d) => (d?.peaks ?? []) as RidgelinePeakInput[])
				.catch(() => []),
		),
	);
	const byName = new Map<string, RidgelinePeakInput>();
	for (const p of lists.flat())
		if (p.name && Number.isFinite(p.ele))
			byName.set(`${p.name}@${p.lat.toFixed(3)}`, p);
	return [...byName.values()];
}
