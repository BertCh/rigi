// Bench of the look graphs (relief-graph.ts, guided-filter-graph.ts, color-stats-graph.ts; the only GPU
// paths of relief / guided filter / band stats) in the page realm (scripts/gpu/look-graph-bench.mjs).
// Checks:
// - determinism over many photos × sizes: every case run twice back to back must give the same bits
//   (relief field/gen bytes, guided q as f32 bits, band-stats per-workgroup partials as f32 bits AND
//   the folded ColorStats as f64 bits), NaN-injected inputs included, subgroup variant included where
//   the device has subgroups;
// - CPU parity (reported): guided q and band stats vs their CPU twins (look/guided-filter.ts
//   guidedFilter, look/color-stats.ts bandInputs + reduceBands), max |Δ|; the relief CPU parity on
//   real tiles is look-bench.mjs (runLookBench);
// - stale transients: the same shape (cache hit) A → B → A, where the second A must equal the first,
//   bit for bit;
// - the clear rule: the relief graph without its clear nodes must fail the compile-time lint;
// - VRAM: pooled-equivalent bytes (pow2 capacities) vs graph imports + physical transients (after
//   aliasing);
// - timing: medians of graph calls.
import type { Device } from "@luma.gl/core";
import { bandInputs, reduceBands } from "../../look/color-stats";
import { guidedFilter } from "../../look/guided-filter";
import { ComputeGraph } from "../core/graph";
import { capacityFor } from "../core/pool";
import { getComputeDevice, hasFeature } from "../device";
import { type BandStatsInput, bandStatsGpu, GROUPS, WG } from "./color-stats";
import { STATS_VALUES } from "./color-stats.wgsl";
import { bandPartialsGraph, lastStatsGraphRun } from "./color-stats-graph";
import { type GuidedJob, guidedFiltersGpu } from "./guided-filter";
import { lastGuidedGraphRun } from "./guided-filter-graph";
import { reliefPassesGpu } from "./relief";
import {
	buildReliefGraph,
	lastReliefGraphRun,
	reliefScratchBytes,
} from "./relief-graph";

type Vec3 = [number, number, number];
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

async function rasterise(name: string, W: number, H: number) {
	const img = new Image();
	img.src = `/photos/${name}.jpg`;
	await img.decode();
	const c = new OffscreenCanvas(W, H);
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("no 2d context");
	ctx.drawImage(img, 0, 0, W, H);
	return new Uint8Array(ctx.getImageData(0, 0, W, H).data);
}

/** Differing elements, bytes or 32-bit words (floats compared as bits: NaN = NaN, -0 ≠ +0). */
function differ(a: ArrayBufferView, b: ArrayBufferView, words: boolean) {
	const x = words
		? new Uint32Array(a.buffer, a.byteOffset, a.byteLength / 4)
		: new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	const y = words
		? new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4)
		: new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	if (x.length !== y.length) return -1;
	let n = 0;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
	return n;
}

/** Differing f64 values (as bits) over every numeric field of two ColorStats-like objects. */
function differStats(a: object, b: object) {
	let n = 0;
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	for (const k of Object.keys(ra)) {
		const x = ra[k];
		const y = rb[k];
		if (ArrayBuffer.isView(x) && ArrayBuffer.isView(y)) {
			const fx = Float64Array.from(x as unknown as ArrayLike<number>);
			const fy = Float64Array.from(y as unknown as ArrayLike<number>);
			const d = differ(
				new Uint32Array(fx.buffer),
				new Uint32Array(fy.buffer),
				true,
			);
			n += d < 0 ? 1e9 : d;
		} else if (!Object.is(x, y)) n++;
	}
	return n;
}

const nanCount = (a: ArrayBufferView) => {
	const f = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
	let n = 0;
	for (const v of f) if (Number.isNaN(v)) n++;
	return n;
};

// ---------- inputs from photos ----------

const lum = (px: Uint8Array, i: number) =>
	(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;

/** Sprinkle NaN into `a` (every `step`-th element from `from`). */
function withNaN(a: Float32Array, step: number, from = 7) {
	const b = a.slice();
	for (let i = from; i < b.length; i += step) b[i] = Number.NaN;
	return b;
}

async function guidedInput(name: string, w: number, h: number, jobs: number) {
	const px = await rasterise(name, w, h);
	const n = w * h;
	const I = new Float32Array(n);
	const cov = new Float32Array(n);
	const fg = new Float32Array(n);
	const blue = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		I[i] = lum(px, i);
		cov[i] = px[i * 4] > 128 ? 1 : 0;
		fg[i] = I[i] > 0.6 ? 1 : 0;
		blue[i] = px[i * 4 + 2] / 255;
	}
	const all: GuidedJob[] = [
		{ p: cov, r: Math.max(2, Math.round(w * 0.008)), eps: 4e-4 },
		{ p: fg, r: Math.max(3, Math.round(w * 0.012)), eps: 1e-3 },
		{ p: blue, r: 5, eps: 1e-2 },
	];
	return { I, jobs: all.slice(0, jobs) };
}

