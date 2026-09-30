/**
 * WP-B study: eye and intrinsics priors (CPU, node). Writes out/concord/priors/*.json and prints tables.
 *
 *   npx tsx scripts/concord/priors-study.ts consistency   MSL-vs-ellipsoid table for every GPS photo
 *   npx tsx scripts/concord/priors-study.ts sigma         fit σA (altitude noise) on DEV photos
 *   npx tsx scripts/concord/priors-study.ts focal         fit LENS_TABLE evidence on DEV, score EXIF vs table
 *                                                         (holdout scored only with CONCORD_HOLDOUT=final)
 *   npx tsx scripts/concord/priors-study.ts eye           old eye rule vs concordEye on DEV photos: skyline
 *                                                         rotation refit at each eye, pins by band (eval lib)
 *   npx tsx scripts/concord/priors-study.ts all
 *
 * DEM: Mapterhorn (finest zoom with data, z17 in CH) from .cache/dem-mapterhorn, Terrarium for reference.
 * Split: tools/concord/pins/PROTOCOL.txt (photo level). Holdout photos are never used to fit anything.
 */
import fs from "node:fs";
import path from "node:path";
import exifr from "exifr";
import { vfovFromFocal } from "../../src/lib/camera";
import { focalPxFromF35 } from "../../src/lib/camera/focal";
import {
	type CameraX,
	distanceBand,
	IDENTITY_INTRINSICS,
	type Vec3,
} from "../../src/lib/concord/core";
import {
	concordEye,
	EYE_ABOVE_GROUND,
	EYE_PRIOR_DEFAULTS,
	eyePriorFromExif,
	floorEye,
	isoBandSeeds,
} from "../../src/lib/concord/priors/altitude";
import {
	focalPrior,
	LENS_TABLE,
	lensEntry,
} from "../../src/lib/concord/priors/focal-table";
import {
	type GroundFn,
	groundFromHeightAt,
	offsetLatLon,
} from "../../src/lib/concord/priors/ground";
import {
	MAPTERHORN,
	TERRARIUM_AWS,
	type TerrainLevel,
} from "../../src/lib/dem";
import { computeHorizon, type HorizonProfile } from "../../src/lib/geo/horizon";
import { detectSkyline } from "../../src/lib/geo/skyline";
import { loadTerrain, type TerrainSampler } from "../../src/lib/geo/terrain";
import {
	fitRotationToHorizon,
	type SkylineSample,
} from "../../src/lib/pose6dof/eye";
import {
	demTileLoaderNode,
	heicToJpeg,
	IMG_DIR,
	loadRGBA,
	ROOT,
} from "../lib/node-io";
import {
	bandTable,
	builtinFit,
	type EvalResidual,
	gtCam,
	loadGT,
	loadPins,
	loadScene,
	loadSplit,
	median,
	scorePins,
	skylineRms,
} from "./lib";

const OUT = path.join(ROOT, "out", "concord", "priors");
fs.mkdirSync(OUT, { recursive: true });
const DEG = Math.PI / 180;
const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");
const pad = (s: string | number, n: number) => String(s).padStart(n);

// ------------------------------------------------------------------ EXIF

type Exif = {
	photo: string;
	make?: string;
	model?: string;
	lensModel?: string;
	focalMm?: number;
	f35?: number;
	exifW?: number;
	exifH?: number;
	lat: number;
	lon: number;
	alt: number | null;
	altRef?: number;
	hAcc: number | null;
	speed?: number;
	dateTimeOriginal?: string;
	offsetTime?: string;
	gpsTime?: string;
	fixAgeS: number;
};

async function readExif(photo: string): Promise<Exif> {
	const e = await exifr.parse(path.join(IMG_DIR, `${photo}.HEIC`), {
		gps: true,
		exif: true,
		tiff: true,
		xmp: false,
		makerNote: false,
		translateValues: false,
		reviveValues: false,
	});
	const ref = e.GPSAltitudeRef;
	const refN = typeof ref === "number" ? ref : ref?.[0];
	const alt =
		typeof e.GPSAltitude === "number"
			? refN === 1
				? -e.GPSAltitude
				: e.GPSAltitude
			: null;
	const gt = Array.isArray(e.GPSTimeStamp)
		? e.GPSTimeStamp.map((x: number) => fmt(x, 2)).join(":")
		: String(e.GPSTimeStamp ?? "");
	// GPS fix age: DateTimeOriginal (local, OffsetTimeOriginal) − GPSDateStamp/GPSTimeStamp (UTC), s
	let fixAgeS = Number.NaN;
	{
		const m = String(e.DateTimeOriginal ?? "").match(
			/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/,
		);
		const off = String(e.OffsetTimeOriginal ?? e.OffsetTime ?? "").match(
			/([+-])(\d+):(\d+)/,
		);
		const d = String(e.GPSDateStamp ?? "").match(/(\d+):(\d+):(\d+)/);
		if (m && off && d && Array.isArray(e.GPSTimeStamp)) {
			const sub = Number(`0.${e.SubSecTimeOriginal ?? 0}`);
			const offS =
				(off[1] === "-" ? -1 : 1) *
				(Number(off[2]) * 3600 + Number(off[3]) * 60);
			const photoUtc =
				Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 +
				sub -
				offS;
			const [hh, mm, ss] = e.GPSTimeStamp as number[];
			const gpsUtc = Date.UTC(+d[1], +d[2] - 1, +d[3], hh, mm, 0) / 1000 + ss;
			fixAgeS = photoUtc - gpsUtc;
		}
	}
	return {
		photo,
		fixAgeS,
		make: e.Make,
		model: e.Model,
		lensModel: e.LensModel,
		focalMm: e.FocalLength,
		f35: e.FocalLengthIn35mmFormat,
		exifW: e.ExifImageWidth,
		exifH: e.ExifImageHeight,
		lat: e.latitude,
		lon: e.longitude,
		alt,
		altRef: refN,
		hAcc: e.GPSHPositioningError ?? null,
		speed: e.GPSSpeed,
		dateTimeOriginal: String(e.DateTimeOriginal ?? ""),
		offsetTime: e.OffsetTime,
		gpsTime: `${e.GPSDateStamp ?? ""} ${gt}`,
	};
}

