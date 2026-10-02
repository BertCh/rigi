// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Live-tier MoGe-2 depth: forward time per (weights, tokens, headStopLevel, heads) over Dawn in node, a
// batched-vs-separate parity check, and quality against the full model (1200 tokens, separate heads,
// the reference weights) on a photo set: depth error after median-scale alignment (the DEM anchor fits
// the scale), mask IoU, focal. Photos are pre-decoded like depth-weights-eval.ts: `--dir` holds
// index.json ([{ name, W, H }]) and <name>.rgb (RGB8 at W × H); each tier resizes (bilinear) on the CPU.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nearfield/depth-live.bench.ts --dir <dir> [--runs 7] [--ref fp16|q8]
//     [--quality-photos 24] [--only parity|time|quality|focal] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { composeDepth } from "../../src/lib/nearfield/local/compose";
import {
	DEPTH_LIVE_PRESETS,
	type DepthNetOutput,
	type DepthRunOptions,
	FOCAL_GRID,
	MOGE2_WEIGHTS,
	MogeDepthNet,
	type MogeWeights,
	tokenGrid,
} from "../../src/lib/nearfield/local/depth-net";
import { focalFromVfov } from "../../src/lib/nearfield/local/focal-shift";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { dawnDevice } from "../nn/dawn";

