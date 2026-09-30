// Terrain around a camera: quadtree LOD selection of Terrarium DEM tiles, meshed in a
// camera-local ENU frame (curvature + refraction baked in), plus optional draped imagery.
import * as THREE from "three";
import { cachedFetch, tilePriority } from "./cache";
import {
	latToTileY,
	loadDemTile,
	lonToTileX,
	type TileKey,
	tileBounds,
	tileNum,
	tileXToLon,
	tileYToLat,
} from "./dem";
import { DEG, distanceM, type EnuFrame, M_PER_DEG_LAT, WGS84 } from "./geodesy";
import { imageryTileUrls } from "./licences/imagery";

// DEM: Mapterhorn (512 px, national lidar such as swissALTI3D where available) through dem's loadDemTile,
// the policy the deck terrain and the CPU horizon share (a missing tile = its nearest ancestor, upsampled).

export type ImagerySource = "satellite" | "topo" | "none";

// URL lists come from the imagery provider abstraction (src/lib/licences/imagery.ts); its
// "default" provider is byte-identical to the URLs this file used to build inline.
function imageryUrl(
	src: ImagerySource,
	z: number,
	x: number,
	y: number,
	lat: number,
	lon: number,
): string[] {
	return src === "none" ? [] : imageryTileUrls(src, z, x, y, lat, lon);
}

export type TerrainTile = {
	key: TileKey;
	mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
	heights: Float32Array; // size×size metres
	size: number;
	distance: number;
};

export type TerrainOptions = {
	radiusM?: number;
	maxZoom?: number;
	minZoom?: number;
	/** Subdivide while distance < lod × tile size. */
	lod?: number;
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
};

// Tiles go through the shared persistent cache (src/lib/cache): nearest-first priority queue, in-flight
// dedupe (StrictMode's second engine shares the first one's requests), 0 bytes on a warm load.
async function fetchImage(
	urls: string[],
	signal?: AbortSignal,
	priority = 0,
): Promise<ImageBitmap | null> {
	for (const url of urls) {
		try {
			const res = await cachedFetch(url, { signal, priority });
			if (!res.ok) continue;
			const blob = await res.blob();
			return await createImageBitmap(blob, {
				colorSpaceConversion: "none",
				premultiplyAlpha: "none",
			});
		} catch (e) {
			if ((e as Error).name === "AbortError") throw e;
		}
	}
	return null;
}

/**
 * DEM height at a point from its zoom-z tile alone, fetched, decoded and sampled exactly as a loaded
 * Terrain does (same URL and cache entry, same priority, same bilinear), so it equals `heightAt` wherever
 * that tile is the finest one loaded, e.g. the camera point at maxZoom. Lets work that needs the camera's
 * ground height (the horizon worker) start before the whole terrain is in.
 */
export async function heightFromTile(
	lat: number,
	lon: number,
	z = 14,
	signal?: AbortSignal,
): Promise<number | null> {
	const fx = lonToTileX(lon, z);
	const fy = latToTileY(lat, z);
	const key = { z, x: Math.floor(fx), y: Math.floor(fy) };
	const dem = await loadDemTile(key, { signal, priority: tilePriority(0, z) });
	return dem && sampleGrid(dem.heights, dem.size, fx - key.x, fy - key.y);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (i < items.length) await fn(items[i++]);
		}),
	);
}