const allPhotos = () =>
	fs
		.readdirSync(IMG_DIR)
		.filter((f) => f.endsWith(".HEIC"))
		.map((f) => f.replace(/\.HEIC$/, ""))
		.sort();

let exifMemo: Exif[] | undefined;
async function allExif() {
	if (!exifMemo) {
		exifMemo = [];
		for (const p of allPhotos()) exifMemo.push(await readExif(p));
		// cross-check the ingest metadata (public/photos/photos.json)
		const meta = JSON.parse(
			fs.readFileSync(
				path.join(ROOT, "public", "photos", "photos.json"),
				"utf8",
			),
		) as { id: string; alt: number; hAccuracy: number; lat: number }[];
		for (const m of meta) {
			const e = exifMemo.find((x) => x.photo === m.id);
			if (!e) continue;
			if (
				Math.abs((e.alt ?? 0) - m.alt) > 1e-6 ||
				Math.abs((e.hAcc ?? 0) - m.hAccuracy) > 1e-6 ||
				Math.abs(e.lat - m.lat) > 1e-9
			)
				console.error(`${m.id}: EXIF and photos.json disagree`);
		}
	}
	return exifMemo;
}

// ------------------------------------------------------------------ DEM

const loadMH = demTileLoaderNode(MAPTERHORN);
const loadTR = demTileLoaderNode(TERRARIUM_AWS);
const mhTiles = new Map<string, Float32Array>();
const trTiles = new Map<string, Float32Array>();
const NEAR_ZOOMS = [17, 16, 15, 14, 13, 12];

/** Mapterhorn around the fix, finest zoom with data at each point (z17 → z12). */
async function nearMH(lat: number, lon: number, radius: number) {
	const levels: TerrainLevel[] = NEAR_ZOOMS.map((z) => ({
		z,
		maxDistance: radius,
	}));
	const t = await loadTerrain(
		lat,
		lon,
		loadMH,
		levels,
		mhTiles,
		8,
		MAPTERHORN.tileSize,
	);
	// zoom actually used at the fix
	let zFix = Number.NaN;
	for (const z of NEAR_ZOOMS)
		if (Number.isFinite(t.sample(lon, lat, z))) {
			zFix = z;
			break;
		}
	const ground = groundFromHeightAt(lat, lon, (la, lo) =>
		t.sampleAt(lo, la, 0),
	);
	return { t, ground, zFix };
}

async function terrariumGround(lat: number, lon: number) {
	const t = await loadTerrain(
		lat,
		lon,
		loadTR,
		[{ z: 15, maxDistance: 50 }],
		trTiles,
	);
	return t.sample(lon, lat, 15);
}

/**
 * Approximate EGM2008 geoid undulation N (m) per region: hand-entered from published geoid maps, NOT a
 * model evaluation (no geoid model in the repo; downloads are out of scope). ±3 m. Only used to ask
 * "does the altitude read like MSL (h) or ellipsoidal (h + N)?" — the two differ by |N| ≥ 16 m here.
 */
function geoidN(lat: number, lon: number): { N: number; where: string } {
	if (lat > 45.5 && lat < 48 && lon > 5.9 && lon < 10.5)
		return lon > 8.3
			? { N: 48.5, where: "central CH" }
			: { N: 49.5, where: "Bernese Oberland" };
	if (lat > 27 && lat < 30 && lon > -19 && lon < -13)
		return { N: 45, where: "Canary Is." };
	if (lat > 43 && lat < 46 && lon > -72 && lon < -69)
		return { N: -27, where: "N. Appalachians" };
	if (lat > 40 && lat < 41.5 && lon > -112.5 && lon < -110.5)
		return { N: -16.5, where: "Wasatch" };
	if (lat > 49 && lat < 51.5 && lon > -118 && lon < -114)
		return { N: -18, where: "Canadian Rockies" };
	if (lat > 38.5 && lat < 40 && lon > -121 && lon < -119.5)
		return { N: -25, where: "Sierra Nevada" };
	return { N: Number.NaN, where: "?" };
}

