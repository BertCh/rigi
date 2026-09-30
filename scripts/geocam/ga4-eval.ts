/**
 * GA4 evaluation (reports/geometry-first-pose.md G4 / §5 GA4): lakes as known horizontal planes.
 * Rule frozen in tools/research/geo/PROTOCOL.txt, SECTION GA4 (written before any number here).
 *
 *   npx tsx scripts/geocam/ga4-eval.ts [--skip-recovery] [--skip-coverage] [--configs W,S,WG] [IMG_xxxx ...]
 *
 * Recovery (DEV GT only; holdout refused by lib.assertDevGT): start at the GT rotation + focal with the
 * eye displaced vertically by dz ∈ {±5, ±10, ±20} m; solveMap with
 *   W   gps + focal prior + skyline + waterline (level + shore, lakes/factors.ts)   PRIMARY
 *   S   W without waterline (control)
 *   WG  W + ground (standing-height) prior (product-like, secondary)
 * and score |U − U_GT|. Coverage (wild dev, 50 ids): usable lake = ≥ 8 water cues at the first verified
 * correct ref camera. Outputs: out/geocam/ga4/{recovery.json, coverage.json, summary.json}; Overpass
 * water for the wild photos cached in out/geocam/ga4/osm/<pid>.json.
 */
import fs from "node:fs";
import path from "node:path";
import {
	buildGeomBuffer,
	type Lake,
	lakeLevel,
	type PhotoEdges,
	photoEdgesFromRGBA,
	waterCuesX,
} from "../../src/lib/concord/cues";
import { focalPx1600 } from "../../src/lib/concord/solve/joint";
import {
	type CameraX,
	type Factor,
	IDX,
	stateFromCameraX,
} from "../../src/lib/geocam/core";
import {
	compactLakes,
	toSceneLakes,
	type WaterElement,
} from "../../src/lib/geocam/lakes/compact";
import { waterlineFactors } from "../../src/lib/geocam/lakes/factors";
import { lakeLevelOf } from "../../src/lib/geocam/lakes/levels";
import {
	focalFactor,
	gpsFactor,
	groundFactor,
	skylineFactor,
	solveMap,
} from "../../src/lib/geocam/map";
import { destination } from "../../src/lib/geodesy";
import { OVERPASS } from "../../src/lib/overpass";
import { heicToJpeg, IMG_DIR, loadRGBA, ROOT } from "../lib/node-io";
import {
	devGTPhotos,
	enuOf,
	GEO_OUT,
	heightFnOf,
	median,
	photoSetup,
	R_EFF,
	type Scene,
	terrainFor,
	wildDev,
	wildDevIds,
	writeJson,
} from "./lib";

const DEG = Math.PI / 180;
const OUT = path.join(GEO_OUT, "ga4");
const PRIMARY = ["IMG_6971", "IMG_7018", "IMG_7033", "IMG_7053"];
const DZ = [-20, -10, -5, 5, 10, 20];
const WATER_OPTS = { searchPx: 30, mirrorHalfPx: 0 };
const MIN_USABLE = 8;

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
	const i = args.indexOf(k);
	if (i < 0) return d;
	const v = args[i + 1];
	args.splice(i, 2);
	return v;
};
const flag = (k: string) => {
	const i = args.indexOf(k);
	if (i < 0) return false;
	args.splice(i, 1);
	return true;
};
const skipRecovery = flag("--skip-recovery");
const skipCoverage = flag("--skip-coverage");
const configs = opt("--configs", "W,S,WG").split(",");
const only = args.filter((a) => a.startsWith("IMG_"));
if (args.includes("--summary-only") && !skipRecovery && only.length)
	throw new Error("--summary-only takes no photos");

// ---------------------------------------------------------------- lakes

type OsmWater = { elements: WaterElement[] };
let cachedWater: WaterElement[] | undefined;
/** Every cached Overpass water element (concord pins cache), deduped. */
function concordWater(): WaterElement[] {
	if (cachedWater) return cachedWater;
	const dir = path.join(ROOT, "out", "concord", "pins", "osm");
	const seen = new Set<string>();
	cachedWater = [];
	for (const f of fs.readdirSync(dir).filter((f) => f.endsWith("_water.json")))
		for (const e of (
			JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as OsmWater
		).elements) {
			const k = `${e.type}/${e.id}`;
			if (seen.has(k)) continue;
			seen.add(k);
			cachedWater.push(e);
		}
	return cachedWater;
}

