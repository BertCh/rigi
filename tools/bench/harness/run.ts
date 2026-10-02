// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * In-the-wild benchmark harness: runs three aligners on ad-hoc photos (JPEG + lat/lon, optional
 * altitude / heading / focal, never a gravity vector unless the manifest carries pitchDeg/rollDeg).
 *
 *   tools/bench/harness/run.sh <manifest.json> [--methods app,cascade,fused] [--ids a,b]
 *       [--conditions given|full,nogravity,noheading,none] [--out DIR] [--matcher-url URL]
 *       [--no-overlay] [--overlay-methods app,cascade,fused] [--force] [--weak-heading] [--fused-seeds]
 *
 * Manifest (array, or {photos: [...]}) entries:
 *   {id, file, lat, lon, altitudeM?, headingDeg?, focalMm?, focal35mm?, width, height, tags}
 *   harness extensions (all optional): pitchDeg, rollDeg (gravity), vfovDeg / hfovDeg, gpsErrorM,
 *   regionFile (app region JSON for peaks), gt / gtPin ({yaw,pitch,roll,vfov} for scoring).
 *   `file` is resolved relative to the manifest's directory.
 *
 * Conditions: given = whatever the manifest has; full = heading + gravity (as given);
 *   nogravity = pitch/roll removed (prior 0); noheading = heading removed (360° search);
 *   none = both removed. Unknown focal → 50° hfov + free focal.
 *
 * Methods (native support per method: reports/bench-ablation.md):
 *   app            engine.autoAlign(true) in the headless app (ad-hoc photo injected with Playwright
 *                  request interception), harness wrapper over yaw seeds (every 40°, full terrain)
 *                  × pitch seeds (−8/0/+8°) × focal seeds (hfov 40/50/65°) for the unknowns, best by
 *                  the app's own score; the single native run is kept as `native`.
 *   cascade        0f's cascade (solvePose → refinePose) with unknowns declared via their options
 *   cascade-native the same with default options and unknowns = 0 (what it does un-told)
 *   fused          tools/matcher/server POST /match ad-hoc mode (two-stage when anything is unknown)
 *
 * Output (default tools/bench/harness/out/runs/<manifest name>/):
 *   photos/<id>.jpg (only when the input needed re-encoding), results/<id>/<cond>.<method>.json,
 *   overlays/<id>__<cond>__<method>.jpg, results.json (all rows), summary.md.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	type Pose,
	vfovFromFocal,
	vfovFromHfov,
} from "../../../src/lib/camera";
import { type CascadeJob, runCascade } from "./cascade";
import { HARNESS, peaksAt, prefetchPeaksBBox, ROOT } from "./lib/geo";
import { Worker } from "./lib/worker.mjs";
import { renderOverlay } from "./overlay";

interface Entry {
	id: string;
	file: string;
	lat: number;
	lon: number;
	altitudeM?: number | null;
	headingDeg?: number | null;
	focalMm?: number | null;
	focal35mm?: number | null;
	width?: number;
	height?: number;
	tags?: string[];
	pitchDeg?: number | null;
	rollDeg?: number | null;
	vfovDeg?: number | null;
	hfovDeg?: number | null;
	gpsErrorM?: number | null;
	regionFile?: string | null;
	gt?: Pose | null;
	gtPin?: Pose | null;
}

interface CondPrior {
	yaw: number | null;
	pitch: number | null;
	roll: number | null;
	vfov: number;
	yawKnown: boolean;
	gravKnown: boolean;
	focalKnown: boolean;
	focalSource: string;
	/** --weak-heading: the manifest heading, used only as a seed / weak prior (search stays 360°). */
	yawHint: number | null;
}

/** Weak-heading prior σ (°) for the cascade; the app and fused search 360° and only seed from it. */
const WEAK_HEADING_SIGMA = 45;

