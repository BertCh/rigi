// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/look/color-stats-fold.check.ts [scenes]   (exits 1 on failure; CI fast tier: 12)
// Node check of the band-stats fold on the GPU (./color-stats-fold.ts, fold "gpu"), no GPU: a CPU
// emulation of the f32 kernels against the float64 fold it replaced.
//  1. the CSR selection matrix (foldSelectionCsr) sums value j of every workgroup exactly once;
//  2. synthetic scenes (photo bytes, premultiplied layer, range with sky, people mask) through the
//     CPU reference look/color-stats.ts reduceBands(bandInputs(...)) (f64), and through an emulation
//     of the GPU: BAND_STATS' per-invocation f32 sums and workgroup tree (or BAND_STATS_SG's subgroup
//     sums) → partials, then (a) the f64 fold + finalizeBands (fold "f64") and (b) the f32 SpMV
//     row sum (luma's subgroup-row / workgroup-row: one nonzero per lane, then a tree) + BAND_FINALIZE
//     in f32 (twin below) + statsFromWords (fold "gpu"). Asserts: same count / valid; every
//     ColorStats field of (b) within 2e-5 of the reference (a measures ~1e-6) and the harmonize
//     transfer (deck-webgpu/layers/composite.ts harmonize: Oklab Reinhard per range band, then sRGB
//     bytes) of (b) differs from (a) by at most 1 byte on < 0.5 % of bytes of 200 000 random pixels;
//  3. finalize edge cases: empty bands back-filled from the nearest trusted band (lower first), no
//     trusted band → identity / valid false, BAND_STATS_SG's -1e20 layout-failure marker → valid -1
//     (subgroupLayoutFailed), counts exact in f32;
//  4. teeth: a wrong selection (value j+1 folded into row j) and a dropped workgroup both fail (2).
import {
	BAND_CENTERS_LOG10,
	type ColorStats,
	N_BANDS,
} from "../../look/color-stats";
import { finalizeBands } from "./color-stats";
import { STATS_VALUES } from "./color-stats.wgsl";
import {
	foldSelectionCsr,
	statsFromWords,
	subgroupLayoutFailed,
} from "./color-stats-fold";
import {
	emulateFinalize,
	emulatePartials,
	emulateSpmv,
	foldF64,
	GROUPS,
	gpuFold,
	lcg,
	makeScene,
	maxDelta,
	sameCounts,
} from "./color-stats-fold.fixtures";

const SCENES = Number(process.argv[2] ?? 12);

let failed = 0;
const fail = (msg: string) => {
	failed++;
	console.log(`FAIL ${msg}`);
};

// ---------- 1. the selection matrix ----------
for (const groups of [1, 7, GROUPS]) {
	const { rows, cols, vals } = foldSelectionCsr(groups);
	const seen = new Uint8Array(groups * STATS_VALUES);
	for (let j = 0; j < STATS_VALUES; j++) {
		if (rows[j + 1] - rows[j] !== groups) fail(`csr row ${j} length`);
		for (let i = rows[j]; i < rows[j + 1]; i++) {
			if (cols[i] % STATS_VALUES !== j) fail(`csr row ${j} col ${cols[i]}`);
			if (vals[i] !== 1) fail(`csr value ${i}`);
			seen[cols[i]]++;
		}
	}
	if (!seen.every((c) => c === 1))
		fail(`csr groups=${groups}: not a partition`);
}
console.log("csr selection matrix: ok");

// ---------- the harmonize transfer (composite.ts harmonize, f64 here) → sRGB bytes ----------
function oklabToLinear(
	L: number,
	A: number,
	B: number,
): [number, number, number] {
	const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}
