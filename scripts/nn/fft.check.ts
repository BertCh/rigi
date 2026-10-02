// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// nn rfft2 / irfft2 (luma GPUFFT2D inside one nn forward) against the f64 DFT reference
// (src/lib/nn/fft-reference.ts) on Dawn: batched, non-square and square fields, the round trip, and
// the Hermitian-fill path with a spectrum that is not Hermitian in the DC / Nyquist columns (torch's
// c2r drops their imaginary parts). SKIP without DAWN_DIR.
//   DAWN_DIR=/tmp/dawn npx tsx scripts/nn/fft.check.ts
import {
	irfft2Reference,
	rfft2Reference,
} from "../../src/lib/nn/fft-reference";
import { GpuNn } from "../../src/lib/nn/gpu/gpu-nn";
import { dawnDevice } from "./dawn";

const device = await dawnDevice("nn-fft");
if (!device) {
	console.log("SKIP nn-fft: DAWN_DIR not set or no adapter");
	process.exit(0);
}
const nn = new GpuNn(device);
let seed = 7;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
const randn = (n: number) =>
	Float32Array.from({ length: n }, () => rand() * 2 - 1);
const worst = (got: Float32Array, ref: Float32Array) => {
	let e = 0;
	let m = 1e-9;
	for (let i = 0; i < ref.length; i++) {
		e = Math.max(e, Math.abs(got[i] - ref[i]));
		m = Math.max(m, Math.abs(ref[i]));
	}
	return e / m;
};
let failed = 0;
const report = (name: string, rel: number, tol: number) => {
	const ok = rel <= tol;
	if (!ok) failed++;
	console.log(
		`${ok ? "PASS" : "FAIL"} ${name}  maxRel ${rel.toExponential(2)}`,
	);
};

for (const [b, h, w] of [
	[1, 8, 8],
	[3, 16, 32],
	[2, 32, 8],
	[1, 64, 64],
	[1, 2, 2],
]) {
	const wf = (w >> 1) + 1;
	const x = randn(b * h * w);
	const tx = nn.fromArray(x, [b, h, w]);
	const [spec, back] = await nn.forward(() => {
		const f = nn.rfft2(tx);
		return [f, nn.irfft2(f)];
	});
	const got = await nn.read(spec);
	if (spec.shape.join() !== [b, h, wf, 2].join())
		report(`rfft2 shape ${spec.shape}`, 1, 0);
	report(`rfft2 ${b}x${h}x${w}`, worst(got, rfft2Reference(x, b, h, w)), 2e-5);
	report(`round trip ${b}x${h}x${w}`, worst(await nn.read(back), x), 2e-5);
	// an arbitrary (non-Hermitian) half spectrum through irfft2
	const s = randn(b * h * wf * 2);
	const ts = nn.fromArray(s, [b, h, wf, 2]);
	const inv = await nn.forward(() => nn.irfft2(ts));
	report(
		`irfft2 ${b}x${h}x${w} (random spectrum)`,
		worst(await nn.read(inv), irfft2Reference(s, b, h, w)),
		2e-5,
	);
	nn.dispose([tx, ts, spec, back, inv]);
}
for (const bad of [[6, 8]]) {
	try {
		await nn.forward(() => nn.rfft2(nn.zeros(bad)));
		failed++;
		console.log(`FAIL rfft2 accepted ${bad}`);
	} catch {
		console.log(`PASS rfft2 rejects ${bad} (not a power of two)`);
	}
}
console.log(failed ? "FAIL nn-fft" : "PASS nn-fft");
process.exit(failed ? 1 : 0);