async function statsInput(
	name: string,
	other: string,
	w: number,
	h: number,
	opts: { fg?: boolean; minRange?: number; nan?: boolean },
): Promise<BandStatsInput> {
	const photo = await rasterise(name, w, h);
	const lay = await rasterise(other, w, h);
	const n = w * h;
	const layer = new Float32Array(n * 4);
	const range = new Float32Array(n);
	const fg = opts.fg ? new Float32Array(n) : null;
	for (let i = 0; i < n; i++) {
		const y = Math.floor(i / w);
		const x = i - y * w;
		for (let c = 0; c < 3; c++)
			layer[i * 4 + c] = (lay[i * 4 + c] / 255) ** 2.2;
		layer[i * 4 + 3] = x < w * 0.1 ? 0.5 : 1;
		// sky above ~20 %, then 0.3 .. 40 km down the frame (all four bands), photo-textured
		range[i] =
			y < h * 0.2 + 10 * lum(photo, i)
				? 0
				: 300 + (1 - y / h) * 40000 * (0.6 + 0.4 * lum(lay, i));
		if (fg) fg[i] = lum(photo, i) > 0.85 ? 1 : 0;
	}
	if (opts.nan) {
		for (let i = 13; i < n; i += 97) range[i] = Number.NaN;
		for (let i = 29; i < n; i += 131) layer[i * 4 + 3] = Number.NaN;
		for (let i = 31; i < n; i += 151) layer[i * 4 + 1] = Number.NaN;
		if (fg) for (let i = 17; i < n; i += 89) fg[i] = Number.NaN;
		for (let i = 5; i < n; i += 211) range[i] = -1;
	}
	return {
		photo,
		layer,
		w,
		h,
		range,
		fg,
		minRange: opts.minRange ?? 0,
		minCount: 60,
	};
}

const HOLE = -1e6;

async function reliefInput(name: string, res: number, nan: boolean) {
	const px = await rasterise(name, res, res);
	const H = new Float32Array(res * res);
	for (let i = 0; i < H.length; i++) {
		const y = Math.floor(i / res);
		H[i] = 400 + 2600 * lum(px, i) + 0.8 * y;
		// holes: a strip along one edge and a few blobs
		if (y < 3 || (i % 5003 < 40 && y > res / 2)) H[i] = HOLE;
	}
	return nan ? withNaN(H, 4099, 101) : H;
}

// the relief passes' px at `res` (field.ts: 40 km across)
const pxOf = (res: number) => 40000 / res;

const SUNS: Record<string, Vec3> = {
	xMajorLow: [0.9, 0.3, 0.2],
	yMajorNeg: [-0.2, -0.95, 0.25],
	steep: [0.1, 0.1, 0.99],
	exactDiag: [0.6, 0.6, 0.53],
	belowHorizon: [0.7, 0.2, -0.3],
	zenith: [0, 0, 1],
};

// ---------- per-pipeline comparisons ----------

/** Max |a − b| over pairs where both are finite, and the pairs where exactly one is NaN. */
function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>) {
	let m = 0;
	let nan = 0;
	for (let i = 0; i < a.length; i++) {
		if (Number.isNaN(a[i]) !== Number.isNaN(b[i])) nan++;
		const d = Math.abs(a[i] - b[i]);
		if (d > m) m = d;
	}
	return { max: m, nanMismatch: nan };
}

async function reliefCase(
	device: Device,
	H: Float32Array,
	res: number,
	sun: Vec3,
	ref?: { field: Uint8Array; gen: Uint8Array },
) {
	const a = await reliefPassesGpu(device, H, res, pxOf(res), sun);
	const hit = lastReliefGraphRun.hit;
	const b = ref ?? (await reliefPassesGpu(device, H, res, pxOf(res), sun));
	return {
		field: differ(a.field, b.field, false),
		gen: differ(a.gen, b.gen, false),
		hit,
		out: a,
	};
}