const ALL_CONDITIONS = ["full", "nogravity", "noheading", "none"];
const COND_LABEL: Record<string, string> = {
	given: "as given",
	full: "full metadata",
	nogravity: "no gravity",
	noheading: "no heading (360°)",
	none: "no heading, no gravity",
};
const DEFAULT_HFOV = 50;
const YAW_SEEDS = [0, 40, 80, 120, 160, 200, 240, 280, 320];
const PITCH_SEEDS = [-8, 0, 8];
const HFOV_SEEDS = [40, 50, 65];

const dang = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const safe = (id: string) => id.replace(/[^\w.-]/g, "_");
const log = (...a: unknown[]) => console.error("[harness]", ...a);

function parseArgs(argv: string[]) {
	const a: Record<string, string | boolean> = {};
	const pos: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		if (k.startsWith("--")) {
			const name = k.slice(2);
			if (
				["no-overlay", "force", "help", "weak-heading", "fused-seeds"].includes(
					name,
				)
			)
				a[name] = true;
			else a[name] = argv[++i];
		} else pos.push(k);
	}
	return { a, pos };
}

function condPrior(
	e: Entry,
	cond: string,
	W: number,
	H: number,
	weakHeading = false,
): CondPrior {
	const hasHeading = e.headingDeg != null && Number.isFinite(e.headingDeg);
	const hasGrav = e.pitchDeg != null && e.rollDeg != null;
	const headingUsable = hasHeading && !["noheading", "none"].includes(cond);
	const yawKnown = headingUsable && !weakHeading;
	const yawHint =
		headingUsable && weakHeading ? (e.headingDeg as number) : null;
	const gravKnown = hasGrav && !["nogravity", "none"].includes(cond);
	let vfov: number;
	let focalSource: string;
	let focalKnown = true;
	if (e.vfovDeg) {
		vfov = e.vfovDeg;
		focalSource = "vfovDeg";
	} else if (e.hfovDeg) {
		vfov = vfovFromHfov(e.hfovDeg, W, H);
		focalSource = "hfovDeg";
	} else if (e.focal35mm) {
		const fPx = (e.focal35mm * Math.hypot(W, H)) / 43.2666; // as src/lib/upload/exif.ts vfovFromF35
		vfov = vfovFromFocal(fPx, H);
		focalSource = "focal35mm";
	} else {
		vfov = vfovFromHfov(DEFAULT_HFOV, W, H);
		focalSource = e.focalMm
			? "default-50-hfov (focalMm without sensor size ignored)"
			: "default-50-hfov";
		focalKnown = false;
	}
	return {
		yaw: yawKnown ? (e.headingDeg as number) : null,
		pitch: gravKnown ? (e.pitchDeg as number) : null,
		roll: gravKnown ? (e.rollDeg as number) : null,
		vfov,
		yawKnown,
		gravKnown,
		focalKnown,
		focalSource,
		yawHint,
	};
}

function errs(p: Pose | null | undefined, gt: Pose | null | undefined) {
	if (!p || !gt) return null;
	return {
		yaw: dang(p.yaw, gt.yaw),
		pitch: p.pitch - gt.pitch,
		roll: p.roll - gt.roll,
	};
}

// ---------- region (peaks for the app page + overlay) ----------

const regionCache = new Map<string, unknown>();
async function regionFor(
	e: Entry,
): Promise<{ region: unknown; regionFile: string | null }> {
	if (e.regionFile && fs.existsSync(e.regionFile))
		return {
			region: JSON.parse(fs.readFileSync(e.regionFile, "utf8")),
			regionFile: e.regionFile,
		};
	const key = `${e.lat.toFixed(2)},${e.lon.toFixed(2)}`;
	if (!regionCache.has(key)) {
		let peaks: unknown[] = [];
		try {
			peaks = (await peaksAt(e.lat, e.lon))
				.filter((p) => p.name)
				.map((p) => ({
					name: p.name,
					lat: p.lat,
					lon: p.lon,
					ele: p.ele ?? null,
					prominence: p.prominence ?? null,
				}));
		} catch (err) {
			log(`peaks for ${e.id} unavailable (${err}); empty region`);
		}
		regionCache.set(key, {
			id: "x",
			center: [e.lat, e.lon],
			photos: [],
			peaks,
			trails: [],
			waterNames: [],
		});
	}
	return { region: regionCache.get(key), regionFile: null };
}

