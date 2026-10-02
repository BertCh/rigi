// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import { simplifyIndices, simplifyPointIndices } from "../simplify";

// Reference copies of the pre-consolidation implementations (verbatim logic), compared for exact index equality.

function refLineStride3(p: number[], tol: number): number[] {
	const n = p.length / 3;
	if (n < 3) return Array.from({ length: n }, (_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [i, j] = stack.pop() as [number, number];
		const x0 = p[i * 3];
		const y0 = p[i * 3 + 1];
		const dx = p[j * 3] - x0;
		const dy = p[j * 3 + 1] - y0;
		const len = Math.hypot(dx, dy);
		let best = -1;
		let bi = -1;
		for (let k = i + 1; k < j; k++) {
			const dist = len
				? Math.abs(dy * (p[k * 3] - x0) - dx * (p[k * 3 + 1] - y0)) / len
				: Math.hypot(p[k * 3] - x0, p[k * 3 + 1] - y0);
			if (dist > best) {
				best = dist;
				bi = k;
			}
		}
		if (best > tol) {
			keep[bi] = 1;
			stack.push([i, bi], [bi, j]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return out;
}

function refSegmentHypot(pts: [number, number][], tol: number): number[] {
	const n = pts.length;
	if (n <= 2) return pts.map((_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop() as [number, number];
		const [ax, ay] = pts[a];
		const dx = pts[b][0] - ax;
		const dy = pts[b][1] - ay;
		const L2 = dx * dx + dy * dy;
		let best = -1;
		let bi = -1;
		for (let i = a + 1; i < b; i++) {
			const px = pts[i][0] - ax;
			const py = pts[i][1] - ay;
			let d: number;
			if (L2 === 0) d = Math.hypot(px, py);
			else {
				const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2));
				d = Math.hypot(px - t * dx, py - t * dy);
			}
			if (d > best) {
				best = d;
				bi = i;
			}
		}
		if (bi >= 0 && best > tol) {
			keep[bi] = 1;
			stack.push([a, bi], [bi, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return out;
}

// scripts/terroir/lib/geo.ts: squared distance against tol².
function refSegmentSquared(pts: [number, number][], tol: number): number[] {
	const keep = new Uint8Array(pts.length);
	keep[0] = keep[pts.length - 1] = 1;
	const stack: [number, number][] = [[0, pts.length - 1]];
	const t2 = tol * tol;
	while (stack.length) {
		const [a, b] = stack.pop() as [number, number];
		let md = -1;
		let mi = -1;
		const [ax, ay] = pts[a];
		const [bx, by] = pts[b];
		const dx = bx - ax;
		const dy = by - ay;
		const l2 = dx * dx + dy * dy;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = pts[i];
			let d2: number;
			if (l2 === 0) d2 = (px - ax) ** 2 + (py - ay) ** 2;
			else {
				const t = Math.max(
					0,
					Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2),
				);
				d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
			}
			if (d2 > md) {
				md = d2;
				mi = i;
			}
		}
		if (md > t2) {
			keep[mi] = 1;
			stack.push([a, mi], [mi, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
	return out;
}

function walk(rand: () => number, n: number, step: number, closed = false) {
	const pts: [number, number][] = [];
	let x = uniform(rand, -1000, 1000);
	let y = uniform(rand, -1000, 1000);
	for (let i = 0; i < n; i++) {
		pts.push([x, y]);
		x += uniform(rand, -step, step);
		y += uniform(rand, -step, step);
	}
	if (closed && pts.length) pts.push([pts[0][0], pts[0][1]]);
	return pts;
}

describe("simplifyIndices equals the pre-consolidation copies", () => {
	it("line mode matches the stride-3 / stride-2 / Pt[] copies exactly", () => {
		const rand = seededRandom(7);
		for (let trial = 0; trial < 300; trial++) {
			const n = Math.floor(uniform(rand, 0, 120));
			const pts = walk(rand, n, uniform(rand, 0.1, 30), trial % 5 === 0);
			const tol = uniform(rand, 0, 25);
			const flat3 = pts.flatMap(([x, y], i) => [x, y, i]);
			const expected = refLineStride3(flat3, tol);
			expect(
				simplifyIndices(
					flat3.length / 3,
					(i) => flat3[i * 3],
					(i) => flat3[i * 3 + 1],
					tol,
				),
			).toEqual(expected);
			expect(simplifyPointIndices(pts, tol)).toEqual(expected);
		}
	});

	it("segment mode matches the lake compactor copy exactly", () => {
		const rand = seededRandom(11);
		for (let trial = 0; trial < 300; trial++) {
			const pts = walk(
				rand,
				Math.floor(uniform(rand, 0, 150)),
				20,
				trial % 4 === 0,
			);
			const tol = uniform(rand, 0, 30);
			expect(simplifyPointIndices(pts, tol, "segment")).toEqual(
				refSegmentHypot(pts, tol),
			);
		}
	});

	it("segment mode matches the terroir squared-tolerance copy on 20k random rings/lines", () => {
		const rand = seededRandom(13);
		for (let trial = 0; trial < 400; trial++) {
			const pts = walk(
				rand,
				50 + Math.floor(uniform(rand, 0, 200)),
				20,
				trial % 2 === 0,
			);
			const tol = uniform(rand, 0.5, 30);
			expect(simplifyPointIndices(pts, tol, "segment")).toEqual(
				refSegmentSquared(pts, tol),
			);
		}
	});
});

describe("simplifyIndices behaviour", () => {
	it("keeps everything below three points and always the endpoints", () => {
		expect(simplifyPointIndices([], 1)).toEqual([]);
		expect(
			simplifyPointIndices(
				[
					[0, 0],
					[1, 1],
				],
				1,
			),
		).toEqual([0, 1]);
		expect(
			simplifyPointIndices(
				[
					[0, 0],
					[1, 0.1],
					[2, 0],
				],
				1,
			),
		).toEqual([0, 2]);
	});
	it("keeps a peak above the tolerance and treats a closed zero-length chord as point distance", () => {
		expect(
			simplifyPointIndices(
				[
					[0, 0],
					[1, 5],
					[2, 0],
				],
				1,
			),
		).toEqual([0, 1, 2]);
		const ring: [number, number][] = [
			[0, 0],
			[4, 0],
			[4, 4],
			[0, 0],
		];
		expect(simplifyPointIndices(ring, 1)).toEqual([0, 1, 2, 3]);
		expect(simplifyPointIndices(ring, 1, "segment")).toEqual([0, 1, 2, 3]);
	});
});
