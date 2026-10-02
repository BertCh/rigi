// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Parity of the TS ALIKED + LightGlue (src/lib/features) against the PyTorch lightglue package the Python
 * services run, on the fixtures written by
 *   tools/matcher/.venv/bin/python scripts/models/aliked-lightglue.py fixtures --layers --max-kp 1024 2048 \
 *     --images public/demo/photos/demo-0{1,2,3}.jpg
 * Per layer (small working size): score map and the four branch maps. End to end: keypoint repeatability,
 * descriptor cosine, LightGlue match agreement on the reference features (isolates the matcher) and
 * on our own features (whole pipeline).
 *
 *   npx tsx src/lib/features/__tests__/parity.check.ts [--quick] [--json out.json]
 * SKIPs (exit 0) when the fixtures or the weights are missing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createNn, setModelFetcher } from "#/lib/nn";
import { entryF32, parseSafetensors } from "#/lib/nn/safetensors";
import { ALIKED_WEIGHTS, type AlikedTrace, runAliked } from "../aliked";
import { compactMatches } from "../index";
import { LIGHTGLUE_WEIGHTS, runLightGlue } from "../lightglue";
import { rgbaToPlanes } from "../preprocess";

const DIR = process.env.FEATURES_PARITY_DIR ?? "out/features-parity";
const MODELS = process.env.RIGI_MODELS_DIR ?? "public/models";
const quick = process.argv.includes("--quick");
const jsonOut = (() => {
	const i = process.argv.indexOf("--json");
	return i > 0 ? process.argv[i + 1] : undefined;
})();

for (const f of [
	join(DIR, "index.json"),
	join(MODELS, ALIKED_WEIGHTS),
	join(MODELS, LIGHTGLUE_WEIGHTS),
])
	if (!existsSync(f)) {
		console.log(`SKIP: missing ${f}`);
		process.exit(0);
	}

type Fx = Map<string, { shape: number[]; data: Float32Array }>;
const load = (tag: string): Fx => {
	const b = readFileSync(join(DIR, `${tag}.safetensors`));
	const st = parseSafetensors(new Uint8Array(b));
	return new Map(
		[...st.entries].map(([k, e]) => [k, { shape: e.shape, data: entryF32(e) }]),
	);
};
const f32 = (fx: Fx, k: string) => {
	const t = fx.get(k);
	if (!t) throw new Error(`fixture tensor ${k} missing`);
	return t.data;
};
if (process.env.RIGI_MODELS_DIR)
	setModelFetcher(async (file) => {
		const b = readFileSync(join(MODELS, file));
		return b.buffer.slice(
			b.byteOffset,
			b.byteOffset + b.byteLength,
		) as ArrayBuffer;
	});

const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as {
	images: {
		tag: string;
		name: string;
		maxKeypoints: number;
		width: number;
		height: number;
		count: number;
		layers: boolean;
		layerSide: number;
	}[];
	pairs: {
		tag: string;
		a: string;
		b: string;
		maxKeypoints: number;
		adaptive: number;
		full: number;
		stop: number;
	}[];
};

function rgbTensorData(fx: Fx): {
	planes: Float32Array;
	width: number;
	height: number;
} {
	const t = fx.get("rgb");
	if (!t) throw new Error("rgb missing");
	const [h, w] = t.shape;
	const rgba = new Uint8Array(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		rgba[4 * i] = t.data[3 * i];
		rgba[4 * i + 1] = t.data[3 * i + 1];
		rgba[4 * i + 2] = t.data[3 * i + 2];
		rgba[4 * i + 3] = 255;
	}
	return {
		planes: rgbaToPlanes({ data: rgba, width: w, height: h }),
		width: w,
		height: h,
	};
}

function diff(a: Float32Array, b: Float32Array) {
	let maxAbs = 0;
	let sq = 0;
	let ref = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.abs(a[i] - b[i]);
		maxAbs = Math.max(maxAbs, d);
		sq += d * d;
		ref += b[i] * b[i];
	}
	return {
		maxAbs: +maxAbs.toPrecision(3),
		relRms: +Math.sqrt(sq / Math.max(ref, 1e-30)).toPrecision(3),
		n: a.length === b.length,
	};
}

