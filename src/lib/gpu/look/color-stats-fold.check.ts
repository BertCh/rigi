// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/look/color-stats-fold.check.ts [scenes]   (exits 1 on failure; CI fast tier: 12)
// Node check of the band-stats fold on the GPU (./color-stats-fold.ts, ?statsFold=gpu), no GPU: a CPU
// emulation of the f32 kernels against the float64 fold it replaced.
//  1. the CSR selection matrix (foldSelectionCsr) sums value j of every workgroup exactly once;
//  2. synthetic scenes (photo bytes, premultiplied layer, range with sky, people mask) through the
//     CPU reference look/color-stats.ts reduceBands(bandInputs(...)) (f64), and through an emulation
//     of the GPU: BAND_STATS' per-invocation f32 sums and workgroup tree (or BAND_STATS_SG's subgroup
//     sums) → partials, then (a) the f64 fold + finalizeBands (?statsFold=f64) and (b) the f32 SpMV
//     row sum (luma's subgroup-row / workgroup-row: one nonzero per lane, then a tree) + BAND_FINALIZE
//     in f32 (twin below) + statsFromWords (?statsFold=gpu). Asserts: same count / valid; every
//     ColorStats field of (b) within 2e-5 of the reference (a measures ~1e-6) and the harmonize
//     transfer (deck-webgpu/layers/composite.ts harmonize: Oklab Reinhard per range band, then sRGB
//     bytes) of (b) differs from (a) by at most 1 byte on < 0.5 % of bytes of 200 000 random pixels;
//  3. finalize edge cases: empty bands back-filled from the nearest trusted band (lower first), no
//     trusted band → identity / valid false, BAND_STATS_SG's -1e20 layout-failure marker → valid -1
//     (subgroupLayoutFailed), counts exact in f32;
//  4. teeth: a wrong selection (value j+1 folded into row j) and a dropped workgroup both fail (2).
import {
	BAND_CENTERS_LOG10,
	bandInputs,
	type ColorStats,
	N_BANDS,
	reduceBands,
} from "../../look/color-stats";
import { finalizeBands } from "./color-stats";
import { STATS_VALUES } from "./color-stats.wgsl";
import {
	foldSelectionCsr,
	STATS_WORDS,
	statsFromWords,
	subgroupLayoutFailed,
} from "./color-stats-fold";
import { STATS_LAYOUT } from "./color-stats-fold.wgsl";

const SCENES = Number(process.argv[2] ?? 12);
const GROUPS = 32;
const WG = 64;
const f = Math.fround;

let failed = 0;
const fail = (msg: string) => {
	failed++;
	console.log(`FAIL ${msg}`);
};