// ---------- method A: app ----------

type AlignRun = {
	prior: Pose;
	ms: number;
	pose: Pose | null;
	score: number | null;
	confidence: number | null;
	alternatives: {
		pose: Pose;
		score: number;
		sil: number | null;
		total: number;
	}[];
};

function acceptRule(
	conf: number,
	pose: Pose,
	alts: AlignRun["alternatives"],
	prior: Pose,
	allowNear: boolean,
) {
	if (conf > 0.2) return { kind: "confident", shown: pose };
	const near = allowNear
		? alts.find(
				(a) =>
					Math.abs(dang(a.pose.yaw, prior.yaw)) < 4 &&
					Math.abs(a.pose.pitch - prior.pitch) < 1.5,
			)
		: null;
	if (near) return { kind: "near-compass", shown: near.pose };
	return { kind: "prior", shown: prior };
}

async function runApp(
	worker: InstanceType<typeof Worker>,
	e: Entry,
	photo: { file: string; width: number; height: number },
	cp: CondPrior,
	region: unknown,
) {
	const vfovs = cp.focalKnown
		? [cp.vfov]
		: HFOV_SEEDS.map((h) => vfovFromHfov(h, photo.width, photo.height));
	const yaws = cp.yawKnown
		? [cp.yaw as number]
		: cp.yawHint != null
			? [cp.yawHint, ...YAW_SEEDS]
			: YAW_SEEDS;
	const pitches = cp.gravKnown ? [cp.pitch as number] : PITCH_SEEDS;
	const roll = cp.gravKnown ? (cp.roll as number) : 0;
	const priors: Pose[] = [];
	for (const v of vfovs)
		for (const y of yaws)
			for (const p of pitches) priors.push({ yaw: y, pitch: p, roll, vfov: v });
	const nativePrior: Pose = {
		yaw: cp.yaw ?? cp.yawHint ?? 0,
		pitch: cp.pitch ?? 0,
		roll,
		vfov: cp.vfov,
	};
	const nativeIdx = priors.findIndex(
		(p) =>
			Math.abs(dang(p.yaw, nativePrior.yaw)) < 1e-9 &&
			Math.abs(p.pitch - nativePrior.pitch) < 1e-9 &&
			Math.abs(p.vfov - nativePrior.vfov) < 1e-6,
	);
	const adhoc = {
		id: `bench-${safe(e.id)}`,
		photoFile: photo.file,
		region,
		meta: {
			lat: e.lat,
			lon: e.lon,
			alt: e.altitudeM ?? null,
			width: photo.width,
			height: photo.height,
			heading: cp.yaw,
			pitch: cp.pitch ?? 0,
			roll,
			vfov: cp.vfov,
			f35: e.focal35mm ?? null,
		},
	};
	const t0 = Date.now();
	const r = await worker.call(
		{
			cmd: "align",
			adhoc,
			priors,
			fullTerrain: !cp.yawKnown,
		},
		900000,
	);
	const wallMs = Date.now() - t0;
	if (!r.ok) throw new Error(r.error);
	// a 360° search on the initial (prior-wedge) terrain is not the row we asked for: an error, not a result
	if (!cp.yawKnown && !r.meta?.fullTerrain)
		throw new Error("fullTerrain requested but the page did not load it");
	const runs: AlignRun[] = r.runs;
	const d = decideApp(runs, priors, nativeIdx, nativePrior, cp);
	const computeMs = runs.reduce((s, x) => s + x.ms, 0);
	return {
		pose: d.pose,
		shownPose: d.shownPose,
		accepted: d.accepted,
		acceptKind: d.acceptKind,
		confidence: d.confidence,
		prior: nativePrior,
		ms: computeMs,
		timing: {
			alignComputeMs: computeMs,
			wallMs,
			...r.timing,
			seeds: priors.length,
		},
		wrapper: {
			seeds: priors.length,
			yawSeeds: yaws.length,
			pitchSeeds: pitches.length,
			focalSeeds: vfovs.length,
			bestSeed: d.bestSeed,
			fullTerrain: !cp.yawKnown,
		},
		native: d.native,
		eye: r.meta?.eye,
		// what the page ran with (render_worker MATCHER_RENDERER)
		page: r.meta?.pageFlags ?? null,
	};
}