/** Nearest-neighbour keypoint agreement + descriptor cosine of the nearest pairs. */
function keypointAgreement(
	ours: { kp: Float32Array; desc: Float32Array; n: number },
	ref: { kp: Float32Array; desc: Float32Array; n: number },
) {
	let within01 = 0;
	let within1 = 0;
	const cos: number[] = [];
	for (let i = 0; i < ref.n; i++) {
		let best = Number.POSITIVE_INFINITY;
		let bj = -1;
		for (let j = 0; j < ours.n; j++) {
			const d = Math.hypot(
				ours.kp[2 * j] - ref.kp[2 * i],
				ours.kp[2 * j + 1] - ref.kp[2 * i + 1],
			);
			if (d < best) {
				best = d;
				bj = j;
			}
		}
		if (best <= 0.1) within01++;
		if (best <= 1) {
			within1++;
			let c = 0;
			for (let k = 0; k < 128; k++)
				c += ours.desc[bj * 128 + k] * ref.desc[i * 128 + k];
			cos.push(c);
		}
	}
	cos.sort((x, y) => x - y);
	const mean = cos.reduce((s, x) => s + x, 0) / Math.max(cos.length, 1);
	return {
		ours: ours.n,
		ref: ref.n,
		repeat01: +(within01 / ref.n).toFixed(4),
		repeat1: +(within1 / ref.n).toFixed(4),
		descCosMean: +mean.toFixed(5),
		descCosP05: +(cos[Math.floor(cos.length * 0.05)] ?? 0).toFixed(5),
	};
}

function pairSet(m: ArrayLike<number>, stride = 2) {
	const s = new Set<string>();
	for (let i = 0; i < m.length; i += stride) s.add(`${m[i]},${m[i + 1]}`);
	return s;
}
const iou = (a: Set<string>, b: Set<string>) => {
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	return +(inter / Math.max(a.size + b.size - inter, 1)).toFixed(4);
};

/** Fraction of `ours` matches with a reference match whose endpoints are both within `tol` px. */
function geometricAgreement(
	ours: {
		k0: Float32Array;
		k1: Float32Array;
		i0: ArrayLike<number>;
		i1: ArrayLike<number>;
	},
	ref: { k0: Float32Array; k1: Float32Array; m: ArrayLike<number> },
	tol = 1.5,
) {
	let hit = 0;
	const n = ours.i0.length;
	for (let t = 0; t < n; t++) {
		const ax = ours.k0[2 * ours.i0[t]];
		const ay = ours.k0[2 * ours.i0[t] + 1];
		const bx = ours.k1[2 * ours.i1[t]];
		const by = ours.k1[2 * ours.i1[t] + 1];
		for (let r = 0; r < ref.m.length; r += 2) {
			const p = ref.m[r];
			const q = ref.m[r + 1];
			if (
				Math.hypot(ref.k0[2 * p] - ax, ref.k0[2 * p + 1] - ay) <= tol &&
				Math.hypot(ref.k1[2 * q] - bx, ref.k1[2 * q + 1] - by) <= tol
			) {
				hit++;
				break;
			}
		}
	}
	return +(hit / Math.max(n, 1)).toFixed(4);
}

const nn = await createNn({
	backend: (process.env.NN_BACKEND as "cpu" | "gpu" | undefined) ?? "auto",
});
const aw = await nn.loadWeights(ALIKED_WEIGHTS);
const lw = await nn.loadWeights(LIGHTGLUE_WEIGHTS);
const report: Record<string, unknown> = { backend: nn.backend.kind };
const failures: string[] = [];
const ours = new Map<
	string,
	{
		kp: Float32Array;
		desc: Float32Array;
		n: number;
		width: number;
		height: number;
	}
>();

