// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { LruIndex } from "../lru";

describe("LruIndex", () => {
	it("tracks bytes and size", () => {
		const l = new LruIndex(100);
		l.add("a", 10, "image/png", 1);
		l.add("b", 20, undefined, 2);
		expect(l.bytes).toBe(30);
		expect(l.size).toBe(2);
		expect(l.get("a")).toEqual({ size: 10, atime: 1, type: "image/png" });
		expect(l.get("b")?.type).toBe("application/octet-stream");
		expect(l.has("c")).toBe(false);
	});
	it("evicts the least recently used keys, oldest first, until under the cap", () => {
		const l = new LruIndex(25);
		expect(l.add("a", 10)).toEqual([]);
		expect(l.add("b", 10)).toEqual([]);
		expect(l.add("c", 10)).toEqual(["a"]);
		expect(l.keys()).toEqual(["b", "c"]);
		expect(l.bytes).toBe(20);
	});
	it("touch moves a key to most-recent so it survives eviction", () => {
		const l = new LruIndex(20);
		l.add("a", 10);
		l.add("b", 10);
		expect(l.touch("a", 99)).toBe(true);
		expect(l.get("a")?.atime).toBe(99);
		expect(l.add("c", 10)).toEqual(["b"]);
		expect(l.keys()).toEqual(["a", "c"]);
	});
	it("touch of an unknown key is false and changes nothing", () => {
		const l = new LruIndex(10);
		expect(l.touch("x")).toBe(false);
		expect(l.size).toBe(0);
	});
	it("replacing a key adjusts the byte total and recency", () => {
		const l = new LruIndex(100);
		l.add("a", 10);
		l.add("b", 10);
		l.add("a", 40);
		expect(l.bytes).toBe(50);
		expect(l.keys()).toEqual(["b", "a"]);
	});
	it("evicts everything including the new key when a single entry exceeds the cap", () => {
		const l = new LruIndex(10);
		l.add("a", 5);
		expect(l.add("big", 50)).toEqual(["a", "big"]);
		expect(l.size).toBe(0);
		expect(l.bytes).toBe(0);
	});
	it("remove returns whether it existed and frees bytes", () => {
		const l = new LruIndex(100);
		l.add("a", 10);
		expect(l.remove("a")).toBe(true);
		expect(l.remove("a")).toBe(false);
		expect(l.bytes).toBe(0);
	});
	it("evict can target a smaller cap without changing the configured one", () => {
		const l = new LruIndex(100);
		for (const k of ["a", "b", "c", "d"]) l.add(k, 10);
		expect(l.evict(25)).toEqual(["a", "b"]);
		expect(l.capBytes).toBe(100);
	});
	it("clear empties it", () => {
		const l = new LruIndex(100);
		l.add("a", 10);
		l.clear();
		expect([l.size, l.bytes]).toEqual([0, 0]);
	});
	it("round-trips through JSON in LRU order", () => {
		const l = new LruIndex(100);
		l.add("a", 10, "x/y", 5);
		l.add("b", 20, "x/z", 6);
		l.touch("a", 7);
		const snap = JSON.parse(JSON.stringify(l));
		expect(snap.version).toBe(1);
		const r = LruIndex.fromJSON(snap, 100);
		expect(r.keys()).toEqual(["b", "a"]);
		expect(r.bytes).toBe(30);
		expect(r.get("a")).toEqual({ size: 10, atime: 7, type: "x/y" });
	});
	it("fromJSON yields an empty index for malformed snapshots", () => {
		for (const bad of [
			null,
			undefined,
			3,
			"x",
			{},
			{ version: 2, entries: [] },
			{ version: 1 },
			{ version: 1, entries: "no" },
		])
			expect(LruIndex.fromJSON(bad, 10).size).toBe(0);
	});
	it("fromJSON skips bad rows but keeps good ones", () => {
		const r = LruIndex.fromJSON(
			{
				version: 1,
				entries: [
					["ok", 5, 1, "t"],
					[3, 5, 1, "t"],
					["neg", -1, 1, "t"],
					["nan", "x", 1, "t"],
					"junk",
					["lenient", "7", "bad", null],
				],
			},
			100,
		);
		expect(r.keys()).toEqual(["ok", "lenient"]);
		expect(r.bytes).toBe(12);
		expect(r.get("lenient")).toEqual({ size: 7, atime: 0, type: "" });
	});
	it("fromJSON does not evict by itself (the caller decides)", () => {
		const r = LruIndex.fromJSON(
			{
				version: 1,
				entries: [
					["a", 80, 0, ""],
					["b", 80, 0, ""],
				],
			},
			100,
		);
		expect(r.bytes).toBe(160);
		expect(r.evict()).toEqual(["a"]);
	});
});
