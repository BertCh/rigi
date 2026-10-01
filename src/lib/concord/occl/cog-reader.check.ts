// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W2.5 gate (CPU, real data): the loaders.gl COG reader (cogReader "loaders") against the own reader on
// real swissSURFACE3D (DSM) and swissALTI3D (DTM) COGs around the Swiss dev photos.
//   npx tsx src/lib/concord/occl/cog-reader.check.ts [--refresh]
//  1. per km tile under each Swiss dev photo (public/photos/photos.json): both headers equal (levels, tile
//     tables, origin, nodata); windows bit-identical (Float32, NaN = NaN): the ndsm levels (DSM 2 m and 1 m,
//     DTM 2 m and 4 m) around the photo, and the whole DSM 2 m / DTM 4 m level (the split read path)
//  2. loadNearDsm with each reader. Without a byte budget (700 m): dsm / dtm grids bit-identical (gated).
//     As ?concord=occl calls it (2000 m, the photo heading's wedge, default 4.5 MB budget): reported only,
//     because the budget counts header bytes and the two readers fetch headers differently
// Requests and bytes are counted per reader (RangeFetcher calls and payload bytes, as FetchStats).
//
// Network: STAC answers and byte ranges are kept in .cache/swiss-cog/ (gitignored); a second run is offline.
// scripts/ci/checks.mjs lists that directory under `needs`, so the CI row SKIPs until this was run once with
// network. --refresh ignores the disk cache.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNearDsm } from "./ndsm";
import {
	type CogHeader,
	type CogReader,
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
	stacTiles,
	wgs84ToLv95,
} from "./swiss-cog";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
	if (!cond) fails++;
};

// ---------------------------------------------------------------- disk-cached transport

const DIR = ".cache/swiss-cog";
const refresh = process.argv.includes("--refresh");
mkdirSync(DIR, { recursive: true });
const net = { requests: 0, bytes: 0 };
const fileOf = (key: string, ext: string) =>
	join(DIR, `${createHash("sha1").update(key).digest("hex")}.${ext}`);

