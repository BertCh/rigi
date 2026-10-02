// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node (no browser) twin of the certified-f32 precision gate (scripts/gpu/precision-gate.mjs): the
// horizon and align stages under horizonPrecision / alignPrecision = f64 vs certified-f32, on a native
// WebGPU device (Dawn, the `webgpu` npm package) adopted as the compute device, scored with the browser
// gate's own scoring (precision-gate-score.mjs: blind-verified accept quality, identity, noise floor).
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/precision-gate-node.ts [--stage both|horizon|align]
//       [--ids a,b | --limit N] [--seeds full|lite] [--out out/gpu/precision-gate-node]
//       [--manifest tools/bench/data/manifest.json] [--split tools/bench/split.json]
//   2-photo tooling smoke (a unit test of this script, NOT the gate):
//       DAWN_DIR=… npx tsx scripts/gpu/precision-gate-node.ts --limit 2 --seeds lite
//
// Data: the FROZEN dev split only (tools/bench/split.json "dev", read-only; --ids outside it are
// refused; the spent test half and data_v3 are never read) joined to the gitignored wild manifest
// (tools/bench/data: manifest.json + photos). Condition "given": the manifest heading is the yaw prior
// when there is one (yaw known), else 360° yaw seeds; gravity is unknown (pitch seeds), focal from
// focal35mm (else hfov seeds), as tools/bench/harness/run.ts condPrior + runApp.
//
// Design (as the browser gate): per photo ONE scene (terrain, mosaics) and three modes run in this order
// on it,
//   base   horizonPrecision=f64            alignPrecision=f64
//   cand   the --stage(s) certified-f32    (the other stage f64)
//   base2  f64 again: the run-to-run noise floor of the baseline
// Per mode: the 360° horizon is marched on the GPU (computeHorizonGpu with the mode's precision) and
// turned to ENU directions (skylineDirs), then every seed runs autoAlignAsync(prior, aspect, dirs, edge,
// 25, {alignPrecision}) and the harness wrapper decides (best total over seeds, confidence from the
// margin, acceptRule). Compared: accept / reject sets, false accepts vs the blind verdicts (the wild
// ground truth: precision-gate-score.mjs loadVerifiedPoses), pose deltas, identity bit for bit, and
// which certified paths actually ran (a cand that fell back everywhere is INCONCLUSIVE, not PASS).
//
// What is NOT the browser gate: no rendered silhouette re-rank (total = the autoAlign score, sil null),
// no foreground mask, the edge map is the CPU edgeMapFromPixels of a @napi-rs/canvas 512 px decode (not
// Chrome's drawImage), DEM tiles from .cache through demTileLoaderNode, a full 360° horizon even for
// photos with a heading, and the GT-12 eval arm is not run. So its verdict is evidence for the batch
// pass, not a replacement for scripts/gpu/precision-gate.mjs.
//
// Output: <out>/results.json (every row, every mode, raw seeds), <out>/summary.json, <out>/summary.md.
// Exit: 0 PASS, 1 FAIL, 3 INCONCLUSIVE, 4 NEEDS-VERIFY, 2 usage / no GPU.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { edgeMapFg, edgeMapFromPixels } from "../../src/lib/align";
import { vfovFromFocal, vfovFromHfov } from "../../src/lib/camera";
import { MAPTERHORN } from "../../src/lib/dem";
import { setFlagOverride } from "../../src/lib/flags";
import { loadScene } from "../../src/lib/geo/pipeline";
import { REFRACTION_K } from "../../src/lib/geodesy";
import * as alignGpu from "../../src/lib/gpu/align";
import { adoptRenderDevice, gpuEnabled } from "../../src/lib/gpu/device";
import {
	certElevationStats,
	computeHorizonGpu,
} from "../../src/lib/gpu/horizon";
import {
	type HorizonPrecision,
	skylineDirs,
} from "../../src/lib/gpu/horizon/certified";
import { mosaicsFromSampler } from "../../src/lib/horizon-fast/march";
import { demTileLoaderNode, loadRGBA } from "../lib/node-io";
import {
	decide,
	EXIT,
	loadVerifiedPoses,
	nearPose,
	scorePhoto,
} from "./precision-gate-score.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const stage = opt("stage", "both") as "both" | "horizon" | "align";
const seedMode = opt("seeds", "full") as "full" | "lite";
const outDir = path.resolve(
	ROOT,
	opt("out", "out/gpu/precision-gate-node") as string,
);
const manifestPath = path.resolve(
	ROOT,
	opt("manifest", "tools/bench/data/manifest.json") as string,
);
const splitPath = path.resolve(
	ROOT,
	opt("split", "tools/bench/split.json") as string,
);
const limit = opt("limit") ? Number(opt("limit")) : null;
if (
	!["both", "horizon", "align"].includes(stage) ||
	!["full", "lite"].includes(seedMode)
) {
	console.error("usage: --stage both|horizon|align, --seeds full|lite");
	process.exit(2);
}

