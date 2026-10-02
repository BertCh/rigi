// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { EnuFrame } from "#/lib/geodesy";
import { type CameraX, IDENTITY_INTRINSICS } from "../../core";
import {
	enuToLv95Affine,
	eyeAltitudeOver,
	loadNearDsm,
	type NearDsm,
	nearHeightAt,
} from "../ndsm";
import {
	OCCL_RULE,
	objectHitRange,
	occludedBy,
	occluderRange,
} from "../occluder";
import {
	DSM_COLLECTION,
	type JsonFetcher,
	lv95ToWgs84,
	type RangeFetcher,
} from "../swiss-cog";
import { buildTiff } from "./tiff-fixture";

const BERN = { lat: 46.951082877, lon: 7.438632495 };

// ---- synthetic swisstopo world: gentle E slope, a 12 m "tree" block 80..100 m east of the origin
const dtmAt = (E: number, _N: number) => 500 + 0.02 * (E - 2600000);
const inTree = (E: number, N: number) =>
	E >= 2600080 && E <= 2600100 && N >= 1200000 && N <= 1200040;
const dsmAt = (E: number, N: number) => dtmAt(E, N) + (inTree(E, N) ? 12 : 0);

const tileBytes = (kind: "dsm" | "dtm", kx: number, ky: number) => {
	const px = kind === "dsm" ? 2 : 4;
	const n = 1000 / px;
	const v = new Float32Array(n * n);
	for (let r = 0; r < n; r++)
		for (let c = 0; c < n; c++) {
			const E = kx * 1000 + (c + 0.5) * px;
			const N = (ky + 1) * 1000 - (r + 0.5) * px;
			v[r * n + c] = kind === "dsm" ? dsmAt(E, N) : dtmAt(E, N);
		}
	return buildTiff({
		levels: [
			{
				width: n,
				height: n,
				tileW: 128,
				tileH: 128,
				values: v,
				compression: 8,
			},
		],
		pixel: px,
		originX: kx * 1000,
		originY: (ky + 1) * 1000,
		nodata: -9999,
	});
};

function swissFakes(opts: { dsmYear?: number; noDsm?: boolean } = {}) {
	const files = new Map<string, Uint8Array>();
	const ranges: string[] = [];
	const jsonUrls: string[] = [];
	const json: JsonFetcher = async (url) => {
		jsonUrls.push(url);
		const dsm = url.includes(DSM_COLLECTION);
		const feats = [];
		if (!(dsm && opts.noDsm))
			for (let kx = 2598; kx <= 2602; kx++)
				for (let ky = 1198; ky <= 1202; ky++) {
					const kind = dsm ? "dsm" : "dtm";
					const year = dsm ? (opts.dsmYear ?? 2019) : 2021;
					const href = `mem://${kind}/${kx}-${ky}.tif`;
					feats.push({
						id: `${dsm ? "swisssurface3d-raster" : "swissalti3d"}_${year}_${kx}-${ky}`,
						assets: { a: { href, "eo:gsd": dsm ? 0.5 : 2 } },
					});
				}
		return { features: feats };
	};
	const fetcher: RangeFetcher = async (url, start, end) => {
		ranges.push(url);
		let f = files.get(url);
		if (!f) {
			const m = url.match(/mem:\/\/(dsm|dtm)\/(\d+)-(\d+)\.tif/);
			if (!m) throw new Error(`404 ${url}`);
			f = tileBytes(m[1] as "dsm" | "dtm", Number(m[2]), Number(m[3]));
			files.set(url, f);
		}
		return f.slice(start, Math.min(end + 1, f.length));
	};
	return { json, fetcher, ranges, jsonUrls };
}

describe("enuToLv95Affine", () => {
	it("maps the frame origin to its LV95 position with unit-scale axes", () => {
		const a = enuToLv95Affine(new EnuFrame(BERN.lat, BERN.lon, 0));
		expect(Math.abs(a.E0 - 2600000)).toBeLessThan(2);
		expect(Math.abs(a.N0 - 1200000)).toBeLessThan(2);
		expect(a.m[0]).toBeCloseTo(1, 2);
		expect(a.m[3]).toBeCloseTo(1, 2);
		expect(Math.abs(a.m[1])).toBeLessThan(0.01);
		const [E, N] = a.map(100, -50);
		expect(E).toBeCloseTo(a.E0 + 100 * a.m[0] - 50 * a.m[1], 6);
		expect(N).toBeCloseTo(a.N0 + 100 * a.m[2] - 50 * a.m[3], 6);
	});
});

describe("eyeAltitudeOver", () => {
	it("uses the DEM + 1.8 m without a GPS altitude and never sinks below DEM + 1.6 m", () => {
		expect(eyeAltitudeOver(null, 500)).toBe(501.8);
		expect(eyeAltitudeOver(undefined, 500)).toBe(501.8);
		expect(eyeAltitudeOver(520, 500)).toBe(520);
		expect(eyeAltitudeOver(490, 500)).toBe(501.6);
	});
});

