#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Wild-set / GT gate for the certified-f32 stages (precision policy P1; WAG W3.1 horizon, W3.3 align),
// judged on QUALITY (user, 2026-10-01): certified-f32 is the default since 3225064, and it stays so
// unless this gate shows it worse than f64.
//
//   node scripts/gpu/precision-gate.mjs [--stage both|horizon|align] [--renderer webgpu|deck|auto|both]
//       [--ids a,b | --limit N] [--chunk N] [--out DIR] [--no-eval] [--no-noise] [--settle-ms N]
//       [--diff-only] [--no-lock] [--manifest tools/bench/data/manifest.json]
//       [--split tools/bench/split.json] [--lock-script PATH]
//   Needs the dev server (APP_URL, default http://localhost:3100), the gitignored wild set
//   (tools/bench/data: manifest.json + photos), the harness's tools/matcher/.venv (photo normalising)
//   and, for the eval arm, data/control-points.json. 2-photo smoke: --limit 2 --no-eval.
//
// Why one page per photo. The first version ran base and cand as two separate harness runs and
// demanded bit identity. It could never pass: the f64 baseline itself differed between runs (wave 3:
// 7/8 deck, 21/22 webgpu of the differing photos were f64 vs f64). Two causes, both fixed with this
// version: (1) the first terrain-pass draw of a fresh page can come back blank, so the first seed's
// top silhouette finalist scored sil 0 on one run and its real score on another (now redrawn:
// deck/silhouette-mask.ts redrawIfBlank); (2) a full-terrain load that timed out left a row computed on
// the initial terrain (now an error row: render_worker ensureFullTerrain, DeckEngine.loadFullTerrain;
// and the stall itself is fixed: terrain-stream.ts gives up on an always-failing tile, the tile cache
// times out a stalled fetch). And the design no longer depends on run-to-run determinism at all:
//
// What it runs: the FROZEN dev split (tools/bench/split.json "dev", read-only; the test half is spent
// and never used here) through the wild harness's "app" method (tools/bench/harness/run.ts, condition
// "given": the app's own autoAlign with the harness's seed wrapper and accept rule), once per photo
// and renderer, with every precision mode on the SAME page and terrain (HARNESS_ALIGN_MODES → the
// render worker's align "modes": the precision is switched per mode through the page's live flag
// overrides, the horizon re-traced under it, all seeds re-run):
//   base   ?horizonPrecision=f64&alignPrecision=f64
//   cand   certified-f32 for the --stage(s) (the defaults)
//   base2  f64 again: the noise floor (what f64 vs f64 differs by on one page; --no-noise drops it)
// The terrain stream is let settle (--settle-ms, default 500) before each mode, and each mode records
// the terrain and horizon it ran on (hashes), so a mode that ran on other data is visible.
//
// Arms and rule (precision-gate-score.mjs):
//   quality  each mode's accepted poses against the wild set's blind verdicts (tools/bench/gt/wild
//            verify_v2, t5/verify_v2, gt/final; same pose = within VERIFY_TOL): verified-correct /
//            -wrong / unsure / unverified accepts per mode.
//   eval     (default on; --no-eval) the GT-12 arm: scripts/eval-app.mjs on data/control-points.json,
//            f64 vs the defaults: photos within 1° yaw, median px error.
//   identity reported, not gated: identical / within the f64 noise / differs.
//   FAIL  cand has more verified-wrong accepts or fewer verified-correct ones, or on any one photo
//         accepts a verified-wrong pose / loses a verified-correct accept that f64 (base and base2)
//         did not, or fewer GT-12 photos within 1°, or a GT-12 median error > 0.5 px worse.
//   NEEDS-VERIFY (exit 4)  cand accepts a pose f64 did not show (new, or another pose) and no blind
//         verdict calls it correct or wrong (a potential false accept under the frozen
//         0-false-accept rule until blind-verified).
//   INCONCLUSIVE (exit 3)  a photo errored, an eval run is missing, or cand never took a certified
//         path (every call fell back: nothing was tested).
//   PASS  otherwise.
// The frozen rule files (tools/bench/t5/RULE_FROZEN*, split.json) are only read.
//
// Full terrain: photos without a heading ask for it (loadFullTerrain), on both engines. A load that
// fails twice (fresh page on the retry) is an error row, never a row on the initial terrain.
// The fused / product-rule arm (matcher service, the worker's "render" command) is not run here.
//
// Output: <out>/<renderer>/results (harness rows, with every mode), <out>/eval-<renderer>-{base,cand}
// .json, <out>/summary.json, <out>/summary.md.
// Exit: 0 PASS, 1 FAIL, 3 INCONCLUSIVE, 4 NEEDS-VERIFY, 2 usage / setup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	decide,
	EXIT,
	loadVerifiedPoses,
	scorePhoto,
} from "./precision-gate-score.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const fail = (msg) => {
	console.error(`[precision-gate] ${msg}`);
	process.exit(2);
};
const log = (...a) => console.error("[precision-gate]", ...a);

