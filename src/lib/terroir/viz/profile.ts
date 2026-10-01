// T3.3 line-of-sight profile data: terrain elevation from the camera to a point. Heights come from the
// app's DEM policy (src/lib/dem loadDemTile: Mapterhorn with ancestor fallback, shared tile cache),
// imported lazily so node checks of the pure helpers never touch the worker pool. Async, display-only.
import type { CoverGrid } from "../pack";
import { resampleLine } from "./geo";

export type ProfilePt = { d: number; h: number; cover: number };
export type Profile = { pts: ProfilePt[]; kind: "profile" | "surface" };

type Tile = { size: number; heights: Float32Array } | null;
const tileCache = new Map<string, Promise<Tile>>();

/** DEM heights along the straight line a → b; null when the DEM cannot be had. */
export async function demProfile(
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
	cover: CoverGrid | null,
	signal?: { aborted: boolean },
): Promise<Profile | null> {
	try {
		const dem = await import("#/lib/dem");
		const total = resampleLine(a, b, 1)[1].d;
		const n = Math.min(140, Math.max(24, Math.round(total / 60)));
		const line = resampleLine(a, b, n);
		let z = 12;
		let keys = new Set<string>();
		for (; z >= 9; z--) {
			keys = new Set(
				line.map((p) => {
					const t = dem.lonLatToTile(p.lon, p.lat, z);
					return `${z}/${Math.floor(t.x)}/${Math.floor(t.y)}`;
				}),
			);
			if (keys.size <= 16) break;
		}
		const tiles = new Map<string, Tile>();
		await Promise.all(
			[...keys].map(async (id) => {
				let p = tileCache.get(id);
				if (!p) {
					const [zz, x, y] = id.split("/").map(Number);
					p = dem
						.loadDemTile({ z: zz, x, y })
						.then((r) => (r ? { size: r.size, heights: r.heights } : null))
						.catch(() => null);
					tileCache.set(id, p);
				}
				tiles.set(id, await p);
			}),
		);
		if (signal?.aborted) return null;
		const pts: ProfilePt[] = [];
		for (const p of line) {
			const t = dem.lonLatToTile(p.lon, p.lat, z);
			const tx = Math.floor(t.x);
			const ty = Math.floor(t.y);
			const tile = tiles.get(`${z}/${tx}/${ty}`);
			if (!tile) continue;
			const h = dem.sampleGrid(
				tile.heights,
				tile.size,
				(t.x - tx) * tile.size,
				(t.y - ty) * tile.size,
			);
			if (!Number.isFinite(h) || h < -500) continue;
			pts.push({ d: p.d, h, cover: cover ? cover.at(p.lat, p.lon) : 0 });
		}
		return pts.length >= 4 ? { pts, kind: "profile" } : null;
	} catch {
		return null;
	}
}

/** Fallback: the visible surface along the screen segment bottom-centre → (u, v), by range. */
export function surfaceProfile(
	sample: (
		u: number,
		v: number,
	) => { h: number; range: number; lat: number; lon: number } | null,
	cover: CoverGrid | null,
	u: number,
	v: number,
	n = 48,
): Profile | null {
	const pts: ProfilePt[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const s = sample(0.5 + (u - 0.5) * t, 0.999 + (v - 0.999) * t);
		if (s)
			pts.push({
				d: s.range,
				h: s.h,
				cover: cover ? cover.at(s.lat, s.lon) : 0,
			});
	}
	pts.sort((p, q) => p.d - q.d);
	return pts.length >= 4 ? { pts, kind: "surface" } : null;
}