/** Scene lakes (≥ 5 ha, within 40 km) with lakeLevelOf levels (OSM ele → table → DEM median). */
function sceneLakes(
	s: Pick<Scene, "lat" | "lon" | "eyeAlt">,
	els: WaterElement[],
	absHeight: (e: number, n: number) => number,
): (Lake & { levelSource?: string })[] {
	const toEN = (lat: number, lon: number): [number, number] => {
		const v = enuOf(s as Scene, lat, lon, 0);
		return [v[0], v[1]];
	};
	const geo = compactLakes(els, { minAreaM2: 50_000 });
	const sc = toSceneLakes(geo, toEN);
	const out: (Lake & { levelSource?: string })[] = [];
	sc.forEach((l, i) => {
		if (!l.polygon.some(([e, n]) => Math.hypot(e, n) < 40_000)) return;
		const lv = lakeLevelOf(
			geo[i],
			() =>
				lakeLevel(l, absHeight, { region: (e, n) => Math.hypot(e, n) < 30_000 })
					.levelM,
		);
		if (!lv) return;
		out.push({ ...l, levelM: lv.levelM, levelSource: lv.source });
	});
	return out;
}

const absHeightOf =
	(
		s: Pick<Scene, "lat" | "lon">,
		t: { sampleAt(lon: number, lat: number, d: number): number },
	) =>
	(e: number, n: number) => {
		const dO = Math.hypot(e, n);
		const p = destination(s.lat, s.lon, Math.atan2(e, n) / DEG, dO);
		return t.sampleAt(p.lon, p.lat, dO);
	};

async function edgesOf(jpg: string, aspect: number): Promise<PhotoEdges> {
	const ew = aspect >= 1 ? 1600 : Math.round(1600 * aspect);
	const rgba = await loadRGBA(jpg, ew);
	return photoEdgesFromRGBA(rgba.data, rgba.width, rgba.height);
}

function waterSource(
	heightFn: (e: number, n: number, d: number) => number,
	frame: { alt0: number; rEff: number },
	lakes: Lake[],
	edges: PhotoEdges,
	o: Record<string, unknown> = {},
) {
	return (cam: CameraX) => {
		const gw = cam.aspect >= 1 ? 800 : Math.round(800 * cam.aspect);
		const gh = Math.round(gw / cam.aspect);
		const g = buildGeomBuffer(cam, gw, gh, heightFn, { frame });
		return waterCuesX(g, cam, lakes, null, { edges, ...o });
	};
}

// ---------------------------------------------------------------- recovery

type Run = {
	photo: string;
	config: string;
	dz: number;
	U: number;
	E: number;
	N: number;
	dPitch: number;
	errZ: number;
	sigmaU: number;
	nLevel: number;
	nShore: number;
	biasLevelPx: number;
	biasShorePx: number;
	converged: boolean;
	outer: number;
	ms: number;
};

