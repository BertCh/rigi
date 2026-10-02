// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Batched terrain for the deck backend (opt-in: terrain-mode.ts, ?terrain=batched).
//
// The per-tile path (terrain-layer.ts TerrainTileLayer) is one layer + luma Model + mesh buffers
// per tile, ~350 of them, each re-submitted by every pass at ~30 µs of CPU. Here every tile is
// drawn by ONE instanced draw per mesh resolution (64 / 128 / 256 segments):
//   - heights: r32float texture arrays (256² layers for ≤ 256 px tiles, 512² for the near tiles),
//   - base grid: rgba32float array, the ENU of the h = 0 surface per tile (batched-terrain-grid.ts),
//   - tile table: rgba32float, one row per tile (layer, size, seg, skirt, Mercator / lon params),
//   - one shared grid mesh per resolution with buildMesh's triangulation and skirts; the per-
//     instance attribute is the tile's table row.
// The vertex shader rebuilds buildMesh's position, central-difference normal, uv and elevation,
// and the fragment shader is terrain-layer.ts's own (same uniforms, same passes, same ENU / log
// depth), so every pass (geometry, normal, colour, canvas) works unchanged.
//
// Imagery (the satellite / topo drape, props.imagery): fixed-size pages of rgba8 2d-array textures
// with mipmaps (≈ 96 MB each, one image size per page), the tile's layer in its table row. Tiles
// that leave props.imagery keep their layer up to a byte budget (imageryBudget), so the world view's
// imagery survives a trip to the photo view. The colour / canvas passes of the imagery style draw one
// instanced draw per (resolution, page), plus one for the tiles whose image hasn't arrived yet
// (hasMap 0); the geometry and normal passes ignore it.
import { Layer, type LayerProps, type UpdateParameters } from "@deck.gl/core";
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { Pose } from "../camera";
import { getCpuHeights } from "../dem/cpu-heights";
import { poseBasis } from "../pose";
import { BASE_MAX, gridMesh } from "./batched-terrain-grid";
import { SlotAllocator } from "./slot-allocator";
import type { TileMesh } from "./terrain-data";
import {
	currentTerrainPass,
	fs,
	setTerrainShaderProps,
	type TerrainDrawProps,
	terrainShaders,
	terroirFs,
} from "./terrain-layer";
import { terrainDrawStats } from "./terrain-mode";

// the shared fragment shader, sampling the imagery from its texture array layer. Built lazily:
// terrain-layer.ts imports this module, so its `fs` is not initialised yet at our module load.
let fsBatchedSrc: string | null = null;
const fsBatched = () =>
	(fsBatchedSrc ??= [
		[
			"uniform sampler2D terrainMap;",
			"uniform highp sampler2DArray terrainMaps;\nflat in float vMapLayer;",
		],
		["texture(terrainMap, vUv)", "texture(terrainMaps, vec3(vUv, vMapLayer))"],
		[
			"textureLod(terrainMap, vUv, 3.0)",
			"textureLod(terrainMaps, vec3(vUv, vMapLayer), 3.0)",
		],
	].reduce((src, [a, b]) => {
		if (!src.includes(a)) throw new Error(`batched terrain: fs has no "${a}"`);
		return src.replace(a, b);
	}, fs));

const batchModule = {
	name: "batch",
	vs: /* glsl */ `\
layout(std140) uniform batchUniforms {
  vec4 frame;
  float rowBase;
} batch;
`,
	uniformTypes: {
		frame: "vec4<f32>",
		rowBase: "f32",
	},
} as const satisfies ShaderModule;

type BatchModuleProps = {
	/** sin φ0, cos φ0 of the ENU frame origin. */
	frame: number[];
	/** Added to the per-instance row (per-tile draws: instance row 0 + rowBase = the tile). */
	rowBase: number;
	heightSmall: Texture;
	heightBig: Texture;
	baseGrid: Texture;
	tileTable: Texture;
	terrainMaps: Texture;
};

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME terrain-batched-vs
precision highp float;
precision highp int;
uniform highp sampler2DArray heightSmall;
uniform highp sampler2DArray heightBig;
uniform highp sampler2DArray baseGrid;
uniform highp sampler2D tileTable;
// per vertex: grid column, grid row (0..seg, row 0 = north), 1 = skirt copy
in vec3 grid;
// per instance: the tile's row in tileTable
in float row;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out float vElev;
out float vLogW;
out vec3 vCamera;
flat out float vMapLayer;

const float EARTH_R = 6371008.8;
const float REFRACTION_K = 0.13;

int tRow;
int tLayer;
bool tBig;
float tSize;
float tSeg;
float tSkirt;
float tG;
vec4 tGeo; // Mercator angle at the north edge, its span, west lon − frame lon, lon span (rad)