const stage = opt("stage", "both");
if (!["both", "horizon", "align"].includes(stage))
	fail(`--stage must be both, horizon or align (got ${stage})`);
const rendererOpt = opt("renderer", "both");
if (!["webgpu", "deck", "auto", "both"].includes(rendererOpt))
	fail(`--renderer must be webgpu, deck, auto or both (got ${rendererOpt})`);
const renderers = rendererOpt === "both" ? ["deck", "webgpu"] : [rendererOpt];
const manifest = path.resolve(
	ROOT,
	opt("manifest", "tools/bench/data/manifest.json"),
);
const splitFile = path.resolve(ROOT, opt("split", "tools/bench/split.json"));
const chunk = Math.max(1, Number(opt("chunk", "5")));
const settleMs = Math.max(0, Number(opt("settle-ms", "500")));
const lockScript = path.resolve(
	ROOT,
	opt("lock-script", "scripts/gpu/with-render-lock.mjs"),
);
const out = path.resolve(
	ROOT,
	opt(
		"out",
		path.join(
			"out/gpu/precision-gate",
			new Date().toISOString().replace(/[:.]/g, "-"),
		),
	),
);
const appUrl = process.env.APP_URL ?? "http://localhost:3100";
const withEval = !has("no-eval");

const BASE = { horizonPrecision: "f64", alignPrecision: "f64" };
const CAND = {
	horizonPrecision: stage === "align" ? "f64" : "certified-f32",
	alignPrecision: stage === "horizon" ? "f64" : "certified-f32",
};
const MODES = [
	{ name: "base", ...BASE },
	{ name: "cand", ...CAND },
	...(has("no-noise") ? [] : [{ name: "base2", ...BASE }]),
];

// ---------- the photo list: the frozen dev split ∩ the manifest ----------
if (!fs.existsSync(manifest))
	fail(`no wild-set manifest at ${manifest} (gitignored tools/bench/data)`);
const split = JSON.parse(fs.readFileSync(splitFile, "utf8"));
const raw = JSON.parse(fs.readFileSync(manifest, "utf8"));
const entries = Array.isArray(raw) ? raw : raw.photos;
const inManifest = new Set(entries.map((e) => e.id));
let ids = split.dev.filter((id) => inManifest.has(id));
const only = opt("ids");
if (only) {
	const want = only.split(",");
	const notDev = want.filter((id) => !split.dev.includes(id));
	if (notDev.length)
		fail(`not in the frozen dev split (never gate on test): ${notDev}`);
	ids = ids.filter((id) => want.includes(id));
}
const limit = opt("limit");
if (limit) ids = ids.slice(0, Number(limit));
if (!ids.length) fail("no photos to run");
const safe = (id) => id.replace(/[^\w.-]/g, "_");

// ---------- run ----------
const locked = (cmd) =>
	has("no-lock") ? cmd : ["node", lockScript, "--", ...cmd];
function step(label, cmd, env) {
	const t0 = Date.now();
	log(`${label}: ${cmd.join(" ")}`);
	const r = spawnSync(cmd[0], cmd.slice(1), {
		cwd: ROOT,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, APP_URL: appUrl, ...env },
	});
	log(
		`${label}: exit ${r.status} in ${((Date.now() - t0) / 1000).toFixed(0)} s`,
	);
	return r.status ?? 1;
}
fs.mkdirSync(out, { recursive: true });
if (!has("diff-only"))
	for (const renderer of renderers) {
		for (let i = 0; i < ids.length; i += chunk) {
			const part = ids.slice(i, i + chunk);
			// the harness skips photos whose result is already ok, so a re-run resumes
			step(
				`${renderer} ${i / chunk + 1}/${Math.ceil(ids.length / chunk)}`,
				locked([
					"bash",
					"tools/bench/harness/run.sh",
					manifest,
					"--methods",
					"app",
					"--conditions",
					"given",
					"--ids",
					part.join(","),
					"--out",
					path.join(out, renderer),
					"--no-overlay",
				]),
				{
					MATCHER_RENDERER: renderer,
					// WebGPU flags on deck too: the certified stages need the compute device
					MATCHER_GPU_COMPUTE: "1",
					// the page's own flags stay at their defaults; the modes switch precision per call
					MATCHER_HORIZON_PRECISION: "",
					MATCHER_ALIGN_PRECISION: "",
					HARNESS_ALIGN_MODES: JSON.stringify(MODES),
					HARNESS_SETTLE_MS: String(settleMs),
				},
			);
		}
		if (withEval)
			for (const [m, p] of [
				["base", BASE],
				["cand", CAND],
			])
				step(
					`eval ${renderer} ${m}`,
					locked([
						"node",
						"scripts/eval-app.mjs",
						"--renderer",
						renderer,
						"--horizon-precision",
						p.horizonPrecision,
						"--align-precision",
						p.alignPrecision,
						"--json",
						path.join(out, `eval-${renderer}-${m}.json`),
					]),
					{},
				);
	}

