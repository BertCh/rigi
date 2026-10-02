// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU backend timing in node: U2-Net-P forward at several sizes with a per-op breakdown.
//   npx tsx scripts/nn/cpu-bench.ts [--naive] [--convs] [--sizes 160x128,192x160,384x288,512x384] [--reps 1]
import { readFileSync } from "node:fs";
import { CpuNn } from "../../src/lib/nn/cpu";
import {
	bindU2netp,
	runU2netp,
	U2NETP_WEIGHTS,
} from "../../src/lib/sky/u2netp";

const arg = (k: string, d: string) => {
	const i = process.argv.indexOf(k);
	return i > 0 ? process.argv[i + 1] : d;
};
const sizes = arg("--sizes", "160x128,192x160,384x288,512x384")
	.split(",")
	.map((s) => s.split("x").map(Number));
const reps = Number(arg("--reps", "1"));

// CPU time, not wall time: the machine is shared, so wall clocks swing with load.
const cpuNow = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
const nn = new CpuNn();
nn.fastConv = !process.argv.includes("--naive"); // the pre-tiling loops, for before/after
const bytes = readFileSync(`public/models/${U2NETP_WEIGHTS}`);
const model = bindU2netp(nn.weightsFromBytes(bytes));

const acc = new Map<string, number>();
const proto = CpuNn.prototype as unknown as Record<
	string,
	(...a: unknown[]) => unknown
>;
for (const k of Object.getOwnPropertyNames(proto).filter((k) =>
	/^p[A-Z]/.test(k),
)) {
	const f = proto[k];
	proto[k] = function (this: unknown, ...a: unknown[]) {
		const t0 = cpuNow();
		const r = f.apply(this, a);
		acc.set(k, (acc.get(k) ?? 0) + cpuNow() - t0);
		return r;
	};
}

const convRows = new Map<string, { ms: number; mac: number; n: number }>();
if (process.argv.includes("--convs")) {
	const pc = proto.pConv;
	proto.pConv = function (this: unknown, ...a: unknown[]) {
		const t0 = cpuNow();
		const r = pc.apply(this, a);
		const q = a[3] as Record<string, number>;
		const key = `${q.Cin}->${q.Cout} k${q.kh} d${q.dh} ${q.W}x${q.H}`;
		const row = convRows.get(key) ?? { ms: 0, mac: 0, n: 0 };
		row.ms += cpuNow() - t0;
		row.mac += (q.Cin / q.groups) * q.Cout * q.kh * q.kw * q.Ho * q.Wo;
		row.n++;
		convRows.set(key, row);
		return r;
	};
}

for (const [W, H] of sizes) {
	convRows.clear();
	const x = nn.fromArray(
		Float32Array.from(
			{ length: 3 * H * W },
			(_, i) => Math.sin(i * 0.37) * 1.5,
		),
		[1, 3, H, W],
	);
	const ms: number[] = [];
	for (let r = 0; r < reps; r++) {
		acc.clear();
		const t0 = cpuNow();
		const out = runU2netp(nn, model, x).prob;
		ms.push(cpuNow() - t0);
		void out;
	}
	ms.sort((a, b) => a - b);
	const br = [...acc]
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k.slice(1)} ${v.toFixed(0)}`)
		.join(", ");
	let totalMac = 0;
	let totalMs = 0;
	for (const [k, r] of [...convRows].sort((a, b) => b[1].ms - a[1].ms)) {
		totalMac += r.mac;
		totalMs += r.ms;
		console.log(
			`  ${k.padEnd(28)} x${r.n} ${r.ms.toFixed(0).padStart(6)} ms ${(r.mac / r.ms / 1e6).toFixed(2)} GMAC/s`,
		);
	}
	if (totalMs)
		console.log(
			`  conv total ${(totalMac / 1e9).toFixed(2)} GMAC, ${(totalMac / totalMs / 1e6).toFixed(2)} GMAC/s`,
		);
	console.log(
		`${W}x${H}: ${ms[ms.length >> 1].toFixed(0)} ms  [last run: ${br}]`,
	);
}