function lcg(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

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

// ---------- emulation of the GPU kernels ----------
type Pixels = { a: Float32Array; b: Float32Array; R: Float32Array; n: number };

/** BAND_STATS (sg = false) / BAND_STATS_SG (sg = subgroup size): GROUPS × 52 f32 partials. */
function emulatePartials(px: Pixels, sg: number | false): Float32Array {
	const threads = GROUPS * WG;
	const out = new Float32Array(GROUPS * STATS_VALUES);
	const acc = Array.from({ length: WG }, () => new Float32Array(STATS_VALUES));
	for (let g = 0; g < GROUPS; g++) {
		for (let l = 0; l < WG; l++) {
			const A = acc[l];
			A.fill(0);
			for (let i = g * WG + l; i < px.n; i += threads) {
				const j = i * 4;
				if (px.b[j + 3] < 0.5) continue;
				const r = px.R[i];
				const band = r < 1000 ? 0 : r < 5000 ? 1 : r < 20000 ? 2 : 3;
				const o = band * 13;
				A[o] = f(A[o] + 1);
				for (let c = 0; c < 3; c++) {
					const av = px.a[j + c];
					const bv = px.b[j + c];
					A[o + 1 + c] = f(A[o + 1 + c] + av);
					A[o + 4 + c] = f(A[o + 4 + c] + f(av * av));
					A[o + 7 + c] = f(A[o + 7 + c] + bv);
					A[o + 10 + c] = f(A[o + 10 + c] + f(bv * bv));
				}
			}
		}
		for (let k = 0; k < STATS_VALUES; k++) {
			const v = Float32Array.from(acc, (A) => A[k]);
			let s: number;
			if (sg) {
				// subgroupAdd per subgroup (a tree), then invocation k sums the subgroups in order
				s = 0;
				for (let q = 0; q < WG; q += sg)
					s = f(s + treeSum(v.subarray(q, q + sg)));
			} else s = treeSum(v);
			out[g * STATS_VALUES + k] = s;
		}
	}
	return out;
}

/** f32 pairwise sum (workgroup tree / subgroupAdd model). */
function treeSum(v: Float32Array): number {
	const t = Float32Array.from(v);
	for (let s = t.length >> 1; s > 0; s >>= 1)
		for (let i = 0; i < s; i++) t[i] = f(t[i] + t[i + s]);
	return t[0];
}

/** luma's SpMV row sum: one nonzero per lane (≤ 64 per row here), then a tree, f32. */
function emulateSpmv(
	partial: Float32Array,
	csr: ReturnType<typeof foldSelectionCsr>,
): Float32Array {
	const folded = new Float32Array(STATS_VALUES);
	for (let j = 0; j < STATS_VALUES; j++) {
		const lanes = new Float32Array(64);
		for (let i = csr.rows[j]; i < csr.rows[j + 1]; i++)
			lanes[(i - csr.rows[j]) % 64] = f(
				lanes[(i - csr.rows[j]) % 64] + f(csr.vals[i] * partial[csr.cols[i]]),
			);
		folded[j] = treeSum(lanes);
	}
	return folded;
}

/** BAND_FINALIZE (color-stats-fold.wgsl.ts) in f32, one "invocation" per band: the STATS_WORDS words. */
function emulateFinalize(folded: Float32Array, minCount: number): ArrayBuffer {
	const out = new Float32Array(STATS_WORDS);
	const trusted = (b: number) => folded[b * 13] >= minCount;
	let anyOk = false;
	let broken = false;
	for (let b = 0; b < N_BANDS; b++) {
		anyOk ||= trusted(b);
		broken ||= folded[b * 13] < 0;
	}
	const valid = anyOk && !broken;
	out[STATS_LAYOUT.valid] = broken ? -1 : valid ? 1 : 0;
	for (let k = 0; k < N_BANDS; k++) {
		out[STATS_LAYOUT.count + k] = broken ? 0 : folded[k * 13];
		let src = k;
		if (!trusted(k))
			for (let dk = 1; dk < N_BANDS; dk++) {
				if (k >= dk && trusted(k - dk)) {
					src = k - dk;
					break;
				}
				if (k + dk < N_BANDS && trusted(k + dk)) {
					src = k + dk;
					break;
				}
			}
		const o = src * 13;
		const n = folded[o];
		for (let c = 0; c < 3; c++) {
			const pm = f(folded[o + 1 + c] / n);
			const lm = f(folded[o + 7 + c] / n);
			const lo = c === 0 ? f(0.01) : f(0.004);
			const ps = Math.max(
				lo,
				f(Math.sqrt(Math.max(0, f(f(folded[o + 4 + c] / n) - f(pm * pm))))),
			);
			const ls = Math.max(
				lo,
				f(Math.sqrt(Math.max(0, f(f(folded[o + 10 + c] / n) - f(lm * lm))))),
			);
			const j = k * 3 + c;
			out[STATS_LAYOUT.photoMean + j] = valid ? pm : 0;
			out[STATS_LAYOUT.photoStd + j] = valid ? ps : 1;
			out[STATS_LAYOUT.layerMean + j] = valid ? lm : 0;
			out[STATS_LAYOUT.layerStd + j] = valid ? ls : 1;
		}
	}
	return out.buffer;
}

/** bandStatsGpu's f64 fold (?statsFold=f64). */
function foldF64(p: Float32Array, minCount: number): ColorStats {
	const acc = new Float64Array(N_BANDS * 12);
	const cnt = new Uint32Array(N_BANDS);
	for (let g = 0; g < GROUPS; g++)
		for (let b = 0; b < N_BANDS; b++) {
			const s = g * STATS_VALUES + b * 13;
			cnt[b] += Math.round(p[s]);
			for (let v = 0; v < 12; v++) acc[b * 12 + v] += p[s + 1 + v];
		}
	return finalizeBands(acc, cnt, minCount);
}

const gpuFold = (
	p: Float32Array,
	minCount: number,
	csr = foldSelectionCsr(GROUPS),
) => statsFromWords(emulateFinalize(emulateSpmv(p, csr), minCount));

const KEYS = ["photoMean", "photoStd", "layerMean", "layerStd"] as const;
function maxDelta(a: ColorStats, b: ColorStats) {
	let m = 0;
	for (const k of KEYS)
		for (let i = 0; i < a[k].length; i++)
			m = Math.max(m, Math.abs(a[k][i] - b[k][i]));
	return m;
}
const sameCounts = (a: ColorStats, b: ColorStats) =>
	a.valid === b.valid && a.count.every((c, i) => c === b.count[i]);

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

// ---------- 2. synthetic scenes ----------
function makeScene(seed: number) {
	const rnd = lcg(seed);
	const w = [256, 192, 256, 144][seed % 4];
	const h = [192, 256, 144, 256][seed % 4];
	const n = w * h;
	const photo = new Uint8ClampedArray(n * 4);
	const layer = new Float32Array(n * 4);
	const range = new Float32Array(n);
	const fg = seed % 3 === 0 ? new Float32Array(n) : null;
	const skyline = h * (0.15 + 0.3 * rnd());
	// snowy / flat scenes stress the E[x²] − E[x]² cancellation of the f32 finalize
	const flat = seed % 5 === 0;
	const tint = [rnd(), rnd(), rnd()];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sky = y < skyline + 8 * Math.sin(x / 17 + seed);
			// metres: far (60 km) at the skyline down to near (300 m) at the bottom
			const t = (y - skyline) / (h - skyline);
			range[i] = sky ? 0 : 60000 * 200 ** -Math.max(0, t) * (0.9 + 0.2 * rnd());
			const base = flat ? 0.9 : 0.25 + 0.5 * t + 0.1 * Math.sin(x / 9);
			for (let c = 0; c < 3; c++) {
				const v = Math.min(
					1,
					Math.max(
						0,
						base * (0.8 + 0.3 * tint[c]) + (flat ? 0.01 : 0.08) * (rnd() - 0.5),
					),
				);
				photo[i * 4 + c] = Math.round(255 * v);
				// linear, premultiplied; a few partial-coverage pixels
				layer[i * 4 + c] =
					(0.6 * v ** 2.2 + 0.05 * rnd()) * (rnd() < 0.02 ? 0.5 : 1);
			}
			photo[i * 4 + 3] = 255;
			layer[i * 4 + 3] = rnd() < 0.02 ? 0.5 : 1;
			if (fg) fg[i] = x > w * 0.4 && x < w * 0.5 && y > h * 0.7 ? 1 : 0;
		}
	const minRange = [0, 300, 1500][seed % 3];
	const { a, b } = bandInputs(
		photo,
		layer,
		w,
		h,
		(x, y) => range[y * w + x],
		fg ? (x, y) => fg[y * w + x] : undefined,
		minRange,
	);
	// the GPU's own validity uses r > minRange from `range` directly: same as bandInputs' R
	return { px: { a, b, R: range, n } as Pixels, ref: reduceBands(a, b, n) };
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
		// today's ?statsFold=f64 against the exact f64 reference: the rounding-flip baseline
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
