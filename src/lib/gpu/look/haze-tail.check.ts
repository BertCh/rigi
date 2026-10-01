// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/look/haze-tail.check.ts [scenes]   (exits 1 on failure; CI fast tier: 16)
// Node check of the haze fit's CPU tail (./haze.ts hazeFitTail), no GPU:
//  1. pathFrom (atmPath with its exp(−h0 / H) hoisted) equals atmPath bit for bit on 400 000 random
//     arguments, both branches of its |x| < 1e-3 series;
//  2. robustSkyExact (typed-array sorts) equals look/haze-fit.ts robustSky bit for bit on random band
//     values with heavy ties, duplicates, ±0 and NaN, every length 0–300;
//  3. end to end: hazeFitTail on an emulated submit 1 (./haze-emulate.ts: the GPU's order statistics
//     and compacted lists, built with fitHaze's own per-pixel code) and an f32-rounded f64 grid equals
//     fitHaze(input) bit for bit (every number of the HazeFit, samples included) on synthetic scenes
//     of several sizes, with and without sky / people masks, xyzr and range-only geometry. Scenes on
//     which the tail is not exact BY DESIGN are skipped and counted: a percentile whose f64 rank
//     q·(n−1) falls a hair under the integer (haze.ts pct's `i === gi − 1` case) and more than 256
//     grid candidates. The refine memo must hit (it is exercised, not dormant);
//     The same with the grid's arg-min picked as the GPU program does (haze-argmin.ts emulatePick).
//  4. teeth: a one-ULP change in one selected list value or in the band's lin changes the result.
import { atmPath } from "../../look/atmosphere";
import { fitHaze, robustSky } from "../../look/haze-fit";
import {
	type GridFn,
	hazeFitTail,
	hazeGpuTimes,
	NBINS,
	type Prep,
	pathFrom,
	robustSkyExact,
} from "./haze";
import { decodePick, emulatePick } from "./haze-argmin";
import {
	emulatedGrid,
	emulatePrep,
	firstDifference,
	lcg,
	makeHazeScene,
	sceneOptions,
} from "./haze-emulate";

/** emulatedGrid, then the arg-min program's pick of it (emulatePick → decodePick). */
const pickedGrid: GridFn = async (...args) => {
	const g = await emulatedGrid(...args);
	const pick = decodePick(...emulatePick(g));
	if (!pick) throw new Error("decodePick rejected an emulated pick");
	return pick;
};

let failed = 0;
const fail = (msg: string) => {
	failed++;
	console.log(`FAIL ${msg}`);
};

// ---------- 1. pathFrom ----------
{
	const rnd = lcg(42);
	let n = 0;
	let series = 0;
	for (let k = 0; k < 400_000; k++) {
		const H = [8000, 600, 900, 1200, 1800, 2700, 4000, 1234.5][k % 8];
		const h0 = rnd() * 4000 - 200;
		// a quarter of the cases inside the series branch |x| < 1e-3
		const h1 = k % 4 === 0 ? h0 + (rnd() - 0.5) * 2e-3 * H : rnd() * 5000 - 300;
		const L = 10 ** (1 + rnd() * 5);
		if (Math.abs((h1 - h0) / H) < 1e-3) series++;
		const a = atmPath(h0, h1, L, H);
		const b = pathFrom(Math.exp(-h0 / H), h0, h1, L, H);
		if (!Object.is(a, b)) {
			if (n++ < 3)
				fail(`pathFrom(${h0}, ${h1}, ${L}, ${H}) = ${b}, atmPath ${a}`);
		}
	}
	console.log(
		`${n ? "FAIL" : "ok  "} pathFrom = atmPath on 400 000 arguments (${series} in the series branch)`,
	);
}

// ---------- 2. robustSkyExact ----------
{
	const rnd = lcg(7);
	let n = 0;
	let cases = 0;
	for (let len = 0; len <= 300; len++)
		for (let rep = 0; rep < 6; rep++) {
			const pool = rep % 3 === 0 ? 4 : rep % 3 === 1 ? 40 : 1e9;
			const value = () => {
				const u = rnd();
				if (rep === 5 && u < 0.02) return Number.NaN;
				if (rep >= 4 && u < 0.05) return u < 0.025 ? -0 : 0;
				return Math.fround(Math.floor(rnd() * pool) / pool);
			};
			const r = Array.from({ length: len }, value);
			const g = Array.from({ length: len }, value);
			const b = Array.from({ length: len }, value);
			const l = r.map((v, i) => 0.2126 * v + 0.7152 * g[i] + 0.0722 * b[i]);
			if (rep === 3 && len) l[len >> 1] = -0;
			const none = new Float32Array(0);
			const want = robustSky(
				r.slice(),
				g.slice(),
				b.slice(),
				l.slice(),
				none,
				none,
			);
			const got = robustSkyExact(r, g, b, l);
			cases++;
			const d = firstDifference(got, want);
			if (d && n++ < 3) fail(`robustSkyExact len ${len} rep ${rep}${d}`);
		}
	console.log(
		`${n ? "FAIL" : "ok  "} robustSkyExact = robustSky on ${cases} band value sets`,
	);
}