/**
 * The app method's decision over its seeds' runs: the single native run (prior yaw 0 when no heading),
 * and the wrapper (best by the app's own re-ranked total across seeds; confidence recomputed with the
 * engine's formula over all seeds' hypotheses, runner-up ≥ 3° of yaw away).
 */
function decideApp(
	runs: AlignRun[],
	priors: Pose[],
	nativeIdx: number,
	nativePrior: Pose,
	cp: CondPrior,
) {
	const nat = runs[nativeIdx >= 0 ? nativeIdx : 0];
	const natAcc = nat.pose
		? acceptRule(
				nat.confidence ?? 0,
				nat.pose,
				nat.alternatives,
				nat.prior,
				true,
			)
		: { kind: "failed", shown: nat.prior };
	const alts = runs.flatMap((x, i) =>
		x.alternatives.map((a) => ({ ...a, run: i })),
	);
	alts.sort((a, b) => b.total - a.total);
	const best = alts[0];
	let pose: Pose | null = null;
	let conf = 0;
	let acc = { kind: "failed", shown: nativePrior } as ReturnType<
		typeof acceptRule
	>;
	if (best) {
		pose = best.pose;
		const second = alts.find(
			(a) => Math.abs(dang(a.pose.yaw, best.pose.yaw)) > 3,
		);
		const margin = second
			? (best.total - second.total) / Math.max(Math.abs(best.total), 1e-3)
			: 1;
		conf = clamp01(margin * 4) * clamp01(best.score * 2.5);
		acc = acceptRule(
			conf,
			best.pose,
			runs[best.run].alternatives,
			runs[best.run].prior,
			cp.yawKnown && cp.gravKnown,
		);
	}
	return {
		pose,
		shownPose: acc.shown,
		accepted: acc.kind !== "prior" && acc.kind !== "failed",
		acceptKind: acc.kind,
		confidence: conf,
		bestSeed: best ? runs[best.run].prior : null,
		native: {
			pose: nat.pose,
			shownPose: natAcc.shown,
			acceptKind: natAcc.kind,
			accepted: natAcc.kind === "confident" || natAcc.kind === "near-compass",
			confidence: nat.confidence,
			ms: nat.ms,
			prior: nat.prior,
		},
		priors: priors.length,
	};
}

// ---------- method C: fused service ----------

