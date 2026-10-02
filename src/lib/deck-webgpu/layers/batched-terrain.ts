// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Batched terrain on WebGPU (port of deck/batched-terrain-layer.ts + batched-terrain-grid.ts;
// README.md "Ports"). Every streamed DEM tile is drawn by ONE instanced, indexed draw per mesh
// resolution (64 / 128 / 256 segments) and pass, with no CPU mesh:
//   - heights:   r32float 2d-arrays (TextureArrayAtlas, grown by copy; 256² layers for ≤ 256 px
//                tiles, 512² for the near tiles), read with textureLoad in the vertex shader (no
//                filtering; the bilinear is dem/grid.ts sampleGrid, done by hand)
//   - base grid: a read-only storage buffer, one packed slot of 2·(G+1)² vec4 per tile (offset in
//                the tile's table row; base-slots.ts, WAG W1.6): per node the ENU of the h = 0
//                surface (batched-terrain-grid.ts buildBatchGrid) and the ellipsoid up vector (CPU,
//                double; replaces the WebGL shader's per-vertex trig)
//   - tile table: a read-only storage buffer, one 48-byte TileRow per tile (height layer, size,
//                seg, skirt | Mercator / lon params | G, big, imagery layer, base-grid offset)
//   - instances: per (pass kind, seg) a compact uint32 vertex buffer of the visible tiles' table
//                rows (CPU-culled with the grid's bounding sphere), step mode "instance". On WebGPU
//                (WAG W1.5) terrain-cull.ts culls and compacts them
//                on the GPU in the pass's prepass and the draws are indirect (no CPU cull, no count
//                readback); conservative and in the CPU path's draw order, so the frames are
//                byte-identical (scripts/deck-webgpu/terrain-indirect-check.mjs)
//   - vertices:  none. (i, j, skirt) come from @builtin(vertex_index) in gridMesh's vertex order
//                (grid rows, then the four edge copies); the index buffer is gridMesh's, so the
//                triangulation (and the double-sided skirts) are buildMesh's.
// The vertex stage rebuilds buildMesh's position, central-difference normal, uv and elevation and
// writes terrain.ts's Varyings; the program is terrainSource(BATCHED_VERTEX_WGSL, shading, plugins)
// with terrainModules / terrainDefines, so the geometry pass, the default hillshade / imagery look,
// terrain styles and drape / truth plugins apply unchanged (the same fragment stages for every look).
// Imagery is the shared ImageryArray: the tile's layer sits in its table row (one 4-byte write
// per change), so the colour pass needs no per-image-size grouping (the WebGL path did).
//
// Meshes must carry a batch grid (the streamer's lite meshes have empty vertex arrays; roll-terrain's
// full meshes carry both). Tiles without `grid` are ignored here.
//
// Device note: the height arrays are bound as texture_2d_array<f32> (luma derives sampleType
// "float" from the WGSL), which accepts r32float only with the 'float32-filterable' feature;
// device.ts requests it (Apple / Metal has it). Same constraint as every rgba32float binding in the
// foundation.
//
// luma 10: nothing deck-specific here; Model / Buffer / Texture / ShaderModule only.
import type {
	Buffer,
	CommandEncoder,
	Device,
	RenderBundleEncoder,
	RenderPass,
	Texture,
} from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import {
	BASE_MAX,
	type BatchGrid,
	gridMesh,
} from "#/lib/deck/batched-terrain-grid";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { getCpuHeights } from "#/lib/dem/cpu-heights";
import { getFlag } from "#/lib/flags";
import { EARTH_R, REFRACTION_K } from "#/lib/geodesy";
import { gpuEnabled } from "#/lib/gpu/device";
import { GpuDecodedHeights } from "#/lib/gpu/ingest/terrarium-tile";
import { nearestWithin } from "../atlas-layout";
import { BaseSlotAllocator, baseSlotVec4, placeSlots } from "../base-slots";
import { type CameraUniforms, sphereInView } from "../camera";
import type { ImageryArray } from "../imagery";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	type PrepassContext,
	passModelProps,
} from "../pass";
import {
	modelBundleKeys,
	RenderBundleSet,
	type RenderBundleStats,
} from "../render-bundle";
import {
	DEFAULT_TERRAIN_LOOK,
	type TerrainLook,
	type TerrainShaderPart,
	terrainDefines,
	terrainModules,
	terrainSource,
} from "../terrain";
import {
	type AtlasLease,
	TextureArrayAtlas,
	TileLayerRef,
} from "../texture-array-atlas";
import { type CulledDraw, TerrainGpuCull } from "./terrain-cull";

// ---------- WGSL ----------

const SMALL = 256;
const BIG = 512;
/** vec4s of the largest base-grid slot: 2 per node (base, up) × (BASE_MAX + 1)². */
const BASE_SLOT = baseSlotVec4(BASE_MAX);
/** Floats per tile-table row (3 × vec4). */
const ROW_FLOATS = 12;
/** Offset of the imagery layer inside a row (t2.z). */
const ROW_IMAGERY = 10;