// ---------- 3. end to end ----------

/** haze.ts pct's inexact case: q·(n−1) in f64 floors below the integer rank, for a fitted bin. */
function hasSubRankPercentile(counts: Uint32Array) {
	let total = 0;
	for (const c of counts) total += c;
	const minCount = Math.max(40, Math.round(total * 0.002));
	for (const n of counts) {
		if (n < minCount) continue;
		const m = n - 1;
		if (Math.floor(0.01 * m) !== Math.floor(m / 100)) return true;
		if (Math.floor(0.09 * m) !== Math.floor((9 * m) / 100)) return true;
	}
	return false;
}

const scenes = Number(process.argv[2] ?? 16);
let compared = 0;
let skipped = 0;
let memoHits = 0;
let fitted = 0;
let firstTeeth: { prep: Prep; ctx: Parameters<typeof hazeFitTail>[1] } | null =
	null;
for (let s = 0; s < scenes; s++) {
	const opts = sceneOptions(s);
	const input = makeHazeScene(opts);
	const { prep, ctx } = emulatePrep(input);
	const want = fitHaze(input);
	// hazeGpuTimes is merged, not replaced: clear it so a short fit cannot show the last one's keys
	for (const k of Object.keys(hazeGpuTimes)) delete hazeGpuTimes[k];
	const got = await hazeFitTail(null as never, ctx, prep, emulatedGrid);
	const label = `scene ${s} (${opts.width}×${opts.height}${opts.skyMask ? " sky" : ""}${opts.foreground ? " fg" : ""}${opts.rangeOnly ? " range" : ""})`;
	if (hasSubRankPercentile(prep.counts)) {
		skipped++;
		console.log(`skip ${label}: a percentile rank floors under its integer`);
		continue;
	}
	if ((hazeGpuTimes.gridCandidates ?? 0) > 256) {
		skipped++;
		console.log(
			`skip ${label}: ${hazeGpuTimes.gridCandidates} grid candidates`,
		);
		continue;
	}
	compared++;
	if (want.samples.length >= 3) fitted++;
	memoHits += hazeGpuTimes.refineMemoHits ?? 0;
	const d = firstDifference(got, want);
	if (d) fail(`${label}: tail ≠ fitHaze at ${d}`);
	// the same tail with the grid's arg-min picked as the GPU program does (haze-argmin.ts)
	const viaPick = await hazeFitTail(null as never, ctx, prep, pickedGrid);
	const dp = firstDifference(viaPick, want);
	if (dp) fail(`${label}: tail with the GPU arg-min pick ≠ fitHaze at ${dp}`);
	else
		console.log(
			`ok   ${label}: ${want.samples.length} bins, quality ${want.quality.toFixed(3)}, memo hits ${hazeGpuTimes.refineMemoHits ?? 0}`,
		);
	if (!firstTeeth && want.samples.length >= 3) firstTeeth = { prep, ctx };
}
console.log(
	`${compared} scenes compared (${fitted} with a physical fit), ${skipped} skipped by design, ${memoHits} refine memo hits`,
);
if (compared < Math.ceil(scenes / 2))
	fail(`only ${compared} of ${scenes} scenes compared`);
if (fitted && !memoHits) fail("the refine memo never hit");

// ---------- 4. teeth ----------
if (firstTeeth) {
	const { prep, ctx } = firstTeeth;
	const base = await hazeFitTail(null as never, ctx, prep, emulatedGrid);
	const nudgeAll = (a: Float32Array) => {
		const b = a.slice();
		const bits = new Uint32Array(b.buffer);
		for (let k = 0; k < bits.length; k++) if (bits[k]) bits[k] += 1;
		return b;
	};
	// one list value strictly inside its bin's [slot 1, slot 2] (always selected), and the band
	let L = -1;
	let at = -1;
	for (let b = 0; b < NBINS && L < 0; b++) {
		const { val } = prep.list(b * 3 + 1);
		const s0 = (b * 3 + 1) * 4;
		const k = val.findIndex(
			(v) => v > prep.stat[s0 + 1] && v < prep.stat[s0 + 2],
		);
		if (k >= 0) {
			L = b * 3 + 1;
			at = k;
		}
	}
	const list = (l: number) => {
		const own = prep.list(l);
		if (l !== L) return own;
		const val = own.val.slice();
		new Uint32Array(val.buffer)[at] += 1;
		return { idx: own.idx, val };
	};
	const variants: [string, Prep][] = [
		["list value", { ...prep, list }],
		["band lin", { ...prep, sky: nudgeAll(prep.sky) }],
	];
	for (const [name, p] of variants) {
		const got = await hazeFitTail(null as never, ctx, p, emulatedGrid);
		const d = firstDifference(got, base);
		if (!d) fail(`teeth: a one-ULP ${name} change left the fit unchanged`);
		else console.log(`ok   teeth: a one-ULP ${name} change shows (${d})`);
	}
} else fail("no scene with a physical fit for the teeth");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
