// WP-F probe: bytes + latency of the per-photo DSM/DTM load, per configuration, from live data.geo.admin.ch.
//   npx tsx tools/concord/occl/probe.mts [--photos=IMG_7018,...] [--configs=A,B,C,D] [--fill-cache]
// Cold network numbers: every config fetches afresh (no disk cache). --fill-cache additionally loads the
// eval configuration (B) through the disk cache (tools/concord/occl/cache, ≤ 50 MB).
// Photos: every GT photo inside Switzerland (bytes/latency only — no labels or pins are read).
import fs from "node:fs";
import path from "node:path";
import {
	loadNearDsm,
	type NearDsmOpts,
} from "../../../src/lib/concord/occl/ndsm";
import {
	httpJsonFetcher,
	httpRangeFetcher,
	inSwissExtent,
} from "../../../src/lib/concord/occl/swiss-cog";
import {
	cacheBytes,
	cachedJsonFetcher,
	cachedRangeFetcher,
} from "./node-io.mts";
import { wedgeOf } from "./wedge.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const arg = (k: string) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const gt = JSON.parse(
	fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
) as Record<
	string,
	{
		lat: number;
		lon: number;
		yaw: number | null;
		f: number;
		width: number;
		height: number;
	}
>;
const photos = (arg("photos")?.split(",") ?? Object.keys(gt)).filter(
	(p) => gt[p]?.yaw != null,
);

type Cfg = {
	name: string;
	radius: number;
	wedge: boolean;
	dtmRes: 2 | 4;
	res: 2 | 1;
	maxTiles?: number;
	maxBytes?: number;
};
const CONFIGS: Cfg[] = [
	{ name: "A", radius: 2000, wedge: false, dtmRes: 4, res: 2 },
	{ name: "B", radius: 2000, wedge: true, dtmRes: 4, res: 2 },
	{ name: "C", radius: 1000, wedge: true, dtmRes: 4, res: 2 },
	{ name: "D", radius: 2000, wedge: true, dtmRes: 2, res: 2 },
	{ name: "E", radius: 1500, wedge: true, dtmRes: 4, res: 2 },
	{ name: "F", radius: 2000, wedge: true, dtmRes: 4, res: 2, maxTiles: 4 },
	// the product default: 2 km wedge under the 4.5 MB byte budget (loadNearDsm's default maxBytes)
	{ name: "P", radius: 2000, wedge: true, dtmRes: 4, res: 2, maxBytes: 4.5e6 },
];
const want = arg("configs")?.split(",") ?? ["B", "C", "F", "P"];

const rows: Record<string, unknown>[] = [];
for (const id of photos) {
	const g = gt[id];
	if (!inSwissExtent(g.lat, g.lon)) {
		console.log(`${id}: outside CH → null (no fetch)`);
		rows.push({ id, outside: true });
		continue;
	}
	for (const c of CONFIGS.filter((c) => want.includes(c.name))) {
		const opts: NearDsmOpts = {
			fetcher: httpRangeFetcher,
			json: httpJsonFetcher,
			dtmRes: c.dtmRes,
			wedge: c.wedge ? wedgeOf(g) : undefined,
			maxTiles: c.maxTiles,
			maxBytes: c.maxBytes ?? Number.POSITIVE_INFINITY,
		};
		// jitter the key so the in-memory cache never serves a previous config
		try {
			const d = await loadNearDsm(g.lat, g.lon, c.radius, c.res, opts);
			if (!d) {
				console.log(`${id} ${c.name}: null`);
				continue;
			}
			let nObj = 0;
			let nValid = 0;
			for (let k = 0; k < d.dsm.length; k++) {
				const v = d.dsm[k] - d.dtm[k];
				if (!Number.isFinite(v)) continue;
				nValid++;
				if (v >= 2.5) nObj++;
			}
			const s = d.stats;
			const row = {
				id,
				cfg: c.name,
				radius: c.radius,
				wedge: c.wedge,
				dtmRes: c.dtmRes,
				tiles: s.tiles,
				requests: s.requests + s.stacRequests,
				MB: +((s.bytes + s.stacBytes) / 1e6).toFixed(2),
				stacKB: +(s.stacBytes / 1e3).toFixed(0),
				ms: Math.round(s.ms),
				fetchMs: Math.round(s.fetchMs),
				objFrac: +(nObj / Math.max(1, nValid)).toFixed(3),
				years: d.years,
			};
			rows.push(row);
			console.log(JSON.stringify(row));
		} catch (e) {
			console.log(`${id} ${c.name}: ERROR ${(e as Error).message}`);
			rows.push({ id, cfg: c.name, error: (e as Error).message });
		}
	}
}

if (process.argv.includes("--fill-cache")) {
	for (const id of photos) {
		const g = gt[id];
		if (!inSwissExtent(g.lat, g.lon)) continue;
		await loadNearDsm(g.lat, g.lon, 2000, 2, {
			fetcher: cachedRangeFetcher,
			json: cachedJsonFetcher,
			dtmRes: 4,
			wedge: wedgeOf(g),
			maxTiles: 99,
			maxBytes: Number.POSITIVE_INFINITY,
		});
		console.log(`cache ${id}: ${(cacheBytes() / 1e6).toFixed(1)} MB`);
	}
}

const out = path.join(ROOT, "out/concord/occl");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "probe.json"), JSON.stringify(rows, null, 1));
// summary per config
for (const c of CONFIGS.filter((c) => want.includes(c.name))) {
	const r = rows.filter((x) => x.cfg === c.name && !x.error) as {
		MB: number;
		ms: number;
	}[];
	if (!r.length) continue;
	const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
	console.log(
		`config ${c.name} (r=${c.radius}${c.wedge ? " wedge" : ""} dtm${c.dtmRes}m): n=${r.length} MB median ${med(r.map((x) => x.MB))} max ${Math.max(...r.map((x) => x.MB))}; ms median ${med(r.map((x) => x.ms))} max ${Math.max(...r.map((x) => x.ms))}; <5MB&<1.5s: ${r.filter((x) => x.MB < 5 && x.ms < 1500).length}/${r.length}`,
	);
}