const t0 = performance.now();
// ---- ALIKED: per layer (small) + end to end
for (const im of index.images) {
	if (quick && im.maxKeypoints !== index.images[0].maxKeypoints) continue;
	const fx = load(im.tag);
	const { planes, width, height } = rgbTensorData(fx);
	const rgb = nn.fromArray(planes, [1, 3, height, width]);
	if (im.layers) {
		const trace: AlikedTrace = {};
		const r = await runAliked(
			nn,
			aw,
			rgb,
			{ maxKeypoints: im.maxKeypoints, longSide: im.layerSide },
			trace,
		);
		const layers: Record<string, unknown> = {
			score: diff(trace.score ?? new Float32Array(), f32(fx, "layer.score")),
		};
		trace.branches?.forEach((b, i) => {
			layers[`x${i + 1}`] = diff(b, f32(fx, `layer.x${i + 1}`));
		});
		layers.keypoints = keypointAgreement(
			{ kp: r.keypoints, desc: r.descriptors, n: r.count },
			{
				kp: f32(fx, "small.keypoints"),
				desc: f32(fx, "small.descriptors"),
				n: f32(fx, "small.scores").length,
			},
		);
		const ka = layers.keypoints as { repeat1: number; descCosMean: number };
		if (ka.repeat1 < 0.95 || ka.descCosMean < 0.99)
			failures.push(
				`${im.name}@${im.layerSide}: repeatability ${ka.repeat1}, descriptor cosine ${ka.descCosMean}`,
			);
		report[`${im.name}.layers@${im.layerSide}`] = layers;
		console.log(im.name, `layers@${im.layerSide}`, JSON.stringify(layers));
	}
	if (quick) {
		// quick (the CI row): per-layer at the small size only
		nn.dispose(rgb);
		continue;
	}
	const t = performance.now();
	const r = await runAliked(nn, aw, rgb, {
		maxKeypoints: im.maxKeypoints,
		longSide: 1024,
	});
	const ms = Math.round(performance.now() - t);
	ours.set(im.tag, {
		kp: r.keypoints,
		desc: r.descriptors,
		n: r.count,
		width,
		height,
	});
	const agree = keypointAgreement(
		{ kp: r.keypoints, desc: r.descriptors, n: r.count },
		{ kp: f32(fx, "keypoints"), desc: f32(fx, "descriptors"), n: im.count },
	);
	report[im.tag] = { ...agree, ms };
	console.log(im.tag, JSON.stringify({ ...agree, ms }));
	if (agree.repeat1 < 0.9)
		failures.push(`${im.tag}: repeatability@1px ${agree.repeat1} < 0.9`);
	if (agree.descCosMean < 0.99)
		failures.push(`${im.tag}: descriptor cosine ${agree.descCosMean} < 0.99`);
	nn.dispose(rgb);
}

// ---- LightGlue
for (const p of index.pairs) {
	if (quick && p !== index.pairs[0]) continue;
	const fa = load(p.a);
	const fb = load(p.b);
	const fp = load(p.tag);
	const ia = index.images.find((x) => x.tag === p.a);
	const ib = index.images.find((x) => x.tag === p.b);
	if (!ia || !ib) continue;
	const refA = {
		keypoints: f32(fa, "keypoints"),
		descriptors: f32(fa, "descriptors"),
		count: ia.count,
		width: ia.width,
		height: ia.height,
	};
	const refB = {
		keypoints: f32(fb, "keypoints"),
		descriptors: f32(fb, "descriptors"),
		count: ib.count,
		width: ib.width,
		height: ib.height,
	};
	const row: Record<string, unknown> = {
		refAdaptive: p.adaptive,
		refFull: p.full,
		refStop: p.stop,
	};
	for (const adaptive of quick ? [true] : [true, false]) {
		const t = performance.now();
		const r = await runLightGlue(nn, lw, refA, refB, { adaptive });
		const m = compactMatches(r.matches0, r.scores0);
		const pairs: number[] = [];
		for (let i = 0; i < m.count; i++) pairs.push(m.indices0[i], m.indices1[i]);
		const ref = fp.get(`${adaptive ? "adaptive" : "full"}.matches`)?.data ?? [];
		const key = adaptive ? "adaptive" : "full";
		row[key] = {
			count: m.count,
			stop: r.stop,
			iou: iou(pairSet(pairs), pairSet(ref)),
			ms: Math.round(performance.now() - t),
		};
	}
	const oa = ours.get(p.a);
	const ob = ours.get(p.b);
	if (oa && ob) {
		const t = performance.now();
		const r = await runLightGlue(
			nn,
			lw,
			{
				keypoints: oa.kp,
				descriptors: oa.desc,
				count: oa.n,
				width: oa.width,
				height: oa.height,
			},
			{
				keypoints: ob.kp,
				descriptors: ob.desc,
				count: ob.n,
				width: ob.width,
				height: ob.height,
			},
		);
		const m = compactMatches(r.matches0, r.scores0);
		row.endToEnd = {
			count: m.count,
			stop: r.stop,
			geomAgree: geometricAgreement(
				{ k0: oa.kp, k1: ob.kp, i0: m.indices0, i1: m.indices1 },
				{
					k0: refA.keypoints,
					k1: refB.keypoints,
					m: fp.get("adaptive.matches")?.data ?? [],
				},
			),
			ms: Math.round(performance.now() - t),
		};
	}
	report[p.tag] = row;
	console.log(p.tag, JSON.stringify(row));
	const ad = row.adaptive as { iou: number } | undefined;
	if (ad && p.adaptive >= 50 && ad.iou < 0.8)
		failures.push(`${p.tag}: LightGlue IoU ${ad.iou} < 0.8`);
}
report.seconds = Math.round((performance.now() - t0) / 1000);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
if (failures.length) {
	console.log(`FAIL: ${failures.join("; ")}`);
	process.exit(1);
}
console.log(`PASS: features parity (${nn.backend.kind}, ${report.seconds}s)`);