const C = BAND_CENTERS_LOG10;
function band(m: Float32Array, lg: number, c: number) {
	const at = (k: number) => m[k * 3 + c];
	if (lg <= C[0]) return at(0);
	if (lg >= C[3]) return at(3);
	for (let k = 0; k < 3; k++)
		if (lg < C[k + 1])
			return at(k) + ((at(k + 1) - at(k)) * (lg - C[k])) / (C[k + 1] - C[k]);
	return at(3);
}
const srgbByte = (x: number) => {
	const v = Math.min(1, Math.max(0, x));
	return Math.round(
		255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055),
	);
};
function harmonizeBytes(
	s: ColorStats,
	lab: Float32Array,
	lg: Float32Array,
	out: Uint8Array,
) {
	const amount = 1;
	const k = [amount, amount * 0.6, amount * 0.6];
	for (let i = 0; i < lg.length; i++) {
		const t = [0, 0, 0];
		for (let c = 0; c < 3; c++) {
			const x = lab[i * 3 + c];
			const ratio = Math.min(
				2,
				Math.max(0.5, band(s.photoStd, lg[i], c) / band(s.layerStd, lg[i], c)),
			);
			const v =
				(x - band(s.layerMean, lg[i], c)) * ratio + band(s.photoMean, lg[i], c);
			t[c] = x + (v - x) * k[c];
		}
		const rgb = oklabToLinear(t[0], t[1], t[2]);
		for (let c = 0; c < 3; c++) out[i * 3 + c] = srgbByte(rgb[c]);
	}
}

let worstF64 = 0;
let worstGpu = 0;
let worstBytes = 0;
let differ = 0;
let differBase = 0;
let total = 0;
let teethWrong = 0;
let teethDrop = 0;
const csr = foldSelectionCsr(GROUPS);
const wrong = foldSelectionCsr(GROUPS);
for (let i = 0; i < wrong.cols.length; i++)
	// every band's Σ photo L reads Σ photo a
	if ((wrong.cols[i] % STATS_VALUES) % 13 === 1) wrong.cols[i] += 1;
const drop = foldSelectionCsr(GROUPS);
// every value of workgroup 5
for (let i = 0; i < drop.cols.length; i++)
	if (Math.floor(drop.cols[i] / STATS_VALUES) === 5) drop.vals[i] = 0;
for (let seed = 1; seed <= SCENES; seed++) {
	const { px, ref } = makeScene(seed);
	for (const sg of [false, 32] as const) {
		const p = emulatePartials(px, sg);
		const a = foldF64(p, 60);
		const b = gpuFold(p, 60, csr);
		const tag = `scene ${seed}${sg ? " sg" : ""}`;
		if (!sameCounts(ref, a) || !sameCounts(ref, b)) {
			fail(
				`${tag}: count / valid ref=${ref.count} f64=${a.count} gpu=${b.count}`,
			);
			continue;
		}
		if (!ref.valid) fail(`${tag}: scene has no trusted band`);
		const da = maxDelta(ref, a);
		const db = maxDelta(ref, b);
		worstF64 = Math.max(worstF64, da);
		worstGpu = Math.max(worstGpu, db);
		if (db > 2e-5)
			fail(`${tag}: gpu fold max |Δ| ${db.toExponential(2)} > 2e-5`);
		// the transfer on random Oklab pixels across the range bands
		const rnd = lcg(seed * 7 + (sg ? 1 : 0));
		const N = 200_000 / SCENES / 2;
		const lab = new Float32Array(N * 3);
		const lg = new Float32Array(N);
		for (let i = 0; i < N; i++) {
			lab[i * 3] = 0.2 + 0.75 * rnd();
			lab[i * 3 + 1] = 0.12 * (rnd() - 0.5);
			lab[i * 3 + 2] = 0.12 * (rnd() - 0.5);
			lg[i] = 2.3 + 2.5 * rnd();
		}
		const ba = new Uint8Array(N * 3);
		const bb = new Uint8Array(N * 3);
		harmonizeBytes(a, lab, lg, ba);
		harmonizeBytes(b, lab, lg, bb);
		// the fold "f64" arm against the exact f64 reference: the rounding-flip baseline
		const br = new Uint8Array(N * 3);
		harmonizeBytes(ref, lab, lg, br);
		for (let i = 0; i < ba.length; i++) if (ba[i] !== br[i]) differBase++;
		for (let i = 0; i < ba.length; i++) {
			const d = Math.abs(ba[i] - bb[i]);
			if (d) differ++;
			worstBytes = Math.max(worstBytes, d);
		}
		total += ba.length;
		// teeth
		if (maxDelta(ref, gpuFold(p, 60, wrong)) > 2e-5) teethWrong++;
		const dropped = gpuFold(p, 60, drop);
		if (!sameCounts(ref, dropped) || maxDelta(ref, dropped) > 2e-5) teethDrop++;
	}
}
if (worstBytes > 1) fail(`harmonize bytes differ by ${worstBytes} > 1`);
if (differ / total >= 5e-3)
	fail(`harmonize bytes differ on ${differ}/${total} ≥ 0.5 %`);