type Disk = {
	min: number;
	max: number;
	/** distance (m) from the fix to the nearest cell with |DEM + 1.6 − target| ≤ tol */
	distIso: number;
};
function diskStats(
	ground: GroundFn,
	target: number,
	radius: number,
	tol = 2,
): Disk {
	let min = Infinity;
	let max = -Infinity;
	let distIso = Infinity;
	const step = Math.max(0.5, radius / 60);
	const m = Math.ceil(radius / step);
	for (let j = -m; j <= m; j++)
		for (let i = -m; i <= m; i++) {
			const d = Math.hypot(i, j) * step;
			if (d > radius) continue;
			const g = ground(i * step, j * step);
			if (!Number.isFinite(g)) continue;
			const e = g + EYE_ABOVE_GROUND;
			min = Math.min(min, e);
			max = Math.max(max, e);
			if (Math.abs(e - target) <= tol) distIso = Math.min(distIso, d);
		}
	return { min, max, distIso };
}

/** DEM slope at the fix (deg), from ±5 m central differences. */
function slopeDeg(ground: GroundFn) {
	const gx = (ground(5, 0) - ground(-5, 0)) / 10;
	const gy = (ground(0, 5) - ground(0, -5)) / 10;
	return Math.atan(Math.hypot(gx, gy)) / DEG;
}

/** Where is the MSL iso-band (|DEM + 1.6 − alt| ≤ tol) within `radius`: nearest point and centroid (az°, m). */
function isoWhere(ground: GroundFn, alt: number, radius: number, tol = 2) {
	let n = 0;
	let sx = 0;
	let sy = 0;
	let best = { d: Infinity, az: Number.NaN };
	const step = Math.max(0.5, radius / 60);
	const m = Math.ceil(radius / step);
	for (let j = -m; j <= m; j++)
		for (let i = -m; i <= m; i++) {
			const x = i * step;
			const y = j * step;
			const d = Math.hypot(x, y);
			if (d > radius) continue;
			const g = ground(x, y);
			if (!Number.isFinite(g) || Math.abs(g + EYE_ABOVE_GROUND - alt) > tol)
				continue;
			n++;
			sx += x;
			sy += y;
			if (d < best.d)
				best = { d, az: (((Math.atan2(x, y) / DEG) % 360) + 360) % 360 };
		}
	const cx = sx / Math.max(1, n);
	const cy = sy / Math.max(1, n);
	return {
		nearest: best,
		centroid: {
			d: Math.hypot(cx, cy),
			az: (((Math.atan2(cx, cy) / DEG) % 360) + 360) % 360,
		},
		n,
	};
}

// ------------------------------------------------------------------ consistency

type ConsRow = {
	photo: string;
	split: string;
	region: string;
	lens: string;
	alt: number;
	hAcc: number;
	zFix: number;
	gMH: number;
	gTR: number;
	gtDemGround: number | null;
	gtEye: number | null;
	N: number;
	rMsl: number;
	rEll: number;
	slope: number;
	disk1: Disk;
	disk2: Disk;
	distIsoEll: number;
	verdict: string;
	fixAgeS: number;
	speed?: number;
	gtYaw: number | null;
	iso: ReturnType<typeof isoWhere>;
};

