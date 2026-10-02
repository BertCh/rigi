// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type ImageryTier, planImageryOverflow } from "../atlas-layout";

const w = (id: string, distance?: number, tier: ImageryTier = 512) => ({
	id,
	tier,
	distance,
});
const none = new Map<string, ImageryTier>();

describe("planImageryOverflow", () => {
	it("admits everything that fits, evicts nothing", () => {
		const p = planImageryOverflow([w("a", 3), w("b", 1)], none, 4);
		expect([...p.admit].sort()).toEqual(["a", "b"]);
		expect(p.evict).toEqual([]);
		expect(p.overflow).toEqual([]);
	});

	it("keeps the nearest and evicts a far resident for a near newcomer", () => {
		const resident = new Map<string, ImageryTier>([
			["far", 512],
			["mid", 512],
		]);
		const p = planImageryOverflow(
			[w("far", 9), w("mid", 5), w("near", 1)],
			resident,
			2,
		);
		expect([...p.admit].sort()).toEqual(["mid", "near"]);
		expect(p.evict).toEqual(["far"]);
		expect(p.overflow).toEqual(["far"]);
	});

	it("breaks distance ties by residency, then id", () => {
		const resident = new Map<string, ImageryTier>([["z", 512]]);
		const p = planImageryOverflow([w("a", 2), w("z", 2)], resident, 1);
		expect([...p.admit]).toEqual(["z"]);
		const q = planImageryOverflow([w("b", 2), w("a", 2)], none, 1);
		expect([...q.admit]).toEqual(["a"]);
	});

	it("treats a missing distance as +Infinity, behind any measured tile", () => {
		const p = planImageryOverflow([w("plain"), w("measured", 100)], none, 1);
		expect([...p.admit]).toEqual(["measured"]);
		expect(p.overflow).toEqual(["plain"]);
	});

	it("budgets each tier separately", () => {
		const wanted = [
			w("s1", 1, 256),
			w("s2", 2, 256),
			w("b1", 3, 512),
			w("b2", 4, 512),
		];
		const p = planImageryOverflow(wanted, none, 1);
		expect([...p.admit].sort()).toEqual(["b1", "s1"]);
		expect(p.overflow.sort()).toEqual(["b2", "s2"]);
	});

	it("does not churn: applying the plan and re-planning changes nothing", () => {
		const wanted = Array.from({ length: 12 }, (_, i) => w(`t${i}`, i % 3));
		const first = planImageryOverflow(wanted, none, 5);
		const resident = new Map<string, ImageryTier>(
			[...first.admit].map((id) => [id, 512]),
		);
		const again = planImageryOverflow(wanted, resident, 5);
		expect(again.evict).toEqual([]);
		expect([...again.admit].sort()).toEqual([...first.admit].sort());
	});

	it("budget 0 admits nothing and evicts every resident", () => {
		const p = planImageryOverflow(
			[w("a", 1), w("b", 2)],
			new Map<string, ImageryTier>([["a", 512]]),
			0,
		);
		expect(p.admit.size).toBe(0);
		expect(p.evict).toEqual(["a"]);
		expect(p.overflow.sort()).toEqual(["a", "b"]);
	});
});
