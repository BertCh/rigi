/**
 * WP-E display-field evaluation (CPU). Leave-one-out on DEV pins only:
 *
 *   for each dev photo, for each pin i: fit the field from the residuals of pins \ i (under the base
 *   camera), draw pin i through it (scripts/concord/eval.ts scorePins: drawn = r + W⁻¹(r)) and
 *   compare with the same pin drawn without a field.
 *
 *   npx tsx scripts/concord/field-eval.ts [--base gt|rot] [--sweep] [--write-candidates] [--photos a,b]
 *
 * Bases: "gt" = GT pose (in-sample for the control-point pins: the GT pose was fitted to them, so
 * the residuals are small and partly already absorbed); "rot" = eval.ts builtin:rot LOO pose
 * (yaw/pitch/roll refit on pins \ i), then the field on the same pins \ i under that pose.
 * Geometry: CPU DEM ray-march (Terrarium, the eval scene) at the base camera on a 64×48 photo-uv grid,
 * cached in out/concord/field/geom/. No people mask (none in the eval).
 * --sweep: the dev-only hyper-parameter grid (ℓ, λ, method); --write-candidates: all-pin fields as
 * eval.ts candidates in out/concord/field/cand/ (IN-SAMPLE, integration smoke test only).
 * The holdout split is only read by the once-only final report (--holdout, CONCORD_HOLDOUT=final).
 */
import fs from "node:fs";
import path from "node:path";
import {
	type CameraX,
	type ResidualField,
	unprojectDirX,
} from "../../src/lib/concord/core";
import {
	type FieldCue,
	type FitOptions,
	fitField,
	type GeomBuffer,
} from "../../src/lib/concord/field";
import { destination } from "../../src/lib/geodesy";
import {
	bandTable,
	baselineCam,
	builtinFit,
	type EvalPin,
	type EvalResidual,
	loadPins,
	loadScene,
	loadSplit,
	looScore,
	median,
	pinUV,
	quantile,
	EVAL_OUT,
	R_EFF,
	scorePins,
} from "./eval";

const DEG = Math.PI / 180;
const OUT = path.join(path.dirname(EVAL_OUT), "field");

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	const v = process.argv[i + 1];
	return v === undefined || v.startsWith("--") ? "" : v;
}
const has = (name: string) => process.argv.includes(`--${name}`);

// ------------------------------------------------------------ geometry (CPU DEM ray-march)

/** Slant range (m) along photo uv from the scene origin; NaN = sky. Mirrors lib.ts rayHit. */
async function demGeom(
	photo: string,
	cam: CameraX,
	w = 64,
	h = 48,
): Promise<GeomBuffer> {
	const p = cam.pose;
	const key = `${photo}_${w}x${h}_${p.yaw.toFixed(4)}_${p.pitch.toFixed(4)}_${p.roll.toFixed(4)}_${p.vfov.toFixed(4)}`;
	const file = path.join(OUT, "geom", `${key}.json`);
	if (fs.existsSync(file)) {
		const j = JSON.parse(fs.readFileSync(file, "utf8"));
		return { w, h, rangeM: Float32Array.from(j.rangeM) };
	}
	const s = await loadScene(photo);
	const rangeM = new Float32Array(w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			const d = unprojectDirX(cam, (i + 0.5) / w, (j + 0.5) / h);
			const hor = Math.hypot(d[0], d[1]);
			const az = Math.atan2(d[0], d[1]) / DEG;
			const t = d[2] / hor;
			const rel = (x: number) => {
				const q = destination(s.lat, s.lon, az, x);
				return (
					s.terrain.sampleAt(q.lon, q.lat, x) -
					s.eyeAlt -
					cam.eye[2] -
					(x * x) / (2 * R_EFF)
				);
			};
			let prev = 0;
			let hit = Number.NaN;
			for (let x = 15; x < 150000; x += Math.max(5, x * 0.004)) {
				const r = rel(x);
				if (Number.isNaN(r)) break;
				if (r >= x * t) {
					let a = prev;
					let b = x;
					for (let k = 0; k < 14; k++) {
						const m = (a + b) / 2;
						if (rel(m) >= m * t) b = m;
						else a = m;
					}
					hit = b / hor;
					break;
				}
				prev = x;
			}
			rangeM[j * w + i] = hit;
		}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			rangeM: Array.from(rangeM, (x) =>
				Number.isFinite(x) ? Math.round(x) : 0,
			),
		}),
	);
	return { w, h, rangeM };
}

