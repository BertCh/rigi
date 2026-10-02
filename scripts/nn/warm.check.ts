// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn.warm on Dawn: the graph a warm-up builds is the one the real forward then finds (graphHits + 1,
// no new graph), warm allocates no output buffers and leaves the runtime's buffer accounting unchanged,
// and results are unaffected. Checked on a small network and, when the weights are in public/models, on
// the real sky (U²-Net 512×384), people-mask (512×384) and ALIKED dense (1024×768) first forwards.
// With `--bench <sky|people|aliked> <cold|warm>` it prints one JSON line: the first-forward latency of
// that model in this fresh process (run it several times; see the nn README). SKIP (exit 0) without
// DAWN_DIR or an adapter.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/warm.check.ts

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Device, Texture } from "@luma.gl/core";
import { ALIKED_WEIGHTS, runAliked } from "../../src/lib/features/aliked";
import { warmAliked } from "../../src/lib/features/warm";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import type { Nn } from "../../src/lib/nn/types";
import { loadPeopleNet, PEOPLE_WEIGHTS } from "../../src/lib/segment/people";
import {
	MASK_LONG_SIDE,
	segmentTextureGpu,
	warmPeopleMask,
} from "../../src/lib/segment/people-gpu";
import {
	bindU2netp,
	runU2netp,
	U2NETP_WEIGHTS,
} from "../../src/lib/sky/u2netp";
import { dawnDevice } from "./dawn";

const MODELS = process.env.RIGI_MODELS_DIR ?? "public/models";
const benchAt = process.argv.indexOf("--bench");
const bench =
	benchAt > 0
		? {
				model: process.argv[benchAt + 1],
				warm: process.argv[benchAt + 2] === "warm",
			}
		: null;

const device = await dawnDevice("nn-warm");
if (!device) {
	console.log("SKIP nn-warm: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const dev: Device = device;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
};
const has = (f: string) => existsSync(join(MODELS, f));
const rand = (n: number, seed = 7) => {
	let s = seed;
	return Float32Array.from({ length: n }, () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	});
};
const now = () => performance.now();

/** warm(fn) then the real forward: the forward must be a graph hit with nothing new built. */
async function hitAfterWarm(
	label: string,
	nn: GpuNn,
	warm: () => Promise<void>,
	real: () => Promise<void>,
	/** bytes of cached constants the warm-up legitimately uploads (ALIKED's border mask), not outputs */
	constantBytes = 0,
) {
	const s = nn.runtime.stats;
	const before = { graphs: s.graphs, hits: s.graphHits, live: s.liveBytes };
	await warm();
	const afterWarm = { graphs: s.graphs, live: s.liveBytes };
	await real();
	const built = s.graphs - afterWarm.graphs;
	check(
		`${label}: warm builds the graph, the real forward is a hit`,
		afterWarm.graphs - before.graphs === 1 &&
			built === 0 &&
			s.graphHits - before.hits === 1,
		`graphs +${afterWarm.graphs - before.graphs} then +${built}, hits +${s.graphHits - before.hits}`,
	);
	check(
		`${label}: warm allocated no pooled buffers`,
		afterWarm.live - before.live <= constantBytes,
		`liveBytes ${before.live} → ${afterWarm.live}`,
	);
}

async function smallNet() {
	const nn = new GpuNn(dev, { graphGroup: "nn/warm-small" });
	const w = nn.fromArray(rand(64 * 64), [64, 64]);
	const net = (x: ReturnType<Nn["fromArray"]>) =>
		nn.scope("blk", () => ({ y: nn.gelu(nn.matmul(x, w)), m: nn.mean(x, 0) }));
	const input = rand(10 * 64, 3);
	let first: Float32Array | undefined;
	await hitAfterWarm(
		"small net",
		nn,
		() => nn.warm((scratch) => net(scratch([10, 64]))),
		async () => {
			const x = nn.fromArray(input, [10, 64]);
			const { y } = await nn.forward(() => net(x));
			first = await nn.read(y);
		},
	);
	// the same forward on a runtime that was never warmed gives the same numbers
	const cold = new GpuNn(dev, { graphGroup: "nn/warm-cold" });
	const wc = cold.fromArray(rand(64 * 64), [64, 64]);
	const x = cold.fromArray(input, [10, 64]);
	const { y } = await cold.forward(() => ({
		y: cold.gelu(cold.matmul(x, wc)),
	}));
	const ref = await cold.read(y);
	let err = 0;
	for (let i = 0; i < ref.length; i++)
		err = Math.max(err, Math.abs(ref[i] - (first as Float32Array)[i]));
	check(
		"small net: warmed result equals the unwarmed one",
		err === 0,
		`max err ${err}`,
	);
	// a second warm of a compiled graph is a no-op hit
	await nn.warm((scratch) => net(scratch([10, 64])));
	check(
		"small net: warm after the real forward is only a hit",
		nn.runtime.stats.graphs === 1,
	);
	// a throwing fn leaves the runtime usable
	let threw = false;
	try {
		await nn.warm(() => {
			throw new Error("boom");
		});
	} catch {
		threw = true;
	}
	const { y: y2 } = await nn.forward(() => ({
		y: nn.gelu(nn.matmul(nn.fromArray(input, [10, 64]), w)),
	}));
	check(
		"small net: a failing warm fn rethrows and the runtime still works",
		threw && (await nn.read(y2)).length === 640,
	);
}

