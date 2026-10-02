// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it } from "vitest";
import {
	adapterKey,
	mergeSpotLedger,
	planSpotCheck,
	recordSpotCheck,
	resetSpotLedger,
	SPOT_CHECKS,
	SPOT_FULL_FIRST,
	SPOT_LIGHT,
	spotKey,
	spotLedger,
	spotPolicyOptions,
} from "../spot-policy";

const dev = (renderer: string, features: string[] = []) =>
	({
		info: { type: "webgpu", renderer },
		features: new Set(features),
	}) as never;

beforeEach(() => {
	resetSpotLedger();
	spotPolicyOptions.mode = "ledger";
});

describe("spot keys", () => {
	it("depend on stage, source and adapter, not feature order", () => {
		const a = dev("x", ["b", "a"]);
		expect(adapterKey(a)).toBe(adapterKey(dev("x", ["a", "b"])));
		expect(adapterKey(a)).not.toBe(adapterKey(dev("y", ["a", "b"])));
		expect(spotKey(a, "s", "src1")).not.toBe(spotKey(a, "s", "src2"));
		expect(spotKey(a, "s", "src1")).not.toBe(spotKey(a, "t", "src1"));
		expect(spotKey(a, "s", "src1")).toBe(spotKey(a, "s", "src1"));
	});
});

describe("spot plan", () => {
	it("runs full checks first, then light ones with rare random full", () => {
		for (let i = 0; i < SPOT_FULL_FIRST; i++) {
			const p = planSpotCheck("k", () => 0.99);
			expect(p).toEqual({ count: SPOT_CHECKS, full: true });
			recordSpotCheck("k", p, 0);
		}
		expect(planSpotCheck("k", () => 0.99)).toEqual({
			count: SPOT_LIGHT,
			full: false,
		});
		expect(planSpotCheck("k", () => 0).full).toBe(true);
	});
	it("light checks do not advance the full count", () => {
		const light = { count: SPOT_LIGHT, full: false };
		recordSpotCheck("k", light, 0);
		expect(spotLedger().k.full).toBe(0);
	});
	it("full mode always runs the full check", () => {
		spotPolicyOptions.mode = "full";
		recordSpotCheck("k", { count: 1, full: true }, 0);
		for (let i = 0; i < 5; i++)
			recordSpotCheck("k", { count: 1, full: true }, 0);
		expect(planSpotCheck("k", () => 0.99).full).toBe(true);
	});
	it("a failure disables the key for good", () => {
		const p = planSpotCheck("k");
		recordSpotCheck("k", p, "mismatch at 3");
		expect(planSpotCheck("k")).toEqual({
			count: 0,
			full: false,
			disabled: "mismatch at 3",
		});
		recordSpotCheck("k", { count: 0, full: false, disabled: "x" }, 0);
		expect(planSpotCheck("k").disabled).toBe("mismatch at 3");
	});
});

describe("ledger merge", () => {
	it("takes max counts, keeps disabled, ignores junk", () => {
		recordSpotCheck("a", { count: 64, full: true }, 0);
		mergeSpotLedger({
			a: { full: 5 },
			b: { full: 1, disabled: "bad" },
			c: null as never,
			d: { full: "x" as never },
		});
		mergeSpotLedger(undefined);
		const l = spotLedger();
		expect(l.a.full).toBe(5);
		expect(l.b.disabled).toBe("bad");
		expect(l.c).toBeUndefined();
		expect(l.d).toBeUndefined();
		mergeSpotLedger({ b: { full: 0 } });
		expect(spotLedger().b.disabled).toBe("bad");
		// the copy is detached
		l.a.full = 99;
		expect(spotLedger().a.full).toBe(5);
	});
});