export function selectTiles(
	lat: number,
	lon: number,
	opts: Required<
		Pick<TerrainOptions, "radiusM" | "maxZoom" | "minZoom" | "lod">
	>,
) {
	const { radiusM, maxZoom, minZoom, lod } = opts;
	const dLat = radiusM / M_PER_DEG_LAT;
	const dLon = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
	const x0 = Math.floor(lonToTileX(lon - dLon, minZoom));
	const x1 = Math.floor(lonToTileX(lon + dLon, minZoom));
	const y0 = Math.floor(latToTileY(lat + dLat, minZoom));
	const y1 = Math.floor(latToTileY(lat - dLat, minZoom));
	const out: { key: TileKey; distance: number }[] = [];
	const visit = (t: TileKey) => {
		const b = tileBounds(t);
		const nearest = {
			lat: Math.min(Math.max(lat, b.south), b.north),
			lon: Math.min(Math.max(lon, b.west), b.east),
		};
		const d = distanceM({ lat, lon }, nearest);
		if (d > radiusM) return;
		const size = distanceM(
			{ lat: b.south, lon: b.west },
			{ lat: b.south, lon: b.east },
		);
		if (t.z < maxZoom && d < lod * size) {
			for (const [dx, dy] of [
				[0, 0],
				[1, 0],
				[0, 1],
				[1, 1],
			])
				visit({ z: t.z + 1, x: t.x * 2 + dx, y: t.y * 2 + dy });
		} else out.push({ key: t, distance: d });
	};
	for (let x = x0; x <= x1; x++)
		for (let y = y0; y <= y1; y++) visit({ z: minZoom, x, y });
	return out.sort((a, b) => a.distance - b.distance);
}

function downsample(h: Float32Array, S: number, T: number) {
	if (T >= S) return h;
	const f = S / T;
	const out = new Float32Array(T * T);
	for (let y = 0; y < T; y++)
		for (let x = 0; x < T; x++) {
			let acc = 0;
			for (let j = 0; j < f; j++)
				for (let i = 0; i < f; i++) acc += h[(y * f + j) * S + x * f + i];
			out[y * T + x] = acc / (f * f);
		}
	return out;
}

/** Bilinear sample of an S×S grid at fractional tile coords (0..1). */
function sampleGrid(h: Float32Array, S: number, fu: number, fv: number) {
	const m = S - 1;
	const x = Math.min(Math.max(fu * S - 0.5, 0), m);
	const y = Math.min(Math.max(fv * S - 0.5, 0), m);
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const x1 = Math.min(x0 + 1, m);
	const y1 = Math.min(y0 + 1, m);
	const fx = x - x0;
	const fy = y - y0;
	const a = h[y0 * S + x0] * (1 - fx) + h[y0 * S + x1] * fx;
	const b = h[y1 * S + x0] * (1 - fx) + h[y1 * S + x1] * fx;
	return a * (1 - fy) + b * fy;
}

/** Vertex t (0..n-1) along tile edge e (north, south, west, east) of an n×n grid. */
function edgeVertex(e: number, t: number, n: number) {
	return e === 0
		? t
		: e === 1
			? (n - 1) * n + t
			: e === 2
				? t * n
				: t * n + n - 1;
}

const tileIndexCache = new Map<number, Uint16Array | Uint32Array>();

/** Triangle index of a (seg+1)² tile grid plus its four skirts (buildMesh's vertex layout). */
function tileIndex(seg: number): Uint16Array | Uint32Array {
	const hit = tileIndexCache.get(seg);
	if (hit) return hit;
	const n = seg + 1;
	const vCount = n * n + 4 * n;
	const count = seg * seg * 6 + 4 * (n - 1) * 12;
	const index =
		vCount > 65535 ? new Uint32Array(count) : new Uint16Array(count);
	let o = 0;
	const push = (...v: number[]) => {
		for (const x of v) index[o++] = x;
	};
	for (let j = 0; j < seg; j++)
		for (let i = 0; i < seg; i++) {
			const a = j * n + i;
			const b = a + 1;
			const c = a + n;
			const d = c + 1;
			push(a, c, b, b, c, d);
		}
	for (let e = 0; e < 4; e++) {
		const start = n * n + e * n;
		for (let i = 0; i < n - 1; i++) {
			const a = edgeVertex(e, i, n);
			const b = edgeVertex(e, i + 1, n);
			const c = start + i;
			const d = start + i + 1;
			push(a, c, b, b, c, d, a, b, c, b, d, c);
		}
	}
	tileIndexCache.set(seg, index);
	return index;
}

/** Azimuth sector (degrees, clockwise from north) that must be loaded up front. */
export type Wedge = {
	center: number;
	halfWidth: number;
	alwaysWithinM?: number;
};

