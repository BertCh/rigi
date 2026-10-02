// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// View-driven DEM streaming for the deck.gl path. The high-detail wedge follows the live view
// heading/FOV: each re-selection queues the missing tiles (near + in-view first, a small
// concurrency cap), drops queued tiles that went stale, and until a tile's mesh arrives it is
// stood in for by already-loaded geometry (its old-resolution mesh, a loaded parent, or a full
// set of loaded children), so the surface never has holes while refining or coarsening.

import { tilePriority } from "../cache";
import {
	type DemLoadOptions,
	type DemRaster,
	downsampleHeights2,
	loadDemTile,
	parentKey,
	type TileKey,
	tileId,
} from "../dem";
import type { EnuFrame } from "../geodesy";
import {
	buildLiteMesh,
	meshTriangles,
	type StreamRaster,
} from "./batched-terrain-grid";
import {
	segmentsFor,
	selectDemTiles,
	TerrainSet,
	type TileChoice,
	type TileMesh,
	type ViewWedge,
} from "./terrain-data";

export type StreamOptions = {
	radiusM?: number;
	maxZoom?: number;
	minZoom?: number;
	/** Split while distance < lod × tile size inside the wedge. */
	lod?: number;
	/** Split factor outside the wedge (context for the 3D orbit view). */
	lodOutside?: number;
	/** Max concurrent tile loads. */
	concurrency?: number;
	/** Meshes kept beyond the rendered set (LRU-ish cache for panning back). */
	spareMeshes?: number;
	/**
	 * Of those spare meshes, how many keep their GPU-resident heights (`gpuLayer`, flag
	 * terrainGpuDecode), most recently used first; the rest let go of their layer and, when drawn
	 * again, decode their bitmap into a new one. Bounds the height atlas to the drawn tiles + this.
	 */
	spareGpuLayers?: number;
	/**
	 * Coarse-first loading (off when unset): the first selection is preceded by the same
	 * selection capped at this zoom (the classic cap is 14), queued ahead of the finer
	 * tiles and handed to `onPreview` once complete. The full set and its first `onUpdate` are
	 * unchanged; they arrive after it.
	 */
	previewMaxZoom?: number;
	/**
	 * Loads one tile at the size its `seg`-segment mesh uses (default: defaultStreamTile =
	 * loadDemTile + the 2× downsamples). The WebGPU engine's GPU decode loader returns lazy
	 * rasters (no CPU heights; deck-webgpu/terrain-gpu-decode.ts). Null = no data / aborted.
	 */
	loadTile?: StreamTileLoader;
	/** The coarse-first set (at most once, before the first `onUpdate`; see previewMaxZoom). */
	onPreview?: (set: TerrainSet) => void;
	/** New render set (throttled). Not called until the first selection has fully loaded. */
	onUpdate: (set: TerrainSet) => void;
	onProgress?: (done: number, total: number) => void;
};

/** One tile of `seg` mesh segments, loaded and sized for its mesh (StreamOptions.loadTile). */
export type StreamTileLoader = (
	key: TileKey,
	seg: number,
	o: DemLoadOptions,
) => Promise<StreamRaster | null>;

/** The CPU path: loadDemTile, then halved while it has > 2 samples per segment and > 256 px. */
export async function defaultStreamTile(
	key: TileKey,
	seg: number,
	o: DemLoadOptions,
): Promise<DemRaster | null> {
	const dem = await loadDemTile(key, o);
	return dem && fitStreamTile(dem, seg);
}

/** A loaded raster sized for a `seg`-segment mesh (the streamer's 2× downsamples). */
export function fitStreamTile(dem: DemRaster, seg: number): DemRaster {
	let r = dem;
	while (r.size > 2 * seg && r.size > 256) r = downsample2(r);
	return r;
}

type Want = TileChoice & { id: string; seg: number };

/**
 * Loads of one tile (at one resolution) that may come back empty (null: a fetch that failed through
 * the whole ancestor fallback, a decode error, a mesh build that threw) before the streamer gives up
 * on it for this selection. A given-up tile no longer counts as pending, so the set completes with a
 * stand-in (its old resolution, loaded children or a parent) instead of waiting forever: one failed
 * tile used to keep `pending` above 0 for good, and loadFullTerrain (which waits for pending 0) ran
 * into its 300 s timeout. A new selection (setWedge) tries given-up tiles again.
 */
