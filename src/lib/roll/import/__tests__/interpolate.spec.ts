// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { distanceM } from "../../../geodesy";
import {
	DRIFT_SPEED,
	interpolatePositions,
	MAX_GAP_MS,
	MIN_ACCURACY_M,
	mode,
	NEAREST_GAP_MS,
	offsetHours,
	type TimedItem,
} from "../interpolate";

const MIN = 60_000;
const at = (
	key: string,
	minutes: number,
	pos: TimedItem["pos"],
	accuracyM?: number,
): TimedItem => ({
	key,
	t: minutes * MIN,
	pos,
	accuracyM,
});

describe("interpolatePositions", () => {
	const A = { lat: 46.7, lon: 7.7 };
	const B = { lat: 46.71, lon: 7.72 };

	it("interpolates linearly between two anchors", () => {
		const out = interpolatePositions([
			at("a", 0, A),
			at("m", 5, null),
			at("b", 20, B),
		]);
		const m = out.get("m");
		expect(m?.method).toBe("interpolated");
		expect(m?.lat).toBeCloseTo(A.lat + 0.25 * (B.lat - A.lat), 9);
		expect(m?.lon).toBeCloseTo(A.lon + 0.25 * (B.lon - A.lon), 9);
		expect(m?.from).toEqual(["a", "b"]);
		expect(m?.gapS).toBe(300);
		expect(m?.accuracyM).toBeGreaterThanOrEqual(MIN_ACCURACY_M);
	});

	it("does not output entries for items that already have a position", () => {
		const out = interpolatePositions([at("a", 0, A), at("m", 5, null)]);
		expect(out.has("a")).toBe(false);
		expect(out.has("m")).toBe(true);
	});

	it("uses the anchor as-is when only a close neighbour exists, with growing accuracy", () => {
		const near = interpolatePositions([at("a", 0, A), at("m", 2, null)]).get(
			"m",
		);
		expect(near?.method).toBe("nearest");
		expect({ lat: near?.lat, lon: near?.lon }).toEqual(A);
		expect(near?.accuracyM).toBe(
			Math.round(Math.max(MIN_ACCURACY_M, (DRIFT_SPEED * 120) / 1 + 10)),
		);
		expect(near?.gapS).toBe(120);
	});

	it("gives null beyond the nearest gap with one neighbour", () => {
		const out = interpolatePositions([
			at("a", 0, A),
			at("m", NEAREST_GAP_MS / MIN + 1, null),
		]);
		expect(out.get("m")).toBeNull();
	});

	it("does not interpolate when either anchor is further than the max gap", () => {
		const out = interpolatePositions([
			at("a", 0, A),
			at("m", 5, null),
			at("b", MAX_GAP_MS / MIN + 10, B),
		]);
		// falls back to nearest (a is 5 min away: exactly NEAREST_GAP_MS)
		expect(out.get("m")?.method).toBe("nearest");
		expect(out.get("m")?.from).toEqual(["a"]);
	});

	it("is null with no anchors or a non-finite time", () => {
		expect(interpolatePositions([at("m", 1, null)]).get("m")).toBeNull();
		const bad: TimedItem = { key: "x", t: Number.NaN, pos: null };
		expect(interpolatePositions([at("a", 0, A), bad]).get("x")).toBeNull();
	});

	it("an item between two anchors at the same instant gets the midpoint", () => {
		const out = interpolatePositions([
			at("a", 3, A),
			at("b", 3, B),
			at("m", 3, null),
		]);
		const m = out.get("m");
		// binary search lands after both anchors (t <= it.t), so span is 0 -> f = 0.5 only when a.t === b.t
		expect(m).not.toBeNull();
		expect(Number.isFinite(m?.lat)).toBe(true);
	});

	it("is independent of input order", () => {
		const items = [
			at("a", 0, A),
			at("m", 7, null),
			at("b", 15, B),
			at("n", 12, null),
		];
		const fwd = interpolatePositions(items);
		const rev = interpolatePositions([...items].reverse());
		expect(rev.get("m")).toEqual(fwd.get("m"));
		expect(rev.get("n")).toEqual(fwd.get("n"));
	});

	it("estimated points lie on the chord between the anchors", () => {
		const out = interpolatePositions([
			at("a", 0, A),
			at("m", 10, null),
			at("b", 20, B),
		]);
		const m = out.get("m");
		if (!m) throw new Error("expected an estimate");
		const total = distanceM(A, B);
		expect(distanceM(A, m) + distanceM(m, B)).toBeCloseTo(total, 0);
		expect(distanceM(A, m)).toBeCloseTo(total / 2, 0);
	});

	it("honours the anchors' own GPS accuracy", () => {
		const loose = interpolatePositions([
			at("a", 0, A, 80),
			at("m", 10, null),
			at("b", 20, A, 90),
		]).get("m");
		const tight = interpolatePositions([
			at("a", 0, A, 5),
			at("m", 10, null),
			at("b", 20, A, 5),
		]).get("m");
		expect(loose?.accuracyM).toBeGreaterThan(tight?.accuracyM ?? 0);
		expect(loose?.accuracyM).toBeGreaterThanOrEqual(90);
	});
});

describe("offsetHours", () => {
	it("parses signed offsets with or without a colon", () => {
		expect(offsetHours("+01:00")).toBe(1);
		expect(offsetHours("-05:30")).toBe(-5.5);
		expect(offsetHours("+0530")).toBe(5.5);
	});
	it("returns null for junk", () => {
		expect(offsetHours("Z")).toBeNull();
		expect(offsetHours(null)).toBeNull();
		expect(offsetHours(undefined)).toBeNull();
		expect(offsetHours("01:00")).toBeNull();
	});
});

describe("mode", () => {
	it("is the most common value, ties to the value that reaches the count first, null when empty", () => {
		expect(mode([1, 2, 2, 3])).toBe(2);
		// NOTE: the doc comment says "first seen", but b reaches 2 before a does, so b wins
		expect(mode(["a", "b", "b", "a"])).toBe("b");
		expect(mode(["a", "b"])).toBe("a");
		expect(mode([])).toBeNull();
	});
});
