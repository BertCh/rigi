// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	byId,
	closestSheetIds,
	lineageOf,
	NODES,
	signpostKicker,
} from "../graph-utils";

describe("lineageOf", () => {
	it("excludes the sheet itself and stays inside the book", () => {
		for (const n of NODES.slice(0, 6)) {
			const { upstream, downstream } = lineageOf(n.id);
			expect(upstream.has(n.id)).toBe(false);
			expect(downstream.has(n.id)).toBe(false);
			for (const id of [...upstream, ...downstream])
				expect(byId.has(id)).toBe(true);
		}
	});
	it("is transitive along curated edges and consistent in both directions", () => {
		const source = NODES.find((n) => n.related.some((e) => byId.has(e.id)));
		expect(source).toBeDefined();
		const id = source?.id as string;
		const { downstream } = lineageOf(id);
		expect(downstream.size).toBeGreaterThan(0);
		for (const d of downstream)
			expect(lineageOf(d).upstream.has(id)).toBe(true);
	});
	it("returns empty sets for an unknown id", () => {
		const { upstream, downstream } = lineageOf("no-such-sheet");
		expect(upstream.size + downstream.size).toBe(0);
	});
});

describe("closestSheetIds", () => {
	const some = NODES[0].id;
	it("finds a sheet by a partial id", () => {
		expect(closestSheetIds(some.slice(0, 6))).toContain(some);
	});
	it("finds a sheet by a one-letter typo", () => {
		expect(closestSheetIds(`${some}x`)).toContain(some);
	});
	it("returns at most the limit, and nothing for noise or empty input", () => {
		expect(closestSheetIds("e", 3).length).toBeLessThanOrEqual(3);
		expect(closestSheetIds("")).toEqual([]);
		expect(closestSheetIds("zzzzzzzzzzzzzzzzzzzzzzzz")).toEqual([]);
	});
});

describe("signpostKicker", () => {
	it("names the chapter only when it changes", () => {
		expect(signpostKicker("next", "I", "I")).toBe("Weiter");
		expect(signpostKicker("next", "I", "II")).toBe("Weiter · Kapitel II");
		expect(signpostKicker("prev", "II", "I")).toBe("Zurück · Kapitel I");
		expect(signpostKicker("prev", undefined, undefined)).toBe("Zurück");
	});
});