const diskRange: RangeFetcher = async (url, start, end, signal) => {
	const f = fileOf(`${url} bytes=${start}-${end}`, "bin");
	if (!refresh && existsSync(f)) return new Uint8Array(readFileSync(f));
	const b = await httpRangeFetcher(url, start, end, signal);
	net.requests++;
	net.bytes += b.length;
	writeFileSync(f, b);
	return b;
};
const diskJson: JsonFetcher = async (url, signal) => {
	const f = fileOf(url, "json");
	if (!refresh && existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
	const j = await httpJsonFetcher(url, signal);
	net.requests++;
	writeFileSync(f, JSON.stringify(j));
	return j;
};

// ---------------------------------------------------------------- helpers

/** Bit mismatches between two Float32 windows (NaN payloads count as equal). */
function bitDiff(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return Number.POSITIVE_INFINITY;
	const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
	const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
	let n = 0;
	for (let k = 0; k < a.length; k++)
		if (ua[k] !== ub[k] && !(Number.isNaN(a[k]) && Number.isNaN(b[k]))) n++;
	return n;
}

const sameHeader = (a: CogHeader, b: CogHeader) =>
	JSON.stringify(a.levels) === JSON.stringify(b.levels) &&
	a.originX === b.originX &&
	a.originY === b.originY &&
	a.nodata === b.nodata &&
	a.littleEndian === b.littleEndian;

type Totals = {
	own: FetchStats;
	loaders: FetchStats;
	ms: Record<CogReader, number>;
};
const totals: Totals = {
	own: newStats(),
	loaders: newStats(),
	ms: { own: 0, loaders: 0 },
};

/** Pixel window [x0, y0, w, h] of `level` around LV95 (E, N), radius r metres, clamped to the image. */
function windowAround(
	hdr: CogHeader,
	level: number,
	E: number,
	N: number,
	r: number,
): [number, number, number, number] | null {
	const lv = hdr.levels[level];
	const px = lv.resX;
	const x0 = Math.max(0, Math.floor((E - r - hdr.originX) / px));
	const x1 = Math.min(lv.width, Math.ceil((E + r - hdr.originX) / px));
	const y0 = Math.max(0, Math.floor((hdr.originY - (N + r)) / px));
	const y1 = Math.min(lv.height, Math.ceil((hdr.originY - (N - r)) / px));
	return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

// ---------------------------------------------------------------- 1. windows

type Photo = {
	id: string;
	lat: number;
	lon: number;
	heading?: number;
	vfov?: number;
	width: number;
	height: number;
};
const photosJson = JSON.parse(
	readFileSync("public/photos/photos.json", "utf8"),
);
const photos: Photo[] = (
	Array.isArray(photosJson)
		? photosJson
		: (photosJson.photos ?? Object.values(photosJson))
).filter((p: Photo) => inSwissExtent(p.lat, p.lon));
console.log(
	`info  ${photos.length} Swiss dev photos: ${photos.map((p) => p.id).join(" ")}`,
);

const seen = new Set<string>();
let windows = 0;
let pixels = 0;
const wholeDone = { dsm: false, dtm: false };
for (const p of photos) {
	const [E, N] = wgs84ToLv95(p.lat, p.lon);
	const kx = Math.floor(E / 1000);
	const ky = Math.floor(N / 1000);
	const [la, lo] = lv95ToWgs84((kx + 0.5) * 1000, (ky + 0.5) * 1000);
	const bb: [number, number, number, number] = [
		lo - 0.001,
		la - 0.001,
		lo + 0.001,
		la + 0.001,
	];
	for (const [coll, gsd, kind] of [
		[DSM_COLLECTION, 0.5, "dsm"],
		[DTM_COLLECTION, 2, "dtm"],
	] as const) {
		const tiles = (await stacTiles(coll, bb, gsd, { json: diskJson })).filter(
			(t) => t.kx === kx && t.ky === ky,
		);
		const t = tiles[0];
		if (!t) {
			ok(false, `${p.id}: no ${kind} tile ${kx}-${ky} in STAC`);
			continue;
		}
		if (seen.has(t.href)) continue;
		seen.add(t.href);
		const st = { own: newStats(), loaders: newStats() };
		const t0 = performance.now();
		const own = await openCog(t.href, diskRange, st.own, undefined, 4096, {
			reader: "own",
		});
		const t1 = performance.now();
		const lod = await openCog(t.href, diskRange, st.loaders, undefined, 4096, {
			reader: "loaders",
		});
		const t2 = performance.now();
		totals.ms.own += t1 - t0;
		totals.ms.loaders += t2 - t1;
		const name = t.href.split("/").pop();
		ok(
			!!lod.loaders && sameHeader(own, lod),
			`${name}: loaders header ${lod.loaders ? "" : "(FELL BACK TO OWN) "}${sameHeader(own, lod) ? "equals" : "DIFFERS FROM"} own (${own.levels.map((l) => `${l.width}px/${l.resX}m`).join(", ")})`,
		);
		if (!lod.loaders) continue;
		const reads: [string, number, [number, number, number, number] | null][] =
			[];
		if (kind === "dsm") {
			for (const res of [2, 1]) {
				const li = pickLevel(own, res);
				reads.push([
					`${res} m around ${p.id}`,
					li,
					windowAround(own, li, E, N, 300),
				]);
			}
			if (!wholeDone.dsm) {
				const li = pickLevel(own, 2);
				reads.push([
					`whole 2 m level`,
					li,
					[0, 0, own.levels[li].width, own.levels[li].height],
				]);
				wholeDone.dsm = true;
			}
		} else {
			for (const res of [2, 4]) {
				const li = pickLevel(own, res);
				reads.push([
					`${res} m around ${p.id}`,
					li,
					windowAround(own, li, E, N, 400),
				]);
			}
			if (!wholeDone.dtm) {
				const li = pickLevel(own, 4);
				reads.push([
					`whole 4 m level`,
					li,
					[0, 0, own.levels[li].width, own.levels[li].height],
				]);
				wholeDone.dtm = true;
			}
		}
		for (const [what, li, win] of reads) {
			if (!win) continue;
			const [x0, y0, w, h] = win;
			const a0 = performance.now();
			const a = await readWindow(own, li, x0, y0, w, h, diskRange, st.own);
			const a1 = performance.now();
			const b = await readWindow(lod, li, x0, y0, w, h, diskRange, st.loaders);
			const a2 = performance.now();
			totals.ms.own += a1 - a0;
			totals.ms.loaders += a2 - a1;
			const d = bitDiff(a, b);
			let finite = 0;
			for (const v of a) if (Number.isFinite(v)) finite++;
			windows++;
			pixels += w * h;
			ok(
				d === 0 && finite > 0,
				`${name} level ${li} (${own.levels[li].resX} m) ${what}: ${w}×${h} px, ${d} bit mismatches, ${finite} valid`,
			);
		}
		console.log(
			`info  ${name}: own ${st.own.requests} req ${(st.own.bytes / 1024).toFixed(0)} KiB | loaders ${st.loaders.requests} req ${(st.loaders.bytes / 1024).toFixed(0)} KiB`,
		);
		for (const r of ["own", "loaders"] as const) {
			totals[r].requests += st[r].requests;
			totals[r].bytes += st[r].bytes;
		}
	}
}
console.log(
	`info  windows: ${windows} windows, ${pixels} px over ${seen.size} COGs. own ${totals.own.requests} requests, ${(totals.own.bytes / 1e6).toFixed(2)} MB, ${totals.ms.own.toFixed(0)} ms | loaders ${totals.loaders.requests} requests, ${(totals.loaders.bytes / 1e6).toFixed(2)} MB, ${totals.ms.loaders.toFixed(0)} ms (ms include disk-cache reads)`,
);

// ---------------------------------------------------------------- 2. loadNearDsm end to end

// one photo per site (the Niederhorn / Beatenberg group, Interlaken east, Uri)
const E2E = ["IMG_7018", "IMG_7053", "IMG_6971", "IMG_7131"];
let e2eSame = 0;
let e2eRun = 0;
for (const id of E2E) {
	const p = photos.find((x) => x.id === id);
	if (!p || p.heading == null || p.vfov == null) continue;
	const aspect = p.width / p.height;
	const hfov =
		(2 * Math.atan(Math.tan(((p.vfov / 2) * Math.PI) / 180) * aspect) * 180) /
		Math.PI;
	const wedge = { yawDeg: p.heading, halfDeg: hfov / 2 + 10 };
	const out: Partial<
		Record<CogReader, Awaited<ReturnType<typeof loadNearDsm>>>
	> = {};
	for (const reader of ["own", "loaders"] as const)
		out[reader] = await loadNearDsm(p.lat, p.lon, 2000, 2, {
			wedge,
			reader,
			fetcher: diskRange,
			json: diskJson,
		});
	const a = out.own;
	const b = out.loaders;
	e2eRun++;
	if (!a || !b) {
		ok(false, `${id}: loadNearDsm returned null (own ${!!a}, loaders ${!!b})`);
		continue;
	}
	const dd = bitDiff(a.dsm, b.dsm);
	const dt = bitDiff(a.dtm, b.dtm);
	const same = dd === 0 && dt === 0 && a.stats.tiles === b.stats.tiles;
	if (same) e2eSame++;
	console.log(
		`${same ? "PASS" : "INFO"}  ${id} loadNearDsm 2000 m wedge ${wedge.yawDeg.toFixed(0)}±${wedge.halfDeg.toFixed(0)}°: dsm ${dd}, dtm ${dt} bit mismatches; tiles kept own ${a.stats.tiles} / loaders ${b.stats.tiles}; own ${a.stats.requests} req ${(a.stats.bytes / 1e6).toFixed(2)} MB | loaders ${b.stats.requests} req ${(b.stats.bytes / 1e6).toFixed(2)} MB`,
	);
}
console.log(
	`info  loadNearDsm end to end: ${e2eSame}/${e2eRun} photos identical under the default byte budget`,
);
// the byte budget subtracts the header bytes spent while planning, and geotiff.js reads headers in 64 KiB
// blocks (the own reader: 4 KiB, grown on demand), so under a budget the loaders reader can keep fewer km
// tiles. Without a budget the grids must match bit for bit.
for (const id of ["IMG_7018", "IMG_7131"]) {
	const p = photos.find((x) => x.id === id);
	if (!p) continue;
	const [a, b] = await Promise.all(
		(["own", "loaders"] as const).map((reader) =>
			loadNearDsm(p.lat, p.lon, 700, 2, {
				reader,
				fetcher: diskRange,
				json: diskJson,
				maxBytes: Number.POSITIVE_INFINITY,
			}),
		),
	);
	ok(
		!!a &&
			!!b &&
			bitDiff(a.dsm, b.dsm) === 0 &&
			bitDiff(a.dtm, b.dtm) === 0 &&
			a.stats.tiles === b.stats.tiles,
		`${id} loadNearDsm 700 m, no byte budget: dsm ${a && b ? bitDiff(a.dsm, b.dsm) : "-"}, dtm ${a && b ? bitDiff(a.dtm, b.dtm) : "-"} bit mismatches, tiles ${a?.stats.tiles}/${b?.stats.tiles}; own ${a?.stats.requests} req ${((a?.stats.bytes ?? 0) / 1e6).toFixed(2)} MB | loaders ${b?.stats.requests} req ${((b?.stats.bytes ?? 0) / 1e6).toFixed(2)} MB`,
	);
}
console.log(
	`info  network this run: ${net.requests} requests, ${(net.bytes / 1e6).toFixed(2)} MB (0 = served from ${DIR})`,
);

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
