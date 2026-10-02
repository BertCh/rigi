// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	buildFrameTimings,
	QueryRing,
	RollingFrameMean,
} from "../frame-timings-core";

const makeRing = (size = 2, maxPasses = 3) => {
	const log = { created: 0, destroyed: [] as number[] };
	const ring = new QueryRing<number>(
		() => log.created++,
		(q) => log.destroyed.push(q),
		{ size, maxPasses },
	);
	return { ring, log };
};

describe("QueryRing", () => {
	it("creates up to size sets then drops frames", () => {
		const { ring } = makeRing(2);
		const a = ring.begin(1);
		const b = ring.begin(2);
		expect(a && b).toBeTruthy();
		expect(ring.begin(3)).toBeNull();
		expect(ring.inFlight).toBe(2);
	});
	it("reuses a released set", () => {
		const { ring, log } = makeRing(1);
		const a = ring.begin(1);
		if (!a) throw new Error("no lease");
		ring.release(a);
		const b = ring.begin(2);
		expect(b?.querySet).toBe(a.querySet);
		expect(log.created).toBe(1);
	});
	it("assigns two timestamp slots per pass and overflows past the cap", () => {
		const { ring } = makeRing(1, 2);
		const lease = ring.begin(1);
		if (!lease) throw new Error("no lease");
		expect(ring.nextPass(lease, "a")).toMatchObject({
			beginIndex: 0,
			endIndex: 1,
		});
		expect(ring.nextPass(lease, "b")).toMatchObject({
			beginIndex: 2,
			endIndex: 3,
		});
		expect(ring.nextPass(lease, "c")).toBeNull();
		expect(lease.overflowed).toBe(true);
		expect(ring.nextPass(lease, "d")).toBeNull();
		expect(lease.passNames).toEqual(["a", "b"]);
	});
	it("discard destroys and frees a creation slot", () => {
		const { ring, log } = makeRing(1);
		const a = ring.begin(1);
		if (!a) throw new Error("no lease");
		ring.discard(a);
		expect(log.destroyed).toEqual([a.querySet]);
		expect(ring.begin(2)).not.toBeNull();
		expect(log.created).toBe(2);
	});
	it("destroyAll destroys only free sets", () => {
		const { ring, log } = makeRing(2);
		const a = ring.begin(1);
		ring.begin(2);
		if (a) ring.release(a);
		ring.destroyAll();
		expect(log.destroyed).toEqual([a?.querySet]);
	});
});

describe("buildFrameTimings", () => {
	it("zeroes non-finite and negative durations and sums the rest", () => {
		const t = buildFrameTimings({ frame: 9, passNames: ["a", "b", "c", "d"] }, [
			1.5,
			-2,
			Number.NaN,
			2,
		]);
		expect(t.passes.map((p) => p.gpuMs)).toEqual([1.5, 0, 0, 2]);
		expect(t.totalGpuMs).toBe(3.5);
		expect(t.frame).toBe(9);
	});
	it("treats missing durations as 0", () => {
		expect(
			buildFrameTimings({ frame: 0, passNames: ["a"] }, []).totalGpuMs,
		).toBe(0);
	});
});

describe("RollingFrameMean", () => {
	const frame = (passes: [string, number][]) =>
		buildFrameTimings(
			{ frame: 0, passNames: passes.map((p) => p[0]) },
			passes.map((p) => p[1]),
		);
	it("averages per pass and total", () => {
		const m = new RollingFrameMean();
		m.add(
			frame([
				["a", 2],
				["b", 4],
			]),
		);
		m.add(frame([["a", 4]]));
		const r = m.mean();
		expect(r.frames).toBe(2);
		expect(r.totalGpuMs).toBe(5);
		expect(r.passes).toEqual([
			{ name: "a", gpuMs: 3 },
			{ name: "b", gpuMs: 4 },
		]);
	});
	it("sums a repeated pass name within a frame as one sample", () => {
		const m = new RollingFrameMean();
		m.add(
			frame([
				["a", 1],
				["a", 2],
			]),
		);
		expect(m.mean().passes).toEqual([{ name: "a", gpuMs: 3 }]);
	});
	it("keeps only the last window frames and resets", () => {
		const m = new RollingFrameMean(2);
		for (const v of [100, 2, 4]) m.add(frame([["a", v]]));
		expect(m.mean().totalGpuMs).toBe(3);
		m.reset();
		expect(m.mean()).toEqual({ passes: [], totalGpuMs: 0, frames: 0 });
	});
});