function inWedge(frame: EnuFrame, key: TileKey, distance: number, w: Wedge) {
	if (distance < (w.alwaysWithinM ?? 3000)) return true;
	const b = tileBounds(key);
	let lo = Number.POSITIVE_INFINITY;
	let hi = Number.NEGATIVE_INFINITY;
	// angular extent of the tile seen from the camera, unwrapped around the wedge centre
	for (const [lat, lon] of [
		[b.north, b.west],
		[b.north, b.east],
		[b.south, b.west],
		[b.south, b.east],
	]) {
		const e = frame.fromGeo(lat, lon, 0);
		const az = (Math.atan2(e[0], e[1]) * 180) / Math.PI;
		const d = ((((az - w.center) % 360) + 540) % 360) - 180;
		lo = Math.min(lo, d);
		hi = Math.max(hi, d);
	}
	if (hi - lo > 180) return true; // straddles the camera's back — be safe
	return hi >= -w.halfWidth && lo <= w.halfWidth;
}

export class Terrain {
	readonly frame: EnuFrame;
	readonly group = new THREE.Group();
	tiles: TerrainTile[] = [];
	/** Uniforms shared by every tile material; mutate `.value` to restyle all tiles. */
	readonly shared: Record<string, THREE.IUniform>;
	imagery: ImagerySource = "none";
	private imageryAbort?: AbortController;
	/** Aborted by dispose() (and by the caller's signal): stops in-flight DEM loading. */
	private loadAbort = new AbortController();
	/** z/x/y → tile, and the loaded zooms finest-first, for O(#zooms) height lookups. */
	private byKey = new Map<number, TerrainTile>();
	private zooms: number[] = [];

	constructor(frame: EnuFrame, shared: Record<string, THREE.IUniform>) {
		this.frame = frame;
		this.shared = shared;
	}

	/** Metres above sea level at a point, from the finest loaded tile (null if outside). */
	heightAt(lat: number, lon: number): number | null {
		// was a linear scan over every tile with trig per tile (~340k calls from peaks + trails ≈ 3 s per load)
		// Mercator once (z 0), scaled by 2^z per zoom: the same values lonToTileX/latToTileY(…, z) give
		const mx = lonToTileX(lon, 0);
		const my = latToTileY(lat, 0);
		for (const z of this.zooms) {
			const fx = mx * 2 ** z;
			const fy = my * 2 ** z;
			const t = this.byKey.get(tileNum(z, Math.floor(fx), Math.floor(fy)));
			if (t) return sampleGrid(t.heights, t.size, fx - t.key.x, fy - t.key.y);
		}
		return null;
	}

	/** Highest DEM point within `radiusM` of a location (snaps OSM peaks onto the DEM summit). */
	localMax(lat: number, lon: number, radiusM = 150) {
		let best = {
			lat,
			lon,
			h: this.heightAt(lat, lon) ?? Number.NEGATIVE_INFINITY,
		};
		const dLat = radiusM / M_PER_DEG_LAT;
		const dLon = radiusM / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
		for (let i = -4; i <= 4; i++)
			for (let j = -4; j <= 4; j++) {
				const la = lat + (i / 4) * dLat;
				const lo = lon + (j / 4) * dLon;
				const h = this.heightAt(la, lo);
				if (h != null && h > best.h) best = { lat: la, lon: lo, h };
			}
		return best;
	}

	static async load(
		frame: EnuFrame,
		shared: Record<string, THREE.IUniform>,
		makeMaterial: (
			uniforms: Record<string, THREE.IUniform>,
		) => THREE.ShaderMaterial,
		options: TerrainOptions & { wedge?: Wedge } = {},
	) {
		const opts = {
			radiusM: 120000,
			maxZoom: 14,
			minZoom: 7,
			lod: 2,
			...options,
		};
		const terrain = new Terrain(frame, shared);
		terrain.makeMaterial = makeMaterial;
		const all = selectTiles(frame.lat, frame.lon, opts);
		const keys = opts.wedge
			? all.filter((t) =>
					inWedge(frame, t.key, t.distance, opts.wedge as Wedge),
				)
			: all;
		terrain.pending = all.filter((t) => !keys.includes(t));
		const signal = opts.signal;
		if (signal?.aborted) terrain.loadAbort.abort();
		else
			signal?.addEventListener("abort", () => terrain.loadAbort.abort(), {
				once: true,
			});
		await terrain.fetchTiles(keys, opts.onProgress);
		return terrain;
	}

