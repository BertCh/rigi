// W5 parity / speed bench: every GPU look twin against its CPU function on the same inputs
// (captured from a live engine by capture.ts). Run in the page by scripts/gpu/look-bench.mjs.
// Errors: max / p99 / mean absolute difference (bytes for the relief textures and the mask bytes,
// floats otherwise). Times: median of `reps` runs after one warm-up (pipeline compile), GPU times
// include upload, dispatch and readback.
import {
	bandInputs,
	type ColorStats,
	reduceBands,
} from "../../look/color-stats";
import { guidedFilter } from "../../look/guided-filter";
import { fitHaze, type HazeFit } from "../../look/haze-fit";
import { buildReliefField } from "../../look/relief/field";
import { getComputeDevice, hasFeature } from "../device";
import { captureLookInputs, type LookInputs } from "./capture";
import { bandStatsGpu } from "./color-stats";
import { guidedFiltersGpu } from "./guided-filter";
import { fitHazeGpu, hazeGpuTimes } from "./haze";
import { buildReliefFieldGpu } from "./relief";

type Err = { max: number; p99: number; mean: number; n: number; diff?: number };

/** max / p99 / mean |a − b| over `n` values read through `get`. */
function errStats(
	n: number,
	get: (i: number) => [number, number],
	countDiff = false,
): Err {
	const d = new Float32Array(n);
	let sum = 0;
	let diff = 0;
	for (let i = 0; i < n; i++) {
		const [a, b] = get(i);
		const e = Math.abs(a - b);
		d[i] = e;
		sum += e;
		if (e > 0) diff++;
	}
	d.sort();
	const r: Err = {
		max: n ? d[n - 1] : 0,
		p99: n ? d[Math.min(n - 1, Math.floor(0.99 * n))] : 0,
		mean: n ? sum / n : 0,
		n,
	};
	if (countDiff) r.diff = diff;
	return r;
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

async function time<T>(
	reps: number,
	f: () => T | Promise<T>,
): Promise<{ ms: number; out: T }> {
	let out = await f();
	const ts: number[] = [];
	for (let i = 0; i < reps; i++) {
		const t = performance.now();
		out = await f();
		ts.push(performance.now() - t);
	}
	return { ms: +median(ts).toFixed(2), out };
}

function hazeErrors(c: HazeFit, g: HazeFit) {
	const scal = (k: keyof HazeFit) => {
		const a = c[k] as number;
		const b = g[k] as number;
		return {
			cpu: a,
			gpu: b,
			rel: Math.abs(a - b) / Math.max(1e-12, Math.abs(a)),
		};
	};
	const vec = (k: "airlight" | "betaR" | "j0" | "beta") =>
		c[k].map(
			(a, i) =>
				+(Math.abs(a - g[k][i]) / Math.max(1e-12, Math.abs(a))).toExponential(
					2,
				),
		);
	const nS = Math.min(c.samples.length, g.samples.length);
	return {
		samples: [c.samples.length, g.samples.length],
		visibility: scal("visibility"),
		quality: scal("quality"),
		rms: scal("rms"),
		betaM: scal("betaM"),
		hM: [c.hM, g.hM],
		relErr: {
			airlight: vec("airlight"),
			betaR: vec("betaR"),
			j0: vec("j0"),
			beta: vec("beta"),
		},
		sampleLow: errStats(nS * 3, (i) => [
			c.samples[(i / 3) | 0].low[i % 3],
			g.samples[(i / 3) | 0].low[i % 3],
		]),
		sampleRange: errStats(nS, (i) => [c.samples[i].range, g.samples[i].range]),
	};
}

/** Whether two fits are equal number for number (samples included). */
const sameFit = (a: HazeFit, b: HazeFit) =>
	JSON.stringify(a) === JSON.stringify(b);

function statsErrors(c: ColorStats, g: ColorStats) {
	const all = (k: "photoMean" | "photoStd" | "layerMean" | "layerStd") =>
		errStats(c[k].length, (i) => [c[k][i], g[k][i]]);
	return {
		counts: [Array.from(c.count), Array.from(g.count)],
		valid: [c.valid, g.valid],
		photoMean: all("photoMean"),
		photoStd: all("photoStd"),
		layerMean: all("layerMean"),
		layerStd: all("layerStd"),
	};
}

export async function runLookBench(
	engine: unknown,
	opts: { reps?: number; label?: string } = {},
) {
	const reps = opts.reps ?? 5;
	const device = await getComputeDevice();
	if (!device) return { error: "no WebGPU compute device" };
	const inp: LookInputs = captureLookInputs(engine, opts.label);
	const out: Record<string, unknown> = { source: inp.source };

	if (inp.relief) {
		const r = inp.relief;
		const cpu = await time(reps, () =>
			buildReliefField(r.tiles, r.frame, r.sunDir, r.yaw),
		);
		const gpu = await time(reps, () =>
			buildReliefFieldGpu(device, r.tiles, r.frame, r.sunDir, r.yaw),
		);
		const a = cpu.out;
		const b = gpu.out;
		const n = a.res * a.res;
		const ch = (buf: "field" | "gen", c: number) =>
			errStats(n, (i) => [a[buf][i * 4 + c], b[buf][i * 4 + c]], true);
		out.relief = {
			res: a.res,
			tiles: r.tiles.length,
			cpuMs: cpu.ms,
			gpuMs: gpu.ms,
			note: "both include rasterizeHeights on the CPU",
			shadowR: ch("field", 0),
			skyViewG: ch("field", 1),
			curvatureB: ch("field", 2),
			coverageA: ch("field", 3),
			genR: ch("gen", 0),
			genG: ch("gen", 1),
			genA: ch("gen", 3),
		};
	}

	if (inp.haze) {
		const h = inp.haze;
		const cpu = await time(reps, () => fitHaze(h));
		const gpu = await time(reps, () => fitHazeGpu(device, h));
		const gpuSteps = { ...hazeGpuTimes };
		// the full lin + bins readback path (compact: false) must give the very same fit
		const full = await time(reps, () =>
			fitHazeGpu(device, h, { compact: false }),
		);
		out.haze = {
			dims: [h.geoW, h.geoH],
			cpuMs: cpu.ms,
			gpuMs: gpu.ms,
			gpuSteps,
			fullReadback: {
				gpuMs: full.ms,
				gpuSteps: { ...hazeGpuTimes },
				identical: sameFit(gpu.out, full.out),
			},
			...hazeErrors(cpu.out, gpu.out),
		};
	}

	if (inp.masks) {
		const m = inp.masks;
		const jobs = [
			{ p: m.cov, r: Math.max(2, Math.round(m.w * 0.008)), eps: 4e-4 },
			...(m.fg
				? [{ p: m.fg, r: Math.max(3, Math.round(m.w * 0.012)), eps: 1e-3 }]
				: []),
		];
		const cpu = await time(reps, () =>
			jobs.map((j) => guidedFilter(m.I, j.p, m.w, m.h, j.r, j.eps)),
		);
		const gpu = await time(reps, () =>
			guidedFiltersGpu(device, m.I, m.w, m.h, jobs),
		);
		const n = m.w * m.h;
		out.guided = {
			dims: [m.w, m.h],
			masks: jobs.length,
			cpuMs: cpu.ms,
			gpuMs: gpu.ms,
			float: jobs.map((_, k) =>
				errStats(n, (i) => [cpu.out[k][i], gpu.out[k][i]]),
			),
			bytes: jobs.map((_, k) =>
				errStats(
					n,
					(i) => [
						Math.round(cpu.out[k][i] * 255),
						Math.round(gpu.out[k][i] * 255),
					],
					true,
				),
			),
		};
	}

	if (inp.stats) {
		const s = inp.stats;
		let valid = 0;
		for (let i = 0; i < s.w * s.h; i++)
			if (s.layer[i * 4 + 3] > 0.98 && s.range[i] > s.minRange) valid++;
		const cpu = await time(reps, () => {
			const { a, b } = bandInputs(
				s.photo,
				s.layer,
				s.w,
				s.h,
				(x, y) => s.range[y * s.w + x],
				s.fg ? (x, y) => (s.fg as Float32Array)[y * s.w + x] : undefined,
				s.minRange,
			);
			return reduceBands(a, b, s.w * s.h);
		});
		const gpu = await time(reps, () => bandStatsGpu(device, s));
		const subgroups = hasFeature(device, "subgroups");
		// the opt-in subgroup reduction: its reassociation drift vs the default shared-memory tree
		const withSg = subgroups
			? await time(reps, () => bandStatsGpu(device, s, { subgroups: true }))
			: null;
		out.stats = {
			dims: [s.w, s.h],
			coveredTerrainPx: valid,
			cpuMs: cpu.ms,
			gpuMs: gpu.ms,
			subgroups,
			...(withSg && {
				withSubgroups: {
					gpuMs: withSg.ms,
					maxAbsDiff: Math.max(
						...(
							["photoMean", "photoStd", "layerMean", "layerStd"] as const
						).map((k) => statsErrors(gpu.out, withSg.out)[k].max),
					),
					sameCounts: withSg.out.count.join() === gpu.out.count.join(),
					vsCpu: statsErrors(cpu.out, withSg.out),
				},
			}),
			...statsErrors(cpu.out, gpu.out),
		};
	}
	return out;
}

/**
 * runLookBench after warmLook(): the passes then run on the async-compiled pipelines (the app's
 * path), which must give the same numbers (look-bench.mjs --fn runLookBenchWarm).
 */
export async function runLookBenchWarm(
	engine: unknown,
	opts: { reps?: number; label?: string } = {},
) {
	const { warmLook } = await import("./hooks");
	const warmMs = await warmLook();
	return { warmMs, ...(await runLookBench(engine, opts)) };
}