const f32 = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** The batched vertex stage: `vertexMain` → terrain.ts Varyings (terrainSource's vertex seam). */
export const BATCHED_VERTEX_WGSL = /* wgsl */ `\
struct TileRow {
  // height layer, DEM size (px), seg, skirt (m)
  t0: vec4<f32>,
  // Mercator angle at the north edge, its span, west lon − frame lon, lon span (rad); unused by
  // the shader (the up vectors are in baseGrid), kept for diagnostics
  geo: vec4<f32>,
  // base cells G, big (1 = 512² pool), imagery layer (−1 none), base-grid slot offset (vec4)
  t2: vec4<f32>,
};

@group(0) @binding(auto) var heightSmall: texture_2d_array<f32>;
@group(0) @binding(auto) var heightBig: texture_2d_array<f32>;
@group(0) @binding(auto) var<storage, read> baseGrid: array<vec4<f32>>;
@group(0) @binding(auto) var<storage, read> tileTable: array<TileRow>;

const BT_EARTH_R: f32 = ${f32(EARTH_R)};
const BT_REFRACTION_K: f32 = ${f32(REFRACTION_K)};

struct BatchTile {
  base: u32,
  layer: i32,
  big: bool,
  size: f32,
  seg: f32,
  skirt: f32,
  g: f32,
};

fn bt_texel(t: BatchTile, x: i32, y: i32) -> f32 {
  if (t.big) { return textureLoad(heightBig, vec2<i32>(x, y), t.layer, 0).r; }
  return textureLoad(heightSmall, vec2<i32>(x, y), t.layer, 0).r;
}

// dem/grid.ts sampleGrid: bilinear on the pixel-centred S×S grid at pixel coords (0..S)
fn bt_height(t: BatchTile, px: f32, py: f32) -> f32 {
  let m = t.size - 1.0;
  let x = clamp(px - 0.5, 0.0, m);
  let y = clamp(py - 0.5, 0.0, m);
  let x0 = floor(x);
  let y0 = floor(y);
  let ix0 = i32(x0);
  let iy0 = i32(y0);
  let ix1 = i32(min(x0 + 1.0, m));
  let iy1 = i32(min(y0 + 1.0, m));
  let fx = x - x0;
  let fy = y - y0;
  let a = bt_texel(t, ix0, iy0) * (1.0 - fx) + bt_texel(t, ix1, iy0) * fx;
  let b = bt_texel(t, ix0, iy1) * (1.0 - fx) + bt_texel(t, ix1, iy1) * fx;
  return a * (1.0 - fy) + b * fy;
}

// The h = 0 surface and the ellipsoid normal at tile fraction f: bilinear between the base nodes
// (baseGrid holds per node [ENU of h = 0 with the curvature drop taken out, up vector]). The drop
// (e² + n²) / 2R is re-added analytically (batched-terrain-grid.ts). The up vector is interpolated
// instead of evaluated with atan(sinh(·)) / sin / cos per vertex (the WebGL path): GPU f32
// transcendentals put ~cm of error into h · up near the eye, while the bilinear error of up over
// one base cell is < 1e-7 rad (≲ 0.1 mm at 4 km of height) on every zoom.
struct BtSurface {
  base: vec3<f32>,
  up: vec3<f32>,
};
fn bt_surface(t: BatchTile, f: vec2<f32>) -> BtSurface {
  let g = f * t.g;
  let c = min(floor(g), vec2<f32>(t.g - 1.0));
  let w = g - c;
  let n = u32(t.g + 0.5) + 1u;
  let o = t.base + 2u * (u32(c.y) * n + u32(c.x));
  let o1 = o + 2u * n;
  var r: BtSurface;
  var b = mix(
    mix(baseGrid[o].xyz, baseGrid[o + 2u].xyz, w.x),
    mix(baseGrid[o1].xyz, baseGrid[o1 + 2u].xyz, w.x),
    w.y,
  );
  b.z -= dot(b.xy, b.xy) / (2.0 * BT_EARTH_R);
  r.base = b;
  r.up = normalize(mix(
    mix(baseGrid[o + 1u].xyz, baseGrid[o + 3u].xyz, w.x),
    mix(baseGrid[o1 + 1u].xyz, baseGrid[o1 + 3u].xyz, w.x),
    w.y,
  ));
  return r;
}

// buildMesh's vertex (i, j): ENU position (xyz, geodesy.ts fromGeo incl. refraction) and elevation (w)
fn bt_vertex(t: BatchTile, i: f32, j: f32) -> vec4<f32> {
  let f = vec2<f32>(i, j) / t.seg;
  let h = bt_height(t, f.x * t.size, f.y * t.size);
  let sf = bt_surface(t, f);
  var p = sf.base + h * sf.up;
  p.z += BT_REFRACTION_K * dot(p.xy, p.xy) / (2.0 * BT_EARTH_R);
  return vec4<f32>(p, h);
}

@vertex fn vertexMain(
  @builtin(vertex_index) vid: u32,
  @location(0) row: u32,
) -> Varyings {
  let r = tileTable[row];
  var t: BatchTile;
  t.base = u32(r.t2.w);
  t.layer = i32(r.t0.x + 0.5);
  t.size = r.t0.y;
  t.seg = r.t0.z;
  t.skirt = r.t0.w;
  t.g = r.t2.x;
  t.big = r.t2.y > 0.5;

  // gridMesh's vertex order: (seg+1)² grid vertices, row 0 = north, then the four edge copies
  // (north row, south row, west column, east column) dropped by the skirt
  let n = u32(t.seg + 0.5) + 1u;
  var i: f32;
  var j: f32;
  var skirt = false;
  if (vid < n * n) {
    i = f32(vid % n);
    j = f32(vid / n);
  } else {
    let e = (vid - n * n) / n;
    let k = f32((vid - n * n) % n);
    skirt = true;
    if (e == 0u) { i = k; j = 0.0; }
    else if (e == 1u) { i = k; j = t.seg; }
    else if (e == 2u) { i = 0.0; j = k; }
    else { i = t.seg; j = k; }
  }

  let v = bt_vertex(t, i, j);
  // buildMesh's grid normals: central differences, clamped at the tile edge (skirts copy the edge's)
  let ex = bt_vertex(t, min(i + 1.0, t.seg), j).xyz - bt_vertex(t, max(i - 1.0, 0.0), j).xyz;
  let sy = bt_vertex(t, i, max(j - 1.0, 0.0)).xyz - bt_vertex(t, i, min(j + 1.0, t.seg)).xyz;
  var nrm = cross(ex, sy);
  let len = length(nrm);
  if (len > 0.0) { nrm = nrm / len; }
  var pos = v.xyz;
  var elev = v.w;
  if (skirt) {
    pos.z -= t.skirt;
    elev -= t.skirt;
  }

  var o: Varyings;
  o.position = camera_clip(pos);
  o.enu = pos;
  o.normal = nrm;
  o.uv = vec2<f32>(i, j) / t.seg;
  o.elev = elev;
  o.layer = r.t2.z;
  return o;
}
`;

// ---------- GPU store: height arrays, base grid + tile table buffers ----------

const TEX_USAGE = { SAMPLE: 0x04, COPY_DST: 0x02, COPY_SRC: 0x01 } as const;
const BUF_USAGE = {
	INDEX: 0x0010,
	VERTEX: 0x0020,
	COPY_DST: 0x0008,
	STORAGE: 0x0080,
} as const;

/** A resident tile: table row, height layer, base-grid slot (offset −1 = not placed yet). */
type Slot = {
	row: number;
	layer: number;
	big: boolean;
	size: number;
	base: number;
	/** the layer belongs to the tile (decoded into at load): this slot holds a
	 * reference instead of owning the layer, and the tile needs no upload */
	lease?: AtlasLease;
};

/** Initial layers of the 256² / 512² height arrays: also the compaction quantum and floor. */
const SMALL_LAYERS = 128;
const BIG_LAYERS = 16;
/** Quiet time after a sync that freed layers before the height arrays are compacted (imagery.ts). */
const HEIGHT_COMPACT_IDLE_MS = 4000;

/** A growable r32float 2d-array of `size`² height layers: a TextureArrayAtlas that grows by copy
 * (layers keep their heights; only fresh tiles upload). */
function heightPool(
	device: Device,
	id: string,
	size: number,
	cap: number,
	max: number,
) {
	return new TextureArrayAtlas(device, {
		id,
		format: "r32float",
		size,
		usage: TEX_USAGE.SAMPLE | TEX_USAGE.COPY_DST | TEX_USAGE.COPY_SRC,
		sampler: {
			minFilter: "nearest",
			magFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		},
		capacity: cap,
		maxLayers: max,
		grow: { factor: 1.5 },
	});
}

/** Heights, base grids and the tile table for the rendered set (by TileMesh identity). */
class TileStore {
	small: TextureArrayAtlas;
	big: TextureArrayAtlas;
	base!: Buffer;
	table!: Buffer;
	private tableData: Float32Array;
	rowsCap = 0;
	private freeRows: number[] = [];
	private nextRow = 0;
	readonly slots = new Map<TileMesh, Slot>();
	private readonly maxLayers: number;
	private readonly maxRows: number;
	/** the most vec4s the base buffer may hold (binding limit; offsets stay f32-exact) */
	private readonly maxBase: number;
	private readonly baseSlots: BaseSlotAllocator;
	/** Tiles dropped for lack of layers / rows (device limits). */
	overflow = 0;
	private compactTimer: ReturnType<typeof setTimeout> | null = null;
	/** idle compactions that shrank a height array */
	compactions = 0;

	constructor(private device: Device) {
		const lim = device.limits as {
			maxTextureArrayLayers?: number;
			maxStorageBufferBindingSize?: number;
		};
		this.maxLayers = lim.maxTextureArrayLayers || 256;
		const maxBinding = lim.maxStorageBufferBindingSize ?? 128 * 2 ** 20;
		this.maxRows = Math.max(16, Math.floor(maxBinding / (BASE_SLOT * 16)));
		this.maxBase = Math.min(2 ** 24, Math.floor(maxBinding / 16));
		this.small = heightPool(
			device,
			"bterrain-h256",
			SMALL,
			SMALL_LAYERS,
			this.maxLayers,
		);
		this.big = heightPool(
			device,
			"bterrain-h512",
			BIG,
			BIG_LAYERS,
			this.maxLayers,
		);
		this.tableData = new Float32Array(0);
		this.growRows(128);
		// initial room: 128 tiles of G = 32 (the photo view's common grid)
		this.baseSlots = new BaseSlotAllocator(128 * baseSlotVec4(32));
		this.base = this.createBase(this.baseSlots.capacity);
	}

	private createBase(vec4s: number) {
		return this.device.createBuffer({
			id: "bterrain-base",
			usage: BUF_USAGE.STORAGE | BUF_USAGE.COPY_DST,
			byteLength: vec4s * 16,
		});
	}

	/** (Re)create the table buffer for `cap` rows; true when it was re-created. */
	private growRows(need: number) {
		if (need <= this.rowsCap) return false;
		const cap = Math.min(
			this.maxRows,
			Math.max(need, Math.ceil(this.rowsCap * 1.5)),
		);
		if (cap === this.rowsCap) return false;
		this.table?.destroy();
		this.table = this.device.createBuffer({
			id: "bterrain-table",
			usage: BUF_USAGE.STORAGE | BUF_USAGE.COPY_DST,
			byteLength: cap * ROW_FLOATS * 4,
		});
		const d = new Float32Array(cap * ROW_FLOATS);
		d.set(
			this.tableData.subarray(0, Math.min(this.tableData.length, d.length)),
		);
		this.tableData = d;
		this.rowsCap = cap;
		return true;
	}

	/** A slot's height layer goes: its reference on a tile's layer, or the layer itself. */
	private freeLayer(s: Slot) {
		if (s.lease) s.lease.release();
		else (s.big ? this.big : this.small).release(s.layer);
	}

	/** The lease a fresh tile was decoded into at load, when it is a live layer of `pool`. */
	private leaseIn(m: TileMesh, pool: TextureArrayAtlas) {
		const ref = m.gpuLayer;
		return ref instanceof TileLayerRef &&
			ref.lease.live &&
			ref.lease.atlas === pool
			? ref.lease
			: undefined;
	}

	/** (Re)start the idle countdown to compactIdle. */
	private armCompact() {
		if (this.compactTimer) clearTimeout(this.compactTimer);
		this.compactTimer = setTimeout(() => {
			this.compactTimer = null;
			this.compactIdle();
		}, HEIGHT_COMPACT_IDLE_MS);
	}

	/**
	 * Idle after layers were freed: a height array with at least its initial capacity free moves its
	 * live layers (this store's own and the tiles' leases) down to 0 … n−1 in a smaller texture
	 * (TextureArrayAtlas.compactLeased; refused when the books do not add up). Slots and table rows
	 * are re-pointed; the texture objects change, so consumers ask per use (the draw's bindings
	 * change identity, which also re-records ?renderBundles=on).
	 */
	compactIdle() {
		let moved = false;
		for (const [pool, big, quantum] of [
			[this.small, false, SMALL_LAYERS],
			[this.big, true, BIG_LAYERS],
		] as const) {
			if (pool.capacity - pool.used() < quantum) continue;
			const owned: Slot[] = [];
			for (const s of this.slots.values())
				if (s.big === big && !s.lease) owned.push(s);
			const remap = pool.compactLeased(
				owned.map((s) => s.layer),
				quantum,
				quantum,
			);
			if (!remap) continue;
			for (const s of this.slots.values()) {
				if (s.big !== big) continue;
				s.layer = s.lease ? s.lease.layer : (remap.get(s.layer) ?? s.layer);
				this.tableData[s.row * ROW_FLOATS] = s.layer;
			}
			this.compactions++;
			moved = true;
		}
		if (moved) this.table.write(this.tableData);
	}

	/** Upload what's new in `tiles`, free what's gone. `layerOf` = imagery layer per tile id. */
	sync(tiles: readonly TileMesh[], layerOf: (id: string) => number) {
		// a later sync pushes a pending compaction back (the scene is moving)
		if (this.compactTimer) this.armCompact();
		const want = new Set(tiles.filter((t) => t.grid && t.size <= BIG));
		let freed = false;
		for (const [m, s] of this.slots)
			if (!want.has(m)) {
				this.slots.delete(m);
				this.freeRows.push(s.row);
				this.freeLayer(s);
				if (s.base >= 0) this.baseSlots.release(s.base, s.size);
				freed = true;
			}
		if (freed) this.armCompact();
		let fresh = [...want].filter((m) => !this.slots.has(m));
		if (!fresh.length) return;
		const overflowed = this.nearFirst(fresh);
		if (overflowed.size) fresh = fresh.filter((m) => !overflowed.has(m));
		if (!fresh.length) {
			this.overflow = overflowed.size;
			return;
		}
		const freshSlots: Slot[] = [];
		for (const m of fresh) {
			const big = m.size > SMALL;
			const pool = big ? this.big : this.small;
			// a tile decoded into a layer of this very atlas at load: draw it from there
			const lease = this.leaseIn(m, pool);
			lease?.retain();
			const slot: Slot = {
				row: this.freeRows.pop() ?? this.nextRow++,
				layer: lease ? lease.layer : pool.alloc(),
				big,
				size: m.grid ? baseSlotVec4(m.grid.G) : 0,
				base: -1,
				lease,
			};
			this.slots.set(m, slot);
			freshSlots.push(slot);
		}
		let maxSmall = 0;
		let maxBig = 0;
		let maxRow = 0;
		for (const s of this.slots.values()) {
			if (s.big) maxBig = Math.max(maxBig, s.layer + 1);
			else maxSmall = Math.max(maxSmall, s.layer + 1);
			maxRow = Math.max(maxRow, s.row + 1);
		}
		// a grow copies the old layers (TextureArrayAtlas.reserve): only fresh tiles upload
		this.small.reserve(maxSmall);
		this.big.reserve(maxBig);
		const reRows = this.growRows(maxRow);
		this.overflow = overflowed.size;
		const drop = (m: TileMesh, s: Slot) => {
			// past a device limit: not drawn
			this.slots.delete(m);
			this.freeRows.push(s.row);
			this.freeLayer(s);
			if (s.base >= 0) this.baseSlots.release(s.base, s.size);
			this.overflow++;
		};
		// out of height layers or rows: dropped before the base slots are placed, so they never
		// take base-grid room from a tile that is drawn
		for (const [m, s] of this.slots)
			if (
				s.layer >= (s.big ? this.big : this.small).capacity ||
				s.row >= this.rowsCap
			)
				drop(m, s);
		const live = new Set(this.slots.values());
		const placed = placeSlots(
			this.baseSlots,
			live,
			freshSlots.filter((s) => live.has(s)),
			this.maxBase,
		);
		if (placed.repacked && this.base.byteLength !== placed.capacity * 16) {
			this.base.destroy();
			this.base = this.createBase(placed.capacity);
		}
		const freshSet = new Set(fresh);
		for (const [m, s] of this.slots) {
			const pool = s.big ? this.big : this.small;
			if (s.base < 0) {
				drop(m, s);
				continue;
			}
			const isFresh = freshSet.has(m);
			if (isFresh && !s.lease) {
				// a GPU-decoded tile whose CPU heights nobody asked for yet:
				// decode its bitmap straight into the layer; else upload the CPU heights
				const gpu = m.heights ? undefined : m.lazyHeights;
				if (
					gpu instanceof GpuDecodedHeights &&
					gpu.bitmap.width / gpu.down === m.size
				)
					pool.writeTerrarium(s.layer, gpu);
				else pool.writeRaster(s.layer, getCpuHeights(m), m.size);
			}
			const g = m.grid;
			if (!g) continue;
			if (isFresh || placed.repacked)
				this.base.write(baseWithUp(g), s.base * 16);
			if (isFresh || reRows || placed.repacked) {
				this.tableData.set(
					[
						s.layer,
						m.size,
						m.seg,
						g.skirt,
						g.merc0,
						g.mercSpan,
						g.dlon0,
						g.dlonSpan,
						g.G,
						s.big ? 1 : 0,
						layerOf(m.id),
						s.base,
					],
					s.row * ROW_FLOATS,
				);
			}
		}
		this.table.write(this.tableData);
	}

	/**
	 * Near-first overflow: when a height array cannot hold every wanted tile (maxLayers, 256 on a
	 * 'core' device), the nearest by (distance, id) keep layers. The candidates are this store's own
	 * layers (non-leased slots, which a nearer fresh tile may evict) and the fresh tiles that need a
	 * new one; layers held by leases (tiles decoded at load, spare meshes) are not the store's to
	 * give and count against the budget. Returns the fresh tiles left out (evicted slots are freed
	 * here and count as overflow by the caller's tally). Nothing changes when everything fits.
	 */
	private nearFirst(fresh: readonly TileMesh[]) {
		const out = new Set<TileMesh>();
		for (const big of [false, true]) {
			const pool = big ? this.big : this.small;
			const need = fresh.filter(
				(m) => m.size > SMALL === big && !this.leaseIn(m, pool),
			);
			if (!need.length || pool.used() + need.length <= pool.maxLayers) continue;
			const owned: [TileMesh, Slot][] = [];
			for (const [m, s] of this.slots)
				if (s.big === big && !s.lease) owned.push([m, s]);
			const budget = Math.max(0, pool.maxLayers - pool.used() + owned.length);
			const keep = new Set(
				nearestWithin([...owned.map(([m]) => m), ...need], budget),
			);
			for (const m of need) if (!keep.has(m)) out.add(m);
			for (const [m, s] of owned)
				if (!keep.has(m)) {
					this.slots.delete(m);
					this.freeRows.push(s.row);
					this.freeLayer(s);
					if (s.base >= 0) this.baseSlots.release(s.base, s.size);
					out.add(m);
				}
		}
		return out;
	}

	/** Point rows at their imagery layers; writes the table once if anything changed. */
	syncLayers(layerOf: (id: string) => number) {
		let dirty = false;
		for (const [m, s] of this.slots) {
			const o = s.row * ROW_FLOATS + ROW_IMAGERY;
			const layer = layerOf(m.id);
			if (this.tableData[o] !== layer) {
				this.tableData[o] = layer;
				dirty = true;
			}
		}
		if (dirty) this.table.write(this.tableData);
		return dirty;
	}

	destroy() {
		if (this.compactTimer) clearTimeout(this.compactTimer);
		this.compactTimer = null;
		this.small.destroy();
		this.big.destroy();
		this.base.destroy();
		this.table.destroy();
		this.slots.clear();
	}
}

// ---------- the core ----------

/** A compact instance buffer (uint32 table rows) for one (pass kind, seg). */
type InstBuf = { buf: Buffer; cap: number; rows?: Uint32Array };

/** Where the batched terrain keeps each tile's heights (BatchedTerrainCore.residentHeights). */
export type ResidentHeights = {
	/** r32float 2d-array, SMALL² layers (tiles of size <= 256; a tile of size S fills the top-left S x S) */
	small: Texture;
	/** r32float 2d-array, BIG² layers (size 257..512) */
	big: Texture;
	/** the tile object's slot, or null when it is not resident (no grid, over a device limit, not yet
	 * synced, and no layer of its own from a load-time GPU decode) */
	slotOf(tile: object): { layer: number; big: boolean } | null;
};

export type BatchedTerrainStats = {
	tiles: number;
	overflow: number;
	drawn: { geometry: number; color: number };
	culled: { geometry: number; color: number };
	draws: { geometry: number; color: number };
	triangles: number;
	uploadMs: number;
	/** which cull the last pass of each kind used ("gpu": drawn/culled are not known on the CPU;
	 * drawn = resident tiles, culled = -1) */
	cullPath: { geometry: "cpu" | "gpu"; color: "cpu" | "gpu" };
	/** CPU ms of the core's prepass + draw, last pass of each kind */
	cpuMs: { geometry: number; color: number };
	/**
	 * ?renderBundles=on diagnostics, cumulative per kind: `hits` replays of a recorded bundle,
	 * `records` (re-)recordings, `incomplete` recordings dropped (a draw was not ready), `direct`
	 * frames drawn the plain way while the flag was on (CPU cull, bundle unavailable).
	 * `last` is what the latest pass of the kind did. All zero with the flag off.
	 */
	bundles: {
		geometry: BundleCounters;
		color: BundleCounters;
	};
};

export type BundleCounters = RenderBundleStats & {
	direct: number;
	last: "off" | "hit" | "record" | "direct";
};

/**
 * The batched terrain as a GpuLayerCore (geometry + colour passes): `look`, `setShaderParts`,
 * `setTiles`, `syncImageryLayers`, `stats`.
 */
export class BatchedTerrainCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["geometry", "color"];
	readonly order = 0;
	look: TerrainLook = DEFAULT_TERRAIN_LOOK;
	private store: TileStore;
	private tiles: readonly TileMesh[] = [];
	private models = new ModelCache();
	private shading: TerrainShaderPart | null = null;
	private plugins: TerrainShaderPart[] = [];
	private indexBufs = new Map<number, { buf: Buffer; count: number }>();
	private instBufs = new Map<string, InstBuf>();
	private empty?: Texture;
	/**
	 * Optional culling override: return the visible rows per seg for this pass, or null to use the
	 * CPU sphere cull. When set, the GPU cull (terrain-cull.ts) stays off.
	 */
	cull?: (
		ctx: PassContext,
		tiles: readonly TileMesh[],
	) => Map<number, number[]> | null;
	stats: BatchedTerrainStats = {
		tiles: 0,
		overflow: 0,
		drawn: { geometry: 0, color: 0 },
		culled: { geometry: 0, color: 0 },
		draws: { geometry: 0, color: 0 },
		triangles: 0,
		uploadMs: 0,
		cullPath: { geometry: "cpu", color: "cpu" },
		cpuMs: { geometry: 0, color: 0 },
		bundles: {
			geometry: { records: 0, hits: 0, incomplete: 0, direct: 0, last: "off" },
			color: { records: 0, hits: 0, incomplete: 0, direct: 0, last: "off" },
		},
	};
	/** ?renderBundles=on: per kind, the recorded GPU-culled draws (MSAA and 1x variants inside) */
	private bundleSets: Partial<Record<"geometry" | "color", RenderBundleSet>> =
		{};
	/** what the bundle record callbacks encode: set by drawCulled just before executing */
	private bundleSource: { model: Model; draw: CulledDraw } | null = null;
	/** GPU cull (created on first use under the flag; WebGPU only) */
	private gpuCull: TerrainGpuCull | null = null;
	/** the GPU cull's candidates are stale (tile set changed) */
	private cullDirty = true;
	/** the GPU cull cannot take the current tile set (too many segs) */
	private cullUnsupported = false;
	/** per kind: the cull recorded by prepass for the coming draw */
	private prepared: Partial<
		Record<
			"geometry" | "color",
			{
				draw: CulledDraw;
				encoder: CommandEncoder;
				camera: CameraUniforms;
				ms: number;
			}
		>
	> = {};

	constructor(
		readonly device: Device,
		readonly imagery: ImageryArray | null,
		readonly id = "batched-terrain",
	) {
		this.store = new TileStore(device);
	}

	/** Replace the colour shading (null = default hillshade / imagery) and the plugin chain. */
	setShaderParts(
		shading: TerrainShaderPart | null,
		plugins: TerrainShaderPart[] = [],
	) {
		const key = (p: TerrainShaderPart | null) => p?.key ?? "";
		const was = [key(this.shading), ...this.plugins.map(key)].join("+");
		this.shading = shading;
		this.plugins = plugins;
		if (was !== [key(shading), ...plugins.map(key)].join("+"))
			this.models.invalidate("color");
	}

	private partsKey() {
		return [
			this.shading?.key ?? "default",
			...this.plugins.map((p) => p.key),
		].join("+");
	}

	private layerOf = (id: string) => this.imagery?.layerOf(id) ?? -1;

	/** Replace the rendered tile set (tiles need `grid`; keeps the GPU data of unchanged meshes). */
	setTiles(meshes: readonly TileMesh[]) {
		const t0 = performance.now();
		this.tiles = meshes;
		this.store.sync(meshes, this.layerOf);
		this.cullDirty = true;
		this.stats.tiles = this.store.slots.size;
		this.stats.overflow = this.store.overflow;
		this.stats.uploadMs += performance.now() - t0;
	}

	/**
	 * The DEM heights resident on this device, for GPU consumers that gather from them (the relief
	 * field's height raster, gpu/look/relief-heights.ts): the two r32float height arrays (COPY_SRC)
	 * and each tile's slot. The arrays are re-created when they grow, so ask again per use.
	 */
	residentHeights(): ResidentHeights {
		const { small, big, slots } = this.store;
		return {
			small: small.texture,
			big: big.texture,
			slotOf: (t) => {
				const s = slots.get(t as TileMesh);
				if (s) return { layer: s.layer, big: s.big };
				// not drawn, but decoded into a layer it still holds (terrainGpuDecode)
				const ref = (t as TileMesh).gpuLayer;
				if (!(ref instanceof TileLayerRef) || !ref.lease.live) return null;
				const atlas = ref.lease.atlas;
				return atlas === small || atlas === big
					? { layer: ref.lease.layer, big: atlas === big }
					: null;
			},
		};
	}

	/**
	 * The two height arrays themselves, for the GPU decode loader: it decodes each tile into a
	 * layer it leases there (TextureArrayAtlas.writeTerrariumLeased), which TileStore then draws.
	 */
	heightAtlases() {
		return { small: this.store.small, big: this.store.big };
	}

	/** Point tiles at their ImageryArray layers (one table write when any changed). */
	syncImageryLayers() {
		if (this.imagery) this.store.syncLayers(this.layerOf);
	}

	private model(kind: "geometry" | "color") {
		const key = kind === "geometry" ? kind : `color|${this.partsKey()}`;
		return this.models.get(key, () => {
			const geometry = kind === "geometry";
			const parts = geometry
				? []
				: [...(this.shading ? [this.shading] : []), ...this.plugins];
			const source = terrainSource(
				BATCHED_VERTEX_WGSL,
				geometry ? null : this.shading,
				geometry ? [] : this.plugins,
			);
			const modules = terrainModules(parts);
			return new Model(this.device, {
				id: `${this.id}-${kind}`,
				source,
				modules: modules as never,
				defines: terrainDefines(kind, parts),
				...passModelProps(kind),
				topology: "triangle-list",
				bufferLayout: [{ name: "row", format: "uint32", stepMode: "instance" }],
				isInstanced: true,
				instanceCount: 0,
			} as never);
		});
	}

	private indexBuf(seg: number) {
		let ib = this.indexBufs.get(seg);
		if (!ib) {
			const { indices } = gridMesh(seg);
			ib = {
				buf: this.device.createBuffer({
					id: `${this.id}-idx-${seg}`,
					data: indices,
					usage: BUF_USAGE.INDEX | BUF_USAGE.COPY_DST,
				}),
				count: indices.length,
			};
			this.indexBufs.set(seg, ib);
		}
		return ib;
	}

	/** The instance buffer of (kind, seg) holding `rows` (written only when they changed).
	 * Per kind: geometry and colour are encoded into one submit, so they must not share one. */
	private instBuf(kind: PassKind, seg: number, rows: number[]) {
		const key = `${kind}|${seg}`;
		let ib = this.instBufs.get(key);
		if (!ib || ib.cap < rows.length) {
			ib?.buf.destroy();
			const cap = Math.max(rows.length, (ib?.cap ?? 128) * 2);
			ib = {
				buf: this.device.createBuffer({
					id: `${this.id}-rows-${key}`,
					usage: BUF_USAGE.VERTEX | BUF_USAGE.COPY_DST,
					byteLength: cap * 4,
				}),
				cap,
			};
			this.instBufs.set(key, ib);
		}
		if (!sameRows(ib.rows, rows)) {
			ib.rows = Uint32Array.from(rows);
			ib.buf.write(ib.rows);
		}
		return ib;
	}

	/** The GPU cull applies: WebGPU, ?gpu=on, no custom `cull` hook. */
	private gpuCullWanted() {
		return (
			this.device.type === "webgpu" &&
			!this.cull &&
			gpuEnabled() &&
			!this.gpuCull?.failed
		);
	}

	/** GpuLayerCore.prepass: record the GPU cull of this pass (when it applies and is ready). */
	prepass(ctx: PrepassContext) {
		if (ctx.kind === "screen") return;
		const t0 = performance.now();
		delete this.prepared[ctx.kind];
		if (!this.gpuCullWanted() || !this.store.slots.size) return;
		this.gpuCull ??= new TerrainGpuCull(this.device);
		if (this.cullDirty) {
			this.cullDirty = false;
			const cands: {
				sphere: [number, number, number, number];
				row: number;
				seg: number;
			}[] = [];
			for (const t of this.tiles) {
				const s = this.store.slots.get(t);
				if (s && t.grid)
					cands.push({ sphere: t.grid.sphere, row: s.row, seg: t.seg });
			}
			this.cullUnsupported = !this.gpuCull.setCandidates(cands);
		}
		if (this.cullUnsupported) return;
		const draw = this.gpuCull.prepare(ctx.commandEncoder, ctx.camera);
		if (draw)
			this.prepared[ctx.kind] = {
				draw,
				encoder: ctx.commandEncoder,
				camera: ctx.camera,
				ms: performance.now() - t0,
			};
	}

	/** Visible table rows per seg, near → far (the set's order), CPU sphere cull. */
	private visibleRows(ctx: PassContext, kind: "geometry" | "color") {
		const custom = this.cull?.(ctx, this.tiles);
		if (custom) return custom;
		const groups = new Map<number, number[]>();
		let culled = 0;
		for (const t of this.tiles) {
			const s = this.store.slots.get(t);
			if (!s || !t.grid) continue;
			const [cx, cy, cz, r] = t.grid.sphere;
			// the WebGL path's pad (sphereCuller / matrixCuller): r·1.02 + 1
			if (!sphereInView(ctx.camera, [cx, cy, cz, r * 1.02 + 1])) {
				culled++;
				continue;
			}
			const g = groups.get(t.seg);
			if (g) g.push(s.row);
			else groups.set(t.seg, [s.row]);
		}
		this.stats.culled[kind] = culled;
		return groups;
	}

	draw(ctx: PassContext) {
		if (ctx.kind === "screen" || !this.store.slots.size) return;
		const t0 = performance.now();
		const kind = ctx.kind;
		// the prepass's GPU cull, if it was recorded for THIS pass (same encoder, same camera)
		const prep = this.prepared[kind];
		delete this.prepared[kind];
		const culled =
			prep &&
			prep.encoder === ctx.device.commandEncoder &&
			prep.camera === ctx.camera
				? prep
				: null;
		const model = this.model(kind);
		const L = this.look;
		model.shaderInputs.setProps({
			camera: ctx.camera,
			fog: L.fog,
			terrain: {
				reliefC0: L.relief.c0,
				reliefC1: L.relief.c1,
				reliefDE: L.relief.de,
				elevRange: L.elevRange,
				rampN: L.relief.n,
				style: L.style === "imagery" && this.imagery ? 1 : 0,
				nearDiscard: kind === "geometry" ? L.nearDiscard : 0,
				pad0: 0,
				pad1: 0,
				pad2: 0,
			},
		} as never);
		const bindings: Record<string, unknown> = {
			heightSmall: this.store.small.texture,
			heightBig: this.store.big.texture,
			baseGrid: this.store.base,
			tileTable: this.store.table,
		};
		if (kind === "color") {
			bindings.imagery = this.imagery?.texture ?? this.emptyArray();
			bindings.imagerySmall = this.imagery?.textureSmall ?? this.emptyArray();
			const uniforms: Record<string, unknown> = {};
			for (const p of [
				...(this.shading ? [this.shading] : []),
				...this.plugins,
			]) {
				const r = p.props?.(ctx);
				Object.assign(uniforms, r?.uniforms);
				Object.assign(bindings, r?.bindings);
			}
			if (Object.keys(uniforms).length)
				model.shaderInputs.setProps(uniforms as never);
		}
		model.setBindings(bindings as never);

		if (culled) {
			if (!this.drawCulledBundled(model, culled.draw, ctx))
				this.drawCulled(model, culled.draw, ctx);
			this.stats.cpuMs[kind] = culled.ms + performance.now() - t0;
			return;
		}
		model.setIndirectBuffer(null);
		if (getFlag("renderBundles") === "on") {
			// CPU-culled instance buffers change with the visible set: not bundled
			this.stats.bundles[kind].direct++;
			this.stats.bundles[kind].last = "direct";
		}
		let drawn = 0;
		let draws = 0;
		let tris = 0;
		for (const [seg, rows] of this.visibleRows(ctx, kind)) {
			if (!rows.length) continue;
			const ib = this.indexBuf(seg);
			const inst = this.instBuf(kind, seg, rows);
			model.setAttributes({ row: inst.buf });
			model.setIndexBuffer(ib.buf);
			model.setIndexCount(ib.count);
			model.setInstanceCount(rows.length);
			model.draw(ctx.renderPass);
			drawn += rows.length;
			draws++;
			tris += (ib.count / 3) * rows.length;
		}
		this.stats.drawn[kind] = drawn;
		this.stats.draws[kind] = draws;
		if (kind === "color") this.stats.triangles = tris;
		this.stats.cullPath[kind] = "cpu";
		this.stats.cpuMs[kind] = performance.now() - t0;
	}

	/**
	 * The GPU-culled draws: one drawIndexedIndirect per draw slot, in the CPU path's group order
	 * (the compaction orders the slots by first visible tile), each with its slot's instance buffer.
	 * Empty slots draw nothing (instanceCount 0 in the record).
	 */
	private drawCulled(model: Model, d: CulledDraw, ctx: PassContext) {
		this.encodeCulled(model, d, ctx.renderPass);
		this.noteCulledDraw(d, ctx.kind as "geometry" | "color");
	}

	private noteCulledDraw(d: CulledDraw, kind: "geometry" | "color") {
		this.stats.drawn[kind] = this.store.slots.size;
		this.stats.culled[kind] = -1;
		this.stats.draws[kind] = d.slots;
		this.stats.cullPath[kind] = "gpu";
	}

	/** One drawIndexedIndirect per slot into a pass or a bundle encoder; false if a draw was skipped. */
	private encodeCulled(
		model: Model,
		d: CulledDraw,
		target: RenderPass | RenderBundleEncoder,
	) {
		let complete = true;
		model.setIndexBuffer(d.index);
		model.setIndexCount(d.indexCount);
		for (let s = 0; s < d.slots; s++) {
			model.setAttributes({ row: d.inst[s] });
			model.setIndirectBuffer(d.args, s * d.recordBytes);
			if (!model.draw(target)) complete = false;
		}
		model.setIndirectBuffer(null);
		return complete;
	}

	/**
	 * ?renderBundles=on: replay the culled draws from a recorded bundle (one set per kind; the MSAA
	 * and the interactive 1x colour passes are two variants, and two Models). Returns false when the
	 * flag is off or no complete bundle exists yet, and the caller then draws directly. Everything
	 * a bundle bakes is in `keys`: model, pipeline, vertex array and every binding (heights, base
	 * grid, tile table, imagery, plugin textures, uniform buffers), the draw buffers and counts, and
	 * the target size. Uniform CONTENTS are not baked, but Model.draw would have flushed the shader
	 * inputs and a replay does not, so flush them here.
	 */
	private drawCulledBundled(model: Model, d: CulledDraw, ctx: PassContext) {
		if (
			this.device.type !== "webgpu" ||
			getFlag("renderBundles") !== "on" ||
			typeof this.device.createRenderBundleEncoder !== "function"
		)
			return false;
		const kind = ctx.kind as "geometry" | "color";
		const counters = this.stats.bundles[kind];
		let set = this.bundleSets[kind];
		if (!set) {
			set = new RenderBundleSet(
				this.device,
				`${this.id}-${kind}`,
				(encoder) => {
					const source = this.bundleSource;
					return source
						? this.encodeCulled(source.model, source.draw, encoder)
						: false;
				},
			);
			this.bundleSets[kind] = set;
		}
		model.updateShaderInputs();
		const keys = [
			...modelBundleKeys(model),
			d.index,
			d.indexCount,
			d.args,
			d.recordBytes,
			d.slots,
			...d.inst,
			ctx.target.width,
			ctx.target.height,
		];
		const before = set.stats;
		this.bundleSource = { model, draw: d };
		let ok = false;
		try {
			ok = set.execute(
				ctx.renderPass,
				{
					colorFormats: ctx.target.colorFormats as never,
					depthFormat: (ctx.target.depthFormat ?? false) as never,
					sampleCount: ctx.target.samples,
				},
				keys,
			);
		} finally {
			this.bundleSource = null;
		}
		const after = set.stats;
		counters.hits = after.hits;
		counters.records = after.records;
		counters.incomplete = after.incomplete;
		if (ok) {
			counters.last = after.records > before.records ? "record" : "hit";
			this.noteCulledDraw(d, kind);
		} else {
			counters.direct++;
			counters.last = "direct";
		}
		return ok;
	}

	private emptyArray() {
		this.empty ??= this.device.createTexture({
			id: `${this.id}-empty-array`,
			dimension: "2d-array",
			format: "rgba8unorm-srgb",
			width: 1,
			height: 1,
			depth: 1,
		});
		return this.empty;
	}

	destroy() {
		this.gpuCull?.destroy();
		this.gpuCull = null;
		this.prepared = {};
		for (const set of Object.values(this.bundleSets)) set.destroy();
		this.bundleSets = {};
		this.models.destroy();
		for (const b of this.indexBufs.values()) b.buf.destroy();
		this.indexBufs.clear();
		for (const b of this.instBufs.values()) b.buf.destroy();
		this.instBufs.clear();
		this.store.destroy();
		this.empty?.destroy();
		this.tiles = [];
	}
}