async function recovery() {
	const photos = devGTPhotos(only);
	const runs: Run[] = [];
	const perPhoto: Record<string, unknown> = {};
	for (const photo of photos) {
		const t0 = Date.now();
		const S = await photoSetup(photo, { start: "gt" });
		const frame = { alt0: S.s.eyeAlt, rEff: R_EFF };
		const lakes = sceneLakes(S.s, concordWater(), absHeightOf(S.s, S.t));
		const jpg = heicToJpeg(path.join(IMG_DIR, `${photo}.HEIC`), 1600);
		const edges = await edgesOf(jpg, S.gt.aspect);
		const srcX = waterSource(S.heightFn, frame, lakes, edges, WATER_OPTS);
		const src = (cam: CameraX) => srcX(cam).cues;
		const atGT = srcX(S.gt);
		const nAtGT = atGT.cues.length;
		const isPrimary = PRIMARY.includes(photo);
		const groundZ = S.ground(0, 0);
		perPhoto[photo] = {
			primary: isPrimary,
			lakes: lakes.map((l) => ({
				name: l.name,
				levelM: l.levelM,
				src: l.levelSource,
			})),
			cuesAtGT: {
				level: atGT.cues.filter((c) => c.kind === "level").length,
				shore: atGT.cues.filter((c) => c.kind === "shore").length,
				predicted: atGT.predicted.length,
				polarity: atGT.polarity,
			},
			gtEyeAboveDemM: -groundZ,
			sigmaH: S.eyePrior.sigmaH,
		};
		console.log(
			`${photo}: lakes ${lakes.length} (${lakes.map((l) => `${l.name ?? "?"}@${l.levelM.toFixed(1)}/${l.levelSource}`).join(", ")}); cues at GT ${nAtGT} (pred ${atGT.predicted.length}); GT eye ${(-groundZ).toFixed(1)} m above DEM`,
		);
		if (!isPrimary && nAtGT < MIN_USABLE) {
			console.log(
				`  not a lake photo by the rule (< ${MIN_USABLE} cues): skipped`,
			);
			continue;
		}
		const base = S.gt;
		const f0 = focalPx1600(base);
		const sky = skylineFactor(base, S.skyline, S.horizonsAtEyes);
		const common: Factor[] = [
			gpsFactor(0, 0, S.eyePrior.sigmaH),
			focalFactor(f0, S.focal.fPx, S.focal.sigmaPx),
			sky,
		];
		for (const config of configs) {
			const water =
				config === "S" ? [] : waterlineFactors(src, base, { frame });
			const factors = [
				...common,
				...water,
				...(config === "WG" ? [groundFactor(S.ground)] : []),
			];
			const p = {
				base,
				f0Px1600: f0,
				factors,
				free: { rotation: true as const, focal: true, eye: true },
			};
			for (const dz of [0, ...DZ]) {
				const x0 = stateFromCameraX(base);
				x0[IDX.U] = dz;
				const r = await solveMap(p, x0, { maxOuter: 8 });
				const lv = water.find((f) => f.family === "level");
				const sh = water.find((f) => f.family === "shore");
				const bias = (f?: Factor) => {
					if (!f) return Number.NaN;
					const z = f.residual(r.x);
					return z[z.length - 1] * 3;
				};
				const run: Run = {
					photo,
					config,
					dz,
					U: r.x[IDX.U],
					E: r.x[IDX.E],
					N: r.x[IDX.N],
					dPitch: r.x[IDX.pitch] - base.pose.pitch,
					errZ: Math.abs(r.x[IDX.U]),
					sigmaU: r.sigma.U,
					nLevel: lv ? lv.dim - 1 : 0,
					nShore: sh ? sh.dim - 1 : 0,
					biasLevelPx: bias(lv),
					biasShorePx: bias(sh),
					converged: r.converged,
					outer: r.outer,
					ms: r.ms,
				};
				runs.push(run);
				console.log(
					`  ${config} dz ${String(dz).padStart(3)} → U ${run.U.toFixed(2)} (σ ${run.sigmaU.toFixed(2)}) EN ${run.E.toFixed(1)},${run.N.toFixed(1)} dPitch ${run.dPitch.toFixed(3)} level ${run.nLevel} shore ${run.nShore} b̂ ${run.biasLevelPx.toFixed(2)}/${run.biasShorePx.toFixed(2)} ${run.converged ? "" : "(not converged)"} ${run.ms} ms`,
				);
			}
		}
		console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
		writeJson(
			path.join(OUT, "recovery", `${photo}_${configs.join("+")}.json`),
			{
				perPhoto: { [photo]: perPhoto[photo] },
				runs: runs.filter((r) => r.photo === photo),
			},
		);
	}
	return { perPhoto, runs };
}

/** Every recovery run on disk (per photo × config-set files, plus a legacy recovery.json), deduped. */
function loadRuns(): { perPhoto: Record<string, unknown>; runs: Run[] } {
	const files: string[] = [];
	const dir = path.join(OUT, "recovery");
	if (fs.existsSync(dir))
		for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json")))
			files.push(path.join(dir, f));
	if (fs.existsSync(path.join(OUT, "recovery.json")))
		files.push(path.join(OUT, "recovery.json"));
	const perPhoto: Record<string, unknown> = {};
	const seen = new Map<string, Run>();
	for (const f of files) {
		const j = JSON.parse(fs.readFileSync(f, "utf8")) as {
			perPhoto: Record<string, unknown>;
			runs: Run[];
		};
		Object.assign(perPhoto, j.perPhoto);
		for (const r of j.runs) {
			const k = `${r.photo}|${r.config}|${r.dz}`;
			if (!seen.has(k)) seen.set(k, r);
		}
	}
	return { perPhoto, runs: [...seen.values()] };
}

