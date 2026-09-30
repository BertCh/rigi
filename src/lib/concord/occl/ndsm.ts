// WP-F: near-field surface model (DSM) + terrain (DTM) around a photo, resampled to the engine's ENU frame.
//
// DSM = swissSURFACE3D Raster (0.5 m product; its 2 m / 1 m COG overview levels are read), DTM = swissALTI3D
// (2 m product, full level or its 4 m overview). nDSM = DSM − DTM marks trees, huts, houses, pylons: the
// objects the bare-earth render cannot occlude with. Switzerland only (null elsewhere).
//
// Grid convention: cell (i, j) centre at ENU e = e0 + i·res, n = n0 − j·res (row 0 = north), heights are
// absolute metres (LV95 / LN02 ≈ MSL, as the engine's DEM heights), NOT curvature-dropped. Cells outside the
// requested radius / wedge or without data are NaN.
import { EnuFrame } from "../../geodesy";
import {
	type CogHeader,
	DSM_COLLECTION,
	DTM_COLLECTION,
	type FetchStats,
	httpJsonFetcher,
	httpRangeFetcher,
	inSwissExtent,
	type JsonFetcher,
	lv95ToWgs84,
	newStats,
	openCog,
	pickLevel,
	type RangeFetcher,
	readWindow,
	type SwissTile,
	stacTiles,
	wgs84ToLv95,
} from "./swiss-cog";

export type NearDsm = {
	frame: EnuFrame;
	res: number;
	dsm: Float32Array;
	dtm: Float32Array;
	w: number;
	h: number;
	/** Survey years of the newest tiles used (max over tiles). */
	epoch: { dsm: number; dtm: number };
	// ---- additive (WP-F) ----
	/** ENU of the centre of cell (0, 0) (north-west corner cell). */
	e0: number;
	n0: number;
	radiusM: number;
	/** Transfer + timing of the load (ms = wall time incl. STAC). */
	stats: FetchStats & {
		ms: number;
		/** Wall time until every tile was decoded (network + LZW), before the ENU resample. */
		fetchMs: number;
		tiles: number;
		dtmRes: number;
	};
	/** Distinct survey years seen (epoch mismatch diagnostics). */
	years: { dsm: number[]; dtm: number[] };
};

export type NearDsmOpts = {
	fetcher?: RangeFetcher;
	json?: JsonFetcher;
	signal?: AbortSignal;
	/** Only tiles intersecting this view wedge (azimuth, degrees clockwise from north) are fetched. */
	wedge?: { yawDeg: number; halfDeg: number };
	/** DTM level: 2 m (swissALTI3D native) or its 4 m overview (≈4× fewer bytes). Default 4. */
	dtmRes?: 2 | 4;
	/** Stop adding tiles (nearest first) once this many km tiles are selected. */
	maxTiles?: number;
	/**
	 * Transfer budget (bytes, headers + STAC-free payload): km tiles are added nearest first while the
	 * planned DSM + DTM bytes fit. Default 4.5e6 (WP-F acceptance: < 5 MB per photo); Infinity = no cap.
	 */
	maxBytes?: number;
};

const DEG = Math.PI / 180;