// ------------------------------------------------------------ pins → cues

function cuesOf(cam: CameraX, pins: EvalPin[]): FieldCue[] {
	const res = scorePins(cam, pins);
	const out: FieldCue[] = [];
	pins.forEach((p, k) => {
		const r = res[k];
		if (r.behind) return;
		const [u, v] = pinUV(p.x, p.y, cam.aspect);
		const depthM = Math.hypot(
			p.enu[0] - cam.eye[0],
			p.enu[1] - cam.eye[1],
			p.enu[2] - cam.eye[2],
		);
		const sigmaPx = p.sigmaPx ?? 2;
		const source = `${p.origin}:${p.kind}`;
		if (p.level)
			out.push({
				kind: "level",
				u,
				v,
				el: 0,
				depthM,
				sigmaPx,
				source,
				residualPx: r.dyPx,
				conf: 1,
			});
		else
			out.push({
				kind: "point",
				u,
				v,
				world: p.enu,
				depthM,
				sigmaPx,
				source,
				residualPx: [r.dxPx, r.dyPx],
				conf: 1,
			});
	});
	return out;
}

// ------------------------------------------------------------ LOO

type Row = {
	photo: string;
	id: string;
	label: string;
	band: string;
	level: boolean;
	nTrain: number;
	before: number;
	after: number;
	gain: number;
	fieldMaxPx: number;
};

async function looPhoto(
	photo: string,
	pins: EvalPin[],
	base: "gt" | "rot",
	opts: FitOptions,
): Promise<{ rows: Row[]; before: EvalResidual[]; after: EvalResidual[] }> {
	const gt = await baselineCam(photo, "gt");
	const rot = builtinFit("rot");
	const rows: Row[] = [];
	const before: EvalResidual[] = [];
	const after: EvalResidual[] = [];
	const fields: (ResidualField | undefined)[] = [];
	const cams: CameraX[] = [];
	for (let i = 0; i < pins.length; i++) {
		const train = pins.filter((_, j) => j !== i);
		const cam = base === "gt" ? gt : await rot(photo, train, gt);
		const g = await demGeom(photo, cam);
		const cues = cuesOf(cam, train);
		const f = cues.length
			? fitField(cues, g, cam, { ...opts, loo: false })
			: undefined;
		fields.push(f && f.maxAbsPx > 0 ? f : undefined);
		cams.push(cam);
	}
	// "after" via the eval.ts LOO harness: the field callback sees only pins \ i
	let k = 0;
	const viaHarness =
		base === "gt"
			? await looScore(
					(_p, _t, b) => b,
					pins,
					gt,
					() => fields[k++],
				)
			: undefined;
	for (let i = 0; i < pins.length; i++) {
		const r0 = scorePins(cams[i], [pins[i]])[0];
		const r1 = viaHarness
			? viaHarness[i]
			: scorePins(cams[i], [pins[i]], fields[i])[0];
		before.push(r0);
		after.push(r1);
		rows.push({
			photo,
			id: pins[i].id,
			label: pins[i].label,
			band: r0.band,
			level: r0.level,
			nTrain: pins.length - 1,
			before: r0.px,
			after: r1.px,
			gain: r0.px - r1.px,
			fieldMaxPx: fields[i]?.maxAbsPx ?? 0,
		});
	}
	return { rows, before, after };
}

type Summary = {
	n: number;
	nWithField: number;
	medGain: number;
	meanGain: number;
	medGainWithField: number;
	improved: number;
	worsened: number;
	medBefore: number;
	medAfter: number;
	p90Before: number;
	p90After: number;
	bandP90: Record<string, { n: number; before: number; after: number }>;
	bandP90Worse: string[];
};

