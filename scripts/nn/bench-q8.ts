// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// MoGe-2 q8 download, resident int8 weights (GpuNn quantResident) vs the load-time f16 expansion:
// forward time (median of warm runs), GPU weight bytes, and the output difference between the two.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/bench-q8.ts [--runs 7] [--bh 30 --bw 40] [--file <q8 file>]

import { readFileSync } from "node:fs";
import path from "node:path";
import {
	MOGE2_WEIGHTS,
	MogeDepthNet,
} from "../../src/lib/nearfield/local/depth-net";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import type { Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
const runs = Number(arg("--runs", "7"));
const bh = Number(arg("--bh", "30"));
const bw = Number(arg("--bw", "40"));
const file = arg("--file", MOGE2_WEIGHTS.q8);
const device = await dawnDevice("bench-q8");
if (!device) {
	console.log("SKIP bench-q8: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const bytes = new Uint8Array(
	readFileSync(path.resolve(import.meta.dirname, "../../public/models", file)),
);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

let seed = 7;
const n = bh * 14 * bw * 14;
const planes = new Float32Array(3 * n);
for (let i = 0; i < planes.length; i++) {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	planes[i] =
		0.5 + 0.4 * Math.sin(i * 0.0013) + (seed / 4294967296 - 0.5) * 0.1;
}

async function run(resident: boolean) {
	const nn = new GpuNn(device as never, { quantResident: resident });
	const net = new MogeDepthNet(nn, nn.weightsFromBytes(bytes));
	await nn.sync();
	const map = (
		net.weights as unknown as {
			map: Map<string, { dtype: string; st: { bytes: number } }>;
		}
	).map;
	let weightBytes = 0;
	let q8 = 0;
	for (const t of map.values()) {
		weightBytes += t.st.bytes;
		if (t.dtype === "q8") q8++;
	}
	const times: number[] = [];
	let out: Record<string, Float32Array> = {};
	for (let r = 0; r < runs + 2; r++) {
		const image = nn.fromArray(planes, [1, 3, bh * 14, bw * 14]);
		const t = performance.now();
		const o = await net.run(image, bw / bh, [bh * 14, bw * 14]);
		const read = async (x: Tensor | null) =>
			x ? nn.read(x) : new Float32Array();
		out = {
			z: await read(o.z),
			mask: await read(o.mask),
			normal: await read(o.normal),
		};
		if (r >= 2) times.push(performance.now() - t);
		nn.dispose([image, ...Object.values(o).filter((x) => x !== null)]);
	}
	return { weightBytes, q8, times, out };
}

const a = await run(false);
const b = await run(true);
console.log(
	`tokens ${bh * bw} (${bh * 14}x${bw * 14}), ${runs} warm runs each (noisy: shared machine)`,
);
for (const [label, r] of [
	["expanded f16", a],
	["resident q8", b],
] as const)
	console.log(
		`${label}: forward median ${median(r.times).toFixed(0)} ms (min ${Math.min(...r.times).toFixed(0)}, max ${Math.max(...r.times).toFixed(0)}), GPU weight bytes ${(r.weightBytes / 1e6).toFixed(1)} MB, q8 tensors ${r.q8}`,
	);
for (const k of Object.keys(a.out)) {
	const x = a.out[k];
	const y = b.out[k];
	const d = Array.from(x, (v, i) => Math.abs(v - y[i])).sort((p, q) => p - q);
	const amax = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
	console.log(
		`${k}: max|expanded| ${amax.toFixed(3)}  diff max ${d[d.length - 1]?.toExponential(2)} median ${d[d.length >> 1]?.toExponential(2)} p99 ${d[Math.floor(d.length * 0.99)]?.toExponential(2)}`,
	);
}
process.exit(0);
