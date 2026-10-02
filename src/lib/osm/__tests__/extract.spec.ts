// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	EXTRACT_FORMAT,
	type ExtractNode,
	extractCovering,
	extractManifest,
	namedPeaksInBBox,
	type OsmExtract,
	parseBBox,
	peaksAround,
	type SWNE,
	setExtractLoader,
} from "../extract";

const idOf = (e: unknown) => (e as { id: number }).id;
const BBOX: SWNE = [46, 7, 47, 8];
const nodes: ExtractNode[] = [
	[1, 46.5, 7.5, { natural: "peak", name: "Alpha", ele: "2000" }],
	[2, 46.6, 7.6, { natural: "volcano", name: "Beta" }],
	[3, 46.7, 7.7, { natural: "peak" }], // unnamed
	[4, 46.8, 7.8, { natural: "saddle", name: "Col" }], // not a peak
	[5, 45.0, 7.5, { natural: "peak", name: "Outside" }], // outside bbox filter
];
const extract: OsmExtract = {
	format: EXTRACT_FORMAT,
	bbox: [44, 6, 48, 9],
	generated: "2026-01-01",
	licence: "ODbL",
	peaks: nodes,
};
const manifest = {
	extracts: [
		{
			file: "alps.json",
			bbox: extract.bbox,
			peaks: 5,
			bytes: 1,
			generated: "x",
		},
	],
};

let loads: string[];
function useLoader(files: Record<string, unknown>) {
	loads = [];
	setExtractLoader(async (f) => {
		loads.push(f);
		if (!(f in files)) throw new Error(`${f}: HTTP 404`);
		return files[f];
	});
}
beforeEach(() =>
	useLoader({ "extracts.json": manifest, "alps.json": extract }),
);

describe("parseBBox", () => {
	it("parses s,w,n,e", () => {
		expect(parseBBox("46.1,7.2,47.3,8.4")).toEqual([46.1, 7.2, 47.3, 8.4]);
		expect(parseBBox(" 1, 2 ,3,4")).toEqual([1, 2, 3, 4]);
	});
	it("rejects wrong arity and non-finite parts", () => {
		expect(() => parseBBox("1,2,3")).toThrow(/bad bbox/);
		expect(() => parseBBox("1,2,3,x")).toThrow(/bad bbox/);
		expect(() => parseBBox("1,2,3,Infinity")).toThrow(/bad bbox/);
	});
});

describe("extractManifest", () => {
	it("lists entries and caches the result", async () => {
		expect(await extractManifest()).toHaveLength(1);
		await extractManifest();
		expect(loads.filter((f) => f === "extracts.json")).toHaveLength(1);
	});
	it("is empty (and retried) when the manifest is missing", async () => {
		useLoader({});
		expect(await extractManifest()).toEqual([]);
		useLoader({ "extracts.json": manifest });
		setExtractLoader(async () => manifest);
		expect(await extractManifest()).toHaveLength(1);
	});
	it("tolerates a manifest without an extracts array", async () => {
		useLoader({ "extracts.json": {} });
		expect(await extractManifest()).toEqual([]);
	});
});

describe("extractCovering", () => {
	it("returns the extract that fully contains the bbox", async () => {
		expect((await extractCovering(BBOX))?.format).toBe(EXTRACT_FORMAT);
	});
	it("returns null when no extract covers it (partial overlap included)", async () => {
		expect(await extractCovering([40, 7, 47, 8])).toBeNull();
		expect(await extractCovering([46, 5, 47, 8])).toBeNull();
	});
	it("accepts a bbox equal to the extract's (inclusive containment)", async () => {
		expect(await extractCovering(extract.bbox)).not.toBeNull();
	});
	it("loads each file once", async () => {
		await extractCovering(BBOX);
		await extractCovering(BBOX);
		expect(loads.filter((f) => f === "alps.json")).toHaveLength(1);
	});
	it("rejects files with a wrong format tag or without peaks", async () => {
		useLoader({
			"extracts.json": manifest,
			"alps.json": { ...extract, format: "other/9" },
		});
		expect(await extractCovering(BBOX)).toBeNull();
		useLoader({
			"extracts.json": manifest,
			"alps.json": { ...extract, peaks: null },
		});
		expect(await extractCovering(BBOX)).toBeNull();
	});
	it("the file's own bbox is authoritative over a stale manifest", async () => {
		useLoader({
			"extracts.json": manifest,
			"alps.json": { ...extract, bbox: [46.2, 7.2, 46.8, 7.8] },
		});
		expect(await extractCovering(BBOX)).toBeNull();
	});
	it("a failing extract file gives null and is retried later", async () => {
		useLoader({ "extracts.json": manifest });
		expect(await extractCovering(BBOX)).toBeNull();
		await Promise.resolve();
		const spy = vi.fn(async (f: string) =>
			f === "extracts.json" ? manifest : extract,
		);
		setExtractLoader(spy);
		expect(await extractCovering(BBOX)).not.toBeNull();
	});
});

describe("namedPeaksInBBox", () => {
	it("returns named peaks/volcanoes in the box, in id order, as OSM elements", async () => {
		const r = await namedPeaksInBBox(BBOX);
		expect(r?.elements.map((e) => idOf(e))).toEqual([1, 2]);
		expect(r?.elements[0]).toEqual({
			type: "node",
			id: 1,
			lat: 46.5,
			lon: 7.5,
			tags: { natural: "peak", name: "Alpha", ele: "2000" },
		});
	});
	it("bbox edges are inclusive", async () => {
		const r = await namedPeaksInBBox([46.5, 7.5, 46.5, 7.5]);
		expect(r?.elements).toHaveLength(1);
	});
	it("returns copies of the tags (callers may mutate)", async () => {
		const r = await namedPeaksInBBox(BBOX);
		(r?.elements[0].tags as Record<string, string>).name = "changed";
		expect(nodes[0][3].name).toBe("Alpha");
	});
	it("is null outside every extract", async () => {
		expect(await namedPeaksInBBox([10, 10, 11, 11])).toBeNull();
	});
});

describe("peaksAround", () => {
	it("keeps peaks inside the circle (spherical, Overpass radius) and drops others", async () => {
		// Alpha is the centre, Beta ~ 13.8 km away, Unnamed ~ 28 km away
		const near = await peaksAround(46.5, 7.5, 1000);
		expect(near?.elements.map((e) => idOf(e))).toEqual([1]);
		const mid = await peaksAround(46.5, 7.5, 30_000);
		expect(mid?.elements.map((e) => idOf(e))).toEqual([1, 2, 3]);
	});
	it("does not require a name but does require natural=peak|volcano", async () => {
		const r = await peaksAround(46.75, 7.75, 20_000);
		const ids = r?.elements.map((e) => idOf(e));
		expect(ids).toContain(3);
		expect(ids).not.toContain(4);
	});
	it("an Overpass-sphere circle: the rim is at the radius, not WGS84's", async () => {
		// 1 deg of latitude = 111.19 km on the 20,000 km half-circumference sphere
		const r = await peaksAround(46.5, 7.5, 111_100);
		const ids = r?.elements.map((e) => idOf(e));
		expect(ids).toContain(1);
		// node 5 is 1.5 deg south = 166.8 km: outside
		expect(ids).not.toContain(5);
	});
	it("is null when the circle's bbox leaves the extract", async () => {
		expect(await peaksAround(44.1, 7.5, 50_000)).toBeNull();
	});
});