float hTexel(int x, int y) {
  return tBig ? texelFetch(heightBig, ivec3(x, y, tLayer), 0).r
              : texelFetch(heightSmall, ivec3(x, y, tLayer), 0).r;
}

// dem/grid.ts sampleGrid: bilinear on the pixel-centred S×S grid at pixel coords (0..S)
float sampleH(float px, float py) {
  float m = tSize - 1.0;
  float x = clamp(px - 0.5, 0.0, m);
  float y = clamp(py - 0.5, 0.0, m);
  float x0 = floor(x);
  float y0 = floor(y);
  int ix0 = int(x0);
  int iy0 = int(y0);
  int ix1 = int(min(x0 + 1.0, m));
  int iy1 = int(min(y0 + 1.0, m));
  float fx = x - x0;
  float fy = y - y0;
  float a = hTexel(ix0, iy0) * (1.0 - fx) + hTexel(ix1, iy0) * fx;
  float b = hTexel(ix0, iy1) * (1.0 - fx) + hTexel(ix1, iy1) * fx;
  return a * (1.0 - fy) + b * fy;
}

// ENU of the h = 0 surface at tile fraction f (batched-terrain-grid.ts: bilinear between the
// base nodes, the curvature drop re-added analytically)
vec3 baseAt(vec2 f) {
  vec2 g = f * tG;
  vec2 c = min(floor(g), vec2(tG - 1.0));
  vec2 t = g - c;
  ivec2 i = ivec2(c);
  vec3 b00 = texelFetch(baseGrid, ivec3(i, tRow), 0).xyz;
  vec3 b10 = texelFetch(baseGrid, ivec3(i + ivec2(1, 0), tRow), 0).xyz;
  vec3 b01 = texelFetch(baseGrid, ivec3(i + ivec2(0, 1), tRow), 0).xyz;
  vec3 b11 = texelFetch(baseGrid, ivec3(i + ivec2(1, 1), tRow), 0).xyz;
  vec3 b = mix(mix(b00, b10, t.x), mix(b01, b11, t.x), t.y);
  b.z -= dot(b.xy, b.xy) / (2.0 * EARTH_R);
  return b;
}

// the ellipsoid normal at tile fraction f, in the frame's ENU (rows of geodesy.ts EnuFrame.r)
vec3 upAt(vec2 f) {
  float lat = atan(sinh(tGeo.x - f.y * tGeo.y));
  float dl = tGeo.z + f.x * tGeo.w;
  float sp = sin(lat);
  float cp = cos(lat);
  float cdl = cos(dl);
  return vec3(cp * sin(dl), batch.frame.y * sp - batch.frame.x * cp * cdl, batch.frame.x * sp + batch.frame.y * cp * cdl);
}

// buildMesh's vertex (i, j): ENU position (xyz, geodesy.ts fromGeo) and elevation (w)
vec4 vertexAt(float i, float j) {
  vec2 f = vec2(i, j) / tSeg;
  float h = sampleH(f.x * tSize, f.y * tSize);
  vec3 p = baseAt(f) + h * upAt(f);
  p.z += REFRACTION_K * dot(p.xy, p.xy) / (2.0 * EARTH_R);
  return vec4(p, h);
}

