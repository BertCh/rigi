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
// Imagery (the satellite / topo drape, props.imagery): rgba8 2d-array textures with mipmaps, one
// per image size (256 / 512 / 1024 px), the tile's layer in its table row. The colour / canvas
// passes of the imagery style draw one instanced draw per (resolution, image size), plus one for
// the tiles whose image hasn't arrived yet (hasMap 0); the geometry and normal passes ignore it.
import { Layer, type LayerProps, type UpdateParameters } from "@deck.gl/core";
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { Pose } from "../camera";
import { poseBasis } from "../pose";
import { BASE_MAX, gridMesh } from "./batched-terrain-grid";
import type { TileMesh } from "./terrain-data";
import {
	currentTerrainPass,
	fs,
	setTerrainShaderProps,
	type TerrainDrawProps,
	terrainShaders,
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

// terrain-data.ts sampleGrid: bilinear on the pixel-centred S×S grid at pixel coords (0..S)
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
  // buildMesh's grid normals: central differences, clamped at the tile edge
  vec3 e = vertexAt(min(i + 1.0, tSeg), j).xyz - vertexAt(max(i - 1.0, 0.0), j).xyz;
  vec3 s = vertexAt(i, max(j - 1.0, 0.0)).xyz - vertexAt(i, min(j + 1.0, tSeg)).xyz;
  vec3 nrm = cross(e, s);
  float len = length(nrm);
  nrm = len > 0.0 ? nrm / len : nrm;
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
	private free: number[] = [];
	private next = 0;
	constructor(
		private device: Device,
		private id: string,
		private format: "r32float" | "rgba32float",
		private size: number,
		cap: number,
	) {
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
		return this.next - this.free.length;
	}
	alloc(): number {
		return this.free.pop() ?? this.next++;
	}
	release(i: number) {
		this.free.push(i);
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

/**
 * Imagery of one size as a growable, mipmapped rgba8 2d-array texture with a free list of layers.
 * Growing re-creates the texture and re-uploads the images it holds (the bitmaps stay alive in
 * the engine's imagery cache while they're in props.imagery).
 */
class MapPool {
	tex: Texture;
	cap: number;
	private free: number[] = [];
	private next = 0;
	private images = new Map<number, ImageBitmap>();
	private dirty = false;
	constructor(
		private device: Device,
		readonly width: number,
		readonly height: number,
		cap: number,
		private max: number,
	) {
		this.cap = cap;
		this.tex = this.create(cap);
	}
	private create(cap: number) {
		return this.device.createTexture({
			id: `terrain-maps-${this.width}x${this.height}`,
			dimension: "2d-array",
			format: "rgba8unorm",
			width: this.width,
			height: this.height,
			depth: cap,
			mipLevels: this.device.getMipLevelCount(this.width, this.height),
			sampler: MAP_SAMPLER,
		});
	}
	get used() {
		return this.images.size;
	}
	/** The image's layer, −1 past the device's array layer limit. */
	add(image: ImageBitmap): number {
		const i = this.free.pop() ?? this.next++;
		if (i >= this.max) {
			this.free.push(i);
			return -1;
		}
		this.images.set(i, image);
		if (i >= this.cap) {
			this.tex.destroy();
			this.cap = Math.min(this.max, Math.max(i + 1, Math.ceil(this.cap * 1.5)));
			this.tex = this.create(this.cap);
			for (const [j, im] of this.images) this.upload(j, im);
		} else this.upload(i, image);
		return i;
	}
	release(i: number) {
		if (this.images.delete(i)) this.free.push(i);
	}
	private upload(i: number, image: ImageBitmap) {
		// closed since (the engine dropped it): leave the layer stale, the tile goes next sync
		if (!image.width) return;
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

class TileStore {
	small: LayerPool;
	big: LayerPool;
	base: LayerPool;
	table: Texture;
	private tableData: Float32Array;
	private rowsCap: number;
	readonly slots = new Map<TileMesh, Slot>();
	private maxLayers: number;
	/** Imagery: one pool per image size ("256x256", …), and each tile id's layer in it. */
	readonly mapPools = new Map<string, MapPool>();
	private maps = new Map<
		string,
		{ image: ImageBitmap; pool: MapPool; layer: number }
	>();
	/** Bound as terrainMaps when a draw has no imagery (a sampler2DArray needs an array). */
	readonly emptyMaps: Texture;

	constructor(private device: Device) {
		this.maxLayers = device.limits.maxTextureArrayLayers || 256;
		this.small = new LayerPool(device, "terrain-h256", "r32float", SMALL, 128);
		this.big = new LayerPool(device, "terrain-h512", "r32float", BIG, 16);
		this.base = new LayerPool(
			device,
			"terrain-base",
			"rgba32float",
			BASE_MAX + 1,
			128,
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
			this.slots.set(m, {
				row: this.base.alloc(),
				layer: (big ? this.big : this.small).alloc(),
				big,
			});
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
				// past the device's array layer limit: not drawn
				this.slots.delete(m);
				continue;
			}
			if (isFresh || (s.big ? reBig : reSmall))
				pool.write(s.layer, m.heights, m.size, m.size);
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

	private mapLayer(id: string) {
		return this.maps.get(id)?.layer ?? -1;
	}

	/**
	 * Imagery per tile id into the map pools (one per image size), and each tile's layer (or −1)
	 * into its table row. Call after sync().
	 */
	syncMaps(tiles: TileMesh[], imagery: Map<string, ImageBitmap> | null) {
		const live = new Set<string>();
		for (const t of tiles) {
			const image = imagery?.get(t.id);
			// a closed bitmap is 0 × 0
			if (!image?.width || !image.height) continue;
			live.add(t.id);
			const cur = this.maps.get(t.id);
			if (cur?.image === image) continue;
			if (cur) cur.pool.release(cur.layer);
			const key = `${image.width}x${image.height}`;
			let pool = this.mapPools.get(key);
			if (!pool) {
				pool = new MapPool(
					this.device,
					image.width,
					image.height,
					16,
					this.maxLayers,
				);
				this.mapPools.set(key, pool);
			}
			const layer = pool.add(image);
			if (layer < 0) this.maps.delete(t.id);
			else this.maps.set(t.id, { image, pool, layer });
		}
		for (const [id, m] of this.maps)
			if (!live.has(id)) {
				m.pool.release(m.layer);
				this.maps.delete(id);
			}
		for (const [key, pool] of this.mapPools) {
			if (!pool.used) {
				pool.destroy();
				this.mapPools.delete(key);
			} else pool.flush();
		}
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

	/** The map pool holding tile `id`'s imagery (null: none yet). */
	mapPool(id: string) {
		return this.maps.get(id)?.pool ?? null;
	}

	destroy() {
		this.small.destroy();
		this.big.destroy();
		this.base.destroy();
		this.table.destroy();
		for (const p of this.mapPools.values()) p.destroy();
		this.mapPools.clear();
		this.maps.clear();
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
	};

/** Per-instance row buffers, one per draw group (a Model's attributes are swapped per draw). */
type RowBuf = { buf: Buffer; cap: number };
type SegModel = { model: Model; bufs: Map<string, RowBuf> };

export class BatchedTerrainTileLayer extends Layer<BatchedTerrainProps> {
	static layerName = "BatchedTerrainTileLayer";
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
			fs: fsBatched(),
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
			this.state.store?.syncMaps(props.tiles, props.imagery);
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
		const viewport = (shaderModuleProps?.project?.viewport ??
			this.context.viewport) as {
			cameraPosition: number[];
			pose?: Pose;
			eye?: [number, number, number];
			width: number;
			height: number;
		};
		const cull =
			viewport.pose && viewport.eye
				? sphereCuller(
						viewport.pose,
						viewport.eye,
						viewport.width / Math.max(1, viewport.height),
					)
				: null;
		const pass = currentTerrainPass();
		// imagery: the colour / canvas passes group each resolution's tiles by map pool
		const withMaps =
			this.props.style === "imagery" &&
			pass !== "geometry" &&
			pass !== "normal" &&
			store.mapPools.size > 0;
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
			Map<string, { pool: MapPool | null; rows: number[] }>
		>();
		for (const t of this.props.tiles) {
			const s = store.slots.get(t);
			if (!s || !t.grid) continue;
			if (cull?.(t.grid.sphere)) continue;
			const pool = withMaps ? store.mapPool(t.id) : null;
			const key = pool ? `${pool.width}x${pool.height}` : "all";
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
				rb.buf.write(new Float32Array(rows));
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
