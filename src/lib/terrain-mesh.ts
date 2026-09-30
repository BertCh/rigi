// Terrain tile mesh arrays (terrain.ts): the camera-local ENU grid + skirts of one DEM tile, as plain typed
// arrays, so they can be built in terrain-tile.worker.ts as well as on the page (same code, same bits).
// Environment-free: no three, no DOM.
import { ancestorCrop } from "./dem/grid";
import { type TileKey, tileBounds, tileXToLon, tileYToLat } from "./dem/tiles";
import { DEG, distanceM, EnuFrame, WGS84 } from "./geodesy";

export function downsample(h: Float32Array, S: number, T: number) {
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
export function sampleGrid(h: Float32Array, S: number, fu: number, fv: number) {
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
export function edgeVertex(e: number, t: number, n: number) {
	return e === 0
		? t
		: e === 1
			? (n - 1) * n + t
			: e === 2
				? t * n
				: t * n + n - 1;
}

export type TileArrays = {
	/** ENU of the tile centre at h = 0: the mesh position; `pos` is relative to it. */
	center: number[];
	pos: Float32Array;
	uv: Float32Array;
	elev: Float32Array;
	nor: Float32Array;
};

/** The (seg+1)² grid + 4 skirts of tile `key` from its size×size heights, in `frame`. */
export function tileArrays(
	frame: EnuFrame,
	key: TileKey,
	heights: Float32Array,
	size: number,
	seg: number,
): TileArrays {
	const n = seg + 1;
	const b = tileBounds(key);
	const center = frame.fromGeo(
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
			frame.fromEcef(
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
	return { center, pos, uv, elev, nor };
}

export type TileJob = {
	/** Encoded Terrarium bytes of `source` (key itself, or the ancestor standing in for it). */
	buf: ArrayBuffer;
	source: TileKey;
	key: TileKey;
	seg: number;
	/** Heights kept for heightAt: the decoded size / keepDiv (1, 2 or 4). */
	keepDiv: number;
	origin: { lat: number; lon: number; h: number };
};

export type TileResult = TileArrays & { heights: Float32Array; size: number };

/**
 * A loaded tile from its bytes, exactly as loadDemTile + Terrain did it on the page: decode, crop an
 * ancestor to the tile, mesh, and keep `keep`² heights. null = undecodable (loadDemTile's null).
 */
export async function buildTile(
	job: TileJob,
	decode: (buf: ArrayBuffer) => Promise<Float32Array>,
): Promise<TileResult | null> {
	const h = await decode(job.buf).catch(() => null);
	if (!h) return null;
	const size = Math.round(Math.sqrt(h.length));
	const heights = ancestorCrop(h, job.source, job.key, size);
	const frame = new EnuFrame(job.origin.lat, job.origin.lon, job.origin.h);
	const keep = size / job.keepDiv;
	return {
		...tileArrays(frame, job.key, heights, size, job.seg),
		heights: downsample(heights, size, keep),
		size: keep,
	};
}
