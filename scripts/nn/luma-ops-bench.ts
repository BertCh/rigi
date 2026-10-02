// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn kernel vs the luma gpgpu operator doing the same job (Dawn in node): GPUMatMul, GPUElementwise,
// GPUTranspose, GPUReduction and GPUSort against nn matmul / binary / transpose / reduce / topk, same
// data, same timing method (R ops in one submission, median of 7 to a 4-byte readback), plus the max
// error of both against the CPU reference. The numbers decide which side nn uses (see README).
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/luma-ops-bench.ts [matmul|elementwise|transpose|reduce|sort]
import { type Device, Buffer as LumaBuffer } from "@luma.gl/core";
import { ComputeGraph, viewRange } from "../../src/lib/gpu/core/graph";
import {
	GPUElementwise,
	GPUMatMul,
	GPUReduction,
	GPUSort,
	GPUTranspose,
	type GraphDataView,
} from "../../src/lib/gpu/core/luma";
import { CpuNn } from "../../src/lib/nn/cpu";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import type { Tensor } from "../../src/lib/nn/types";
import { dawnDevice } from "./dawn";

const maybeDevice = await dawnDevice("nn-luma-ops");
if (!maybeDevice) {
	console.log("SKIP nn-luma-ops: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const device: Device = maybeDevice;
const only = process.argv[2];
const nn = new GpuNn(device);
const cpu = new CpuNn();
const STORAGE = LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST;
const rnd = (n: number, s = 0.5) =>
	Float32Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898) * s);
const median = (a: number[]) =>
	a.sort((x, y) => x - y)[Math.floor(a.length / 2)];

/** nn: R copies of `op` in one forward. */
async function timeNn(R: number, op: () => Tensor) {
	const run = async () => {
		const outs = await nn.forward(() => Array.from({ length: R }, op));
		await nn.read(nn.slice(nn.reshape(outs[R - 1], [-1]), 0, 0, 1));
		nn.dispose(outs);
	};
	await run();
	const ms: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t0 = performance.now();
		await run();
		ms.push(performance.now() - t0);
	}
	return median(ms) / R;
}

const out = (bytes: number) =>
	device.createBuffer({ usage: STORAGE, byteLength: bytes });
const maxRel = (got: ArrayLike<number>, ref: ArrayLike<number>) => {
	let e = 0;
	let m = 1e-30;
	for (let i = 0; i < ref.length; i++) {
		e = Math.max(e, Math.abs(got[i] - ref[i]));
		m = Math.max(m, Math.abs(ref[i]));
	}
	return e / m;
};
const row = (label: string, nnMs: number, lumaMs: number, extra = "") =>
	console.log(
		`${label.padEnd(34)} nn ${nnMs.toFixed(3).padStart(8)} ms  luma ${lumaMs.toFixed(3).padStart(8)} ms  luma/nn ${(lumaMs / nnMs).toFixed(2).padStart(5)}x  ${extra}`,
	);

/** One luma op in its own graph: build with `add`, run once, return the output plane for parity. */
async function runLumaOnce(
	inputs: (Float32Array | Uint32Array)[],
	formats: ("float32" | "uint32")[],
	outLen: number,
	outFmt: "float32" | "uint32",
	add: (g: ComputeGraph, ins: GraphDataView[], o: GraphDataView) => void,
) {
	const g = new ComputeGraph(device, "luma-once");
	const ins = inputs.map((d, i) =>
		g.importView(
			`i${i}`,
			device.createBuffer({ usage: STORAGE, data: d }),
			formats[i],
			d.length,
		),
	);
	const ob = out(outLen * 4);
	const o = g.importView("o", ob, outFmt, outLen);
	add(g, ins as GraphDataView[], o);
	g.compile();
	const r = await g.run(undefined, { read: [viewRange(o, ob)] });
	return outFmt === "float32"
		? new Float32Array(r.data[0]).slice(0, outLen)
		: new Uint32Array(r.data[0]).slice(0, outLen);
}

/** Time one luma op: R copies in one graph over fixed inputs, output to one buffer. */
async function lumaTime(
	R: number,
	inputs: (Float32Array | Uint32Array)[],
	formats: ("float32" | "uint32")[],
	outLen: number,
	outFmt: "float32" | "uint32",
	add: (
		g: ComputeGraph,
		ins: GraphDataView[],
		o: GraphDataView,
		i: number,
	) => void,
) {
	const g = new ComputeGraph(device, "luma-time");
	const ins = inputs.map((d, i) =>
		g.importView(
			`i${i}`,
			device.createBuffer({ usage: STORAGE, data: d }),
			formats[i],
			d.length,
		),
	);
	const ob = out(outLen * 4);
	const o = g.importView("o", ob, outFmt, outLen);
	for (let i = 0; i < R; i++) add(g, ins as GraphDataView[], o, i);
	g.compile();
	const small = g.view(o.buffer, "uint32", 1);
	const run = () => g.run(undefined, { read: [viewRange(small, ob)] });
	await run();
	const ms: number[] = [];
	for (let i = 0; i < 7; i++) {
		const t0 = performance.now();
		await run();
		ms.push(performance.now() - t0);
	}
	return median(ms) / R;
}