// ---------- score ----------
const verified = loadVerifiedPoses(ROOT);
const read = (renderer, id) => {
	const f = path.join(out, renderer, "results", safe(id), "given.app.json");
	try {
		return JSON.parse(fs.readFileSync(f, "utf8"));
	} catch {
		return null;
	}
};
/**
 * How cand's certified stages ran over its seeds. `horizonSource` = the mode's re-traced horizon
 * (render_worker modes[].horizon.source): only a "fast" horizon ran the certified-f32 march. After
 * loadFullTerrain (or a fast-horizon fallback) the horizon is the CPU f64 one, and the per-run
 * horizon stats are the page's last fast horizon (init, under other flags), so they don't count.
 */
function certifiedUse(runs, horizonSource) {
	const c = {
		seeds: runs.length,
		alignCert: 0,
		alignFellBack: {},
		horizonCert: 0,
		horizonFellBack: {},
	};
	for (const r of runs) {
		const a = r.precision?.align;
		if (a?.path === "certified-f32") c.alignCert++;
		else if (a?.requested === "certified-f32") {
			const why = a.reason ?? a.path ?? "unknown";
			c.alignFellBack[why] = (c.alignFellBack[why] ?? 0) + 1;
		}
		const h = r.precision?.horizon;
		if (horizonSource !== "fast") {
			const why = `horizon source ${horizonSource ?? "unknown"}`;
			c.horizonFellBack[why] = (c.horizonFellBack[why] ?? 0) + 1;
		} else if (
			h?.mode === "certified-f32" &&
			!h.fellBack &&
			!h.elevations?.fellBack
		)
			c.horizonCert++;
		else if (h?.mode === "certified-f32") {
			const why = String(h.fellBack ?? h.elevations?.fellBack).slice(0, 80);
			c.horizonFellBack[why] = (c.horizonFellBack[why] ?? 0) + 1;
		}
	}
	return c;
}
const median = (xs) => {
	const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
	return s.length ? s[s.length >> 1] : Number.NaN;
};
function evalArmOf(renderer) {
	if (!withEval) return null;
	const ev = (m) => {
		try {
			return JSON.parse(
				fs.readFileSync(path.join(out, `eval-${renderer}-${m}.json`), "utf8"),
			);
		} catch {
			return null;
		}
	};
	const eb = ev("base");
	const ec = ev("cand");
	if (!eb || !ec) return { error: "eval output missing" };
	const byId = new Map(ec.rows.map((r) => [r.id, r]));
	return {
		photos: eb.rows.length,
		within1deg: [eb.within1deg, ec.within1deg],
		medianAutoErr: [
			median(eb.rows.map((r) => r.autoErr)),
			median(ec.rows.map((r) => r.autoErr)),
		],
		poseDiffs: eb.rows
			.filter((r) => {
				const c = byId.get(r.id)?.autoPose;
				const b = r.autoPose;
				return !(
					b &&
					c &&
					["yaw", "pitch", "roll", "vfov"].every((k) => Object.is(b[k], c[k]))
				);
			})
			.map((r) => r.id),
		alignCertified: ec.rows.filter(
			(r) => r.precision?.align?.path === "certified-f32",
		).length,
	};
}