export const TILE_LOAD_ATTEMPTS = 3;
/** Backoff before retry n (1-based) of a failed tile load: n × this. */
export const TILE_RETRY_MS = 400;

const childrenOf = (k: TileKey): TileKey[] => [
	{ z: k.z + 1, x: k.x * 2, y: k.y * 2 },
	{ z: k.z + 1, x: k.x * 2 + 1, y: k.y * 2 },
	{ z: k.z + 1, x: k.x * 2, y: k.y * 2 + 1 },
	{ z: k.z + 1, x: k.x * 2 + 1, y: k.y * 2 + 1 },
];
const isAncestor = (a: TileKey, d: TileKey) =>
	a.z < d.z && d.x >> (d.z - a.z) === a.x && d.y >> (d.z - a.z) === a.y;

export class TerrainStreamer {
	readonly frame: EnuFrame;
	private o: Required<
		Omit<
			StreamOptions,
			"onProgress" | "onPreview" | "previewMaxZoom" | "loadTile"
		>
	> &
		Pick<
			StreamOptions,
			"onProgress" | "onPreview" | "previewMaxZoom" | "loadTile"
		>;
	/** One mesh per tile id (replaced when the wanted resolution changes). */
	private meshes = new Map<string, TileMesh>();
	private lastUsed = new Map<string, number>();
	private want: Want[] = [];
	private wantById = new Map<string, Want>();
	private queue: Want[] = [];
	/** Coarse-first selection still to be handed to onPreview (null = none pending). */
	private preview: Want[] | null = null;
	private previewById = new Map<string, Want>();
	/** ms from the first setWedge to the preview set (-1 = not emitted). */
	private previewMs = -1;
	/** Failed loads per tile at a resolution (`id:seg`) in this selection (TILE_LOAD_ATTEMPTS). */
	private failures = new Map<string, number>();
	/** Tiles given up on for this selection (`id:seg`): not pending, stood in for. */
	private gaveUp = new Set<string>();
	/** In-flight loads, abortable when they go stale. */
	private loading = new Map<string, { seg: number; ac: AbortController }>();
	private wedge?: ViewWedge;
	private generation = 0;
	private genStart = 0;
	private genTotal = 0;
	/** ms from the view change to this generation fully loaded (-1 while loading). */
	private genDoneMs = -1;
	private ready = false;
	private disposed = false;
	private emitTimer: ReturnType<typeof setTimeout> | null = null;
	private tick = 0;
	/** Main-thread ms spent in buildMesh / buildBatchGrid. */
	private buildMs = 0;

	constructor(frame: EnuFrame, options: StreamOptions) {
		this.frame = frame;
		this.o = {
			radiusM: 120_000,
			maxZoom: 17,
			minZoom: 7,
			lod: 2,
			lodOutside: 0.6,
			concurrency: 10,
			spareMeshes: 150,
			spareGpuLayers: 48,
			...options,
		};
	}

