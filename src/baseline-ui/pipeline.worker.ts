/// <reference lib="webworker" />
/**
 * Baseline pipeline worker: DEM tiles → horizon → peaks, plus skyline
 * detection and pose solving.
 */
import { fetchDemTile, TERRARIUM_AWS, tileId, tilesAround } from "#/lib/dem";
import type { HorizonProfile } from "#/lib/geo/horizon";
import {
	overpassPeaksQuery,
	parseOverpassPeaks,
	viewPeaks,
} from "#/lib/geo/peaks";
import { cascade, loadScene, sceneHorizon } from "#/lib/geo/pipeline";
import { detectSkyline } from "#/lib/geo/skyline";
import { OVERPASS, overpassMemo } from "#/lib/overpass";
import type {
	AlignResult,
	FromWorker,
	SkylineObservation,
	Stage,
	ToWorker,
} from "./types";

const DEM = TERRARIUM_AWS;
const PEAK_RADIUS_M = 50_000;
const MAX_CACHED_TILES = 1500;
/** Public instances rate-limit (429) and time out (504): try mirrors in turn. */
const OVERPASS_ENDPOINTS = [OVERPASS.main, OVERPASS.coffee, OVERPASS.mailru];

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (msg: FromWorker, transfer: Transferable[] = []) =>
	ctx.postMessage(msg, transfer);

const tileCache = new Map<string, Float32Array>();

/** State of the latest run (align needs the full horizon). */
let current: { id: number; horizon?: HorizonProfile } = { id: -1 };
/** Skyline of the current photo (independent of the location run). */
let sky: SkylineObservation | undefined;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const stale = (id: number) => id !== current.id;

/** Last completed run, replayed when the same location is requested again. */
let last: {
	key: string;
	horizon: HorizonProfile;
	lite: FromWorker & { type: "horizon" };
	peaks?: FromWorker & { type: "peaks" };
} | null = null;

function cloneLite(m: FromWorker & { type: "horizon" }, id: number) {
	const h = m.horizon;
	const horizon = {
		step: h.step,
		elevation: h.elevation.slice(),
		distance: h.distance.slice(),
		ridgeAz: h.ridgeAz.slice(),
		ridgeEl: h.ridgeEl.slice(),
		ridgeDist: h.ridgeDist.slice(),
	};
	const transfer = [
		horizon.elevation.buffer,
		horizon.distance.buffer,
		horizon.ridgeAz.buffer,
		horizon.ridgeEl.buffer,
		horizon.ridgeDist.buffer,
	];
	return { msg: { ...m, id, horizon }, transfer };
}

async function run(id: number, lat: number, lon: number, altitude?: number) {
	current = { id };
	const key = `${lat.toFixed(6)},${lon.toFixed(6)},${altitude ?? ""}`;
	if (last?.key === key && last.peaks) {
		current.horizon = last.horizon;
		const { msg, transfer } = cloneLite(last.lite, id);
		post(msg, transfer);
		post({ ...last.peaks, id });
		return;
	}
	const progress = (
		stage: Stage,
		message: string,
		done?: number,
		total?: number,
	) => post({ type: "progress", id, stage, message, done, total });

	if (tileCache.size > MAX_CACHED_TILES) tileCache.clear();
	const total = DEM.levels
		.flatMap((l) => tilesAround(lat, lon, l.maxDistance, l.z))
		.filter((k) => !tileCache.has(tileId(k))).length;
	let done = 0;
	let failed = 0;
	progress("tiles", `Loading DEM tiles 0/${total}`, 0, total);
	const { terrain, ground, eye } = await loadScene(
		lat,
		lon,
		altitude,
		DEM,
		async (k) => {
			let t: Float32Array | undefined;
			try {
				t = await fetchDemTile(DEM, k);
			} catch {
				t = undefined;
			}
			if (!t) failed++;
			done++;
			if (!stale(id))
				progress(
					"tiles",
					`Loading DEM tiles ${done}/${total}${failed ? ` (${failed} failed)` : ""}`,
					done,
					total,
				);
			return t;
		},
		tileCache,
	);
	if (stale(id)) return;

	progress("horizon", "Computing horizon (7200 azimuths)…");
	const t0 = performance.now();
	const horizon = await sceneHorizon(terrain, lat, lon, eye);
	const ms = performance.now() - t0;
	if (stale(id)) return;
	current.horizon = horizon;

	const ridgeAz: number[] = [];
	const ridgeEl: number[] = [];
	const ridgeDist: number[] = [];
	horizon.ridges.forEach((rs, i) => {
		for (const r of rs) {
			ridgeAz.push(i * horizon.step);
			ridgeEl.push(r.elevation);
			ridgeDist.push(r.distance);
		}
	});
	const lite = {
		step: horizon.step,
		elevation: horizon.elevation.slice(),
		distance: horizon.distance.slice(),
		ridgeAz: Float32Array.from(ridgeAz),
		ridgeEl: Float32Array.from(ridgeEl),
		ridgeDist: Float32Array.from(ridgeDist),
	};
	const liteMsg = {
		type: "horizon" as const,
		id,
		horizon: lite,
		eye,
		ground,
		ms,
	};
	last = { key, horizon, lite: liteMsg };
	const { msg, transfer } = cloneLite(liteMsg, id);
	post(msg, transfer);

	progress("peaks", "Fetching peaks from OpenStreetMap…");
	try {
		const json = await overpassMemo(
			overpassPeaksQuery(lat, lon, PEAK_RADIUS_M),
			{ endpoints: OVERPASS_ENDPOINTS },
		);
		const views = viewPeaks(parseOverpassPeaks(json), terrain, lat, lon, eye);
		const peaksMsg = { type: "peaks" as const, id, views };
		if (last?.key === key) last.peaks = peaksMsg;
		if (stale(id)) return;
		post(peaksMsg);
	} catch (e) {
		post({ type: "error", id, stage: "peaks", message: errMsg(e) });
	}
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
	const msg = ev.data;
	try {
		if (msg.type === "run") {
			await run(msg.id, msg.lat, msg.lon, msg.altitude);
		} else if (msg.type === "skyline") {
			sky = undefined;
			const obs = detectSkyline(msg.image);
			sky = obs;
			post({ type: "skyline", id: msg.id, sky: obs });
		} else if (msg.type === "align") {
			if (!current.horizon) throw new Error("Horizon not computed yet");
			if (!sky) throw new Error("Photo skyline not detected yet");
			// Cascade (scored best in scripts/eval.ts: 11/12 accepted, 0 false
			// accepts) with default options: rejects escalate to refinePose.
			const r = cascade(msg.prior, current.horizon, sky);
			const result: AlignResult = {
				camera: r.camera,
				confidence: r.confidence,
				residualPx: r.residualPx,
				accepted: r.accepted,
				rejectReason: r.rejectReason,
				method: r.stage,
			};
			post({ type: "align", id: msg.id, result });
		}
	} catch (e) {
		const stage: Stage = msg.type === "run" ? "tiles" : msg.type;
		post({ type: "error", id: msg.id, stage, message: errMsg(e) });
	}
};
