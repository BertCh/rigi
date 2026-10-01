#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Wild-set / EVAL gate for the opt-in certified-f32 stages (precision policy P1; WAG W3.1 horizon,
// W3.3 align). A certified-f32 stage may become a default only after this gate passes.
//
//   node scripts/gpu/precision-gate.mjs [--stage both|horizon|align] [--renderer webgpu|deck|auto]
//       [--ids a,b | --limit N] [--chunk N] [--out DIR] [--eval] [--diff-only] [--no-lock]
//       [--manifest tools/bench/data/manifest.json] [--split tools/bench/split.json]
//       [--lock-script PATH]
//   Needs the dev server (APP_URL, default http://localhost:3100) and the gitignored wild set
//   (tools/bench/data: manifest.json + photos) plus the harness's tools/matcher/.venv (photo normalising).
//   2-photo smoke: --limit 2.
//
// What it runs: the FROZEN dev split (tools/bench/split.json "dev", read-only; the test half is spent and
// is never used here) through the wild harness's "app" method (tools/bench/harness/run.ts: the app's own
// autoAlign in the headless app with the harness's seed wrapper and accept rule, condition "given"),
// twice:
//   base: ?horizonPrecision=f64&alignPrecision=f64         (the defaults)
//   cand: ?horizonPrecision=certified-f32 and/or ?alignPrecision=certified-f32 (--stage)
// both pinned to --renderer (default webgpu), through the render worker's page-flag pass-through
// (tools/matcher/server/render_worker.mjs MATCHER_RENDERER / MATCHER_*_PRECISION). Every chunk of
// --chunk photos (default 5) is one step under the machine-wide render lock (FIFO, shared).
// --eval adds the GT-12 arm: scripts/eval-app.mjs on data/control-points.json, base vs cand.
//
// The rule. The certified stages claim outputs bit-identical to the f64 path, so the gate is identity:
//   PASS  every photo: the same accept / reject decision (and accept kind), the same final, shown and
//         native poses and confidence, and every seed's raw autoAlign result (pose, score, confidence,
//         alternatives) bit for bit (Object.is); the pinned engine ran in both; the certified path
//         really ran in cand (at least one seed per requested stage took it; fallbacks are counted).
//   FAIL  any difference. A cand accept that base rejects is a NEW ACCEPT: under the frozen
//         0-false-accept rule it counts as a potential false accept (it has no blind verdict), so it
//         fails the gate whatever its pose. A changed pose on an accepted row fails the same way.
//   INCONCLUSIVE (exit 3)  a photo errored in either run, or cand never took a certified path (the
//         probe failed, every call fell back): nothing was tested.
// With identity, the false-accept count of cand equals base's by construction (the rule's inputs are
// identical), so no new blind verification is needed. The frozen rule files (tools/bench/t5/
// RULE_FROZEN*, split.json) are only read.
//
// Full terrain: the app arm on photos without a heading asks for it (loadFullTerrain). Both engines
// implement it since WAG3 (WebGpuEngine.loadFullTerrain / renderPoseView), so webgpu rows run on the
// 360° terrain like deck; a row is recorded as fullTerrainUnsupported only when the engine lacks the hook.
// The fused / product-rule arm (matcher service, the worker's "render" command) is not run by this gate.
//
// Output: <out>/{base,cand}/ (harness results), <out>/summary.json, <out>/summary.md.
// Exit: 0 PASS, 1 FAIL, 3 INCONCLUSIVE, 2 usage / setup.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
const renderer = opt("renderer", "webgpu");
if (!["webgpu", "deck", "auto"].includes(renderer))
	fail(`--renderer must be webgpu, deck or auto (got ${renderer})`);
const manifest = path.resolve(
	ROOT,
	opt("manifest", "tools/bench/data/manifest.json"),
);
const splitFile = path.resolve(ROOT, opt("split", "tools/bench/split.json"));
const chunk = Math.max(1, Number(opt("chunk", "5")));
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

const MODES = {
	base: { horizon: "f64", align: "f64" },
	cand: {
		horizon: stage === "align" ? "f64" : "certified-f32",
		align: stage === "horizon" ? "f64" : "certified-f32",
	},
};

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
const modeEnv = (m) => ({
	MATCHER_RENDERER: renderer,
	MATCHER_HORIZON_PRECISION: MODES[m].horizon,
	MATCHER_ALIGN_PRECISION: MODES[m].align,
});
fs.mkdirSync(out, { recursive: true });
if (!has("diff-only"))
	for (const m of ["base", "cand"])
		for (let i = 0; i < ids.length; i += chunk) {
			const part = ids.slice(i, i + chunk);
			// the harness skips photos whose result is already ok, so a re-run resumes
			step(
				`${m} ${i / chunk + 1}/${Math.ceil(ids.length / chunk)}`,
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
					path.join(out, m),
					"--no-overlay",
				]),
				modeEnv(m),
			);
		}