async function health(url: string) {
	try {
		const r = await fetch(`${url}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		return (await r.json()) as { ok: boolean; capabilities?: string[] };
	} catch {
		return null;
	}
}

async function ensureMatcher(
	url: string,
): Promise<{ url: string; stop: () => void }> {
	const h = await health(url);
	if (h?.capabilities?.includes("adhoc")) return { url, stop: () => {} };
	if (h)
		log(
			`${url} runs a matcher without ad-hoc support (restart it with the current tools/matcher/server); starting a private one on :8766`,
		);
	const own = "http://127.0.0.1:8766";
	const h2 = await health(own);
	if (h2?.capabilities?.includes("adhoc")) return { url: own, stop: () => {} };
	log("starting tools/matcher/server/run.sh --port 8766");
	const logFile = fs.openSync(
		path.join(HARNESS, "out", "server-8766.log"),
		"a",
	);
	const p = spawn(
		path.join(ROOT, "tools/matcher/server/run.sh"),
		["--port", "8766"],
		{ cwd: ROOT, stdio: ["ignore", logFile, logFile], detached: false },
	);
	for (let i = 0; i < 90; i++) {
		await new Promise((r) => setTimeout(r, 2000));
		const hh = await health(own);
		if (hh?.ok) return { url: own, stop: () => p.kill("SIGINT") };
	}
	p.kill();
	throw new Error("matcher service did not come up on :8766");
}

async function runFused(
	url: string,
	e: Entry,
	photo: { file: string; width: number; height: number },
	cp: CondPrior,
	region: unknown,
	seeds: unknown[] = [],
) {
	const body = {
		photoPath: photo.file,
		meta: { lat: e.lat, lon: e.lon, altitudeM: e.altitudeM ?? null },
		prior: {
			yaw: cp.yaw,
			pitch: cp.pitch,
			roll: cp.roll,
			...(cp.focalKnown ? { vfov: cp.vfov } : {}),
		},
		region,
		timeoutMs: 600000,
		// server uses these only for narrow views (hfov < 25°): weak heading + optional other methods' poses
		...(cp.yawHint != null ? { yawHint: cp.yawHint } : {}),
		...(seeds.length ? { seeds } : {}),
	};
	const t0 = Date.now();
	const res = await fetch(`${url}/match`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(660000),
	});
	const j = (await res.json()) as Record<string, unknown> & {
		pose?: Pose;
		ok: boolean;
		error?: { message: string };
	};
	const wallMs = Date.now() - t0;
	if (!j.pose) throw new Error(`fused: ${j.error?.message ?? "no pose"}`);
	const high = j.confidenceLevel === "high";
	const adhoc = j.adhoc as { priorUsed: Pose; stages: unknown[] } | undefined;
	return {
		pose: j.pose,
		shownPose: j.pose,
		accepted: high,
		acceptKind: String(j.confidenceLevel ?? j.method),
		confidence: j.confidence as number,
		confidenceLevel: j.confidenceLevel,
		confidenceChecks: j.confidenceChecks,
		fusionScore: j.fusionScore,
		serverMethod: j.method, // "fused" | "render-match" (skyline cue unavailable); row.method stays the harness method
		cues: j.cues,
		prior: adhoc?.priorUsed,
		adhoc,
		ms: wallMs,
		timing: { ...(j.timingMs as object), wallMs },
		eye: j.eye,
	};
}

/** --fused-seeds: hand the app / cascade solved poses to fused as narrow-view stage-1 seeds (breaks independence). */
function fusedSeeds(
	rows: Record<string, Record<string, unknown>>,
	on: boolean,
) {
	if (!on) return [];
	return (["app", "cascade"] as const)
		.map((m) => rows[m])
		.filter((r) => r?.ok && r.pose)
		.map((r) => ({ ...(r.pose as Pose), source: String(r.method) }));
}

/** One retry: the dev server is shared, so an HMR reload can kill a page mid-request. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		log(`retrying after: ${String(err).slice(0, 160)}`);
		await new Promise((r) => setTimeout(r, 3000));
		return await fn();
	}
}

// ---------- main ----------

async function main() {
	const { a, pos } = parseArgs(process.argv.slice(2));
	if (a.help || !pos[0]) {
		console.error(
			fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0],
		);
		process.exit(pos[0] ? 0 : 2);
	}
	const manifestPath = path.resolve(pos[0]);
	const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	let entries: Entry[] = Array.isArray(raw) ? raw : raw.photos;
	const ids = typeof a.ids === "string" ? a.ids.split(",") : null;
	if (ids) entries = entries.filter((e) => ids.includes(e.id));
	const methods = (
		typeof a.methods === "string" ? a.methods : "app,cascade,fused"
	).split(",");
	const wantCascade = methods.some((m) => m.startsWith("cascade"));
	const conditions = (
		typeof a.conditions === "string" ? a.conditions : "given"
	).split(",");
	for (const c of conditions)
		if (c !== "given" && !ALL_CONDITIONS.includes(c))
			throw new Error(`unknown condition ${c}`);
	const overlayMethods = (
		typeof a["overlay-methods"] === "string"
			? a["overlay-methods"]
			: "app,cascade,fused"
	).split(",");
	const outDir = path.resolve(
		typeof a.out === "string"
			? a.out
			: path.join(
					HARNESS,
					"out",
					"runs",
					path.parse(manifestPath).name === "manifest"
						? path.basename(path.dirname(manifestPath))
						: path.parse(manifestPath).name,
				),
	);
	fs.mkdirSync(outDir, { recursive: true });
	const baseDir = path.dirname(manifestPath);
	log(`${entries.length} photos × [${conditions}] × [${methods}] → ${outDir}`);

	// normalise photos (upright JPEG ≤ 2048 px)
	const py = path.join(ROOT, "tools/matcher/.venv/bin/python");
	const args = entries.map(
		(e) => `${safe(e.id)}=${path.resolve(baseDir, e.file)}`,
	);
	const norm: Record<
		string,
		{
			file: string;
			width: number;
			height: number;
			orientation: number;
			reencoded: boolean;
		}
	> = args.length
		? JSON.parse(
				execFileSync(
					py,
					[
						path.join(HARNESS, "lib/normalize.py"),
						path.join(outDir, "photos"),
						...args,
					],
					{ encoding: "utf8" },
				),
			)
		: {};

	// one polite Overpass query for the whole set's peaks (per-photo queries otherwise)
	const noRegion = entries.filter(
		(e) => !(e.regionFile && fs.existsSync(e.regionFile)),
	);
	if (noRegion.length > 3) {
		const lats = noRegion.map((e) => e.lat);
		const lons = noRegion.map((e) => e.lon);
		const mLat = 0.8;
		const mLon =
			0.8 / Math.cos((Math.max(...lats.map(Math.abs)) * Math.PI) / 180);
		try {
			const n = await prefetchPeaksBBox(
				+(Math.min(...lats) - mLat).toFixed(2),
				+(Math.min(...lons) - mLon).toFixed(2),
				+(Math.max(...lats) + mLat).toFixed(2),
				+(Math.max(...lons) + mLon).toFixed(2),
			);
			log(`peaks: ${n} named OSM peaks in the set's bbox`);
		} catch (err) {
			log(
				`bbox peak prefetch failed (${err}); falling back to per-photo queries`,
			);
		}
	}

	let matcher: { url: string; stop: () => void } | null = null;
	let worker: InstanceType<typeof Worker> | null = null;
	const all: Record<string, unknown>[] = [];
	try {
		if (methods.includes("fused"))
			matcher = await ensureMatcher(
				typeof a["matcher-url"] === "string"
					? a["matcher-url"]
					: "http://127.0.0.1:8765",
			);
		if (methods.includes("app")) {
			process.env.MATCHER_PORT = matcher ? new URL(matcher.url).port : "8765";
			worker = new Worker({ maxPages: 2 });
		}
		for (const e of entries) {
			const photo = norm[safe(e.id)];
			if (
				e.width &&
				e.height &&
				(e.width !== photo.width || e.height !== photo.height) &&
				e.width / e.height !== photo.width / photo.height
			)
				log(
					`${e.id}: manifest size ${e.width}×${e.height} vs upright file ${photo.width}×${photo.height}; using the file`,
				);
			const { region, regionFile } = await regionFor(e);
			for (const cond of conditions) {
				const cp = condPrior(
					e,
					cond,
					photo.width,
					photo.height,
					!!a["weak-heading"],
				);
				const rows: Record<string, Record<string, unknown>> = {};
				const resFile = (m: string) =>
					path.join(outDir, "results", safe(e.id), `${cond}.${m}.json`);
				const todo = (m: string) => {
					if (a.force || !fs.existsSync(resFile(m))) return true;
					try {
						return !JSON.parse(fs.readFileSync(resFile(m), "utf8")).ok; // re-run earlier failures
					} catch {
						return true;
					}
				};
				const base = {
					id: e.id,
					condition: cond,
					assumptions: cp,
					tags: e.tags ?? [],
				};
				// B: cascade (both variants from one call)
				if (wantCascade && (todo("cascade") || todo("cascade-native"))) {
					const job: CascadeJob = {
						key: `${e.id}/${cond}`,
						photoFile: photo.file,
						width: photo.width,
						height: photo.height,
						lat: e.lat,
						lon: e.lon,
						alt: e.altitudeM ?? null,
						gpsError: e.gpsErrorM ?? undefined,
						prior: {
							yaw: cp.yaw ?? cp.yawHint,
							pitch: cp.pitch,
							roll: cp.roll,
							vfov: cp.vfov,
						},
						focalKnown: cp.focalKnown,
						yawSigmaDeg: cp.yawHint != null ? WEAK_HEADING_SIGMA : undefined,
					};
					const r = (await runCascade(job)) as Record<string, unknown> & {
						variants?: Record<string, Record<string, unknown>>;
					};
					for (const [m, v] of [
						["cascade", "configured"],
						["cascade-native", "native"],
					]) {
						if (
							!methods.includes(m) &&
							!(m === "cascade-native" && methods.includes("cascade"))
						)
							continue;
						const x = r.variants?.[v];
						rows[m] = x
							? {
									...base,
									method: m,
									ok: true,
									pose: x.pose,
									shownPose: x.accepted ? x.pose : x.prior,
									accepted: x.accepted,
									acceptKind: x.accepted
										? `accepted (${x.stage})`
										: `rejected (${x.stage})`,
									confidence: x.confidence,
									prior: x.prior,
									ms: Math.round(
										(r.skylineMs as number) + (x.solveMs as number),
									),
									timing: {
										skylineMs: r.skylineMs,
										solveMs: x.solveMs,
										sceneMs: r.sceneMs,
									},
									detail: { ...x, pose: undefined, prior: undefined },
									eye: r.eye,
									eyeGround: r.ground,
									dem: r.dem ?? "terrarium",
								}
							: { ...base, method: m, ok: false, error: r.error };
					}
				}
				// A: app
				if (methods.includes("app") && worker && todo("app")) {
					try {
						const reg = {
							...(region as object),
							id: `bench-${safe(e.id)}-region`,
						};
						rows.app = {
							...base,
							method: "app",
							ok: true,
							...(await retry(() =>
								runApp(
									worker as InstanceType<typeof Worker>,
									e,
									photo,
									cp,
									reg,
								),
							)),
						};
					} catch (err) {
						rows.app = {
							...base,
							method: "app",
							ok: false,
							error: String(err),
						};
						if (worker.dead) worker = new Worker({ maxPages: 2 });
					}
				}
				// C: fused
				if (methods.includes("fused") && matcher && todo("fused")) {
					try {
						const url = matcher.url;
						rows.fused = {
							...base,
							method: "fused",
							ok: true,
							...(await retry(() =>
								runFused(
									url,
									e,
									photo,
									cp,
									region,
									fusedSeeds(rows, !!a["fused-seeds"]),
								),
							)),
						};
					} catch (err) {
						rows.fused = {
							...base,
							method: "fused",
							ok: false,
							error: String(err),
						};
					}
				}
				for (const [m, row] of Object.entries(rows)) {
					row.err = {
						gt: errs(row.pose as Pose, e.gt),
						gtPin: errs(row.pose as Pose, e.gtPin),
						gtShown: errs(row.shownPose as Pose, e.gt),
					};
					if (
						!a["no-overlay"] &&
						row.ok &&
						row.pose &&
						overlayMethods.includes(m)
					) {
						try {
							const ov = await renderOverlay({
								photoFile: photo.file,
								lat: e.lat,
								lon: e.lon,
								alt: e.altitudeM ?? null,
								// the eye this method used (fused/app: engine ENU [0,0,h]; cascade: its eyeHeight)
								eyeH: Array.isArray(row.eye)
									? (row.eye as number[])[2]
									: typeof row.eye === "number"
										? row.eye
										: null,
								pose: row.pose as Pose,
								gt: e.gt ?? null,
								prior:
									cp.yawKnown || cp.yawHint != null
										? {
												yaw: (cp.yaw ?? cp.yawHint) as number,
												pitch: cp.pitch ?? 0,
												roll: cp.roll ?? 0,
												vfov: cp.vfov,
											}
										: null,
								title: e.id,
								method: m,
								condition: COND_LABEL[cond],
								confidence: confText(row),
								extra: (row.err as { gt: { yaw: number } | null }).gt
									? `Δ vs GT yaw ${(row.err as { gt: { yaw: number; pitch: number; roll: number } }).gt.yaw.toFixed(2)}° pitch ${(row.err as { gt: { pitch: number } }).gt.pitch.toFixed(2)}° roll ${(row.err as { gt: { roll: number } }).gt.roll.toFixed(2)}°`
									: undefined,
								regionFile,
								width: 1400,
								out: path.join(
									outDir,
									"overlays",
									`${safe(e.id)}__${cond}__${m}.jpg`,
								),
							});
							row.overlay = path.relative(outDir, ov.out);
							row.overlayPeaks = ov.labels;
						} catch (err) {
							row.overlayError = String(err);
						}
					}
					fs.mkdirSync(path.dirname(resFile(m)), { recursive: true });
					fs.writeFileSync(resFile(m), JSON.stringify(row, null, 1));
					const g = (row.err as { gt: { yaw: number } | null }).gt;
					log(
						`${e.id} ${cond} ${m}: ${row.ok ? `yaw ${(row.pose as Pose)?.yaw?.toFixed(2)} ${confText(row)}${g ? ` Δyaw ${g.yaw.toFixed(2)}` : ""} ${row.ms} ms` : `ERROR ${row.error}`}`,
					);
				}
			}
		}
	} finally {
		await worker?.close();
		matcher?.stop();
	}
	// collect every result under out/results (including earlier, resumed ones)
	const resDir = path.join(outDir, "results");
	for (const d of fs.existsSync(resDir) ? fs.readdirSync(resDir) : [])
		for (const f of fs.readdirSync(path.join(resDir, d)))
			all.push(JSON.parse(fs.readFileSync(path.join(resDir, d, f), "utf8")));
	fs.writeFileSync(
		path.join(outDir, "results.json"),
		JSON.stringify(all, null, 1),
	);
	fs.writeFileSync(path.join(outDir, "summary.md"), summary(all));
	log(
		`wrote ${all.length} rows → ${path.join(outDir, "results.json")} and summary.md`,
	);
}