	/**
	 * Re-select for a new view wedge. Cheap no-op if the wedge barely moved (or both are 360°): then
	 * it returns false and no new set is emitted for it.
	 */
	setWedge(wedge: ViewWedge): boolean {
		if (this.disposed) return false;
		const w = this.wedge;
		if (
			w &&
			((wedge.halfAngleDeg >= 180 && w.halfAngleDeg >= 180) ||
				(Math.abs(((wedge.headingDeg - w.headingDeg + 540) % 360) - 180) < 2 &&
					Math.abs(wedge.halfAngleDeg - w.halfAngleDeg) < 2))
		)
			return false;
		this.wedge = wedge;
		this.generation++;
		this.genStart = performance.now();
		this.genDoneMs = -1;
		this.failures.clear();
		this.gaveUp.clear();
		this.want = selectDemTiles(this.frame.lat, this.frame.lon, {
			...this.o,
			wedge,
		}).map((c) => ({ ...c, id: tileId(c.key), seg: segmentsFor(c) }));
		this.wantById = new Map(this.want.map((w) => [w.id, w]));
		// Cancel in-flight loads the new view no longer wants (or wants at another resolution);
		// the shared cache drops their network request once no other caller wants it.
		for (const [id, l] of this.loading) {
			const w = this.wantById.get(id) ?? this.previewById.get(id);
			if (!w || w.seg !== l.seg) {
				l.ac.abort();
				this.loading.delete(id); // free the slot; re-queued below if wanted at a new seg
			}
		}
		// Queue whatever isn't loaded at the wanted resolution; near + in-view first. Anything
		// queued for the previous wedge and not in this list is dropped (stale).
		const missing = (w: Want) =>
			this.meshes.get(w.id)?.seg !== w.seg && !this.loading.has(w.id);
		this.queue = this.want
			.filter(missing)
			.sort((a, b) => this.priority(a) - this.priority(b));
		this.genTotal = this.queue.length + this.loading.size;
		// Coarse-first (first selection only): the capped selection's tiles go ahead of the rest.
		// Most of them (the far field) are in the full selection too, at the same resolution.
		this.preview = null;
		this.previewById.clear();
		if (
			!this.ready &&
			this.generation === 1 &&
			this.o.previewMaxZoom != null &&
			this.o.previewMaxZoom < this.o.maxZoom &&
			this.o.onPreview
		) {
			const coarse = selectDemTiles(this.frame.lat, this.frame.lon, {
				...this.o,
				maxZoom: this.o.previewMaxZoom,
				wedge,
			}).map((c) => ({ ...c, id: tileId(c.key), seg: segmentsFor(c) }));
			this.preview = coarse;
			this.previewById = new Map(coarse.map((w) => [w.id, w]));
			const first = coarse
				.filter((w) => {
					const f = this.wantById.get(w.id);
					return missing(w) && (!f || f.seg === w.seg);
				})
				.sort((a, b) => this.priority(a) - this.priority(b));
			const ahead = new Set(first.map((w) => w.id));
			this.queue = [...first, ...this.queue.filter((w) => !ahead.has(w.id))];
		}
		this.pump();
		this.scheduleEmit(0);
		this.maybePreview();
		return true;
	}

	/** Load diagnostics of the coarse-first set: ms from the first view to it (-1 = none yet). */
	get previewLoadMs() {
		return this.previewMs;
	}

	dispose() {
		this.disposed = true;
		this.queue = [];
		for (const l of this.loading.values()) l.ac.abort();
		if (this.emitTimer) clearTimeout(this.emitTimer);
		for (const m of this.meshes.values()) m.gpuLayer?.release();
	}

	private priority(w: Want) {
		// metres, with out-of-view tiles pushed back 4×; finer tiles slightly before coarse
		// ones at equal distance so the near field sharpens first
		return (w.focus ? 1 : 4) * (w.distance + w.size * 0.25);
	}

	private pump() {
		while (
			!this.disposed &&
			this.loading.size < this.o.concurrency &&
			this.queue.length
		) {
			const w = this.queue.shift() as Want;
			const cur = this.wantById.get(w.id) ?? this.previewById.get(w.id);
			if (!cur || cur.seg !== w.seg) continue; // went stale
			if (this.meshes.get(w.id)?.seg === w.seg || this.loading.has(w.id))
				continue;
			const ac = new AbortController();
			this.loading.set(w.id, { seg: w.seg, ac });
			const gen = this.generation;
			this.load(w, ac.signal)
				.catch(() => false) // a mesh build that threw: a failed load
				.then((ok) => {
					if (!ok && !ac.signal.aborted && gen === this.generation)
						this.failed(w);
				})
				.finally(() => {
					if (this.loading.get(w.id)?.ac === ac) this.loading.delete(w.id);
					this.pump();
					this.maybePreview();
					this.scheduleEmit(this.queue.length || this.loading.size ? 150 : 0);
				});
		}
	}