describe("occludedBy", () => {
	it("applies ratio 1.05 plus 3 m slack", () => {
		expect(OCCL_RULE).toEqual({ ratio: 1.05, slackM: 3 });
		expect(occludedBy(100, 100)).toBe(false);
		expect(occludedBy(108, 100)).toBe(false);
		expect(occludedBy(108.5, 100)).toBe(true);
		expect(occludedBy(5, 0)).toBe(true);
		expect(occludedBy(1, Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("loadNearDsm (synthetic swisstopo COGs)", () => {
	it("returns null outside Switzerland without any request", async () => {
		const f = swissFakes();
		const g = await loadNearDsm(48.85, 2.35, 250, 2, {
			json: f.json,
			fetcher: f.fetcher,
		});
		expect(g).toBeNull();
		expect(f.jsonUrls).toHaveLength(0);
	});

	it("returns null when STAC has no DSM tile", async () => {
		const f = swissFakes({ noDsm: true });
		const g = await loadNearDsm(BERN.lat, BERN.lon, 210, 2, {
			json: f.json,
			fetcher: f.fetcher,
		});
		expect(g).toBeNull();
	});

	it("resamples DSM and DTM onto the ENU grid and reports epoch and stats", async () => {
		const f = swissFakes({ dsmYear: 2019 });
		const g = (await loadNearDsm(BERN.lat, BERN.lon, 300, 2, {
			json: f.json,
			fetcher: f.fetcher,
		})) as NearDsm;
		expect(g).not.toBeNull();
		expect(g.res).toBe(2);
		expect(g.w).toBe(2 * 150 + 1);
		expect(g.h).toBe(g.w);
		expect(g.e0).toBe(-300);
		expect(g.n0).toBe(300);
		expect(g.radiusM).toBe(300);
		expect(g.epoch).toEqual({ dsm: 2019, dtm: 2021 });
		expect(g.years.dsm).toEqual([2019]);
		expect(g.stats.tiles).toBeGreaterThanOrEqual(1);
		expect(g.stats.dtmRes).toBe(4);
		expect(g.stats.bytes).toBeGreaterThan(0);
		expect(g.stats.stacRequests).toBe(2);
		// terrain: 500 + 0.02 * E (ENU east ~ LV95 east here)
		expect(nearHeightAt(g, "dtm", 0, 0)).toBeCloseTo(500, 0);
		expect(nearHeightAt(g, "dtm", 200, 0)).toBeCloseTo(504, 0);
		// tree: +12 m over the DTM, none beside it
		const treeE = 90;
		const treeN = 20;
		expect(
			nearHeightAt(g, "dsm", treeE, treeN) -
				nearHeightAt(g, "dtm", treeE, treeN),
		).toBeCloseTo(12, 0);
		expect(
			nearHeightAt(g, "dsm", -90, 20) - nearHeightAt(g, "dtm", -90, 20),
		).toBeCloseTo(0, 1);
		// corners outside the radius stay NaN
		expect(Number.isNaN(g.dsm[0])).toBe(true);
	});

	it("caches by argument set and drops failed loads from the cache", async () => {
		const f = swissFakes();
		const args = [
			BERN.lat,
			BERN.lon,
			220,
			2,
			{ json: f.json, fetcher: f.fetcher },
		] as const;
		const a = loadNearDsm(...args);
		const b = loadNearDsm(...args);
		expect(a).toBe(b);
		await a;
		const bad: JsonFetcher = async () => {
			throw new Error("offline");
		};
		const bargs = [
			BERN.lat,
			BERN.lon,
			230,
			2,
			{ json: bad, fetcher: f.fetcher },
		] as const;
		await expect(loadNearDsm(...bargs)).rejects.toThrow("offline");
		const again = loadNearDsm(BERN.lat, BERN.lon, 230, 2, {
			json: f.json,
			fetcher: f.fetcher,
		});
		await expect(again).resolves.not.toBeNull();
	});

	it("limits the tiles with maxTiles and blanks cells outside the view wedge", async () => {
		const f = swissFakes();
		const [lat, lon] = lv95ToWgs84(2600500, 1200500); // inside tile 2600-1200 only
		const g = (await loadNearDsm(lat, lon, 240, 2, {
			json: f.json,
			fetcher: f.fetcher,
			maxTiles: 1,
			wedge: { yawDeg: 90, halfDeg: 20 },
		})) as NearDsm;
		expect(g.stats.tiles).toBe(1);
		expect(Number.isFinite(nearHeightAt(g, "dsm", 150, 0))).toBe(true);
		expect(Number.isNaN(nearHeightAt(g, "dsm", 0, 150))).toBe(true);
		expect(Number.isNaN(nearHeightAt(g, "dsm", -150, 0))).toBe(true);
	});

	it("keeps only the tiles that fit the byte budget (always at least one)", async () => {
		const f = swissFakes();
		const g = (await loadNearDsm(BERN.lat, BERN.lon, 250, 2, {
			json: f.json,
			fetcher: f.fetcher,
			maxBytes: 1,
		})) as NearDsm;
		expect(g.stats.tiles).toBe(1);
	});
});

describe("nearHeightAt", () => {
	const g = {
		res: 10,
		e0: 0,
		n0: 20,
		w: 3,
		h: 3,
		dsm: Float32Array.from([0, 10, 20, 0, 10, 20, 0, 10, 20]),
		dtm: new Float32Array(9),
	} as unknown as NearDsm;

	it("interpolates bilinearly and is NaN outside the grid", () => {
		expect(nearHeightAt(g, "dsm", 5, 20)).toBeCloseTo(5, 6);
		expect(nearHeightAt(g, "dsm", 20, 0)).toBeCloseTo(20, 6);
		expect(nearHeightAt(g, "dsm", 15, 10)).toBeCloseTo(15, 6);
		expect(Number.isNaN(nearHeightAt(g, "dsm", -1, 10))).toBe(true);
		expect(Number.isNaN(nearHeightAt(g, "dsm", 5, 21))).toBe(true);
		expect(nearHeightAt(g, "dtm", 5, 5)).toBe(0);
	});
});

describe("objectHitRange / occluderRange", async () => {
	const f = swissFakes();
	const dsm = (await loadNearDsm(BERN.lat, BERN.lon, 400, 2, {
		json: f.json,
		fetcher: f.fetcher,
	})) as NearDsm;
	const eye: [number, number, number] = [0, 10, 501.7];
	const east: [number, number, number] = [1, 0, 0];

	it("hits the tree's near face along a level ray", () => {
		const r = objectHitRange(dsm, eye, east, 1000);
		expect(r).toBeGreaterThan(70);
		expect(r).toBeLessThan(90);
	});

	it("misses when the ray passes above the tree", () => {
		const up = [Math.cos(0.3), 0, Math.sin(0.3)] as [number, number, number];
		expect(objectHitRange(dsm, eye, up, 1000)).toBe(Number.POSITIVE_INFINITY);
	});

	it("misses when the ray runs beside the tree or dives under the terrain", () => {
		expect(objectHitRange(dsm, [0, 100, 501.7], east, 1000)).toBe(
			Number.POSITIVE_INFINITY,
		);
		const down = [Math.cos(0.2), 0, -Math.sin(0.2)] as [number, number, number];
		expect(objectHitRange(dsm, eye, down, 1000)).toBe(Number.POSITIVE_INFINITY);
	});

	it("ignores a vertical ray and respects maxT and nearSkipM", () => {
		expect(objectHitRange(dsm, eye, [0, 0, 1], 1000)).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(objectHitRange(dsm, eye, east, 50)).toBe(Number.POSITIVE_INFINITY);
		expect(objectHitRange(dsm, [60, 10, 501.7], east, 1000)).toBeGreaterThan(
			15,
		);
		expect(
			objectHitRange(dsm, [60, 10, 501.7], east, 1000, { nearSkipM: 40 }),
		).toBeGreaterThanOrEqual(40);
	});

	it("a high nDSM threshold hides the tree", () => {
		expect(objectHitRange(dsm, eye, east, 1000, { minObjM: 20 })).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	const cam: CameraX = {
		pose: { yaw: 90, pitch: 0, roll: 0, vfov: 30 },
		eye,
		aspect: 1,
		intr: { ...IDENTITY_INTRINSICS },
	};
	const g = (range: number, sky = 0) => ({
		w: 5,
		h: 5,
		xyz: new Float32Array(75),
		range: new Float32Array(25).fill(range),
		sky: new Uint8Array(25).fill(sky),
	});

	it("takes the nearer of DEM range and DSM object, per pixel", () => {
		const out = occluderRange(g(2000), cam, dsm);
		expect(out[12]).toBeGreaterThan(70);
		expect(out[12]).toBeLessThan(90);
		expect(occluderRange(g(30), cam, dsm)[12]).toBeCloseTo(30, 3);
	});

	it("is the DEM range without a DSM and Infinity over sky", () => {
		expect(occluderRange(g(500), cam, null)[12]).toBe(500);
		expect(occluderRange(g(500, 1), cam, dsm)[12]).toBeLessThan(90);
		expect(occluderRange(g(500, 1), cam, null)[12]).toBe(
			Number.POSITIVE_INFINITY,
		);
	});

	it("honours anchored objects and zeroes person pixels", () => {
		const objects = new Float32Array(25).fill(Number.NaN);
		objects[0] = 40;
		objects[1] = 9999;
		const people = new Uint8Array(25);
		people[2] = 255;
		const out = occluderRange(g(500), cam, null, objects, people);
		expect(out[0]).toBe(40);
		expect(out[1]).toBe(500);
		expect(out[2]).toBe(0);
		expect(out[3]).toBe(500);
	});

	it("eyeZ overrides the camera height", () => {
		const high = occluderRange(g(2000), cam, dsm, undefined, undefined, {
			eyeZ: 700,
		});
		expect(high[12]).toBe(2000);
	});
});

vi.setConfig({ testTimeout: 20000 });