// ---------------------------------------------------------------- coverage

const OSM_DIR = path.join(OUT, "osm");
async function wildWater(
	pid: string,
	lat: number,
	lon: number,
): Promise<WaterElement[]> {
	const f = path.join(OSM_DIR, `${pid}.json`);
	if (fs.existsSync(f))
		return (JSON.parse(fs.readFileSync(f, "utf8")) as OsmWater).elements;
	// region.ts regionQueries().water for the snapped cell (TRAIL_RADIUS_KM 12 + 3, REGION_SNAP_DEG 0.05)
	const s = (v: number) => Number((Math.round(v / 0.05) * 0.05).toFixed(4));
	const [clat, clon] = [s(lat), s(lon)];
	const km = 15;
	const dLat = km / 111.32;
	const dLon = km / (111.32 * Math.cos((clat * Math.PI) / 180));
	const tr = [clat - dLat, clon - dLon, clat + dLat, clon + dLon]
		.map((v) => v.toFixed(5))
		.join(",");
	const q = `[out:json][timeout:120];(way["natural"="water"]["name"](${tr});relation["natural"="water"]["name"](${tr}););out geom;`;
	let r: { elements: unknown[] } | null = null;
	let last: unknown = null;
	for (let attempt = 0; attempt < 5 && !r; attempt++) {
		try {
			// src/lib/overpass.ts sends no User-Agent from node, which overpass-api.de now answers with 406
			const url = attempt % 2 === 0 ? OVERPASS.main : OVERPASS.mailru;
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"User-Agent":
						"rigi-geo-research/1.0 (GA4 lake coverage; offline eval)",
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: `data=${encodeURIComponent(q)}`,
				signal: AbortSignal.timeout(150_000),
			});
			if (!res.ok) throw new Error(`overpass ${url}: HTTP ${res.status}`);
			r = (await res.json()) as { elements: unknown[] };
		} catch (e) {
			last = e;
			console.log(`  overpass attempt ${attempt + 1} failed: ${e}`);
			await new Promise((res) => setTimeout(res, 30_000 * (attempt + 1)));
		}
	}
	if (!r) throw new Error(`overpass unavailable: ${last}`);
	fs.mkdirSync(OSM_DIR, { recursive: true });
	fs.writeFileSync(f, JSON.stringify({ query: q, elements: r.elements }));
	await new Promise((res) => setTimeout(res, 1500));
	return r.elements as WaterElement[];
}

async function coverage() {
	const ids = wildDevIds();
	const rows: Record<string, unknown>[] = [];
	for (const pid of ids) {
		const w = wildDev(pid);
		const ref = w?.meta.correct_refs?.[0];
		if (!w || !ref) {
			rows.push({ pid, hasRef: false, usable: false });
			console.log(`${pid}: no correct ref`);
			continue;
		}
		try {
			const eyeAlt = ref.renderEye?.[2] ?? w.meta.eye[2];
			const s = {
				photo: `wild_${pid}`,
				lat: w.meta.lat,
				lon: w.meta.lon,
				eyeAlt,
			} as Scene;
			const t = await terrainFor(s, "mh");
			const heightFn = heightFnOf(s, t);
			const els = await wildWater(pid, w.meta.lat, w.meta.lon);
			const lakes = sceneLakes(s, els, absHeightOf(s, t));
			const cam: CameraX = {
				pose: { ...ref.pose },
				eye: [0, 0, 0],
				aspect: w.meta.aspect,
				intr: { fScale: 1, k1: 0, cx: 0, cy: 0 },
			};
			let nCues = 0;
			let nPred = 0;
			let nLevel = 0;
			if (lakes.length) {
				const edges = await edgesOf(w.photoJpg, cam.aspect);
				const r = waterSource(
					heightFn,
					{ alt0: eyeAlt, rEff: R_EFF },
					lakes,
					edges,
				)(cam);
				nCues = r.cues.length;
				nLevel = r.cues.filter((c) => c.kind === "level").length;
				nPred = r.predicted.length;
			}
			const usable = nCues >= MIN_USABLE;
			rows.push({
				pid,
				hasRef: true,
				lakes: lakes.length,
				lakeNames: lakes.slice(0, 6).map((l) => l.name),
				nCues,
				nLevel,
				nPred,
				usable,
				usablePred: nPred >= MIN_USABLE,
			});
			console.log(
				`${pid}: lakes ${lakes.length}, predicted ${nPred}, cues ${nCues} (level ${nLevel}) ${usable ? "USABLE" : ""}`,
			);
		} catch (e) {
			rows.push({
				pid,
				hasRef: true,
				usable: false,
				error: String(e),
				fetchError: String(e).includes("overpass"),
			});
			console.log(`${pid}: ERROR ${e}`);
		}
		writeJson(path.join(OUT, "coverage.json"), { rows });
	}
	writeJson(path.join(OUT, "coverage.json"), { rows });
	return rows;
}

