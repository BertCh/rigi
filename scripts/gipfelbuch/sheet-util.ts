// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Shared helpers for the offline sheet bake (scripts/gipfelbuch/data-sheet.ts): seeded PRNG, grid blur and gradients.
 * These are node build scripts, so the GPU-first rule does not apply; everything here is deterministic CPU code.
 */

/** sfc32 seeded from an integer hash (no Math.random anywhere in the bake). */
export function makeRng(seed: number) {
	let a = 0x9e3779b9;
	let b = 0x243f6a88;
	let c = 0xb7e15162;
	let d = seed | 0;
	const next = () => {
		a >>>= 0;
		b >>>= 0;
		c >>>= 0;
		d >>>= 0;
		const t = (a + b) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		d = (d + 1) | 0;
		const r = (t + d) | 0;
		c = (c + r) | 0;
		return (r >>> 0) / 4294967296;
	};
	for (let i = 0; i < 12; i++) next();
	return next;
}

/** FNV-1a string hash to a 32-bit integer. */
export function hashString(text: string) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++)
		h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const smoothstep = (a: number, b: number, v: number) => {
	const t = clamp01((v - a) / (b - a));
	return t * t * (3 - 2 * t);
};

/** Separable Gaussian blur with clamped edges. */
export function blurGrid(
	src: Float32Array | Float64Array,
	w: number,
	h: number,
	sigma: number,
) {
	const r = Math.max(1, Math.ceil(sigma * 3));
	const k = new Float32Array(2 * r + 1);
	let sum = 0;
	for (let i = -r; i <= r; i++) {
		k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
		sum += k[i + r];
	}
	for (let i = 0; i < k.length; i++) k[i] /= sum;
	const tmp = new Float32Array(w * h);
	const out = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let s = 0;
			for (let i = -r; i <= r; i++)
				s += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
			tmp[y * w + x] = s;
		}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let s = 0;
			for (let i = -r; i <= r; i++)
				s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
			out[y * w + x] = s;
		}
	return out;
}

/** Central-difference gradient in metres per metre: east (x) and north (y; rows run south, so sign flipped). */
export function gradientEN(
	z: Float32Array,
	w: number,
	h: number,
	cellMetres: number,
) {
	const gx = new Float32Array(w * h);
	const gy = new Float32Array(w * h);
	const g = (x: number, y: number) =>
		z[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			gx[y * w + x] = (g(x + 1, y) - g(x - 1, y)) / (2 * cellMetres);
			gy[y * w + x] = (g(x, y - 1) - g(x, y + 1)) / (2 * cellMetres);
		}
	return { gx, gy };
}

/** Connected components (4-neighbour) of a binary mask; returns the label grid and per-label area. */
export function labelComponents(mask: Uint8Array, w: number, h: number) {
	const labels = new Int32Array(w * h).fill(-1);
	const areas: number[] = [];
	const stack: number[] = [];
	for (let i = 0; i < w * h; i++) {
		if (!mask[i] || labels[i] >= 0) continue;
		const id = areas.length;
		let area = 0;
		stack.push(i);
		labels[i] = id;
		while (stack.length) {
			const c = stack.pop() as number;
			area++;
			const x = c % w;
			const y = (c / w) | 0;
			const nb = [
				x > 0 ? c - 1 : -1,
				x < w - 1 ? c + 1 : -1,
				y > 0 ? c - w : -1,
				y < h - 1 ? c + w : -1,
			];
			for (const n of nb)
				if (n >= 0 && mask[n] && labels[n] < 0) {
					labels[n] = id;
					stack.push(n);
				}
		}
		areas.push(area);
	}
	return { labels, areas };
}
