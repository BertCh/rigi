// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "#/lib/ontology/core/storage";

type Mod = typeof import("../photos");
let P: Mod;

const meta = (id: string, over: Record<string, unknown> = {}) =>
	({
		id,
		src: `blob:${id}`,
		width: 100,
		height: 50,
		takenAt: "2023-07-01T10:00:00Z",
		lat: 47,
		lon: 8,
		alt: null,
		hAccuracy: null,
		heading: null,
		f35: 26,
		vfov: 50,
		gravity: null,
		pitch: 0,
		roll: 0,
		holding: null,
		region: "r-local",
		...over,
	}) as never;

const region = (id: string) =>
	({
		id,
		center: [47, 8],
		photos: [],
		peaks: [],
		trails: [],
		waterNames: [],
	}) as never;

beforeEach(async () => {
	vi.resetModules();
	localStorage.clear();
	P = await import("../photos");
});

describe("local photos", () => {
	it("registers a photo so getPhoto finds it, and lists it", () => {
		expect(P.getPhoto("local-1")).toBeUndefined();
		P.registerLocalPhoto(meta("local-1"), null);
		expect(P.getPhoto("local-1")?.src).toBe("blob:local-1");
		expect(P.listLocalPhotos().map((p) => p.id)).toEqual(["local-1"]);
	});
	it("re-registering replaces rather than duplicates", () => {
		P.registerLocalPhoto(meta("local-1"), null);
		P.registerLocalPhoto(meta("local-1", { width: 200 }), null);
		expect(P.listLocalPhotos()).toHaveLength(1);
		expect(P.getPhoto("local-1")?.width).toBe(200);
	});
	it("seeds the region so loadRegion never touches the network", async () => {
		const f = vi.fn();
		vi.stubGlobal("fetch", f);
		const r = region("r-local");
		P.registerLocalPhoto(meta("local-2"), r);
		expect(await P.loadRegion("r-local")).toBe(r);
		expect(f).not.toHaveBeenCalled();
	});
	it("returns undefined for an unknown id", () => {
		expect(P.getPhoto("nope")).toBeUndefined();
	});
});

describe("loadRegion", () => {
	it("fetches /photos/<id>.json once and caches the promise", async () => {
		const f = vi.fn(
			async () =>
				new Response(JSON.stringify(region("region-0")), { status: 200 }),
		);
		vi.stubGlobal("fetch", f);
		const [a, b] = await Promise.all([
			P.loadRegion("region-0"),
			P.loadRegion("region-0"),
		]);
		expect(a).toEqual(b);
		expect(f).toHaveBeenCalledTimes(1);
		expect(f).toHaveBeenCalledWith("/photos/region-0.json");
		await P.loadRegion("region-0");
		expect(f).toHaveBeenCalledTimes(1);
	});
	it("rejects on HTTP errors with the status and does not cache the failure", async () => {
		const f = vi
			.fn()
			.mockResolvedValueOnce(new Response("no", { status: 404 }))
			.mockResolvedValueOnce(
				new Response(JSON.stringify(region("region-9")), { status: 200 }),
			);
		vi.stubGlobal("fetch", f);
		await expect(P.loadRegion("region-9")).rejects.toThrow(
			"region region-9: HTTP 404",
		);
		await Promise.resolve();
		expect((await P.loadRegion("region-9")) as { id: string }).toMatchObject({
			id: "region-9",
		});
		expect(f).toHaveBeenCalledTimes(2);
	});
});

describe("saved pose", () => {
	const key = storageKey("savedPose", "p1");
	const good = { yaw: 10, pitch: -2, roll: 0.5, vfov: 50 };
	it("round-trips through localStorage", () => {
		P.savePose("p1", good);
		expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(good);
		expect(P.loadSavedPose("p1")).toEqual(good);
	});
	it("savePose(null) removes the entry", () => {
		P.savePose("p1", good);
		P.savePose("p1", null);
		expect(localStorage.getItem(key)).toBeNull();
		expect(P.loadSavedPose("p1")).toBeNull();
	});
	it("keeps poses of different photos apart", () => {
		P.savePose("p1", good);
		expect(P.loadSavedPose("p2")).toBeNull();
	});
	it.each([
		[
			"null fields (unlabelled ground truth)",
			{ yaw: null, pitch: null, roll: null, vfov: 180 },
		],
		["vfov 180", { ...good, vfov: 180 }],
		["vfov 0", { ...good, vfov: 0 }],
		["negative vfov", { ...good, vfov: -5 }],
		["NaN angle as null", { ...good, yaw: null }],
		["a missing field", { yaw: 1, pitch: 2, roll: 3 }],
		["string angles", { yaw: "1", pitch: 2, roll: 3, vfov: 40 }],
	])("ignores %s", (_n, v) => {
		localStorage.setItem(key, JSON.stringify(v));
		expect(P.loadSavedPose("p1")).toBeNull();
	});
	it("ignores corrupt JSON and the literal null", () => {
		localStorage.setItem(key, "{not json");
		expect(P.loadSavedPose("p1")).toBeNull();
		localStorage.setItem(key, "null");
		expect(P.loadSavedPose("p1")).toBeNull();
	});
	it("never throws when storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		expect(P.loadSavedPose("p1")).toBeNull();
		expect(() => P.savePose("p1", good)).not.toThrow();
	});
});

describe("formatTakenAt", () => {
	const fmt = (takenAt: string, tzOffset?: string | null) =>
		P.formatTakenAt(meta("x", { takenAt, tzOffset }));
	it("renders in the photo's own local time, not the viewer's", () => {
		const utc = fmt("2023-07-01T10:00:00Z", null);
		const plus2 = fmt("2023-07-01T10:00:00Z", "+02:00");
		expect(utc).toMatch(/10:00/);
		expect(plus2).toMatch(/12:00/);
	});
	it("handles negative and half-hour offsets and day rollover", () => {
		expect(fmt("2023-07-01T10:00:00Z", "-07:00")).toMatch(/3:00/);
		expect(fmt("2023-07-01T10:00:00Z", "+05:30")).toMatch(/3:30/);
		expect(fmt("2023-07-01T23:00:00Z", "+02:00")).toMatch(
			/Jul 2, 2023|2 Jul 2023|02\.07\.2023|2023/,
		);
	});
	it("treats a malformed offset as UTC", () => {
		expect(fmt("2023-07-01T10:00:00Z", "CEST")).toBe(
			fmt("2023-07-01T10:00:00Z", null),
		);
	});
});

describe("regionNames", () => {
	it("names region-0 to region-7", () => {
		for (let i = 0; i < 8; i++)
			expect(P.regionNames[`region-${i}`]).toBeTruthy();
	});
});
