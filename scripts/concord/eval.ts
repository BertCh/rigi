// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Whole-image concordance evaluation (WP-A). CPU-only.
 *
 *   npx tsx scripts/concord/eval.ts --baseline [--pose gt|app] [--split dev|all] [--skyline]
 *   npx tsx scripts/concord/eval.ts --candidate out/concord/<pkg>/[<photo>.json] [--skyline]
 *   npx tsx scripts/concord/eval.ts --loo builtin:rot|builtin:rotf|<module.ts exporting fitWithout>
 *   options: --photos IMG_a,IMG_b  --run <name>  --sources control-points,interior-pins
 *
 * Pins: data/control-points.json (peaks, DEM notches, waterlines; in-sample for the GT pose!) +
 * tools/concord/pins/interior-pins.json (blind human pins). Split per photo from
 * tools/concord/pins/PROTOCOL.txt; --split holdout needs CONCORD_HOLDOUT=final.
 * Writes out/concord/eval/<run>.json and prints a table. The library is ./lib.ts (re-exported).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CameraX, ResidualField } from "../../src/lib/concord/core";
import {
	appSolve,
	auditBands,
	bandTable,
	baselineCam,
	builtinFit,
	concordReport,
	EVAL_OUT,
	type EvalPin,
	type EvalResidual,
	type FitWithout,
	gtPhotos,
	loadPins,
	loadScene,
	loadSplit,
	looScore,
	type PinSource,
	readCandidate,
	type Split,
	scorePins,
	skylineRms,
} from "./lib";

export * from "./lib";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith("--") ? "" : v;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "  - ");