type Pose = { yaw: number; pitch: number; roll: number; vfov: number };
type Entry = {
	id: string;
	lat: number;
	lon: number;
	altitudeM?: number | null;
	headingDeg?: number | null;
	focal35mm?: number | null;
	width: number;
	height: number;
};
type Mode = {
	name: "base" | "cand" | "base2";
	horizonPrecision: HorizonPrecision;
	alignPrecision: HorizonPrecision;
};
const CERT = "certified-f32" as const;
const MODES: Mode[] = [
	{ name: "base", horizonPrecision: "f64", alignPrecision: "f64" },
	{
		name: "cand",
		horizonPrecision: stage === "align" ? "f64" : CERT,
		alignPrecision: stage === "horizon" ? "f64" : CERT,
	},
	{ name: "base2", horizonPrecision: "f64", alignPrecision: "f64" },
];

// the harness's seeds (tools/bench/harness/run.ts); lite keeps a 3-yaw, one-pitch, one-focal subset
const YAW_SEEDS =
	seedMode === "lite"
		? [0, 120, 240]
		: [0, 40, 80, 120, 160, 200, 240, 280, 320];
const PITCH_SEEDS = seedMode === "lite" ? [0] : [-8, 0, 8];
const HFOV_SEEDS = seedMode === "lite" ? [50] : [40, 50, 65];
const WORK_WIDTH = 512;
const MAX_DISTANCE = 120_000;
const STEP = 0.05;

const dang = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

async function dawnDevice(): Promise<Device | null> {
	const dir = process.env.DAWN_DIR;
	if (!dir) return null;
	const { create, globals } = await import(
		pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu: create([]), userAgent: "node" },
		configurable: true,
	});
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	return luma.createDevice({
		type: "webgpu",
		adapters: [webgpuAdapter],
		createCanvasContext: false,
	} as never);
}

/** The harness's acceptRule (tools/bench/harness/run.ts). */
function acceptRule(
	conf: number,
	pose: Pose,
	alts: { pose: Pose }[],
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

type Run = {
	prior: Pose;
	pose: Pose;
	score: number;
	confidence: number;
	alternatives: { pose: Pose; score: number; total: number; sil: null }[];
	precision: {
		alignRequested: string;
		alignPath: string | null;
		alignReason?: string;
	};
};

/** tools/bench/harness/run.ts decideApp, without the silhouette re-rank (total = score). */
function decideApp(
	runs: Run[],
	nativeIdx: number,
	nativePrior: Pose,
	allowNear: boolean,
) {
	const nat = runs[nativeIdx >= 0 ? nativeIdx : 0];
	const natAcc = acceptRule(
		nat.confidence,
		nat.pose,
		nat.alternatives,
		nat.prior,
		allowNear,
	);
	const alts = runs
		.flatMap((x, i) => x.alternatives.map((a) => ({ ...a, run: i })))
		.sort((a, b) => b.total - a.total);
	const best = alts[0];
	let pose: Pose | null = null;
	let confidence = 0;
	let acc: { kind: string; shown: Pose } = {
		kind: "failed",
		shown: nativePrior,
	};
	if (best) {
		pose = best.pose;
		const second = alts.find(
			(a) => Math.abs(dang(a.pose.yaw, best.pose.yaw)) > 3,
		);
		const margin = second
			? (best.total - second.total) / Math.max(Math.abs(best.total), 1e-3)
			: 1;
		confidence = clamp01(margin * 4) * clamp01(best.score * 2.5);
		acc = acceptRule(
			confidence,
			best.pose,
			runs[best.run].alternatives,
			runs[best.run].prior,
			allowNear,
		);
	}
	return {
		pose,
		shownPose: acc.shown,
		accepted: acc.kind !== "prior" && acc.kind !== "failed",
		acceptKind: acc.kind,
		confidence,
		native: {
			pose: nat.pose,
			accepted: natAcc.kind !== "prior",
			acceptKind: natAcc.kind,
		},
	};
}

const poseDelta = (a: Pose | null, b: Pose | null) =>
	a && b
		? {
				yaw: Math.abs(dang(a.yaw, b.yaw)),
				pitch: Math.abs(a.pitch - b.pitch),
				roll: Math.abs(a.roll - b.roll),
				vfov: Math.abs(a.vfov - b.vfov),
			}
		: null;

/** FNV-1a over the float bits: a cheap identity hash of the horizon directions. */
function hashFloats(a: Float32Array) {
	const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
	let h = 0x811c9dc5;
	for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193) >>> 0;
	return h.toString(16);
}

