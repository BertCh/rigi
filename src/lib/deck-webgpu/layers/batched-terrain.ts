// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Batched terrain on WebGPU (port of deck/batched-terrain-layer.ts + batched-terrain-grid.ts;
// README.md "Ports"). Every streamed DEM tile is drawn by ONE instanced, indexed draw per mesh
// resolution (64 / 128 / 256 segments) and pass, with no CPU mesh:
//   - heights:   r32float 2d-arrays (256² layers for ≤ 256 px tiles, 512² for the near tiles), read
//                with textureLoad in the vertex shader (no filtering; the bilinear is dem/grid.ts
//                sampleGrid, done by hand)
//   - base grid: a read-only storage buffer, one fixed slot of 2·(BASE_MAX+1)² vec4 per tile row:
//                per node the ENU of the h = 0 surface (batched-terrain-grid.ts buildBatchGrid) and
//                the ellipsoid up vector (CPU, double; replaces the WebGL shader's per-vertex trig)
//   - tile table: a read-only storage buffer, one 48-byte TileRow per tile (height layer, size,
//                seg, skirt | Mercator / lon params | G, big, imagery layer)
//   - instances: per (pass kind, seg) a compact uint32 vertex buffer of the visible tiles' table
//                rows (CPU-culled with the grid's bounding sphere), step mode "instance"
//   - vertices:  none. (i, j, skirt) come from @builtin(vertex_index) in gridMesh's vertex order
//                (grid rows, then the four edge copies); the index buffer is gridMesh's, so the
//                triangulation (and the double-sided skirts) are buildMesh's.
// The vertex stage rebuilds buildMesh's position, central-difference normal, uv and elevation and
// writes terrain.ts's Varyings; the program is terrainSource(BATCHED_VERTEX_WGSL, shading, plugins)
// with terrainModules / terrainDefines, so the geometry pass, the default hillshade / imagery look,
// terrain styles and drape / truth plugins apply unchanged (same fragment stages as TerrainCore).
// Imagery is the shared ImageryArray: the tile's layer sits in its table row (one 4-byte write
// per change), so the colour pass needs no per-image-size grouping (the WebGL path did).
//
// The streamer must build batch grids: terrain=batched (lite meshes, empty vertex arrays; the
// per-tile TerrainCore skips those) or __RIGI_TERRAIN_BOTH__ (both representations, parity A/B).
// Tiles without `grid` are ignored here.
//
// Device note: the height arrays are bound as texture_2d_array<f32> (luma 9.4 derives sampleType
// "float" from the WGSL), which accepts r32float only with the 'float32-filterable' feature;
// device.ts requests it (Apple / Metal has it). Same constraint as every rgba32float binding in the
// foundation.
//
// luma 10: nothing deck-specific here; Model / Buffer / Texture / ShaderModule only.
import type { Buffer, Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import {
	BASE_MAX,
	type BatchGrid,
	gridMesh,
} from "#/lib/deck/batched-terrain-grid";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { EARTH_R, REFRACTION_K } from "#/lib/geodesy";
import { sphereInView } from "../camera";
import type { ImageryArray } from "../imagery";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import {
	DEFAULT_TERRAIN_LOOK,
	type TerrainLook,
	type TerrainShaderPart,
	terrainDefines,
	terrainModules,
	terrainSource,
} from "../terrain";

// ---------- WGSL ----------

const SMALL = 256;
const BIG = 512;
/** vec4s per base-grid slot: 2 per node (base, up) × the largest grid, (BASE_MAX + 1)². */
const BASE_SLOT = 2 * (BASE_MAX + 1) * (BASE_MAX + 1);
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
  // base cells G, big (1 = 512² pool), imagery layer (−1 none), 0
  t2: vec4<f32>,
};

@group(0) @binding(auto) var heightSmall: texture_2d_array<f32>;
@group(0) @binding(auto) var heightBig: texture_2d_array<f32>;
@group(0) @binding(auto) var<storage, read> baseGrid: array<vec4<f32>>;
@group(0) @binding(auto) var<storage, read> tileTable: array<TileRow>;