async function main() {
	const split = (arg("split") || "dev") as Split | "all";
	if (split === "holdout" && process.env.CONCORD_HOLDOUT !== "final")
		throw new Error(
			"--split holdout is the once-only final report: set CONCORD_HOLDOUT=final",
		);
	const splitOf = loadSplit();
	const photos = (
		arg("photos")?.split(",").filter(Boolean) ?? gtPhotos()
	).filter((p) => split === "all" || splitOf[p] === split);
	const sources = arg("sources")?.split(",") as PinSource[] | undefined;
	const pose = (arg("pose") || "gt") as "gt" | "app";
	const cand = arg("candidate");
	const loo = arg("loo");
	const mode = cand ? "candidate" : loo ? "loo" : "baseline";
	const run =
		arg("run") ||
		(mode === "baseline"
			? `baseline-${pose}-${split}`
			: mode === "loo"
				? `loo-${path.basename(loo as string).replace(/[^\w.-]/g, "_")}-${split}`
				: `candidate-${path.basename(cand as string)}-${split}`);

	const pins = await loadPins({ photos, split, sources });
	const byPhoto = new Map<string, EvalPin[]>();
	for (const p of pins)
		byPhoto.set(p.photo, [...(byPhoto.get(p.photo) ?? []), p]);

	let fit: FitWithout | undefined;
	if (loo) {
		if (loo.startsWith("builtin:"))
			fit = builtinFit(loo.slice(8) as "rot" | "rotf");
		else {
			const m = await import(pathToFileURL(path.resolve(loo)).href);
			fit = m.fitWithout ?? m.default;
			if (typeof fit !== "function")
				throw new Error(`${loo}: no fitWithout export`);
		}
	}

	const all: EvalResidual[] = [];
	const perPhoto: Record<string, unknown> = {};
	const dem: Record<string, unknown> = {};
	console.log(
		`mode=${mode}${mode === "baseline" ? ` pose=${pose}` : ""} split=${split} pins=${pins.length} photos=${byPhoto.size}`,
	);
	for (const photo of photos) {
		const s = await loadScene(photo);
		dem[photo] = {
			gtDemGround: s.g.demGround,
			gtEye: s.eyeAlt,
			gtEyeSource: s.g.eyeSource,
			gpsAltitude: s.g.gpsAltitude ?? null,
			terrariumGround: +s.groundTerrarium.toFixed(1),
			mapterhornGround: s.groundMapterhorn
				? +s.groundMapterhorn.h.toFixed(1)
				: null,
			mapterhornZ: s.groundMapterhorn?.z ?? null,
			mapterhornMinusGtDemGround: s.groundMapterhorn
				? +(s.groundMapterhorn.h - s.g.demGround).toFixed(1)
				: null,
		};
		const pp = byPhoto.get(photo) ?? [];
		if (!pp.length) continue;
		let cam: CameraX;
		let field: ResidualField | undefined;
		let extra: Record<string, unknown> = {};
		if (mode === "candidate") {
			const c = cand as string;
			const file =
				fs.existsSync(c) && fs.statSync(c).isDirectory()
					? path.join(c, `${photo}.json`)
					: c;
			if (!fs.existsSync(file) || (file === c && !file.includes(photo))) {
				console.log(`${photo}: no candidate file, skipped`);
				continue;
			}
			({ cam, field } = readCandidate(file));
		} else if (pose === "app") {
			const a = await appSolve(photo);
			cam = a.cam;
			extra = {
				appAccepted: a.accepted,
				appConfidence: a.confidence,
				appEyeAlt: a.appEyeAlt,
				appPose: a.cam.pose,
			};
		} else cam = await baselineCam(photo, "gt");
		const res =
			mode === "loo"
				? await looScore(fit as FitWithout, pp, await baselineCam(photo, pose))
				: scorePins(cam, pp, field);
		const warpedRaw = field ? scorePins(cam, pp) : undefined;
		const sky =
			has("skyline") && mode !== "loo"
				? await skylineRms(photo, cam)
				: undefined;
		all.push(...res);
		perPhoto[photo] = {
			...extra,
			report: concordReport(photo, res, sky?.rmsInl),
			skyline: sky,
			rawWithoutField: warpedRaw ? bandTable(warpedRaw) : undefined,
			residuals: res.map((r) => ({
				...r,
				dxPx: +r.dxPx.toFixed(2),
				dyPx: +r.dyPx.toFixed(2),
				px: +r.px.toFixed(2),
				distM: Math.round(r.distM),
			})),
		};
		const t = bandTable(res);
		console.log(
			`${photo}  n=${String(res.length).padStart(2)}  med ${f1(t.all.medPx)}  p90 ${f1(t.all.p90Px)}` +
				`  | ${Object.entries(t.byBand)
					.map(([b, v]) => `${b} ${v.n ? `${f1(v.medPx)}(${v.n})` : "-"}`)
					.join("  ")}` +
				(sky
					? `  | sky rms ${sky.rmsInl.toFixed(2)} medAbs ${sky.medAbs.toFixed(2)}`
					: "") +
				(extra.appAccepted !== undefined
					? `  | app ${extra.appAccepted ? "accept" : "REJECT"}`
					: ""),
		);
	}
	const pooled = bandTable(all);
	const audit = auditBands(all);
	console.log("\npooled by distance band (px @1600: median / p90 / n)");
	for (const [b, v] of Object.entries(pooled.byBand))
		console.log(`  ${b.padEnd(8)} ${f1(v.medPx)} / ${f1(v.p90Px)} / ${v.n}`);
	console.log("pooled by radius band");
	for (const [b, v] of Object.entries(pooled.byRadius))
		console.log(`  ${b.padEnd(8)} ${f1(v.medPx)} / ${f1(v.p90Px)} / ${v.n}`);
	console.log(
		`all      ${f1(pooled.all.medPx)} / ${f1(pooled.all.p90Px)} / ${pooled.all.n}`,
	);
	console.log(
		`audit bands (point pins): <6.5km ${audit["<6.5km"].medPx.toFixed(2)} (n=${audit["<6.5km"].n})  >15km ${audit[">15km"].medPx.toFixed(2)} (n=${audit[">15km"].n})  waterline ${f1(audit.waterline.medPx)} (n=${audit.waterline.n})`,
	);
	console.log(
		"\nDEM ground at the GT eye (m): GT demGround | Terrarium now | Mapterhorn (z) | Δ(MH−GT)",
	);
	for (const [p, d] of Object.entries(dem) as [
		string,
		Record<string, number | null>,
	][])
		console.log(
			`  ${p}  ${d.gtDemGround}  ${d.terrariumGround}  ${d.mapterhornGround ?? "-"} (z${d.mapterhornZ ?? "-"})  ${d.mapterhornMinusGtDemGround ?? "-"}   eye ${d.gtEye} (${d.gtEyeSource}), gps ${d.gpsAltitude}`,
		);
	fs.mkdirSync(EVAL_OUT, { recursive: true });
	const out = path.join(EVAL_OUT, `${run}.json`);
	fs.writeFileSync(
		out,
		JSON.stringify(
			{
				run,
				mode,
				pose: mode === "baseline" ? pose : undefined,
				candidate: cand,
				loo,
				split,
				date: new Date().toISOString(),
				pooled,
				audit,
				dem,
				perPhoto,
			},
			null,
			1,
		),
	);
	console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
}

const isMain =
	process.argv[1] &&
	import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain)
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