	/** A load of `w` came back empty: retried after a backoff, or given up on (TILE_LOAD_ATTEMPTS). */
	private failed(w: Want) {
		const key = `${w.id}:${w.seg}`;
		const n = (this.failures.get(key) ?? 0) + 1;
		this.failures.set(key, n);
		if (n >= TILE_LOAD_ATTEMPTS) {
			this.gaveUp.add(key);
			console.warn(
				`[terrain-stream] tile ${w.id} (seg ${w.seg}) failed ${n}×, stood in for`,
			);
			return;
		}
		const gen = this.generation;
		setTimeout(() => {
			if (this.disposed || gen !== this.generation) return;
			const cur = this.wantById.get(w.id) ?? this.previewById.get(w.id);
			if (!cur || cur.seg !== w.seg) return;
			if (this.meshes.get(w.id)?.seg === w.seg || this.loading.has(w.id))
				return;
			this.queue.unshift(cur);
			this.pump();
		}, n * TILE_RETRY_MS);
	}

	/** Wanted tiles not loaded at their resolution and not given up on. */
	private pendingCount() {
		let n = 0;
		for (const w of this.want)
			if (
				this.meshes.get(w.id)?.seg !== w.seg &&
				!this.gaveUp.has(`${w.id}:${w.seg}`)
			)
				n++;
		return n;
	}

	/** true = the mesh is in; false = nothing loaded (aborted, disposed, or no data: see failed()). */
	private async load(w: Want, signal: AbortSignal): Promise<boolean> {
		const load: StreamTileLoader = this.o.loadTile ?? defaultStreamTile;
		const dem = await load(w.key, w.seg, {
			minZoom: this.o.minZoom - 2,
			priority: tilePriority(w.focus ? w.distance : w.distance * 4, w.key.z),
			signal,
		}).catch(() => null); // aborted (stale) or no data anywhere up the pyramid
		if (!dem || this.disposed || signal.aborted) {
			dem?.lazyHeights?.release?.();
			dem?.gpuLayer?.release();
			return false;
		}
		const t0 = performance.now();
		const mesh = buildLiteMesh(this.frame, dem, w.seg, w.distance, w.focus);
		this.buildMs += performance.now() - t0;
		// the replaced mesh (another seg) lets go of its GPU heights; a drawn copy holds its own reference
		this.meshes.get(w.id)?.gpuLayer?.release();
		this.meshes.set(w.id, mesh);
		return true;
	}

	/** Hands the coarse-first set to onPreview once every tile of it is loaded (once). */
	private maybePreview() {
		const p = this.preview;
		if (!p || this.disposed) return;
		if (this.ready) {
			this.preview = null; // the full set made it first
			return;
		}
		const tiles: TileMesh[] = [];
		for (const w of p) {
			// (a tile of both selections has one resolution; the full one's wins if they differ)
			const m = this.meshes.get(w.id);
			if (!m || (m.seg !== w.seg && m.seg !== this.wantById.get(w.id)?.seg))
				return;
			tiles.push(m);
		}
		this.preview = null;
		this.previewMs = Math.round(performance.now() - this.genStart);
		const set = new TerrainSet(
			this.frame,
			tiles.sort((a, b) => a.distance - b.distance),
		);
		const zooms: Record<number, number> = {};
		for (const t of tiles) zooms[t.key.z] = (zooms[t.key.z] ?? 0) + 1;
		set.stats = {
			tiles: tiles.length,
			zooms,
			fallbacks: tiles.filter((t) => t.sourceZ < t.key.z).length,
			standIns: 0,
			pending: this.want.filter((w) => this.meshes.get(w.id)?.seg !== w.seg)
				.length,
			triangles: tiles.reduce((n, t) => n + meshTriangles(t), 0),
			loadMs: this.previewMs,
			generation: 0,
			buildMs: Math.round(this.buildMs),
		};
		this.o.onPreview?.(set);
	}

	private scheduleEmit(ms: number) {
		if (this.disposed) return;
		if (this.emitTimer) {
			if (ms > 0) return; // one already pending
			clearTimeout(this.emitTimer);
		}
		this.emitTimer = setTimeout(() => {
			this.emitTimer = null;
			this.emit();
		}, ms);
	}

	/** Loaded meshes exactly tiling `key` (itself, or children recursively), else null. */
	private cover(key: TileKey, depth: number): TileMesh[] | null {
		const m = this.meshes.get(tileId(key));
		if (m) return [m];
		if (depth === 0 || key.z >= this.o.maxZoom) return null;
		const out: TileMesh[] = [];
		for (const c of childrenOf(key)) {
			const sub = this.cover(c, depth - 1);
			if (!sub) return null;
			out.push(...sub);
		}
		return out;
	}

