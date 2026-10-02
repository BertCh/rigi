// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU timestamp profile of the MoGe-2 depth forward over Dawn in node: per-op-type GPU ms (top N) for the
// live presets and the 1200-token still path.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/depth-profile.ts --dir <photo dir> [--tokens 256,1200] [--top 10]
//     [--f16 on|off] [--weights q8|q8lite]

import { readFileSync } from "node:fs";
import path from "node:path";
import { getGpuProfile, resetGpuProfile } from "../../src/lib/gpu/core/profile";
import {
	MOGE2_WEIGHTS,
	MogeDepthNet,
	type MogeWeights,
	tokenGrid,
} from "../../src/lib/nearfield/local/depth-net";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { setKernelCaps } from "../../src/lib/nn/gpu/kernel-caps";
import { dawnDevice } from "./dawn";

const argv = process.argv.slice(2);
const arg = (k: string, d?: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
const dir = arg("--dir");
if (!dir) {
	console.error("usage: depth-profile.ts --dir <dir>");
	process.exit(2);
}
const device = await dawnDevice("depth-profile");
if (!device) {
	console.log("SKIP depth-profile: DAWN_DIR not set or no adapter");
	process.exit(0);
}
globalThis.__RIGI_GPU_PROFILE__ = true;
if (arg("--f16") === "on") setKernelCaps({ f16Math: true });
if (arg("--f16") === "acc")
	setKernelCaps({ f16Math: true, f16Accumulate: true });
const weights = (arg("--weights", "q8") ?? "q8") as MogeWeights;
const nn = new GpuNn(device);
const MODELS = path.resolve(import.meta.dirname, "../../public/models");
const net = new MogeDepthNet(
	nn,
	nn.weightsFromBytes(
		new Uint8Array(readFileSync(path.join(MODELS, MOGE2_WEIGHTS[weights]))),
	),
);
await nn.sync();
const photo = (
	JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")) as {
		name: string;
		W: number;
		H: number;
	}[]
)[0];
const top = Number(arg("--top", "10"));
for (const tokens of (arg("--tokens", "256,1200") ?? "")
	.split(",")
	.map(Number)) {
	const [bh, bw] = tokenGrid(tokens, photo.W / photo.H);
	const image = nn.fromArray(
		Float32Array.from(
			{ length: 3 * bh * 14 * bw * 14 },
			(_, i) => (Math.sin(i * 0.01) + 1) / 2,
		),
		[1, 3, bh * 14, bw * 14],
	);
	const opts =
		tokens <= 384
			? { batchedHeads: true, headStopLevel: 3 as const, normals: false }
			: { normals: false };
	for (let i = 0; i < 3; i++) {
		resetGpuProfile();
		const o = await net.run(image, photo.W / photo.H, [photo.H, photo.W], opts);
		await nn.read(o.mask64);
		if (i < 2) continue;
		const prof = await getGpuProfile();
		const byType = new Map<string, { ms: number; n: number }>();
		let total = 0;
		for (const [label, v] of Object.entries(prof)) {
			// label: graph/node-id; node ids are `<scope>/<op>#n` style: bucket by op name
			const node = (label.split("/").pop() ?? label).replace(/^n\d+:/, "");
			const parts = node.split("-");
			const head = parts.slice(
				0,
				parts.findIndex((x) => /^\d+$/.test(x)) >>> 0 || parts.length,
			);
			const op =
				[
					...head,
					...parts.filter(
						(x) =>
							/^g\d+$/.test(x) ||
							/^bias\+/.test(x) ||
							/^(res|add|residual)/.test(x),
					),
				].join("-") || node;
			const t = byType.get(op) ?? { ms: 0, n: 0 };
			t.ms += v.gpuMs;
			t.n += v.count;
			byType.set(op, t);
			total += v.gpuMs;
		}
		console.log(
			`\n== ${weights} tokens ${tokens} (${bh}x${bw}), GPU total ${total.toFixed(1)} ms, ${Object.keys(prof).length} labels`,
		);
		console.log(
			[...byType.entries()]
				.sort((a, b) => b[1].ms - a[1].ms)
				.slice(0, top)
				.map(
					([k, v]) =>
						`${k.padEnd(28)} ${v.ms.toFixed(2).padStart(8)} ms  x${v.n}  ${((100 * v.ms) / total).toFixed(1)}%`,
				)
				.join("\n"),
		);
		if (argv.includes("--labels")) {
			console.log(
				[...Object.entries(prof)]
					.sort((a, b) => b[1].gpuMs - a[1].gpuMs)
					.slice(0, 25)
					.map(([k, v]) => `${k} ${v.gpuMs.toFixed(2)}`)
					.join("\n"),
			);
		}
	}
}
process.exit(0);