async function guidedCase(
	device: Device,
	I: Float32Array,
	w: number,
	h: number,
	jobs: GuidedJob[],
	ref?: Float32Array[],
) {
	const a = await guidedFiltersGpu(device, I, w, h, jobs);
	const hit = lastGuidedGraphRun.hit;
	const b = ref ?? (await guidedFiltersGpu(device, I, w, h, jobs));
	const cpu = jobs.map((j, k) =>
		maxAbs(a[k], guidedFilter(I, j.p, w, h, j.r, j.eps)),
	);
	return {
		q: a.map((x, k) => differ(x, b[k], true)),
		nanQ: a.map(nanCount),
		cpuMaxAbs: cpu.map((c) => c.max),
		cpuNaNMismatch: cpu.map((c) => c.nanMismatch),
		hit,
		out: a,
	};
}

/** The words bandStatsGpu builds (keep in sync with color-stats.ts). */
function statsWords(o: BandStatsInput) {
	const words = new ArrayBuffer(20);
	new Uint32Array(words, 0, 4).set([o.w, o.h, GROUPS * WG, o.fg ? 1 : 0]);
	new Float32Array(words, 16, 1)[0] = o.minRange ?? 0;
	const R = new Float32Array(o.w * o.h);
	for (let i = 0; i < R.length; i++) {
		const r = o.range[i];
		R[i] = r > 0 && Number.isFinite(r) ? r : 0;
	}
	return { words, R };
}

async function statsCase(
	device: Device,
	o: BandStatsInput,
	sg: boolean,
	ref?: { partials: Float32Array; stats: object },
) {
	const { words, R } = statsWords(o);
	const pa = await bandPartialsGraph(device, o, words, R, sg);
	const hit = lastStatsGraphRun.hit;
	const pb =
		ref?.partials ?? (await bandPartialsGraph(device, o, words, R, sg));
	const sa = await bandStatsGpu(device, o, { subgroups: sg });
	const sb = ref?.stats ?? (await bandStatsGpu(device, o, { subgroups: sg }));
	const { a, b } = bandInputs(
		o.photo as Uint8ClampedArray,
		o.layer,
		o.w,
		o.h,
		(x, y) => o.range[y * o.w + x],
		o.fg ? (x, y) => (o.fg as Float32Array)[y * o.w + x] : undefined,
		o.minRange,
	);
	const cpu = reduceBands(a, b, o.w * o.h, o.minCount);
	let negative = 0;
	for (let g = 0; g < GROUPS; g++) if (pa[g * STATS_VALUES] < 0) negative++;
	return {
		partials: differ(pa, pb, true),
		stats: differStats(sa, sb),
		cpuMaxAbs: Math.max(
			...(["photoMean", "photoStd", "layerMean", "layerStd"] as const).map(
				(k) => maxAbs(sa[k], cpu[k]).max,
			),
		),
		cpuSameCounts: sa.count.join() === cpu.count.join(),
		sgCheckFailedGroups: negative,
		valid: sa.valid,
		counts: Array.from(sa.count),
		hit,
		out: { partials: pa, stats: sa },
	};
}

// ---------- the clear lint ----------

async function lintTest(device: Device) {
	const out: Record<string, unknown> = {};
	for (const skip of [true, false]) {
		const g = new ComputeGraph<undefined>(device, `relief-lint-${skip}`);
		buildReliefGraph(g, 64, 64 * 64 * 4, 80, false, skip);
		try {
			await g.compileAsync();
			out[skip ? "withoutClears" : "withClears"] = "compiled";
		} catch (e) {
			out[skip ? "withoutClears" : "withClears"] =
				`threw: ${String((e as Error).message).slice(0, 160)}`;
		}
		g.destroy();
	}
	out.ok =
		String(out.withoutClears).startsWith("threw") &&
		out.withClears === "compiled";
	return out;
}

// ---------- VRAM ----------

function vram(device: Device) {
	const cap = (xs: number[]) => xs.reduce((s, b) => s + capacityFor(b), 0);
	const out: Record<string, unknown> = {};
	// relief at 1024: pooled equivalent = H + 7 scratch slots (+ prm) at pow2 capacity
	{
		const res = 1024;
		const s = reliefScratchBytes(res);
		const oldB = cap([res * res * 4, 80, ...Object.values(s)]);
		const st = lastReliefGraphRun.stats;
		out.relief = {
			res,
			pooledEquivalentBytes: oldB,
			graphImportBytes: cap([res * res * 4, 80]),
			graphLogicalTransientBytes: st?.logicalTransientBytes,
			graphPhysicalTransientBytes: st?.physicalTransientBytes,
			graphPhysicalBuffers: `${st?.physicalTransientBufferCount}/${st?.logicalTransientBufferCount}`,
			graphTotal: cap([res * res * 4, 80]) + (st?.physicalTransientBytes ?? 0),
		};
	}
	return { ...out, device: device.info?.gpu };
}

