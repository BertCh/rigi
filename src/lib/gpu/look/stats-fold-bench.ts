// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Quality / speed bench of the band-stats fold on the GPU (color-stats-fold.ts) against the float64
// CPU fold, on a live /photo page (scripts/gpu/stats-fold-bench.mjs drives it; dev only, it pokes
// engine internals):
// - WebGL deck engine (renderer=deck): the ARRAY path. The engine's own setStats input is captured
//   (CompositeLook.setStats), turned into BandStatsInput as composite.ts does, and run through the CPU
//   reference (reduceBands(bandInputs), f64), bandStatsGpu f64 fold and GPU fold, plain and subgroups.
// - WebGPU deck engine (renderer=webgpu): the TEXTURE path. The engine's stats layer is rendered and
//   bandStatsTex runs on it with the f64 fold and the GPU fold, plain and subgroups.
// Per variant: every ColorStats field's max |Δ| against the reference (f64 fold, plain), and the
// composite: the photo view rendered with each variant's stats injected, max / mean |Δ| per channel
// byte and the count of differing bytes against the reference render. Plus ms per call.
import type { Device } from "@luma.gl/core";
import {
	bandInputs,
	type ColorStats,
	reduceBands,
} from "../../look/color-stats";
import {
	gridSize,
	photoPixels,
	STATS_LONG_SIDE,
	trustedRange,
} from "../../look/composite";
import { getComputeDevice, hasFeature } from "../device";
import { type BandStatsInput, bandStatsGpu } from "./color-stats";
import { lastStatsGraphRun } from "./color-stats-graph";
import { lookIdle } from "./opt-in";
import { bandStatsTex, type StatsTexInput } from "./textures";

type Mask8 = { data: Uint8Array; width: number; height: number };
type RangeGrid = { w: number; h: number; at: (x: number, y: number) => number };
type SetStatsArg = {
	key: string;
	img: HTMLImageElement;
	layer: Float32Array;
	w: number;
	h: number;
	geo: RangeGrid;
	fg: Mask8 | null;
	minRange: number;
};

// biome-ignore lint/suspicious/noExplicitAny: dev bench over private engine internals
type AnyEngine = any;

const KEYS = ["photoMean", "photoStd", "layerMean", "layerStd"] as const;

function statsDelta(a: ColorStats, b: ColorStats) {
	const out: Record<string, number | boolean> = {
		valid: a.valid === b.valid,
		count: Array.from(a.count).every((c, i) => c === b.count[i]),
	};
	let max = 0;
	let rel = 0;
	for (const k of KEYS) {
		let m = 0;
		for (let i = 0; i < a[k].length; i++) {
			const d = Math.abs(a[k][i] - b[k][i]);
			m = Math.max(m, d);
			rel = Math.max(rel, d / Math.max(1e-6, Math.abs(a[k][i])));
		}
		out[k] = m;
		max = Math.max(max, m);
	}
	out.max = max;
	out.maxRel = rel;
	out.exact = max === 0 && out.valid === true && out.count === true;
	return out;
}

function pixelDelta(a: Uint8Array, b: Uint8Array) {
	let max = 0;
	let sum = 0;
	let differ = 0;
	for (let i = 0; i < a.length; i++) {
		if ((i & 3) === 3) continue;
		const d = Math.abs(a[i] - b[i]);
		if (d) differ++;
		sum += d;
		if (d > max) max = d;
	}
	return {
		max,
		mean: sum / ((a.length / 4) * 3),
		differ,
		bytes: (a.length / 4) * 3,
	};
}

async function time<T>(reps: number, f: () => Promise<T>) {
	await f();
	const t0 = performance.now();
	for (let i = 0; i < reps; i++) await f();
	return (performance.now() - t0) / reps;
}

const maskAt = (m: Mask8, u: number, v: number) =>
	m.data[
		Math.min(m.height - 1, Math.floor(v * m.height)) * m.width +
			Math.min(m.width - 1, Math.floor(u * m.width))
	] / 255;

/** composite.ts setStats' GPU input from its arguments (keep in sync). */
function arrayInput(o: SetStatsArg): BandStatsInput {
	const { w, h, geo, fg } = o;
	const layer = new Float32Array(o.layer.length);
	for (let y = 0; y < h; y++)
		layer.set(
			o.layer.subarray((h - 1 - y) * w * 4, (h - y) * w * 4),
			y * w * 4,
		);
	const range = new Float32Array(w * h);
	const fa = fg ? new Float32Array(w * h) : null;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			range[y * w + x] = geo.at(
				Math.floor(((x + 0.5) * geo.w) / w),
				Math.floor(((y + 0.5) * geo.h) / h),
			);
			if (fa && fg) fa[y * w + x] = maskAt(fg, (x + 0.5) / w, (y + 0.5) / h);
		}
	return {
		photo: photoPixels(o.img, w, h).data,
		layer,
		w,
		h,
		range,
		fg: fa,
		minRange: o.minRange,
	};
}

/** The photo view's pixels at `long` px on the long side, with `stats` injected (null = the engine's own). */
async function renderWith(
	e: AnyEngine,
	stats: ColorStats | null,
	long: number,
): Promise<Uint8Array> {
	const aspect = e.photo.width / e.photo.height;
	const [rw, rh] = gridSize(aspect, long);
	if (e.gpu?.bridge) {
		const bridge = e.gpu.bridge;
		if (stats) {
			bridge.stats = stats;
			bridge.version++;
		}
		e.updateLook();
		e.sync();
		return (await e.renderOffscreen({
			width: rw,
			height: rh,
			view: "photo",
			screen: true,
		})) as Uint8Array;
	}
	if (stats) {
		e.compLook.stats = stats;
		e.compLook.version++;
	}
	e.updateLayers();
	e.flushLayers();
	return (await e.compositor.renderImage(
		e.liveLayers(),
		e.pose,
		e.eyeArr,
		rw,
		rh,
	)) as Uint8Array;
}

