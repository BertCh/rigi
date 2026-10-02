// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { LOOK_DIMS } from "#/lib/gpu/palette";
import {
	defaultLookGroupCount,
	groupByLook,
	groupByLookCpu,
	similarLooks,
	similarLooksCpu,
} from "../lookGroups";

const rng = (seed: number) => () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

/** `perGroup` noisy members around each of `groups` well separated centres, interleaved. */
const clustered = (groups: number, perGroup: number, seed = 5) => {
	const r = rng(seed);
	const centres = Array.from({ length: groups }, (_, g) =>
		Float32Array.from(
			{ length: LOOK_DIMS },
			(_, d) => (d % groups === g ? 3 : 0) + r() * 0.1,
		),
	);
	const truth: number[] = [];
	const embeddings: Float32Array[] = [];
	for (let i = 0; i < perGroup; i++)
		for (let g = 0; g < groups; g++) {
			truth.push(g);
			embeddings.push(
				Float32Array.from(centres[g], (v) => v + (r() - 0.5) * 0.1),
			);
		}
	return { embeddings, truth, centres };
};

describe("defaultLookGroupCount", () => {
	it("clamps round(sqrt(n/2)) to 2..6 and to n", () => {
		expect(defaultLookGroupCount(1)).toBe(1);
		expect(defaultLookGroupCount(2)).toBe(2);
		expect(defaultLookGroupCount(8)).toBe(2);
		expect(defaultLookGroupCount(50)).toBe(5);
		expect(defaultLookGroupCount(1000)).toBe(6);
	});
});

describe("groupByLookCpu", () => {
	it("recovers clustered groups", () => {
		const { embeddings, truth } = clustered(3, 8);
		const result = groupByLookCpu(embeddings, 3);
		expect(result.groups).toHaveLength(3);
		for (const group of result.groups) {
			const labels = new Set(group.members.map((m) => truth[m]));
			expect(labels.size).toBe(1);
			expect(group.members).toHaveLength(8);
		}
		expect(result.backend).toBe("cpu");
	});
	it("orders each group most typical first, ties by photo index", () => {
		const { embeddings } = clustered(2, 6);
		const result = groupByLookCpu(embeddings, 2);
		for (const group of result.groups) {
			const distance = (m: number) =>
				embeddings[m].reduce((s, v, d) => s + (v - group.centroid[d]) ** 2, 0);
			for (let i = 1; i < group.members.length; i++)
				expect(distance(group.members[i])).toBeGreaterThanOrEqual(
					Math.fround(distance(group.members[i - 1])) - 1e-6,
				);
		}
		const twins = [
			new Float32Array(LOOK_DIMS),
			new Float32Array(LOOK_DIMS),
			new Float32Array(LOOK_DIMS),
		];
		const same = groupByLookCpu(twins, 1);
		expect(same.groups[0].members).toEqual([0, 1, 2]);
	});
	it("is deterministic and maps every photo to a group", () => {
		const { embeddings } = clustered(4, 5, 9);
		const a = groupByLookCpu(embeddings);
		const b = groupByLookCpu(embeddings);
		expect([...a.groupOfPhoto]).toEqual([...b.groupOfPhoto]);
		expect(a.groups.reduce((s, g) => s + g.members.length, 0)).toBe(
			embeddings.length,
		);
		a.groups.forEach((g, index) => {
			for (const m of g.members) expect(a.groupOfPhoto[m]).toBe(index);
		});
		// largest group first
		for (let i = 1; i < a.groups.length; i++)
			expect(a.groups[i - 1].members.length).toBeGreaterThanOrEqual(
				a.groups[i].members.length,
			);
	});
	it("handles 0 and 1 photo", () => {
		expect(groupByLookCpu([]).groups).toEqual([]);
		expect(
			groupByLookCpu([new Float32Array(LOOK_DIMS)]).groups[0].members,
		).toEqual([0]);
	});
});

describe("similarLooksCpu", () => {
	it("excludes the query and ranks its cluster first", () => {
		const { embeddings, truth } = clustered(3, 6);
		const similar = similarLooksCpu(embeddings, 4, 5);
		expect(similar).toHaveLength(5);
		expect(similar.some((s) => s.index === 4)).toBe(false);
		for (const s of similar) expect(truth[s.index]).toBe(truth[4]);
		for (let i = 1; i < similar.length; i++)
			expect(similar[i - 1].score).toBeGreaterThanOrEqual(similar[i].score);
	});
	it("orders equal scores by index and caps k at n - 1", () => {
		const same = Array.from({ length: 4 }, () =>
			Float32Array.from({ length: LOOK_DIMS }, () => 1),
		);
		expect(similarLooksCpu(same, 2, 10).map((s) => s.index)).toEqual([0, 1, 3]);
	});
});

describe("no-GPU wrappers", () => {
	it("fall back to the CPU twin without a compute device", async () => {
		const { embeddings } = clustered(2, 4);
		const grouped = await groupByLook(embeddings, 2);
		expect(grouped.backend).toBe("cpu");
		expect(grouped.groups).toHaveLength(2);
		expect(
			(await similarLooks(embeddings, 0, 3)).some((s) => s.index === 0),
		).toBe(false);
	});
});
