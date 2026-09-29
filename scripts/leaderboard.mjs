#!/usr/bin/env node
/**
 * Rigi leaderboard: one command that answers "are we state of the art yet?"
 *
 *   node scripts/leaderboard.mjs [flags]
 *
 * Steps (each optional, each with a timeout, a failure is recorded and the run continues):
 *   tsc      npx tsc --noEmit -p .                      → error count, grouped by owning session
 *   biome    npx biome check src scripts --reporter=json → error/warning counts (read-only, never --write)
 *   build    vite build with out/lead/leaderboard/vite.build.config.mjs (same plugins as vite.config.ts,
 *            but every artefact goes to out/lead/leaderboard/build, so the shared .output/ is untouched)
 *            → pass/fail, chunk sizes (raw + gzip)
 *   (start)  GT snapshot: photos.json, data/ground-truth.json, data/control-points.json are copied ONCE into
 *            out/lead/leaderboard/gt-snapshot/ (+ manifest.json); every score in the run uses that snapshot
 *   evalcpu  READ-ONLY: 0f's out/eval/report.json (→ cpu, cpu-final) and every out/eval-<variant>/report.json
 *            (→ cpu:<variant>, e.g. cpu:classic-cascade = 0f's recommended default, cpu:classic-skyfirst = the
 *            high-accuracy mode), re-scored from prior + delta. Reads retry while a report has fewer rows than
 *            photos. Only with --run-evalcpu does it first run `npx tsx scripts/eval.ts` (rewrites 0f's out/eval/)
 *   evalapp  OFF by default (it is 9e's evaluator and reads the live data/): --run-evalapp runs
 *            node scripts/eval-app.mjs and parses its table as a cross-check of the app step
 *   matcher  READ-ONLY external results, re-scored against the snapshot: out/refine/results.json (d1; rows split
 *            by `method` → refine, refine+sky), other out/<track>/results.json, tools/matcher/results*.json,
 *            f0's raw tools/matcher/out/results/<id>_initial|_refine.json (→ matcher:render-match[-it1]) and
 *            fusion_default.json (→ matcher:fused), plus --results files. f0's contract files win: raw-derived
 *            rows are used only for methods no contract file provides. f0's report_tables.md summary lines
 *            are kept as "from report, not re-scored"
 *   (merge)  ranking on accept counts / false accepts / > 2° errors (never on sub-0.3° medians), oracle /
 *            agreement-gate ensemble analysis, "Recommended pipeline" line, input ages
 *   app      own Playwright pass over /photo/<id> on the dev server: the app's final pose, a timed re-run of
 *            engine.autoAlign(true) for confidence + solve time, the control-point GT solve, and reprojection
 *            px of every method's pose at the labelled control points
 *   perf     time-to-[data-ready] for /photo/<id>, cold (fresh on-disk profile) and warm (reload), sequential;
 *            bytes on the wire per origin (cross-origin included) and cache hits via the DevTools protocol
 *
 * Flags:
 *   --skip tsc,biome,build,evalcpu,evalapp,matcher,app,perf   skip steps (a skipped step carries over the
 *                                     previous reports/leaderboard.json result, marked stale, unless --no-carry)
 *   --only tsc,biome                  run only these steps (others skipped)
 *   --quick                           = --skip build,perf (evalapp is off unless --run-evalapp)
 *   --run-evalapp                     also run 9e's scripts/eval-app.mjs (cross-check; not run by default)
 *   --photos IMG_a,IMG_b              restrict the accuracy passes to these photos
 *   --perf-photos IMG_a,IMG_b,IMG_c   photos for the perf step (default: first, middle, last)
 *   --app-url http://localhost:3100   dev server (env APP_URL also works)
 *   --concurrency 3                   parallel pages in the app pass
 *   --timeout-scale 1                 multiply every step timeout
 *   --out reports                     where leaderboard.md/json go
 *   --no-carry                        do not carry over stale results for skipped steps
 *   --run-evalcpu                     regenerate 0f's out/eval/report.json with scripts/eval.ts first (full set
 *                                     only; refused with --photos). Default: read the existing report.
 *   --results a.json,b.json           extra external results files (matcher shape) to score
 *   --selftest                        run the unit self-test (math, convention cross-check vs src/lib/pose.ts) and exit
 *
 * Pose convention (src/lib/pose.ts): yaw = true heading clockwise from north, pitch up +, roll right side
 * down +, vfov = vertical FOV, all degrees. 0f's Camera (src/lib/geo/camera.ts) uses the same angles
 * (checked: photos.json prior == ground-truth.json prior), f in px on width×height → vfov = 2·atan(h/2f).
 *
 * ── reports/leaderboard.json, schemaVersion 2 (v1 + ranking, ensemble, recommendation, inputs.files) ──
 * {
 *   schemaVersion: 2, generatedAt: ISO, durationMs, appUrl, argv: string[],
 *   targets: { medianYawDeg, success1Rate, meanYawSotaDeg, success1SotaRate, coldReadyMs },
 *   steps: {
 *     <step>: { status: 'ok'|'partial'|'fail'|'timeout'|'skipped'|'error', ms, note?, stale?: ISO (carried over), ...step fields }
 *              (partial = some photos failed; the failures are listed and reach the blocking list)
 *     tsc:     { errorCount, byOwner: {owner: n}, byFile: {file: n}, sample: string[] }
 *     biome:   { errors, warnings, infos, filesChecked?, byOwner, byCategory, byFile }
 *     build:   { outDir, assets: [{file, bytes, gzipBytes}], totalJsBytes, totalJsGzip, totalCssBytes }
 *     evalcpu: { reportPath, reportMtime, reportAgeMin, photos, ran: bool, reportStale?: true (ran but report not rewritten),
 *                reports: [{dir, file, key, rows, mtime, ageMin, reads, warning?}], evalMatches?: string[] (variants out/eval equals) }
 *     evalapp: { rows: [{id, pins, gtResid, priorPx, autoPx, dYawPrior, dYawAuto, dPitchAuto, dRollAuto}],
 *                within1: "k/n", medianAutoPx, crossCheck: {n, maxAbsPxDiff, maxAbsYawDiff} (vs the app step) }
 *     matcher: { files: [{file, methods: {<method>: n}, mtime, ageMin, reads?, warning?} | {file, error}],
 *                reported: [{source, method, n, medianAbsYaw, medianAbsPitch, medianAbsRoll, medianPinPx, within1, of}] (not re-scored),
 *                reportedOnly: bool }
 *     app:     { photos, failures: [{id, error}], concurrency,
 *                raw: { <id>: { prior, final, aspect, alignMs, align: {pose, score, confidence, nAlt, alts: Pose[]}|null,
 *                               cp: {labelled, pins, pose?, residPx?, px: {<method>: px}}?, readyMs, pageErrors } } }
 *                (raw is kept so a later run with --skip app can carry the app numbers over)
 *     perf:    { runs: [{id, cold: {readyMs, loadMs, pageErrors, lastResponseMs, requests, cachedRequests, pendingAtReady,
 *                                    transferKiB (on the wire, all origins), byOrigin: {<origin>: {requests, cached, networkKiB}},
 *                                    bytesMeasured: 'cdp'}|null,
 *                        warm: {...}|null, error?}],   // lastResponseMs: last network response before ready
 *                failed: string[], medianColdMs, medianWarmMs, nCold, nWarm }
 *   },
 *   inputs: { start|used|end: { photos|groundTruth|controlPoints: {mtime, sha1} }, changed: string[],
 *             gtSnapshot: { dir, takenAt, files: {<k>: {source, sourceMtime, sha1, bytes}} },
 *             files: [{file, owner, mtime, ageMin, note}] },   // every input with its age
 *           // changed: live GT edited after the snapshot, or a method file rewritten during the run
 *   gt: { json: string[] (ids with a usable ground-truth.json pose), cp: string[] (ids with ≥2 resolved pins),
 *         either: string[], missing: string[], bandDeg (GT-uncertainty band around 1° on 'approx' GT) },
 *   photos: [{
 *     id, width, height,
 *     gtJson: { quality, pose: Pose, rmsPx1600? } | null,
 *     gtCp:   { labelled, pins, pose: Pose | null, residPx } | null,       // solved in-page by engine.solvePins
 *     gtAgreement: { yaw, pitch, roll, pinPx } | null,                     // gtJson vs gtCp
 *     primaryGt: 'json' | 'cp' | null,                                     // json if quality good/approx, else cp
 *     ready: { ms } | null,                                                // app pass time-to-ready (concurrent)
 *     methods: { <method>: {
 *        pose: Pose, confidence: number|null, accepted: boolean|null, ms: number|null, note?,
 *        err: { json?: Err, cp?: Err, primary?: Err },
 *        sim?: { fallbackKind, fallback: Pose, bestYaw, fallbackYaw } } }  // app / cpu-final: pose shown if rejected,
 *                                                                            // signed yaw errs vs primary GT
 *   }],  // Pose = {yaw,pitch,roll,vfov}; Err = {yaw, pitch, roll, vfov (signed deg, method − GT), px}
 *        // px: json → mean grid reprojection (7×5 grid of GT rays) on a 1600-px-wide image;
 *        //     cp   → mean reprojection error at the labelled control points (engine.pinError, 1600 basis)
 *   methods: { <method>: { label, description,
 *        agg: { json|cp|primary: { n, medianAbsYaw, meanAbsYaw, maxAbsYaw, medianAbsPitch, medianAbsRoll,
 *                                  medianPx, meanPx, maxPx, success05, success1, rate05, rate1, accepted, medianMs } },
 *        calibration: { n, auroc, spearman, confidentFailures: string[], rejectedSuccesses: string[],
 *                       acceptedFailures: [{id, conf, absYaw}],
 *                       separatingThreshold: { above, n, rejectsFailures, rejectsSuccesses: string[], simulated,
 *                          // simulated (methods with sim): newly rejected photos take their fallback pose
 *                          successesBefore?, successesAfter?, meanAbsYawBefore?, meanAbsYawAfter?,
 *                          changed?: [{id, conf, fromAbsYaw, toAbsYaw, fallback}] } | null,
 *                       bins: [{range, n, medianAbsYaw}] } | null } },
 *   // agg.* also carries the decision view: acceptsAll, correctAccepts, falseAccepts, falseAcceptIds, borderlineAccepts,
 *   //   borderlineAcceptIds, success1Clear, borderlineShown, borderlineShownIds, over2, over2Ids (band: GT_BAND_DEG on
 *   //   'approx' / cp GT; gt.bandDeg)
 *   ranking: { need, rows: [{rank, method, n, correctAccepts, falseAccepts, borderlineAccepts, over2, success1,
 *                            success1Clear, medianAbsYaw, medianMsAll}],
 *              incomplete: [{method, n}], duplicates?: [{method, sameAs}] },
 *   ensemble: { members: {name: method}, nPhotos, nGt,
 *               residualPick: {available, residualsPerMember, note?, n?, within1?, ...},
 *               oracle / confidencePick: {n, within1, clear, borderline, wrong, medianAbsYaw, meanAbsYaw, maxAbsYaw,
 *                                         perPhoto, ...}  // confidencePick also: picksByMember, tiesBrokenByOrder, tieIds
 *               agreement: [Gate], baseline: Gate & {method, baseline: true} }  // baseline = the default alone
 *   // Gate = {rule, members, accepted, escalated, escalationRate, escalatedIds, acceptedGt, correct, falseAccepts,
 *   //         falseAcceptIds, borderline, borderlineIds, over2, medianAbsYaw, maxAbsYaw, escalatedGt,
 *   //         bestEscalation: {method, fixed, wrong, of}|null, costMs, overallWithin1, overallOf}
 *   recommendation: string | null,                            // the "Recommended pipeline" line
 *   disagreement: [{ id, a, b, yaw, pitch, hasGt, closer }],   // |Δyaw| between app and cpu:classic-cascade > 1°
 *   blocking: string[]                                        // auto-derived "what's blocking SoTA"
 * }
 *
 * ── external results (tools/matcher/results*.json, out/<track>/results.json, --results) shape ────────
 *   { "method": "lightglue-pnp", "results": [ { "id": "IMG_6958", "yaw": 43.7, "pitch": -1.6, "roll": 1.5,
 *        "vfov": 30.3,  // or "f" (px) with "width"/"height"
 *        "confidence": 0.9, "accepted": true, "ms": 2400 } ] }
 *   `results` may also be an object keyed by photo id, or the file may be a bare array of rows (as
 *   out/refine/results.json is). Method name: "matcher:<method|file suffix>", "<track>[:<method>]".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const MY_DIR = path.join(ROOT, "out", "lead", "leaderboard");
const STEPS = [
	"tsc",
	"biome",
	"build",
	"evalcpu",
	"evalapp",
	"matcher",
	"app",
	"perf",
];
const D = Math.PI / 180;

/** Median |yaw| differences smaller than this are inside GT noise: a median this close above a target is "within noise". */
const MEDIAN_NOISE_DEG = 0.1;
export const TARGETS = {
	/** Our bar: median |yaw| on the in-house set. */
	medianYawDeg: 0.3,
	/** Our bar: fraction of photos within 1° yaw. */
	success1Rate: 0.9,
	/** Porzi et al. (sensor-seeded contour alignment) mean error, per the SoTA report. */
	meanYawSotaDeg: 1.23,
	/** LandscapeAR fraction within 1° on GeoPose3K, per the SoTA report. */
	success1SotaRate: 0.39,
	/** Cold time to [data-ready] on /photo/<id>. */
	coldReadyMs: 10000,
};

// ─────────────────────────────── ownership ───────────────────────────────
const OWNERS = [
	[
		"leaderboard",
		{
			exact: ["scripts/leaderboard.mjs"],
			prefix: ["reports/leaderboard.", "out/lead/leaderboard/"],
		},
	],
	[
		"lead",
		{
			exact: [],
			prefix: [
				"src/lib/upload/",
				"src/lib/pose6dof/",
				"src/lib/export/",
				"scripts/test-",
				"out/lead/",
			],
		},
	],
	[
		"9e",
		{
			exact: [
				"src/lib/engine.ts",
				"src/lib/align.ts",
				"src/lib/terrain.ts",
				"src/lib/materials.ts",
				"src/lib/pose.ts",
				"src/lib/geodesy.ts",
				"src/lib/photos.ts",
				"src/lib/segment.ts",
				"src/routes/index.tsx",
				"src/routes/photo.$id.tsx",
				"src/routes/__root.tsx",
				"src/styles.css",
				"scripts/ingest.mjs",
				"scripts/eval-app.mjs",
				"scripts/shot.mjs",
			],
			prefix: ["src/components/", "public/photos/"],
		},
	],
	[
		"0f",
		{
			exact: ["src/routes/baseline.tsx"],
			prefix: [
				"src/lib/geo/",
				"src/baseline-ui/",
				"data/",
				"out/eval",
				"out/gt/",
				"out/baseline/",
				"out/skyline/",
				"out/peaks/",
				"scripts/eval",
				"scripts/annotate",
				"scripts/baseline",
				"scripts/lib/",
				"scripts/export-baseline",
				"scripts/.tmp/",
			],
		},
	],
	[
		"d1",
		{
			exact: ["scripts/refine-eval.ts"],
			prefix: [
				"src/lib/look/",
				"src/lib/sky/",
				"src/lib/refine/",
				"src/lib/horizon-fast/",
				"out/refine/",
			],
		},
	],
	[
		"f0",
		{
			exact: ["src/routes/deck.tsx", "src/lib/matcher-client.ts"],
			prefix: ["src/lib/deck/", "src/lib/cache/", "tools/"],
		},
	],
];
/** Other lead tracks (out/lead/<track>/ exists) are assumed to own src/lib/<track>/ too. */
function leadTracks() {
	try {
		return fs
			.readdirSync(path.join(ROOT, "out", "lead"), { withFileTypes: true })
			.filter((d) => d.isDirectory() && d.name !== "leaderboard")
			.map((d) => d.name);
	} catch {
		return [];
	}
}
let LEAD_TRACKS = null;
export function ownerOf(file) {
	const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
	for (const [o, r] of OWNERS) if (r.exact.includes(f)) return o;
	for (const [o, r] of OWNERS)
		if (r.prefix.some((p) => f.startsWith(p))) return o;
	LEAD_TRACKS ??= leadTracks();
	for (const t of LEAD_TRACKS)
		if (f.startsWith(`src/lib/${t}/`) || f.startsWith(`out/lead/${t}/`))
			return `lead/${t}`;
	return "unowned";
}

// ─────────────────────────────── math ───────────────────────────────
export const angleDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
export function median(v) {
	const s = v.filter(Number.isFinite).sort((a, b) => a - b);
	if (!s.length) return null;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export const mean = (v) => {
	const s = v.filter(Number.isFinite);
	return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
};
const maxOf = (v) => {
	const s = v.filter(Number.isFinite);
	return s.length ? Math.max(...s) : null;
};
/** P(conf of a success > conf of a failure); ties count ½. null when a class is empty. */
export function auroc(pairs) {
	const pos = pairs.filter((p) => p.ok).map((p) => p.conf);
	const neg = pairs.filter((p) => !p.ok).map((p) => p.conf);
	if (!pos.length || !neg.length) return null;
	let s = 0;
	for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
	return s / (pos.length * neg.length);
}
function ranks(v) {
	const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
	const r = new Array(v.length);
	for (let i = 0; i < idx.length; ) {
		let j = i;
		while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
		for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
		i = j + 1;
	}
	return r;
}
export function spearman(x, y) {
	if (x.length < 3) return null;
	const rx = ranks(x);
	const ry = ranks(y);
	const mx = mean(rx);
	const my = mean(ry);
	let n = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < x.length; i++) {
		n += (rx[i] - mx) * (ry[i] - my);
		dx += (rx[i] - mx) ** 2;
		dy += (ry[i] - my) ** 2;
	}
	return dx && dy ? n / Math.sqrt(dx * dy) : null;
}