function summarise(
	rows: Row[],
	before: EvalResidual[],
	after: EvalResidual[],
): Summary {
	const tb = bandTable(before);
	const ta = bandTable(after);
	const bandP90: Summary["bandP90"] = {};
	const worse: string[] = [];
	for (const b of Object.keys(tb.byBand) as (keyof typeof tb.byBand)[]) {
		if (!tb.byBand[b].n) continue;
		bandP90[b] = {
			n: tb.byBand[b].n,
			before: tb.byBand[b].p90Px,
			after: ta.byBand[b].p90Px,
		};
		if (ta.byBand[b].p90Px > tb.byBand[b].p90Px + 1e-6) worse.push(b);
	}
	const wf = rows.filter((r) => r.fieldMaxPx > 0);
	return {
		n: rows.length,
		nWithField: wf.length,
		medGain: median(rows.map((r) => r.gain)),
		meanGain: rows.reduce((a, r) => a + r.gain, 0) / Math.max(1, rows.length),
		medGainWithField: median(wf.map((r) => r.gain)),
		improved: rows.filter((r) => r.gain > 1e-6).length,
		worsened: rows.filter((r) => r.gain < -1e-6).length,
		medBefore: median(rows.map((r) => r.before)),
		medAfter: median(rows.map((r) => r.after)),
		p90Before: quantile(
			rows.map((r) => r.before),
			0.9,
		),
		p90After: quantile(
			rows.map((r) => r.after),
			0.9,
		),
		bandP90,
		bandP90Worse: worse,
	};
}

async function runConfig(
	byPhoto: Map<string, EvalPin[]>,
	base: "gt" | "rot",
	opts: FitOptions,
) {
	const rows: Row[] = [];
	const before: EvalResidual[] = [];
	const after: EvalResidual[] = [];
	for (const [photo, pins] of byPhoto) {
		const r = await looPhoto(photo, pins, base, opts);
		rows.push(...r.rows);
		before.push(...r.before);
		after.push(...r.after);
	}
	return { rows, summary: summarise(rows, before, after) };
}

const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
const line = (name: string, s: Summary) =>
	`${name.padEnd(34)} n=${s.n} (field ${s.nWithField})  medGain ${f2(s.medGain)}  meanGain ${f2(s.meanGain)}  medGain|field ${f2(s.medGainWithField)}  +${s.improved}/-${s.worsened}  med ${f2(s.medBefore)}→${f2(s.medAfter)}  p90 ${f2(s.p90Before)}→${f2(s.p90After)}  p90-worse [${s.bandP90Worse.join(",")}]`;