	private emit() {
		if (this.disposed) return;
		const pending = this.pendingCount();
		this.o.onProgress?.(Math.max(0, this.genTotal - pending), this.genTotal);
		if (!this.ready && pending > 0) return; // first load: all or nothing
		this.ready = true;

		const render = new Map<string, TileMesh>();
		let standIns = 0;
		for (const w of this.want) {
			const own = this.meshes.get(w.id); // right tile, maybe old resolution
			if (own) {
				render.set(w.id, own);
				if (own.seg !== w.seg) standIns++;
				continue;
			}
			standIns++;
			const kids = this.cover(w.key, 4);
			if (kids) {
				for (const m of kids) render.set(m.id, m);
				continue;
			}
			for (let a = parentKey(w.key); a.z >= 0; a = parentKey(a)) {
				const m = this.meshes.get(tileId(a));
				if (m) {
					render.set(m.id, m);
					break;
				}
			}
		}
		// A stand-in parent hides its (partially loaded) children: no overlapping tiles.
		const coarse = [...render.values()].filter((m) => m.key.z < this.o.maxZoom);
		const tiles = [...render.values()].filter(
			(m) => !coarse.some((a) => isAncestor(a.key, m.key)),
		);

		this.tick++;
		for (const t of tiles) this.lastUsed.set(t.id, this.tick);
		this.evict(new Set(tiles.map((t) => t.id)));

		const set = new TerrainSet(
			this.frame,
			tiles.sort((a, b) => a.distance - b.distance),
		);
		const zooms: Record<number, number> = {};
		for (const t of tiles) zooms[t.key.z] = (zooms[t.key.z] ?? 0) + 1;
		if (pending === 0 && this.loading.size === 0 && this.genDoneMs < 0)
			this.genDoneMs = Math.round(performance.now() - this.genStart);
		set.stats = {
			tiles: tiles.length,
			zooms,
			fallbacks: tiles.filter((t) => t.sourceZ < t.key.z).length,
			standIns,
			pending,
			...(this.gaveUp.size ? { failed: this.gaveUp.size } : {}),
			triangles: tiles.reduce((n, t) => n + meshTriangles(t), 0),
			loadMs: this.genDoneMs,
			generation: this.generation,
			buildMs: Math.round(this.buildMs),
		};
		this.o.onUpdate(set);
	}

	private evict(rendered: Set<string>) {
		// oldest first
		const candidates = [...this.meshes.keys()]
			.filter((id) => !rendered.has(id) && !this.wantById.has(id))
			.sort(
				(a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0),
			);
		const plan = spareEviction(
			candidates,
			this.meshes.size - rendered.size,
			this.o.spareMeshes,
			this.o.spareGpuLayers,
		);
		for (const id of plan.drop) {
			this.meshes.get(id)?.gpuLayer?.release();
			this.meshes.delete(id);
			this.lastUsed.delete(id);
		}
		for (const id of plan.unlease) this.meshes.get(id)?.gpuLayer?.release();
	}
}

/**
 * The streamer's spare-mesh policy: of `candidates` (spare meshes that may go, oldest first; `spare`
 * = all meshes beyond the rendered set), the oldest go until at most `spareMeshes` spare remain
 * (`drop`), and of the candidates kept, all but the newest `spareGpuLayers` let go of their GPU
 * heights (`unlease`).
 */
export function spareEviction<T>(
	candidates: readonly T[],
	spare: number,
	spareMeshes: number,
	spareGpuLayers: number,
) {
	const n = Math.min(candidates.length, Math.max(0, spare - spareMeshes));
	const drop = candidates.slice(0, n);
	const kept = candidates.slice(n);
	const unlease = kept.slice(0, Math.max(0, kept.length - spareGpuLayers));
	return { drop, unlease };
}

/** 2× box-filter downsample (for tiles whose mesh can't use the full 512 px). */
export function downsample2(r: DemRaster): DemRaster {
	return {
		...r,
		size: r.size / 2,
		heights: downsampleHeights2(r.heights, r.size),
	};
}