// ---------- entry ----------

export async function runLookGraphBench(
	opts: { names?: string[]; reps?: number } = {},
) {
	const device = await getComputeDevice();
	if (!device) return { error: "no WebGPU compute device" };
	const names = opts.names ?? ["IMG_6958", "IMG_7086", "IMG_7131", "IMG_7155"];
	const reps = opts.reps ?? 9;
	const sg = hasFeature(device, "subgroups");
	const out: Record<string, unknown> = { subgroups: sg };
	const fail: string[] = [];
	const check = (tag: string, { out: _, ...r }: Record<string, unknown>) => {
		const bad = Object.entries(r).some(
			([k, v]) =>
				(k === "field" || k === "gen" || k === "partials" || k === "stats") &&
				v !== 0,
		);
		const badQ = Array.isArray(r.q) && (r.q as number[]).some((d) => d !== 0);
		if (bad || badQ) fail.push(tag);
		return { tag, ...r };
	};

	// relief: photos × res × suns (incl. both degenerate ones), NaN heights on one photo per res
	const relief: unknown[] = [];
	for (const res of [256, 512, 1024, 2048]) {
		for (const [ni, name] of names.entries()) {
			const suns =
				ni === 0 ? Object.keys(SUNS) : [Object.keys(SUNS)[ni % 4], "zenith"];
			for (const nan of ni === 0 ? [false, true] : [false]) {
				const H = await reliefInput(name, res, nan);
				for (const s of suns)
					relief.push(
						check(
							`relief ${name} ${res} ${s}${nan ? " NaN" : ""}`,
							await reliefCase(device, H, res, SUNS[s]),
						),
					);
			}
		}
	}
	// twice with different data at one shape: A → B → A (hits); the second A against the first
	{
		const A = await reliefInput(names[0], 512, false);
		const B = await reliefInput(names[1], 512, false);
		const first = await reliefCase(device, A, 512, SUNS.xMajorLow);
		const mid = await reliefCase(device, B, 512, SUNS.xMajorLow);
		const again = await reliefCase(device, A, 512, SUNS.xMajorLow, first.out);
		out.reliefTwice = [
			check("relief twice A", first),
			check("relief twice B", mid),
			check("relief twice A vs first A", again),
		];
	}
	out.relief = relief;

	// guided: photos × sizes × job counts, NaN in I and p on one photo
	const guided: unknown[] = [];
	const gSizes: [number, number][] = [
		[512, 384],
		[333, 251],
		[1024, 768],
		[97, 61],
		[2048, 1536],
		[384, 512],
	];
	for (const [w, h] of gSizes)
		for (const [ni, name] of names.entries()) {
			const jobs = 1 + ((ni + w) % 3);
			const inp = await guidedInput(name, w, h, jobs);
			guided.push(
				check(
					`guided ${name} ${w}x${h} jobs${jobs}`,
					await guidedCase(device, inp.I, w, h, inp.jobs),
				),
			);
			if (ni === 0) {
				const I = withNaN(inp.I, 997);
				const jobsN = inp.jobs.map((j) => ({ ...j, p: withNaN(j.p, 1499, 3) }));
				guided.push(
					check(
						`guided ${name} ${w}x${h} NaN`,
						await guidedCase(device, I, w, h, jobsN),
					),
				);
			}
		}
	{
		const A = await guidedInput(names[0], 512, 384, 2);
		const B = await guidedInput(names[1], 512, 384, 2);
		const first = await guidedCase(device, A.I, 512, 384, A.jobs);
		const mid = await guidedCase(device, B.I, 512, 384, B.jobs);
		const again = await guidedCase(device, A.I, 512, 384, A.jobs, first.out);
		out.guidedTwice = [
			check("guided twice A", first),
			check("guided twice B", mid),
			check("guided twice A vs first A", again),
		];
	}
	out.guided = guided;

	// band stats: photos × sizes × (fg, minRange, NaN) × (tree, subgroups)
	const stats: unknown[] = [];
	const sSizes: [number, number][] = [
		[512, 384],
		[256, 192],
		[1000, 700],
		[61, 97],
		[1536, 1152],
	];
	for (const [w, h] of sSizes)
		for (const [ni, name] of names.entries()) {
			const o = await statsInput(name, names[(ni + 1) % names.length], w, h, {
				fg: ni % 2 === 1,
				minRange: ni === 2 ? 2000 : 0,
				nan: ni === 0,
			});
			for (const s of sg ? [false, true] : [false])
				stats.push(
					check(
						`stats ${name} ${w}x${h}${s ? " sg" : ""}${ni === 0 ? " NaN" : ""}`,
						await statsCase(device, o, s),
					),
				);
		}
	{
		const seq = [];
		const A = await statsInput(names[0], names[1], 512, 384, {});
		const B = await statsInput(names[2], names[3], 512, 384, { fg: true });
		const first = await statsCase(device, A, false);
		seq.push(check("stats twice A", first));
		seq.push(check("stats twice B", await statsCase(device, B, false)));
		seq.push(
			check(
				"stats twice A vs first A",
				await statsCase(device, A, false, first.out),
			),
		);
		out.statsTwice = seq;
	}
	out.stats = stats;

	out.lint = await lintTest(device);
	if (!(out.lint as { ok: boolean }).ok) fail.push("lint");

	// ---------- timings (medians; typical app sizes) ----------
	const timing = async (
		f: () => Promise<unknown>,
	): Promise<{ graphMs: number }> => {
		await f();
		const a: number[] = [];
		for (let i = 0; i < reps; i++) {
			const t = performance.now();
			await f();
			a.push(performance.now() - t);
		}
		return { graphMs: +med(a).toFixed(2) };
	};
	const H = await reliefInput(names[0], 1024, false);
	const gi = await guidedInput(names[0], 512, 384, 2);
	const gi2 = await guidedInput(names[0], 1024, 768, 2);
	const so = await statsInput(names[0], names[1], 512, 384, { fg: true });
	out.timings = {
		relief1024: await timing(() =>
			reliefPassesGpu(device, H, 1024, pxOf(1024), SUNS.xMajorLow),
		),
		guided512x384x2: await timing(() =>
			guidedFiltersGpu(device, gi.I, 512, 384, gi.jobs),
		),
		guided1024x768x2: await timing(() =>
			guidedFiltersGpu(device, gi2.I, 1024, 768, gi2.jobs),
		),
		stats512x384: await timing(() => bandStatsGpu(device, so)),
		...(sg && {
			stats512x384sg: await timing(() =>
				bandStatsGpu(device, so, { subgroups: true }),
			),
		}),
	};

	// ---------- VRAM (after the timing runs: the last graph stats are the timed shapes) ----------
	const guidedV = (() => {
		const n = 1024 * 768;
		const st = lastGuidedGraphRun.stats;
		const imports = [n * 4, 16, n * 4, 16, n * 4];
		const oldScratch = [n * 16, n * 8, n * 8, n * 4, n * 4];
		const cap = (xs: number[]) => xs.reduce((s, b) => s + capacityFor(b), 0);
		return {
			shape: "1024x768, 2 jobs",
			pooledEquivalentBytes: cap([...imports, ...oldScratch]),
			graphImportBytes: cap(imports),
			graphLogicalTransientBytes: st?.logicalTransientBytes,
			graphPhysicalTransientBytes: st?.physicalTransientBytes,
			graphPhysicalBuffers: `${st?.physicalTransientBufferCount}/${st?.logicalTransientBufferCount}`,
			graphTotal: cap(imports) + (st?.physicalTransientBytes ?? 0),
		};
	})();
	const statsV = (() => {
		const n = 512 * 384;
		const st = lastStatsGraphRun.stats;
		const cap = (xs: number[]) => xs.reduce((s, b) => s + capacityFor(b), 0);
		const imports = [20, n * 4, n * 16, n * 4, n * 4, 1024];
		return {
			shape: "512x384 fg",
			pooledEquivalentBytes: cap([...imports, GROUPS * STATS_VALUES * 4]),
			graphTotal: cap(imports) + (st?.physicalTransientBytes ?? 0),
			graphPhysicalTransientBytes: st?.physicalTransientBytes,
		};
	})();
	out.vram = { ...vram(device), guided: guidedV, stats: statsV };
	out.graphStats = {
		relief: lastReliefGraphRun.stats,
		guided: lastGuidedGraphRun.stats,
		stats: lastStatsGraphRun.stats,
	};
	out.cases = {
		relief: relief.length + 3,
		guided: guided.length + 3,
		stats: stats.length + 3,
	};
	out.failures = fail;
	out.ok = fail.length === 0;
	return out;
}