async function consistency(): Promise<ConsRow[]> {
	const split = loadSplit();
	const gt = loadGT();
	const rows: ConsRow[] = [];
	for (const e of await allExif()) {
		if (e.alt == null) continue;
		const hAcc = e.hAcc ?? 20;
		const R = Math.min(200, Math.max(30, 2 * hAcc)) + 10;
		const { ground, zFix } = await nearMH(e.lat, e.lon, R);
		const gMH = ground(0, 0);
		const gTR = await terrariumGround(e.lat, e.lon);
		const { N, where } = geoidN(e.lat, e.lon);
		const rMsl = e.alt - (gMH + EYE_ABOVE_GROUND);
		const rEll = e.alt - N - (gMH + EYE_ABOVE_GROUND);
		const r1 = Math.max(5, hAcc);
		const disk1 = diskStats(ground, e.alt, r1);
		const disk2 = diskStats(ground, e.alt, 2 * r1);
		const distIsoEll = diskStats(ground, e.alt - N, 2 * r1).distIso;
		// verdict: which datum puts DEM + 1.6 = alt inside the 2σH disk (σA tolerance 2 m, plus 3 m band)?
		const inMsl = e.alt >= disk2.min - 3 && e.alt <= disk2.max + 3;
		const inEll = e.alt - N >= disk2.min - 3 && e.alt - N <= disk2.max + 3;
		let verdict = inMsl
			? inEll
				? "both (ambiguous)"
				: "MSL"
			: inEll
				? "ellipsoidal"
				: e.alt > disk2.max
					? "neither: above every DEM+1.6 in 2σH"
					: "neither: below every DEM+1.6 in 2σH";
		if (!Number.isFinite(N)) verdict += " (N unknown)";
		const g = gt[e.photo];
		const iso = isoWhere(ground, e.alt, 2 * r1);
		rows.push({
			fixAgeS: e.fixAgeS,
			speed: e.speed,
			gtYaw: g?.yaw ?? null,
			iso,
			photo: e.photo,
			split: split[e.photo] ?? "no-GT",
			region: where,
			lens: `${e.focalMm}mm/${e.f35}`,
			alt: e.alt,
			hAcc,
			zFix,
			gMH,
			gTR,
			gtDemGround: g?.demGround ?? null,
			gtEye: g?.eye ?? null,
			N,
			rMsl,
			rEll,
			slope: slopeDeg(ground),
			disk1,
			disk2,
			distIsoEll,
			verdict,
		});
	}
	console.log(
		"\nMSL-vs-ellipsoid consistency (every photo with a GPS altitude). DEM = Mapterhorn at the finest zoom",
	);
	console.log(
		"with data (zFix); r = alt − (DEM(fix) + 1.6); N = approx. EGM2008 undulation (±3 m, hand-entered);",
	);
	console.log(
		"disk σ / 2σ = range of DEM + 1.6 within hAcc / 2·hAcc of the fix; iso = distance to the nearest point",
	);
	console.log(
		"with |DEM + 1.6 − alt| ≤ 2 m (MSL reading) / ≤ 2 m of alt − N (ellipsoidal reading).",
	);
	console.log(
		`${"photo".padEnd(9)} ${"split".padEnd(7)} ${"lens".padEnd(9)} ${pad("alt", 7)} ${pad("hAcc", 5)} ${pad("z", 2)} ${pad("DEM", 7)} ${pad("Terr", 7)} ${pad("slope", 5)} ${pad("r_MSL", 6)} ${pad("N", 5)} ${pad("r_ell", 6)} ${pad("disk σ", 13)} ${pad("disk 2σ", 13)} ${pad("isoMSL", 6)} ${pad("isoEll", 6)}  verdict`,
	);
	for (const r of rows)
		console.log(
			`${r.photo.padEnd(9)} ${r.split.padEnd(7)} ${r.lens.padEnd(9)} ${pad(fmt(r.alt), 7)} ${pad(fmt(r.hAcc, 0), 5)} ${pad(r.zFix, 2)} ${pad(fmt(r.gMH), 7)} ${pad(fmt(r.gTR), 7)} ${pad(fmt(r.slope, 0), 5)} ${pad(fmt(r.rMsl), 6)} ${pad(fmt(r.N, 1), 5)} ${pad(fmt(r.rEll), 6)} ${pad(`${fmt(r.disk1.min - r.alt, 0)}..${fmt(r.disk1.max - r.alt, 0)}`, 13)} ${pad(`${fmt(r.disk2.min - r.alt, 0)}..${fmt(r.disk2.max - r.alt, 0)}`, 13)} ${pad(fmt(r.disk2.distIso, 0), 6)} ${pad(fmt(r.distIsoEll, 0), 6)}  ${r.verdict}`,
		);
	console.log(
		"(disk columns are DEM + 1.6 − alt: a range that brackets 0 means some point within that radius explains the altitude)",
	);
	console.log(
		"\nWhere the MSL iso-band lies (within 2σH, |DEM + 1.6 − alt| ≤ 2 m), fix age (photo − GPS time) and GPS speed:",
	);
	console.log(
		`${"photo".padEnd(9)} ${pad("fixAge s", 8)} ${pad("km/h", 5)} ${pad("GT yaw", 6)} ${pad("nearest", 13)} ${pad("centroid", 13)} ${pad("cells", 5)}`,
	);
	for (const r of rows)
		console.log(
			`${r.photo.padEnd(9)} ${pad(fmt(r.fixAgeS, 1), 8)} ${pad(fmt(r.speed ?? Number.NaN, 1), 5)} ${pad(r.gtYaw == null ? "-" : fmt(r.gtYaw, 0), 6)} ${pad(`${fmt(r.iso.nearest.d, 0)} m @${fmt(r.iso.nearest.az, 0)}°`, 13)} ${pad(`${fmt(r.iso.centroid.d, 0)} m @${fmt(r.iso.centroid.az, 0)}°`, 13)} ${pad(r.iso.n, 5)}`,
		);
	fs.writeFileSync(
		path.join(OUT, "consistency.json"),
		JSON.stringify(rows, null, 1),
	);
	return rows;
}

// ------------------------------------------------------------------ σA (dev only)

/**
 * Marginal likelihood of σA under: alt = DEM(x) + 1.6 + ε, ε ~ N(0, σA²), x ~ N(0, σH² I) (σH = hAcc).
 * DEV photos only.
 */
