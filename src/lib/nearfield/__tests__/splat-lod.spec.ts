// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { SplatRADHierarchyManager } from "@luma.gl/splats";
import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	buildSplatLod,
	SPLAT_LOD_BRANCHING,
	type SplatLod,
	symmetricEigen3,
	tintedLodColors,
} from "../splat-lod";
import type { GaussianCloud } from "../types";

function randomCloud(n: number, seed = 7): GaussianCloud {
	const rand = seededRandom(seed);
	const positions = new Float32Array(3 * n);
	const scales = new Float32Array(3 * n);
	const rotations = new Float32Array(4 * n);
	const colors = new Uint8Array(4 * n);
	const provenance = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		positions[3 * i] = uniform(rand, -10, 10);
		positions[3 * i + 1] = uniform(rand, 5, 40);
		positions[3 * i + 2] = uniform(rand, -2, 6);
		for (let k = 0; k < 3; k++) scales[3 * i + k] = uniform(rand, 0.01, 0.2);
		const q = [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5];
		const l = Math.hypot(...q);
		for (let k = 0; k < 4; k++) rotations[4 * i + k] = q[k] / l;
		for (let k = 0; k < 3; k++) colors[4 * i + k] = Math.floor(rand() * 256);
		colors[4 * i + 3] = 40 + Math.floor(rand() * 216);
		provenance[i] = Math.floor(rand() * 4);
	}
	return {
		count: n,
		frame: "enu",
		positions,
		scales,
		rotations,
		colors,
		provenance,
	};
}