if (!only || only === "matmul") {
	console.log("-- matmul (f32) --");
	for (const [M, K, N] of [
		[256, 256, 256],
		[1024, 1024, 1024],
		[2048, 768, 768],
		[1369, 768, 3072],
	]) {
		const a = rnd(M * K);
		const b = rnd(K * N, 0.3);
		const ta = nn.fromArray(a, [M, K]);
		const tb = nn.fromArray(b, [K, N]);
		const nnMs = await timeNn(8, () => nn.matmul(ta, tb));
		const lumaMs = await lumaTime(
			8,
			[a, b],
			["float32", "float32"],
			M * N,
			"float32",
			(g, [l, r], o, i) =>
				g.add(
					new GPUMatMul({
						id: `mm${i}`,
						left: l as never,
						right: r as never,
						output: o as never,
						m: M,
						k: K,
						n: N,
					}),
				),
		);
		let err = "";
		if (M * N * K <= 2048 * 768 * 768) {
			const ref = await cpu.read(
				cpu.matmul(cpu.fromArray(a, [M, K]), cpu.fromArray(b, [K, N])),
			);
			const got = await runLumaOnce(
				[a, b],
				["float32", "float32"],
				M * N,
				"float32",
				(g, [l, r], o) =>
					g.add(
						new GPUMatMul({
							left: l as never,
							right: r as never,
							output: o as never,
							m: M,
							k: K,
							n: N,
						}),
					),
			);
			const nnGot = await nn.read(nn.matmul(ta, tb));
			err = `rel err nn ${maxRel(nnGot, ref).toExponential(1)} luma ${maxRel(got as Float32Array, ref).toExponential(1)}`;
		}
		const gf = (ms: number) => ((2 * M * N * K) / (ms * 1e6)).toFixed(0);
		row(
			`matmul ${M}x${K}x${N}`,
			nnMs,
			lumaMs,
			`${gf(nnMs)} vs ${gf(lumaMs)} GFLOP/s  ${err}`,
		);
	}
}

if (!only || only === "elementwise") {
	console.log("-- elementwise, same shape (f32) --");
	for (const n of [1 << 16, 1 << 22]) {
		const a = rnd(n);
		const b = rnd(n, 0.7);
		const ta = nn.fromArray(a, [n]);
		const tb = nn.fromArray(b, [n]);
		const pairs: [
			string,
			"add" | "sub" | "mul" | "max",
			"add" | "subtract" | "multiply" | "max",
		][] = [
			["add", "add", "add"],
			["mul", "mul", "multiply"],
			["max", "max", "max"],
		];
		for (const [name, nnOp, lumaOp] of pairs) {
			const nnMs = await timeNn(8, () => nn.binary(nnOp, ta, tb));
			const lumaMs = await lumaTime(
				8,
				[a, b],
				["float32", "float32"],
				n,
				"float32",
				(g, [x, y], o, i) =>
					g.add(
						new GPUElementwise({
							id: `e${i}`,
							operation: lumaOp,
							input: x as never,
							inputB: y as never,
							output: o as never,
						}),
					),
			);
			const ref = await cpu.read(
				cpu.binary(nnOp, cpu.fromArray(a, [n]), cpu.fromArray(b, [n])),
			);
			const got = await runLumaOnce(
				[a, b],
				["float32", "float32"],
				n,
				"float32",
				(g, [x, y], o) =>
					g.add(
						new GPUElementwise({
							operation: lumaOp,
							input: x as never,
							inputB: y as never,
							output: o as never,
						}),
					),
			);
			const nnGot = await nn.read(nn.binary(nnOp, ta, tb));
			row(
				`${name} n=${n}`,
				nnMs,
				lumaMs,
				`rel err nn ${maxRel(nnGot, ref).toExponential(1)} luma ${maxRel(got as Float32Array, ref).toExponential(1)}`,
			);
		}
	}
}