async function fitSigma() {
	const split = loadSplit();
	const pool = process.argv.includes("--with-nogt")
		? ["dev", undefined]
		: ["dev"];
	const exif = (await allExif()).filter(
		(e) => pool.includes(split[e.photo]) && e.alt != null,
	);
	console.log(
		`\nσA fit pool: ${pool.includes(undefined) ? "DEV + photos without GT (robustness check)" : "DEV"}: ${exif.map((e) => e.photo.slice(4)).join(" ")}`,
	);
	const grids: { photo: string; w: number[]; r: number[] }[] = [];
	for (const e of exif) {
		const sH = Math.max(5, e.hAcc ?? 20);
		const { ground } = await nearMH(e.lat, e.lon, 3 * sH + 10);
		const w: number[] = [];
		const r: number[] = [];
		const step = Math.max(0.5, sH / 15);
		const m = Math.ceil((3 * sH) / step);
		for (let j = -m; j <= m; j++)
			for (let i = -m; i <= m; i++) {
				const d2 = (i * i + j * j) * step * step;
				if (d2 > 9 * sH * sH) continue;
				const g = ground(i * step, j * step);
				if (!Number.isFinite(g)) continue;
				w.push(Math.exp(-d2 / (2 * sH * sH)));
				r.push((e.alt as number) - g - EYE_ABOVE_GROUND);
			}
		grids.push({ photo: e.photo, w, r });
	}
	const ll = (s: number, g: (typeof grids)[number], b = 0) => {
		let num = 0;
		let den = 0;
		for (let k = 0; k < g.w.length; k++) {
			const r = g.r[k] - b;
			num +=
				(g.w[k] * Math.exp(-(r * r) / (2 * s * s))) /
				(Math.sqrt(2 * Math.PI) * s);
			den += g.w[k];
		}
		return Math.log(Math.max(1e-300, num / den));
	};
	const sigmas = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30];
	console.log(
		"\nσA marginal log-likelihood (DEV photos; x ~ N(fix, hAcc²), alt = DEM(x) + 1.6 + N(0, σA²))",
	);
	console.log(
		`${"σA".padStart(5)} ${"ΣlogL".padStart(8)}  per photo (logL)  [${grids.map((g) => g.photo.slice(4)).join(" ")}]`,
	);
	const table: { sigma: number; total: number; per: number[] }[] = [];
	for (const s of sigmas) {
		const per = grids.map((g) => ll(s, g));
		const total = per.reduce((a, b) => a + b, 0);
		table.push({ sigma: s, total, per });
		console.log(
			`${pad(s, 5)} ${pad(fmt(total, 2), 8)}  ${per.map((x) => fmt(x, 1)).join(" ")}`,
		);
	}
	const best = table.reduce((a, b) => (b.total > a.total ? b : a));
	// leave-one-photo-out σA (robustness)
	const loo = grids.map((_, i) => {
		const t = sigmas.map((s) => ({
			s,
			v: grids.reduce((a, g, j) => (j === i ? a : a + ll(s, g)), 0),
		}));
		return t.reduce((a, b) => (b.v > a.v ? b : a)).s;
	});
	console.log(
		`best σA = ${best.sigma} m (pool n=${grids.length}); leave-one-photo-out best: ${loo.join(", ")}`,
	);
	// joint (bias, σA): is there a systematic altitude offset? (reported, not used unless clear)
	let jb = { b: 0, s: best.sigma, v: -Infinity };
	const joint: { b: number; s: number; v: number }[] = [];
	for (let b = -12; b <= 6; b += 1)
		for (const s of sigmas) {
			const v = grids.reduce((a, g) => a + ll(s, g, b), 0);
			joint.push({ b, s, v });
			if (v > jb.v) jb = { b, s, v };
		}
	const at0 = grids.reduce((a, g) => a + ll(jb.s, g, 0), 0);
	console.log(
		`joint fit: bias ${jb.b} m, σA ${jb.s} m, ΣlogL ${fmt(jb.v, 2)} (vs ${fmt(best.total, 2)} at bias 0, σA ${best.sigma}; ${fmt(at0, 2)} at bias 0, σA ${jb.s}); LR = ${fmt(2 * (jb.v - best.total), 2)} for 1 extra parameter`,
	);
	// same-spot pair check: 7059 / 7063 (13 s apart; tools/nearfield/eyes: baseline < 1 m)
	const a = exif.find((e) => e.photo === "IMG_7059")?.alt;
	const b = exif.find((e) => e.photo === "IMG_7063")?.alt;
	if (a != null && b != null)
		console.log(
			`same-spot pair 7059/7063: Δalt = ${fmt(a - b, 2)} m → per-fix σ ≈ ${fmt(Math.abs(a - b) / Math.SQRT2, 1)} m`,
		);
	fs.writeFileSync(
		path.join(OUT, "sigma.json"),
		JSON.stringify({ table, best: best.sigma, loo }, null, 1),
	);
	return best.sigma;
}

// ------------------------------------------------------------------ skyline helpers

const skyMemo = new Map<string, Promise<SkylineSample[]>>();
/** detectSkyline on the 1600 px photo, every 2nd column with weight ≥ 0.3 (as scripts/concord/lib.ts). */
function skySamples(photo: string) {
	let p = skyMemo.get(photo);
	if (!p) {
		p = (async () => {
			const img = await loadRGBA(
				heicToJpeg(path.join(IMG_DIR, `${photo}.HEIC`), 1600),
			);
			const sky = detectSkyline(img);
			const out: SkylineSample[] = [];
			for (let x = 0; x < img.width; x += 2) {
				const y = sky.rows[x];
				if (!Number.isFinite(y) || sky.weight[x] < 0.3) continue;
				out.push({
					u: (x + 0.5) / img.width,
					v: y / img.height,
					w: sky.weight[x],
				});
			}
			return out;
		})();
		skyMemo.set(photo, p);
	}
	return p;
}

const h1600 = (aspect: number) => (aspect >= 1 ? 1600 / aspect : 1600);

// ------------------------------------------------------------------ focal