function confText(row: Record<string, unknown>) {
	if (!row.ok) return "error";
	if (row.method === "fused")
		return `${String(row.confidenceLevel ?? row.acceptKind).toUpperCase()} (${Number(row.confidence).toFixed(2)})`;
	return `conf ${Number(row.confidence ?? 0).toFixed(2)} ${row.accepted ? "accepted" : "rejected"}`;
}

function summary(rows: Record<string, unknown>[]) {
	const f = (v: unknown, d = 2) =>
		typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "–";
	const out = [
		"| photo | condition | method | yaw | pitch | roll | vfov | confidence | accepted | Δyaw GT | Δpitch GT | Δroll GT | ms |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	rows.sort(
		(x, y) =>
			String(x.id).localeCompare(String(y.id)) ||
			ALL_CONDITIONS.indexOf(String(x.condition)) -
				ALL_CONDITIONS.indexOf(String(y.condition)) ||
			String(x.method).localeCompare(String(y.method)),
	);
	for (const r of rows) {
		const p = (r.pose ?? {}) as Partial<Pose>;
		const g = ((r.err as { gt?: Partial<Pose> } | undefined)?.gt ??
			{}) as Partial<Pose>;
		out.push(
			`| ${r.id} | ${r.condition} | ${r.method} | ${f(p.yaw)} | ${f(p.pitch)} | ${f(p.roll)} | ${f(p.vfov, 1)} | ${r.ok ? confText(r) : `error: ${String(r.error).slice(0, 60)}`} | ${r.ok ? r.acceptKind : "–"} | ${f(g.yaw)} | ${f(g.pitch)} | ${f(g.roll)} | ${r.ms ?? "–"} |`,
		);
	}
	return `${out.join("\n")}\n`;
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
