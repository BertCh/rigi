// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { withFlags } from "#/test/helpers";

const db = vi.hoisted(() => ({
	regions: new Map<string, Record<string, unknown>>(),
}));
vi.mock("../store", () => ({
	putRegion: async (r: { id: string }) => void db.regions.set(r.id, r),
	getRegion: async (id: string) => db.regions.get(id) ?? null,
	deleteRegion: async (id: string) => void db.regions.delete(id),
	regionIds: async () => [...db.regions.keys()],
}));
const overpassMock = vi.hoisted(() => vi.fn());
vi.mock("../../overpass", () => ({ overpass: overpassMock }));

import {
	_resetRegionMemo,
	ABANDON_GRACE_MS,
	fetchRegion,
	fetchRegionTrails,
} from "../region";

// far from every bundled photo region, so the bundled-reuse path never applies
const LAT = -80;
const LON = 10;

const peaksReply = {
	elements: [
		{
			type: "node",
			id: 1,
			lat: -80,
			lon: 10,
			tags: { name: "Pk", ele: "1500" },
		},
	],
};
const waterReply = {
	elements: [
		{ type: "way", id: 2, tags: { name: "Lake A" } },
		{ type: "way", id: 3, tags: { name: "Lake A" } },
		{ type: "way", id: 4, tags: {} },
	],
};
const trailsReply = {
	elements: [
		{
			type: "way",
			id: 5,
			tags: { sac_scale: "hiking" },
			geometry: [
				{ lat: 1, lon: 2 },
				{ lat: 3, lon: 4 },
			],
		},
	],
};

function serveOverpass(
	over: { water?: () => unknown; peaks?: () => unknown } = {},
) {
	overpassMock.mockImplementation(async (q: string) => {
		if (q.includes('"peak|volcano"'))
			return (over.peaks ?? (() => peaksReply))();
		if (q.includes('"natural"="water"'))
			return (over.water ?? (() => waterReply))();
		return trailsReply;
	});
}

beforeEach(() => {
	db.regions.clear();
	overpassMock.mockReset();
	_resetRegionMemo();
});