/** Σ from scales + quaternion, as packSplats does. */
function covariance(lod: SplatLod, r: number) {
	let [w, x, y, z] = lod.rotations.subarray(4 * r, 4 * r + 4);
	const l = Math.hypot(w, x, y, z);
	w /= l;
	x /= l;
	y /= l;
	z /= l;
	const R = [
		[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
		[2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
		[2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
	];
	const s = lod.scales.subarray(3 * r, 3 * r + 3);
	const out: number[][] = [];
	for (let i = 0; i < 3; i++) {
		out.push([]);
		for (let j = 0; j < 3; j++) {
			let v = 0;
			for (let k = 0; k < 3; k++) v += R[i][k] * s[k] * s[k] * R[j][k];
			out[i].push(v);
		}
	}
	return out;
}

/** CPU-only RAD page metadata (luma SplatRADHierarchyData) over one LoD page. */
function radPage(lod: SplatLod, page: { rowStart: number; rowCount: number }) {
	const { rowStart: a, rowCount: n } = page;
	return {
		id: `p${a}`,
		data: {
			length: n,
			byteLength: n * 64,
			destroyed: false,
			destroy() {},
			sourceBatchIndex: a / n,
			rowIndexBase: a,
			revision: 0,
			source: {
				positions: lod.positions.subarray(3 * a, 3 * (a + n)),
				scales: lod.scales.subarray(3 * a, 3 * (a + n)),
				opacities: lod.opacities.subarray(a, a + n),
			},
		},
		childCounts: lod.childCounts.subarray(a, a + n),
		childStarts: lod.childStarts.subarray(a, a + n),
	};
}

describe("buildSplatLod", () => {
	it("lays out a breadth-first tree whose leaves are the cloud's splats, once each", () => {
		const cloud = randomCloud(1000);
		const lod = buildSplatLod(cloud);
		expect(lod.leafCount).toBe(1000);
		const seen = new Uint8Array(1000);
		let interior = 0;
		for (let r = 0; r < lod.rowCount; r++) {
			const leaf = lod.leafIndex[r];
			if (leaf >= 0) {
				expect(lod.childCounts[r]).toBe(0);
				seen[leaf]++;
				continue;
			}
			interior++;
			const count = lod.childCounts[r];
			expect(count).toBeGreaterThan(1);
			expect(count).toBeLessThanOrEqual(SPLAT_LOD_BRANCHING);
			// children come after their parent, contiguous
			expect(lod.childStarts[r]).toBeGreaterThan(r);
			expect(lod.childStarts[r] + count).toBeLessThanOrEqual(lod.rowCount);
		}
		expect([...seen].every((v) => v === 1)).toBe(true);
		expect(lod.rowCount).toBe(1000 + interior);
		// every row but the root is somebody's child exactly once
		const parentOf = new Int32Array(lod.rowCount).fill(-1);
		for (let r = 0; r < lod.rowCount; r++)
			for (let c = 0; c < lod.childCounts[r]; c++) {
				const child = lod.childStarts[r] + c;
				expect(parentOf[child]).toBe(-1);
				parentOf[child] = r;
			}
		expect(parentOf.filter((p) => p < 0).length).toBe(1);
		expect(parentOf[0]).toBe(-1);
		expect(lod.depth).toBeGreaterThanOrEqual(4);
		expect(lod.pages).toEqual([{ rowStart: 0, rowCount: lod.rowCount }]);
	});

	it("keeps leaf values bit for bit", () => {
		const cloud = randomCloud(300, 3);
		const lod = buildSplatLod(cloud);
		for (let r = 0; r < lod.rowCount; r++) {
			const i = lod.leafIndex[r];
			if (i < 0) continue;
			expect([...lod.positions.subarray(3 * r, 3 * r + 3)]).toEqual([
				...cloud.positions.subarray(3 * i, 3 * i + 3),
			]);
			expect([...lod.rotations.subarray(4 * r, 4 * r + 4)]).toEqual([
				...cloud.rotations.subarray(4 * i, 4 * i + 4),
			]);
			expect([...lod.colors.subarray(4 * r, 4 * r + 4)]).toEqual([
				...cloud.colors.subarray(4 * i, 4 * i + 4),
			]);
			expect(lod.opacities[r]).toBeCloseTo(cloud.colors[4 * i + 3] / 255, 6);
			expect(lod.provenance[r]).toBe(cloud.provenance[i]);
		}
	});

	it("merges children into a parent that covers them (mean inside the children, variance at least the smallest child's)", () => {
		const lod = buildSplatLod(randomCloud(2000, 11));
		for (let r = 0; r < lod.rowCount; r++) {
			const count = lod.childCounts[r];
			if (!count) continue;
			const first = lod.childStarts[r];
			for (let k = 0; k < 3; k++) {
				let lo = Infinity;
				let hi = -Infinity;
				for (let c = first; c < first + count; c++) {
					lo = Math.min(lo, lod.positions[3 * c + k]);
					hi = Math.max(hi, lod.positions[3 * c + k]);
				}
				expect(lod.positions[3 * r + k]).toBeGreaterThanOrEqual(lo - 1e-4);
				expect(lod.positions[3 * r + k]).toBeLessThanOrEqual(hi + 1e-4);
			}
			// moment matching adds the spread of the means to the (weighted) children's own
			// covariance, so the parent's total variance is at least the smallest child's
			const trace = (row: number) =>
				lod.scales[3 * row] ** 2 +
				lod.scales[3 * row + 1] ** 2 +
				lod.scales[3 * row + 2] ** 2;
			let smallest = Infinity;
			for (let c = first; c < first + count; c++)
				smallest = Math.min(smallest, trace(c));
			expect(trace(r)).toBeGreaterThanOrEqual(smallest * 0.999);
			expect(lod.opacities[r]).toBeGreaterThan(0);
			expect(lod.opacities[r]).toBeLessThanOrEqual(1);
		}
	});

	it("stores a parent covariance its scales and rotation reproduce", () => {
		const cloud = randomCloud(64, 5);
		const lod = buildSplatLod(cloud);
		// root of 64 splats: recompute the moment-matched covariance from the leaves directly
		const W: number[] = [];
		let w = 0;
		const mu = [0, 0, 0];
		for (let i = 0; i < 64; i++) {
			const s = cloud.scales.subarray(3 * i, 3 * i + 3);
			const wi =
				(cloud.colors[4 * i + 3] / 255) *
				(s[0] * s[1] + s[1] * s[2] + s[2] * s[0]);
			W.push(wi);
			w += wi;
			for (let k = 0; k < 3; k++) mu[k] += wi * cloud.positions[3 * i + k];
		}
		for (let k = 0; k < 3; k++) mu[k] /= w;
		const leafRow = new Int32Array(64);
		for (let r = 0; r < lod.rowCount; r++)
			if (lod.leafIndex[r] >= 0) leafRow[lod.leafIndex[r]] = r;
		const expected = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		];
		for (let i = 0; i < 64; i++) {
			const ci = covariance(lod, leafRow[i]);
			const d = [0, 1, 2].map((k) => cloud.positions[3 * i + k] - mu[k]);
			for (let a = 0; a < 3; a++)
				for (let b = 0; b < 3; b++)
					expected[a][b] += (W[i] * (ci[a][b] + d[a] * d[b])) / w;
		}
		const got = covariance(lod, 0);
		for (let a = 0; a < 3; a++)
			for (let b = 0; b < 3; b++)
				expect(got[a][b]).toBeCloseTo(expected[a][b], 4);
		for (let k = 0; k < 3; k++) expect(lod.positions[k]).toBeCloseTo(mu[k], 4);
	});

	it("handles one splat, a handful, and pages", () => {
		expect(buildSplatLod(randomCloud(1)).rowCount).toBe(1);
		const few = buildSplatLod(randomCloud(5));
		expect(few.rowCount).toBe(6);
		expect(few.childCounts[0]).toBe(5);
		expect(few.childStarts[0]).toBe(1);
		const paged = buildSplatLod(randomCloud(500), { pageSize: 128 });
		expect(paged.pages.reduce((s, p) => s + p.rowCount, 0)).toBe(
			paged.rowCount,
		);
		expect(paged.pages.every((p, i) => p.rowStart === i * 128)).toBe(true);
	});

	it("symmetricEigen3 returns a proper rotation and the eigenvalues", () => {
		const out = new Float64Array(12);
		symmetricEigen3([4, 1, 0.5, 3, 0.2, 2], 0, out);
		const v = (c: number) => [out[3 + 3 * c], out[4 + 3 * c], out[5 + 3 * c]];
		const A = [
			[4, 1, 0.5],
			[1, 3, 0.2],
			[0.5, 0.2, 2],
		];
		for (let c = 0; c < 3; c++) {
			const e = v(c);
			for (let i = 0; i < 3; i++) {
				const Av = A[i][0] * e[0] + A[i][1] * e[1] + A[i][2] * e[2];
				expect(Av).toBeCloseTo(out[c] * e[i], 9);
			}
		}
		const [a, b, c] = [v(0), v(1), v(2)];
		const det =
			a[0] * (b[1] * c[2] - b[2] * c[1]) -
			b[0] * (a[1] * c[2] - a[2] * c[1]) +
			c[0] * (a[1] * b[2] - a[2] * b[1]);
		expect(det).toBeCloseTo(1, 9);
	});

	it("tints colours toward the provenance tint and keeps alpha", () => {
		const lod = buildSplatLod(randomCloud(50));
		const tints = [
			[1, 0, 0, 0.5],
			[0, 1, 0, 0.5],
			[0, 0, 1, 0.5],
			[1, 1, 1, 1],
		];
		const out = tintedLodColors(lod, tints);
		for (let r = 0; r < lod.rowCount; r++) {
			const t = tints[lod.provenance[r]];
			for (let k = 0; k < 3; k++)
				expect(out[4 * r + k]).toBeCloseTo(
					lod.colors[4 * r + k] * (1 - t[3]) + t[k] * t[3] * 255,
					-0.5,
				);
			expect(out[4 * r + 3]).toBe(lod.colors[4 * r + 3]);
		}
	});
});

describe("luma SplatRADHierarchyManager over the LoD tree (CPU metadata, no GPU)", () => {
	const lod = buildSplatLod(randomCloud(4000, 21), { pageSize: 2048 });
	const select = (eye: [number, number, number], maxError: number) => {
		const manager = new SplatRADHierarchyManager({
			pages: lod.pages.map((p) => radPage(lod, p)) as never,
			pageSize: 2048,
			maximumScreenSpaceError: maxError,
			frustumCulling: false,
		});
		const frontier = manager.selectView({
			cameraPosition: eye,
			viewportSize: [1280, 720],
			verticalFieldOfView: Math.PI / 3,
		});
		const rows = frontier.reduce((s, e) => s + e.activeRows.length, 0);
		const stats = manager.stats;
		manager.destroy();
		return { frontier, rows, stats };
	};

	it("selects every leaf when the error limit is tiny", () => {
		const { rows, frontier } = select([0, 0, 2], 1e-6);
		expect(rows).toBe(lod.leafCount);
		for (const e of frontier)
			for (const local of e.activeRows) {
				const r = e.data.rowIndexBase + local;
				expect(lod.leafIndex[r]).toBeGreaterThanOrEqual(0);
			}
	});

	it("selects a coarser cut from far away, covering every leaf once", () => {
		const near = select([0, 0, 2], 1);
		const far = select([0, -5000, 2], 1);
		expect(far.rows).toBeLessThan(near.rows);
		expect(far.rows).toBeGreaterThan(0);
		// the selected rows partition the leaves: every leaf has exactly one selected ancestor-or-self
		const parent = new Int32Array(lod.rowCount).fill(-1);
		for (let r = 0; r < lod.rowCount; r++)
			for (let c = 0; c < lod.childCounts[r]; c++)
				parent[lod.childStarts[r] + c] = r;
		const selected = new Uint8Array(lod.rowCount);
		for (const e of far.frontier)
			for (const local of e.activeRows)
				selected[e.data.rowIndexBase + local] = 1;
		for (let r = 0; r < lod.rowCount; r++) {
			if (lod.leafIndex[r] < 0) continue;
			let hits = 0;
			for (let a = r; a >= 0; a = parent[a]) hits += selected[a];
			expect(hits).toBe(1);
		}
	});
});
