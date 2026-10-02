// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU backend timing in node for the people segmenters (selfie multiclass, DeepLab), CPU time with a
// per-op breakdown.   npx tsx scripts/nn/cpu-bench-seg.ts [--naive] [multiclass|deeplab]
import { readFileSync } from "node:fs";
import { CpuNn } from "../../src/lib/nn/cpu";
import { PEOPLE_WEIGHTS, type PeopleModel } from "../../src/lib/segment/people";
import { bindTfliteNet, runTfliteNet } from "../../src/lib/segment/tflite-net";

const cpuNow = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
const nn = new CpuNn();
nn.fastConv = !process.argv.includes("--naive");
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
const rows = new Map<string, { ms: number; mac: number }>();
const pc = proto.pConv;
proto.pConv = function (this: unknown, ...a: unknown[]) {
	const t0 = cpuNow();
	const r = pc.apply(this, a);
	const q = a[3] as Record<string, number>;
	const key = `${q.Cin}->${q.Cout} k${q.kh} s${q.sh} g${q.groups} ${q.W}x${q.H}`;
	const row = rows.get(key) ?? { ms: 0, mac: 0 };
	row.ms += cpuNow() - t0;
	row.mac += (q.Cin / q.groups) * q.Cout * q.kh * q.kw * q.Ho * q.Wo;
	rows.set(key, row);
	return r;
};
const which = (["multiclass", "deeplab"] as PeopleModel[]).filter((m) =>
	process.argv.includes(m),
);
for (const m of which.length
	? which
	: (["multiclass", "deeplab"] as PeopleModel[])) {
	const net = bindTfliteNet(
		nn.weightsFromBytes(readFileSync(`public/models/${PEOPLE_WEIGHTS[m]}`)),
	);
	const n = net.inputShape.reduce((a, b) => a * b, 1);
	const x = nn.fromArray(
		Float32Array.from({ length: n }, (_, i) => Math.sin(i * 0.37)),
		net.inputShape,
	);
	acc.clear();
	const t0 = cpuNow();
	runTfliteNet(nn, net, x);
	const br = [...acc]
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k.slice(1)} ${v.toFixed(0)}`)
		.join(", ");
	if (process.argv.includes("--convs"))
		for (const [k, r] of [...rows]
			.sort((a, b) => b[1].ms - a[1].ms)
			.slice(0, 14))
			console.log(
				`  ${k.padEnd(30)} ${r.ms.toFixed(0).padStart(5)} ms ${(r.mac / r.ms / 1e6).toFixed(2)} GMAC/s`,
			);
	rows.clear();
	console.log(
		`${m} [${net.inputShape.join("x")}]: ${(cpuNow() - t0).toFixed(0)} ms  [${br}]`,
	);
}