const argv = process.argv.slice(2);
const arg = (k: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined;
const dir = arg("--dir");
if (!dir) {
	console.error("usage: depth-live.bench.ts --dir <dir> [--runs 7] [--ref q8]");
	process.exit(2);
}
const runs = Number(arg("--runs") ?? 7);
const refWeights = (arg("--ref") ?? "q8") as MogeWeights;
const only = arg("--only");
const device = await dawnDevice("depth-live-bench");
if (!device) {
	console.log("SKIP depth-live.bench: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const nn = new GpuNn(device);
const MODELS = path.resolve(import.meta.dirname, "../../public/models");
type Photo = { name: string; W: number; H: number; vfov?: number };
const photos = (
	JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")) as Photo[]
).slice(0, Number(arg("--quality-photos") ?? 24));

const loadNet = async (w: MogeWeights) => {
	const net = new MogeDepthNet(
		nn,
		nn.weightsFromBytes(
			new Uint8Array(readFileSync(path.join(MODELS, MOGE2_WEIGHTS[w]))),
		),
	);
	await nn.sync();
	return net;
};

const rgbCache = new Map<string, Uint8Array>();
const rgb = (p: Photo) => {
	let b = rgbCache.get(p.name);
	if (!b) {
		b = new Uint8Array(readFileSync(path.join(dir, `${p.name}.rgb`)));
		rgbCache.set(p.name, b);
	}
	return b;
};

/** Bilinear (align_corners false, area-ish for downscale via 2×2 taps) resize into a [1, 3, h, w] tensor. */
function inputTensor(p: Photo, tokens: number) {
	const [bh, bw] = tokenGrid(tokens, p.W / p.H);
	const w = bw * 14;
	const h = bh * 14;
	const px = rgb(p);
	const out = new Float32Array(3 * w * h);
	const sx = p.W / w;
	const sy = p.H / h;
	for (let y = 0; y < h; y++) {
		const fy = Math.max(0, (y + 0.5) * sy - 0.5);
		const y0 = Math.min(p.H - 1, Math.floor(fy));
		const y1 = Math.min(p.H - 1, y0 + 1);
		const ty = fy - y0;
		for (let x = 0; x < w; x++) {
			const fx = Math.max(0, (x + 0.5) * sx - 0.5);
			const x0 = Math.min(p.W - 1, Math.floor(fx));
			const x1 = Math.min(p.W - 1, x0 + 1);
			const tx = fx - x0;
			for (let c = 0; c < 3; c++) {
				const a =
					px[3 * (y0 * p.W + x0) + c] * (1 - tx) +
					px[3 * (y0 * p.W + x1) + c] * tx;
				const b =
					px[3 * (y1 * p.W + x0) + c] * (1 - tx) +
					px[3 * (y1 * p.W + x1) + c] * tx;
				out[c * w * h + y * w + x] = (a * (1 - ty) + b * ty) / 255;
			}
		}
	}
	return nn.fromArray(out, [1, 3, h, w]);
}

type Config = {
	label: string;
	weights: MogeWeights;
	tokens: number;
	opts: DepthRunOptions;
};
const cfg = (
	weights: MogeWeights,
	tokens: number,
	headStop: 3 | 4,
	batched: boolean,
	normals: boolean,
): Config => ({
	label: `${weights} t${tokens} h${headStop === 4 ? 16 : 8}x ${batched ? "batched" : "separate"} ${normals ? "+n" : "pm"}`,
	weights,
	tokens,
	opts: { batchedHeads: batched, headStopLevel: headStop, normals },
});

const filter = arg("--filter");
const allConfigs: Config[] = [
	cfg("q8", 1200, 4, false, true),
	cfg("q8", 1200, 4, true, true),
	cfg("q8", 1200, 4, false, false),
	cfg("q8", 1200, 4, true, false),
	cfg("q8", 1200, 3, true, false),
	...[256, 384, 512].flatMap((t) => [
		cfg("q8", t, 4, false, false),
		cfg("q8", t, 4, true, false),
		cfg("q8", t, 3, true, false),
	]),
	cfg("q8lite", 1200, 4, true, false),
	...[256, 384, 512].flatMap((t) => [
		cfg("q8lite", t, 4, true, false),
		cfg("q8lite", t, 3, true, false),
	]),
	cfg("q8lite", 128, 3, true, false),
	cfg("q8lite", 32, 3, true, false),
	...Object.entries(DEPTH_LIVE_PRESETS).map(([name, preset]) => ({
		...cfg(
			preset.weights,
			preset.tokens,
			preset.headStopLevel,
			preset.batchedHeads,
			preset.normals,
		),
		label: `preset ${name}`,
	})),
];

const configs = filter
	? allConfigs.filter((c) => c.label.includes(filter))
	: allConfigs;
/** timing output grid: the photo's (default) or `--out <long side>` (live consumers need far less) */
const outLong = arg("--out") ? Number(arg("--out")) : 0;
const timeOut = (p: Photo): [number, number] => {
	if (!outLong) return [p.H, p.W];
	const s = outLong / Math.max(p.W, p.H);
	return [Math.round(p.H * s), Math.round(p.W * s)];
};
const median = (xs: number[]) =>
	[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const quantile = (xs: number[], q: number) => {
	if (!xs.length) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function forward(net: MogeDepthNet, p: Photo, c: Config) {
	const image = inputTensor(p, c.tokens);
	const o = await net.run(image, p.W / p.H, [p.H, p.W], c.opts);
	return { image, o };
}
const release = (image: ReturnType<typeof inputTensor>, o: DepthNetOutput) =>
	nn.dispose([image, ...Object.values(o).filter((x) => x !== null)]);

const nets = new Map<MogeWeights, MogeDepthNet>();
const netFor = async (w: MogeWeights) => {
	const hit = nets.get(w);
	if (hit) return hit;
	const n = await loadNet(w);
	nets.set(w, n);
	return n;
};

const result: Record<string, unknown> = { runs, ref: refWeights };

if (!only || only === "parity") {
	// batched vs separate heads, same weights and input: max |Δ| / max|ref| per output
	const net = await netFor("q8");
	const p = photos[0];
	const rows: Record<string, number>[] = [];
	for (const [tokens, headStop] of [
		[256, 4],
		[1200, 4],
		[256, 3],
	] as const) {
		const base = cfg("q8", tokens, headStop, false, true);
		const a = await forward(net, p, base);
		const b = await forward(net, p, {
			...base,
			opts: { ...base.opts, batchedHeads: true },
		});
		const row: Record<string, number> = { tokens, headStop };
		for (const k of ["z", "mask", "normal", "points64"] as const) {
			const ta = a.o[k];
			const tb = b.o[k];
			if (!ta || !tb) continue;
			const [x, y] = await Promise.all([nn.read(ta), nn.read(tb)]);
			let d = 0;
			let m = 0;
			for (let i = 0; i < x.length; i++) {
				d = Math.max(d, Math.abs(x[i] - y[i]));
				m = Math.max(m, Math.abs(x[i]));
			}
			row[`${k}MaxRel`] = d / m;
		}
		rows.push(row);
		release(a.image, a.o);
		release(b.image, b.o);
	}
	console.log("parity batched vs separate (q8, photo 0)");
	console.table(rows);
	result.parity = rows;
}

if (!only || only === "time") {
	const p = photos[0];
	const rows: Record<string, unknown>[] = [];
	for (const c of configs) {
		const net = await netFor(c.weights);
		const ms: number[] = [];
		const stats = (nn as unknown as { runtime: { stats: { nodes: number } } })
			.runtime.stats;
		let nodes = 0;
		for (let i = 0; i < runs + 2; i++) {
			const before = stats.nodes;
			const image = inputTensor(p, c.tokens);
			const t = performance.now();
			const o = await net.run(image, p.W / p.H, timeOut(p), c.opts);
			await nn.read(o.mask64);
			if (i >= 2) ms.push(performance.now() - t);
			nodes = stats.nodes - before;
			release(image, o);
		}
		rows.push({
			config: c.label,
			nodes,
			medianMs: Math.round(median(ms)),
			minMs: Math.round(Math.min(...ms)),
			maxMs: Math.round(Math.max(...ms)),
		});
		console.log(rows[rows.length - 1]);
	}
	result.time = rows;
}

if (!only || only === "quality") {
	// reference: the full model at 1200 tokens, separate heads, normals off (compose derives normals anyway)
	const refNet = await netFor(refWeights);
	const refCfg = cfg(refWeights, 1200, 4, false, false);
	type Composed = ReturnType<typeof composeDepth>;
	const compose = async (
		net: MogeDepthNet,
		p: Photo,
		c: Config,
	): Promise<Composed> => {
		const { image, o } = await forward(net, p, c);
		const [z, mask, points64, mask64, scale] = await Promise.all([
			nn.read(o.z),
			nn.read(o.mask),
			nn.read(o.points64),
			nn.read(o.mask64),
			nn.read(o.metricScale),
		]);
		release(image, o);
		return composeDepth(
			{
				width: p.W,
				height: p.H,
				z,
				mask,
				normal: null,
				points64,
				mask64,
				focalGrid: FOCAL_GRID,
				metricScale: scale[0],
			},
			c.weights,
		);
	};
	const refs = new Map<string, Composed>();
	for (const p of photos) refs.set(p.name, await compose(refNet, p, refCfg));
	const rows: Record<string, unknown>[] = [];
	for (const c of configs) {
		if (c.opts.normals) continue;
		const net = await netFor(c.weights);
		const per: Record<string, number[]> = {
			med: [],
			p90: [],
			iou: [],
			focal: [],
		};
		for (const p of photos) {
			const a = refs.get(p.name) as Composed;
			const b = await compose(net, p, c);
			const ratio: number[] = [];
			let inter = 0;
			let union = 0;
			for (let k = 0; k < a.depth.length; k++) {
				const va = a.valid[k];
				const vb = b.valid[k];
				if (va || vb) union++;
				if (va && vb) {
					inter++;
					if (k % 3 === 0) ratio.push(b.depth[k] / a.depth[k]);
				}
			}
			const r0 = quantile(ratio, 0.5);
			const aligned = ratio.map((r) => Math.abs(r / r0 - 1));
			per.med.push(quantile(aligned, 0.5));
			per.p90.push(quantile(aligned, 0.9));
			per.iou.push(union ? inter / union : 1);
			per.focal.push(Math.abs(b.focal / a.focal - 1));
		}
		rows.push({
			config: c.label,
			alignedMedRel: +median(per.med).toFixed(4),
			alignedP90Rel: +median(per.p90).toFixed(4),
			worstP90: +Math.max(...per.p90).toFixed(4),
			maskIoUMedian: +median(per.iou).toFixed(4),
			maskIoUMin: +Math.min(...per.iou).toFixed(4),
			focalRelMedian: +median(per.focal).toFixed(4),
			focalRelWorst: +Math.max(...per.focal).toFixed(4),
		});
		console.log(rows[rows.length - 1]);
	}
	result.quality = rows;
}

if (only === "focal") {
	// liveFast with the net's own focal vs the camera's known focal (EXIF vfov), against the 1200-token q8
	// model. Errors are the depth ratio to the reference over valid pixels in both: raw (what the splats
	// see, the DEM anchor then fits scale / shift on top) and after median-scale alignment.
	const refNet = await netFor(refWeights);
	const refCfg = cfg(refWeights, 1200, 4, false, false);
	const preset = DEPTH_LIVE_PRESETS.liveFast;
	const liveCfg = {
		...cfg(
			preset.weights,
			preset.tokens,
			preset.headStopLevel,
			preset.batchedHeads,
			preset.normals,
		),
	};
	const liveNet = await netFor(liveCfg.weights);
	type Composed = ReturnType<typeof composeDepth>;
	const arrays = async (net: MogeDepthNet, p: Photo, c: Config) => {
		const { image, o } = await forward(net, p, c);
		const [z, mask, points64, mask64, scale] = await Promise.all([
			nn.read(o.z),
			nn.read(o.mask),
			nn.read(o.points64),
			nn.read(o.mask64),
			nn.read(o.metricScale),
		]);
		release(image, o);
		return {
			width: p.W,
			height: p.H,
			z,
			mask,
			normal: null,
			points64,
			mask64,
			focalGrid: FOCAL_GRID,
			metricScale: scale[0],
		};
	};
	const variants: [
		string,
		(exif: number, ref: number) => number | undefined,
	][] = [
		["net focal", () => undefined],
		["EXIF focal", (exif) => exif],
		["EXIF focal +5%", (exif) => exif * 1.05],
		["EXIF focal -5%", (exif) => exif / 1.05],
		["EXIF focal +10%", (exif) => exif * 1.1],
		["reference focal", (_e, ref) => ref],
	];
	const per = new Map<string, Record<string, number[]>>();
	const refFocalVsExif: number[] = [];
	for (const p of photos) {
		if (!p.vfov) continue;
		const ref = composeDepth(await arrays(refNet, p, refCfg), "ref");
		const exif = focalFromVfov(p.vfov, p.W, p.H);
		refFocalVsExif.push(Math.abs(ref.focal / exif - 1));
		const live = await arrays(liveNet, p, liveCfg);
		for (const [label, pick] of variants) {
			const known = pick(exif, ref.focal);
			const b: Composed = composeDepth(
				{ ...live, ...(known ? { knownFocal: known } : {}) },
				"live",
			);
			const raw: number[] = [];
			const idx: number[] = [];
			for (let k = 0; k < ref.depth.length; k += 3)
				if (ref.valid[k] && b.valid[k]) {
					raw.push(b.depth[k] / ref.depth[k]);
					idx.push(k);
				}
			const r0 = quantile(raw, 0.5);
			// 3D position error: both clouds back-projected with their own intrinsics, the live one scaled by
			// the median depth ratio, distance relative to the reference range (lateral error shows here)
			const Ka = ref.intrinsicsNorm as {
				fx: number;
				fy: number;
				cx: number;
				cy: number;
			};
			const Kb = b.intrinsicsNorm as typeof Ka;
			const pos = idx.map((k) => {
				const u = ((k % p.W) + 0.5) / p.W;
				const v = (Math.floor(k / p.W) + 0.5) / p.H;
				const za = ref.depth[k];
				const zb = b.depth[k] / r0;
				const ax = ((u - Ka.cx) / Ka.fx) * za;
				const ay = ((v - Ka.cy) / Ka.fy) * za;
				const bx = ((u - Kb.cx) / Kb.fx) * zb;
				const by = ((v - Kb.cy) / Kb.fy) * zb;
				return Math.hypot(ax - bx, ay - by, za - zb) / Math.hypot(ax, ay, za);
			});
			const row = per.get(label) ?? {
				raw: [],
				rawP90: [],
				med: [],
				p90: [],
				focal: [],
				pos: [],
			};
			const rawErr = raw.map((r) => Math.abs(r - 1));
			const aligned = raw.map((r) => Math.abs(r / r0 - 1));
			row.raw.push(quantile(rawErr, 0.5));
			row.rawP90.push(quantile(rawErr, 0.9));
			row.med.push(quantile(aligned, 0.5));
			row.p90.push(quantile(aligned, 0.9));
			row.focal.push(Math.abs(b.focal / exif - 1));
			row.pos.push(quantile(pos, 0.5));
			per.set(label, row);
		}
	}
	console.log(
		`1200-token reference focal vs EXIF: median ${(median(refFocalVsExif) * 100).toFixed(1)}%, worst ${(Math.max(...refFocalVsExif) * 100).toFixed(1)}%`,
	);
	const rows = [...per.entries()].map(([label, r]) => ({
		focal: label,
		rawMedRel: +median(r.raw).toFixed(4),
		rawP90Rel: +median(r.rawP90).toFixed(4),
		alignedMedRel: +median(r.med).toFixed(4),
		alignedP90Rel: +median(r.p90).toFixed(4),
		worstAlignedP90: +Math.max(...r.p90).toFixed(4),
		pos3dMedRel: +median(r.pos).toFixed(4),
		focalVsExifMedian: +median(r.focal).toFixed(4),
	}));
	console.log(`liveFast, ${per.get("net focal")?.med.length} photos`);
	console.table(rows);
	result.focal = { refFocalVsExif: median(refFocalVsExif), rows };
}

const json = arg("--json");
if (json) writeFileSync(json, JSON.stringify(result, null, "\t"));
process.exit(0);
