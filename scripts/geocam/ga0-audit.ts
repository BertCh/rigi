/**
 * GA0 audit (GEO, Agent A; rules in tools/research/geo/PROTOCOL.txt "GA0 - Agent A"). CPU-only, no renders,
 * no live services. DEV GT photos only: holdout ids are refused by assertDevGT (no override).
 *
 *   npx tsx scripts/geocam/ga0-audit.ts [IMG_xxxx ...]
 *
 * Per photo: EXIF GPSImgDirectionRef (census), WMM2025 declination at the fix and capture date (applied only
 * when the ref is magnetic), the app's eye (engine.ts eyeAltitude: max(alt, DEM + 1.6), Mapterhorn at the
 * fix), the lake floor (src/lib/geocam/lakes, OSM water from the cached out/concord/pins/osm/*_water.json;
 * level ele → table → Mapterhorn median), and the GT eye. Also a ref census of the non-GT bundled photos
 * (photos.json; holdout skipped) and the wild dev set (C0 meta has no ref: headingKnown only).
 * Writes out/geocam/ga0/audit.json and audit.txt (tools/research/geo/REPORT_GA0.txt is written from these
 * plus the browser gates).
 */
import fs from "node:fs";
import path from "node:path";
import exifr from "exifr";
import {
	candidateLakes,
	compactLakes,
	lakeFloorDetail,
	type WaterElement,
} from "../../src/lib/geocam/lakes";
import { declination } from "../../src/lib/geocam/priors/wmm";
import { IMG_DIR, ROOT } from "../lib/node-io";
import {
	assertDevGT,
	devGTPhotos,
	GEO_OUT,
	GT_HOLDOUT,
	loadGT,
	type Scene,
	terrainFor,
	wildDev,
	wildDevIds,
	writeJson,
} from "./lib";

type Bundled = {
	id: string;
	lat: number;
	lon: number;
	alt: number | null;
	hAccuracy: number | null;
	heading: number | null;
	takenAt: string;
	takenAtUtc?: string;
};
const bundled = JSON.parse(
	fs.readFileSync(path.join(ROOT, "public", "photos", "photos.json"), "utf8"),
) as Bundled[];

async function headingRef(id: string): Promise<string | null> {
	const f = path.join(IMG_DIR, `${id}.HEIC`);
	if (!fs.existsSync(f)) return "no-file";
	const e = await exifr
		.parse(f, { gps: true, exif: false, tiff: false, translateValues: false })
		.catch(() => null);
	return (e?.GPSImgDirectionRef as string | undefined) ?? null;
}