async function main() {
	const splitOf = loadSplit();
	// the once-only final report scores the frozen HOLDOUT photos (CONCORD_HOLDOUT=final, --holdout); never tune on it
	const want = has("holdout") ? "holdout" : "dev";
	if (want === "holdout" && process.env.CONCORD_HOLDOUT !== "final")
		throw new Error(
			"--holdout is the once-only final report: set CONCORD_HOLDOUT=final",
		);
	if (want === "holdout" && (has("sweep") || has("write-candidates")))
		throw new Error("--holdout runs the frozen default config only");
	const photos = (
		arg("photos")?.split(",").filter(Boolean) ?? Object.keys(splitOf)
	).filter((p) => splitOf[p] === want);
	const pins = await loadPins({ photos, split: want });
	const byPhoto = new Map<string, EvalPin[]>();
	for (const p of pins)
		byPhoto.set(p.photo, [...(byPhoto.get(p.photo) ?? []), p]);
	console.log(
		`${want} photos ${byPhoto.size}, pins ${pins.length}: ${[...byPhoto].map(([p, v]) => `${p.slice(4)}:${v.length}`).join(" ")}`,
	);
	const bases = (arg("base") || "gt,rot").split(",") as ("gt" | "rot")[];
	const configs: [string, FitOptions][] = [["default gp ℓ200 λ1", {}]];
	if (has("sweep")) {
		for (const lengthPx of [100, 200, 400, 800])
			for (const logRangeScale of [0.5, 1, 2, 1e6])
				configs.push([
					`gp ℓ${lengthPx} λ${logRangeScale === 1e6 ? "∞" : logRangeScale}`,
					{ lengthPx, logRangeScale },
				]);
		for (const lengthPx of [200, 400, 800])
			configs.push([`tps ℓ${lengthPx}`, { method: "tps", lengthPx }]);
		configs.push([
			"gp ℓ400 λ1 fade[0.8,1]",
			{ lengthPx: 400, fade: [0.8, 1.0] },
		]);
		configs.push([
			"gp ℓ400 λ1 NO BOUND(metres,deg)",
			{ lengthPx: 400, maxMetres: 1e9, maxDeg: 90 },
		]);
		configs.push([
			"gp ℓ200 λ1 NO BOUND(metres,deg)",
			{ maxMetres: 1e9, maxDeg: 90 },
		]);
	}
	const results: Record<string, unknown> = {};
	for (const base of bases) {
		console.log(`\n== base ${base} (LOO over ${want} pins; px @1600) ==`);
		for (const [name, opts] of configs) {
			const r = await runConfig(byPhoto, base, opts);
			console.log(line(name, r.summary));
			results[`${base} | ${name}`] = { opts, ...r };
		}
	}
	const def = results[`gt | ${configs[0][0]}`] as {
		rows: Row[];
		summary: Summary;
	};
	console.log("\nper-pin (base gt, default):");
	for (const r of def.rows)
		console.log(
			`  ${r.photo} ${r.id.padEnd(18)} ${r.band.padEnd(7)} ${r.level ? "L" : "P"} train ${r.nTrain}  ${f2(r.before)} → ${f2(r.after)}  (field max ${f2(r.fieldMaxPx)})  ${r.label}`,
		);
	console.log("\nband p90 (base gt, default): before → after");
	for (const [b, v] of Object.entries(def.summary.bandP90))
		console.log(`  ${b.padEnd(8)} n=${v.n}  ${f2(v.before)} → ${f2(v.after)}`);

	if (has("write-candidates")) {
		const dir = path.join(OUT, "cand");
		fs.mkdirSync(dir, { recursive: true });
		for (const [photo, pp] of byPhoto) {
			const cam = await baselineCam(photo, "gt");
			const f = fitField(cuesOf(cam, pp), await demGeom(photo, cam), cam);
			fs.writeFileSync(
				path.join(dir, `${photo}.json`),
				JSON.stringify({
					note: "WP-E all-pin field (IN-SAMPLE; integration smoke test, not an accuracy number)",
					cam,
					field: {
						...f,
						du: Array.from(f.du),
						dv: Array.from(f.dv),
						sigmaPx: Array.from(f.sigmaPx),
					},
				}),
			);
			console.log(
				`candidate ${photo}: maxAbsPx ${f2(f.maxAbsPx)} looGain ${f2(f.provenance.looGainPx ?? Number.NaN)} n ${f.provenance.n}`,
			);
		}
	}
	fs.mkdirSync(OUT, { recursive: true });
	const out = path.join(
		OUT,
		`field-eval-${has("sweep") ? "sweep" : "default"}${want === "holdout" ? "-holdout" : ""}.json`,
	);
	fs.writeFileSync(
		out,
		JSON.stringify(
			{
				date: new Date().toISOString(),
				split: want,
				note: `LOO over ${want} control-point pins; GT pose is in-sample for these pins`,
				results: Object.fromEntries(
					Object.entries(results).map(([k, v]) => {
						const x = v as { opts: FitOptions; summary: Summary; rows: Row[] };
						return [k, { opts: x.opts, summary: x.summary, rows: x.rows }];
					}),
				),
			},
			null,
			1,
		),
	);
	console.log(`\nwrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