if (has("eval") && !has("diff-only"))
	for (const m of ["base", "cand"])
		step(
			`eval ${m}`,
			locked([
				"node",
				"scripts/eval-app.mjs",
				"--renderer",
				renderer,
				"--horizon-precision",
				MODES[m].horizon,
				"--align-precision",
				MODES[m].align,
				"--json",
				path.join(out, `eval-${m}.json`),
			]),
			{},
		);

// ---------- diff ----------
const POSE = ["yaw", "pitch", "roll", "vfov"];
const samePose = (a, b) =>
	(a == null && b == null) ||
	(a != null && b != null && POSE.every((k) => Object.is(a[k], b[k])));
const sameRun = (a, b) =>
	samePose(a.pose, b.pose) &&
	Object.is(a.score, b.score) &&
	Object.is(a.confidence, b.confidence) &&
	(a.alternatives ?? []).length === (b.alternatives ?? []).length &&
	(a.alternatives ?? []).every(
		(x, i) =>
			samePose(x.pose, b.alternatives[i].pose) &&
			Object.is(x.score, b.alternatives[i].score) &&
			Object.is(x.total, b.alternatives[i].total) &&
			Object.is(x.sil, b.alternatives[i].sil),
	);
const read = (m, id) => {
	const f = path.join(out, m, "results", safe(id), "given.app.json");
	try {
		return JSON.parse(fs.readFileSync(f, "utf8"));
	} catch {
		return null;
	}
};
/** How the cand's certified stages ran over its seeds. */
function certifiedUse(row) {
	const runs = row?.precisionRuns ?? [];
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
		if (h?.mode === "certified-f32" && !h.fellBack && !h.elevations?.fellBack)
			c.horizonCert++;
		else if (h?.mode === "certified-f32") {
			const why = String(h.fellBack ?? h.elevations?.fellBack).slice(0, 80);
			c.horizonFellBack[why] = (c.horizonFellBack[why] ?? 0) + 1;
		}
	}
	return c;
}

const rows = [];
for (const id of ids) {
	const b = read("base", id);
	const c = read("cand", id);
	const row = { id, issues: [] };
	rows.push(row);
	if (!b?.ok || !c?.ok) {
		row.status = "error";
		row.issues.push(
			`missing or failed result: base ${b ? (b.ok ? "ok" : b.error) : "none"}, cand ${c ? (c.ok ? "ok" : c.error) : "none"}`,
		);
		continue;
	}
	for (const [m, r] of [
		["base", b],
		["cand", c],
	]) {
		const pf = r.page ?? {};
		if (renderer !== "auto" && pf.engine !== renderer)
			row.issues.push(`${m}: engine ${pf.engine} ran, ${renderer} pinned`);
		if (
			pf.horizonPrecision !== MODES[m].horizon ||
			pf.alignPrecision !== MODES[m].align
		)
			row.issues.push(`${m}: page flags ${JSON.stringify(pf)}`);
	}
	row.base = { accepted: b.accepted, kind: b.acceptKind };
	row.cand = { accepted: c.accepted, kind: c.acceptKind };
	row.newAccept = !b.accepted && c.accepted;
	row.lostAccept = b.accepted && !c.accepted;
	row.decisionSame = b.accepted === c.accepted && b.acceptKind === c.acceptKind;
	const poses = [
		["pose", b.pose, c.pose],
		["shownPose", b.shownPose, c.shownPose],
		["native.pose", b.native?.pose, c.native?.pose],
		["native.shownPose", b.native?.shownPose, c.native?.shownPose],
	];
	row.poseDiffs = poses.filter(([, x, y]) => !samePose(x, y)).map(([k]) => k);
	if (!Object.is(b.confidence, c.confidence)) row.poseDiffs.push("confidence");
	const br = b.precisionRuns ?? [];
	const cr = c.precisionRuns ?? [];
	row.seedDiffs =
		br.length !== cr.length || !br.length
			? -1
			: br.filter((x, i) => !sameRun(x, cr[i])).length;
	row.use = certifiedUse(c);
	row.fullTerrainUnsupported = !!(
		b.fullTerrainUnsupported || c.fullTerrainUnsupported
	);
	if (!row.decisionSame) row.issues.push("decision differs");
	if (row.newAccept) row.issues.push("NEW ACCEPT (potential false accept)");
	if (row.poseDiffs.length) row.issues.push(`differs: ${row.poseDiffs}`);
	if (row.seedDiffs !== 0)
		row.issues.push(
			row.seedDiffs < 0
				? "seed runs missing (render worker without the precision pass-through?)"
				: `${row.seedDiffs} seed results differ`,
		);
	row.status = row.issues.length ? "fail" : "same";
}