	private makeMaterial?: (
		uniforms: Record<string, THREE.IUniform>,
	) => THREE.ShaderMaterial;
	private pending: { key: TileKey; distance: number }[] = [];

	/** Tiles outside the initial viewing wedge, still to load (for free-orbit views). */
	get hasPending() {
		return this.pending.length > 0;
	}

	async loadPending(onProgress?: (done: number, total: number) => void) {
		const keys = this.pending;
		this.pending = [];
		// shared queue order: any photo's wedge DEM (0–~150) < world-view DEM (500+) < imagery (1000+)
		await this.fetchTiles(keys, onProgress, 500);
		if (this.imagery !== "none") {
			const src = this.imagery;
			this.imagery = "none";
			await this.loadImagery(src);
		}
	}

	private async fetchTiles(
		keys: { key: TileKey; distance: number }[],
		onProgress?: (d: number, t: number) => void,
		basePriority = 0,
	) {
		let done = 0;
		const added: TerrainTile[] = [];
		const signal = this.loadAbort.signal;
		// the cache's queue caps network concurrency; this pool now bounds decode + mesh work
		const work = pool(keys, 24, async ({ key, distance }) => {
			const dem = await loadDemTile(key, {
				signal,
				priority: basePriority + tilePriority(distance, key.z),
			});
			if (signal.aborted)
				throw new DOMException("Terrain disposed", "AbortError");
			done++;
			onProgress?.(done, keys.length);
			if (!dem || !this.makeMaterial) return;
			const { heights, size } = dem;
			const seg = distance < 2500 ? 256 : key.z >= 10 ? 128 : 96;
			const mesh = this.buildMesh(key, heights, size, seg, this.makeMaterial);
			// keep full-res heights only near the camera; far tiles are only used for coarse lookups
			const keep = key.z >= 13 ? size : key.z === 12 ? size / 2 : size / 4;
			added.push({
				key,
				mesh,
				heights: downsample(heights, size, keep),
				size: keep,
				distance,
			});
		});
		try {
			await work;
		} catch (e) {
			// aborted (disposed): free what was already meshed
			for (const t of added) {
				t.mesh.geometry.dispose();
				t.mesh.material.dispose();
			}
			throw e;
		}
		// distance from the eye, then tile key: never the network completion order
		this.tiles = [...this.tiles, ...added].sort(
			(a, b) =>
				a.distance - b.distance ||
				a.key.z - b.key.z ||
				a.key.x - b.key.x ||
				a.key.y - b.key.y,
		);
		// Deterministic draw order: every tile has its own ShaderMaterial and three sorts opaque meshes
		// by renderOrder, then material id (= creation = completion order), so coplanar skirts at shared
		// pixels resolved differently from run to run. Near first; 1+ keeps them after the sky (-1).
		this.tiles.forEach((t, i) => {
			t.mesh.renderOrder = 1 + i;
		});
		for (const t of added)
			this.byKey.set(tileNum(t.key.z, t.key.x, t.key.y), t);
		this.zooms = [...new Set(this.tiles.map((t) => t.key.z))].sort(
			(a, b) => b - a,
		);
		for (const t of added) this.group.add(t.mesh);
	}