if (!only || only === "transpose") {
	console.log("-- transpose [R, C] -> [C, R] (f32) --");
	for (const [R, C] of [
		[256, 256],
		[2048, 2048],
		[1024, 4096],
		[1369, 768],
	]) {
		const a = rnd(R * C);
		const ta = nn.fromArray(a, [R, C]);
		const nnMs = await timeNn(8, () => nn.transpose(ta, 0, 1));
		const lumaMs = await lumaTime(
			8,
			[a],
			["float32"],
			R * C,
			"float32",
			(g, [x], o, i) =>
				g.add(
					new GPUTranspose({
						id: `t${i}`,
						input: x as never,
						output: o as never,
						rows: R,
						columns: C,
					}),
				),
		);
		const ref = await cpu.read(cpu.transpose(cpu.fromArray(a, [R, C]), 0, 1));
		const got = await runLumaOnce(
			[a],
			["float32"],
			R * C,
			"float32",
			(g, [x], o) =>
				g.add(
					new GPUTranspose({
						input: x as never,
						output: o as never,
						rows: R,
						columns: C,
					}),
				),
		);
		const nnGot = await nn.read(nn.transpose(ta, 0, 1));
		row(
			`transpose ${R}x${C}`,
			nnMs,
			lumaMs,
			`max abs diff nn ${maxRel(nnGot, ref).toExponential(1)} luma ${maxRel(got as Float32Array, ref).toExponential(1)}`,
		);
	}
}

if (!only || only === "reduce") {
	console.log("-- full reduction to a scalar (f32) --");
	for (const n of [1 << 16, 1 << 20, 1 << 22]) {
		const a = rnd(n);
		const ta = nn.fromArray(a, [1, n]);
		for (const op of ["sum", "max"] as const) {
			const nnMs = await timeNn(8, () => nn.reduce(op, ta, 1));
			const lumaMs = await lumaTime(
				8,
				[a],
				["float32"],
				1,
				"float32",
				(g, [x], o, i) =>
					g.add(
						new GPUReduction({
							id: `r${i}`,
							operation: op,
							input: x as never,
							output: o as never,
						}),
					),
			);
			const ref = await cpu.read(cpu.reduce(op, cpu.fromArray(a, [1, n]), 1));
			const got = await runLumaOnce(
				[a],
				["float32"],
				1,
				"float32",
				(g, [x], o) =>
					g.add(
						new GPUReduction({
							operation: op,
							input: x as never,
							output: o as never,
						}),
					),
			);
			const nnGot = await nn.read(nn.reduce(op, ta, 1));
			row(
				`${op} n=${n}`,
				nnMs,
				lumaMs,
				`value nn ${nnGot[0].toFixed(3)} luma ${got[0].toFixed(3)} cpu ${ref[0].toFixed(3)}`,
			);
		}
	}
}

if (!only || only === "sort") {
	console.log(
		"-- top-k via sort: nn topk(4096 of n) vs GPUSort descending of n keys (no key transform, no gather) --",
	);
	for (const n of [1 << 16, 786432, 1 << 20]) {
		const a = rnd(n, 1);
		const keys = Uint32Array.from(a, (v) => {
			const u = new Uint32Array(new Float32Array([v]).buffer)[0];
			return u & 0x80000000 ? ~u >>> 0 : (u | 0x80000000) >>> 0;
		});
		const vals = Uint32Array.from({ length: n }, (_, i) => i);
		const ta = nn.fromArray(a, [1, n]);
		const nnMs = await timeNn(2, () => nn.topk(ta, 4096).indices);
		const lumaMs = await lumaTime(
			2,
			[keys, vals],
			["uint32", "uint32"],
			n,
			"uint32",
			(g, [k, v], o, i) => {
				const ok = g.transientView(`ok${i}`, "uint32", n);
				g.add(
					new GPUSort({
						id: `s${i}`,
						keys: k as never,
						values: v as never,
						outputKeys: ok,
						outputValues: o as never,
						direction: "descending",
					}),
				);
			},
		);
		row(`topk 4096 of ${n}`, nnMs, lumaMs);
	}
}
if (!only || only === "e2e") {
	console.log("-- end to end through nn (lumaOps on vs off) --");
	const both = async (label: string, R: number, op: () => Tensor) => {
		nn.lumaOps.enabled = false;
		const off = await timeNn(R, op);
		nn.lumaOps.enabled = true;
		const on = await timeNn(R, op);
		row(label, off, on, "(nn kernels vs luma operators)");
	};
	for (const n of [1 << 12, 1 << 14, 1 << 15, 1 << 16, 786432]) {
		const x = nn.fromArray(rnd(n, 1), [1, n]);
		await both(
			`topk ${Math.min(4096, n >> 2)} of ${n}`,
			2,
			() => nn.topk(x, Math.min(4096, n >> 2)).indices,
		);
	}
	for (const n of [1 << 14, 1 << 16, 1 << 17, 1 << 18, 1 << 19]) {
		const x = nn.fromArray(rnd(n), [1, n]);
		await both(`sum of ${n}`, 8, () => nn.sum(x, 1));
	}
}
process.exit(0);