// ---------------------------------------------------------------- summary

let seed = 4242;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
/** Bootstrap by photo: resample photos, median of their pooled runs; 95 % percentile CI. */
function bootMedian(byPhoto: number[][], B = 2000): [number, number] {
	const meds: number[] = [];
	for (let b = 0; b < B; b++) {
		const pool: number[] = [];
		for (let k = 0; k < byPhoto.length; k++)
			pool.push(...byPhoto[Math.floor(rnd() * byPhoto.length)]);
		meds.push(median(pool));
	}
	meds.sort((a, b) => a - b);
	return [meds[Math.floor(0.025 * B)], meds[Math.floor(0.975 * B)]];
}

/** Wilson 95 % interval for k/n. */
function wilson(k: number, n: number): [number, number] {
	if (!n) return [0, 1];
	const z = 1.96;
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [(c - h) / d, (c + h) / d];
}

async function main() {
	const summary: Record<string, unknown> = {
		protocol: "tools/research/geo/PROTOCOL.txt SECTION GA4",
	};
	if (!skipRecovery) {
		if (!args.includes("--summary-only")) await recovery();
		const { runs } = loadRuns();
		const table: Record<string, unknown> = {};
		for (const config of configs) {
			const prim = runs.filter(
				(r) => r.config === config && r.dz !== 0 && PRIMARY.includes(r.photo),
			);
			const byPhoto = PRIMARY.map((p) =>
				prim.filter((r) => r.photo === p).map((r) => r.errZ),
			).filter((a) => a.length);
			const all = prim.map((r) => r.errZ);
			const conv = runs
				.filter((r) => r.config === config && r.dz !== 0)
				.map((r) => {
					const ref = runs.find(
						(q) => q.config === config && q.photo === r.photo && q.dz === 0,
					);
					return ref ? Math.abs(r.U - ref.U) : Number.NaN;
				});
			table[config] = {
				n: all.length,
				medianErrZ: median(all),
				ci95: byPhoto.length ? bootMedian(byPhoto) : null,
				perPhotoMedian: Object.fromEntries(
					PRIMARY.map((p) => [
						p,
						median(prim.filter((r) => r.photo === p).map((r) => r.errZ)),
					]),
				),
				byDz: Object.fromEntries(
					DZ.map((d) => [
						d,
						median(prim.filter((r) => r.dz === d).map((r) => r.errZ)),
					]),
				),
				dz0: Object.fromEntries(
					PRIMARY.map((p) => [
						p,
						runs.find((r) => r.config === config && r.photo === p && r.dz === 0)
							?.U,
					]),
				),
				medianConvergenceToDz0: median(conv.filter(Number.isFinite)),
				secondary: [
					...new Set(
						runs.filter((r) => !PRIMARY.includes(r.photo)).map((r) => r.photo),
					),
				],
			};
		}
		summary.recovery = table;
		console.log(JSON.stringify(table, null, 1));
	}
	if (!skipCoverage) {
		const rows = await coverage();
		const n = rows.length;
		const k = rows.filter((r) => r.usable).length;
		const withRef = rows.filter((r) => r.hasRef).length;
		const kPred = rows.filter((r) => r.usablePred).length;
		summary.coverage = {
			n,
			usable: k,
			frac: k / n,
			wilson95: wilson(k, n),
			withRef,
			fracOfWithRef: withRef ? k / withRef : null,
			usablePredOnly: kPred,
			usableIds: rows.filter((r) => r.usable).map((r) => r.pid),
		};
		console.log(JSON.stringify(summary.coverage, null, 1));
	}
	const prev = fs.existsSync(path.join(OUT, "summary.json"))
		? JSON.parse(fs.readFileSync(path.join(OUT, "summary.json"), "utf8"))
		: {};
	writeJson(path.join(OUT, "summary.json"), { ...prev, ...summary });
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
