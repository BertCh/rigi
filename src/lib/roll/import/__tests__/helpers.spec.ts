// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPool } from "../pool";
import {
	loadProvenance,
	type PositionProvenance,
	provenanceFromEstimate,
	saveProvenance,
} from "../provenance";
import { reuseIfSame } from "../stable";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createPool", () => {
	it("runs at most `limit` tasks at once, in FIFO order", async () => {
		const pool = createPool(2);
		const started: number[] = [];
		const release: (() => void)[] = [];
		for (let i = 0; i < 5; i++)
			pool.push(
				() =>
					new Promise<void>((res) => {
						started.push(i);
						release.push(res);
					}),
			);
		expect(started).toEqual([0, 1]);
		expect(pool.pending).toBe(5);
		release[0]();
		await tick();
		expect(started).toEqual([0, 1, 2]);
		release[1]();
		release[2]();
		await tick();
		expect(started).toEqual([0, 1, 2, 3, 4]);
		release[3]();
		release[4]();
		await tick();
		expect(pool.pending).toBe(0);
	});

	it("keeps going after a task rejects", async () => {
		const pool = createPool(1);
		const ran: string[] = [];
		pool.push(async () => {
			ran.push("bad");
			throw new Error("x");
		});
		pool.push(async () => void ran.push("good"));
		await tick();
		await tick();
		expect(ran).toEqual(["bad", "good"]);
	});

	it("close drops queued tasks, lets running ones finish and ignores later pushes", async () => {
		const pool = createPool(1);
		const ran: string[] = [];
		let release = () => {};
		pool.push(
			() =>
				new Promise<void>((res) => {
					ran.push("first");
					release = res;
				}),
		);
		pool.push(async () => void ran.push("queued"));
		pool.close();
		expect(pool.pending).toBe(1);
		pool.push(async () => void ran.push("late"));
		release();
		await tick();
		expect(ran).toEqual(["first"]);
		expect(pool.pending).toBe(0);
	});
});

describe("reuseIfSame", () => {
	it("returns prev when every element is identical", () => {
		const prev = ["a", "b"];
		expect(reuseIfSame(prev, ["a", "b"])).toBe(prev);
	});
	it("returns next on length, element or null-prev difference", () => {
		const prev = ["a", "b"];
		const next = ["a", "c"];
		expect(reuseIfSame(prev, next)).toBe(next);
		const longer = ["a", "b", "c"];
		expect(reuseIfSame(prev, longer)).toBe(longer);
		const first = ["a"];
		expect(reuseIfSame(null, first)).toBe(first);
	});
	it("uses === so equal-looking objects are different", () => {
		const prev = [{ id: 1 }];
		const next = [{ id: 1 }];
		expect(reuseIfSame(prev, next)).toBe(next);
	});
});

function stubStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	return store;
}

describe("position provenance", () => {
	afterEach(() => vi.unstubAllGlobals());
	const p: PositionProvenance = {
		method: "interpolated",
		accuracyM: 40,
		from: ["a", "b"],
		gapS: 12,
		at: 1_700_000_000_000,
	};

	it("round-trips through localStorage, per photo id", () => {
		const store = stubStorage();
		saveProvenance("one", p);
		saveProvenance("two", { ...p, method: "pin" });
		expect(store.size).toBe(2);
		expect(loadProvenance("one")).toEqual(p);
		expect(loadProvenance("two")?.method).toBe("pin");
		expect(loadProvenance("three")).toBeNull();
	});
	it("null removes the record", () => {
		const store = stubStorage();
		saveProvenance("one", p);
		saveProvenance("one", null);
		expect(store.size).toBe(0);
		expect(loadProvenance("one")).toBeNull();
	});
	it("degrades quietly with no storage or corrupt JSON", () => {
		expect(loadProvenance("x")).toBeNull();
		expect(() => saveProvenance("x", p)).not.toThrow();
		const store = stubStorage();
		saveProvenance("bad", p);
		for (const k of store.keys()) store.set(k, "{not json");
		expect(loadProvenance("bad")).toBeNull();
	});
	it("provenanceFromEstimate copies the estimate and stamps the time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(5000);
		const r = provenanceFromEstimate({
			lat: 1,
			lon: 2,
			method: "nearest",
			accuracyM: 30,
			from: ["k"],
			gapS: 7,
		});
		vi.useRealTimers();
		expect(r).toEqual({
			method: "nearest",
			accuracyM: 30,
			from: ["k"],
			gapS: 7,
			at: 5000,
		});
	});
});