/**
 * Composite deltas of each variant's stats against the reference's: ref, variant, ref again, so a
 * scene that changes between renders (drift: ref vs ref again) is told apart from the variant's effect.
 */
async function composites(
	e: AnyEngine,
	variants: Record<string, ColorStats>,
	ref: string,
	long: number,
) {
	const out: Record<string, unknown> = {};
	const one = async (s: ColorStats) => {
		const before = await renderWith(e, variants[ref], long);
		const v = await renderWith(e, s, long);
		const after = await renderWith(e, variants[ref], long);
		const a = pixelDelta(before, v);
		const b = pixelDelta(after, v);
		return {
			...(a.differ <= b.differ ? a : b),
			drift: pixelDelta(before, after),
		};
	};
	for (const [name, s] of Object.entries(variants))
		if (name !== ref) out[name] = await one(s);
	// sanity: identity stats (harmonize off) must change the render, or the injection did nothing
	out.identitySanity = await one({ ...variants[ref], valid: false });
	return out;
}

/** WebGL deck engine: capture the next setStats input (forces a stats pass). */
function captureSetStats(e: AnyEngine): Promise<SetStatsArg> {
	return new Promise((resolve, reject) => {
		const L = e.compLook;
		const orig = L.setStats.bind(L);
		const timer = setTimeout(
			() => reject(new Error("no setStats call in 30 s")),
			30_000,
		);
		L.setStats = (o: SetStatsArg) => {
			L.setStats = orig;
			clearTimeout(timer);
			resolve(o);
			return orig(o);
		};
		L.statsKey = null;
		e.updateLayers();
	});
}

export type StatsFoldBenchOptions = { reps?: number; long?: number };

/** Run on the page's window.__engine (renderer=deck: array path; renderer=webgpu: texture path). */
export async function runStatsFoldBench(
	engine: unknown,
	opts: StatsFoldBenchOptions = {},
) {
	const e = engine as AnyEngine;
	const reps = opts.reps ?? 10;
	const long = opts.long ?? 1024;
	const device = (await getComputeDevice()) as Device | null;
	if (!device) throw new Error("no compute device");
	const sgAvail = hasFeature(device, "subgroups");
	const out: Record<string, unknown> = {
		engine: e.gpu?.bridge ? "webgpu" : "deck",
		subgroups: sgAvail,
	};
	const variants: Record<string, ColorStats> = {};
	const ms: Record<string, number> = {};
	if (e.gpu?.bridge) {
		// ── texture path
		const bridge = e.gpu.bridge;
		const img = e.photoImg as HTMLImageElement;
		const [w, h] = gridSize(e.aspect, STATS_LONG_SIDE);
		const geometry = e.geometryTexture();
		if (!geometry) throw new Error("no geometry texture");
		const minRange = trustedRange(e.photo.hAccuracy);
		await e.renderLayer(w, h, async (layer: unknown) => {
			const input = {
				geometry,
				layer,
				photo: bridge.photoTexture(img, w, h),
				fg: e.fgMask ? bridge.byteMask("fg", e.fgMask) : null,
				minRange,
			} as StatsTexInput;
			const run = (fold: "gpu" | "f64", subgroups: boolean) => async () =>
				(await bandStatsTex(device, input, { fold, subgroups }))
					.stats as ColorStats;
			for (const fold of ["f64", "gpu"] as const)
				for (const sg of sgAvail ? [false, true] : [false]) {
					const name = `${fold}${sg ? "-sg" : ""}`;
					variants[name] = await run(fold, sg)();
					ms[name] = await time(reps, run(fold, sg));
					ms[`${name}-noread`] = await time(reps, async () => {
						await bandStatsTex(device, input, {
							fold,
							subgroups: sg,
							read: false,
						});
						await (
							device as unknown as { handle: GPUDevice }
						).handle.queue.onSubmittedWorkDone();
					});
				}
		});
		out.grid = [w, h];
	} else {
		// ── array path
		const arg = await captureSetStats(e);
		// the engine's own stats pass lands before anything is injected
		await lookIdle();
		const input = arrayInput(arg);
		const { a, b } = bandInputs(
			input.photo as Uint8ClampedArray,
			input.layer,
			input.w,
			input.h,
			(x, y) => input.range[y * input.w + x],
			input.fg
				? (x, y) => (input.fg as Float32Array)[y * input.w + x]
				: undefined,
			input.minRange ?? 0,
		);
		const cpu = () => reduceBands(a, b, input.w * input.h);
		variants.cpu = cpu();
		ms.cpu = await time(reps, async () => cpu());
		for (const fold of ["f64", "gpu"] as const)
			for (const sg of sgAvail ? [false, true] : [false]) {
				const name = `${fold}${sg ? "-sg" : ""}`;
				const f = () => bandStatsGpu(device, input, { fold, subgroups: sg });
				variants[name] = await f();
				if (fold === "gpu" && !sg) out.lowering = lastStatsGraphRun.lowering;
				ms[name] = await time(reps, f);
			}
		out.grid = [input.w, input.h];
		out.counts = Array.from(variants.f64.count);
	}
	const ref = "f64";
	const deltas: Record<string, unknown> = {};
	for (const [name, s] of Object.entries(variants))
		if (name !== ref) deltas[name] = statsDelta(variants[ref], s);
	out.valid = variants[ref].valid;
	out.stats = deltas;
	out.ms = ms;
	out.composite = await composites(e, variants, ref, long);
	return out;
}