const BT_EARTH_R: f32 = ${f32(EARTH_R)};
const BT_REFRACTION_K: f32 = ${f32(REFRACTION_K)};
const BT_BASE_SLOT: u32 = ${BASE_SLOT}u;

struct BatchTile {
  row: u32,
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
  let o = t.row * BT_BASE_SLOT + 2u * (u32(c.y) * n + u32(c.x));
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
  t.row = row;
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

type Slot = { row: number; layer: number; big: boolean };

/** A growable r32float 2d-array with a free list of layers. Growing re-creates it (callers
 * re-upload). */
class HeightPool {
	tex: Texture;
	cap: number;
	private free: number[] = [];
	private next = 0;
	constructor(
		private device: Device,
		private id: string,
		readonly size: number,
		cap: number,
	) {
		this.cap = cap;
		this.tex = this.create(cap);
	}
	private create(cap: number) {
		return this.device.createTexture({
			id: this.id,
			dimension: "2d-array",
			format: "r32float",
			width: this.size,
			height: this.size,
			depth: cap,
			usage: TEX_USAGE.SAMPLE | TEX_USAGE.COPY_DST | TEX_USAGE.COPY_SRC,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
	}
	alloc() {
		return this.free.pop() ?? this.next++;
	}
	release(i: number) {
		this.free.push(i);
	}
	/** Room for layer indices < need; true = re-created (contents lost). */
	reserve(need: number, max: number) {
		if (need <= this.cap) return false;
		const cap = Math.min(max, Math.max(need, Math.ceil(this.cap * 1.5)));
		if (cap === this.cap) return false;
		this.tex.destroy();
		this.cap = cap;
		this.tex = this.create(cap);
		return true;
	}
	write(i: number, data: Float32Array, w: number) {
		this.tex.writeData(data as never, {
			x: 0,
			y: 0,
			z: i,
			width: w,
			height: w,
			depthOrArrayLayers: 1,
			bytesPerRow: w * 4,
		});
	}
	destroy() {
		this.tex.destroy();
	}
}

/** Heights, base grids and the tile table for the rendered set (by TileMesh identity). */
class TileStore {
	small: HeightPool;
	big: HeightPool;
	base!: Buffer;
	table!: Buffer;
	private tableData: Float32Array;
	rowsCap = 0;
	private freeRows: number[] = [];
	private nextRow = 0;
	readonly slots = new Map<TileMesh, Slot>();
	private readonly maxLayers: number;
	private readonly maxRows: number;
	/** Tiles dropped for lack of layers / rows (device limits). */
	overflow = 0;

	constructor(private device: Device) {
		const lim = device.limits as {
			maxTextureArrayLayers?: number;
			maxStorageBufferBindingSize?: number;
		};
		this.maxLayers = lim.maxTextureArrayLayers || 256;
		this.maxRows = Math.max(
			16,
			Math.floor(
				(lim.maxStorageBufferBindingSize ?? 128 * 2 ** 20) / (BASE_SLOT * 16),
			),
		);
		this.small = new HeightPool(device, "bterrain-h256", SMALL, 128);
		this.big = new HeightPool(device, "bterrain-h512", BIG, 16);
		this.tableData = new Float32Array(0);
		this.growRows(128);
	}

	/** (Re)create the row buffers for `cap` rows; true when they were re-created. */
	private growRows(need: number) {
		if (need <= this.rowsCap) return false;
		const cap = Math.min(
			this.maxRows,
			Math.max(need, Math.ceil(this.rowsCap * 1.5)),
		);
		if (cap === this.rowsCap) return false;
		this.base?.destroy();
		this.table?.destroy();
		this.base = this.device.createBuffer({
			id: "bterrain-base",
			usage: BUF_USAGE.STORAGE | BUF_USAGE.COPY_DST,
			byteLength: cap * BASE_SLOT * 16,
		});
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

	/** Upload what's new in `tiles`, free what's gone. `layerOf` = imagery layer per tile id. */
	sync(tiles: readonly TileMesh[], layerOf: (id: string) => number) {
		const want = new Set(tiles.filter((t) => t.grid && t.size <= BIG));
		for (const [m, s] of this.slots)
			if (!want.has(m)) {
				this.slots.delete(m);
				this.freeRows.push(s.row);
				(s.big ? this.big : this.small).release(s.layer);
			}
		const fresh = [...want].filter((m) => !this.slots.has(m));
		if (!fresh.length) return;
		for (const m of fresh) {
			const big = m.size > SMALL;
			this.slots.set(m, {
				row: this.freeRows.pop() ?? this.nextRow++,
				layer: (big ? this.big : this.small).alloc(),
				big,
			});
		}
		let maxSmall = 0;
		let maxBig = 0;
		let maxRow = 0;
		for (const s of this.slots.values()) {
			if (s.big) maxBig = Math.max(maxBig, s.layer + 1);
			else maxSmall = Math.max(maxSmall, s.layer + 1);
			maxRow = Math.max(maxRow, s.row + 1);
		}
		const reSmall = this.small.reserve(maxSmall, this.maxLayers);
		const reBig = this.big.reserve(maxBig, this.maxLayers);
		const reRows = this.growRows(maxRow);
		const freshSet = new Set(fresh);
		this.overflow = 0;
		for (const [m, s] of this.slots) {
			const pool = s.big ? this.big : this.small;
			if (s.layer >= pool.cap || s.row >= this.rowsCap) {
				// past a device limit: not drawn
				this.slots.delete(m);
				this.freeRows.push(s.row);
				pool.release(s.layer);
				this.overflow++;
				continue;
			}
			const isFresh = freshSet.has(m);
			if (isFresh || (s.big ? reBig : reSmall))
				pool.write(s.layer, m.heights, m.size);
			const g = m.grid;
			if (!g) continue;
			if (isFresh || reRows) {
				this.base.write(baseWithUp(g), s.row * BASE_SLOT * 16);
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
						0,
					],
					s.row * ROW_FLOATS,
				);
			}
		}
		this.table.write(this.tableData);
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
	/** the tile object's slot, or null when it is not resident (no grid, over a device limit, not yet synced) */
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
};

/**
 * The batched terrain as a GpuLayerCore (geometry + colour passes). Drop-in for TerrainCore:
 * same `look`, `setShaderParts`, `setTiles`, `syncImageryLayers`, `stats` shape (plus draws).
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
	 * Optional culling override (GPU culling by mt-image-03's compute core, when it exists):
	 * return the visible rows per seg for this pass, or null to use the CPU sphere cull.
	 * TODO(mt-image-03): src/lib/gpu/core compute cull → an indirect-draw buffer.
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
	};

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
			small: small.tex,
			big: big.tex,
			slotOf: (t) => {
				const s = slots.get(t as TileMesh);
				return s ? { layer: s.layer, big: s.big } : null;
			},
		};
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
		const kind = ctx.kind;
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
			heightSmall: this.store.small.tex,
			heightBig: this.store.big.tex,
			baseGrid: this.store.base,
			tileTable: this.store.table,
		};
		if (kind === "color") {
			bindings.imagery = this.imagery?.texture ?? this.emptyArray();
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
 * Factory (the assembler's entry point). Wiring, in place of TerrainCore:
 *   const terrain = createBatchedTerrain(host.device, imagery);
 *   terrain.look = {...};                         // same TerrainLook as TerrainCore
 *   streamer onUpdate: terrain.setTiles(set.tiles) // meshes must carry `grid`: set the terrain
 *                                                  // flag to "batched" (lite meshes) instead of
 *                                                  // "tiles", or __RIGI_TERRAIN_BOTH__ for A/B
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