const reports = {};
for (const renderer of renderers) {
	const rows = [];
	const totals = { seeds: 0, alignCert: 0, horizonCert: 0 };
	for (const id of ids) {
		const r = read(renderer, id);
		if (!r?.ok || !r.modes?.base || !r.modes?.cand) {
			rows.push({
				id,
				status: "error",
				issues: [
					r
						? r.ok
							? "row without modes (old harness / worker?)"
							: r.error
						: "no result",
				],
			});
			continue;
		}
		const row = scorePhoto(id, r.modes, verified);
		const pf = r.page ?? {};
		if (renderer !== "auto" && pf.engine !== renderer)
			row.issues.push(`engine ${pf.engine} ran, ${renderer} pinned`);
		// every mode on the same data: terrain and (for equal precision) horizon hashes
		const m = r.modes;
		const tIds = new Set(Object.values(m).map((x) => x.terrain?.ids));
		if (tIds.size > 1) row.issues.push("modes ran on different terrain sets");
		if (m.base2 && m.base.horizon?.hash !== m.base2.horizon?.hash)
			row.issues.push("f64 horizon differs between base and base2");
		row.use = certifiedUse(m.cand.runs ?? [], m.cand.horizon?.source);
		totals.seeds += row.use.seeds;
		totals.alignCert += row.use.alignCert;
		totals.horizonCert += row.use.horizonCert;
		row.fullTerrainUnsupported = !!r.fullTerrainUnsupported;
		rows.push(row);
	}
	const vacuous = [];
	if (CAND.alignPrecision === "certified-f32" && totals.alignCert === 0)
		vacuous.push("align: no seed took the certified path");
	if (CAND.horizonPrecision === "certified-f32" && totals.horizonCert === 0)
		vacuous.push("horizon: no march took the certified path");
	const evalArm = evalArmOf(renderer);
	const d = decide({ rows, evalArm, vacuous });
	reports[renderer] = { ...d, certified: totals, vacuous, eval: evalArm, rows };
}

const order = ["FAIL", "INCONCLUSIVE", "NEEDS-VERIFY", "PASS"];
const verdict = Object.values(reports)
	.map((r) => r.verdict)
	.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
const summary = {
	verdict,
	stage,
	renderers,
	modes: MODES,
	settleMs,
	photos: ids.length,
	verifiedPoses: verified.length,
	reports,
};
fs.writeFileSync(
	path.join(out, "summary.json"),
	JSON.stringify(summary, null, 1),
);
const q = (c) =>
	`${c.accepts} accepts: ${c.correct} correct, ${c.wrong} wrong, ${c.unsure} unsure, ${c.unverified} unverified`;
const md = [
	`# certified-f32 precision gate: ${verdict}`,
	"",
	`stage ${stage}, ${ids.length} dev photos (frozen split), condition "given", app method; modes on one page per photo: ${MODES.map((m) => `${m.name} ${m.horizonPrecision}/${m.alignPrecision}`).join(", ")}; settle ${settleMs} ms. ${verified.length} blind-verified poses.`,
	"",
	...Object.entries(reports).flatMap(([renderer, r]) => [
		`## ${renderer}: ${r.verdict}${r.reasons.length ? ` (${r.reasons.join("; ")})` : ""}`,
		"",
		`- quality, base (f64): ${q(r.quality.base)}`,
		`- quality, cand: ${q(r.quality.cand)}`,
		...(MODES.length > 2
			? [`- quality, base2 (f64): ${q(r.quality.base2)}`]
			: []),
		`- new accepts without a blind verdict: ${r.unverifiedNewAccepts.join(", ") || "none"}`,
		`- identity (reported): ${r.identity.identical} identical, ${r.identity.withinNoise} within f64 noise, differs: ${r.identity.differs.join(", ") || "none"}; f64 noisy (base ≠ base2): ${r.identity.noisy.join(", ") || "none"}`,
		`- certified path taken: align ${r.certified.alignCert}/${r.certified.seeds} seeds, horizon ${r.certified.horizonCert}/${r.certified.seeds}${r.vacuous.length ? ` (${r.vacuous.join("; ")})` : ""}`,
		`- errors: ${r.errors.join(", ") || "none"}`,
		r.eval
			? `- EVAL (GT-12): ${r.eval.error ?? `${r.eval.photos} photos, within 1° ${r.eval.within1deg.join(" vs ")}, median px error ${r.eval.medianAutoErr.map((x) => x.toFixed(1)).join(" vs ")}, pose differences ${r.eval.poseDiffs.join(", ") || "none"}, cand certified align ${r.eval.alignCertified}`}`
			: "- EVAL (GT-12): not run (--no-eval)",
		"",
		"| photo | status | base | cand | cand verdict | certified align / horizon / seeds | issues |",
		"|---|---|---|---|---|---|---|",
		...r.rows.map(
			(x) =>
				`| ${x.id} | ${x.status} | ${x.quality?.base.kind ?? "–"} | ${x.quality?.cand.kind ?? "–"} | ${x.quality?.cand.verdict ?? "–"} | ${x.use ? `${x.use.alignCert} / ${x.use.horizonCert} / ${x.use.seeds}` : "–"} | ${x.issues.join("; ")} |`,
		),
		"",
	]),
].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), `${md}\n`);
console.log(md);
process.exit(EXIT[verdict]);