async function focal() {
	const split = loadSplit();
	const gt = loadGT();
	const exif = await allExif();
	const holdoutOk = process.env.CONCORD_HOLDOUT === "final";
	type Row = {
		photo: string;
		split: string;
		lens: string;
		f35: number;
		fExif: number;
		fGt: number;
		gtNote: string;
		fRotf: number | null;
		nPins: number;
		fSky: number | null;
		prior: number;
		sigma: number;
		entry: string;
	};
	const rows: Row[] = [];
	for (const photo of Object.keys(split).sort()) {
		const sp = split[photo];
		if (sp === "holdout" && !holdoutOk) continue;
		const g = gt[photo];
		const e = exif.find((x) => x.photo === photo);
		if (!e || !g.f || !e.f35) continue;
		const px = { width: g.width, height: g.height };
		const fExif = focalPxFromF35(e.f35, px);
		const note = g.notes ?? "";
		const gtNote = /f solved/i.test(note)
			? "solved"
			: /f fixed at 3085/i.test(note)
				? "fixed 3085 (mean)"
				: "fixed EXIF";
		// independent re-solve: rot+focal on ALL of the photo's pins at the GT eye (in-sample; ≥ 3 pins)
		const pins = await loadPins({
			photos: [photo],
			split: sp,
			sources: ["control-points"],
		});
		let fRotf: number | null = null;
		if (pins.length >= 3) {
			const base = gtCam(photo);
			const cam = await builtinFit("rotf")(photo, pins, base);
			fRotf = g.f * cam.intr.fScale;
		}
		// skyline profile over fScale (rotation refit at each, GT eye, Terrarium horizon as the audit)
		let fSky: number | null = null;
		{
			const s = await loadScene(photo);
			const samples = await skySamples(photo);
			const base = gtCam(photo);
			let best = { k: 1, cost: Infinity };
			const costs: [number, number][] = [];
			for (let k = 0.95; k <= 1.08 + 1e-9; k += 0.005) {
				const pose = { ...base.pose, vfov: vfovFromFocal(g.f * k, g.height) };
				const fit = fitRotationToHorizon(samples, s.horizon, pose, {
					aspect: s.aspect,
					imageHeight: h1600(s.aspect),
					rotationSigma: { yaw: 10, pitch: 10, roll: 10 },
				});
				costs.push([k, fit.cost]);
				if (fit.cost < best.cost) best = { k, cost: fit.cost };
			}
			// parabolic refinement around the best grid point
			const i = costs.findIndex((c) => c[0] === best.k);
			if (i > 0 && i < costs.length - 1) {
				const [a, b, c] = [costs[i - 1][1], costs[i][1], costs[i + 1][1]];
				const den = a - 2 * b + c;
				const off = den > 0 ? (0.5 * (a - c)) / den : 0;
				fSky = g.f * (best.k + off * 0.005);
			} else fSky = g.f * best.k; // at the scan edge: unreliable
		}
		const pr = focalPrior(e.lensModel, e.f35, px);
		rows.push({
			photo,
			split: sp,
			lens: `${e.focalMm}mm/${e.f35}`,
			f35: e.f35,
			fExif,
			fGt: g.f,
			gtNote,
			fRotf,
			nPins: pins.length,
			fSky,
			prior: pr.fPx,
			sigma: pr.sigmaPx,
			entry: pr.entry.evidence ?? "",
		});
	}
	const rel = (a: number, b: number) => (100 * (a - b)) / b;
	console.log(
		"\nFocal (px @4032 long side): EXIF (focalPxFromF35) vs GT f vs independent pin re-solve (rot+f, all pins, GT eye)",
	);
	console.log(
		"vs skyline profile (rot refit per focal, GT eye) vs LENS_TABLE prior. Δ = % vs GT f where GT f was SOLVED.",
	);
	console.log(
		`${"photo".padEnd(9)} ${"split".padEnd(7)} ${"lens".padEnd(9)} ${pad("EXIF", 7)} ${pad("GT f", 7)} ${"GT f source".padEnd(17)} ${pad("pins", 4)} ${pad("rot+f", 7)} ${pad("skyline", 7)} ${pad("prior", 7)} ${pad("±", 5)} ${pad("ΔEXIF%", 7)} ${pad("Δprior%", 7)}`,
	);
	for (const r of rows)
		console.log(
			`${r.photo.padEnd(9)} ${r.split.padEnd(7)} ${r.lens.padEnd(9)} ${pad(fmt(r.fExif), 7)} ${pad(fmt(r.fGt), 7)} ${r.gtNote.padEnd(17)} ${pad(r.nPins, 4)} ${pad(fmt(r.fRotf ?? Number.NaN), 7)} ${pad(fmt(r.fSky ?? Number.NaN), 7)} ${pad(fmt(r.prior), 7)} ${pad(fmt(r.sigma), 5)} ${pad(r.gtNote === "solved" ? fmt(rel(r.fExif, r.fGt), 2) : "-", 7)} ${pad(r.gtNote === "solved" ? fmt(rel(r.prior, r.fGt), 2) : "-", 7)}`,
		);
	for (const sp of ["dev", "holdout"]) {
		const s = rows.filter((r) => r.split === sp && r.gtNote === "solved");
		if (!s.length) continue;
		const eX = s.map((r) => Math.abs(rel(r.fExif, r.fGt)));
		const eP = s.map((r) => Math.abs(rel(r.prior, r.fGt)));
		console.log(
			`${sp}: |f − f_pinsolve| median  EXIF ${fmt(median(eX), 2)} %   table ${fmt(median(eP), 2)} %   (n=${s.length}${sp === "dev" ? ", IN-SAMPLE: the table was fitted on these" : ", scored once with the frozen table"})`,
		);
	}
	{
		// leave-one-photo-out on DEV: table mean refitted without the scored photo (main 26 mm only)
		const s = rows.filter(
			(r) => r.split === "dev" && r.gtNote === "solved" && r.f35 === 26,
		);
		const k = s.map((r) => r.fGt / r.fExif);
		const loo = s.map((r, i) => {
			const others = k.filter((_, j) => j !== i);
			const m = others.reduce((a, b) => a + b, 0) / others.length;
			return Math.abs(rel(r.fExif * m, r.fGt));
		});
		console.log(
			`dev leave-one-photo-out (main 26 mm, n=${s.length}): |f_table − f_pinsolve| median ${fmt(median(loo), 2)} % [${loo.map((x) => fmt(x, 2)).join(", ")}]`,
		);
	}
	if (!holdoutOk)
		console.log(
			"holdout photos skipped (set CONCORD_HOLDOUT=final for the single final score)",
		);
	console.log("LENS_TABLE:");
	for (const t of LENS_TABLE)
		console.log(
			`  ${t.match.source}${t.f35 ? ` f35=${t.f35}` : ""}: ×${t.fScale} ±${t.sigma}  (${t.evidence})`,
		);
	fs.writeFileSync(
		path.join(OUT, holdoutOk ? "focal-final.json" : "focal-dev.json"),
		JSON.stringify(rows, null, 1),
	);
	void lensEntry;
}