describe("fetchRegion", () => {
	it("queries peaks and water, parses them and stores the region", async () => {
		serveOverpass();
		const stages: string[] = [];
		const r = await fetchRegion(LAT, LON, {
			onProgress: (s) => stages.push(s),
		});
		expect(r.id).toBe("local-region--80.00_10.00");
		expect(r.center).toEqual([-80, 10]);
		expect(r.peaks).toEqual([
			{ name: "Pk", lat: -80, lon: 10, ele: 1500, prominence: null },
		]);
		expect(r.waterNames).toEqual(["Lake A"]);
		expect(r.trails).toEqual([]);
		expect(stages).toEqual(["cache", "peaks", "water", "done"]);
		expect(db.regions.get(r.id)).toMatchObject({ id: r.id });
	});
	it("serves a second request from memory, and a fresh memo from the stored region", async () => {
		serveOverpass();
		await fetchRegion(LAT, LON);
		await fetchRegion(LAT, LON);
		expect(overpassMock).toHaveBeenCalledTimes(2); // peaks + water, once
		_resetRegionMemo();
		const infos: (string | undefined)[] = [];
		await fetchRegion(LAT, LON, {
			onProgress: (s, i) => s === "done" && infos.push(i),
		});
		expect(overpassMock).toHaveBeenCalledTimes(2);
		expect(infos).toEqual(["cache"]);
	});
	it("nearby photos in the same 0.05 degree cell share one fetch", async () => {
		serveOverpass();
		await Promise.all([
			fetchRegion(LAT, LON),
			fetchRegion(LAT + 0.01, LON + 0.01),
		]);
		expect(overpassMock).toHaveBeenCalledTimes(2);
	});
	it("force refetches even when cached", async () => {
		serveOverpass();
		await fetchRegion(LAT, LON);
		await fetchRegion(LAT, LON, { force: true });
		expect(overpassMock).toHaveBeenCalledTimes(4);
	});
	it("water failures degrade to no names", async () => {
		serveOverpass({
			water: () => {
				throw new Error("429");
			},
		});
		const r = await fetchRegion(LAT, LON);
		expect(r.waterNames).toEqual([]);
		expect(r.peaks).toHaveLength(1);
	});
	it("peak failures reject and are not memoised", async () => {
		serveOverpass({
			peaks: () => {
				throw new Error("overpass down");
			},
		});
		await expect(fetchRegion(LAT, LON)).rejects.toThrow("overpass down");
		serveOverpass();
		await expect(fetchRegion(LAT, LON)).resolves.toMatchObject({
			peaks: [expect.anything()],
		});
	});
	it("offline with an older partial region falls back to it with a warning", async () => {
		db.regions.set("local-region--80.00_10.00", {
			id: "local-region--80.00_10.00",
			center: [-80, 10],
			photos: ["p"],
			peaks: [],
			trails: [],
			waterNames: [],
			partial: true,
		});
		serveOverpass({
			peaks: () => {
				throw new Error("offline");
			},
		});
		const r = await fetchRegion(LAT, LON);
		expect(r.warnings?.[0]).toBe("using cached data: offline");
		expect(r.photos).toEqual(["p"]);
	});
	it("keeps the stored photo ids when refreshing a partial region", async () => {
		db.regions.set("local-region--80.00_10.00", {
			id: "local-region--80.00_10.00",
			center: [-80, 10],
			photos: ["p"],
			peaks: [],
			trails: [],
			waterNames: [],
			partial: true,
		});
		serveOverpass();
		const r = await fetchRegion(LAT, LON);
		expect(r.photos).toEqual(["p"]);
		expect(r.peaks).toHaveLength(1);
	});
	it("an already-aborted signal rejects without fetching", async () => {
		const ac = new AbortController();
		ac.abort(new Error("stop"));
		await expect(fetchRegion(LAT, LON, { signal: ac.signal })).rejects.toThrow(
			"stop",
		);
		expect(overpassMock).not.toHaveBeenCalled();
	});
	it("aborting one caller detaches only it; the shared fetch finishes for the other", async () => {
		let release: (v: unknown) => void = () => {};
		overpassMock.mockImplementation(async (q: string) => {
			if (q.includes('"peak|volcano"')) await new Promise((r) => (release = r));
			return q.includes('"peak|volcano"') ? peaksReply : waterReply;
		});
		const ac = new AbortController();
		const a = fetchRegion(LAT, LON, { signal: ac.signal });
		const b = fetchRegion(LAT, LON);
		ac.abort(new Error("gone"));
		await expect(a).rejects.toThrow("gone");
		release(null);
		await expect(b).resolves.toMatchObject({ peaks: [expect.anything()] });
	});
	it("aborts the shared fetch only after every caller left and the grace period passed", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		overpassMock.mockImplementation(
			(_q: string, o: { signal?: AbortSignal }) => {
				signal = o.signal;
				return new Promise(() => {});
			},
		);
		const ac = new AbortController();
		const p = fetchRegion(LAT, LON, { signal: ac.signal });
		p.catch(() => {});
		await vi.advanceTimersByTimeAsync(0);
		ac.abort(new Error("x"));
		await vi.advanceTimersByTimeAsync(ABANDON_GRACE_MS - 100);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(200);
		expect(signal?.aborted).toBe(true);
		vi.useRealTimers();
	});
	it("replays the last progress stage to a late joiner", async () => {
		serveOverpass();
		const first = fetchRegion(LAT, LON);
		const seen: string[] = [];
		const second = fetchRegion(LAT, LON, { onProgress: (s) => seen.push(s) });
		await Promise.all([first, second]);
		expect(seen[0]).toBeDefined();
		expect(seen.at(-1)).toBe("done");
	});
	it("adds compact lakes only with ?geoLakes=on", async () => {
		serveOverpass();
		expect(await fetchRegion(LAT, LON)).not.toHaveProperty("lakes");
		_resetRegionMemo();
		db.regions.clear();
		withFlags({ geoLakes: "on" });
		expect(await fetchRegion(LAT, LON)).toHaveProperty("lakes");
	});
});

describe("fetchRegionTrails", () => {
	it("is null for bundled regions", async () => {
		expect(await fetchRegionTrails("region-1")).toBeNull();
	});
	it("is empty for an unknown local region", async () => {
		expect(await fetchRegionTrails("local-region-none")).toEqual([]);
	});
	it("queries once, stores trails with trailsFetched, and reuses them", async () => {
		serveOverpass();
		const r = await fetchRegion(LAT, LON);
		const t = await fetchRegionTrails(r.id);
		expect(t).toEqual([
			{
				sac: "hiking",
				name: null,
				coords: [
					[2, 1],
					[4, 3],
				],
			},
		]);
		expect(db.regions.get(r.id)).toMatchObject({ trailsFetched: true });
		const calls = overpassMock.mock.calls.length;
		expect(await fetchRegionTrails(r.id)).toEqual(t);
		expect(overpassMock.mock.calls.length).toBe(calls);
	});
	it("does not memoise a failed query", async () => {
		serveOverpass();
		const r = await fetchRegion(-70, 20);
		overpassMock.mockRejectedValueOnce(new Error("busy"));
		await expect(fetchRegionTrails(r.id)).rejects.toThrow("busy");
		await Promise.resolve();
		serveOverpass();
		expect(await fetchRegionTrails(r.id)).toHaveLength(1);
	});
	it("returns the trails a region already holds without querying", async () => {
		db.regions.set("local-region-held", {
			id: "local-region-held",
			center: [1, 2],
			photos: [],
			peaks: [],
			trails: [
				{
					sac: null,
					name: "T",
					coords: [
						[0, 0],
						[1, 1],
					],
				},
			],
			waterNames: [],
		});
		expect(await fetchRegionTrails("local-region-held")).toHaveLength(1);
		expect(overpassMock).not.toHaveBeenCalled();
	});
});
