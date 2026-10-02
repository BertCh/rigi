// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { seededRandom } from "#/test/helpers";
import {
	DROPPED_KEY,
	gpuSplatOrderCpu,
	splatKeysF32,
	stableOrderByKey,
} from "../cpu";
import { SortBackendState } from "../fallback";

describe("splat sort CPU twin", () => {
	it("keys run 0 (far end) .. 65535 (nearest) over the kept depth range; behind-camera splats drop", () => {
		// depth = -(z + d): row picks z; camera looks down -z
		const pos = new Float32Array([
			0,
			0,
			-1,
			0,
			0,
			-3,
			0,
			0,
			-2,
			0,
			0,
			5,
			0,
			0,
			Number.NEGATIVE_INFINITY,
		]);
		const { keys, kept } = splatKeysF32(pos, 5, [0, 0, 1, 0]);
		expect(kept).toBe(3);
		expect(keys[3]).toBe(DROPPED_KEY);
		expect(keys[4]).toBe(DROPPED_KEY);
		expect(keys[1]).toBe(0);
		expect(keys[0]).toBe(65535);
		expect(keys[2]).toBeGreaterThan(0);
		expect(keys[2]).toBeLessThan(65535);
	});
	it("a degenerate span gives all-zero keys", () => {
		const pos = new Float32Array([0, 0, -2, 1, 1, -2]);
		expect(Array.from(splatKeysF32(pos, 2, [0, 0, 1, 0]).keys)).toEqual([0, 0]);
	});
	it("stableOrderByKey is a stable ascending sort with dropped last", () => {
		const rnd = seededRandom(3);
		const n = 500;
		const keys = new Uint32Array(n);
		for (let i = 0; i < n; i++)
			keys[i] = rnd() < 0.1 ? DROPPED_KEY : Math.floor(rnd() * 20);
		const order = stableOrderByKey(keys, n);
		const want = Array.from({ length: n }, (_, i) => i).sort(
			(a, b) => keys[a] - keys[b] || a - b,
		);
		expect(Array.from(order)).toEqual(want);
	});
	it("whole pipeline orders far-to-near for back-to-front blending", () => {
		const pos = new Float32Array([0, 0, -1, 0, 0, -5, 0, 0, -3]);
		const { order, kept } = gpuSplatOrderCpu(pos, 3, [0, 0, 1, 0]);
		expect(kept).toBe(3);
		// key = (maxD - depth): nearest (depth 1) has the largest key, so it sorts last
		expect(Array.from(order)).toEqual([1, 2, 0]);
	});
});

describe("SortBackendState", () => {
	it("fails over once, warns once, and is one-way", () => {
		const onSwitch = vi.fn();
		const warn = vi.fn();
		const s = new SortBackendState("gpu", onSwitch, warn);
		expect(s.fail("bad")).toBe(true);
		expect(s.fail("again")).toBe(false);
		expect(s.backend).toBe("worker");
		expect(s.reason).toBe("bad");
		expect(onSwitch).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	it("a worker-first state never switches", () => {
		const onSwitch = vi.fn();
		const s = new SortBackendState("worker", onSwitch, () => {});
		expect(s.fail("x")).toBe(false);
		expect(s.reason).toBeNull();
		expect(onSwitch).not.toHaveBeenCalled();
	});
	it("watch turns a rejection into a failure with the message", async () => {
		const s = new SortBackendState(
			"gpu",
			() => {},
			() => {},
		);
		s.watch(Promise.resolve(1), "ok");
		expect(s.backend).toBe("gpu");
		s.watch(Promise.reject(new Error("compile")), "pipeline");
		await new Promise((r) => setTimeout(r, 0));
		expect(s.reason).toBe("pipeline: compile");
		const t = new SortBackendState(
			"gpu",
			() => {},
			() => {},
		);
		t.watch(Promise.reject("str"), "scope");
		await new Promise((r) => setTimeout(r, 0));
		expect(t.reason).toBe("scope: str");
	});
});