// ------------------------------------------------------------------ eye (dev)

const mhFull = new Map<string, TerrainSampler>();
/** Full-horizon Mapterhorn terrain around a fix: z17 within 300 m, then the app's MAPTERHORN levels. */
async function mhTerrain(photo: string, lat: number, lon: number) {
	let t = mhFull.get(photo);
	if (!t) {
		t = await loadTerrain(
			lat,
			lon,
			loadMH,
			[{ z: 17, maxDistance: 300 }, ...MAPTERHORN.levels],
			mhTiles,
			8,
			MAPTERHORN.tileSize,
		);
		mhFull.set(photo, t);
	}
	return t;
}

const HZ_CACHE = path.join(OUT, "cache");
function horizonAtEye(
	photo: string,
	t: TerrainSampler,
	lat: number,
	lon: number,
	eye: Vec3,
): HorizonProfile {
	const p = offsetLatLon(lat, lon, eye[0], eye[1]);
	const key = `${photo}_mh_${eye[0].toFixed(2)}_${eye[1].toFixed(2)}_${eye[2].toFixed(2)}`;
	const file = path.join(HZ_CACHE, `${key}.json`);
	if (fs.existsSync(file)) {
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		return {
			step: j.step,
			elevation: Float32Array.from(j.elevation),
			distance: Float32Array.from(j.distance),
			ridges: [],
		};
	}
	const h = computeHorizon(t, p.lat, p.lon, eye[2]);
	fs.mkdirSync(HZ_CACHE, { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			step: h.step,
			elevation: Array.from(h.elevation),
			distance: Array.from(h.distance),
		}),
	);
	return h;
}

type EyeVariant = { name: string; eye: Vec3 | null; note: string };

