// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Frame-loop cost of src/lib/nn on Dawn in node (not a browser bench): per-call CPU overhead of a plain
// forward() vs a compiled forward (nn.compile) on a tiny net and on 100 / 400 node chains, pipelined
// throughput of compiled runs, and the MoGe-2 depth net's warm run at 256 and 1200 tokens (q8 weights)
// through run() vs runCompiled().  Medians of N samples; the GPU is shared, so treat them as noisy.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/frame-loop.bench.ts [--only tiny,chain,pipeline,depth] [--samples 9]
// "sync" columns are the time `forward()` / `run()` take to RETURN their promise: the CPU work of
// recording, planning and encoding that blocks the caller's frame; "total" includes the GPU and readback.

import {
	DEPTH_LIVE_PRESETS,
	MOGE2_VITS,
	MOGE2_WEIGHTS,
	MogeDepthNet,
	tokenGrid,
} from "../../src/lib/nearfield/local/depth-net";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import type { Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const argv = process.argv.slice(2);
const flag = (name: string) =>
	argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
const only = flag("--only") ? new Set(flag("--only")?.split(",")) : null;
const samples = Number(flag("--samples") ?? 9);
const device = await dawnDevice("nn-frame-loop");
if (!device) {
	console.log("SKIP nn-frame-loop: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const nn = new GpuNn(device);
const HAS_COMPILE = typeof (nn as { compile?: unknown }).compile === "function";
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const ms = (v: number) => v.toFixed(3).padStart(8);
const now = () => performance.now();
const rnd = (n: number) =>
	Float32Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898) * 0.5);

async function sampleLoop(
	n: number,
	one: () => Promise<{ sync: number; total: number }>,
) {
	await one();
	await one();
	const sync: number[] = [];
	const total: number[] = [];
	for (let i = 0; i < n; i++) {
		const r = await one();
		sync.push(r.sync);
		total.push(r.total);
	}
	return { sync: median(sync), total: median(total) };
}

const chain = (nodes: number) => (x: Tensor) => {
	let y = x;
	for (let i = 0; i < nodes; i++) y = nn.softmax(y, -1);
	return y;
};

if (!only || only.has("tiny") || only.has("chain")) {
	console.log("per-call overhead (softmax chains over [1, 64]; ms)");
	console.log(
		"                          fwd sync fwd total   cmp sync cmp total",
	);
	for (const [label, nodes] of [
		["tiny (1 node)", 1],
		["chain 100", 100],
		["chain 400", 400],
	] as const) {
		const data = rnd(64);
		const fn = chain(nodes);
		const fwd = await sampleLoop(samples, async () => {
			const x = nn.fromArray(data, [1, 64]);
			const t0 = now();
			const p = nn.forward(() => fn(x));
			const sync = now() - t0;
			const y = await p;
			await nn.read(y);
			const total = now() - t0;
			nn.dispose([x, y]);
			return { sync, total };
		});
		// the compiled path is absent on a checkout from before nn.compile (A/B against it)
		const c = HAS_COMPILE
			? await nn.compile(`bench-chain-${nodes}`, [[1, 64]], ([x]) => fn(x))
			: null;
		const cmp = c
			? await sampleLoop(samples, async () => {
					const t0 = now();
					const p = c.run([data]);
					const sync = now() - t0;
					await p;
					return { sync, total: now() - t0 };
				})
			: { sync: Number.NaN, total: Number.NaN };
		console.log(
			`${label.padEnd(24)} ${ms(fwd.sync)} ${ms(fwd.total)} ${ms(cmp.sync)} ${ms(cmp.total)}   (${((fwd.sync / nodes) * 1000).toFixed(1)} -> ${((cmp.sync / nodes) * 1000).toFixed(1)} us/node sync)`,
		);
		c?.dispose();
	}
}

if ((!only || only.has("pipeline")) && HAS_COMPILE) {
	const nodes = 100;
	const data = rnd(64);
	const c = await nn.compile("bench-pipeline", [[1, 64]], ([x]) =>
		chain(nodes)(x),
	);
	const count = 32;
	await c.run([data]);
	const seq: number[] = [];
	const pipe: number[] = [];
	const maxFlight = { v: 0 };
	for (let s = 0; s < samples; s++) {
		let t0 = now();
		for (let i = 0; i < count; i++) await c.run([data]);
		seq.push((now() - t0) / count);
		t0 = now();
		let flight = 0;
		await Promise.all(
			Array.from({ length: count }, () => {
				flight++;
				maxFlight.v = Math.max(maxFlight.v, flight);
				return c.run([data]).then(() => {
					flight--;
				});
			}),
		);
		pipe.push((now() - t0) / count);
	}
	console.log(
		`pipelined compiled runs (100-node chain, ${count} per sample): awaited one by one ${ms(median(seq))} ms/frame, all in flight ${ms(median(pipe))} ms/frame (max ${maxFlight.v} in flight)`,
	);
	c.dispose();
}

if (!only || only.has("depth")) {
	const file = MOGE2_WEIGHTS.q8;
	let net: MogeDepthNet;
	try {
		net = await MogeDepthNet.load(nn, { file });
	} catch (e) {
		console.log(`SKIP depth: ${file} not loadable (${(e as Error).message})`);
		process.exit(0);
	}
	console.log(`MoGe-2 ViT-S warm run, ${file} (ms, median of ${samples})`);
	for (const tokens of [256, 1200]) {
		const aspect = 4 / 3;
		const [bh, bw] = tokenGrid(tokens, aspect);
		const H = bh * MOGE2_VITS.patch;
		const W = bw * MOGE2_VITS.patch;
		const data = rnd(3 * H * W).map((v) => v + 0.5);
		const run = async () => {
			const image = nn.fromArray(data, [1, 3, H, W]);
			const t0 = now();
			const out = await net.run(image, aspect, [H, W]);
			await nn.read(out.z);
			const total = now() - t0;
			nn.dispose(image);
			nn.dispose(Object.values(out).filter((v): v is Tensor => v !== null));
			return { sync: 0, total };
		};
		const runCompiled = async () => {
			const t0 = now();
			const out = await net.runCompiled({ data, shape: [1, 3, H, W] }, aspect, [
				H,
				W,
			]);
			await nn.read(out.z);
			return { sync: 0, total: now() - t0 };
		};
		const a = await sampleLoop(Math.min(samples, 5), run);
		const b = HAS_COMPILE
			? await sampleLoop(Math.min(samples, 5), runCompiled)
			: { sync: 0, total: Number.NaN };
		console.log(
			`  ${tokens} tokens (grid ${bh}x${bw}, ${W}x${H}): run ${ms(a.total)}  runCompiled ${ms(b.total)}`,
		);
	}

	// the live tier (DEPTH_LIVE_PRESETS.liveFast: q8lite, batched heads, level 3, no normals), outputs at the
	// live depth grid (long side 512) and at 1024 x 768
	const preset = DEPTH_LIVE_PRESETS.liveFast;
	const liveNet = await MogeDepthNet.load(nn, {
		file: MOGE2_WEIGHTS[preset.weights],
	});
	const aspect = 4 / 3;
	const [bh, bw] = tokenGrid(preset.tokens, aspect);
	const H = bh * MOGE2_VITS.patch;
	const W = bw * MOGE2_VITS.patch;
	const data = rnd(3 * H * W).map((v) => v + 0.5);
	for (const out of [
		[384, 512],
		[768, 1024],
	] as const) {
		const run = async () => {
			const image = nn.fromArray(data, [1, 3, H, W]);
			const t0 = now();
			const o = await liveNet.run(image, aspect, out, preset);
			await nn.read(o.z);
			const total = now() - t0;
			nn.dispose(image);
			nn.dispose(Object.values(o).filter((v): v is Tensor => v !== null));
			return { sync: 0, total };
		};
		const runCompiled = async () => {
			const t0 = now();
			const o = await liveNet.runCompiled(
				{ data, shape: [1, 3, H, W] },
				aspect,
				out,
				preset,
			);
			await nn.read(o.z);
			return { sync: 0, total: now() - t0 };
		};
		const a = await sampleLoop(samples, run);
		const b = await sampleLoop(samples, runCompiled);
		console.log(
			`  liveFast ${preset.tokens} tokens (${W}x${H}) out ${out[1]}x${out[0]}: run ${ms(a.total)}  runCompiled ${ms(b.total)}`,
		);
	}
}
process.exit(0);