/**
 * Factory (the assembler's entry point). Wiring:
 *   const terrain = createBatchedTerrain(host.device, imagery);
 *   terrain.look = {...};
 *   streamer onUpdate: terrain.setTiles(set.tiles)  // meshes must carry `grid`
 *   imagery.onChange / after imagery.sync: terrain.syncImageryLayers()
 *   host.cores = [terrain, …]
 */
export function createBatchedTerrain(
	device: Device,
	imagery: ImageryArray | null,
	id?: string,
) {
	return new BatchedTerrainCore(device, imagery, id);
}

/**
 * The tile's base nodes interleaved with the ellipsoid normal at each node, in the frame's ENU
 * (geodesy.ts EnuFrame rows; the WebGL shader's upAt, evaluated in double on the CPU):
 * per node [e, n, u', 0, upE, upN, upU, 0].
 */
function baseWithUp(g: BatchGrid) {
	const n = g.G + 1;
	const out = new Float32Array(n * n * 8);
	const f0 = (g.frameLat * Math.PI) / 180;
	const s0 = Math.sin(f0);
	const c0 = Math.cos(f0);
	for (let j = 0; j < n; j++) {
		const lat = Math.atan(Math.sinh(g.merc0 - (j / g.G) * g.mercSpan));
		const sp = Math.sin(lat);
		const cp = Math.cos(lat);
		for (let i = 0; i < n; i++) {
			const dl = g.dlon0 + (i / g.G) * g.dlonSpan;
			const cdl = Math.cos(dl);
			const k = j * n + i;
			out[k * 8] = g.base[k * 4];
			out[k * 8 + 1] = g.base[k * 4 + 1];
			out[k * 8 + 2] = g.base[k * 4 + 2];
			out[k * 8 + 4] = cp * Math.sin(dl);
			out[k * 8 + 5] = c0 * sp - s0 * cp * cdl;
			out[k * 8 + 6] = s0 * sp + c0 * cp * cdl;
		}
	}
	return out;
}

function sameRows(a: Uint32Array | undefined, b: number[]) {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