void main() {
  tRow = int(row + batch.rowBase + 0.5);
  vec4 t0 = texelFetch(tileTable, ivec2(0, tRow), 0);
  tGeo = texelFetch(tileTable, ivec2(1, tRow), 0);
  vec4 t2 = texelFetch(tileTable, ivec2(2, tRow), 0);
  tLayer = int(t0.x + 0.5);
  tSize = t0.y;
  tSeg = t0.z;
  tSkirt = t0.w;
  tG = t2.x;
  tBig = t2.y > 0.5;
  vMapLayer = t2.z;

  float i = grid.x;
  float j = grid.y;
  vec4 v = vertexAt(i, j);
  // buildMesh's grid normals: central differences, clamped at the tile edge. Style 3 (geometry
  // pass) writes the range only and never reads vNormal (terrain-layer.ts fs returns early), so the
  // four neighbour fetches are skipped there; the uniform branch is coherent across the draw.
  vec3 nrm = vec3(0.0, 0.0, 1.0);
  if (int(terrain.style + 0.5) != 3) {
    vec3 e = vertexAt(min(i + 1.0, tSeg), j).xyz - vertexAt(max(i - 1.0, 0.0), j).xyz;
    vec3 s = vertexAt(i, max(j - 1.0, 0.0)).xyz - vertexAt(i, min(j + 1.0, tSeg)).xyz;
    nrm = cross(e, s);
    float len = length(nrm);
    nrm = len > 0.0 ? nrm / len : nrm;
  }
  vec3 positions = v.xyz;
  float elev = v.w;
  if (grid.z > 0.5) {
    // skirt: the edge vertex dropped straight down
    positions.z -= tSkirt;
    elev -= tSkirt;
  }

  vWorld = positions;
  vCamera = project.cameraPosition + project.coordinateOrigin;
  vNormal = nrm;
  vUv = vec2(i, j) / tSeg;
  vElev = elev;
  vec4 posCommon;
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0), posCommon);
  vLogW = 1.0 + max(gl_Position.w, 1e-6);
}
`;

// ---------- GPU store: height / base texture arrays + tile table ----------

const SMALL = 256;
const BIG = 512;
const TABLE_W = 3;
const NEAREST = {
	minFilter: "nearest",
	magFilter: "nearest",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
} as const;

type Slot = { row: number; layer: number; big: boolean };

/** A growable 2d-array texture with a free list of layers. */
class LayerPool {
	tex: Texture;
	cap: number;
	private slots: SlotAllocator;
	constructor(
		private device: Device,
		private id: string,
		private format: "r32float" | "rgba32float",
		private size: number,
		cap: number,
		/** The device's array layer limit: alloc() is -1 past it (the pool can never hold more). */
		limit = Number.POSITIVE_INFINITY,
	) {
		this.slots = new SlotAllocator(limit);
		this.cap = cap;
		this.tex = this.create(cap);
	}
	private create(cap: number) {
		return this.device.createTexture({
			id: this.id,
			dimension: "2d-array",
			format: this.format,
			width: this.size,
			height: this.size,
			depth: cap,
			sampler: NEAREST,
		});
	}
	get used() {
		return this.slots.used;
	}
	/** A free layer index, or -1 at the layer limit. */
	alloc(): number {
		return this.slots.alloc();
	}
	release(i: number) {
		this.slots.release(i);
	}
	/** Make room for layer indices < `need`; true = the texture was re-created (contents lost). */
	reserve(need: number, max: number): boolean {
		if (need <= this.cap) return false;
		const cap = Math.min(max, Math.max(need, Math.ceil(this.cap * 1.5)));
		this.tex.destroy();
		this.cap = cap;
		this.tex = this.create(cap);
		return true;
	}
	write(i: number, data: Float32Array, w: number, h: number) {
		this.tex.writeData(data, {
			x: 0,
			y: 0,
			z: i,
			width: w,
			height: h,
			depthOrArrayLayers: 1,
		});
	}
	destroy() {
		this.tex.destroy();
	}
}

// makeTexture's sampler (terrain-layer.ts): trilinear, 8× anisotropic
const MAP_SAMPLER = {
	minFilter: "linear",
	magFilter: "linear",
	mipmapFilter: "linear",
	addressModeU: "clamp-to-edge",
	addressModeV: "clamp-to-edge",
	maxAnisotropy: 8,
} as const;

/** Bytes of one mipmapped rgba8 layer of a w × h image. */
function layerBytes(w: number, h: number) {
	return Math.round(w * h * 4 * (4 / 3));
}

/**
 * Imagery budget knobs (see TileStore.syncMaps):
 *  - pageBytes: one imagery page (a fixed-size 2d-array texture) holds about this much, so a page
 *    never grows (growing re-uploaded everything it held) and pages free one by one;
 *  - retainBytes: tiles no longer in props.imagery (the photo view after the world view, tiles the
 *    world camera left) keep their layers up to this much, least recently used first out, so the
 *    next world entry finds them uploaded;
 *  - uploadBytes: canvas-drawn layers (the world view) upload at most this much per frame, the
 *    rest next frame (the tile draws without imagery meanwhile, as while it streams in).
 */
export const imageryBudget = {
	pageBytes: 96 << 20,
	retainBytes: 300 << 20,
	uploadBytes: 32 << 20,
};

/**
 * One page of imagery of one size: a fixed-size, mipmapped rgba8 2d-array texture with a free list
 * of layers. Uploads copy the bitmap once; the page never needs it again.
 */
class MapPage {
	readonly tex: Texture;
	private free: number[] = [];
	private next = 0;
	used = 0;
	private dirty = false;
	constructor(
		private device: Device,
		readonly key: string,
		readonly width: number,
		readonly height: number,
		readonly cap: number,
	) {
		this.tex = device.createTexture({
			id: `terrain-maps-${key}`,
			dimension: "2d-array",
			format: "rgba8unorm",
			width,
			height,
			depth: cap,
			mipLevels: device.getMipLevelCount(width, height),
			sampler: MAP_SAMPLER,
		});
	}
	get full() {
		return this.used >= this.cap;
	}
	get bytes() {
		return this.cap * layerBytes(this.width, this.height);
	}
	/** Copy `image` into a free layer (the page must not be full); the layer. */
	add(image: ImageBitmap): number {
		const i = this.free.pop() ?? this.next++;
		this.used++;
		// makeTexture's upload: no flip, no premultiply, sRGB bytes as-is (the shader decodes)
		this.tex.copyExternalImage({
			image,
			x: 0,
			y: 0,
			z: i,
			width: this.width,
			height: this.height,
			depth: 1,
			flipY: false,
			premultipliedAlpha: false,
		});
		this.dirty = true;
		return i;
	}
	release(i: number) {
		this.free.push(i);
		this.used--;
	}
	/** Rebuild the mip chain after uploads. */
	flush() {
		if (!this.dirty) return;
		this.dirty = false;
		if (this.device.type === "webgl") this.tex.generateMipmapsWebGL();
	}
	destroy() {
		this.tex.destroy();
	}
}

/** A tile's imagery in a page; `gen` = the last syncMaps that had it in props.imagery. */
type MapEntry = {
	image: ImageBitmap;
	page: MapPage;
	layer: number;
	gen: number;
};

/** Diagnostics (globalThis.__rigiTerrainMaps): imagery uploads, retained hits, evictions. */
export const terrainMapStats = {
	uploads: 0,
	uploadBytes: 0,
	hits: 0,
	evicted: 0,
	pages: 0,
	pageBytes: 0,
	retained: 0,
	pending: 0,
};
(
	globalThis as { __rigiTerrainMaps?: typeof terrainMapStats }
).__rigiTerrainMaps = terrainMapStats;

class TileStore {
	small: LayerPool;
	big: LayerPool;
	base: LayerPool;
	table: Texture;
	private tableData: Float32Array;
	private rowsCap: number;
	readonly slots = new Map<TileMesh, Slot>();
	private maxLayers: number;
	/** Imagery pages (any image size), and each tile id's layer in one. */
	readonly pages: MapPage[] = [];
	private maps = new Map<string, MapEntry>();
	/** Tiles whose image waits for an upload (throttled draws), in the set's order. */
	private pending = new Map<string, ImageBitmap>();
	private gen = 0;
	private pageSeq = 0;
	/** Bound as terrainMaps when a draw has no imagery (a sampler2DArray needs an array). */
	readonly emptyMaps: Texture;

	constructor(private device: Device) {
		this.maxLayers = device.limits.maxTextureArrayLayers || 256;
		this.small = new LayerPool(
			device,
			"terrain-h256",
			"r32float",
			SMALL,
			128,
			this.maxLayers,
		);
		this.big = new LayerPool(
			device,
			"terrain-h512",
			"r32float",
			BIG,
			16,
			this.maxLayers,
		);
		this.base = new LayerPool(
			device,
			"terrain-base",
			"rgba32float",
			BASE_MAX + 1,
			128,
			this.maxLayers,
		);
		this.rowsCap = this.base.cap;
		this.tableData = new Float32Array(this.rowsCap * TABLE_W * 4);
		this.table = this.makeTable();
		this.emptyMaps = device.createTexture({
			id: "terrain-maps-empty",
			dimension: "2d-array",
			format: "rgba8unorm",
			width: 1,
			height: 1,
			depth: 1,
			sampler: NEAREST,
		});
	}

	private makeTable() {
		return this.device.createTexture({
			id: "terrain-table",
			format: "rgba32float",
			width: TABLE_W,
			height: this.rowsCap,
			sampler: NEAREST,
		});
	}

	/** Upload what's new in `tiles`, free what's gone. Tiles without a batch grid are skipped. */
	sync(tiles: TileMesh[]) {
		const want = new Set(tiles.filter((t) => t.grid && t.size <= BIG));
		for (const [m, s] of this.slots)
			if (!want.has(m)) {
				this.slots.delete(m);
				this.base.release(s.row);
				(s.big ? this.big : this.small).release(s.layer);
			}
		const fresh = [...want].filter((m) => !this.slots.has(m));
		if (!fresh.length) return;
		for (const m of fresh) {
			const big = m.size > SMALL;
			const pool = big ? this.big : this.small;
			const row = this.base.alloc();
			const layer = pool.alloc();
			if (row < 0 || layer < 0) {
				// at the device's array layer limit: not drawn, and nothing taken stays held (CR-45)
				if (row >= 0) this.base.release(row);
				if (layer >= 0) pool.release(layer);
				continue;
			}
			this.slots.set(m, { row, layer, big });
		}
		// grow (re-upload everything already in a re-created pool)
		const maxOf = (sel: (s: Slot) => number, f?: (s: Slot) => boolean) =>
			Math.max(
				0,
				...[...this.slots.values()].filter(f ?? (() => true)).map(sel),
			) + 1;
		const reSmall = this.small.reserve(
			maxOf(
				(s) => s.layer,
				(s) => !s.big,
			),
			this.maxLayers,
		);
		const reBig = this.big.reserve(
			maxOf(
				(s) => s.layer,
				(s) => s.big,
			),
			this.maxLayers,
		);
		const reBase = this.base.reserve(
			maxOf((s) => s.row),
			this.maxLayers,
		);
		if (reBase) {
			this.rowsCap = this.base.cap;
			const d = new Float32Array(this.rowsCap * TABLE_W * 4);
			d.set(this.tableData);
			this.tableData = d;
			this.table.destroy();
			this.table = this.makeTable();
		}
		for (const [m, s] of this.slots) {
			const isFresh = fresh.includes(m);
			const pool = s.big ? this.big : this.small;
			if (s.layer >= pool.cap || s.row >= this.base.cap) {
				// unreachable while alloc() is limited to maxLayers; keeps the index accounting honest
				this.slots.delete(m);
				this.base.release(s.row);
				pool.release(s.layer);
				continue;
			}
			if (isFresh || (s.big ? reBig : reSmall))
				pool.write(s.layer, m.heights ?? getCpuHeights(m), m.size, m.size);
			const g = m.grid;
			if (!g) continue;
			if (isFresh || reBase) this.base.write(s.row, g.base, g.G + 1, g.G + 1);
			if (isFresh) {
				const o = s.row * TABLE_W * 4;
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
						this.mapLayer(m.id),
						0,
					],
					o,
				);
			}
		}
		this.table.writeData(this.tableData, {
			width: TABLE_W,
			height: this.rowsCap,
		});
	}

	/** Tile `id`'s imagery layer while it is in props.imagery (retained ones: −1). */
	private mapLayer(id: string) {
		const m = this.maps.get(id);
		return m && m.gen === this.gen ? m.layer : -1;
	}

	/**
	 * Imagery per tile id into the pages, and each tile's layer (or −1) into its table row. Call
	 * after sync(). A tile's image stays uploaded while it's in `imagery` (matched by bitmap
	 * identity); once out, it's retained (imageryBudget.retainBytes, least recently used out first,
	 * the latest pages first on a tie), so switching the world view off and on again re-uploads
	 * nothing it kept. `budget` caps this call's upload bytes (the rest waits for pump()).
	 */
	syncMaps(
		tiles: TileMesh[],
		imagery: Map<string, ImageBitmap> | null,
		budget = Number.POSITIVE_INFINITY,
	) {
		const gen = ++this.gen;
		this.pending.clear();
		for (const t of tiles) {
			const image = imagery?.get(t.id);
			// a closed bitmap is 0 × 0
			if (!image?.width || !image.height) continue;
			const cur = this.maps.get(t.id);
			if (cur?.image === image) {
				if (cur.gen < gen - 1) terrainMapStats.hits++;
				cur.gen = gen;
				continue;
			}
			if (cur) this.dropMap(t.id, cur);
			this.pending.set(t.id, image);
		}
		this.evict();
		this.pump(budget, true);
	}

	/** Upload pending imagery, at most `budget` bytes (one at least); true = some still waits. */
	pump(budget: number, force = false): boolean {
		if (!this.pending.size && !force) return false;
		let spent = 0;
		for (const [id, image] of this.pending) {
			if (spent > 0 && spent >= budget) break;
			this.pending.delete(id);
			// closed since (the engine dropped it): the tile goes next sync
			if (!image.width) continue;
			const page = this.pageFor(image.width, image.height);
			if (!page) continue;
			const layer = page.add(image);
			this.maps.set(id, { image, page, layer, gen: this.gen });
			const b = layerBytes(image.width, image.height);
			spent += b;
			terrainMapStats.uploads++;
			terrainMapStats.uploadBytes += b;
		}
		for (const p of this.pages) p.flush();
		this.writeMapLayers();
		terrainMapStats.pending = this.pending.size;
		return this.pending.size > 0;
	}

	/** A page of this image size with a free layer (a new one if none); null past the layer limit. */
	private pageFor(w: number, h: number): MapPage | null {
		const key = `${w}x${h}`;
		for (const p of this.pages)
			if (p.width === w && p.height === h && !p.full) return p;
		const cap = Math.max(
			1,
			Math.min(
				this.maxLayers,
				Math.floor(imageryBudget.pageBytes / layerBytes(w, h)),
			),
		);
		const page = new MapPage(
			this.device,
			`${key}-${this.pageSeq++}`,
			w,
			h,
			cap,
		);
		this.pages.push(page);
		this.pageStats();
		return page;
	}

	private dropMap(id: string, m: MapEntry) {
		m.page.release(m.layer);
		this.maps.delete(id);
	}

	/** Retained imagery over imageryBudget.retainBytes out (LRU), then empty pages. */
	private evict() {
		const old: [string, MapEntry][] = [];
		let bytes = 0;
		for (const e of this.maps)
			if (e[1].gen !== this.gen) {
				old.push(e);
				bytes += layerBytes(e[1].page.width, e[1].page.height);
			}
		if (bytes > imageryBudget.retainBytes) {
			const idx = new Map(this.pages.map((p, i) => [p, i]));
			old.sort(
				(a, b) =>
					a[1].gen - b[1].gen ||
					(idx.get(b[1].page) ?? 0) - (idx.get(a[1].page) ?? 0) ||
					b[1].layer - a[1].layer,
			);
			for (const [id, m] of old) {
				if (bytes <= imageryBudget.retainBytes) break;
				bytes -= layerBytes(m.page.width, m.page.height);
				this.dropMap(id, m);
				terrainMapStats.evicted++;
			}
		}
		// the freed layers are scattered over the pages: whole pages holding only retained imagery
		// then go too (the fewest held first) until those pages fit the budget, so what the view
		// doesn't draw costs at most retainBytes of texture memory
		const live = new Set<MapPage>();
		const held = new Map<MapPage, string[]>();
		for (const [id, m] of this.maps)
			if (m.gen === this.gen) live.add(m.page);
			else held.set(m.page, [...(held.get(m.page) ?? []), id]);
		const idle = this.pages
			.filter((p) => p.used && !live.has(p))
			.sort((a, b) => a.used - b.used);
		let idleBytes = idle.reduce((a, p) => a + p.bytes, 0);
		for (const p of idle) {
			if (idleBytes <= imageryBudget.retainBytes) break;
			idleBytes -= p.bytes;
			for (const id of held.get(p) ?? []) {
				const m = this.maps.get(id);
				if (!m) continue;
				bytes -= layerBytes(m.page.width, m.page.height);
				this.dropMap(id, m);
				terrainMapStats.evicted++;
			}
		}
		for (let i = this.pages.length - 1; i >= 0; i--)
			if (!this.pages[i].used) {
				this.pages[i].destroy();
				this.pages.splice(i, 1);
			}
		terrainMapStats.retained = bytes;
		this.pageStats();
	}

	private pageStats() {
		terrainMapStats.pages = this.pages.length;
		terrainMapStats.pageBytes = this.pages.reduce((a, p) => a + p.bytes, 0);
	}

	private writeMapLayers() {
		let dirty = false;
		for (const [m, s] of this.slots) {
			const o = s.row * TABLE_W * 4 + 10;
			const layer = this.mapLayer(m.id);
			if (this.tableData[o] !== layer) {
				this.tableData[o] = layer;
				dirty = true;
			}
		}
		if (dirty)
			this.table.writeData(this.tableData, {
				width: TABLE_W,
				height: this.rowsCap,
			});
	}

	/** The page holding tile `id`'s imagery (null: none, not yet, or only retained). */
	mapPage(id: string) {
		const m = this.maps.get(id);
		return m && m.gen === this.gen ? m.page : null;
	}

	destroy() {
		this.small.destroy();
		this.big.destroy();
		this.base.destroy();
		this.table.destroy();
		for (const p of this.pages) p.destroy();
		this.pages.length = 0;
		this.maps.clear();
		this.pending.clear();
		this.pageStats();
		this.emptyMaps.destroy();
	}
}

// ---------- the layer ----------

export type BatchedTerrainProps = LayerProps &
	TerrainDrawProps & {
		tiles: TileMesh[];
		/** Opaque change key for the compositor's geometry cache (composite.ts reads props.mesh). */
		mesh: unknown;
		imagery: Map<string, ImageBitmap> | null;
		/** The parent's offscreen (photo view): imagery uploads unthrottled (uploadBudget). */
		offscreen?: boolean;
	};

/** Per-instance row buffers, one per draw group (a Model's attributes are swapped per draw). */
type RowBuf = {
	buf: Buffer;
	cap: number;
	/** The rows last written to `buf` (skips the upload when a pass draws the same set). */
	rows?: Float32Array;
};
type SegModel = { model: Model; bufs: Map<string, RowBuf> };

export class BatchedTerrainTileLayer extends Layer<BatchedTerrainProps> {
	static layerName = "BatchedTerrainTileLayer";
	private lastPump = 0;
	declare state: {
		store?: TileStore;
		segs: Map<number, SegModel>;
		/** deck reads `models` (project uniforms, draw parameters). */
		models: Model[];
		defines: string;
	};

	getShaders() {
		return super.getShaders({
			...terrainShaders(this.props, vs, [batchModule]),
			fs: terroirFs(this.props, fsBatched()),
		});
	}

	initializeState() {
		this.setState({
			store: new TileStore(this.context.device),
			segs: new Map(),
			models: [],
			defines: this.definesKey(),
		});
	}

	private definesKey() {
		return JSON.stringify(terrainShaders(this.props, "").defines ?? null);
	}

	private segModel(seg: number): SegModel {
		const hit = this.state.segs.get(seg);
		if (hit) return hit;
		const { grid, indices } = gridMesh(seg);
		const bufs = new Map<string, RowBuf>();
		const first = this.rowBuf(seg, bufs, "all", 512);
		const model = new Model(this.context.device, {
			...this.getShaders(),
			id: `${this.props.id}-${seg}`,
			geometry: new Geometry({
				topology: "triangle-list",
				indices,
				attributes: { grid: { size: 3, value: grid } },
			}),
			bufferLayout: [{ name: "row", format: "float32", stepMode: "instance" }],
			attributes: { row: first.buf },
			isInstanced: true,
			instanceCount: 0,
		});
		const sm = { model, bufs };
		this.state.segs.set(seg, sm);
		this.state.models = [...this.state.segs.values()].map((s) => s.model);
		return sm;
	}

	/** The row buffer of draw group `key`, grown to hold `n` rows. */
	private rowBuf(
		seg: number,
		bufs: Map<string, RowBuf>,
		key: string,
		n: number,
	): RowBuf {
		const cur = bufs.get(key);
		if (cur && cur.cap >= n) return cur;
		cur?.buf.destroy();
		const cap = Math.max(n, (cur?.cap ?? 256) * 2);
		const rb = {
			buf: this.context.device.createBuffer({
				id: `${this.props.id}-rows-${seg}-${key}`,
				usage: Buffer.VERTEX | Buffer.COPY_DST,
				byteLength: cap * 4,
			}),
			cap,
		};
		bufs.set(key, rb);
		return rb;
	}

	private destroyBufs(s: SegModel) {
		for (const b of s.bufs.values()) b.buf.destroy();
		s.bufs.clear();
	}

	private destroyModels() {
		for (const s of this.state.segs.values()) {
			s.model.destroy();
			this.destroyBufs(s);
		}
		this.state.segs.clear();
		this.state.models = [];
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		if (props.tiles !== oldProps.tiles) this.state.store?.sync(props.tiles);
		const d = this.definesKey();
		if (d !== this.state.defines) {
			// a preset / feature toggle: new programs (the grid meshes are cheap to rebuild)
			this.destroyModels();
			this.state.defines = d;
		}
		if (props.imagery !== oldProps.imagery || props.tiles !== oldProps.tiles)
			this.state.store?.syncMaps(
				props.tiles,
				props.imagery,
				this.uploadBudget(),
			);
	}

	/**
	 * Per-frame imagery upload bytes: the canvas (world view) draws every frame, so a big batch (a
	 * world re-entry, a new imagery source) streams in over a few frames instead of one long task.
	 * Offscreen (photo view) passes are cached by the compositor: everything at once there.
	 */
	private uploadBudget() {
		return this.props.offscreen
			? Number.POSITIVE_INFINITY
			: imageryBudget.uploadBytes;
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		// deck destroys state.models; the row buffers and the store are ours
		for (const s of this.state.segs.values()) this.destroyBufs(s);
		this.state.segs.clear();
		super.finalizeState(context);
		this.state.store?.destroy();
	}

	draw({
		shaderModuleProps,
	}: {
		shaderModuleProps?: {
			project?: {
				viewport?: {
					cameraPosition: number[];
					pose?: Pose;
					eye?: [number, number, number];
					width: number;
					height: number;
				};
			};
		};
	}) {
		const { store } = this.state;
		if (!store) return;
		// throttled imagery uploads (uploadBudget): the next slice, once per frame
		const now = performance.now();
		if (now - this.lastPump > 4) {
			this.lastPump = now;
			if (store.pump(this.uploadBudget())) this.setNeedsRedraw();
		}
		const viewport = (shaderModuleProps?.project?.viewport ??
			this.context.viewport) as {
			cameraPosition: number[];
			pose?: Pose;
			eye?: [number, number, number];
			width: number;
			height: number;
			isGeospatial?: boolean;
			viewProjectionMatrix?: ArrayLike<number>;
		};
		// the photo camera: its pose frustum; any other CARTESIAN camera (world orbit / fly / top-down,
		// step-inside; all ENU WorldViewports): the side planes of its view-projection
		const photoCam = !!(viewport.pose && viewport.eye);
		const cull =
			photoCam && viewport.pose && viewport.eye
				? sphereCuller(
						viewport.pose,
						viewport.eye,
						viewport.width / Math.max(1, viewport.height),
					)
				: batchedCullStats.world &&
						!viewport.isGeospatial &&
						viewport.viewProjectionMatrix
					? matrixCuller(viewport.viewProjectionMatrix)
					: null;
		const pass = currentTerrainPass();
		// imagery: the colour / canvas passes group each resolution's tiles by map pool
		const withMaps =
			this.props.style === "imagery" &&
			pass !== "geometry" &&
			pass !== "normal" &&
			store.pages.length > 0;
		const g = this.props.tiles.find((t) => t.grid)?.grid;
		const DEG = Math.PI / 180;
		const frame = g
			? [Math.sin(g.frameLat * DEG), Math.cos(g.frameLat * DEG), 0, 0]
			: [0, 1, 0, 0];
		const batch: BatchModuleProps = {
			frame,
			rowBase: 0,
			heightSmall: store.small.tex,
			heightBig: store.big.tex,
			baseGrid: store.base.tex,
			tileTable: store.table,
			terrainMaps: store.emptyMaps,
		};
		// visible tiles per resolution (and map pool), in the set's (near → far) order
		const groups = new Map<
			number,
			Map<string, { pool: MapPage | null; rows: number[] }>
		>();
		for (const t of this.props.tiles) {
			const s = store.slots.get(t);
			if (!s || !t.grid) continue;
			if (cull?.(t.grid.sphere)) {
				batchedCullStats.culled++;
				if (!photoCam) batchedCullStats.culledW++;
				continue;
			}
			batchedCullStats.drawn++;
			if (!photoCam) batchedCullStats.drawnW++;
			const pool = withMaps ? store.mapPage(t.id) : null;
			const key = pool ? pool.key : "all";
			let bySeg = groups.get(t.seg);
			if (!bySeg) {
				bySeg = new Map();
				groups.set(t.seg, bySeg);
			}
			const grp = bySeg.get(key);
			if (grp) grp.rows.push(s.row);
			else bySeg.set(key, { pool, rows: [s.row] });
		}
		const renderPass = this.context.renderPass;
		for (const [seg, bySeg] of groups) {
			const sm = this.segModel(seg);
			setTerrainShaderProps(sm.model, this.props, undefined, viewport);
			for (const [key, { pool, rows }] of bySeg) {
				const rb = this.rowBuf(seg, sm.bufs, key, rows.length);
				if (!sameRows(rb.rows, rows)) {
					rb.rows = new Float32Array(rows);
					rb.buf.write(rb.rows);
				}
				sm.model.setAttributes({ row: rb.buf });
				sm.model.setInstanceCount(rows.length);
				sm.model.shaderInputs.setProps({
					terrain: { hasMap: pool ? 1 : 0 },
					batch: { ...batch, terrainMaps: pool?.tex ?? store.emptyMaps },
				});
				terrainDrawStats.draws++;
				sm.model.draw(renderPass);
			}
		}
	}
}

/**
 * Diagnostics for harnesses (globalThis.__rigiBatchedCull): tile instances drawn / culled so far,
 * all passes and (…W) non-photo cameras only; `world: false` turns the non-photo camera culling
 * off (A/B pixel checks).
 */
export const batchedCullStats = {
	drawn: 0,
	culled: 0,
	drawnW: 0,
	culledW: 0,
	world: true,
};
(
	globalThis as { __rigiBatchedCull?: typeof batchedCullStats }
).__rigiBatchedCull = batchedCullStats;

function sameRows(a: Float32Array | undefined, b: number[]) {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * true = the sphere lies entirely outside one of the four side planes of a view-projection
 * (column-major, common space = ENU metres for a CARTESIAN non-geospatial viewport). Near / far are
 * not tested: the terrain writes its own log depth. For a perspective camera the side planes pass
 * through the eye and together imply w ≥ 0, so a sphere behind the camera is culled too. The pad is
 * sphereCuller's (the grid spheres already include skirts, heights and a sag margin).
 */
export function matrixCuller(m: ArrayLike<number>) {
	const planes: number[][] = [];
	for (const [r, sgn] of [
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1],
	] as const) {
		const p = [0, 1, 2, 3].map((c) => m[c * 4 + 3] + sgn * m[c * 4 + r]);
		const n = Math.hypot(p[0], p[1], p[2]);
		if (!(n > 1e-12) || !p.every(Number.isFinite)) return null;
		planes.push(p.map((v) => v / n));
	}
	return ([cx, cy, cz, rad]: [number, number, number, number]) => {
		const pad = rad * 1.02 + 1;
		for (const p of planes)
			if (p[0] * cx + p[1] * cy + p[2] * cz + p[3] < -pad) return true;
		return false;
	};
}

/** true = the sphere lies entirely outside the photo camera's frustum (geometry-pass.ts frustumCuller). */
function sphereCuller(
	pose: Pose,
	eye: [number, number, number],
	aspect: number,
) {
	const { forward: f, right: r, up: u } = poseBasis(pose);
	const ty = Math.tan((pose.vfov * Math.PI) / 360);
	const tx = ty * aspect;
	const nx = Math.hypot(1, tx);
	const ny = Math.hypot(1, ty);
	return ([cx, cy, cz, rad]: [number, number, number, number]) => {
		const dx = cx - eye[0];
		const dy = cy - eye[1];
		const dz = cz - eye[2];
		const z = dx * f.x + dy * f.y + dz * f.z;
		const x = dx * r.x + dy * r.y + dz * r.z;
		const y = dx * u.x + dy * u.y + dz * u.z;
		const pad = rad * 1.02 + 1;
		return (
			z < -pad ||
			(Math.abs(x) - z * tx) / nx > pad ||
			(Math.abs(y) - z * ty) / ny > pad
		);
	};
}
