// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { guidedFilter } from "../../../look/guided-filter";

/**
 * CPU emulation of the GPU chain's border rule (guided-filter.wgsl.ts): all-ones zero-boundary box
 * SUMS over a stack of planes separated by r zero gap rows, divided by the analytic in-range window
 * count. Must equal the CPU twin's clamped-window mean.
 */
function boxMeansViaStack(
	planes: Float64Array[],
	w: number,
	h: number,
	r: number,
) {
	const pitch = h + r;
	const rows = planes.length * pitch;
	const stack = new Float64Array(w * rows);
	planes.forEach((plane, c) => {
		stack.set(plane, c * pitch * w);
	});
	const horizontal = new Float64Array(w * rows);
	for (let y = 0; y < rows; y++)
		for (let x = 0; x < w; x++) {
			let sum = 0;
			for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++)
				sum += stack[y * w + k];
			horizontal[y * w + x] = sum;
		}
	return planes.map((_, c) => {
		const out = new Float64Array(w * h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				let sum = 0;
				for (let k = y - r; k <= y + r; k++) {
					const row = c * pitch + k;
					if (row >= 0 && row < rows) sum += horizontal[row * w + x];
				}
				const cx = Math.min(w, x + r + 1) - Math.max(0, x - r);
				const cy = Math.min(h, y + r + 1) - Math.max(0, y - r);
				out[y * w + x] = sum / (cx * cy);
			}
		return out;
	});
}

function filterViaStack(
	I: Float32Array,
	p: Float32Array,
	w: number,
	h: number,
	r: number,
	eps: number,
) {
	const n = w * h;
	const f = (a: Float32Array | Float64Array) => Float64Array.from(a);
	const II = new Float64Array(n);
	const Ip = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		II[i] = I[i] * I[i];
		Ip[i] = I[i] * p[i];
	}
	const [mI, mp, mII, mIp] = boxMeansViaStack([f(I), f(p), II, Ip], w, h, r);
	const a = new Float64Array(n);
	const b = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps);
		b[i] = mp[i] - a[i] * mI[i];
	}
	const [ma, mb] = boxMeansViaStack([a, b], w, h, r);
	return Float32Array.from({ length: n }, (_, i) =>
		Math.min(1, Math.max(0, ma[i] * I[i] + mb[i])),
	);
}

describe("guided filter border rule of the GPU chain", () => {
	it.each([
		[16, 12, 2],
		[5, 7, 5],
		[3, 4, 3],
		[40, 9, 6],
	])("stacked zero-boundary sums / count = the clamped-window mean (%ix%i r%i)", (w, h, r) => {
		const I = new Float32Array(w * h);
		const p = new Float32Array(w * h);
		for (let i = 0; i < w * h; i++) {
			I[i] = (Math.sin(i * 0.37) + 1) / 2;
			p[i] = (Math.cos(i * 0.11) + 1) / 2;
		}
		const cpu = guidedFilter(I, p, w, h, r, 1e-3);
		const emulated = filterViaStack(I, p, w, h, r, 1e-3);
		let max = 0;
		for (let i = 0; i < cpu.length; i++)
			max = Math.max(max, Math.abs(cpu[i] - emulated[i]));
		expect(max).toBeLessThan(1e-5);
	});
});
