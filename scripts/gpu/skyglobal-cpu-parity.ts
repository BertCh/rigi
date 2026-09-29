// TS CPU twin (src/lib/gpu/skyglobal/cpu.ts) vs Python skyglobal.py on the dumped dev fixtures
// (out/gpu/skyglobal/<id>/, written by tools/matcher/gpu_port/dump_skyglobal_fixtures.py). No browser.
//
//   npx tsx scripts/gpu/skyglobal-cpu-parity.ts [wc_0001 …]
//
// Per photo: max |Δ| of the sky / Sc / Sf maps, the per-yaw grid winner (best value, arg combo), the
// full combo × yaw grid when grid.f32 was dumped, the peaks and the polished top-k hypotheses.
// Writes out/gpu/skyglobal/cpu-parity.json.
import fs from "node:fs";
import path from "node:path";
import { type Hyp, SkyGlobal } from "../../src/lib/gpu/skyglobal/cpu";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIR = path.join(ROOT, "out/gpu/skyglobal");
const f32 = (p: string) => {
	const b = fs.readFileSync(p);
	return new Float32Array(
		b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
	);
};
const f64 = (p: string) => {
	const b = fs.readFileSync(p);
	return new Float64Array(
		b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
	);
};
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let m = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i] - b[i]);
		if (d > m || Number.isNaN(d))
			m = Number.isNaN(d) ? Number.POSITIVE_INFINITY : d;
	}
	return m;
};
const poseDiff = (a: Hyp["pose"], b: Hyp["pose"]) =>
	Math.max(
		Math.abs(((a.yaw - b.yaw + 540) % 360) - 180),
		Math.abs(a.pitch - b.pitch),
		Math.abs(a.roll - b.roll),
		Math.abs(a.vfov - b.vfov),
	);

export function loadFixture(id: string) {
	const d = path.join(DIR, id);
	const meta = JSON.parse(fs.readFileSync(path.join(d, "meta.json"), "utf8"));
	const b = fs.readFileSync(path.join(d, "rgb.u8"));
	return {
		meta,
		ed: {
			w: meta.w,
			h: meta.h,
			dirs: f32(path.join(d, "dirs.f32")),
			fine: f32(path.join(d, "fine.f32")),
			coarse: f32(path.join(d, "coarse.f32")),
			fg: f32(path.join(d, "fg.f32")),
			rgb: new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
		},
	};
}

const args = process.argv.slice(2);
const ids = args.length
	? args
	: fs
			.readdirSync(DIR)
			.filter((x) => fs.existsSync(path.join(DIR, x, "ref.json")));
const rows = [];
for (const id of ids) {
	const d = path.join(DIR, id);
	const ref = JSON.parse(fs.readFileSync(path.join(d, "ref.json"), "utf8"));
	const { meta, ed } = loadFixture(id);
	const t0 = performance.now();
	const sg = new SkyGlobal(ed, meta.aspect);
	const ctorMs = performance.now() - t0;
	const g = sg.plan(meta.vfov0, meta.focalKnown);
	if (!g) throw new Error(`${id}: no profile`);
	const hasFull = fs.existsSync(path.join(d, "grid.f32"));
	const full = hasFull ? new Float64Array(g.combos.length * g.nYaw) : undefined;
	const gr = sg.gridCpu(g, full);
	const t1 = performance.now();
	const evals0 = sg.evals;
	const peaks = sg.peaks(g, gr, meta.vfov0, ref.k);
	const hyps = sg.polish(peaks, meta.vfov0, meta.focalKnown, ref.k);
	const polishMs = performance.now() - t1;
	const pBest = f64(path.join(d, "best.f64"));
	const pArg = f32(path.join(d, "arg.f32"));
	let argFlips = 0;
	for (let iy = 0; iy < g.nYaw; iy++) {
		const cb = g.combos[gr.arg[iy]];
		if (
			Math.fround(g.vfovs[cb.vi]) !== pArg[iy * 3] ||
			Math.fround(cb.pitch) !== pArg[iy * 3 + 1] ||
			Math.fround(cb.roll) !== pArg[iy * 3 + 2]
		)
			argFlips++;
	}
	let gridMax: number | null = null;
	if (full) {
		const pg = f32(path.join(d, "grid.f32"));
		// Python's grid is dumped as float32: compare against our values rounded the same way
		gridMax = maxAbs(Float32Array.from(full), pg);
		const prof = f64(path.join(d, "prof.f64"));
		gridMax = Math.max(gridMax, 0);
		(globalThis as { __prof?: number }).__prof = maxAbs(prof, g.prof);
	}
	const hypsSame =
		hyps.length === ref.hyps.length &&
		hyps.every(
			(h: Hyp, i: number) =>
				poseDiff(h.pose, ref.hyps[i].pose) === 0 &&
				h.score === ref.hyps[i].score,
		);
	const hypsMaxDiff = Math.max(
		0,
		...hyps.map((h: Hyp, i: number) =>
			ref.hyps[i]
				? poseDiff(h.pose, ref.hyps[i].pose)
				: Number.POSITIVE_INFINITY,
		),
	);
	const row = {
		id,
		nYaw: g.nYaw,
		nCombo: g.combos.length,
		skyMax: maxAbs(sg.sky, f32(path.join(d, "sky.f32"))),
		ScMax: maxAbs(sg.Sc, f32(path.join(d, "Sc.f32"))),
		SfMax: maxAbs(sg.Sf, f32(path.join(d, "Sf.f32"))),
		bestMax: maxAbs(gr.best, pBest),
		argFlips,
		gridMax,
		profMax: (globalThis as { __prof?: number }).__prof ?? null,
		hypsSame,
		hypsMaxDiff,
		hypsN: [hyps.length, ref.hyps.length],
		scoreMaxDiff: Math.max(
			0,
			...hyps.map((h: Hyp, i: number) =>
				Math.abs(h.score - (ref.hyps[i]?.score ?? Number.NaN)),
			),
		),
		ms: {
			ctor: ctorMs,
			grid: gr.ms,
			polish: polishMs,
			evals: sg.evals - evals0,
		},
		pyMs: ref.profileMs,
		hyps: hyps.map((h: Hyp) => ({ ...h.pose, score: h.score })),
	};
	(globalThis as { __prof?: number }).__prof = undefined;
	rows.push(row);
	console.log(
		`${id}: sky ${row.skyMax.toExponential(1)} Sc ${row.ScMax.toExponential(1)} Sf ${row.SfMax.toExponential(1)} ` +
			`best ${row.bestMax.toExponential(1)} argFlips ${argFlips}/${g.nYaw} grid ${gridMax === null ? "-" : gridMax.toExponential(1)} ` +
			`hyps ${hypsSame ? "IDENTICAL" : `DIFF max ${hypsMaxDiff.toExponential(2)}`} (${hyps.length}) | ts ctor ${ctorMs.toFixed(0)} grid ${gr.ms.toFixed(0)} polish ${polishMs.toFixed(0)} ms` +
			` | py grid ${ref.profileMs.grid} refine ${ref.profileMs.refine}`,
	);
}
fs.writeFileSync(
	path.join(DIR, "cpu-parity.json"),
	JSON.stringify(rows, null, 1),
);
