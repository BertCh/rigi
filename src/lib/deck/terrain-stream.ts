// View-driven DEM streaming for the deck.gl path. The high-detail wedge follows the live view
// heading/FOV: each re-selection queues the missing tiles (near + in-view first, a small
// concurrency cap), drops queued tiles that went stale, and until a tile's mesh arrives it is
// stood in for by already-loaded geometry (its old-resolution mesh, a loaded parent, or a full
// set of loaded children), so the surface never has holes while refining or coarsening.

import { tilePriority } from "../cache";
import {
	type DemRaster,
	loadDemTile,
	parentKey,
	type TileKey,
	tileId,
} from "../dem";
import type { EnuFrame } from "../geodesy";
import {
	buildBatchGrid,
	buildLiteMesh,
	meshTriangles,
} from "./batched-terrain-grid";
import {
	buildMesh,
	segmentsFor,
	selectDemTiles,
	TerrainSet,
	type TileChoice,
	type TileMesh,
	type ViewWedge,
} from "./terrain-data";
import { terrainBuild } from "./terrain-mode";

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
	/** New render set (throttled). Not called until the first selection has fully loaded. */
	onUpdate: (set: TerrainSet) => void;
	onProgress?: (done: number, total: number) => void;
};

type Want = TileChoice & { id: string; seg: number };

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
	private o: Required<Omit<StreamOptions, "onProgress">> &
		Pick<StreamOptions, "onProgress">;
	/** One mesh per tile id (replaced when the wanted resolution changes). */
	private meshes = new Map<string, TileMesh>();
	private lastUsed = new Map<string, number>();
	private want: Want[] = [];
	private wantById = new Map<string, Want>();
	private queue: Want[] = [];
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
			...options,
		};
	}

	/** Re-select for a new view wedge. Cheap no-op if the wedge barely moved. */
	setWedge(wedge: ViewWedge) {
		if (this.disposed) return;
		const w = this.wedge;
		if (
			w &&
			Math.abs(((wedge.headingDeg - w.headingDeg + 540) % 360) - 180) < 2 &&
			Math.abs(wedge.halfAngleDeg - w.halfAngleDeg) < 2
		)
			return;
		this.wedge = wedge;
		this.generation++;
		this.genStart = performance.now();
		this.genDoneMs = -1;
		this.want = selectDemTiles(this.frame.lat, this.frame.lon, {
			...this.o,
			wedge,
		}).map((c) => ({ ...c, id: tileId(c.key), seg: segmentsFor(c) }));
		this.wantById = new Map(this.want.map((w) => [w.id, w]));
		// Cancel in-flight loads the new view no longer wants (or wants at another resolution);
		// the shared cache drops their network request once no other caller wants it.
		for (const [id, l] of this.loading) {
			const w = this.wantById.get(id);
			if (!w || w.seg !== l.seg) {
				l.ac.abort();
				this.loading.delete(id); // free the slot; re-queued below if wanted at a new seg
			}
		}
		// Queue whatever isn't loaded at the wanted resolution; near + in-view first. Anything
		// queued for the previous wedge and not in this list is dropped (stale).
		this.queue = this.want
			.filter(
				(w) => this.meshes.get(w.id)?.seg !== w.seg && !this.loading.has(w.id),
			)
			.sort((a, b) => this.priority(a) - this.priority(b));
		this.genTotal = this.queue.length + this.loading.size;
		this.pump();
		this.scheduleEmit(0);
	}

	dispose() {
		this.disposed = true;
		this.queue = [];
		for (const l of this.loading.values()) l.ac.abort();
		if (this.emitTimer) clearTimeout(this.emitTimer);
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
			const cur = this.wantById.get(w.id);
			if (!cur || cur.seg !== w.seg) continue; // went stale
			if (this.meshes.get(w.id)?.seg === w.seg || this.loading.has(w.id))
				continue;
			const ac = new AbortController();
			this.loading.set(w.id, { seg: w.seg, ac });
			this.load(w, ac.signal).finally(() => {
				if (this.loading.get(w.id)?.ac === ac) this.loading.delete(w.id);
				this.pump();
				this.scheduleEmit(this.queue.length || this.loading.size ? 150 : 0);
			});
		}
	}

	private async load(w: Want, signal: AbortSignal) {
		let dem = await loadDemTile(w.key, {
			minZoom: this.o.minZoom - 2,
			priority: tilePriority(w.focus ? w.distance : w.distance * 4, w.key.z),
			signal,
		}).catch(() => null); // aborted (stale) or no data anywhere up the pyramid
		if (!dem || this.disposed || signal.aborted) return;
		while (dem.size > 2 * w.seg && dem.size > 256) dem = downsample2(dem);
		const t0 = performance.now();
		// terrain-mode.ts: the per-tile path's CPU mesh and / or the batched path's grid
		const build = terrainBuild();
		const mesh = build.mesh
			? buildMesh(this.frame, dem, w.seg, w.distance, w.focus)
			: buildLiteMesh(this.frame, dem, w.seg, w.distance, w.focus);
		if (build.mesh && build.grid)
			mesh.grid = buildBatchGrid(this.frame, dem.key, dem.heights);
		this.buildMs += performance.now() - t0;
		this.meshes.set(w.id, mesh);
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
		const pending = this.want.filter(
			(w) => this.meshes.get(w.id)?.seg !== w.seg,
		).length;
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
			triangles: tiles.reduce((n, t) => n + meshTriangles(t), 0),
			loadMs: this.genDoneMs,
			generation: this.generation,
			buildMs: Math.round(this.buildMs),
		};
		this.o.onUpdate(set);
	}

	private evict(rendered: Set<string>) {
		const spare = this.meshes.size - rendered.size;
		if (spare <= this.o.spareMeshes) return;
		const candidates = [...this.meshes.keys()]
			.filter((id) => !rendered.has(id) && !this.wantById.has(id))
			.sort(
				(a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0),
			);
		for (const id of candidates.slice(0, spare - this.o.spareMeshes)) {
			this.meshes.delete(id);
			this.lastUsed.delete(id);
		}
	}
}

/** 2× box-filter downsample (for tiles whose mesh can't use the full 512 px). */
function downsample2(r: DemRaster): DemRaster {
	const s = r.size / 2;
	const h = r.heights;
	const S = r.size;
	const out = new Float32Array(s * s);
	for (let y = 0; y < s; y++)
		for (let x = 0; x < s; x++) {
			const o = 2 * y * S + 2 * x;
			out[y * s + x] = (h[o] + h[o + 1] + h[o + S] + h[o + S + 1]) * 0.25;
		}
	return { ...r, size: s, heights: out };
}