type ModeRow = {
	pose: Pose | null;
	runs: Run[];
	horizon: { dirsHash: string };
};

async function main() {
	const device = await dawnDevice();
	if (!device) {
		console.error(
			"no WebGPU device: set DAWN_DIR to a directory with `npm i webgpu@0.3.0`",
		);
		process.exit(2);
	}
	adoptRenderDevice(device);
	if (!gpuEnabled()) {
		console.error("gpuEnabled() is false after adopting the Dawn device");
		process.exit(2);
	}
	const split = readJson(splitPath) as { dev: string[] };
	const manifest = readJson(manifestPath) as Entry[];
	const byId = new Map(manifest.map((e) => [e.id, e]));
	const wanted = opt("ids")?.split(",");
	if (wanted) {
		const outside = wanted.filter((id) => !split.dev.includes(id));
		if (outside.length) {
			console.error(
				`refusing ids outside the frozen dev split: ${outside.join(",")}`,
			);
			process.exit(2);
		}
	}
	let ids = (wanted ?? split.dev).filter((id) => byId.has(id));
	if (limit) ids = ids.slice(0, limit);
	const verified = loadVerifiedPoses(ROOT);
	const loadTile = demTileLoaderNode(MAPTERHORN);
	const results: Record<string, unknown>[] = [];
	const rows: ReturnType<typeof scorePhoto>[] = [];
	const totals = { seeds: 0, alignCert: 0, horizonCert: 0, marches: 0 };
	const extra: Record<string, unknown> = {};

	for (const id of ids) {
		const t0 = Date.now();
		const e = byId.get(id) as Entry;
		const file = path.join(path.dirname(manifestPath), "photos", `${id}.jpg`);
		try {
			if (!fs.existsSync(file)) throw new Error("no photo file");
			const yawKnown = e.headingDeg != null && Number.isFinite(e.headingDeg);
			const focalKnown = !!e.focal35mm;
			const vfovs = focalKnown
				? [
						vfovFromFocal(
							((e.focal35mm as number) * Math.hypot(e.width, e.height)) /
								43.2666,
							e.height,
						),
					]
				: HFOV_SEEDS.map((h) => vfovFromHfov(h, e.width, e.height));
			const yaws = yawKnown ? [e.headingDeg as number] : YAW_SEEDS;
			const priors: Pose[] = [];
			for (const v of vfovs)
				for (const y of yaws)
					for (const p of PITCH_SEEDS)
						priors.push({ yaw: y, pitch: p, roll: 0, vfov: v });
			const nativePrior: Pose = {
				yaw: e.headingDeg ?? 0,
				pitch: 0,
				roll: 0,
				vfov: focalKnown ? vfovs[0] : vfovFromHfov(50, e.width, e.height),
			};
			const nativeIdx = priors.findIndex(
				(p) =>
					Math.abs(dang(p.yaw, nativePrior.yaw)) < 1e-9 &&
					p.pitch === 0 &&
					Math.abs(p.vfov - nativePrior.vfov) < 1e-6,
			);
			// the photo and its edge map, once (the same input for every mode)
			const img = await loadRGBA(file, WORK_WIDTH);
			const fg = edgeMapFg(img.width, img.height, null);
			const rgb = new Uint8ClampedArray(img.data);
			const edge = edgeMapFromPixels(rgb, img.width, img.height, fg);
			edge.rgb = rgb;
			const aspect = img.width / img.height;
			// the scene, once: terrain and mosaics
			const { terrain, eye } = await loadScene(
				e.lat,
				e.lon,
				e.altitudeM ?? null,
				MAPTERHORN,
				loadTile,
			);
			const mosaics = mosaicsFromSampler(terrain, e.lat, e.lon, MAX_DISTANCE);

			const modes: Record<string, unknown> = {};
			for (const m of MODES) {
				setFlagOverride("horizonPrecision", m.horizonPrecision);
				setFlagOverride("alignPrecision", m.alignPrecision);
				const [prof] = await computeHorizonGpu(
					device,
					mosaics,
					[{ lat: e.lat, lon: e.lon, h: eye }],
					{
						step: STEP,
						k: REFRACTION_K,
						maxDistance: MAX_DISTANCE,
						minDistance: 2,
						noRidges: true,
						precision: m.horizonPrecision,
					},
				);
				const elev = certElevationStats.get(prof);
				const { dirs, stats: dirStats } = await skylineDirs(
					device,
					prof,
					{ lat: e.lat, lon: e.lon, k: REFRACTION_K },
					eye,
					m.horizonPrecision,
				);
				const horizonCertified =
					m.horizonPrecision === CERT &&
					!dirStats.fellBack &&
					!elev?.fellBack &&
					dirStats.precision === CERT;
				const runs: Run[] = [];
				for (const prior of priors) {
					const r = await alignGpu.autoAlignAsync(
						prior,
						aspect,
						dirs,
						edge,
						25,
						{ alignPrecision: m.alignPrecision },
					);
					const t = alignGpu.lastAlignTiming;
					runs.push({
						prior,
						pose: r.pose,
						score: r.score,
						confidence: r.confidence,
						alternatives: (r.alternatives ?? []).map((a) => ({
							pose: a.pose,
							score: a.score,
							total: a.score,
							sil: null,
						})),
						precision: {
							alignRequested: m.alignPrecision,
							alignPath: t?.cert?.path ?? null,
							...(t?.cert?.reason
								? { alignReason: String(t.cert.reason) }
								: {}),
						},
					});
				}
				const decision = decideApp(runs, nativeIdx, nativePrior, false);
				modes[m.name] = {
					...decision,
					runs,
					horizon: {
						mode: m.horizonPrecision,
						certified: horizonCertified,
						ties: dirStats.ties,
						fellBack: dirStats.fellBack ?? elev?.fellBack ?? null,
						dirsHash: hashFloats(dirs),
					},
				};
				if (m.name === "cand") {
					totals.seeds += runs.length;
					totals.alignCert += runs.filter(
						(x) => x.precision.alignPath === CERT,
					).length;
					totals.marches += 1;
					if (horizonCertified) totals.horizonCert += 1;
				}
			}
			const row = scorePhoto(id, modes as never, verified);
			const mb = modes.base as ModeRow;
			const mc = modes.cand as ModeRow;
			const m2 = modes.base2 as ModeRow;
			// pose deltas: the decided pose, and the worst seed's best pose
			extra[id] = {
				poseDelta: poseDelta(mb.pose, mc.pose),
				maxSeedDelta: mb.runs.reduce(
					(acc, r, i) => {
						const d = poseDelta(r.pose, mc.runs[i].pose);
						return d
							? {
									yaw: Math.max(acc.yaw, d.yaw),
									pitch: Math.max(acc.pitch, d.pitch),
									roll: Math.max(acc.roll, d.roll),
									vfov: Math.max(acc.vfov, d.vfov),
								}
							: acc;
					},
					{ yaw: 0, pitch: 0, roll: 0, vfov: 0 },
				),
				horizonDirsIdentical: mb.horizon.dirsHash === mc.horizon.dirsHash,
				horizonNoise: mb.horizon.dirsHash !== m2.horizon.dirsHash,
				sameAcceptedPose:
					mb.pose && mc.pose ? nearPose(mb.pose, mc.pose) : mb.pose === mc.pose,
			};
			rows.push(row);
			results.push({ id, ok: true, modes, seeds: priors.length });
			console.error(
				`${id} [${((Date.now() - t0) / 1000).toFixed(0)} s] ${row.status}: base ${row.quality.base.kind}, cand ${row.quality.cand.kind} (${row.quality.cand.verdict ?? "-"}) ${row.issues.join("; ")}`,
			);
		} catch (err) {
			rows.push({ id, status: "error", issues: [String(err)] } as never);
			results.push({ id, ok: false, error: String(err) });
			console.error(`${id}: ERROR ${String(err).slice(0, 160)}`);
		}
	}

	const vacuous: string[] = [];
	if (MODES[1].alignPrecision === CERT && totals.alignCert === 0)
		vacuous.push("align: no seed took the certified path");
	if (MODES[1].horizonPrecision === CERT && totals.horizonCert === 0)
		vacuous.push("horizon: no march took the certified path");
	const d = decide({ rows, evalArm: null, vacuous });
	const summary = {
		runner: "node-dawn",
		stage,
		seeds: seedMode,
		modes: MODES,
		photos: ids.length,
		verifiedPoses: verified.length,
		certified: totals,
		vacuous,
		...d,
		extra,
		rows,
	};
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results));
	fs.writeFileSync(
		path.join(outDir, "summary.json"),
		JSON.stringify(summary, null, 1),
	);
	const q = (c: Record<string, number>) =>
		`${c.accepts} accepts: ${c.correct} correct, ${c.wrong} wrong, ${c.unsure} unsure, ${c.unverified} unverified`;
	const fmt = (x: unknown) => {
		const p = (x as { poseDelta?: Record<string, number> } | undefined)
			?.poseDelta;
		return p
			? `${p.yaw.toFixed(3)}/${p.pitch.toFixed(3)}/${p.roll.toFixed(3)}/${p.vfov.toFixed(3)}`
			: "-";
	};
	const ids2 = (f: (r: (typeof rows)[number]) => boolean) =>
		rows
			.filter(f)
			.map((r) => r.id)
			.join(", ") || "none";
	const md = [
		`# certified-f32 precision gate (node, Dawn): ${d.verdict}`,
		"",
		`stage ${stage}, ${ids.length} dev photos (frozen split, wild manifest), seeds ${seedMode}; modes ${MODES.map((m) => `${m.name} ${m.horizonPrecision}/${m.alignPrecision}`).join(", ")}; ${verified.length} blind-verified poses. No silhouette re-rank, no GT-12 arm: evidence for the batch pass, not the browser gate.`,
		"",
		...(d.reasons.length ? [`Reasons: ${d.reasons.join("; ")}`, ""] : []),
		`- quality, base (f64): ${q(d.quality.base)}`,
		`- quality, cand: ${q(d.quality.cand)}`,
		`- quality, base2 (f64): ${q(d.quality.base2)}`,
		`- false accepts vs blind verdicts (cand wrong, f64 not): ${ids2((r) => !!r.falseAccept)}`,
		`- accept set: base ${rows.filter((r) => r.quality?.base.accepted).length}, cand ${rows.filter((r) => r.quality?.cand.accepted).length}, base2 ${rows.filter((r) => r.quality?.base2?.accepted).length}; new accepts ${ids2((r) => !!r.newAccept)}; lost accepts ${ids2((r) => !!r.lostAccept)}`,
		`- new accepts without a blind verdict: ${d.unverifiedNewAccepts.join(", ") || "none"}`,
		`- identity (reported): ${d.identity.identical} identical, ${d.identity.withinNoise} within f64 noise, differs: ${d.identity.differs.join(", ") || "none"}; f64 noisy (base != base2): ${d.identity.noisy.join(", ") || "none"}`,
		`- certified path taken: align ${totals.alignCert}/${totals.seeds} seeds, horizon ${totals.horizonCert}/${totals.marches} marches${vacuous.length ? ` (${vacuous.join("; ")})` : ""}`,
		`- errors: ${d.errors.join(", ") || "none"}`,
		"",
		"| photo | status | base | cand | cand verdict | pose delta yaw/pitch/roll/vfov | issues |",
		"|---|---|---|---|---|---|---|",
		...rows.map(
			(x) =>
				`| ${x.id} | ${x.status} | ${x.quality?.base.kind ?? "-"} | ${x.quality?.cand.kind ?? "-"} | ${x.quality?.cand.verdict ?? "-"} | ${fmt(extra[x.id])} | ${x.issues.join("; ")} |`,
		),
		"",
	].join("\n");
	fs.writeFileSync(path.join(outDir, "summary.md"), `${md}\n`);
	console.log(md);
	console.error(`wrote ${outDir}`);
	device.destroy();
	// Dawn keeps the event loop alive
	process.exit(EXIT[d.verdict as keyof typeof EXIT]);
}

await main();