/** Port of src/lib/pose.ts poseBasis (plain arrays). Cross-checked in --selftest. */
export function poseBasis(p) {
	const y = p.yaw * D;
	const pt = p.pitch * D;
	const r = p.roll * D;
	const f = [
		Math.sin(y) * Math.cos(pt),
		Math.cos(y) * Math.cos(pt),
		Math.sin(pt),
	];
	const r0 = [Math.cos(y), -Math.sin(y), 0];
	const u0 = [
		r0[1] * f[2] - r0[2] * f[1],
		r0[2] * f[0] - r0[0] * f[2],
		r0[0] * f[1] - r0[1] * f[0],
	];
	const right = r0.map((v, i) => v * Math.cos(r) - u0[i] * Math.sin(r));
	const up = u0.map((v, i) => v * Math.cos(r) + r0[i] * Math.sin(r));
	return { forward: f, right, up };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function projectDir(p, aspect, d) {
	const { forward, right, up } = poseBasis(p);
	const z = dot(d, forward);
	if (z <= 0) return null;
	const t = Math.tan((p.vfov * D) / 2);
	return {
		u: 0.5 + dot(d, right) / z / (t * aspect) / 2,
		v: 0.5 - dot(d, up) / z / t / 2,
	};
}
export function unprojectDir(p, aspect, u, v) {
	const { forward, right, up } = poseBasis(p);
	const t = Math.tan((p.vfov * D) / 2);
	const x = (u * 2 - 1) * t * aspect;
	const y = (1 - v * 2) * t;
	const d = forward.map((f, i) => f + right[i] * x + up[i] * y);
	const n = Math.hypot(...d);
	return d.map((c) => c / n);
}
/** Mean px (on a `basis`-wide image) by which `pose` misplaces a 7×5 grid of `gt`'s rays. */
export function gridPx(pose, gt, aspect, basis = 1600) {
	let s = 0;
	let n = 0;
	for (let i = 0; i < 7; i++)
		for (let j = 0; j < 5; j++) {
			const u = 0.05 + (0.9 * i) / 6;
			const v = 0.05 + (0.9 * j) / 4;
			const pr = projectDir(pose, aspect, unprojectDir(gt, aspect, u, v));
			if (!pr) return Number.POSITIVE_INFINITY;
			s += Math.hypot((pr.u - u) * basis, ((pr.v - v) * basis) / aspect);
			n++;
		}
	return s / n;
}
export const vfovFromF = (f, height) => (2 * Math.atan(height / 2 / f)) / D;
function poseErr(pose, gt, aspect, px) {
	if (!pose || !gt) return undefined;
	return {
		yaw: round(angleDiff(pose.yaw, gt.yaw), 3),
		pitch: round(pose.pitch - gt.pitch, 3),
		roll: round(pose.roll - gt.roll, 3),
		vfov: round(pose.vfov - gt.vfov, 3),
		px: round(px ?? gridPx(pose, gt, aspect), 1),
	};
}
const round = (x, n = 2) =>
	Number.isFinite(x) ? +x.toFixed(n) : x == null ? null : x > 0 ? 1e9 : null;

// ─────────────────────────────── process helpers ───────────────────────────────
function run(cmd, args, { timeoutMs, env } = {}) {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const child = spawn(cmd, args, {
			cwd: ROOT,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env },
		});
		let out = "";
		let err = "";
		let timedOut = false;
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3000);
		}, timeoutMs ?? 120000);
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({
				code: -1,
				out,
				err: `${err}${e.message}`,
				ms: Date.now() - t0,
				timedOut,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err, ms: Date.now() - t0, timedOut });
		});
	});
}
const log = (...m) =>
	console.log(`[leaderboard ${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...m);
const readJson = (p, fallback = null) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return fallback;
	}
};
const tail = (s, n = 600) => (s.length > n ? `…${s.slice(-n)}` : s).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** JSON.parse that also accepts Python's bare NaN / Infinity / -Infinity (f0's matcher writes them) as null. */
export const parseJsonLenient = (txt) =>
	JSON.parse(
		txt.replace(/([:[,]\s*)-?(?:Infinity|NaN)(?=\s*[,\]}])/g, "$1null"),
	);
/**
 * Reads a JSON file another session may be rewriting right now. `validate(json)` returns true, or a string saying
 * why the content looks incomplete (e.g. fewer rows than expected); the read is retried `tries` times, `delayMs`
 * apart. After the last try the latest parse is returned with a warning (never throws).
 */
export async function readJsonStable(
	file,
	{ validate = () => true, tries = 4, delayMs = 2500 } = {},
) {
	let last = null;
	let why = "";
	for (let i = 0; i < tries; i++) {
		try {
			const j = parseJsonLenient(fs.readFileSync(file, "utf8"));
			const v = validate(j);
			if (v === true) return { json: j, tries: i + 1, mtimeMs: mtimeOf(file) };
			why = typeof v === "string" ? v : "failed validation";
			last = j;
		} catch (e) {
			why =
				e.code === "ENOENT"
					? "missing"
					: `unparseable (${String(e.message).slice(0, 80)})`;
			if (e.code === "ENOENT")
				return { json: null, tries: i + 1, warning: "missing", mtimeMs: null };
		}
		if (i < tries - 1) await sleep(delayMs);
	}
	return {
		json: last,
		tries,
		warning: `${why} after ${tries} reads ${delayMs} ms apart`,
		mtimeMs: mtimeOf(file),
	};
}
const ageMin = (ms) =>
	ms == null ? null : Math.round((Date.now() - ms) / 60000);
const isoOf = (ms) => (ms == null ? null : new Date(ms).toISOString());

// ─────────────────────────────── steps ───────────────────────────────
async function stepTsc(scale) {
	const r = await run("npx", ["tsc", "--noEmit", "-p", "."], {
		timeoutMs: 180000 * scale,
	});
	if (r.timedOut) return { status: "timeout", ms: r.ms };
	const lines = `${r.out}\n${r.err}`.split("\n");
	const byFile = {};
	const byOwner = {};
	const sample = [];
	let errorCount = 0;
	for (const l of lines) {
		const m = l.match(/^(.+?)\(\d+,\d+\): error TS\d+/);
		if (!m) continue;
		errorCount++;
		const f = path.relative(ROOT, path.resolve(ROOT, m[1]));
		byFile[f] = (byFile[f] ?? 0) + 1;
		const o = ownerOf(f);
		byOwner[o] = (byOwner[o] ?? 0) + 1;
		if (sample.length < 15) sample.push(l.trim().slice(0, 240));
	}
	const global = lines.filter((l) => /^error TS\d+/.test(l));
	errorCount += global.length;
	if (global.length) byOwner.global = global.length;
	return {
		status: r.code === 0 ? "ok" : errorCount ? "fail" : "error",
		ms: r.ms,
		errorCount,
		byOwner,
		byFile,
		sample: [...global.slice(0, 5), ...sample],
		...(r.code !== 0 && !errorCount ? { note: tail(r.err || r.out) } : {}),
	};
}

async function stepBiome(scale) {
	const r = await run(
		"npx",
		[
			"biome",
			"check",
			"src",
			"scripts",
			"--reporter=json",
			"--max-diagnostics=none",
		],
		{ timeoutMs: 120000 * scale },
	);
	if (r.timedOut) return { status: "timeout", ms: r.ms };
	let j;
	try {
		j = JSON.parse(r.out.slice(r.out.indexOf("{")));
	} catch {
		return {
			status: "error",
			ms: r.ms,
			note: `unparseable biome output: ${tail(r.err || r.out, 300)}`,
		};
	}
	const byOwner = {};
	const byCategory = {};
	const byFile = {};
	for (const d of j.diagnostics ?? []) {
		if (d.severity !== "error" && d.severity !== "warning") continue;
		const f = d.location?.path ?? "?";
		byFile[f] = (byFile[f] ?? 0) + 1;
		const o = ownerOf(f);
		byOwner[o] = (byOwner[o] ?? 0) + 1;
		byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
	}
	const s = j.summary ?? {};
	return {
		status: s.errors ? "fail" : "ok",
		ms: r.ms,
		errors: s.errors ?? 0,
		warnings: s.warnings ?? 0,
		infos: s.infos ?? 0,
		filesChecked: (s.changed ?? 0) + (s.unchanged ?? 0),
		byOwner,
		byCategory,
		byFile,
		note: "biome.json includes only **/src/** (plus vite.config.ts), so scripts/ is ignored by config",
	};
}

const BUILD_CONFIG = `// Leaderboard-owned build config (generated by scripts/leaderboard.mjs): identical plugins to
// /vite.config.ts, but every artefact goes under out/lead/leaderboard/build so the shared .output/
// (and anyone previewing it) is untouched.
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const OUT = path.join(import.meta.dirname, 'build')

export default defineConfig({
  root: ROOT,
  logLevel: 'warn',
  resolve: { tsconfigPaths: true },
  build: { outDir: path.join(OUT, 'client') },
  plugins: [
    nitro({
      rollupConfig: { external: [/^@sentry\\//] },
      buildDir: path.join(OUT, '.nitro'),
      output: { dir: OUT, serverDir: path.join(OUT, 'server'), publicDir: path.join(OUT, 'public') },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
`;
async function stepBuild(scale) {
	fs.mkdirSync(MY_DIR, { recursive: true });
	const cfg = path.join(MY_DIR, "vite.build.config.mjs");
	fs.writeFileSync(cfg, BUILD_CONFIG);
	// If the repo's vite.config.ts grows plugins we don't mirror, the build may diverge: note it.
	const viteCfg = fs.readFileSync(path.join(ROOT, "vite.config.ts"), "utf8");
	const mirrored = [
		"devtools",
		"nitro",
		"tailwindcss",
		"tanstackStart",
		"viteReact",
	];
	const unknown = [...viteCfg.matchAll(/^\s+(\w+)\(/gm)]
		.map((m) => m[1])
		.filter((p) => !mirrored.includes(p) && p !== "defineConfig");
	const outDir = path.join(MY_DIR, "build");
	fs.rmSync(outDir, { recursive: true, force: true });
	const outputStamp = (() => {
		try {
			return fs.statSync(path.join(ROOT, ".output", "nitro.json")).mtimeMs;
		} catch {
			return null;
		}
	})();
	// nitro records its last output dir in node_modules/.nitro/last-build.json (read by `nitro preview`).
	// Put back whatever was there so our private build never becomes the repo's "last build".
	const lastBuild = path.join(
		ROOT,
		"node_modules",
		".nitro",
		"last-build.json",
	);
	const lastBuildBefore = fs.existsSync(lastBuild)
		? fs.readFileSync(lastBuild, "utf8")
		: null;
	const r = await run(
		"npx",
		["vite", "build", "--config", path.relative(ROOT, cfg)],
		{ timeoutMs: 400000 * scale },
	);
	// Side effect outside out/lead/leaderboard (unavoidable: nitro hard-codes the path under its rootDir, which must
	// stay the repo root): nitro rewrites node_modules/.nitro/last-build.json; we restore it here and record it.
	let lastBuildAction = "untouched";
	try {
		// a pointer at our own build dir (left by an older version of this script) is dropped → nitro's default (.output)
		if (
			lastBuildBefore != null &&
			!lastBuildBefore.includes("out/lead/leaderboard")
		) {
			fs.writeFileSync(lastBuild, lastBuildBefore);
			lastBuildAction = "rewritten by nitro, restored to its previous content";
		} else if (
			fs.existsSync(lastBuild) &&
			fs.readFileSync(lastBuild, "utf8").includes("out/lead/leaderboard")
		) {
			fs.rmSync(lastBuild);
			lastBuildAction =
				lastBuildBefore == null
					? "created by nitro, deleted (did not exist before)"
					: "pointed at our build (older run), deleted";
		}
	} catch (e) {
		lastBuildAction = `restore failed: ${e.message}`;
	}
	const after = (() => {
		try {
			return fs.statSync(path.join(ROOT, ".output", "nitro.json")).mtimeMs;
		} catch {
			return null;
		}
	})();
	const res = {
		status: r.timedOut ? "timeout" : r.code === 0 ? "ok" : "fail",
		ms: r.ms,
		outDir: path.relative(ROOT, outDir),
		sideEffects: [`node_modules/.nitro/last-build.json: ${lastBuildAction}`],
	};
	const notes = [];
	if (unknown.length)
		notes.push(
			`vite.config.ts has plugins not mirrored: ${unknown.join(", ")}`,
		);
	if (outputStamp !== after)
		notes.push("WARNING: shared .output/ changed during the build");
	if (r.code !== 0)
		notes.push(tail(`${r.err}\n${r.out}`.replace(/\x1b\[[0-9;]*m/g, ""), 800));
	const assetsDir = path.join(outDir, "public", "assets");
	if (fs.existsSync(assetsDir)) {
		const assets = fs
			.readdirSync(assetsDir)
			.filter((f) => /\.(js|css)$/.test(f))
			.map((f) => {
				const buf = fs.readFileSync(path.join(assetsDir, f));
				return {
					file: f,
					bytes: buf.length,
					gzipBytes: zlib.gzipSync(buf, { level: 9 }).length,
				};
			})
			.sort((a, b) => b.bytes - a.bytes);
		res.assets = assets;
		res.totalJsBytes = assets
			.filter((a) => a.file.endsWith(".js"))
			.reduce((s, a) => s + a.bytes, 0);
		res.totalJsGzip = assets
			.filter((a) => a.file.endsWith(".js"))
			.reduce((s, a) => s + a.gzipBytes, 0);
		res.totalCssBytes = assets
			.filter((a) => a.file.endsWith(".css"))
			.reduce((s, a) => s + a.bytes, 0);
		// photos are copied into the build's public dir; drop them to save disk
		fs.rmSync(path.join(outDir, "public", "photos"), {
			recursive: true,
			force: true,
		});
	}
	if (notes.length) res.note = notes.join("\n");
	return res;
}

const EVAL_REPORT = path.join(ROOT, "out", "eval", "report.json");
const mtimeOf = (p) => {
	try {
		return fs.statSync(p).mtimeMs;
	} catch {
		return null;
	}
};
/** Labels for 0f's CPU variants, keyed by the out/eval-<key>/ directory (classic-<solver>[-fasth][-<dem>]: SOLVER=<solver> [HORIZON=fast] [DEM=<dem>]). */
const CPU_VARIANTS = {
	"classic-cascade": [
		"CPU classic+cascade (0f recommended default)",
		"detectSkyline → solvePose → on reject refinePose; what /baseline Auto-align runs (SOLVER=cascade)",
	],
	"classic-skyfirst": [
		"CPU classic+skyfirst (0f high-accuracy mode)",
		"refine with ONNX sky cross-check, else cascade; always loads the 4.5 MB sky model (SOLVER=skyfirst)",
	],
	"classic-cascade-fasth": [
		"CPU classic+cascade, HORIZON=fast",
		"the cascade on d1's horizon-fast horizon (what the browser runs)",
	],
	"classic-solve": [
		"CPU classic+solve",
		"classic skyline, simple solvePose core only",
	],
	"classic-solve-fasth": [
		"CPU classic+solve, HORIZON=fast",
		"simple solvePose core on the horizon-fast horizon",
	],
};
export function cpuVariantInfo(key) {
	if (CPU_VARIANTS[key]) return CPU_VARIANTS[key];
	const m = key.match(/^([a-z]+)-([a-z0-9]+?)(-fasth)?$/);
	return m
		? [
				`CPU ${m[1]}+${m[2]}${m[3] ? ", HORIZON=fast" : ""}`,
				`0f variant out/eval-${key}/`,
			]
		: [`CPU ${key}`, `0f variant out/eval-${key}/`];
}
/**
 * 0f's CPU pipeline results, READ-ONLY: out/eval/report.json (0f's last default run → methods cpu / cpu-final)
 * and every out/eval-<variant>/report.json (→ method cpu:<variant>, final pose). Each file is read with retries
 * (a report with fewer rows than photos.json is treated as mid-rewrite). --run-evalcpu re-runs eval.ts over the
 * full set first (rewrites 0f's out/eval/ only); it refuses --photos.
 */
async function stepEvalCpu(scale, runIt, nExpected) {
	const t0 = Date.now();
	const res = {
		status: "ok",
		ms: 0,
		reportPath: "out/eval/report.json",
		ran: !!runIt,
		reports: [],
	};
	const notes = [];
	if (runIt) {
		const before = mtimeOf(EVAL_REPORT);
		const r = await run("npx", ["tsx", "scripts/eval.ts"], {
			timeoutMs: 600000 * scale,
		});
		const after = mtimeOf(EVAL_REPORT);
		if (r.timedOut || r.code !== 0) {
			res.status = r.timedOut ? "timeout" : "fail";
			notes.push(`eval.ts ${res.status}: ${tail(r.err || r.out, 300)}`);
		}
		if (after == null || after === before || res.status !== "ok")
			res.reportStale = true;
	} else
		notes.push(
			"read-only: 0f's out/eval*/report.json as last written (pass --run-evalcpu to regenerate out/eval/)",
		);
	const dirs = fs
		.readdirSync(path.join(ROOT, "out"), { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^eval(-[a-z0-9-]+)?$/.test(d.name))
		.map((d) => d.name)
		.sort();
	const validate = (j) =>
		!Array.isArray(j)
			? "not an array"
			: j.length < nExpected
				? `${j.length} rows < ${nExpected} photos`
				: true;
	res._reports = {};
	for (const d of dirs) {
		const file = path.join(ROOT, "out", d, "report.json");
		if (!fs.existsSync(file)) continue;
		const r = await readJsonStable(file, { validate });
		const key = d === "eval" ? "eval" : d.slice(5);
		const entry = {
			dir: `out/${d}`,
			file: `out/${d}/report.json`,
			key,
			rows: Array.isArray(r.json) ? r.json.length : 0,
			mtime: isoOf(r.mtimeMs),
			ageMin: ageMin(r.mtimeMs),
			reads: r.tries,
			...(r.warning ? { warning: r.warning } : {}),
		};
		res.reports.push(entry);
		if (Array.isArray(r.json)) res._reports[key] = { ...entry, report: r.json };
		if (r.warning) notes.push(`${entry.file}: ${r.warning}`);
	}
	// out/eval/ carries no record of its SOLVER; name the variant it matches (same accepts, |Δyaw| sum < 0.5°)
	const base = res._reports.eval?.report;
	if (base)
		for (const [k, v] of Object.entries(res._reports)) {
			if (k === "eval") continue;
			let s = 0;
			let same = true;
			for (const r of base) {
				const o = v.report.find((x) => x.name === r.name);
				if (!o || o.accepted !== r.accepted) same = false;
				else s += Math.abs((o.delta?.yaw ?? 0) - (r.delta?.yaw ?? 0));
			}
			if (same && s < 0.5) (res.evalMatches ??= []).push(k);
		}
	const m = mtimeOf(EVAL_REPORT);
	res.ms = Date.now() - t0;
	res.reportMtime = isoOf(m);
	res.reportAgeMin = ageMin(m);
	res.photos = base?.length ?? 0;
	if (!Object.keys(res._reports).length) {
		if (res.status === "ok") res.status = "error";
		notes.push("no out/eval*/report.json found");
	}
	if (res.reportStale)
		notes.push(
			`report.json was NOT freshly written by this run; the CPU numbers are from ${res.reportMtime}`,
		);
	res.note = notes.join("; ");
	return res;
}

async function stepEvalApp(scale, appUrl, photos) {
	const r = await run("node", ["scripts/eval-app.mjs", ...photos], {
		timeoutMs: 400000 * scale,
		env: { APP_URL: appUrl },
	});
	const rows = [];
	for (const l of r.out.split("\n")) {
		const m = l.trim().split(/\s+/);
		if (!/^IMG_/.test(m[0] ?? "") || m.length < 10) continue;
		const n = (s) => (s === "∞" ? null : Number(s));
		rows.push({
			id: m[0],
			pins: n(m[1]),
			gtResid: n(m[2]),
			priorPx: n(m[3]),
			autoPx: n(m[4]),
			dYawPrior: n(m[5]),
			dYawAuto: n(m[6]),
			dPitchAuto: n(m[7]),
			dRollAuto: n(m[8]),
			gtYawFromPrior: n(m[9]),
		});
	}
	const sum = r.out.match(
		/(\d+\/\d+) within 1° yaw; median auto px error ([\d.∞NaN]+)/,
	);
	return {
		status: r.timedOut ? "timeout" : r.code === 0 ? "ok" : "fail",
		ms: r.ms,
		rows,
		within1: sum?.[1] ?? null,
		medianAutoPx: sum ? Number(sum[2]) : null,
		...(r.code !== 0 || r.timedOut ? { note: tail(r.err || r.out) } : {}),
	};
}

const EXT_INFO = {
	refine: [
		"d1 refine",
		"d1 src/lib/refine: robust skyline refinement from the prior (out/refine/results.json, method 'refine')",
	],
	"refine+sky": [
		"d1 refine+sky",
		"d1 src/lib/refine with the ONNX sky mask (out/refine/results.json, method 'refine+sky')",
	],
	"matcher:render-match": [
		"f0 render-match (ALIKED+LightGlue, sat, rot_fixf)",
		"f0 tools/matcher: satellite-draped DEM renders at prior yaw ±20°, ALIKED+LightGlue, rotation-only solve at the GPS eye (f0's headline config). From tools/matcher/results.json (with f0's confidence / accepted) when present, else re-derived from out/results/<id>_initial.json (then it always 'accepts'); ms = match+solve, rendering excluded",
	],
	"matcher:render-match-it1": [
		"f0 render-match + 1 refinement render",
		"f0 tools/matcher refine stage (it1): one more render at the solved pose, same config. Always 'accepts'",
	],
	"matcher:fusion": [
		"f0 fusion (skyline + render-match)",
		"f0 tools/matcher/results-fusion.json (contract file): joint skyline + render-match refinement (fusion.py), with f0's confidence / accepted",
	],
	"matcher:fused": [
		"f0 fused skyline+match",
		"f0 tools/matcher/fusion.py (fusion_default.json, shift 0): joint skyline + match refinement; accepted = confidence level HIGH (agreement / sky / support gates)",
	],
};
/**
 * External per-photo results, all re-scored here against the GT snapshot (their own err fields are ignored):
 *   out/<track>/results.json, out/lead/<track>/results.json: rows may carry `method` (out/refine/results.json has
 *     'refine' and 'refine+sky'): each becomes its own method (<method> if it starts with the track name, else
 *     <track>:<method>). Read with retries: a method with fewer rows than photos is treated as mid-rewrite.
 *   tools/matcher/results*.json (contract shape) → matcher:<method|suffix>
 *   tools/matcher/out/results/<id>_initial.json / _refine.json → matcher:render-match / render-match-it1
 *     (configs["aliked:sat"].rot_fixf.pose, f0's headline config), fusion_default.json (shift 0) → matcher:fused
 *   --results a.json,b.json → <file stem>[:<method>]
 * When no raw matcher poses exist, the summary lines of tools/matcher/out/report_tables.md are kept as
 * "from report, not re-scored" (they are parsed either way, as a cross-check of the re-scoring).
 */
async function stepMatcher(extra, ids) {
	const methods = {};
	const files = [];
	const warn = [];
	const add = (key, id, row, file, mtimeMs) => {
		const m = (methods[key] ??= { rows: {}, files: new Set(), mtimeMs: 0 });
		m.rows[id] = row;
		m.files.add(file);
		m.mtimeMs = Math.max(m.mtimeMs, mtimeMs ?? 0);
	};
	const rowOf = (r) => {
		const vfov = Number.isFinite(r.vfov)
			? r.vfov
			: Number.isFinite(r.f) && r.height
				? vfovFromF(r.f, r.height)
				: null;
		return {
			pose: { yaw: r.yaw, pitch: r.pitch ?? 0, roll: r.roll ?? 0, vfov },
			confidence: r.confidence ?? null,
			accepted: r.accepted ?? null,
			ms: r.ms ?? null,
		};
	};
	// 1) contract-shaped files
	const sources = [];
	const mdir = path.join(ROOT, "tools", "matcher");
	if (fs.existsSync(mdir))
		for (const f of fs
			.readdirSync(mdir)
			.filter((f) => /^results.*\.json$/.test(f)))
			sources.push({
				file: path.join(mdir, f),
				prefix: "matcher",
				fallback: f.replace(/^results[-_]?|\.json$/g, "") || "default",
			});
	for (const base of [path.join(ROOT, "out"), path.join(ROOT, "out", "lead")]) {
		let dirs = [];
		try {
			dirs = fs
				.readdirSync(base, { withFileTypes: true })
				.filter(
					(d) =>
						d.isDirectory() && d.name !== "leaderboard" && d.name !== "lead",
				);
		} catch {}
		for (const d of dirs) {
			const f = path.join(base, d.name, "results.json");
			if (fs.existsSync(f))
				sources.push({ file: f, prefix: d.name, fallback: null });
		}
	}
	for (const e of extra)
		sources.push({
			file: path.resolve(ROOT, e),
			prefix: path.basename(e).replace(/\.json$/, ""),
			fallback: null,
		});
	const listOf = (j) =>
		Array.isArray(j)
			? j
			: Array.isArray(j?.results)
				? j.results
				: Object.entries(j?.results ?? j?.photos ?? {}).map(([id, v]) => ({
						id,
						...v,
					}));
	for (const src of sources) {
		const rel = path.relative(ROOT, src.file);
		const validate = (j) => {
			const list = listOf(j);
			const by = {};
			for (const r of list)
				if (r && Number.isFinite(r.yaw))
					by[r.method ?? "_"] = (by[r.method ?? "_"] ?? 0) + 1;
			const short = Object.entries(by).filter(([, n]) => n < ids.length);
			// parseable but not in the contract shape (e.g. an experiment's own schema) is not "mid-rewrite": no retry
			return !Object.keys(by).length
				? true
				: short.length
					? `${short.map(([k, n]) => `${k} ${n}`).join(", ")} rows < ${ids.length} photos`
					: true;
		};
		const r = await readJsonStable(src.file, { validate });
		if (!r.json) {
			files.push({ file: rel, error: r.warning ?? "missing or unparseable" });
			continue;
		}
		if (r.warning) warn.push(`${rel}: ${r.warning}`);
		const fileMethod =
			(!Array.isArray(r.json) && r.json.method) || src.fallback;
		const counts = {};
		for (const row of listOf(r.json)) {
			const id = row.id ?? row.name ?? row.photo;
			if (!id || !Number.isFinite(row.yaw)) continue;
			const sub = row.method ?? fileMethod;
			const key = !sub
				? src.prefix
				: sub.startsWith(src.prefix)
					? sub
					: `${src.prefix}:${sub}`;
			add(key, id, rowOf(row), rel, r.mtimeMs);
			counts[key] = (counts[key] ?? 0) + 1;
		}
		if (!Object.keys(counts).length) {
			files.push({
				file: rel,
				mtime: isoOf(r.mtimeMs),
				ageMin: ageMin(r.mtimeMs),
				skipped:
					"no rows with id + absolute yaw (not the results contract shape)",
			});
			continue;
		}
		files.push({
			file: rel,
			methods: counts,
			mtime: isoOf(r.mtimeMs),
			ageMin: ageMin(r.mtimeMs),
			reads: r.tries,
			...(r.warning ? { warning: r.warning } : {}),
		});
	}
	// 2) f0's raw matcher outputs (python JSON: NaN/Infinity tolerated)
	const rdir = path.join(ROOT, "tools", "matcher", "out", "results");
	if (fs.existsSync(rdir)) {
		for (const [suffix, key] of [
			["initial", "matcher:render-match"],
			["refine", "matcher:render-match-it1"],
		]) {
			// f0's contract file (tools/matcher/results*.json) wins: it carries confidence / accepted
			if (methods[key]) {
				files.push({
					file: `${path.relative(ROOT, rdir)}/<id>_${suffix}.json`,
					skipped: `superseded by the contract file for ${key} (${[...methods[key].files].join(", ")})`,
				});
				continue;
			}
			let n = 0;
			let newest = 0;
			for (const id of ids) {
				const f = path.join(rdir, `${id}_${suffix}.json`);
				if (!fs.existsSync(f)) continue;
				const r = await readJsonStable(f, {
					validate: (j) => (j?.configs ? true : "no configs"),
				});
				const c = r.json?.configs?.["aliked:sat"];
				const sol = c?.rot_fixf;
				if (!sol?.pose || !Number.isFinite(sol.pose.yaw)) continue;
				const ms = Number.isFinite(c.matchSec)
					? Math.round((c.matchSec + (sol.sec ?? 0)) * 1000)
					: null;
				add(
					key,
					id,
					{
						pose: { ...sol.pose },
						confidence: null,
						accepted: null,
						ms,
						inliers: sol.inliers ?? null,
					},
					path.relative(ROOT, rdir) + `/*_${suffix}.json`,
					r.mtimeMs,
				);
				n++;
				newest = Math.max(newest, r.mtimeMs ?? 0);
			}
			if (n)
				files.push({
					file: `${path.relative(ROOT, rdir)}/<id>_${suffix}.json`,
					methods: { [key]: n },
					mtime: isoOf(newest),
					ageMin: ageMin(newest),
				});
		}
		const ff = path.join(rdir, "fusion_default.json");
		const fusionContract = ["matcher:fusion", "matcher:fused"].find(
			(k) => methods[k],
		);
		if (fs.existsSync(ff) && fusionContract)
			files.push({
				file: path.relative(ROOT, ff),
				skipped: `superseded by the contract file for ${fusionContract} (${[...methods[fusionContract].files].join(", ")})`,
			});
		else if (fs.existsSync(ff)) {
			const r = await readJsonStable(ff, {
				validate: (j) =>
					!Array.isArray(j)
						? "not an array"
						: j.filter((x) => x.shift === 0).length < ids.length
							? `${j.filter((x) => x.shift === 0).length} shift-0 rows < ${ids.length} photos`
							: true,
			});
			if (r.warning) warn.push(`fusion_default.json: ${r.warning}`);
			let n = 0;
			for (const row of Array.isArray(r.json) ? r.json : []) {
				if (
					row.shift !== 0 ||
					!row.fused?.pose ||
					!Number.isFinite(row.fused.pose.yaw)
				)
					continue;
				const lvl = row.confidence?.level ?? null;
				const rm = methods["matcher:render-match"]?.rows?.[row.id]?.ms;
				add(
					"matcher:fused",
					row.id,
					{
						pose: { ...row.fused.pose },
						confidence: lvl === "HIGH" ? 1 : lvl === "LOW" ? 0 : null,
						accepted: lvl ? lvl === "HIGH" : null,
						ms: Number.isFinite(row.sec)
							? Math.round(row.sec * 1000 + (rm ?? 0))
							: null,
						level: lvl,
						dAgree: row.confidence?.d_agree ?? null,
					},
					path.relative(ROOT, ff),
					r.mtimeMs,
				);
				n++;
			}
			files.push({
				file: path.relative(ROOT, ff),
				methods: { "matcher:fused": n },
				mtime: isoOf(r.mtimeMs),
				ageMin: ageMin(r.mtimeMs),
				reads: r.tries,
				...(r.warning ? { warning: r.warning } : {}),
			});
		}
	}
	// 3) f0's own summary lines (cross-check, or the only numbers when no raw poses exist)
	const reported = [];
	const tf = path.join(ROOT, "tools", "matcher", "out", "report_tables.md");
	if (fs.existsSync(tf)) {
		const txt = fs.readFileSync(tf, "utf8");
		for (const m of txt.matchAll(
			/^- ([^:\n]+): n=(\d+), median \|Δyaw\| ([\d.]+)°, \|Δpitch\| ([\d.]+)°, \|Δroll\| ([\d.]+)°, median pin ([\d.]+)px, within 1° yaw (\d+)\/(\d+)/gm,
		))
			reported.push({
				source: path.relative(ROOT, tf),
				method: m[1].trim(),
				n: +m[2],
				medianAbsYaw: +m[3],
				medianAbsPitch: +m[4],
				medianAbsRoll: +m[5],
				medianPinPx: +m[6],
				within1: +m[7],
				of: +m[8],
				gt: "f0's in-page control-point solve (engine.solvePins)",
				mtime: isoOf(mtimeOf(tf)),
			});
	}
	const hasRaw = Object.keys(methods).some((k) => k.startsWith("matcher:"));
	const out = {};
	for (const [k, v] of Object.entries(methods))
		out[k] = {
			rows: v.rows,
			file: [...v.files].join(", "),
			mtime: isoOf(v.mtimeMs),
			mtimeMs: v.mtimeMs,
		};
	return {
		status: files.length || reported.length ? "ok" : "skipped",
		ms: 0,
		files,
		reported,
		reportedOnly: !hasRaw && reported.length > 0,
		note:
			[
				files.length ? null : "no external results files yet",
				!hasRaw && reported.length
					? "matcher numbers are from tools/matcher/out/report_tables.md, not re-scored"
					: null,
				...warn,
			]
				.filter(Boolean)
				.join("; ") || undefined,
		_methods: out,
	};
}

async function launchBrowser(chromium) {
	const args = ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"];
	try {
		return await chromium.launch({ headless: true, args });
	} catch {
		return chromium.launch({ headless: true, args, channel: "chrome" });
	}
}

/**
 * Counts every HTTP response a page receives, cross-origin included, via the Chrome DevTools protocol
 * (PerformanceResourceTiming.transferSize is 0 for cross-origin responses without Timing-Allow-Origin,
 * i.e. the Mapterhorn DEM tiles and the MediaPipe model). encodedDataLength = bytes on the wire
 * (headers + compressed body); a response is "cached" when served from the HTTP disk/memory cache,
 * prefetch cache or a service worker.
 */
async function netTracker(page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Network.enable");
	let reqs = new Map();
	const get = (id) => {
		let r = reqs.get(id);
		if (!r)
			reqs.set(
				id,
				(r = { url: "", bytes: 0, cached: false, done: false, failed: false }),
			);
		return r;
	};
	let documents = 0;
	cdp.on("Network.requestWillBeSent", (e) => {
		get(e.requestId).url = e.request.url;
		if (e.type === "Document" && !e.redirectResponse) documents++;
	});
	cdp.on("Network.requestServedFromCache", (e) => {
		get(e.requestId).cached = true;
	});
	cdp.on("Network.responseReceived", (e) => {
		const r = get(e.requestId);
		r.url ||= e.response.url;
		r.status = e.response.status;
		if (
			e.response.fromDiskCache ||
			e.response.fromPrefetchCache ||
			e.response.fromServiceWorker
		)
			r.cached = true;
	});
	cdp.on("Network.loadingFinished", (e) => {
		const r = get(e.requestId);
		r.bytes = e.encodedDataLength ?? 0;
		r.done = true;
	});
	cdp.on("Network.loadingFailed", (e) => {
		get(e.requestId).failed = true;
	});
	return {
		reset() {
			reqs = new Map();
			documents = 0;
		},
		summary() {
			const byOrigin = {};
			let bytes = 0;
			let n = 0;
			let cached = 0;
			let pending = 0;
			for (const r of reqs.values()) {
				if (!/^https?:/.test(r.url)) continue;
				const o = new URL(r.url).origin;
				const b = (byOrigin[o] ??= { requests: 0, cached: 0, networkKiB: 0 });
				b.requests++;
				n++;
				if (r.cached) {
					b.cached++;
					cached++;
				}
				if (!r.done && !r.failed) pending++;
				// bytes from cache hits are ~0 (or a 304's headers); count what actually crossed the wire
				b.networkKiB += r.bytes / 1024;
				bytes += r.bytes;
			}
			for (const b of Object.values(byOrigin))
				b.networkKiB = Math.round(b.networkKiB);
			return {
				requests: n,
				cachedRequests: cached,
				pendingAtReady: pending,
				networkKiB: Math.round(bytes / 1024),
				byOrigin,
				documents,
			};
		},
		async close() {
			await cdp.detach().catch(() => {});
		},
	};
}

/** Loads /photo/<id> in `ctx`; resolves time to [data-ready] (ms since navigation start) or throws. */
async function loadPhoto(
	ctx,
	appUrl,
	id,
	timeoutMs,
	reload = false,
	existing = null,
	net = null,
) {
	const page =
		existing ?? (await ctx.newPage({ viewport: { width: 1400, height: 900 } }));
	const pageErrors = [];
	const onErr = (e) => pageErrors.push(String(e.message).slice(0, 200));
	page.on("pageerror", onErr);
	if (!existing)
		await page.addInitScript(() => {
			localStorage.clear();
			// default buffer is 250 entries; tiles alone exceed that
			performance.setResourceTimingBufferSize(100000);
		});
	if (reload) await page.reload({ waitUntil: "commit" });
	else
		await page.goto(`${appUrl}/photo/${id}`, {
			waitUntil: "commit",
			timeout: timeoutMs,
		});
	await page.waitForSelector("[data-ready]", {
		state: "attached",
		timeout: timeoutMs,
	});
	const t = await page.evaluate(() => {
		const nav = performance.getEntriesByType("navigation")[0];
		const res = performance.getEntriesByType("resource");
		return {
			readyMs: performance.now(),
			loadMs: nav?.loadEventEnd || null,
			// responseEnd is exposed cross-origin even without Timing-Allow-Origin; transferSize is not
			lastResponseMs: res.reduce((m, r) => Math.max(m, r.responseEnd || 0), 0),
			sameOriginTransfer: res.reduce((s, r) => s + (r.transferSize || 0), 0),
		};
	});
	page.off("pageerror", onErr);
	const n = net?.summary() ?? null;
	return {
		page,
		readyMs: Math.round(t.readyMs),
		loadMs: t.loadMs ? Math.round(t.loadMs) : null,
		pageErrors: pageErrors.length,
		lastResponseMs: Math.round(t.lastResponseMs),
		...(n
			? {
					requests: n.requests,
					cachedRequests: n.cachedRequests,
					pendingAtReady: n.pendingAtReady,
					transferKiB: n.networkKiB,
					byOrigin: n.byOrigin,
					documents: n.documents,
					bytesMeasured: "cdp",
				}
			: {
					transferKiB: null,
					sameOriginTransferKiB: Math.round(t.sameOriginTransfer / 1024),
					bytesMeasured: "resource-timing (cross-origin bytes unmeasured)",
				}),
	};
}

async function stepApp(scale, appUrl, ids, ctxFor, concurrency) {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch (e) {
		return {
			status: "error",
			ms: 0,
			note: `playwright unavailable: ${e.message}`,
		};
	}
	const t0 = Date.now();
	try {
		const ping = await fetch(appUrl, { signal: AbortSignal.timeout(10000) });
		if (!ping.ok && ping.status >= 500) throw new Error(`HTTP ${ping.status}`);
	} catch (e) {
		return {
			status: "error",
			ms: Date.now() - t0,
			note: `dev server not reachable at ${appUrl}: ${e.message}`,
		};
	}
	const browser = await launchBrowser(chromium);
	const results = {};
	const failures = [];
	const queue = [...ids];
	const worker = async () => {
		while (queue.length) {
			const id = queue.shift();
			const ctx = await browser.newContext();
			try {
				const { page, readyMs, pageErrors } = await loadPhoto(
					ctx,
					appUrl,
					id,
					180000 * scale,
				);
				const r = await page.evaluate(
					({ cp, poses, D0 }) => {
						const e = window.__engine;
						if (!e)
							return {
								error: "window.__engine missing (needs a DEV build of the app)",
							};
						const out = {
							prior: { ...e.prior },
							final: { ...e.pose },
							aspect: e.aspect,
						};
						if (typeof e.autoAlign === "function") {
							const t0 = performance.now();
							const res = e.autoAlign(true);
							out.alignMs = performance.now() - t0;
							out.align = res
								? {
										pose: res.pose,
										score: res.score,
										confidence: res.confidence,
										nAlt: res.alternatives?.length ?? 0,
										alts: (res.alternatives ?? []).map((a) => ({ ...a.pose })),
									}
								: null;
						}
						if (cp && typeof e.controlPins === "function") {
							const pins = e.controlPins(cp);
							out.cp = {
								labelled: cp.points.length,
								pins: pins.length,
								px: {},
							};
							if (pins.length >= 2) {
								const gt = e.solvePins(pins, e.prior, cp.solveFocal !== false);
								out.cp.pose = {
									yaw: gt.yaw,
									pitch: gt.pitch,
									roll: gt.roll,
									vfov: gt.vfov,
								};
								out.cp.residPx = e.pinError(gt, pins, D0).mean;
								const all = { ...poses, prior: e.prior, app: e.pose };
								if (out.align) all["app-raw"] = out.align.pose;
								for (const [k, p] of Object.entries(all))
									if (p && Number.isFinite(p.vfov))
										out.cp.px[k] = e.pinError(p, pins, D0).mean;
							}
						}
						return out;
					},
					{ cp: ctxFor[id].cp, poses: ctxFor[id].poses, D0: 1600 },
				);
				if (r.error) throw new Error(r.error);
				results[id] = { ...r, readyMs, pageErrors };
				log(
					`app ${id}: ready ${readyMs} ms, conf ${r.align?.confidence?.toFixed(2)}, align ${r.alignMs?.toFixed(0)} ms${r.cp?.pose ? `, cp gt resid ${r.cp.residPx.toFixed(1)} px` : ""}`,
				);
			} catch (e) {
				failures.push({
					id,
					error: String(e.message).split("\n")[0].slice(0, 300),
				});
				log(`app ${id}: FAILED ${failures.at(-1).error}`);
			} finally {
				await ctx.close().catch(() => {});
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
	await browser.close();
	return {
		status:
			failures.length === ids.length
				? "fail"
				: failures.length
					? "partial"
					: "ok",
		ms: Date.now() - t0,
		photos: Object.keys(results).length,
		failures,
		concurrency,
		note: "ready times here are under concurrent load; use the perf step for clean timings. app 'accepted' mirrors PhotoWorkspace (confidence > 0.2).",
		raw: results,
	};
}

async function stepPerf(scale, appUrl, ids) {
	let chromium;
	try {
		({ chromium } = await import("playwright"));
	} catch (e) {
		return {
			status: "error",
			ms: 0,
			note: `playwright unavailable: ${e.message}`,
		};
	}
	const t0 = Date.now();
	const runs = [];
	for (const id of ids) {
		// A fresh on-disk profile per photo: Playwright's ephemeral contexts keep the HTTP cache in memory and
		// drop large entries (the 16 MB segmentation model, many DEM tiles), which would make "warm" look
		// like a second cold load. A persistent profile behaves like a real browser's disk cache.
		const profile = fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-perf-"));
		const row = { id, cold: null, warm: null };
		let net = null;
		let ctx = null;
		try {
			const opts = {
				headless: true,
				args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu"],
				viewport: { width: 1400, height: 900 },
			};
			ctx = await chromium
				.launchPersistentContext(profile, opts)
				.catch(() =>
					chromium.launchPersistentContext(profile, {
						...opts,
						channel: "chrome",
					}),
				);
			const page = ctx.pages()[0] ?? (await ctx.newPage());
			await page.addInitScript(() => {
				localStorage.clear();
				performance.setResourceTimingBufferSize(100000);
			});
			net = await netTracker(page).catch(() => null);
			const pick = ({ page: _p, ...r }) => r;
			row.cold = pick(
				await loadPhoto(ctx, appUrl, id, 180000 * scale, false, page, net),
			);
			net?.reset();
			row.warm = pick(
				await loadPhoto(ctx, appUrl, id, 180000 * scale, true, page, net),
			);
			for (const k of ["cold", "warm"])
				if (row[k].documents > 1) row[k].reloadedDuringLoad = true;
			log(
				`perf ${id}: cold ${row.cold.readyMs} ms / ${row.cold.transferKiB} KiB, warm ${row.warm.readyMs} ms / ${row.warm.transferKiB} KiB (${row.warm.cachedRequests}/${row.warm.requests} cached)`,
			);
		} catch (e) {
			row.error = String(e.message).split("\n")[0].slice(0, 300);
			log(`perf ${id}: FAILED ${row.error}`);
		}
		await net?.close();
		await ctx?.close().catch(() => {});
		fs.rmSync(profile, { recursive: true, force: true });
		runs.push(row);
	}
	const failed = runs.filter((r) => r.error).map((r) => r.id);
	const cold = runs.map((r) => r.cold?.readyMs).filter(Number.isFinite);
	const warm = runs.map((r) => r.warm?.readyMs).filter(Number.isFinite);
	return {
		status:
			failed.length === runs.length ? "fail" : failed.length ? "partial" : "ok",
		ms: Date.now() - t0,
		runs,
		failed,
		medianColdMs: median(cold),
		medianWarmMs: median(warm),
		nCold: cold.length,
		nWarm: warm.length,
		note: "cold = fresh on-disk browser profile (empty HTTP cache/storage; the Vite dev server's own transform cache may be warm); warm = reload in the same profile. Sequential, one page at a time. Bytes = on-the-wire bytes of every response, cross-origin included (Chrome DevTools protocol). A load with >1 document request was reloaded mid-measurement (e.g. dev-server HMR) and is flagged.",
	};
}

// ─────────────────────────────── merge + aggregate ───────────────────────────────
const METHOD_INFO = {
	prior: [
		"Prior (compass + gravity)",
		"EXIF heading, Apple gravity pitch/roll, f35 focal: the baseline to beat",
	],
	app: [
		"App GPU aligner (final)",
		"9e src/lib/align.ts via the app: the pose the UI shows after load (conf > 0.2 → aligned, else near-compass alt or prior)",
	],
	"app-raw": [
		"App GPU aligner (raw)",
		"engine.autoAlign(true) best pose, whatever its confidence",
	],
	cpu: [
		"CPU skyline solver (raw)",
		"0f scripts/eval.ts: detectSkyline + solvePose, always the solved pose",
	],
	"cpu-final": [
		"CPU skyline solver (final)",
		"0f: solved if accepted, else prior (what the baseline pipeline would show)",
	],
};

/**
 * Control-point kinds (0f): az+el = DEM notch direction; el only (+ level) = lake waterline level constraint;
 * peak "node/<osm id>" = OSM node by id; other peak = OSM name. usable = what engine.controlPins can resolve.
 */
export function cpKinds(points) {
	const k = { notches: 0, levels: 0, nodes: 0, named: 0 };
	for (const pt of points) {
		if (pt.peak) k[/^node\/\d+$/.test(pt.peak) ? "nodes" : "named"]++;
		else if (pt.az != null && pt.el != null) k.notches++;
		else if (pt.el != null) k.levels++;
	}
	return { ...k, usable: k.notches + k.named };
}
/** Absolute pose of a 0f report row: photos.json prior + delta (focal ratio → vfov). */
export function cpuSolvedPose(prior, c) {
	const k = c.delta?.focal ?? 1;
	return {
		yaw: prior.yaw + c.delta.yaw,
		pitch: prior.pitch + c.delta.pitch,
		roll: prior.roll + c.delta.roll,
		vfov: (2 * Math.atan(Math.tan((prior.vfov * D) / 2) / k)) / D,
	};
}
function buildPhotos({
	photosMeta,
	ids,
	gtJson,
	cpAll,
	cpuReports,
	matcherMethods,
	appResults,
}) {
	const cpuBy = Object.fromEntries(
		Object.entries(cpuReports ?? {}).map(([k, v]) => [
			k,
			Object.fromEntries(v.report.map((r) => [r.name, r])),
		]),
	);
	const photos = [];
	for (const id of ids) {
		const meta = photosMeta[id];
		const aspect = meta ? meta.width / meta.height : 4 / 3;
		const prior = meta
			? {
					yaw: meta.heading ?? 0,
					pitch: meta.pitch ?? 0,
					roll: meta.roll ?? 0,
					vfov: meta.vfov,
				}
			: null;
		const g = gtJson[id];
		const gj =
			g && g.quality !== "none" && Number.isFinite(g.yaw)
				? {
						quality: g.quality,
						pose: {
							yaw: g.yaw,
							pitch: g.pitch,
							roll: g.roll,
							vfov: vfovFromF(g.f, g.height),
						},
						rmsPx1600: g.rmsPx1600 ?? null,
					}
				: null;
		const app = appResults?.[id];
		const kinds = cpAll[id]?.points ? cpKinds(cpAll[id].points) : null;
		const gc = app?.cp
			? {
					labelled: app.cp.labelled,
					pins: app.cp.pins,
					kinds,
					pose: app.cp.pose ?? null,
					residPx: round(app.cp.residPx, 1),
				}
			: cpAll[id]
				? {
						labelled: cpAll[id].points?.length ?? 0,
						pins: null,
						kinds,
						pose: null,
						residPx: null,
					}
				: null;
		const methods = {};
		if (prior)
			methods.prior = { pose: prior, confidence: null, accepted: null, ms: 0 };
		if (app) {
			const conf = app.align?.confidence ?? null;
			methods.app = {
				pose: app.final,
				confidence: conf,
				accepted: conf == null ? null : conf > 0.2,
				ms: round(app.alignMs, 0),
			};
			if (app.align) {
				// PhotoWorkspace's fallback when confidence ≤ threshold: the first ranked alternative within 4° yaw
				// and 1.5° pitch of the engine prior (same raw, unwrapped comparison as the app), else the prior.
				const ep = app.prior ?? prior;
				const near = (app.align.alts ?? []).find(
					(a) =>
						Math.abs(a.yaw - ep.yaw) < 4 && Math.abs(a.pitch - ep.pitch) < 1.5,
				);
				methods.app._sim = {
					best: app.align.pose,
					fallback: near ?? ep,
					fallbackKind: near ? "near-compass alternative" : "prior",
				};
			}
			if (app.align)
				methods["app-raw"] = {
					pose: app.align.pose,
					confidence: conf,
					accepted: conf > 0.2,
					ms: round(app.alignMs, 0),
				};
		}
		for (const [key, by] of Object.entries(cpuBy)) {
			const c = by[id];
			if (!c?.delta || !prior) continue;
			const solved = cpuSolvedPose(prior, c);
			const ms = (c.ms?.skyline ?? 0) + (c.ms?.solve ?? 0);
			const extra = {
				residualPx: c.residualPx ?? null,
				search: c.search ?? null,
			};
			const fin = {
				pose: c.accepted ? solved : { ...prior },
				confidence: c.confidence,
				accepted: c.accepted,
				ms,
				note: c.rejectReason,
				...extra,
				_sim: { best: solved, fallback: prior, fallbackKind: "prior" },
			};
			if (key === "eval") {
				methods.cpu = {
					pose: solved,
					confidence: c.confidence,
					accepted: c.accepted,
					ms,
					note: c.rejectReason,
					...extra,
				};
				methods["cpu-final"] = fin;
			} else methods[`cpu:${key}`] = fin;
		}
		for (const [m, { rows }] of Object.entries(matcherMethods ?? {})) {
			const r = rows[id] && { ...rows[id], pose: { ...rows[id].pose } };
			if (!r) continue;
			if (!Number.isFinite(r.pose.vfov) && prior) r.pose.vfov = prior.vfov;
			methods[m] = r;
		}
		const primaryGt =
			gj && (gj.quality === "good" || gj.quality === "approx")
				? "json"
				: gc?.pose
					? "cp"
					: gj
						? "json"
						: null;
		for (const [m, v] of Object.entries(methods)) {
			const err = {};
			if (gj) err.json = poseErr(v.pose, gj.pose, aspect);
			if (gc?.pose)
				err.cp = poseErr(v.pose, gc.pose, aspect, app.cp.px?.[m] ?? Number.NaN);
			if (primaryGt) err.primary = err[primaryGt];
			v.err = err;
			if (v._sim) {
				const gp =
					primaryGt === "json" ? gj.pose : primaryGt === "cp" ? gc.pose : null;
				v.sim = {
					fallbackKind: v._sim.fallbackKind,
					fallback: Object.fromEntries(
						Object.entries(v._sim.fallback).map(([k, x]) => [k, round(x, 3)]),
					),
					bestYaw: gp ? round(angleDiff(v._sim.best.yaw, gp.yaw), 3) : null,
					fallbackYaw: gp
						? round(angleDiff(v._sim.fallback.yaw, gp.yaw), 3)
						: null,
				};
				delete v._sim;
			}
			v.pose = Object.fromEntries(
				Object.entries(v.pose).map(([k, x]) => [k, round(x, 3)]),
			);
		}
		const gtAgreement =
			gj && gc?.pose
				? {
						yaw: round(angleDiff(gj.pose.yaw, gc.pose.yaw), 3),
						pitch: round(gj.pose.pitch - gc.pose.pitch, 3),
						roll: round(gj.pose.roll - gc.pose.roll, 3),
						pinPx: round(app.cp.px?.gtJson, 1),
					}
				: null;
		photos.push({
			id,
			width: meta?.width ?? null,
			height: meta?.height ?? null,
			gtJson: gj,
			gtCp: gc,
			gtAgreement,
			primaryGt,
			ready: app ? { ms: app.readyMs } : null,
			methods,
		});
	}
	return photos;
}

/**
 * GT-uncertainty band (°) around the 1° decision line for one photo's GT. 'approx' ground-truth.json poses
 * (and the in-page control-point solve) are only good to ~0.2–0.4° yaw; some notes say ±1° (IMG_7059, IMG_7130).
 * An error with 1 − band ≤ |yaw| < 1 + band on such a photo is "borderline": the GT cannot say which side of
 * 1° it is on, so it counts as neither a correct nor a false accept (shown separately). 'good' GT has no band.
 */
export const GT_BAND_DEG = 0.3;
export function gtBandOf(p, key = "primary") {
	const src = key === "primary" ? p.primaryGt : key;
	// an explicit per-photo yawUncertaintyDeg in ground-truth.json (0f) widens the band, never narrows it
	if (src === "json")
		return Math.max(
			p.gtJson?.quality === "good" ? 0 : GT_BAND_DEG,
			Number(p.gtJson?.yawUncertaintyDeg) || 0,
		);
	if (src === "cp") return GT_BAND_DEG;
	return 0;
}
/** "ok" (< 1° beyond GT noise), "borderline" (within the photo's GT band of 1°) or "wrong" (≥ 1° beyond it). */
export function classifyErr(absYaw, band) {
	if (absYaw < 1 - band) return "ok";
	if (absYaw < 1 + band)
		return band > 0 ? "borderline" : absYaw < 1 ? "ok" : "wrong";
	return "wrong";
}

function aggregate(photos, method, key) {
	const rows = photos
		.map((p) => ({ id: p.id, band: gtBandOf(p, key), m: p.methods[method] }))
		.filter((r) => r.m?.err?.[key]);
	if (!rows.length) return null;
	const yaw = rows.map((r) => Math.abs(r.m.err[key].yaw));
	const px = rows.map((r) => r.m.err[key].px);
	const s05 = yaw.filter((y) => y < 0.5).length;
	const s1 = yaw.filter((y) => y < 1).length;
	const cls = (r) => classifyErr(Math.abs(r.m.err[key].yaw), r.band);
	const acc = rows.filter((r) => r.m.accepted !== false);
	const tag = (r) => `${r.id} (${round(r.m.err[key].yaw, 2)}°)`;
	return {
		n: rows.length,
		medianAbsYaw: round(median(yaw), 3),
		meanAbsYaw: round(mean(yaw), 3),
		maxAbsYaw: round(maxOf(yaw), 3),
		medianAbsPitch: round(
			median(rows.map((r) => Math.abs(r.m.err[key].pitch))),
			3,
		),
		medianAbsRoll: round(
			median(rows.map((r) => Math.abs(r.m.err[key].roll))),
			3,
		),
		medianPx: round(median(px), 1),
		meanPx: round(mean(px), 1),
		maxPx: round(maxOf(px), 1),
		success05: s05,
		success1: s1,
		rate05: round(s05 / rows.length, 3),
		rate1: round(s1 / rows.length, 3),
		accepted: rows.filter((r) => r.m.accepted).length,
		medianMs: round(median(rows.map((r) => r.m.ms)), 0),
		// decision view (robust to GT noise): a method with no accept/reject signal (accepted null) counts as
		// always accepting. Each error is classified against the photo's GT band (gtBandOf): correctAccepts =
		// accepted & clearly < 1°; falseAccepts = accepted & clearly ≥ 1°; borderlineAccepts = accepted & within
		// the band of 1° (neither). success1Clear = clearly < 1° as shown; over2 = |yaw| > 2° as scored (the shown
		// pose for app / cpu variants).
		acceptsAll: rows.every((r) => r.m.accepted == null),
		correctAccepts: acc.filter((r) => cls(r) === "ok").length,
		falseAccepts: acc.filter((r) => cls(r) === "wrong").length,
		falseAcceptIds: acc.filter((r) => cls(r) === "wrong").map(tag),
		borderlineAccepts: acc.filter((r) => cls(r) === "borderline").length,
		borderlineAcceptIds: acc.filter((r) => cls(r) === "borderline").map(tag),
		success1Clear: rows.filter((r) => cls(r) === "ok").length,
		borderlineShown: rows.filter((r) => cls(r) === "borderline").length,
		borderlineShownIds: rows.filter((r) => cls(r) === "borderline").map(tag),
		over2: rows.filter((r) => Math.abs(r.m.err[key].yaw) > 2).length,
		over2Ids: rows
			.filter((r) => Math.abs(r.m.err[key].yaw) > 2)
			.map((r) => r.id),
	};
}

/**
 * Ranks methods on the decision metrics: fewest false accepts, most correct accepts, fewest > 2° errors, most
 * clearly within 1°. Accept/success counts exclude errors inside the photo's GT band around 1° (gtBandOf:
 * ±0.3° on 'approx' GT), so GT noise alone cannot flip a photo between "correct" and "false"; those photos are
 * reported as borderline instead. Median |yaw| is shown but
 * never used to rank (sub-0.3° differences are inside GT noise); ties share a rank. Methods with results for
 * < 80% of the GT photos are listed as incomplete. prior / raw variants are excluded.
 */
export function rankMethods(methods, nGt, exclude = []) {
	const skip = new Set(["prior", "app-raw", "cpu", ...exclude]);
	const need = Math.max(3, Math.ceil(nGt * 0.8));
	const rows = [];
	const incomplete = [];
	for (const [k, m] of Object.entries(methods)) {
		const a = m.agg?.primary;
		if (skip.has(k) || !a) continue;
		if (a.n < need) {
			incomplete.push({ method: k, n: a.n });
			continue;
		}
		rows.push({
			method: k,
			n: a.n,
			correctAccepts: a.correctAccepts,
			falseAccepts: a.falseAccepts,
			borderlineAccepts: a.borderlineAccepts ?? 0,
			over2: a.over2,
			success1: a.success1,
			success1Clear: a.success1Clear ?? a.success1,
			medianAbsYaw: a.medianAbsYaw,
			medianMsAll: m.medianMsAll ?? null,
		});
	}
	// counts as fractions of each method's own n (n can differ by a photo when a source skipped one)
	const keyOf = (r) => [
		r.falseAccepts / r.n,
		-r.correctAccepts / r.n,
		r.over2 / r.n,
		-r.success1Clear / r.n,
	];
	rows.sort((x, y) => {
		const a = keyOf(x);
		const b = keyOf(y);
		for (let i = 0; i < a.length; i++)
			if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] - b[i];
		return (x.medianMsAll ?? 1e12) - (y.medianMsAll ?? 1e12);
	});
	let rank = 0;
	rows.forEach((r, i) => {
		const same =
			i > 0 &&
			keyOf(rows[i - 1]).every((v, j) => Math.abs(v - keyOf(r)[j]) < 1e-9);
		if (!same) rank = i + 1;
		r.rank = rank;
	});
	return { need, rows, incomplete };
}

function calibration(photos, method) {
	const rows = photos
		.map((p) => ({ id: p.id, band: gtBandOf(p), m: p.methods[method] }))
		.filter((r) => r.m?.err?.primary && Number.isFinite(r.m.confidence));
	if (!rows.length) return null;
	// ok = < 1° (AUROC / bins); wrong = ≥ 1° beyond the photo's GT band (failure lists: a borderline error is not a
	// failure the GT can confirm)
	const pairs = rows.map((r) => ({
		id: r.id,
		conf: r.m.confidence,
		err: Math.abs(r.m.err.primary.yaw),
		ok: Math.abs(r.m.err.primary.yaw) < 1,
		wrong: classifyErr(Math.abs(r.m.err.primary.yaw), r.band) === "wrong",
		accepted: r.m.accepted,
		sim: r.m.sim,
	}));
	const bins = [
		["<0.3", 0, 0.3],
		["0.3–0.7", 0.3, 0.7],
		["≥0.7", 0.7, 1.01],
	].map(([range, lo, hi]) => {
		const b = pairs.filter((p) => p.conf >= lo && p.conf < hi);
		return {
			range,
			n: b.length,
			medianAbsYaw: round(median(b.map((p) => p.err)), 3),
		};
	});
	return {
		n: pairs.length,
		auroc: round(auroc(pairs), 3),
		spearman: round(
			spearman(
				pairs.map((p) => p.conf),
				pairs.map((p) => p.err),
			),
			3,
		),
		confidentFailures: pairs
			.filter((p) => p.conf >= 0.7 && p.wrong)
			.map(
				(p) =>
					`${p.id} (conf ${p.conf.toFixed(2)}, |yaw| ${p.err.toFixed(2)}°)`,
			),
		rejectedSuccesses: pairs
			.filter((p) => p.accepted === false && p.ok)
			.map((p) => p.id),
		acceptedFailures: pairs
			.filter((p) => p.accepted && p.wrong)
			.map((p) => ({
				id: p.id,
				conf: round(p.conf, 3),
				absYaw: round(p.err, 3),
			})),
		/**
		 * The smallest acceptance bar (confidence > t) that rejects every accepted failure, simulated: each
		 * newly rejected photo gets the method's fallback pose (sim.fallback: the app's near-compass alternative
		 * or prior; cpu-final's prior), and the success count / mean |yaw| are recomputed. Photos already
		 * rejected keep their current pose. Methods without a modelled fallback only report what gets rejected.
		 */
		separatingThreshold: (() => {
			const f = pairs.filter((p) => p.accepted && p.wrong);
			if (!f.length) return null;
			const t = Math.max(...f.map((p) => p.conf));
			const flips = pairs.filter((p) => p.accepted && p.conf <= t);
			const base = {
				above: round(t, 3),
				n: pairs.length,
				rejectsFailures: f.length,
				rejectsSuccesses: flips.filter((p) => p.ok).map((p) => p.id),
			};
			if (!pairs.some((p) => p.sim)) return { ...base, simulated: false };
			const after = pairs.map((p) =>
				p.accepted && p.conf <= t && p.sim?.fallbackYaw != null
					? Math.abs(p.sim.fallbackYaw)
					: p.err,
			);
			return {
				...base,
				simulated: true,
				successesBefore: pairs.filter((p) => p.ok).length,
				successesAfter: after.filter((e) => e < 1).length,
				meanAbsYawBefore: round(mean(pairs.map((p) => p.err)), 3),
				meanAbsYawAfter: round(mean(after), 3),
				changed: flips.map((p) => ({
					id: p.id,
					conf: round(p.conf, 3),
					fromAbsYaw: round(p.err, 3),
					toAbsYaw:
						p.sim?.fallbackYaw != null
							? round(Math.abs(p.sim.fallbackYaw), 3)
							: null,
					fallback: p.sim?.fallbackKind ?? null,
				})),
			};
		})(),
		bins,
	};
}

// ─────────────────────────────── ensemble / oracle ───────────────────────────────
/** The product candidates for an ensemble: cheap skyline aligners, d1's refine+sky, and f0's texture matcher. */
const ENSEMBLE_MEMBERS = [
	["app", "app"],
	["cascade", "cpu:classic-cascade"],
	["refine+sky", "refine+sky"],
	["matcher", "matcher:render-match"],
];
const gtPoseOf = (p) =>
	(p.primaryGt === "json"
		? p.gtJson?.pose
		: p.primaryGt === "cp"
			? p.gtCp?.pose
			: null) ?? null;
const meanPose = (a, b) => ({
	yaw: a.yaw + angleDiff(b.yaw, a.yaw) / 2,
	pitch: (a.pitch + b.pitch) / 2,
	roll: (a.roll + b.roll) / 2,
	vfov: (a.vfov + b.vfov) / 2,
});
/**
 * The pose the user would see from a member: app / CPU rows already hold it (app fallback, CPU prior on reject:
 * they carry sim); a row without a modelled fallback (refine, matcher) that rejected shows the prior.
 */
const shownPoseOf = (p, key) => {
	const m = p.methods[key];
	if (!m?.pose) return null;
	if (m.accepted === false && !m.sim) return p.methods.prior?.pose ?? null;
	return m.pose;
};
/** A member's vote: its pose unless it explicitly rejected the photo (a rejected pose is a fallback, not a vote). */
const voteOf = (p, key) => {
	const m = p.methods[key];
	return m && m.accepted !== false ? m.pose : null;
};

/**
 * (a) "pick the lowest skyline residual among app / cascade / refine+sky" — computed only when every member
 *     reports a comparable px residual on ≥ 80% of photos; otherwise the availability is reported, plus two
 *     stand-ins: the GT oracle (best of the three by true error: an upper bound, not a product) and a GT-free
 *     "highest confidence among accepting members" pick.
 * (b) agreement gates: accept when ≥ 2 members' votes agree within 1° yaw (output = mean of the closest
 *     agreeing pair), else escalate. Reported per pair and for 2-of-3 / 2-of-4, with the escalation rate over all
 *     photos, false accepts over GT photos, and which other method best fixes the escalated GT photos.
 */
export function ensembleAnalysis(photos, methods, ranked) {
	const members = ENSEMBLE_MEMBERS.filter(([, k]) => methods[k]);
	const three = members.filter(([n]) => n !== "matcher");
	const gtPhotos = photos.filter((p) => gtPoseOf(p));
	const errOf = (pose, p) => Math.abs(angleDiff(pose.yaw, gtPoseOf(p).yaw));
	const res = {
		members: Object.fromEntries(members),
		nPhotos: photos.length,
		nGt: gtPhotos.length,
	};
	// (a) residual availability
	const residualOf = (p, k) => {
		const m = p.methods[k];
		return Number.isFinite(m?.residualPx) ? m.residualPx : null;
	};
	const avail = Object.fromEntries(
		three.map(([n, k]) => [
			n,
			photos.filter((p) => residualOf(p, k) != null).length,
		]),
	);
	const canPick =
		three.length >= 2 &&
		three.every(([n]) => avail[n] >= Math.ceil(photos.length * 0.8));
	res.residualPick = {
		available: canPick,
		residualsPerMember: avail,
		note: canPick
			? null
			: "not computable: residuals are not reported comparably (app's autoAlign score is an edge score, not px; cascade's residualPx is null whenever refinePose produced the pose; refine+sky rows carry none)",
	};
	if (canPick) {
		const errs = [];
		for (const p of gtPhotos) {
			const c = three
				.map(([n, k]) => ({
					n,
					k,
					r: residualOf(p, k),
					pose: p.methods[k]?.pose,
				}))
				.filter((x) => x.r != null && x.pose);
			if (!c.length) continue;
			c.sort((x, y) => x.r - y.r);
			errs.push({ id: p.id, by: c[0].n, err: errOf(c[0].pose, p) });
		}
		Object.assign(res.residualPick, summarizeErrs(errs));
	}
	// oracle (upper bound) and confidence pick over the three. The oracle chooses among the poses each member
	// would actually show (its accepted pose, or its fallback / the prior when it rejects), never a pose the member
	// itself rejected.
	{
		const errs = [];
		const conf = [];
		const wins = {};
		const picks = {};
		let confEsc = 0;
		let ties = 0;
		const tieIds = [];
		for (const p of photos) {
			const hasGt = !!gtPoseOf(p);
			const c = three
				.map(([n, k]) => ({ n, m: p.methods[k], shown: shownPoseOf(p, k) }))
				.filter((x) => x.m?.pose);
			if (hasGt && c.length) {
				const best = c
					.filter((x) => x.shown)
					.map((x) => ({
						n:
							x.m.accepted === false
								? `${x.n} (rejected → shown ${x.m.sim ? x.m.sim.fallbackKind : "prior"})`
								: x.n,
						w: x.n,
						e: errOf(x.shown, p),
					}))
					.sort((x, y) => x.e - y.e)[0];
				if (best) {
					errs.push({ id: p.id, by: best.n, err: best.e, band: gtBandOf(p) });
					wins[best.n] = (wins[best.n] ?? 0) + 1;
				}
			}
			const acc = c
				.filter((x) => x.m.accepted !== false)
				.sort((x, y) => (y.m.confidence ?? 0) - (x.m.confidence ?? 0));
			if (!acc.length) {
				confEsc++;
				continue;
			}
			const tied =
				acc.length > 1 &&
				Math.abs((acc[0].m.confidence ?? 0) - (acc[1].m.confidence ?? 0)) <
					1e-9;
			if (tied) {
				ties++;
				tieIds.push(p.id);
			}
			picks[acc[0].n] = (picks[acc[0].n] ?? 0) + 1;
			if (hasGt)
				conf.push({
					id: p.id,
					by: acc[0].n + (tied ? " (tie)" : ""),
					err: errOf(acc[0].m.pose, p),
					band: gtBandOf(p),
				});
		}
		res.oracle = {
			members: three.map(([n]) => n),
			...summarizeErrs(errs),
			winsByMember: wins,
			note: "uses GT to choose among the poses each member would show (a rejected member contributes its fallback / the prior, not its rejected pose): an upper bound for any selector over these three, not a deployable rule",
		};
		res.confidencePick = {
			members: three.map(([n]) => n),
			...summarizeErrs(conf),
			escalated: confEsc,
			escalationRate: round(confEsc / photos.length, 3),
			picksByMember: picks,
			tiesBrokenByOrder: ties,
			tieIds,
			note: "highest raw confidence among members that accepted; the members' confidence scales are not calibrated against each other, and ties (e.g. several at 1.0) go to the listed member order (app first). Not evidence for a selector.",
		};
	}
	// (b) agreement gates
	const rules = [];
	for (let i = 0; i < members.length; i++)
		for (let j = i + 1; j < members.length; j++)
			rules.push({
				name: `${members[i][0]} + ${members[j][0]}`,
				set: [members[i], members[j]],
			});
	if (three.length === 3)
		rules.push({
			name: `2 of 3 (${three.map(([n]) => n).join(", ")})`,
			set: three,
		});
	if (members.length === 4)
		rules.push({
			name: `2 of 4 (${members.map(([n]) => n).join(", ")})`,
			set: members,
		});
	const rankedKeys = (ranked?.rows ?? []).map((r) => r.method);
	res.agreement = rules.map(({ name, set }) => {
		const acceptedIds = [];
		const escalated = [];
		const errs = [];
		for (const p of photos) {
			const v = set
				.map(([n, k]) => ({ n, pose: voteOf(p, k) }))
				.filter((x) => x.pose);
			let best = null;
			for (let a = 0; a < v.length; a++)
				for (let b = a + 1; b < v.length; b++) {
					const d = Math.abs(angleDiff(v[a].pose.yaw, v[b].pose.yaw));
					if (d <= 1 && (!best || d < best.d))
						best = {
							d,
							pose: meanPose(v[a].pose, v[b].pose),
							pair: `${v[a].n}+${v[b].n}`,
						};
				}
			if (!best) {
				escalated.push(p.id);
				continue;
			}
			acceptedIds.push(p.id);
			if (gtPoseOf(p))
				errs.push({
					id: p.id,
					by: best.pair,
					err: errOf(best.pose, p),
					band: gtBandOf(p),
				});
		}
		return gateRow(
			name,
			set.map(([n]) => n),
			set.map(([, k]) => k),
			acceptedIds,
			escalated,
			errs,
		);
	});
	// baseline: the recommended default alone (top-ranked, cheapest), as a gate: accept when it accepts, else escalate
	const R = ranked?.rows ?? [];
	const def = R.length
		? [...R.filter((r) => r.rank === R[0].rank)].sort(
				(a, b) => (a.medianMsAll ?? 1e12) - (b.medianMsAll ?? 1e12),
			)[0].method
		: null;
	if (def) {
		const acceptedIds = [];
		const escalated = [];
		const errs = [];
		for (const p of photos) {
			const m = p.methods[def];
			if (!m?.pose || m.accepted === false) {
				escalated.push(p.id);
				continue;
			}
			acceptedIds.push(p.id);
			if (gtPoseOf(p))
				errs.push({
					id: p.id,
					by: def,
					err: errOf(m.pose, p),
					band: gtBandOf(p),
				});
		}
		const name =
			Object.entries(res.members).find(([, k]) => k === def)?.[0] ?? def;
		res.baseline = {
			...gateRow(
				`${name} alone (baseline: accept when it accepts)`,
				[name],
				[def],
				acceptedIds,
				escalated,
				errs,
			),
			method: def,
			baseline: true,
		};
	}
	return res;

	function gateRow(name, memberNames, keys, acceptedIds, escalated, errs) {
		const s = summarizeErrs(errs);
		const escGt = photos.filter((p) => escalated.includes(p.id) && gtPoseOf(p));
		// who fixes the escalated GT photos? any ranked method outside the gate (pose as scored)
		const inSet = new Set(keys);
		// a target "fixes" an escalated photo only if it accepts it and is < 1° off (a rejected method showing a
		// lucky prior does not count); "wrong" = accepts it but ≥ 1° off (both beyond the photo's GT band)
		const targets = rankedKeys
			.filter((k) => !inSet.has(k))
			.map((k) => {
				const acc = escGt.filter(
					(p) => p.methods[k]?.pose && p.methods[k].accepted !== false,
				);
				const cl = (p) => classifyErr(errOf(p.methods[k].pose, p), gtBandOf(p));
				return {
					method: k,
					fixed: acc.filter((p) => cl(p) === "ok").length,
					wrong: acc.filter((p) => cl(p) === "wrong").length,
					of: escGt.length,
					ms: methods[k]?.medianMsAll ?? null,
				};
			})
			.sort(
				(x, y) =>
					y.fixed - x.fixed ||
					x.wrong - y.wrong ||
					(x.ms ?? 1e12) - (y.ms ?? 1e12),
			);
		const t = targets[0] ?? null;
		return {
			rule: name,
			members: memberNames,
			accepted: acceptedIds.length,
			escalated: escalated.length,
			escalationRate: round(escalated.length / photos.length, 3),
			escalatedIds: escalated,
			acceptedGt: s.n,
			correct: s.clear,
			falseAccepts: s.wrong,
			falseAcceptIds: errs
				.filter((e) => classifyErr(e.err, e.band ?? 0) === "wrong")
				.map((e) => `${e.id} (${round(e.err, 2)}°)`),
			borderline: s.borderline,
			borderlineIds: errs
				.filter((e) => classifyErr(e.err, e.band ?? 0) === "borderline")
				.map((e) => `${e.id} (${round(e.err, 2)}°)`),
			over2: errs.filter((e) => e.err > 2).length,
			medianAbsYaw: s.medianAbsYaw,
			maxAbsYaw: s.maxAbsYaw,
			escalatedGt: escGt.length,
			bestEscalation: t
				? { method: t.method, fixed: t.fixed, wrong: t.wrong, of: t.of }
				: null,
			costMs: keys.reduce((acc, k) => acc + (methods[k]?.medianMsAll ?? 0), 0),
			overallWithin1: s.within1 + (t?.fixed ?? 0),
			overallOf: gtPhotos.length,
		};
	}
}
function summarizeErrs(errs) {
	const e = errs.map((x) => x.err);
	const c = errs.map((x) => classifyErr(x.err, x.band ?? 0));
	return {
		n: e.length,
		within1: e.filter((x) => x < 1).length,
		clear: c.filter((x) => x === "ok").length,
		borderline: c.filter((x) => x === "borderline").length,
		wrong: c.filter((x) => x === "wrong").length,
		medianAbsYaw: round(median(e), 3),
		meanAbsYaw: round(mean(e), 3),
		maxAbsYaw: round(maxOf(e), 3),
		perPhoto: errs.map((x) => ({
			id: x.id,
			by: x.by,
			absYaw: round(x.err, 3),
		})),
	};
}

/** One line for the product decision, derived only from accept counts / false accepts / escalation (not medians). */
export function deriveRecommendation(L) {
	const R = L.ranking?.rows ?? [];
	if (!R.length) return null;
	const top = R.filter((r) => r.rank === R[0].rank);
	const byMs = [...top].sort(
		(a, b) => (a.medianMsAll ?? 1e12) - (b.medianMsAll ?? 1e12),
	);
	const def = byMs[0];
	const lbl = (k) => L.methods[k]?.label ?? k;
	const others = byMs.slice(1).map((r) => lbl(r.method));
	let line = `**${lbl(def.method)}** as the default: ${def.correctAccepts}/${def.n} correct accepts, ${def.falseAccepts} false accept(s), ${def.over2} error(s) > 2°, median ${fmt(def.medianMsAll, 0)} ms`;
	if (others.length)
		line += `; tied on accept counts with ${others.join(", ")} (their median |yaw| differences are inside GT noise, so the cheapest wins)`;
	line += ".";
	// gate: no false accepts, lowest escalation, then cheapest (sum of members' median ms). A gate is only
	// recommended when it beats the default running alone (the baseline row) on false accepts or > 2° errors.
	const gates = (L.ensemble?.agreement ?? [])
		.filter((g) => g.falseAccepts === 0 && g.acceptedGt > 0)
		.sort((a, b) => a.escalationRate - b.escalationRate || a.costMs - b.costMs);
	const g = gates[0];
	const B = L.ensemble?.baseline;
	const who = (g) =>
		g.members.length === 2
			? `${g.members[0]} and ${g.members[1]} agree`
			: `any two of ${g.members.join(", ")} agree`;
	const gateTxt = (g) =>
		`escalates ${g.escalated}/${L.ensemble.nPhotos} photos (${pct(g.escalationRate)}${g.escalatedIds.length ? `: ${g.escalatedIds.join(", ")}` : ""}), ${g.falseAccepts} false accept(s) and ${g.over2} > 2° on ${g.acceptedGt} accepted GT photos${g.borderline ? `, ${g.borderline} borderline (${g.borderlineIds.join(", ")})` : ""}, members' median ms sum ${fmt(g.costMs, 0)}`;
	const escTier = (g) => {
		const few = g.bestEscalation?.of && g.bestEscalation.of < 3;
		if (few)
			return `; only ${g.bestEscalation.of} escalated GT photo(s), too few to pick an escalation tier from data (best on this set: ${lbl(g.bestEscalation.method)}, ${g.bestEscalation.fixed}/${g.bestEscalation.of} accepted within 1°); until then show the prior flagged "unverified" or ask for manual pins`;
		if (g.bestEscalation?.of)
			return g.bestEscalation.fixed
				? `; the best escalation tier is ${lbl(g.bestEscalation.method)}, which accepts and gets ${g.bestEscalation.fixed}/${g.bestEscalation.of} escalated GT photos within 1°${g.bestEscalation.wrong ? ` (${g.bestEscalation.wrong} accepted wrong)` : ""}`
				: `; no other method accepts any escalated GT photo within 1°, so escalated photos should show the prior flagged "unverified" (or go to manual pinning)`;
		return "";
	};
	if (g && B) {
		const better = g.falseAccepts < B.falseAccepts || g.over2 < B.over2;
		if (better)
			line += ` Safety gate: accept only when ${who(g)} within 1° yaw, else escalate. It beats ${lbl(B.method)} alone (${B.falseAccepts} false accept(s), ${B.over2} > 2°): ${gateTxt(g)}${escTier(g)}.`;
		else
			line += ` **No agreement gate beats ${lbl(B.method)} alone on this set.** Alone it ${gateTxt(B)}${escTier(B)}. The best gate (${g.rule}: accept only when ${who(g)} within 1° yaw) ${gateTxt(g)}: no fewer false accepts or > 2° errors, ${g.escalated > B.escalated ? `${g.escalated - B.escalated} more escalation(s)` : g.escalated < B.escalated ? `${B.escalated - g.escalated} fewer escalation(s)` : "the same escalations"} and ${fmt(g.costMs / Math.max(1, B.costMs), 1)}× the cost. Treat a gate as defence-in-depth that this ${L.ensemble.nGt}-photo set does not support.`;
	} else if (g)
		line += ` Safety gate: accept only when ${who(g)} within 1° yaw, else escalate: ${gateTxt(g)}${escTier(g)}.`;
	else if (L.ensemble?.agreement?.length)
		line += " No agreement gate is free of false accepts on this set.";
	return line;
}

/** Methods that get their own bullets in "What's blocking SoTA" and columns in the per-photo table. */
const HEADLINE = [
	"app",
	"cpu:classic-cascade",
	"cpu:classic-skyfirst",
	"refine",
	"refine+sky",
	"matcher:render-match",
	"matcher:fusion",
	"matcher:fused",
];
function deriveBlocking(L) {
	const b = [];
	const { photos, methods, steps, gt } = L;
	const nPhotos = photos.length;
	if (gt.missing.length)
		b.push(
			`**Ground truth covers ${gt.either.length}/${nPhotos} photos** (${gt.json.length} ground-truth.json poses, ${gt.cp.length} control-point solves). Missing: ${gt.missing.join(", ")}. The SoTA report asks for a 50–100 photo in-house set; every number below rests on ${gt.either.length} photo(s).`,
		);
	// target check: one bullet per headline method, one summary bullet for the other complete methods
	const R = L.ranking ?? { rows: [], incomplete: [] };
	const verdict = (m) => {
		const a = methods[m].agg.primary;
		const miss = [];
		const near = [];
		// a median within MEDIAN_NOISE_DEG over the target is inside GT noise: neither a pass nor a miss
		if (a.medianAbsYaw > TARGETS.medianYawDeg + MEDIAN_NOISE_DEG)
			miss.push(`median |yaw| ${a.medianAbsYaw}° > ${TARGETS.medianYawDeg}°`);
		else if (a.medianAbsYaw > TARGETS.medianYawDeg)
			near.push(
				`median |yaw| ${a.medianAbsYaw}° is within GT noise of the ${TARGETS.medianYawDeg}° target`,
			);
		// ≤ 1° rate: a miss only if it misses even with the borderline photos counted as successes
		const rateHi =
			((a.success1Clear ?? a.success1) + (a.borderlineShown ?? 0)) / a.n;
		if (rateHi < TARGETS.success1Rate)
			miss.push(
				`${Math.round(a.rate1 * 100)}% within 1° < ${TARGETS.success1Rate * 100}%`,
			);
		else if (a.rate1 < TARGETS.success1Rate)
			near.push(
				`${Math.round(a.rate1 * 100)}% within 1°, ${Math.round(rateHi * 100)}% counting the borderline ${a.borderlineShownIds.join(", ")}`,
			);
		const sota =
			a.meanAbsYaw <= TARGETS.meanYawSotaDeg &&
			a.rate1 >= TARGETS.success1SotaRate;
		return { a, miss, near, sota };
	};
	const heads = HEADLINE.filter((m) => R.rows.some((r) => r.method === m));
	for (const m of heads) {
		const { a, miss, near, sota } = verdict(m);
		b.push(
			`**${methods[m].label}**: ${a.correctAccepts}/${a.n} correct accepts, ${a.falseAccepts} false accept(s)${a.falseAccepts ? ` (${a.falseAcceptIds.join(", ")})` : ""}${a.borderlineAccepts ? `, ${a.borderlineAccepts} borderline accept(s) inside GT noise (${a.borderlineAcceptIds.join(", ")})` : ""}, ${a.over2} > 2°; ${miss.length ? `misses target (${miss.join("; ")})` : near.length ? `within noise of target (${near.join("; ")})` : "meets target"}; ${sota ? "beats" : "does not beat"} published SoTA (mean ${a.meanAbsYaw}° vs Porzi ${TARGETS.meanYawSotaDeg}°, ${Math.round(a.rate1 * 100)}% ≤1° vs LandscapeAR ${TARGETS.success1SotaRate * 100}%).`,
		);
	}
	const rest = R.rows.filter((r) => !heads.includes(r.method));
	if (rest.length) {
		const meet = rest
			.filter((r) => !verdict(r.method).miss.length)
			.map(
				(r) =>
					methods[r.method].label +
					(verdict(r.method).near.length
						? ` (within noise: ${verdict(r.method).near.join("; ")})`
						: ""),
			);
		const fa = rest
			.filter((r) => r.falseAccepts)
			.map(
				(r) =>
					`${methods[r.method].label} (${methods[r.method].agg.primary.falseAcceptIds.join(", ")})`,
			);
		const bl = rest
			.filter((r) => r.borderlineAccepts)
			.map(
				(r) =>
					`${methods[r.method].label} (${methods[r.method].agg.primary.borderlineAcceptIds.join(", ")})`,
			);
		b.push(
			`Other ranked variants: ${meet.length ? `meet the target (or are within noise of it): ${meet.join(", ")}` : "none meets the target"}${fa.length ? `; false accepts: ${fa.join("; ")}` : "; none has a false accept"}${bl.length ? `; borderline accepts inside GT noise: ${bl.join("; ")}` : ""}.`,
		);
	}
	for (const { method, n } of R.incomplete)
		b.push(
			`**${methods[method].label}**: only ${n}/${gt.either.length} GT photos have a result${methods[method].file ? ` in ${methods[method].file}` : ""}, too few to rank (needs ${R.need}).`,
		);
	// photos no complete method gets within 1°
	const complete = R.rows.map((r) => r.method);
	const hopeless = photos.filter(
		(p) =>
			p.primaryGt &&
			complete.length &&
			complete.every(
				(m) =>
					!p.methods[m]?.err?.primary ||
					Math.abs(p.methods[m].err.primary.yaw) >= 1,
			),
	);
	if (hopeless.length)
		b.push(
			`No method gets within 1° on ${hopeless.map((p) => `${p.id} (best ${Math.min(...complete.map((m) => Math.abs(p.methods[m]?.err?.primary?.yaw ?? 1e9))).toFixed(2)}°)`).join(", ")}: a data/GT problem (eye position, DEM, or the GT itself), not an aligner problem.`,
		);
	for (const m of heads) {
		const worst = photos
			.filter((p) => p.methods[m]?.err?.primary)
			.sort(
				(x, y) =>
					Math.abs(y.methods[m].err.primary.yaw) -
					Math.abs(x.methods[m].err.primary.yaw),
			)
			.slice(0, 3)
			.filter((p) => Math.abs(p.methods[m].err.primary.yaw) >= 1);
		if (worst.length)
			b.push(
				`Worst photos for ${methods[m]?.label ?? m}: ${worst.map((p) => `${p.id} (${p.methods[m].err.primary.yaw}° yaw, ${p.methods[m].err.primary.px} px${p.methods[m].accepted === false ? ", rejected" : ""})`).join(", ")}.`,
			);
		const cf = methods[m]?.calibration?.confidentFailures ?? [];
		if (cf.length)
			b.push(
				`Confident failures (${m}, conf ≥ 0.7 but > 1° off): ${cf.join(", ")}. Confidence does not flag these, so they reach users silently.`,
			);
		const au = methods[m]?.calibration?.auroc;
		if (au != null && au < 0.75)
			b.push(
				`Confidence is poorly calibrated for ${m} (AUROC ${au} for predicting ≤1° success).`,
			);
		const cal = methods[m]?.calibration;
		if (cal?.acceptedFailures?.length && cal.separatingThreshold) {
			const t = cal.separatingThreshold;
			const acc = `${methods[m].label} accepts ${cal.acceptedFailures.length} wrong pose(s): ${cal.acceptedFailures.map((f) => `${f.id} (conf ${f.conf}, ${f.absYaw}° off)`).join(", ")}.`;
			if (t.simulated) {
				const gain =
					t.successesAfter > t.successesBefore ||
					(t.successesAfter === t.successesBefore &&
						t.meanAbsYawAfter < t.meanAbsYawBefore);
				b.push(
					`${acc} Simulated fix, accept only confidence > ${t.above}: the ${t.changed.length} newly rejected photo(s) fall back (${t.changed.map((c) => `${c.id} ${c.fromAbsYaw}° → ${c.fallback} ${c.toAbsYaw ?? "?"}°`).join(", ")}); ` +
						`within 1° ${t.successesBefore}/${t.n} → ${t.successesAfter}/${t.n}, mean |yaw| ${t.meanAbsYawBefore}° → ${t.meanAbsYawAfter}°. ` +
						(gain
							? "Worth doing."
							: "No gain: a higher threshold alone does not fix this; the fallback (or an escalation tier) has to."),
				);
			} else
				b.push(
					`${acc} Confidence > ${t.above} would reject them${t.rejectsSuccesses.length ? ` and also reject ${t.rejectsSuccesses.length} success(es) (${t.rejectsSuccesses.join(", ")})` : ""}; no fallback pose is modelled for this method, so this counts rejections, not fixes.`,
				);
		}
	}
	const dis = L.disagreement;
	const noGt = dis.filter((d) => !d.hasGt);
	if (dis.length) {
		const judged = dis.filter((d) => d.closer);
		const aWins = judged.filter((d) => d.closer === dis[0].a).length;
		const la = methods[dis[0].a]?.label ?? dis[0].a;
		const lb = methods[dis[0].b]?.label ?? dis[0].b;
		b.push(
			`${la} and ${lb} disagree by > 1° yaw on ${dis.length}/${nPhotos} photos (${dis.map((d) => `${d.id} ${d.yaw}°`).join(", ")}).` +
				(judged.length
					? ` Where GT exists the first is closer on ${aWins}/${judged.length}.`
					: "") +
				(noGt.length
					? ` ${noGt.length} of them have no GT, so label them next: ${noGt.map((d) => d.id).join(", ")}.`
					: ""),
		);
	}
	const ens = L.ensemble;
	if (ens?.agreement?.length) {
		const bad = ens.agreement.filter((g) => g.falseAccepts);
		if (bad.length)
			b.push(
				`Agreement gates that still let a wrong pose through: ${bad.map((g) => `${g.rule}: ${g.falseAcceptIds.join(", ")}`).join("; ")}. Two methods can share a failure (same skyline, same eye/DEM error).`,
			);
	}
	const perfRuns = steps.perf?.runs?.filter((r) => r.cold && r.warm) ?? [];
	if (perfRuns.length) {
		const n = perfRuns.length;
		const cold = median(perfRuns.map((r) => r.cold.readyMs));
		const warm = median(perfRuns.map((r) => r.warm.readyMs));
		const measured = perfRuns.every(
			(r) => r.cold.bytesMeasured === "cdp" && r.warm.bytesMeasured === "cdp",
		);
		if (measured) {
			const coldKiB = median(perfRuns.map((r) => r.cold.transferKiB));
			const warmKiB = median(perfRuns.map((r) => r.warm.transferKiB));
			const warmCached = median(perfRuns.map((r) => r.warm.cachedRequests));
			const warmReq = median(perfRuns.map((r) => r.warm.requests));
			// origins that were re-downloaded (not served from cache) on the warm load
			const refetch = {};
			for (const r of perfRuns)
				for (const [o, v] of Object.entries(r.warm.byOrigin ?? {}))
					if (v.networkKiB >= 64)
						refetch[o] = Math.max(refetch[o] ?? 0, v.networkKiB);
			const refetchTxt = Object.entries(refetch)
				.sort((a, b2) => b2[1] - a[1])
				.map(
					([o, k]) =>
						`${new URL(o).host} ${k >= 1024 ? `${(k / 1024).toFixed(1)} MiB` : `${k} KiB`}`,
				)
				.join(", ");
			b.push(
				`Load (median of n=${n}${steps.perf.stale ? `, carried over from ${steps.perf.stale}` : ""}): cold ${(cold / 1000).toFixed(1)} s with ${(coldKiB / 1024).toFixed(1)} MiB on the wire (all origins, incl. DEM tiles and the segmentation model); warm reload ${(warm / 1000).toFixed(1)} s with ${warmKiB >= 1024 ? `${(warmKiB / 1024).toFixed(1)} MiB` : `${warmKiB} KiB`} on the wire (${warmCached}/${warmReq} requests from cache).` +
					(refetchTxt ? ` Re-downloaded on warm reload: ${refetchTxt}.` : "") +
					(warm > TARGETS.coldReadyMs / 2 && warmKiB < 1024
						? " The warm load barely touches the network yet stays slow, so the time is in-browser compute (horizon renders, segmentation, alignment)."
						: ""),
			);
		} else
			b.push(
				`Load (median of n=${n}): cold ${(cold / 1000).toFixed(1)} s, warm ${(warm / 1000).toFixed(1)} s. Byte counts unavailable (DevTools protocol not attached); cross-origin bytes are unmeasured.`,
			);
	}
	const reloaded = (steps.perf?.runs ?? []).flatMap((r) =>
		["cold", "warm"]
			.filter((k) => r[k]?.reloadedDuringLoad)
			.map((k) => `${r.id} ${k}`),
	);
	if (reloaded.length)
		b.push(
			`Perf: the page reloaded during ${reloaded.join(", ")} (dev-server HMR from another session's edit?), so those times and bytes are inflated; re-run the perf step.`,
		);
	if (steps.perf?.failed?.length && !steps.perf.stale)
		b.push(
			`Perf step partial: ${steps.perf.failed.length} photo(s) failed (${steps.perf.failed.join(", ")}); medians are over the remaining ${steps.perf.nCold ?? "?"}.`,
		);
	if (steps.app?.failures?.length && !steps.app.stale)
		b.push(
			`App pass partial: ${steps.app.failures.length} photo(s) failed (${steps.app.failures.map((f) => `${f.id}: ${f.error.slice(0, 80)}`).join("; ")}); their app numbers are missing.`,
		);
	if (steps.evalcpu?.reportStale)
		b.push(
			`CPU solver numbers are stale: --run-evalcpu did not rewrite out/eval/report.json (${steps.evalcpu.status}); using the copy from ${steps.evalcpu.reportMtime}.`,
		);
	if (L.inputs?.changed?.length)
		b.push(
			`Inputs changed during the run (other sessions editing): ${L.inputs.changed.join(", ")}. Every score uses the GT snapshot taken at the start (out/lead/leaderboard/gt-snapshot/), but a method file rewritten mid-run may mix versions; re-run if it matters.`,
		);
	const gtDis = photos.filter(
		(p) => p.gtAgreement && Math.abs(p.gtAgreement.yaw) > 0.3,
	);
	if (gtDis.length)
		b.push(
			`The two GT sources disagree by > 0.3° yaw on ${gtDis.map((p) => `${p.id} (${p.gtAgreement.yaw}°)`).join(", ")}. Reconcile them before trusting sub-degree numbers.`,
		);
	// engine.controlPins resolves named peaks and az/el DEM notches; lake-waterline levels (el only) and
	// peak: "node/<osm id>" are deliberate GT (0f) that the in-page solve cannot use. Flag only the unexplained drops.
	const unexplained = photos.filter(
		(p) =>
			p.gtCp?.pins != null && p.gtCp.kinds && p.gtCp.pins < p.gtCp.kinds.usable,
	);
	if (unexplained.length)
		b.push(
			`engine.controlPins dropped named peaks / notches it should resolve (peak name missing from the OSM region?): ${unexplained.map((p) => `${p.id} ${p.gtCp.pins}/${p.gtCp.kinds.usable}`).join(", ")}.`,
		);
	const partial = photos.filter(
		(p) => p.gtCp?.kinds && p.gtCp.kinds.levels + p.gtCp.kinds.nodes > 0,
	);
	if (partial.length)
		b.push(
			`The control-point GT (secondary column) is solved in-page from a subset of the labelled points: engine.controlPins has no level constraint for lake waterlines and no OSM-node-id lookup (region JSON carries no ids), so ${partial.map((p) => `${p.id} drops ${[p.gtCp.kinds.levels ? `${p.gtCp.kinds.levels} level` : "", p.gtCp.kinds.nodes ? `${p.gtCp.kinds.nodes} node/<id>` : ""].filter(Boolean).join(" + ")}`).join(", ")}. The primary GT (ground-truth.json, 0f's solve with all points) is unaffected.`,
		);
	const tsc = steps.tsc;
	if (tsc?.errorCount)
		b.push(
			`tsc: ${tsc.errorCount} errors (${Object.entries(tsc.byOwner)
				.map(([o, n]) => `${o} ${n}`)
				.join(", ")}).`,
		);
	if (steps.biome?.errors)
		b.push(
			`biome: ${steps.biome.errors} errors (${Object.entries(
				steps.biome.byOwner,
			)
				.map(([o, n]) => `${o} ${n}`)
				.join(", ")}).`,
		);
	if (
		steps.build &&
		steps.build.status !== "ok" &&
		steps.build.status !== "skipped"
	)
		b.push(`Production build: ${steps.build.status}.`);
	const perf = steps.perf;
	if (perf?.medianColdMs > TARGETS.coldReadyMs)
		b.push(
			`Cold time-to-ready median ${(perf.medianColdMs / 1000).toFixed(1)} s (n=${perf.nCold ?? perf.runs?.filter((r) => r.cold).length}) is over the ${TARGETS.coldReadyMs / 1000} s target.`,
		);
	for (const [k, s] of Object.entries(steps))
		if (
			["fail", "timeout", "error"].includes(s.status) &&
			!["tsc", "biome", "build"].includes(k) &&
			!(k === "evalcpu" && s.reportStale)
		)
			b.push(
				`Step ${k} ${s.status}${s.note ? `: ${String(s.note).split("\n")[0].slice(0, 200)}` : ""}.`,
			);
	return b;
}

// ─────────────────────────────── markdown ───────────────────────────────
const fmt = (x, n = 2) =>
	x == null || Number.isNaN(x)
		? "–"
		: x >= 1e9
			? "∞"
			: typeof x === "number"
				? Number.isInteger(x) && n <= 2
					? String(x)
					: x.toFixed(n)
				: String(x);
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
function renderMd(L) {
	const o = [];
	const { steps } = L;
	o.push("# Rigi leaderboard", "");
	o.push(
		`Generated ${L.generatedAt} by \`node scripts/leaderboard.mjs\` in ${(L.durationMs / 1000).toFixed(0)} s. App: ${L.appUrl}. Machine-readable version: \`reports/leaderboard.json\` (schema at the top of the script).`,
		"",
	);
	if (L.recommendation)
		o.push(
			"## Recommended pipeline",
			"",
			L.recommendation,
			"",
			"Derived from accept counts, false accepts, > 2° errors and escalation rates only (never from sub-0.3° median differences, which are inside the ~0.2–0.4° noise of 'approx' GT).",
			"",
		);
	o.push("## What's blocking SoTA", "");
	for (const b of L.blocking) o.push(`- ${b}`);
	if (!L.blocking.length) o.push("- Nothing: every target is met.");
	o.push("");
	o.push(
		`Targets: median |yaw| ≤ ${TARGETS.medianYawDeg}°, ≥ ${TARGETS.success1Rate * 100}% of photos within 1°. "Within noise of target" = a median at most ${MEDIAN_NOISE_DEG}° over the bar, or a ≤ 1° rate that meets the bar once the borderline (GT-band) photos are counted; neither is called a pass or a miss. Published reference points from the SoTA report: Porzi et al. ${TARGETS.meanYawSotaDeg}° mean error; LandscapeAR ${TARGETS.success1SotaRate * 100}% within 1°.`,
		"",
	);

	const gs = L.inputs.gtSnapshot;
	o.push("## Leaderboard (ranked)", "");
	o.push(
		`Every method is re-scored here against one GT snapshot (\`${gs.dir}/\`, taken ${gs.takenAt}; ground-truth.json sha1 ${gs.files.groundTruth?.sha1 ?? "?"}), against the primary GT per photo. Ranked by fewest false accepts, then most correct accepts, fewest > 2° errors, most clearly within 1° (as fractions of each method's n); ties share a rank and are ordered by median time. **GT-uncertainty band:** on photos whose GT is 'approx' (${L.gt.bandDeg ?? "0.3"}° either side of 1°: 1 ± ${L.gt.bandDeg ?? "0.3"}°) an error cannot be called right or wrong at the 1° line, so it is counted as *borderline*, not as a correct or false accept (and not in 'clearly ≤ 1°'); 'good' GT has no band. **Median |yaw| is shown but not ranked on:** differences under ~0.3° are inside GT noise.`,
		"",
	);
	o.push(
		"| rank | method | n | correct accepts (clearly < 1°) | false accepts (clearly ≥ 1°) | borderline accepts | > 2° | clearly ≤ 1° / ≤ 1° | median \\|yaw\\| | mean \\|yaw\\| | max \\|yaw\\| | median px | median ms (all photos) | source age |",
	);
	o.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	const ageOfMethod = (k) => {
		if (k.startsWith("cpu:"))
			return (L.steps.evalcpu?.reports ?? []).find((r) => r.key === k.slice(4))
				?.ageMin;
		if (k === "cpu-final" || k === "cpu")
			return (L.steps.evalcpu?.reports ?? []).find((r) => r.key === "eval")
				?.ageMin;
		if (L.methods[k]?.fileMtime)
			return ageMin(Date.parse(L.methods[k].fileMtime));
		if (k.startsWith("app"))
			return L.steps.app?.stale ? ageMin(Date.parse(L.steps.app.stale)) : 0;
		return null;
	};
	const ageTxt = (m) =>
		m == null
			? "–"
			: m < 1
				? "this run"
				: m < 120
					? `${m} min`
					: `${(m / 60).toFixed(1)} h`;
	for (const r of L.ranking.rows) {
		const m = L.methods[r.method];
		const a = m.agg.primary;
		o.push(
			`| ${r.rank} | ${m.label}${a.acceptsAll ? " ¹" : ""} | ${a.n} | ${a.correctAccepts}/${a.n} | ${a.falseAccepts ? `**${a.falseAccepts}** (${a.falseAcceptIds.join(", ")})` : 0} | ${a.borderlineAccepts ? `${a.borderlineAccepts} (${a.borderlineAcceptIds.join(", ")})` : 0} | ${a.over2 ? `${a.over2} (${a.over2Ids.join(", ")})` : 0} | ${a.success1Clear ?? a.success1}/${a.success1} of ${a.n}${a.borderlineShown ? ` (borderline: ${a.borderlineShownIds.join(", ")})` : ""} | ${fmt(a.medianAbsYaw)}° | ${fmt(a.meanAbsYaw)}° | ${fmt(a.maxAbsYaw)}° | ${fmt(a.medianPx, 1)} | ${fmt(m.medianMsAll, 0)} | ${ageTxt(ageOfMethod(r.method))} |`,
		);
	}
	for (const r of L.ranking.incomplete)
		o.push(
			`| – | ${L.methods[r.method].label} (incomplete: ${r.n} GT photos < ${L.ranking.need}) | ${r.n} | | | | | | | | | | | ${ageTxt(ageOfMethod(r.method))} |`,
		);
	for (const d of L.ranking.duplicates ?? [])
		o.push(
			`| = | ${L.methods[d.method]?.label} | | | | | | | | | | | | same results as ${d.sameAs.map((k) => L.methods[k]?.label ?? k).join(", ")} |`,
		);
	const pr = L.methods.prior?.agg?.primary;
	if (pr)
		o.push(
			`| ref | ${L.methods.prior.label} | ${pr.n} | – | – | – | ${pr.over2} | ${pr.success1Clear ?? pr.success1}/${pr.success1} of ${pr.n} | ${fmt(pr.medianAbsYaw)}° | ${fmt(pr.meanAbsYaw)}° | ${fmt(pr.maxAbsYaw)}° | ${fmt(pr.medianPx, 1)} | 0 | – |`,
		);
	o.push(
		"",
		"¹ No accept/reject signal in the source, so it counts as always accepting (every error clearly ≥ 1° is a false accept). 'Correct/false accepts' use the method's own accept flag (app: confidence > 0.2; CPU variants: 0f's accept; refine and matcher contract files: their `accepted`; fused from fusion_default.json: confidence level HIGH). '> 2°' and '≤ 1°' score the pose as shown: a rejected CPU photo shows the prior, the app shows its fallback, external methods (refine, matcher) are scored on the pose in their file even when they rejected it. Median ms: CPU = skyline + solve on Node; app = autoAlign in the browser; matcher = match + solve on the MPS GPU, rendering excluded.",
		"",
	);

	const E = L.ensemble;
	if (E) {
		o.push("## Oracle / ensemble (product decision input)", "");
		o.push(
			`Members: ${Object.entries(E.members)
				.map(([n, k]) => `${n} = ${L.methods[k]?.label ?? k}`)
				.join("; ")}. ${E.nPhotos} photos, ${E.nGt} with GT.`,
			"",
		);
		const rp = E.residualPick;
		o.push(
			`**(a) Lowest skyline residual among ${E.oracle.members.join(" / ")}:** ${
				rp.available
					? `${rp.within1}/${rp.n} within 1°, median ${fmt(rp.medianAbsYaw)}°, max ${fmt(rp.maxAbsYaw)}°.`
					: `${rp.note}. Residuals available per member: ${Object.entries(
							rp.residualsPerMember,
						)
							.map(([k, n]) => `${k} ${n}/${E.nPhotos}`)
							.join(", ")}.`
			} Stand-ins:`,
			"",
		);
		o.push(
			`- GT oracle (best of the three by true error among the poses each member would show: a member that rejected contributes its fallback / the prior, never its rejected pose; an upper bound for any selector): ${E.oracle.within1}/${E.oracle.n} within 1°${E.oracle.borderline ? ` (${E.oracle.borderline} borderline)` : ""}, median ${fmt(E.oracle.medianAbsYaw)}°, max ${fmt(E.oracle.maxAbsYaw)}°; wins ${Object.entries(
				E.oracle.winsByMember,
			)
				.map(([k, n]) => `${k} ${n}`)
				.join(", ")}.`,
		);
		const cp = E.confidencePick;
		o.push(
			`- Highest raw confidence among accepting members (GT-free, **not evidence for a selector**): ${cp.within1}/${cp.n} within 1°, median ${fmt(cp.medianAbsYaw)}°, max ${fmt(cp.maxAbsYaw)}°; ${cp.escalated}/${E.nPhotos} photos have no accepting member. The members' confidences are on uncalibrated, non-comparable scales, and ${cp.tiesBrokenByOrder ?? "?"}/${E.nPhotos - cp.escalated} picks are ties (${(cp.tieIds ?? []).join(", ")}) broken by member order (${E.oracle.members.join(" → ")}); picks: ${Object.entries(
				cp.picksByMember ?? {},
			)
				.map(([k, n]) => `${k} ${n}`)
				.join(
					", ",
				)}. In effect it is "use ${Object.entries(cp.picksByMember ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "?"} unless it rejects".`,
			"",
		);
		o.push(
			"**(b) Agreement gate:** accept when two members' accepted poses agree within 1° yaw (output = their mean), else escalate. A rejected pose is not a vote. The first row is the baseline every gate must beat: the recommended default alone (accepted when it accepts, escalated when it rejects).",
			"",
		);
		o.push(
			"| gate | accepted | escalated (rate) | false accepts on GT | borderline | > 2° | correct / accepted GT | median \\|yaw\\| accepted | max | best escalation target (≤ 1° on escalated GT) | overall ≤ 1° | members' median ms |",
			"|---|---|---|---|---|---|---|---|---|---|---|---|",
		);
		for (const g of [...(E.baseline ? [E.baseline] : []), ...E.agreement])
			o.push(
				`| ${g.baseline ? `**${g.rule}**` : g.rule} | ${g.accepted}/${E.nPhotos} | ${g.escalated} (${pct(g.escalationRate)})${g.escalatedIds.length ? `: ${g.escalatedIds.join(", ")}` : ""} | ${g.falseAccepts ? `**${g.falseAccepts}** (${g.falseAcceptIds.join(", ")})` : 0} | ${g.borderline ? `${g.borderline} (${g.borderlineIds.join(", ")})` : 0} | ${g.over2 ?? "–"} | ${g.correct}/${g.acceptedGt} | ${fmt(g.medianAbsYaw)}° | ${fmt(g.maxAbsYaw)}° | ${g.bestEscalation?.of ? `${L.methods[g.bestEscalation.method]?.label ?? g.bestEscalation.method}: ${g.bestEscalation.fixed}/${g.bestEscalation.of}${g.bestEscalation.wrong ? ` (${g.bestEscalation.wrong} accepted wrong)` : ""}` : "–"} | ${g.overallWithin1}/${g.overallOf} | ${fmt(g.costMs, 0)} |`,
			);
		o.push(
			"",
			"Escalation rate is over all photos (GT or not); false accepts and 'overall' are over GT photos. An escalation target only counts a photo it accepts (a rejected method showing a lucky prior does not count). 'Overall ≤ 1°' = gate-accepted correct + escalated photos the best target accepts within 1°.",
			"",
		);
	}

	o.push("## Accuracy detail", "");
	for (const [key, title] of [
		[
			"primary",
			"Against the primary GT per photo (ground-truth.json if quality good/approx, else the control-point solve)",
		],
		[
			"json",
			"Against data/ground-truth.json poses (px = mean grid reprojection, 1600-px-wide image)",
		],
		[
			"cp",
			"Against the control-point GT solve (px = mean reprojection at the labelled points, 1600-px basis)",
		],
	]) {
		const ms = Object.entries(L.methods).filter(([, m]) => m.agg[key]);
		if (!ms.length) continue;
		o.push(`### ${title}`, "");
		o.push(
			"| method | n | median \\|yaw\\| | mean \\|yaw\\| | max \\|yaw\\| | median \\|pitch\\| | median \\|roll\\| | median px | max px | ≤0.5° | ≤1° | accepted | median ms |",
		);
		o.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
		for (const [, m] of ms) {
			const a = m.agg[key];
			o.push(
				`| ${m.label} | ${a.n} | ${fmt(a.medianAbsYaw)}° | ${fmt(a.meanAbsYaw)}° | ${fmt(a.maxAbsYaw)}° | ${fmt(a.medianAbsPitch)}° | ${fmt(a.medianAbsRoll)}° | ${fmt(a.medianPx, 1)} | ${fmt(a.maxPx, 1)} | ${a.success05}/${a.n} (${pct(a.rate05)}) | ${a.success1}/${a.n} (${pct(a.rate1)}) | ${a.acceptsAll ? "n/a (always)" : `${a.accepted}/${a.n}`} | ${fmt(a.medianMs, 0)} |`,
			);
		}
		o.push("");
	}

	o.push("### Confidence calibration (primary GT, success = |yaw| < 1°)", "");
	o.push(
		"| method | n | AUROC | Spearman(conf, \\|yaw err\\|) | conf <0.3 | 0.3–0.7 | ≥0.7 | confident failures | rejected successes |",
	);
	o.push("|---|---|---|---|---|---|---|---|---|");
	for (const [, m] of Object.entries(L.methods)) {
		const c = m.calibration;
		if (!c) continue;
		const bin = (i) =>
			c.bins[i].n ? `${c.bins[i].n} @ ${fmt(c.bins[i].medianAbsYaw)}°` : "–";
		o.push(
			`| ${m.label} | ${c.n} | ${fmt(c.auroc)} | ${fmt(c.spearman)} | ${bin(0)} | ${bin(1)} | ${bin(2)} | ${c.confidentFailures.length ? c.confidentFailures.join("; ") : "none"} | ${c.rejectedSuccesses.length ? c.rejectedSuccesses.join(", ") : "none"} |`,
		);
	}
	o.push(
		"",
		"AUROC is blank until the set has both successes and failures. Spearman should be negative: higher confidence, lower error.",
		"",
	);

	const mNames = ["prior", ...HEADLINE].filter((m) => L.methods[m]);
	o.push(
		"## Per photo (signed yaw error vs primary GT, degrees; confidence in brackets)",
		"",
	);
	o.push(
		`| photo | GT | GT agreement (json−cp yaw) | ${mNames.map((m) => L.methods[m].label).join(" | ")} | app−cascade yaw |`,
	);
	o.push(`|---|---|---|${mNames.map(() => "---").join("|")}|---|`);
	for (const p of L.photos) {
		const gtLabel = p.primaryGt
			? `${p.primaryGt}${p.gtJson ? ` (${p.gtJson.quality})` : ""}${p.gtCp?.pose ? ` cp ${p.gtCp.pins}/${p.gtCp.labelled} pins` : ""}`
			: "**missing**";
		const cells = mNames.map((m) => {
			const v = p.methods[m];
			if (!v) return "–";
			const e = v.err.primary;
			const c =
				v.confidence != null
					? ` (${v.confidence.toFixed(2)}${v.accepted === false ? ", rej" : ""})`
					: "";
			return e
				? `${Math.abs(e.yaw) >= 1 ? `**${fmt(e.yaw)}**` : fmt(e.yaw)}${c}`
				: `yaw ${fmt(v.pose.yaw, 1)}${c}`;
		});
		const a = p.methods.app?.pose;
		const cf =
			p.methods[
				L.disagreement[0]?.b ??
					(L.methods["cpu:classic-cascade"]
						? "cpu:classic-cascade"
						: "cpu-final")
			]?.pose;
		const dy = a && cf ? angleDiff(a.yaw, cf.yaw) : null;
		o.push(
			`| ${p.id} | ${gtLabel} | ${p.gtAgreement ? `${fmt(p.gtAgreement.yaw)}° (${fmt(p.gtAgreement.pinPx, 1)} px)` : "–"} | ${cells.join(" | ")} | ${dy == null ? "–" : Math.abs(dy) > 1 ? `**${fmt(dy)}**` : fmt(dy)} |`,
		);
	}
	o.push(
		"",
		"Headline methods only; every method's per-photo errors are in leaderboard.json. Cells without GT show the method's absolute yaw instead of an error. **Bold** = more than 1° off or more than 1° of disagreement.",
		"",
	);
	const rep = L.steps.matcher?.reported ?? [];
	if (rep.length) {
		o.push(
			`### f0's own matcher summary (from report, not re-scored; ${rep[0].source})`,
			"",
			"| method | n | median \\|Δyaw\\| | median \\|Δpitch\\| | median \\|Δroll\\| | median pin px | within 1° |",
			"|---|---|---|---|---|---|---|",
		);
		for (const r of rep)
			o.push(
				`| ${r.method} | ${r.n} | ${fmt(r.medianAbsYaw)}° | ${fmt(r.medianAbsPitch)}° | ${fmt(r.medianAbsRoll)}° | ${fmt(r.medianPinPx, 1)} | ${r.within1}/${r.of} |`,
			);
		const rm = L.methods["matcher:render-match"]?.agg?.cp;
		o.push(
			"",
			`Against ${rep[0].gt}. ${rm ? `Our re-score of render-match against the same kind of GT (the cp column): n=${rm.n}, median |yaw| ${fmt(rm.medianAbsYaw)}°, ${rm.success1}/${rm.n} within 1° (differences come from the GT snapshot and pin set).` : ""}`,
			"",
		);
	}

	if (steps.evalapp?.rows?.length) {
		o.push("### scripts/eval-app.mjs as printed (cross-check)", "");
		o.push(
			"| photo | pins | gt resid px | prior px | auto px | Δyaw prior | Δyaw auto | Δpitch auto | Δroll auto |",
			"|---|---|---|---|---|---|---|---|---|",
		);
		for (const r of steps.evalapp.rows)
			o.push(
				`| ${r.id} | ${r.pins} | ${fmt(r.gtResid, 1)} | ${fmt(r.priorPx, 1)} | ${fmt(r.autoPx, 1)} | ${fmt(r.dYawPrior)} | ${fmt(r.dYawAuto)} | ${fmt(r.dPitchAuto)} | ${fmt(r.dRollAuto)} |`,
			);
		const cc = steps.evalapp.crossCheck;
		o.push(
			"",
			`eval-app summary: ${steps.evalapp.within1 ?? "–"} within 1° yaw, median auto px ${fmt(steps.evalapp.medianAutoPx, 1)}.${cc ? ` Agreement with this run's app step over ${cc.n} photos: max |Δpx| ${fmt(cc.maxAbsPxDiff, 1)}, max |Δyaw| ${fmt(cc.maxAbsYawDiff)}° (separate page loads, so small differences are expected).` : ""}${steps.evalapp.stale ? ` (stale, from ${steps.evalapp.stale})` : ""}`,
			"",
		);
	}

	o.push("## Performance", "");
	if (steps.perf?.runs?.length) {
		const s1 = (ms) => (ms ? `${(ms / 1000).toFixed(2)} s` : "–");
		o.push(
			"| photo | cold ready | warm ready | cold load event | cold last network response | cold requests / KiB on wire | warm requests / KiB on wire | page errors |",
			"|---|---|---|---|---|---|---|---|",
		);
		for (const r of steps.perf.runs)
			o.push(
				`| ${r.id} | ${r.cold ? s1(r.cold.readyMs) : (r.error ?? "–")} | ${s1(r.warm?.readyMs)} | ${s1(r.cold?.loadMs)} | ${s1(r.cold?.lastResponseMs)} | ${r.cold?.requests ?? "–"} / ${r.cold?.transferKiB ?? "–"} | ${r.warm?.requests ?? "–"} / ${r.warm?.transferKiB ?? "–"} | ${(r.cold?.pageErrors ?? 0) + (r.warm?.pageErrors ?? 0)} |`,
			);
		o.push(
			"",
			"If ready is much later than the last network response, the time goes to in-browser compute (horizon renders, segmentation, alignment), not downloads.",
		);
		o.push(
			"",
			`Median cold ${fmt(steps.perf.medianColdMs / 1000)} s (n=${steps.perf.nCold ?? "?"}), warm ${fmt(steps.perf.medianWarmMs / 1000)} s (n=${steps.perf.nWarm ?? "?"}). ${steps.perf.note ?? ""}${steps.perf.stale ? ` (stale, from ${steps.perf.stale})` : ""}`,
			"",
		);
		const origins = [
			...new Set(
				steps.perf.runs.flatMap((r) => [
					...Object.keys(r.cold?.byOrigin ?? {}),
					...Object.keys(r.warm?.byOrigin ?? {}),
				]),
			),
		];
		if (origins.length) {
			o.push(
				"Bytes on the wire by origin (requests, of which from cache / KiB):",
				"",
				`| photo | load | ${origins.map((x) => new URL(x).host).join(" | ")} |`,
				`|---|---|${origins.map(() => "---").join("|")}|`,
			);
			for (const r of steps.perf.runs)
				for (const k of ["cold", "warm"])
					if (r[k]?.byOrigin)
						o.push(
							`| ${r.id} | ${k} | ${origins.map((x) => (r[k].byOrigin[x] ? `${r[k].byOrigin[x].requests} (${r[k].byOrigin[x].cached} cached) / ${r[k].byOrigin[x].networkKiB}` : "–")).join(" | ")} |`,
						);
			o.push("");
		}
	} else o.push(`Perf step ${steps.perf?.status ?? "not run"}.`, "");
	const solveMs = Object.entries(L.methods)
		.filter(([, m]) => m.agg.primary?.medianMs != null || m.medianMsAll != null)
		.map(([, m]) => `${m.label} ${fmt(m.medianMsAll, 0)} ms`);
	if (solveMs.length)
		o.push(`Median solve time over all photos: ${solveMs.join(", ")}.`, "");
	if (steps.build?.assets?.length) {
		o.push(
			`### Production bundle (${steps.build.status}, ${(steps.build.ms / 1000).toFixed(1)} s)`,
			"",
		);
		o.push(
			`Total JS ${(steps.build.totalJsBytes / 1024).toFixed(0)} KiB (${(steps.build.totalJsGzip / 1024).toFixed(0)} KiB gzip), CSS ${(steps.build.totalCssBytes / 1024).toFixed(0)} KiB.`,
			"",
		);
		o.push("| chunk | size | gzip |", "|---|---|---|");
		for (const a of steps.build.assets.slice(0, 10))
			o.push(
				`| ${a.file} | ${(a.bytes / 1024).toFixed(0)} KiB | ${(a.gzipBytes / 1024).toFixed(0)} KiB |`,
			);
		o.push("");
	}
	if (steps.build?.sideEffects?.length)
		o.push(
			`Build side effects outside out/lead/leaderboard/: ${steps.build.sideEffects.join("; ")}. (Nitro always writes this pointer under the repo root; the step puts back what was there.)`,
			"",
		);

	o.push("## Health", "");
	o.push("| step | status | time | result |", "|---|---|---|---|");
	const res = (k, s) => {
		if (k === "tsc" && s.errorCount != null)
			return `${s.errorCount} errors${
				s.errorCount
					? `: ${Object.entries(s.byOwner)
							.map(([o2, n]) => `${o2} ${n}`)
							.join(", ")}`
					: ""
			}`;
		if (k === "biome" && s.errors != null)
			return `${s.errors} errors, ${s.warnings} warnings over ${s.filesChecked} files${
				s.errors
					? ` (${Object.entries(s.byOwner)
							.map(([o2, n]) => `${o2} ${n}`)
							.join(", ")}; ${Object.entries(s.byCategory)
							.map(([c, n]) => `${c} ${n}`)
							.join(", ")})`
					: ""
			}`;
		if (k === "build" && s.totalJsBytes)
			return `JS ${(s.totalJsBytes / 1024).toFixed(0)} KiB`;
		if (k === "evalapp")
			return `${s.rows?.length ?? 0} rows, ${s.within1 ?? "–"} within 1°`;
		if (k === "matcher")
			return s.files?.length
				? s.files
						.map(
							(f) =>
								`${f.file} (${
									f.error ??
									(f.skipped
										? "ignored"
										: Object.entries(f.methods ?? {})
												.map(([m, n]) => `${m} ${n}`)
												.join(", "))
								})`,
						)
						.join(", ")
				: "no results file";
		if (k === "evalcpu" && s.reports?.length)
			return `${s.reports.length} reports (${s.reports.map((r) => `${r.key} ${r.rows}`).join(", ")})${s.ran ? " (re-run)" : " (read-only)"}${s.evalMatches?.length ? `; out/eval = ${s.evalMatches.join(", ")}` : ""}${s.reportStale ? " STALE" : ""}`;
		if (k === "app")
			return `${s.photos ?? 0} photos${s.failures?.length ? `, ${s.failures.length} failed: ${s.failures.map((f) => f.id).join(", ")}` : ""}`;
		if (k === "perf")
			return `${s.runs?.length ?? 0} photos${s.failed?.length ? `, ${s.failed.length} failed: ${s.failed.join(", ")}` : ""}; median cold ${fmt(s.medianColdMs / 1000)} s (n=${s.nCold ?? "?"}), warm ${fmt(s.medianWarmMs / 1000)} s (n=${s.nWarm ?? "?"})`;
		if (k === "evalcpu")
			return `${s.photos ?? 0} photos, report ${s.reportMtime ?? "missing"}${s.ran ? " (re-run)" : " (read-only)"}${s.reportStale ? " STALE" : ""}`;
		return "";
	};
	for (const [k, s] of Object.entries(steps))
		o.push(
			`| ${k} | ${s.status}${s.stale ? ` (stale ${s.stale})` : ""} | ${s.ms != null ? `${(s.ms / 1000).toFixed(1)} s` : "–"} | ${res(k, s).replace(/\|/g, "\\|")} |`,
		);
	o.push("");
	const notes = Object.entries(steps).filter(([, s]) => s.note);
	if (notes.length) {
		o.push("Step notes:", "");
		for (const [k, s] of notes)
			o.push(
				`- **${k}**: ${String(s.note).split("\n").slice(0, 3).join(" ").slice(0, 400)}`,
			);
		o.push("");
	}
	o.push("## Inputs and their age", "");
	o.push(
		"Default mode runs no other session's evaluator: it reads their latest outputs (retrying a read while a file looks mid-rewrite).",
		"",
	);
	o.push(
		"| file | owner | written | age at run | note |",
		"|---|---|---|---|---|",
	);
	for (const f of L.inputs.files ?? [])
		o.push(
			`| ${f.file} | ${f.owner} | ${f.mtime ?? "–"} | ${ageTxt(f.ageMin)} | ${String(f.note ?? "").replace(/\|/g, "\\|")} |`,
		);
	o.push("");
	o.push("## Methods", "");
	for (const [, m] of Object.entries(L.methods))
		o.push(`- **${m.label}**: ${m.description}`);
	o.push("");
	return `${o.join("\n")}\n`;
}

// ─────────────────────────────── selftest ───────────────────────────────
async function selftest() {
	let fails = 0;
	const ok = (c, msg) => {
		if (!c) {
			fails++;
			console.log(`FAIL ${msg}`);
		} else console.log(`ok   ${msg}`);
	};
	ok(
		angleDiff(359, 1) === -2 &&
			angleDiff(1, 359) === 2 &&
			angleDiff(180, 0) === -180,
		"angleDiff wraps",
	);
	ok(
		median([3, 1, 2]) === 2 &&
			median([4, 1, 2, 3]) === 2.5 &&
			median([]) === null,
		"median",
	);
	ok(
		auroc([
			{ conf: 0.9, ok: true },
			{ conf: 0.1, ok: false },
		]) === 1 &&
			auroc([
				{ conf: 0.5, ok: true },
				{ conf: 0.5, ok: false },
			]) === 0.5 &&
			auroc([{ conf: 1, ok: true }]) === null,
		"auroc",
	);
	ok(Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12, "spearman −1");
	const P = { yaw: 40, pitch: -2, roll: 1.5, vfov: 30 };
	ok(gridPx(P, P, 4 / 3) < 1e-9, "gridPx zero for identical poses");
	const hfov = (2 * Math.atan(Math.tan(15 * D) * (4 / 3))) / D;
	const g1 = gridPx({ ...P, yaw: P.yaw + 0.1 }, P, 4 / 3);
	ok(
		Math.abs(g1 - (0.1 / hfov) * 1600) / ((0.1 / hfov) * 1600) < 0.2,
		`gridPx 0.1° yaw ≈ ${((0.1 / hfov) * 1600).toFixed(1)} px (got ${g1.toFixed(1)})`,
	);
	ok(
		Math.abs(vfovFromF(5590.9, 3024) - 30.27) < 0.02,
		"vfovFromF matches photos.json prior vfov (IMG_6958)",
	);
	const b = poseBasis({ yaw: 90, pitch: 0, roll: 0, vfov: 30 });
	ok(
		Math.abs(b.forward[0] - 1) < 1e-12 &&
			Math.abs(b.right[1] + 1) < 1e-12 &&
			Math.abs(b.up[2] - 1) < 1e-12,
		"yaw 90 looks east, right = south, up = up",
	);
	const br = poseBasis({ yaw: 0, pitch: 0, roll: 10, vfov: 30 });
	ok(br.right[2] < 0, "roll + puts the right side down");
	const pu = projectDir(
		{ yaw: 0, pitch: 5, roll: 0, vfov: 30 },
		4 / 3,
		[0, 1, 0],
	);
	ok(pu.v > 0.5, "pitch up + moves the horizon down in the image");
	ok(
		ownerOf("src/lib/engine.ts") === "9e" &&
			ownerOf("scripts/eval-app.mjs") === "9e" &&
			ownerOf("scripts/eval.ts") === "0f" &&
			ownerOf("src/lib/deck/scene.ts") === "f0" &&
			ownerOf("src/lib/look/sun.ts") === "d1" &&
			ownerOf("src/router.tsx") === "unowned",
		"ownerOf",
	);
	ok(
		ownerOf("src/lib/refine/robust.ts") === "d1" &&
			ownerOf("src/lib/horizon-fast/march.ts") === "d1" &&
			ownerOf("out/refine/results.json") === "d1",
		"ownerOf: d1 owns refine / horizon-fast",
	);
	ok(
		ownerOf("src/lib/matcher-client.ts") === "f0" &&
			ownerOf("src/lib/upload/x.ts") === "lead" &&
			ownerOf("out/lead/leaderboard/API.md") === "leaderboard" &&
			ownerOf("out/eval-classic-cascade/report.json") === "0f",
		"ownerOf: f0 matcher-client, lead upload, leaderboard, 0f eval variants",
	);
	{
		// mid-rewrite: a truncated file, then a short one, then the full one → readJsonStable retries until valid
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-stable-"));
		const f = path.join(dir, "results.json");
		fs.writeFileSync(f, '[{"id":"A","yaw":1}');
		setTimeout(() => fs.writeFileSync(f, '[{"id":"A","yaw":1}]'), 150);
		setTimeout(
			() => fs.writeFileSync(f, '[{"id":"A","yaw":1},{"id":"B","yaw":2}]'),
			450,
		);
		const r = await readJsonStable(f, {
			validate: (j) => (j.length < 2 ? "short" : true),
			tries: 6,
			delayMs: 200,
		});
		const r2 = await readJsonStable(path.join(dir, "nope.json"), {
			tries: 3,
			delayMs: 10,
		});
		fs.rmSync(dir, { recursive: true, force: true });
		ok(
			r.json?.length === 2 &&
				r.tries >= 3 &&
				!r.warning &&
				r2.json === null &&
				r2.warning === "missing",
			`readJsonStable retries a mid-rewrite file (${r.tries} reads) and gives up at once on a missing one`,
		);
	}
	ok(
		parseJsonLenient('{"a": NaN, "b": [Infinity, -Infinity, 1]}').b[0] ===
			null && parseJsonLenient('{"a": NaN}').a === null,
		"lenient JSON: python NaN/Infinity → null",
	);
	{
		const k = cpKinds([
			{ az: 1, el: 2 },
			{ el: -0.1, level: true },
			{ peak: "node/123" },
			{ peak: "Niesen" },
		]);
		ok(
			k.notches === 1 &&
				k.levels === 1 &&
				k.nodes === 1 &&
				k.named === 1 &&
				k.usable === 2,
			"cpKinds: notch / level / node id / named peak",
		);
		const f = cpuVariantInfo("classic-skyfirst-fasth");
		ok(
			cpuVariantInfo("classic-cascade")[0].includes("recommended") &&
				f[0].includes("HORIZON=fast"),
			"cpu variant labels",
		);
	}
	{
		// ranking: false accepts dominate, medians never rank; ties share a rank
		const mk = (fa, ca, o2, s1, med, ms) => ({
			agg: {
				primary: {
					n: 10,
					falseAccepts: fa,
					correctAccepts: ca,
					over2: o2,
					success1: s1,
					medianAbsYaw: med,
				},
			},
			medianMsAll: ms,
		});
		const r = rankMethods(
			{
				a: mk(1, 9, 0, 9, 0.1, 10),
				b: mk(0, 8, 0, 9, 0.5, 100),
				c: mk(0, 8, 0, 9, 0.2, 50),
				prior: mk(0, 0, 5, 3, 3, 0),
				d: { agg: { primary: { n: 2 } } },
			},
			10,
		);
		ok(
			r.rows.map((x) => x.method).join() === "c,b,a" &&
				r.rows[0].rank === 1 &&
				r.rows[1].rank === 1 &&
				r.rows[2].rank === 3 &&
				r.incomplete[0].method === "d",
			"rankMethods: false accepts first, ties share rank, prior excluded, incomplete listed",
		);
	}
	{
		// agreement gate: X/Y agree (accept, correct); Z: X accepted but wrong, Y rejected → escalate; W: no GT, disagree
		const P = (id, gtYaw, votes) => ({
			id,
			primaryGt: gtYaw == null ? null : "json",
			gtJson:
				gtYaw == null
					? null
					: { pose: { yaw: gtYaw, pitch: 0, roll: 0, vfov: 30 } },
			methods: Object.fromEntries(
				Object.entries(votes).map(([k, [yaw, acc]]) => [
					k,
					{
						pose: { yaw, pitch: 0, roll: 0, vfov: 30 },
						accepted: acc,
						confidence: acc ? 1 : 0,
					},
				]),
			),
		});
		const photos = [
			P("X", 10, { app: [10.2, true], "cpu:classic-cascade": [9.9, true] }),
			P("Z", 50, { app: [53, true], "cpu:classic-cascade": [53.5, false] }),
			P("W", null, { app: [0, true], "cpu:classic-cascade": [5, true] }),
		];
		const methods = { app: {}, "cpu:classic-cascade": {} };
		const e = ensembleAnalysis(photos, methods, { rows: [] });
		const g = e.agreement.find((x) => x.rule === "app + cascade");
		ok(
			g &&
				g.accepted === 1 &&
				g.escalated === 2 &&
				g.falseAccepts === 0 &&
				g.correct === 1 &&
				Math.abs(g.medianAbsYaw - 0.05) < 1e-9,
			"agreement gate: rejected poses do not vote, output = mean pose, escalation over all photos",
		);
		ok(e.oracle.n === 2 && e.oracle.within1 === 1, "oracle over GT photos");
		// Z: cascade's rejected 53.5 pose (no fallback modelled, no prior) is not an oracle candidate
		ok(
			e.oracle.perPhoto.find((x) => x.id === "Z")?.by === "app",
			"oracle never picks a pose its member rejected",
		);
	}
	{
		// GT band: 'approx' GT ±0.3° around 1° is borderline; 'good' GT has none
		ok(
			classifyErr(1.029, 0.3) === "borderline" &&
				classifyErr(0.954, 0.3) === "borderline" &&
				classifyErr(1.4, 0.3) === "wrong" &&
				classifyErr(0.5, 0.3) === "ok",
			"classifyErr: approx band",
		);
		ok(
			classifyErr(1.029, 0) === "wrong" && classifyErr(0.99, 0) === "ok",
			"classifyErr: good GT has no band",
		);
		const P = (id, q, yaw, acc) => ({
			id,
			primaryGt: "json",
			gtJson: { quality: q },
			methods: {
				m: {
					accepted: acc,
					err: { primary: { yaw, pitch: 0, roll: 0, px: 0 } },
					ms: 1,
				},
			},
		});
		const a = aggregate(
			[
				P("A", "approx", 1.03, true),
				P("B", "good", 1.03, true),
				P("C", "approx", -0.95, false),
				P("D", "approx", 0.2, true),
			],
			"m",
			"primary",
		);
		ok(
			a.falseAccepts === 1 &&
				a.falseAcceptIds[0].startsWith("B") &&
				a.borderlineAccepts === 1 &&
				a.correctAccepts === 1 &&
				a.success1 === 2 &&
				a.success1Clear === 1 &&
				a.borderlineShown === 2,
			"aggregate: borderline accepts are neither correct nor false",
		);
	}
	{
		// baseline: the default alone must be beaten by a gate on false accepts / > 2° before a gate is recommended
		const P = (id, gtYaw, votes) => ({
			id,
			primaryGt: "json",
			gtJson: {
				quality: "good",
				pose: { yaw: gtYaw, pitch: 0, roll: 0, vfov: 30 },
			},
			methods: Object.fromEntries(
				Object.entries(votes).map(([k, [yaw, acc]]) => [
					k,
					{
						pose: { yaw, pitch: 0, roll: 0, vfov: 30 },
						accepted: acc,
						confidence: 1,
					},
				]),
			),
		});
		const photos = [
			P("X", 10, { app: [10.2, true], "cpu:classic-cascade": [10.1, true] }),
			P("Y", 20, { app: [23, true], "cpu:classic-cascade": [20.1, true] }),
		];
		const methods = {
			app: { medianMsAll: 1000 },
			"cpu:classic-cascade": { medianMsAll: 900, label: "cascade" },
		};
		const ranked = {
			rows: [
				{
					method: "cpu:classic-cascade",
					rank: 1,
					n: 2,
					correctAccepts: 2,
					falseAccepts: 0,
					over2: 0,
					medianMsAll: 900,
				},
			],
		};
		const e = ensembleAnalysis(photos, methods, ranked);
		ok(
			e.baseline &&
				e.baseline.method === "cpu:classic-cascade" &&
				e.baseline.escalated === 0 &&
				e.baseline.falseAccepts === 0,
			"baseline row = default alone",
		);
		const rec = deriveRecommendation({ ranking: ranked, methods, ensemble: e });
		ok(
			/No agreement gate beats/.test(rec) && !/Safety gate:/.test(rec),
			"recommendation: a gate that does not beat the default alone is not recommended",
		);
		// confidence pick flags ties broken by member order
		ok(
			e.confidencePick.tiesBrokenByOrder === 2 &&
				e.confidencePick.picksByMember.app === 2,
			"confidence pick: ties at equal confidence are counted",
		);
	}
	{
		// threshold simulation: A accepted wrong (conf .4, 2.9° off) whose fallback is worse (4.1°); B success already
		// on its fallback (rejected); C accepted success with conf .6 (kept). Before 2/3, after 2/3, mean worsens.
		const mk = (id, conf, accepted, yaw, fb) => ({
			id,
			methods: {
				x: {
					confidence: conf,
					accepted,
					err: { primary: { yaw } },
					sim: { fallbackKind: "prior", fallbackYaw: fb },
				},
			},
		});
		const c = calibration(
			[
				mk("A", 0.4, true, 2.9, 4.1),
				mk("B", 0.001, false, 0.4, 0.4),
				mk("C", 0.6, true, 0.2, 3),
			],
			"x",
		);
		const t = c.separatingThreshold;
		ok(
			t.simulated &&
				t.above === 0.4 &&
				t.successesBefore === 2 &&
				t.successesAfter === 2 &&
				t.meanAbsYawAfter > t.meanAbsYawBefore &&
				t.changed.length === 1 &&
				t.changed[0].toAbsYaw === 4.1,
			"threshold simulation uses the fallback pose, keeps already-rejected successes",
		);
		const c2 = calibration(
			[mk("A", 0.4, true, 2.9, 0.3), mk("C", 0.6, true, 0.2, 3)],
			"x",
		);
		ok(
			c2.separatingThreshold.successesAfter === 2,
			"threshold simulation counts a good fallback as a fix",
		);
	}
	{
		let threw = false;
		try {
			parseArgs(["--run-evalcpu", "--photos", "IMG_1"]);
		} catch {
			threw = true;
		}
		ok(
			threw && !parseArgs([]).runEvalCpu,
			"evalcpu is read-only by default; --run-evalcpu refuses --photos",
		);
	}
	// Cross-check the pose port against the app's src/lib/pose.ts (via tsx).
	// (written to the OS temp dir, not the repo, so the repo-wide tsc never sees it)
	const probe = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-")),
		"selftest-pose.ts",
	);
	fs.writeFileSync(
		probe,
		`import { poseBasis, projectPoint } from ${JSON.stringify(path.join(ROOT, "src", "lib", "pose.ts"))};\nconst poses = ${JSON.stringify([P, { yaw: 213, pitch: 7, roll: -4, vfov: 55 }, { yaw: -20, pitch: -12, roll: 30, vfov: 12 }])};\nconst out = poses.map((p) => { const b = poseBasis(p); return { f: b.forward.toArray(), r: b.right.toArray(), u: b.up.toArray(), pr: projectPoint(p, 4 / 3, { x: 0, y: 0, z: 0 } as never, [1000, 3000, 200]) }; });\nconsole.log(JSON.stringify(out));\n`,
	);
	const r = await run("npx", ["tsx", probe], { timeoutMs: 60000 });
	try {
		const app = JSON.parse(r.out.trim().split("\n").at(-1));
		const poses = [
			P,
			{ yaw: 213, pitch: 7, roll: -4, vfov: 55 },
			{ yaw: -20, pitch: -12, roll: 30, vfov: 12 },
		];
		let maxd = 0;
		poses.forEach((p, i) => {
			const b2 = poseBasis(p);
			for (const [k, v] of [
				["f", b2.forward],
				["r", b2.right],
				["u", b2.up],
			])
				for (let j = 0; j < 3; j++)
					maxd = Math.max(maxd, Math.abs(app[i][k][j] - v[j]));
			const d = [1000, 3000, 200];
			const n = Math.hypot(...d);
			const mine = projectDir(
				p,
				4 / 3,
				d.map((x) => x / n),
			);
			if (app[i].pr)
				maxd = Math.max(
					maxd,
					Math.abs(app[i].pr.u - mine.u),
					Math.abs(app[i].pr.v - mine.v),
				);
		});
		ok(
			maxd < 1e-9,
			`pose port matches src/lib/pose.ts (max diff ${maxd.toExponential(1)})`,
		);
	} catch (e) {
		ok(false, `pose cross-check via tsx: ${e.message} ${tail(r.err, 300)}`);
	}
	fs.rmSync(path.dirname(probe), { recursive: true, force: true });
	// Real-data convention check: ground-truth.json prior == photos.json prior.
	const gtJ = readJson(path.join(ROOT, "data", "ground-truth.json"), {});
	const pm = readJson(path.join(ROOT, "public", "photos", "photos.json"), []);
	for (const [id, g] of Object.entries(gtJ)) {
		const m = pm.find((x) => x.id === id);
		if (!m || !g.prior) continue;
		ok(
			Math.abs(angleDiff(m.heading, g.prior.yaw)) < 0.01 &&
				Math.abs(m.pitch - g.prior.pitch) < 0.01 &&
				Math.abs(m.roll - g.prior.roll) < 0.01,
			`${id}: ground-truth.json prior matches photos.json prior (same angle convention)`,
		);
	}
	console.log(fails ? `\n${fails} FAILED` : "\nall passed");
	process.exit(fails ? 1 : 0);
}

// ─────────────────────────────── main ───────────────────────────────
const T0 = Date.now();
function parseArgs(argv) {
	const o = {
		skip: new Set(),
		only: null,
		photos: null,
		perfPhotos: null,
		appUrl: process.env.APP_URL ?? "http://localhost:3100",
		concurrency: 3,
		scale: 1,
		out: "reports",
		carry: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--skip") for (const s of next().split(",")) o.skip.add(s.trim());
		else if (a === "--only")
			o.only = new Set(
				next()
					.split(",")
					.map((s) => s.trim()),
			);
		else if (a === "--quick")
			for (const s of ["build", "evalapp", "perf"]) o.skip.add(s);
		else if (a === "--photos") o.photos = next().split(",");
		else if (a === "--perf-photos") o.perfPhotos = next().split(",");
		else if (a === "--app-url") o.appUrl = next();
		else if (a === "--concurrency") o.concurrency = Number(next());
		else if (a === "--timeout-scale") o.scale = Number(next());
		else if (a === "--out") o.out = next();
		else if (a === "--no-carry") o.carry = false;
		else if (a === "--selftest") o.selftest = true;
		else if (a === "--run-evalcpu") o.runEvalCpu = true;
		else if (a === "--run-evalapp") o.runEvalApp = true;
		else if (a === "--results")
			o.results = next()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		else if (a === "--help" || a === "-h") o.help = true;
		else throw new Error(`unknown flag ${a}`);
	}
	if (o.only) for (const s of STEPS) if (!o.only.has(s)) o.skip.add(s);
	if (o.runEvalCpu && o.photos)
		throw new Error(
			"--run-evalcpu cannot be combined with --photos: scripts/eval.ts would replace 0f's full out/eval/report.json with the subset",
		);
	return o;
}

async function main() {
	const opt = parseArgs(process.argv.slice(2));
	if (opt.help) {
		const src = fs.readFileSync(import.meta.filename, "utf8");
		console.log(
			src
				.slice(src.indexOf("/**") + 3, src.indexOf("* ── reports"))
				.replace(/^ \* ?/gm, ""),
		);
		return;
	}
	if (opt.selftest) return selftest();
	const outDir = path.resolve(ROOT, opt.out);
	const prev = opt.carry
		? readJson(path.join(outDir, "leaderboard.json"))
		: null;
	const INPUTS = {
		photos: path.join(ROOT, "public", "photos", "photos.json"),
		groundTruth: path.join(ROOT, "data", "ground-truth.json"),
		controlPoints: path.join(ROOT, "data", "control-points.json"),
	};
	const snap = () =>
		Object.fromEntries(
			Object.entries(INPUTS).map(([k, p]) => {
				try {
					const buf = fs.readFileSync(p);
					return [
						k,
						{
							mtime: new Date(fs.statSync(p).mtimeMs).toISOString(),
							sha1: crypto
								.createHash("sha1")
								.update(buf)
								.digest("hex")
								.slice(0, 12),
						},
					];
				} catch {
					return [k, null];
				}
			}),
		);
	const snapStart = snap();
	// ONE GT snapshot for the whole run: copied at start, and every score (CPU, refine, matcher, app, cp solve) uses it.
	const gtSnap = await snapshotInputs(INPUTS, outDir);
	const photosMeta = Object.fromEntries(
		(gtSnap.data.photos ?? []).map((p) => [p.id, p]),
	);
	const gtJson = gtSnap.data.groundTruth ?? {};
	const cpAll = gtSnap.data.controlPoints ?? {};
	const ids = (opt.photos ?? Object.keys(photosMeta)).sort();
	const nAll = Object.keys(photosMeta).length;
	const perfIds =
		opt.perfPhotos ??
		[ids[0], ids[ids.length >> 1], ids[ids.length - 1]].filter(
			(v, i, a) => v && a.indexOf(v) === i,
		);
	const steps = {};
	const skipped = (k) => {
		const p = prev?.steps?.[k];
		if (p && p.status !== "skipped")
			steps[k] = { ...p, stale: p.stale ?? prev.generatedAt };
		else steps[k] = { status: "skipped" };
	};
	const guard = async (k, fn, { alwaysRead = false } = {}) => {
		if (opt.skip.has(k) && !alwaysRead) return skipped(k);
		log(`step ${k}…`);
		try {
			steps[k] = await fn();
		} catch (e) {
			steps[k] = {
				status: "error",
				ms: null,
				note: String(e?.stack ?? e).slice(0, 600),
			};
		}
		if (opt.skip.has(k))
			steps[k].note =
				`${steps[k].note ? `${steps[k].note}; ` : ""}listed as skipped, but the step only reads other sessions' files, so it was read anyway`;
		log(
			`step ${k}: ${steps[k].status}${steps[k].ms != null ? ` (${(steps[k].ms / 1000).toFixed(1)} s)` : ""}`,
		);
	};

	await guard("tsc", () => stepTsc(opt.scale));
	await guard("biome", () => stepBiome(opt.scale));
	await guard("build", () => stepBuild(opt.scale));
	// evalcpu / matcher are read-only (retrying reads of files another session may be rewriting), so always read
	await guard("evalcpu", () => stepEvalCpu(opt.scale, opt.runEvalCpu, nAll), {
		alwaysRead: true,
	});
	const cpuReports = steps.evalcpu?._reports ?? {};
	await guard("matcher", () => stepMatcher(opt.results ?? [], ids), {
		alwaysRead: true,
	});
	const matcherMethods = steps.matcher?._methods ?? {};
	// eval-app.mjs is 9e's evaluator and reads the live data/: only with --run-evalapp
	if (!opt.runEvalApp) opt.skip.add("evalapp");
	await guard("evalapp", () =>
		stepEvalApp(opt.scale, opt.appUrl, opt.photos ?? []),
	);

	const snapUsed = snap();
	// Poses of CPU/matcher/GT-json methods, handed to the page so they're scored at the control points too.
	const ctxFor = {};
	for (const id of ids) {
		const meta = photosMeta[id];
		const poses = {};
		if (meta) {
			const prior = {
				yaw: meta.heading ?? 0,
				pitch: meta.pitch ?? 0,
				roll: meta.roll ?? 0,
				vfov: meta.vfov,
			};
			for (const [key, v] of Object.entries(cpuReports)) {
				const c = v.report.find((r) => r.name === id);
				if (!c?.delta) continue;
				const solved = cpuSolvedPose(prior, c);
				if (key === "eval") {
					poses.cpu = solved;
					poses["cpu-final"] = c.accepted ? solved : prior;
				} else poses[`cpu:${key}`] = c.accepted ? solved : prior;
			}
		}
		for (const [m, { rows }] of Object.entries(matcherMethods))
			if (rows[id])
				poses[m] = { ...rows[id].pose, vfov: rows[id].pose.vfov ?? meta?.vfov };
		const g = gtJson[id];
		if (g && g.quality !== "none" && Number.isFinite(g.yaw))
			poses.gtJson = {
				yaw: g.yaw,
				pitch: g.pitch,
				roll: g.roll,
				vfov: vfovFromF(g.f, g.height),
			};
		ctxFor[id] = { cp: cpAll[id] ?? null, poses };
	}
	await guard("app", () =>
		stepApp(opt.scale, opt.appUrl, ids, ctxFor, opt.concurrency),
	);
	await guard("perf", () => stepPerf(opt.scale, opt.appUrl, perfIds));

	const appResults = steps.app?.raw ?? null;
	if (steps.evalapp?.rows?.length && appResults && !steps.evalapp.stale) {
		const px = [];
		const yaw = [];
		for (const r of steps.evalapp.rows) {
			const a = appResults[r.id]?.cp;
			if (!a?.pose || r.autoPx == null) continue;
			px.push(Math.abs(a.px.app - r.autoPx));
			yaw.push(
				Math.abs(
					angleDiff(appResults[r.id].final.yaw, a.pose.yaw) - r.dYawAuto,
				),
			);
		}
		steps.evalapp.crossCheck = {
			n: px.length,
			maxAbsPxDiff: round(maxOf(px), 1),
			maxAbsYawDiff: round(maxOf(yaw), 2),
		};
	}
	const photos = buildPhotos({
		photosMeta,
		ids,
		gtJson,
		cpAll,
		cpuReports,
		matcherMethods,
		appResults,
	});
	const order = [
		"prior",
		"app",
		"app-raw",
		"cpu:classic-cascade",
		"cpu:classic-skyfirst",
		"cpu-final",
		"cpu",
	];
	const methodNames = [
		...new Set(photos.flatMap((p) => Object.keys(p.methods))),
	].sort((a, b) => {
		const grp = (m) =>
			order.includes(m)
				? order.indexOf(m)
				: m.startsWith("cpu")
					? 10
					: m.startsWith("refine")
						? 20
						: m.startsWith("matcher")
							? 30
							: 40;
		return grp(a) - grp(b) || a.localeCompare(b);
	});
	const evalSame = steps.evalcpu?.evalMatches ?? [];
	const methods = {};
	for (const m of methodNames) {
		const ext = matcherMethods[m];
		let info = METHOD_INFO[m] ?? EXT_INFO[m];
		if (m.startsWith("cpu:")) {
			const k = m.slice(4);
			const [l, d] = cpuVariantInfo(k);
			const r = cpuReports[k];
			info = [
				l,
				`${d}. 0f's out/eval-${k}/report.json (written ${r?.mtime ?? "?"}); final pose = solved if accepted, else prior; re-scored here from prior + delta`,
			];
		}
		if ((m === "cpu" || m === "cpu-final") && info)
			info = [
				`${info[0]}, out/eval`,
				`${info[1]}. out/eval/report.json = 0f's last default run (written ${cpuReports.eval?.mtime ?? "?"})${evalSame.length ? `; its results match out/eval-${evalSame.join(", out/eval-")}` : ""}`,
			];
		const [label, description] = info ?? [
			m,
			`external results from ${ext?.file ?? "?"} (written ${ext?.mtime ?? "?"}); pose as given in the file, whether or not it was accepted`,
		];
		methods[m] = {
			label,
			description,
			...(ext ? { external: true, file: ext.file, fileMtime: ext.mtime } : {}),
			medianMsAll: round(median(photos.map((p) => p.methods[m]?.ms)), 0),
			agg: {
				primary: aggregate(photos, m, "primary"),
				json: aggregate(photos, m, "json"),
				cp: aggregate(photos, m, "cp"),
			},
			calibration: m === "prior" ? null : calibration(photos, m),
		};
	}
	const gt = {
		json: photos.filter((p) => p.gtJson).map((p) => p.id),
		cp: photos.filter((p) => p.gtCp?.pose).map((p) => p.id),
	};
	gt.either = photos.filter((p) => p.primaryGt).map((p) => p.id);
	gt.missing = photos.filter((p) => !p.primaryGt).map((p) => p.id);
	gt.bandDeg = GT_BAND_DEG;
	gt.banded = photos
		.filter((p) => p.primaryGt && gtBandOf(p) > 0)
		.map((p) => p.id);
	// app vs the recommended CPU pipeline (cascade), else out/eval's cpu-final
	const disB = methods["cpu:classic-cascade"]
		? "cpu:classic-cascade"
		: "cpu-final";
	const disagreement = [];
	for (const p of photos) {
		const a = p.methods.app?.pose;
		const c = p.methods[disB]?.pose;
		if (!a || !c) continue;
		const dy = angleDiff(a.yaw, c.yaw);
		if (Math.abs(dy) <= 1) continue;
		const ea = p.methods.app.err.primary;
		const ec = p.methods[disB].err.primary;
		disagreement.push({
			id: p.id,
			a: "app",
			b: disB,
			yaw: round(dy, 2),
			pitch: round(a.pitch - c.pitch, 2),
			hasGt: !!p.primaryGt,
			closer:
				ea && ec ? (Math.abs(ea.yaw) < Math.abs(ec.yaw) ? "app" : disB) : null,
		});
	}
	for (const s of Object.values(steps))
		for (const k of Object.keys(s)) if (k.startsWith("_")) delete s[k];
	const snapEnd = snap();
	// live GT edits during the run do not affect the scores (snapshot), but are recorded
	const changed = Object.keys(INPUTS)
		.filter((k) => gtSnap.files[k]?.sha1 !== snapEnd[k]?.sha1)
		.map(
			(k) =>
				`${path.relative(ROOT, INPUTS[k])} (live copy changed after the snapshot)`,
		);
	for (const { file, mtimeMs } of Object.values(matcherMethods))
		for (const f of file.split(", ")) {
			if (f.includes("*")) continue;
			const now = mtimeOf(path.join(ROOT, f));
			if (now != null && mtimeMs && now > mtimeMs + 1) changed.push(f);
		}
	for (const r of steps.evalcpu?.reports ?? []) {
		const now = mtimeOf(path.join(ROOT, r.file));
		if (now != null && r.mtime && isoOf(now) !== r.mtime) changed.push(r.file);
	}
	// every input with its age (minutes before this run finished)
	const inputFiles = [
		...Object.entries(gtSnap.files).map(([k, f]) => ({
			file: path.relative(ROOT, INPUTS[k]),
			owner: ownerOf(path.relative(ROOT, INPUTS[k])),
			mtime: f.sourceMtime,
			ageMin: ageMin(Date.parse(f.sourceMtime)),
			note: `snapshot sha1 ${f.sha1} → ${path.relative(ROOT, gtSnap.dir)}/`,
		})),
		...(steps.evalcpu?.reports ?? []).map((r) => ({
			file: r.file,
			owner: "0f",
			mtime: r.mtime,
			ageMin: r.ageMin,
			note: `${r.rows} rows${r.reads > 1 ? `, ${r.reads} reads` : ""}${r.warning ? `, WARNING ${r.warning}` : ""}`,
		})),
		...(steps.matcher?.files ?? []).map((f) => ({
			file: f.file,
			owner: ownerOf(f.file.replace(/<id>.*$/, "")),
			mtime: f.mtime ?? null,
			ageMin: f.ageMin ?? null,
			note: f.error
				? `ERROR ${f.error}`
				: f.skipped
					? `ignored: ${f.skipped}`
					: `${Object.entries(f.methods ?? {})
							.map(([k, n]) => `${k} ${n}`)
							.join(
								", ",
							)}${f.reads > 1 ? `, ${f.reads} reads` : ""}${f.warning ? `, WARNING ${f.warning}` : ""}`,
		})),
		...(steps.matcher?.reported ?? [])
			.slice(0, 1)
			.map((r) => ({
				file: r.source,
				owner: "f0",
				mtime: r.mtime,
				ageMin: ageMin(Date.parse(r.mtime)),
				note: "summary lines, not re-scored (cross-check only)",
			})),
		...(steps.app?.stale
			? [
					{
						file: "app step (own Playwright pass)",
						owner: "leaderboard",
						mtime: steps.app.stale,
						ageMin: ageMin(Date.parse(steps.app.stale)),
						note: "carried over from a previous run",
					},
				]
			: []),
		...(steps.perf?.stale
			? [
					{
						file: "perf step (own Playwright pass)",
						owner: "leaderboard",
						mtime: steps.perf.stale,
						ageMin: ageMin(Date.parse(steps.perf.stale)),
						note: "carried over from a previous run",
					},
				]
			: []),
	];
	const L = {
		schemaVersion: 2,
		generatedAt: new Date().toISOString(),
		durationMs: Date.now() - T0,
		appUrl: opt.appUrl,
		argv: process.argv.slice(2),
		targets: TARGETS,
		steps,
		inputs: {
			start: snapStart,
			used: snapUsed,
			end: snapEnd,
			changed,
			gtSnapshot: {
				dir: path.relative(ROOT, gtSnap.dir),
				takenAt: gtSnap.takenAt,
				files: gtSnap.files,
			},
			files: inputFiles,
		},
		gt,
		photos,
		methods,
		ranking: null,
		ensemble: null,
		recommendation: null,
		disagreement,
		blocking: [],
	};
	// out/eval/ duplicates a variant (0f's last run) → rank the named variant only
	L.ranking = rankMethods(
		methods,
		gt.either.length,
		evalSame.length ? ["cpu-final"] : [],
	);
	if (evalSame.length)
		L.ranking.duplicates = [
			{ method: "cpu-final", sameAs: evalSame.map((k) => `cpu:${k}`) },
		];
	L.ensemble = ensembleAnalysis(photos, methods, L.ranking);
	L.recommendation = deriveRecommendation(L);
	L.blocking = deriveBlocking(L);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(
		path.join(outDir, "leaderboard.json"),
		`${JSON.stringify(L, null, 1)}\n`,
	);
	fs.writeFileSync(path.join(outDir, "leaderboard.md"), renderMd(L));
	log(
		`wrote ${path.relative(ROOT, path.join(outDir, "leaderboard.md"))} and leaderboard.json`,
	);
	if (L.recommendation)
		console.log(`  Recommended: ${L.recommendation.replace(/\*\*/g, "")}`);
	for (const b of L.blocking) console.log(`  - ${b.replace(/\*\*/g, "")}`);
}

/**
 * Copies photos.json, ground-truth.json and control-points.json ONCE into <gt-snapshot>/ (with a manifest of
 * source mtimes and sha1s) and returns the parsed copies. Reads retry if a file is mid-rewrite (unparseable).
 * The default --out (reports) snapshots to out/lead/leaderboard/gt-snapshot/; any other --out gets its own.
 */
async function snapshotInputs(INPUTS, outDir) {
	const dir =
		path.resolve(ROOT, outDir) === path.join(ROOT, "reports")
			? path.join(MY_DIR, "gt-snapshot")
			: path.join(outDir, "gt-snapshot");
	fs.mkdirSync(dir, { recursive: true });
	const files = {};
	const data = {};
	for (const [k, p] of Object.entries(INPUTS)) {
		const r = await readJsonStable(p, {
			validate: (j) => (j && typeof j === "object" ? true : "empty"),
		});
		if (!r.json) {
			files[k] = null;
			continue;
		}
		const buf = fs.readFileSync(p);
		// write exactly what was parsed (re-serialised only if the file changed between parse and copy)
		const parsedTxt = JSON.stringify(r.json);
		const same = (() => {
			try {
				return JSON.stringify(JSON.parse(buf.toString("utf8"))) === parsedTxt;
			} catch {
				return false;
			}
		})();
		const out = same
			? buf
			: Buffer.from(`${JSON.stringify(r.json, null, 1)}\n`);
		fs.writeFileSync(path.join(dir, path.basename(p)), out);
		files[k] = {
			source: path.relative(ROOT, p),
			sourceMtime: isoOf(r.mtimeMs),
			sha1: crypto.createHash("sha1").update(out).digest("hex").slice(0, 12),
			bytes: out.length,
		};
		data[k] = r.json;
	}
	const takenAt = new Date().toISOString();
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		`${JSON.stringify({ takenAt, note: "GT snapshot used for every score in this leaderboard run", files }, null, 1)}\n`,
	);
	return { dir, takenAt, files, data };
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