	private buildMesh(
		key: TileKey,
		heights: Float32Array,
		size: number,
		seg: number,
		makeMaterial: (
			uniforms: Record<string, THREE.IUniform>,
		) => THREE.ShaderMaterial,
	) {
		const n = seg + 1;
		const b = tileBounds(key);
		const center = this.frame.fromGeo(
			(b.north + b.south) / 2,
			(b.east + b.west) / 2,
			0,
		);
		const sizeM = distanceM(
			{ lat: b.south, lon: b.west },
			{ lat: b.south, lon: b.east },
		);
		const skirt = Math.max(30, sizeM * 0.03);
		const vCount = n * n + 4 * n;
		const pos = new Float32Array(vCount * 3);
		const uv = new Float32Array(vCount * 2);
		const elev = new Float32Array(vCount);
		const nor = new Float32Array(vCount * 3);
		// WGS84 → ECEF → ENU as EnuFrame.fromGeo does, with the latitude terms per row and the longitude
		// terms per column instead of per vertex (bit-identical)
		const { A, E2 } = WGS84;
		const cosLam = new Float64Array(n);
		const sinLam = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			const lam = tileXToLon(key.x + i / seg, key.z) * DEG;
			cosLam[i] = Math.cos(lam);
			sinLam[i] = Math.sin(lam);
		}
		const tmp = [0, 0, 0];
		for (let j = 0; j < n; j++) {
			const phi = tileYToLat(key.y + j / seg, key.z) * DEG;
			const sp = Math.sin(phi);
			const N = A / Math.sqrt(1 - E2 * sp * sp);
			const cp = Math.cos(phi);
			for (let i = 0; i < n; i++) {
				const h = sampleGrid(heights, size, i / seg, j / seg);
				this.frame.fromEcef(
					(N + h) * cp * cosLam[i],
					(N + h) * cp * sinLam[i],
					(N * (1 - E2) + h) * sp,
					tmp,
				);
				const k = j * n + i;
				pos[k * 3] = tmp[0] - center[0];
				pos[k * 3 + 1] = tmp[1] - center[1];
				pos[k * 3 + 2] = tmp[2] - center[2];
				uv[k * 2] = i / seg;
				uv[k * 2 + 1] = 1 - j / seg;
				elev[k] = h;
			}
		}
		// Normals: three's computeVertexNormals over the grid triangles (area-weighted face normals,
		// accumulated in float32 in index order, then normalised), inlined on the typed arrays: the
		// same bits at a fraction of the cost (it was ~half of buildMesh through Vector3 accessors)
		const face = (a: number, b: number, c: number) => {
			const a3 = a * 3;
			const b3 = b * 3;
			const c3 = c * 3;
			const cbx = pos[c3] - pos[b3];
			const cby = pos[c3 + 1] - pos[b3 + 1];
			const cbz = pos[c3 + 2] - pos[b3 + 2];
			const abx = pos[a3] - pos[b3];
			const aby = pos[a3 + 1] - pos[b3 + 1];
			const abz = pos[a3 + 2] - pos[b3 + 2];
			const x = cby * abz - cbz * aby;
			const y = cbz * abx - cbx * abz;
			const z = cbx * aby - cby * abx;
			nor[a3] += x;
			nor[a3 + 1] += y;
			nor[a3 + 2] += z;
			nor[b3] += x;
			nor[b3 + 1] += y;
			nor[b3 + 2] += z;
			nor[c3] += x;
			nor[c3 + 1] += y;
			nor[c3 + 2] += z;
		};
		for (let j = 0; j < seg; j++)
			for (let i = 0; i < seg; i++) {
				const a = j * n + i;
				face(a, a + n, a + 1);
				face(a + 1, a + n, a + n + 1);
			}
		for (let k = 0; k < n * n * 3; k += 3) {
			const x = nor[k];
			const y = nor[k + 1];
			const z = nor[k + 2];
			const inv = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
			nor[k] = x * inv;
			nor[k + 1] = y * inv;
			nor[k + 2] = z * inv;
		}
		// Skirts: drop a copy of each edge row to hide cracks between LOD levels.
		for (let e = 0; e < 4; e++)
			for (let t = 0; t < n; t++) {
				const k = edgeVertex(e, t, n);
				const v = n * n + e * n + t;
				pos[v * 3] = pos[k * 3];
				pos[v * 3 + 1] = pos[k * 3 + 1];
				pos[v * 3 + 2] = pos[k * 3 + 2] - skirt;
				uv[v * 2] = uv[k * 2];
				uv[v * 2 + 1] = uv[k * 2 + 1];
				elev[v] = elev[k] - skirt;
				nor[v * 3] = nor[k * 3];
				nor[v * 3 + 1] = nor[k * 3 + 1];
				nor[v * 3 + 2] = nor[k * 3 + 2];
			}
		const geo = new THREE.BufferGeometry();
		geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
		geo.setAttribute("elev", new THREE.BufferAttribute(elev, 1));
		geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
		// the index depends on seg alone: one shared array, a BufferAttribute (GL buffer) per tile
		geo.setIndex(new THREE.BufferAttribute(tileIndex(seg), 1));
		geo.computeBoundingSphere();
		geo.computeBoundingBox();
		const uniforms: Record<string, THREE.IUniform> = {
			...this.shared,
			map: { value: null },
			hasMap: { value: 0 },
		};
		const mesh = new THREE.Mesh(geo, makeMaterial(uniforms));
		mesh.position.set(center[0], center[1], center[2]);
		mesh.updateMatrixWorld();
		mesh.frustumCulled = true;
		mesh.userData.key = key;
		return mesh;
	}

	/** Drape web-mercator imagery onto every tile (mosaicked 2–4× finer than the DEM tile). */
	async loadImagery(
		src: ImagerySource,
		onProgress?: (done: number, total: number) => void,
		anisotropy = 8,
	) {
		if (src === this.imagery) return;
		this.imageryAbort?.abort();
		this.imagery = src;
		for (const t of this.tiles) {
			const u = t.mesh.material.uniforms;
			(u.map.value as THREE.Texture | null)?.dispose();
			u.map.value = null;
			u.hasMap.value = 0;
		}
		if (src === "none") return;
		const ac = new AbortController();
		this.imageryAbort = ac;
		let done = 0;
		await pool(this.tiles, 8, async (t) => {
			if (ac.signal.aborted) return;
			const extra = t.distance < 4000 ? 2 : t.distance < 40000 ? 1 : 0;
			const f = 2 ** extra;
			const z = t.key.z + extra;
			const canvas = document.createElement("canvas");
			canvas.width = canvas.height = 256 * f;
			const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
			const jobs: Promise<void>[] = [];
			for (let dy = 0; dy < f; dy++)
				for (let dx = 0; dx < f; dx++) {
					const x = t.key.x * f + dx;
					const y = t.key.y * f + dy;
					const lat = tileYToLat(y + 0.5, z);
					const lon = tileXToLon(x + 0.5, z);
					jobs.push(
						// +1000: imagery never jumps ahead of DEM tiles in the shared queue
						fetchImage(
							imageryUrl(src, z, x, y, lat, lon),
							ac.signal,
							1000 + tilePriority(t.distance, z),
						)
							.then((img) => {
								if (img) {
									ctx.drawImage(img, dx * 256, dy * 256);
									img.close();
								}
							})
							.catch(() => {}),
					);
				}
			await Promise.all(jobs);
			if (ac.signal.aborted) return;
			const tex = new THREE.CanvasTexture(canvas);
			tex.colorSpace = THREE.SRGBColorSpace;
			tex.anisotropy = anisotropy;
			tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
			const u = t.mesh.material.uniforms;
			u.map.value = tex;
			u.hasMap.value = 1;
			done++;
			onProgress?.(done, this.tiles.length);
		});
	}

	dispose() {
		this.loadAbort.abort();
		this.imageryAbort?.abort();
		for (const t of this.tiles) {
			t.mesh.geometry.dispose();
			(t.mesh.material.uniforms.map.value as THREE.Texture | null)?.dispose();
			t.mesh.material.dispose();
		}
		this.tiles = [];
		this.byKey.clear();
		this.zooms = [];
	}
}