async function sky(nn: GpuNn) {
	const net = bindU2netp(await nn.loadWeights(U2NETP_WEIGHTS));
	const h = 384;
	const w = 512;
	const real = async () => {
		const x = nn.fromArray(rand(3 * h * w, 5), [1, 3, h, w]);
		const { prob } = await nn.forward(() => runU2netp(nn, net, x));
		const t = now();
		const v = await nn.read(prob);
		nn.dispose(prob);
		nn.dispose(x);
		return { v, readMs: now() - t };
	};
	const warmFn = () =>
		nn.warm((scratch) => runU2netp(nn, net, scratch([1, 3, h, w])));
	return { real, warmFn };
}

async function people(nn: GpuNn) {
	const nets = [await loadPeopleNet(nn, "multiclass")];
	const w = MASK_LONG_SIDE;
	const h = 384;
	const real = async () => {
		const tex = dev.createTexture({
			id: "people-rgba",
			width: w,
			height: h,
			format: "rgba8unorm",
			usage: Texture.SAMPLE | Texture.COPY_DST | Texture.RENDER_ATTACHMENT,
		});
		try {
			await segmentTextureGpu(nn, nets, tex, w, h);
		} finally {
			tex.destroy();
		}
	};
	const warmFn = () => warmPeopleMask(nn, nets, dev, w, h);
	return { real, warmFn };
}

async function aliked(nn: GpuNn) {
	const weights = await nn.loadWeights(ALIKED_WEIGHTS);
	const W = 1024;
	const H = 768;
	// the real first extract: runAliked's single forward, then its readback
	const real = async () => {
		const rgb = nn.fromArray(rand(3 * H * W, 9), [1, 3, H, W]);
		await runAliked(nn, weights, rgb, { maxKeypoints: 4096, longSide: 1024 });
		nn.dispose(rgb);
	};
	const warmFn = () => warmAliked(nn, weights);
	return { real, warmFn };
}

if (bench) {
	const nn = new GpuNn(dev, {
		graphGroup: `nn/bench-${bench.model}`,
	});
	const m =
		bench.model === "sky"
			? await sky(nn)
			: bench.model === "people"
				? await people(nn)
				: await aliked(nn);
	if (bench.warm) await m.warmFn();
	const t0 = now();
	await m.real();
	console.log(
		JSON.stringify({
			model: bench.model,
			warm: bench.warm,
			firstForwardMs: +(now() - t0).toFixed(1),
		}),
	);
	process.exit(0);
}

await smallNet();
if (has(U2NETP_WEIGHTS)) {
	const nn = new GpuNn(dev, { graphGroup: "nn/warm-sky" });
	const m = await sky(nn);
	await hitAfterWarm(
		"sky U²-Net 512×384",
		nn,
		m.warmFn,
		async () => void (await m.real()),
	);
} else console.log("SKIP sky: weights missing");
if (has(PEOPLE_WEIGHTS.multiclass)) {
	const nn = new GpuNn(dev, { graphGroup: "nn/warm-people" });
	const m = await people(nn);
	await hitAfterWarm("people mask 512×384", nn, m.warmFn, m.real);
} else console.log("SKIP people: weights missing");
if (has(ALIKED_WEIGHTS)) {
	const nn = new GpuNn(dev, { graphGroup: "nn/warm-aliked" });
	const m = await aliked(nn);
	await hitAfterWarm(
		"aliked forward 1024×768",
		nn,
		m.warmFn,
		m.real,
		2 ** 22 + 4096, // the border mask, a power-of-two pooled buffer
	);
} else console.log("SKIP aliked: weights missing");
console.log(failed ? `FAIL nn-warm: ${failed} failed` : "PASS nn-warm");
process.exit(failed ? 1 : 0);