// eval arm
let evalDiff = null;
if (has("eval")) {
	const ev = (m) => {
		try {
			return JSON.parse(
				fs.readFileSync(path.join(out, `eval-${m}.json`), "utf8"),
			);
		} catch {
			return null;
		}
	};
	const eb = ev("base");
	const ec = ev("cand");
	if (!eb || !ec) evalDiff = { error: "eval output missing" };
	else {
		const byId = new Map(ec.rows.map((r) => [r.id, r]));
		const diffs = eb.rows
			.filter((r) => !samePose(r.autoPose, byId.get(r.id)?.autoPose))
			.map((r) => r.id);
		evalDiff = {
			photos: eb.rows.length,
			poseDiffs: diffs,
			within1deg: [eb.within1deg, ec.within1deg],
			alignCertified: ec.rows.filter(
				(r) => r.precision?.align?.path === "certified-f32",
			).length,
			horizonCertified: ec.rows.filter(
				(r) =>
					r.precision?.horizon?.mode === "certified-f32" &&
					!r.precision.horizon.fellBack,
			).length,
		};
	}
}

// verdict
const errors = rows.filter((r) => r.status === "error");
const failed = rows.filter((r) => r.status === "fail");
const totals = rows.reduce(
	(t, r) => {
		if (!r.use) return t;
		t.seeds += r.use.seeds;
		t.alignCert += r.use.alignCert;
		t.horizonCert += r.use.horizonCert;
		return t;
	},
	{ seeds: 0, alignCert: 0, horizonCert: 0 },
);
const vacuous = [];
if (MODES.cand.align === "certified-f32" && totals.alignCert === 0)
	vacuous.push("align: no seed took the certified path");
if (MODES.cand.horizon === "certified-f32" && totals.horizonCert === 0)
	vacuous.push("horizon: no march took the certified path");
const evalFail =
	evalDiff &&
	(evalDiff.error ||
		evalDiff.poseDiffs.length ||
		evalDiff.within1deg[0] !== evalDiff.within1deg[1]);
const verdict =
	failed.length || evalFail
		? "FAIL"
		: errors.length || vacuous.length
			? "INCONCLUSIVE"
			: "PASS";
const summary = {
	verdict,
	stage,
	renderer,
	modes: MODES,
	photos: ids.length,
	same: rows.filter((r) => r.status === "same").length,
	failed: failed.map((r) => r.id),
	errors: errors.map((r) => r.id),
	newAccepts: rows.filter((r) => r.newAccept).map((r) => r.id),
	lostAccepts: rows.filter((r) => r.lostAccept).map((r) => r.id),
	accepts: {
		base: rows.filter((r) => r.base?.accepted).length,
		cand: rows.filter((r) => r.cand?.accepted).length,
	},
	certified: totals,
	vacuous,
	fullTerrainUnsupported: rows.filter((r) => r.fullTerrainUnsupported).length,
	eval: evalDiff,
	rows,
};
fs.writeFileSync(
	path.join(out, "summary.json"),
	JSON.stringify(summary, null, 1),
);
const md = [
	`# certified-f32 precision gate: ${verdict}`,
	"",
	`stage ${stage}, renderer ${renderer} pinned, ${ids.length} dev photos (frozen split), condition "given", app method.`,
	`base ${JSON.stringify(MODES.base)} vs cand ${JSON.stringify(MODES.cand)}.`,
	"",
	`- identical: ${summary.same}/${ids.length}; failed: ${summary.failed.join(", ") || "none"}; errors: ${summary.errors.join(", ") || "none"}`,
	`- accepts: base ${summary.accepts.base}, cand ${summary.accepts.cand}; new accepts (potential false accepts): ${summary.newAccepts.join(", ") || "none"}; lost accepts: ${summary.lostAccepts.join(", ") || "none"}`,
	`- certified path taken: align ${totals.alignCert}/${totals.seeds} seeds, horizon ${totals.horizonCert}/${totals.seeds}${vacuous.length ? ` (${vacuous.join("; ")})` : ""}`,
	`- rows on the initial terrain (no loadFullTerrain on this engine): ${summary.fullTerrainUnsupported}`,
	evalDiff
		? `- EVAL (GT-12): ${evalDiff.error ?? `${evalDiff.photos} photos, pose differences ${evalDiff.poseDiffs.join(", ") || "none"}, within 1° ${evalDiff.within1deg.join(" vs ")}, cand certified align ${evalDiff.alignCertified} / horizon ${evalDiff.horizonCertified}`}`
		: "- EVAL (GT-12): not run (--eval)",
	"",
	"| photo | status | base | cand | certified align / horizon / seeds | issues |",
	"|---|---|---|---|---|---|",
	...rows.map(
		(r) =>
			`| ${r.id} | ${r.status} | ${r.base?.kind ?? "–"} | ${r.cand?.kind ?? "–"} | ${r.use ? `${r.use.alignCert} / ${r.use.horizonCert} / ${r.use.seeds}` : "–"} | ${r.issues.join("; ")} |`,
	),
].join("\n");
fs.writeFileSync(path.join(out, "summary.md"), `${md}\n`);
console.log(md);
process.exit(verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3);