/** ENU (of `frame`) → LV95, as an affine map fitted at the frame origin (< 0.1 m error within 3 km). */
export function enuToLv95Affine(frame: EnuFrame) {
	const at = (e: number, n: number) => {
		const g = frame.toGeo(e, n, 0);
		return wgs84ToLv95(g.lat, g.lon);
	};
	const [E0, N0] = at(0, 0);
	const d = 500;
	const [Ee, Ne] = at(d, 0);
	const [Ew, Nw] = at(-d, 0);
	const [En, Nn] = at(0, d);
	const [Es, Ns] = at(0, -d);
	const a = [(Ee - Ew) / (2 * d), (En - Es) / (2 * d)];
	const b = [(Ne - Nw) / (2 * d), (Nn - Ns) / (2 * d)];
	return {
		E0,
		N0,
		/** [dE/de, dE/dn, dN/de, dN/dn] */
		m: [a[0], a[1], b[0], b[1]] as const,
		map: (e: number, n: number): [number, number] => [
			E0 + a[0] * e + a[1] * n,
			N0 + b[0] * e + b[1] * n,
		],
	};
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

function tileSelected(
	kx: number,
	ky: number,
	E0: number,
	N0: number,
	R: number,
	conv: number,
	wedge?: { yawDeg: number; halfDeg: number },
): { ok: boolean; dist: number } {
	const x0 = kx * 1000;
	const y0 = ky * 1000;
	const dx = Math.max(x0 - E0, 0, E0 - (x0 + 1000));
	const dy = Math.max(y0 - N0, 0, N0 - (y0 + 1000));
	const dist = Math.hypot(dx, dy);
	if (dist > R) return { ok: false, dist };
	if (!wedge || dist === 0) return { ok: true, dist };
	// sample the tile border + interior; any sample inside the wedge (and radius) selects it
	for (let a = 0; a <= 10; a++)
		for (let b = 0; b <= 10; b++) {
			const x = x0 + a * 100 - E0;
			const y = y0 + b * 100 - N0;
			if (Math.hypot(x, y) > R) continue;
			// grid azimuth → true azimuth (meridian convergence `conv`, deg)
			const az = Math.atan2(x, y) / DEG + conv;
			if (Math.abs(wrap180(az - wedge.yawDeg)) <= wedge.halfDeg + 3)
				return { ok: true, dist };
		}
	return { ok: false, dist };
}

type Raster = {
	data: Float32Array;
	w: number;
	h: number;
	/** LV95 of the top-left CORNER, pixel size. */
	x0: number;
	y0: number;
	px: number;
};

type Plan = {
	hdr: CogHeader;
	li: number;
	cx0: number;
	cy0: number;
	w: number;
	h: number;
	/** Compressed bytes of the internal tiles the window needs. */
	cost: number;
};

/** Open the COG header and plan the window read (no pixel data fetched yet). */
async function planTile(
	t: SwissTile,
	resM: number,
	win: [number, number, number, number], // LV95 xmin, ymin, xmax, ymax
	fetcher: RangeFetcher,
	stats: FetchStats,
	signal?: AbortSignal,
): Promise<Plan | null> {
	// GDAL COGs keep every IFD in the first ~1–2 KiB; HeadBuf grows on demand. (A prefix that also covers the
	// coarsest overview would save a round trip but over-fetches on small, e.g. lake-only, tiles: +2.7 MB
	// measured on IMG_7018.)
	const hdr = await openCog(t.href, fetcher, stats, signal, 4096);
	const li = pickLevel(hdr, resM);
	const lv = hdr.levels[li];
	const px = lv.resX;
	const cx0 = Math.max(0, Math.floor((win[0] - hdr.originX) / px));
	const cx1 = Math.min(lv.width, Math.ceil((win[2] - hdr.originX) / px));
	const cy0 = Math.max(0, Math.floor((hdr.originY - win[3]) / px));
	const cy1 = Math.min(lv.height, Math.ceil((hdr.originY - win[1]) / px));
	if (cx1 <= cx0 || cy1 <= cy0) return null;
	const across = Math.ceil(lv.width / lv.tileW);
	let cost = 0;
	for (
		let ty = Math.floor(cy0 / lv.tileH);
		ty <= Math.floor((cy1 - 1) / lv.tileH);
		ty++
	)
		for (
			let tx = Math.floor(cx0 / lv.tileW);
			tx <= Math.floor((cx1 - 1) / lv.tileW);
			tx++
		)
			cost += lv.counts[ty * across + tx] ?? 0;
	return { hdr, li, cx0, cy0, w: cx1 - cx0, h: cy1 - cy0, cost };
}

async function readPlan(
	p: Plan,
	fetcher: RangeFetcher,
	stats: FetchStats,
	signal?: AbortSignal,
): Promise<Raster> {
	const px = p.hdr.levels[p.li].resX;
	const data = await readWindow(
		p.hdr,
		p.li,
		p.cx0,
		p.cy0,
		p.w,
		p.h,
		fetcher,
		stats,
		signal,
	);
	return {
		data,
		w: p.w,
		h: p.h,
		x0: p.hdr.originX + p.cx0 * px,
		y0: p.hdr.originY - p.cy0 * px,
		px,
	};
}

/** Bilinear over a set of rasters (first containing raster wins); NaN outside. */
function sampleRasters(rs: Raster[], E: number, N: number): number {
	for (const r of rs) {
		const fx = (E - r.x0) / r.px - 0.5;
		const fy = (r.y0 - N) / r.px - 0.5;
		if (fx < -0.5 || fy < -0.5 || fx > r.w - 0.5 || fy > r.h - 0.5) continue;
		const x = Math.min(r.w - 1, Math.max(0, fx));
		const y = Math.min(r.h - 1, Math.max(0, fy));
		const ix = Math.min(r.w - 2, Math.floor(x));
		const iy = Math.min(r.h - 2, Math.floor(y));
		if (ix < 0 || iy < 0) return r.data[Math.round(y) * r.w + Math.round(x)];
		const tx = x - ix;
		const ty = y - iy;
		const d = r.data;
		const o = iy * r.w + ix;
		const v00 = d[o];
		const v10 = d[o + 1];
		const v01 = d[o + r.w];
		const v11 = d[o + r.w + 1];
		const v =
			(v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
		if (Number.isFinite(v)) return v;
		// NaN neighbour (tile edge / nodata): nearest valid
		const nn = d[Math.round(y) * r.w + Math.round(x)];
		if (Number.isFinite(nn)) return nn;
	}
	return Number.NaN;
}

const CACHE = new Map<string, Promise<NearDsm | null>>();

/**
 * Load the DSM + DTM around (lat, lon) within radiusM at resM (2 m: the DSM's 2 m COG overview; 1 m: its
 * 1 m level, ≈4× the bytes). Null outside Switzerland or when no tile exists. Cached per argument set.
 * Throws on network failure (not cached).
 */
export function loadNearDsm(
	lat: number,
	lon: number,
	radiusM = 2000,
	resM: 2 | 1 = 2,
	opts: NearDsmOpts = {},
): Promise<NearDsm | null> {
	const key = JSON.stringify([
		lat.toFixed(7),
		lon.toFixed(7),
		radiusM,
		resM,
		opts.wedge ?? null,
		opts.dtmRes ?? 4,
		opts.maxTiles ?? null,
		opts.maxBytes ?? null,
	]);
	let p = CACHE.get(key);
	if (!p) {
		p = loadNearDsmUncached(lat, lon, radiusM, resM, opts);
		p.catch(() => CACHE.delete(key));
		CACHE.set(key, p);
	}
	return p;
}

async function loadNearDsmUncached(
	lat: number,
	lon: number,
	radiusM: number,
	resM: 2 | 1,
	opts: NearDsmOpts,
): Promise<NearDsm | null> {
	const t0 = performance.now();
	if (!inSwissExtent(lat, lon)) return null;
	const fetcher = opts.fetcher ?? httpRangeFetcher;
	const json = opts.json ?? httpJsonFetcher;
	const dtmRes = opts.dtmRes ?? 4;
	const stats = newStats();
	const frame = new EnuFrame(lat, lon, 0);
	const aff = enuToLv95Affine(frame);
	const [E0, N0] = [aff.E0, aff.N0];
	// meridian convergence: true north vs grid north (deg), from the affine map
	const conv = Math.atan2(aff.m[0 * 2 + 1], aff.m[3]) / DEG; // dE/dn vs dN/dn
	const R = radiusM;
	// candidate tiles, nearest first
	const cand: { kx: number; ky: number; dist: number }[] = [];
	for (
		let kx = Math.floor((E0 - R) / 1000);
		kx <= Math.floor((E0 + R) / 1000);
		kx++
	)
		for (
			let ky = Math.floor((N0 - R) / 1000);
			ky <= Math.floor((N0 + R) / 1000);
			ky++
		) {
			const s = tileSelected(kx, ky, E0, N0, R, -conv, opts.wedge);
			if (s.ok) cand.push({ kx, ky, dist: s.dist });
		}
	cand.sort((a, b) => a.dist - b.dist);
	const chosen = cand.slice(0, opts.maxTiles ?? cand.length);
	if (!chosen.length) return null;
	// one STAC bbox query per collection over the chosen tiles
	let bb: [number, number, number, number] = [180, 90, -180, -90];
	for (const c of chosen)
		for (const [dx, dy] of [
			[0.5, 0.5],
			[0.1, 0.1],
			[0.9, 0.9],
		]) {
			const [la, lo] = lv95ToWgs84((c.kx + dx) * 1000, (c.ky + dy) * 1000);
			bb = [
				Math.min(bb[0], lo),
				Math.min(bb[1], la),
				Math.max(bb[2], lo),
				Math.max(bb[3], la),
			];
		}
	const want = new Set(chosen.map((c) => `${c.kx}-${c.ky}`));
	const [dsmTiles, dtmTiles] = await Promise.all([
		stacTiles(DSM_COLLECTION, bb, 0.5, { json, signal: opts.signal, stats }),
		stacTiles(DTM_COLLECTION, bb, 2, { json, signal: opts.signal, stats }),
	]);
	const pickT = (ts: SwissTile[]) =>
		ts.filter((t) => want.has(`${t.kx}-${t.ky}`));
	const dsT = pickT(dsmTiles);
	const dtT = pickT(dtmTiles);
	if (!dsT.length) return null;
	const winOf = (t: SwissTile): [number, number, number, number] => [
		Math.max(t.kx * 1000, E0 - R - 8),
		Math.max(t.ky * 1000, N0 - R - 8),
		Math.min((t.kx + 1) * 1000, E0 + R + 8),
		Math.min((t.ky + 1) * 1000, N0 + R + 8),
	];
	const dist = new Map(chosen.map((c) => [`${c.kx}-${c.ky}`, c.dist]));
	const byDist = (x: SwissTile, y: SwissTile) =>
		(dist.get(`${x.kx}-${x.ky}`) ?? 0) - (dist.get(`${y.kx}-${y.ky}`) ?? 0);
	dsT.sort(byDist);
	const [dsP, dtP] = await Promise.all([
		Promise.all(
			dsT.map((t) => planTile(t, resM, winOf(t), fetcher, stats, opts.signal)),
		),
		Promise.all(
			dtT.map((t) =>
				planTile(t, dtmRes, winOf(t), fetcher, stats, opts.signal),
			),
		),
	]);
	// byte budget: nearest km tiles first, DSM + DTM of a tile together
	const budget = (opts.maxBytes ?? 4.5e6) - stats.bytes;
	const dtmOf = new Map(dtT.map((t, k) => [`${t.kx}-${t.ky}`, dtP[k]]));
	const keep = new Set<string>();
	let spent = 0;
	for (let k = 0; k < dsT.length; k++) {
		const key = `${dsT[k].kx}-${dsT[k].ky}`;
		const cost = (dsP[k]?.cost ?? 0) + (dtmOf.get(key)?.cost ?? 0);
		if (keep.size > 0 && spent + cost > budget) break;
		keep.add(key);
		spent += cost;
	}
	const [dsR, dtR] = await Promise.all([
		Promise.all(
			dsP.map((p, k) =>
				p && keep.has(`${dsT[k].kx}-${dsT[k].ky}`)
					? readPlan(p, fetcher, stats, opts.signal)
					: null,
			),
		),
		Promise.all(
			dtP.map((p, k) =>
				p && keep.has(`${dtT[k].kx}-${dtT[k].ky}`)
					? readPlan(p, fetcher, stats, opts.signal)
					: null,
			),
		),
	]);
	const fetchMs = performance.now() - t0;
	const dsRs = dsR.filter((r): r is Raster => !!r);
	const dtRs = dtR.filter((r): r is Raster => !!r);
	// resample to the ENU grid
	const half = Math.ceil(R / resM);
	const w = 2 * half + 1;
	const h = w;
	const e0 = -half * resM;
	const n0 = half * resM;
	const dsm = new Float32Array(w * h).fill(Number.NaN);
	const dtm = new Float32Array(w * h).fill(Number.NaN);
	const [a, b, c, d] = aff.m;
	const R2 = (R + resM) * (R + resM);
	for (let j = 0; j < h; j++) {
		const n = n0 - j * resM;
		for (let i = 0; i < w; i++) {
			const e = e0 + i * resM;
			if (e * e + n * n > R2) continue;
			if (opts.wedge && e * e + n * n > 400) {
				const az = Math.atan2(e, n) / DEG;
				if (Math.abs(wrap180(az - opts.wedge.yawDeg)) > opts.wedge.halfDeg + 3)
					continue;
			}
			const E = E0 + a * e + b * n;
			const N = N0 + c * e + d * n;
			const k = j * w + i;
			dsm[k] = sampleRasters(dsRs, E, N);
			dtm[k] = sampleRasters(dtRs, E, N);
		}
	}
	const used = (ts: SwissTile[]) =>
		ts.filter((t) => keep.has(`${t.kx}-${t.ky}`));
	const yrs = (ts: SwissTile[]) =>
		[...new Set(used(ts).map((t) => t.year))].sort();
	return {
		frame,
		res: resM,
		dsm,
		dtm,
		w,
		h,
		epoch: {
			dsm: Math.max(...used(dsT).map((t) => t.year)),
			dtm: used(dtT).length ? Math.max(...used(dtT).map((t) => t.year)) : 0,
		},
		e0,
		n0,
		radiusM: R,
		stats: {
			...stats,
			ms: performance.now() - t0,
			fetchMs,
			tiles: keep.size,
			dtmRes,
		},
		years: { dsm: yrs(dsT), dtm: yrs(dtT) },
	};
}

/** Bilinear height of `which` at ENU (e, n); NaN outside / no data. */
export function nearHeightAt(
	g: NearDsm,
	which: "dsm" | "dtm",
	e: number,
	n: number,
): number {
	const x = (e - g.e0) / g.res;
	const y = (g.n0 - n) / g.res;
	if (!(x >= 0 && y >= 0 && x <= g.w - 1 && y <= g.h - 1)) return Number.NaN;
	const ix = Math.min(g.w - 2, Math.floor(x));
	const iy = Math.min(g.h - 2, Math.floor(y));
	const tx = x - ix;
	const ty = y - iy;
	const a = g[which];
	const o = iy * g.w + ix;
	return (
		(a[o] * (1 - tx) + a[o + 1] * tx) * (1 - ty) +
		(a[o + g.w] * (1 - tx) + a[o + g.w + 1] * tx) * ty
	);
}

/** Engine eye rule (deck/scene.ts eyeAltitude) over a given ground height. */
export const eyeAltitudeOver = (alt: number | null | undefined, dem: number) =>
	alt != null ? Math.max(alt, dem + 1.6) : dem + 1.8;