function cachedWater(): WaterElement[] {
	const dir = path.join(ROOT, "out", "concord", "pins", "osm");
	const seen = new Set<string>();
	const out: WaterElement[] = [];
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith("_water.json")))
		for (const e of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))
			.elements as WaterElement[]) {
			const k = `${e.type}/${e.id}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(e);
		}
	return out;
}

const r1 = (x: number | null | undefined) =>
	x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

async function main() {
	const only = process.argv.slice(2);
	const photos = devGTPhotos(only);
	const lakes = compactLakes(cachedWater());
	const gt = loadGT();
	const rows = [];
	for (const id of photos) {
		assertDevGT(id);
		const m = bundled.find((p) => p.id === id);
		if (!m) throw new Error(`${id} not in photos.json`);
		const g = gt[id];
		const ref = await headingRef(id);
		const date = new Date(m.takenAtUtc ?? m.takenAt);
		const decl = declination(m.lat, m.lon, m.alt ?? 0, date);
		const mh = await terrainFor({ photo: id, lat: m.lat, lon: m.lon } as Scene);
		const abs = (lat: number, lon: number) => {
			const h = mh.sampleAt(lon, lat, 0);
			return Number.isFinite(h) ? h : null;
		};
		const dem = abs(m.lat, m.lon);
		const eyeApp =
			m.alt != null ? Math.max(m.alt, (dem ?? m.alt) + 1.6) : (dem ?? 0) + 1.8;
		const cands = candidateLakes(lakes, m.lat, m.lon, {
			hAccM: m.hAccuracy,
			absHeight: abs,
		});
		const fl = lakeFloorDetail(cands, [0, 0], {
			hAccM: m.hAccuracy,
			demAtFix: dem,
		});
		// nearest lake for context (any distance)
		const all = candidateLakes(lakes, m.lat, m.lon, {
			hAccM: 1e9, // radius clamp 100 + 30 m: context only
			absHeight: abs,
		});
		const binds = fl != null && fl.floorM > eyeApp;
		const eyeGeo = binds ? (fl as { floorM: number }).floorM : eyeApp;
		rows.push({
			id,
			lat: m.lat,
			lon: m.lon,
			hAcc: m.hAccuracy,
			alt: r1(m.alt),
			headingRef: ref,
			declDeg: r1(decl),
			declApplied: ref === "M",
			demFix: r1(dem),
			eyeApp: r1(eyeApp),
			gtEye: r1(g?.eye),
			gtEyeSource: g?.eyeSource,
			floor: fl
				? {
						floorM: r1(fl.floorM),
						lake: fl.lake,
						levelM: r1(fl.levelM),
						levelSource: fl.levelSource,
						distM: r1(fl.distM),
						inside: fl.inside,
						radiusM: fl.radiusM,
					}
				: null,
			lakesWithin130m: all.map((l) => l.name ?? l.id),
			floorBinds: binds,
			eyeGeo: r1(eyeGeo),
			errApp: r1(g ? Math.abs(eyeApp - g.eye) : null),
			errGeo: r1(g ? Math.abs(eyeGeo - g.eye) : null),
			gtBelowFloor: fl != null && g != null && g.eye < fl.floorM,
		});
		console.log(
			`${id} ref=${ref ?? "-"} D=${decl.toFixed(2)}° dem=${dem?.toFixed(1)} alt=${m.alt?.toFixed(1)} eyeApp=${eyeApp.toFixed(1)} gt=${g?.eye?.toFixed(1)} floor=${fl ? `${fl.floorM.toFixed(1)} (${fl.lake} ${fl.levelSource}, ${fl.inside ? "inside" : `${fl.distM.toFixed(0)} m`})` : "-"}${binds ? " BINDS" : ""}`,
		);
	}
	// census of the other bundled photos (not GT dev, holdout skipped)
	const census: { id: string; ref: string | null; heading: number | null }[] =
		[];
	for (const p of bundled) {
		if ((GT_HOLDOUT as readonly string[]).includes(p.id)) continue;
		if (photos.includes(p.id)) continue;
		if (gt[p.id]?.yaw != null) continue; // a GT photo outside the dev list: skip
		census.push({ id: p.id, ref: await headingRef(p.id), heading: p.heading });
	}
	const wild = wildDevIds().map((pid) => {
		const w = wildDev(pid);
		return {
			pid,
			headingKnown: w ? w.meta.headingDeg != null : null,
		};
	});
	const refCount = (xs: (string | null)[]) => {
		const c: Record<string, number> = {};
		for (const x of xs) c[x ?? "none"] = (c[x ?? "none"] ?? 0) + 1;
		return c;
	};
	const summary = {
		devRefs: refCount(rows.map((r) => r.headingRef)),
		otherBundledRefs: refCount(census.map((c) => c.ref)),
		wildDevHeadingKnown: wild.filter((w) => w.headingKnown).length,
		wildDevN: wild.length,
		declApplied: rows.filter((r) => r.declApplied).length,
		floorExists: rows.filter((r) => r.floor).length,
		floorBinds: rows.filter((r) => r.floorBinds).length,
		boundCloserToGT: rows.filter(
			(r) =>
				r.floorBinds &&
				(r.errGeo ?? Number.POSITIVE_INFINITY) < (r.errApp ?? 0),
		).length,
		gtBelowFloor: rows.filter((r) => r.gtBelowFloor).map((r) => r.id),
	};
	const out = {
		format: "geocam-ga0-audit/1",
		created: new Date().toISOString(),
		protocol:
			"tools/research/geo/PROTOCOL.txt GA0 - Agent A (2026-09-30T03:04Z)",
		water: "out/concord/pins/osm/*_water.json union (cached Overpass)",
		dem: "Mapterhorn (scripts/geocam/lib.ts terrainFor)",
		summary,
		rows,
		census,
		wild,
	};
	writeJson(path.join(GEO_OUT, "ga0", "audit.json"), out);
	const lines = [
		`GA0 audit (Agent A), ${out.created}. DEV GT only (holdout refused). ${out.protocol}.`,
		`Water: ${out.water}. DEM: ${out.dem}.`,
		"",
		"id        ref  decl°   hAcc  alt      DEM(fix)  eyeApp   GT eye   floor (lake, source, where)                binds  |eyeApp-GT| |eyeGeo-GT|",
		...rows.map(
			(r) =>
				`${r.id}  ${String(r.headingRef ?? "-").padEnd(3)} ${String(r.declDeg).padStart(6)} ${String(r1(r.hAcc)).padStart(6)} ${String(r.alt).padStart(8)} ${String(r.demFix).padStart(8)} ${String(r.eyeApp).padStart(8)} ${String(r.gtEye).padStart(8)}  ${(r.floor ? `${r.floor.floorM} (${r.floor.lake}, ${r.floor.levelSource}, ${r.floor.inside ? "inside" : `${r.floor.distM} m`})` : "-").padEnd(42)} ${r.floorBinds ? "YES" : "no "}   ${String(r.errApp).padStart(8)} ${String(r.errGeo).padStart(10)}`,
		),
		"",
		`summary: ${JSON.stringify(summary)}`,
		`other bundled photos (non-GT, holdout skipped): ${census.map((c) => `${c.id}=${c.ref ?? "none"}`).join(" ")}`,
		`wild dev: ${summary.wildDevHeadingKnown}/${summary.wildDevN} have a heading; C0 meta keeps no GPSImgDirectionRef.`,
	];
	fs.writeFileSync(
		path.join(GEO_OUT, "ga0", "audit.txt"),
		`${lines.join("\n")}\n`,
	);
	console.log(`\n${JSON.stringify(summary)}`);
}

await main();