async function eyeStudy() {
	const split = loadSplit();
	const gt = loadGT();
	const exif = await allExif();
	const which = process.argv.includes("--holdout") ? "holdout" : "dev";
	if (which === "holdout" && process.env.CONCORD_HOLDOUT !== "final")
		throw new Error(
			"--holdout is the once-only final score: set CONCORD_HOLDOUT=final",
		);
	const dev = Object.keys(split)
		.filter((p) => split[p] === which)
		.sort();
	const allRes: Record<string, EvalResidual[]> = {};
	const perPhoto: Record<string, unknown>[] = [];
	const variantsCfg =
		which === "holdout"
			? { "concord (defaults)": {} }
			: ({
					"concord (defaults)": {},
					"concord σA=8": { sigmaA: 8, altBias: 0 },
					"concord σA=4": { sigmaA: 4, altBias: 0 },
					"concord σA=3 b=-7": { sigmaA: 3, altBias: -7 },
				} as const);
	for (const photo of dev) {
		const g = gt[photo];
		const e = exif.find((x) => x.photo === photo) as Exif;
		const sH = Math.min(100, Math.max(5, e.hAcc ?? 20));
		const { ground } = await nearMH(e.lat, e.lon, 2 * sH + 20);
		const g0 = ground(0, 0);
		const meta = { lat: e.lat, lon: e.lon, alt: e.alt, hAcc: e.hAcc };
		const variants: EyeVariant[] = [
			{
				name: "old rule (Mapterhorn)",
				eye: [0, 0, floorEye(e.alt, g0)],
				note: "baseline: max(alt, DEM+1.6) at the fix",
			},
			{
				name: "GT eye (Terrarium)",
				eye: [0, 0, g.eye],
				note: "ground-truth.json eye (old rule on the Terrarium DEM)",
			},
		];
		for (const [name, o] of Object.entries(variantsCfg)) {
			const c = concordEye(meta, ground, { eye: true, opts: o });
			variants.push({
				name,
				eye: c ? [c.dE, c.dN, c.alt] : null,
				note: c
					? `shift ${fmt(c.shiftM)} m, ${c.prior.reason}`
					: `fallback: ${eyePriorFromExif(meta, ground, o).reason}`,
			});
		}
		const t = await mhTerrain(photo, e.lat, e.lon);
		const samples = await skySamples(photo);
		const pins = await loadPins({ photos: [photo], split: which });
		const base = gtCam(photo);
		const s = await loadScene(photo);
		const row: Record<string, unknown> = {
			photo,
			alt: e.alt,
			hAcc: e.hAcc,
			g0,
			gtEye: g.eye,
			nPins: pins.length,
		};
		console.log(
			`\n${photo}  alt ${fmt(e.alt ?? Number.NaN)}  hAcc ${fmt(e.hAcc ?? Number.NaN, 0)}  DEM(fix) ${fmt(g0)}  pins ${pins.length}`,
		);
		for (const v of variants) {
			const eye = v.eye ?? variants[0].eye; // fallback ⇒ old rule
			if (!eye) continue;
			const hz = horizonAtEye(photo, t, e.lat, e.lon, eye);
			const fit = fitRotationToHorizon(samples, hz, base.pose, {
				aspect: s.aspect,
				imageHeight: h1600(s.aspect),
				rotationSigma: { yaw: 10, pitch: 10, roll: 10 },
			});
			const r = fit.residualsPx.filter(Number.isFinite);
			const inl = r.filter((x) => Math.abs(x) < 30);
			const rms30 = Math.sqrt(
				inl.reduce((a, x) => a + x * x, 0) / Math.max(1, inl.length),
			);
			const cam: CameraX = {
				pose: fit.pose,
				// scene frame of the eval lib: ENU at the GT fix, z relative to the GT eye
				eye: [eye[0], eye[1], eye[2] - s.eyeAlt],
				aspect: s.aspect,
				intr: { ...IDENTITY_INTRINSICS },
			};
			// band by the pin's distance from the GT eye, so every eye rule is scored on the same bands
			const res = scorePins(cam, pins).map((x, k) => ({
				...x,
				band: distanceBand(pins[k].distM),
			}));
			if (!allRes[v.name]) allRes[v.name] = [];
			allRes[v.name].push(...res);
			// candidate file for scripts/concord/eval.ts --candidate (WP-A format {cam})
			const slug = v.name.replace(/[^\w=.-]+/g, "_").replace(/_+$/, "");
			const cdir = path.join(
				OUT,
				which === "dev" ? "cand" : "cand-holdout",
				slug,
			);
			fs.mkdirSync(cdir, { recursive: true });
			fs.writeFileSync(
				path.join(cdir, `${photo}.json`),
				JSON.stringify({ cam, note: v.note }),
			);
			const px = res.map((x) => x.px);
			row[v.name] = {
				eye,
				fallback: v.eye === null,
				note: v.note,
				skyRms30: rms30,
				skyMedAbs: fit.medianAbsPx,
				skyInl: fit.inlierFrac,
				pose: fit.pose,
				pins: res.map((x) => ({
					id: x.id,
					band: x.band,
					px: x.px,
					distM: x.distM,
				})),
			};
			console.log(
				`  ${v.name.padEnd(22)} eye [${eye.map((x) => fmt(x, 1)).join(", ")}]${v.eye ? "" : " (fallback=old)"}  sky rms30 ${fmt(rms30, 2)} med ${fmt(fit.medianAbsPx, 2)} inl ${fmt(fit.inlierFrac, 2)}  pins med ${fmt(median(px), 2)} [${res.map((x) => `${x.band}:${fmt(x.px, 1)}`).join(" ")}]  ${v.note}`,
			);
		}
		perPhoto.push(row);
	}
	console.log(
		`\n${which.toUpperCase()} pins by distance band (px @1600; median / p90 (n)), rotation refit to the skyline at each eye:`,
	);
	const bands = ["<0.5km", "0.5-2km", "2-5km", "5-15km", ">15km"] as const;
	console.log(
		`${"eye rule".padEnd(22)} ${bands.map((b) => pad(b, 17)).join("")} ${pad("all", 17)}`,
	);
	const summary: Record<string, unknown> = {};
	for (const [name, res] of Object.entries(allRes)) {
		const bt = bandTable(res);
		summary[name] = bt;
		console.log(
			`${name.padEnd(22)} ${bands.map((b) => pad(`${fmt(bt.byBand[b].medPx, 2)}/${fmt(bt.byBand[b].p90Px, 1)} (${bt.byBand[b].n})`, 17)).join("")} ${pad(`${fmt(bt.all.medPx, 2)}/${fmt(bt.all.p90Px, 1)} (${bt.all.n})`, 17)}`,
		);
	}
	fs.writeFileSync(
		path.join(OUT, `eye-${which}.json`),
		JSON.stringify({ perPhoto, summary }, null, 1),
	);
	void skylineRms;
	void isoBandSeeds;
	void EYE_PRIOR_DEFAULTS;
	void median;
}

// ------------------------------------------------------------------ main

const cmd = process.argv[2] ?? "all";
if (cmd === "consistency" || cmd === "all") await consistency();
if (cmd === "sigma" || cmd === "all") await fitSigma();
if (cmd === "focal" || cmd === "all") await focal();
if (cmd === "eye" || cmd === "all") await eyeStudy();