if (teethWrong !== SCENES * 2)
	fail(`teeth: wrong selection caught ${teethWrong}/${SCENES * 2}`);
if (teethDrop !== SCENES * 2)
	fail(`teeth: dropped workgroup caught ${teethDrop}/${SCENES * 2}`);
console.log(
	`${SCENES} scenes × {tree, subgroups}: max |Δ| vs reduceBands f64-fold ${worstF64.toExponential(2)}, gpu-fold ${worstGpu.toExponential(2)}; harmonize bytes vs f64-fold max Δ ${worstBytes}, ${differ}/${total} differ (f64-fold vs reduceBands: ${differBase})`,
);

// ---------- 3. finalize edge cases ----------
{
	const folded = (counts: number[]) => {
		const v = new Float32Array(STATS_VALUES);
		const rnd = lcg(counts.join("").length + counts[0]);
		for (let b = 0; b < N_BANDS; b++) {
			const n = counts[b];
			v[b * 13] = n;
			for (let c = 0; c < 3; c++) {
				const m = 0.3 + 0.4 * rnd();
				const sd = 0.05 * rnd();
				v[b * 13 + 1 + c] = n * m;
				v[b * 13 + 4 + c] = n * (m * m + sd * sd);
				v[b * 13 + 7 + c] = n * (m + 0.05);
				v[b * 13 + 10 + c] = n * ((m + 0.05) ** 2 + sd * sd);
			}
		}
		return v;
	};
	const cases = [
		[100, 0, 0, 500],
		[0, 59, 60, 0],
		[0, 0, 0, 61],
		[59, 59, 59, 59],
		[0, 0, 0, 0],
		[16_000_000, 3, 70, 0],
	];
	for (const counts of cases) {
		const v = folded(counts);
		const acc = new Float64Array(N_BANDS * 12);
		for (let b = 0; b < N_BANDS; b++)
			for (let k = 0; k < 12; k++) acc[b * 12 + k] = v[b * 13 + 1 + k];
		const want = finalizeBands(acc, Uint32Array.from(counts), 60);
		const words = emulateFinalize(v, 60);
		const got = statsFromWords(words);
		if (subgroupLayoutFailed(words))
			fail(`finalize ${counts}: flagged as layout failure`);
		if (!sameCounts(want, got) || maxDelta(want, got) > 1e-5)
			fail(
				`finalize ${counts}: valid ${got.valid}/${want.valid} Δ ${maxDelta(want, got)}`,
			);
	}
	// BAND_STATS_SG's marker in one workgroup's partials
	const p = new Float32Array(GROUPS * STATS_VALUES).fill(3);
	for (let k = 0; k < STATS_VALUES; k++) p[5 * STATS_VALUES + k] = -1e20;
	for (let g = 0; g < GROUPS; g++) p[g * STATS_VALUES] = 1000;
	const words = emulateFinalize(emulateSpmv(p, csr), 60);
	if (!subgroupLayoutFailed(words))
		fail("subgroup layout marker not seen after the fold");
	if (statsFromWords(words).valid) fail("marker: stats valid");
	console.log("finalize edge cases: ok");
}

if (failed) {
	console.log(`FAIL color-stats-fold: ${failed} failure(s)`);
	process.exit(1);
}
console.log("PASS color-stats-fold");
