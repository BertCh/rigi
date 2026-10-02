// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverride } from "#/lib/flags";
import { headingDeclination } from "#/lib/geocam/priors/heading";
import { storageKey } from "#/lib/ontology/core/storage";
import { destination } from "../../geodesy";
import type { PhotoMeta } from "../../photos";
import {
	clusterPhotos,
	hfovOf,
	legacyUploadRollIndex,
	loadSolvedPose,
	makeRoll,
	priorPose,
	ROLL_LINK_M,
	resolvePose,
	saveSolvedPose,
	UPLOAD_ROLL_PREFIX,
	uploadRollId,
	uploadRolls,
	VIEWPOINT_RADIUS_M,
} from "../roll";

const T0 = Date.parse("2025-08-01T10:00:00Z");
function meta(id: string, o: Partial<PhotoMeta> = {}): PhotoMeta {
	return {
		id,
		src: `${id}.jpg`,
		width: 4000,
		height: 3000,
		takenAt: new Date(T0).toISOString(),
		lat: 46.7,
		lon: 7.7,
		alt: 1500,
		hAccuracy: null,
		heading: 120,
		f35: 26,
		vfov: 55,
		gravity: null,
		pitch: 3,
		roll: -1,
		holding: null,
		region: "x",
		...o,
	} as PhotoMeta;
}
/** A photo `metres` north of the base point, `secs` after T0. */
function north(
	id: string,
	metres: number,
	secs = 0,
	o: Partial<PhotoMeta> = {},
) {
	const d = destination(46.7, 7.7, 0, metres);
	return meta(id, {
		lat: d.lat,
		lon: d.lon,
		takenAt: new Date(T0 + secs * 1000).toISOString(),
		...o,
	});
}

function stubStorage() {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	return store;
}
afterEach(() => vi.unstubAllGlobals());

describe("clusterPhotos", () => {
	it("single-linkage chains photos each within the link distance", () => {
		// 0, 10 km, 20 km: ends are 20 km apart (> link) but linked through the middle
		const ms = [north("a", 0), north("b", 10_000), north("c", 20_000)];
		const g = clusterPhotos(ms);
		expect(g).toHaveLength(1);
		expect(g[0].map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
	});
	it("splits groups beyond the link distance and orders largest first", () => {
		const ms = [
			north("far", 50_000),
			north("a", 0),
			north("b", 100),
			north("c", 200),
		];
		const g = clusterPhotos(ms);
		expect(g.map((x) => x.length)).toEqual([3, 1]);
		expect(g[1][0].id).toBe("far");
	});
	it("honours a custom link distance and the strict inequality", () => {
		const ms = [north("a", 0), north("b", 1000)];
		expect(clusterPhotos(ms, 900)).toHaveLength(2);
		expect(clusterPhotos(ms, 1100)).toHaveLength(1);
	});
	it("drops photos with a non-finite position and handles the empty list", () => {
		expect(clusterPhotos([])).toEqual([]);
		const g = clusterPhotos([meta("a"), meta("bad", { lat: Number.NaN })]);
		expect(g).toHaveLength(1);
		expect(g[0].map((m) => m.id)).toEqual(["a"]);
	});
	it("partitions every valid photo exactly once", () => {
		const ms = Array.from({ length: 30 }, (_, i) => north(`p${i}`, i * 9000));
		const g = clusterPhotos(ms, ROLL_LINK_M);
		expect(
			g
				.flat()
				.map((m) => m.id)
				.sort(),
		).toEqual(ms.map((m) => m.id).sort());
	});
});

describe("upload roll ids", () => {
	it("derives the id from the earliest photo (time, then id), stripping 'local-'", () => {
		const ms = [
			meta("local-b", { takenAt: "2025-08-01T10:00:00Z" }),
			meta("local-a", { takenAt: "2025-08-01T10:00:00Z" }),
			meta("local-c", { takenAt: "2025-08-01T11:00:00Z" }),
		];
		expect(uploadRollId(ms)).toBe(`${UPLOAD_ROLL_PREFIX}a`);
		expect(uploadRollId([...ms].reverse())).toBe(`${UPLOAD_ROLL_PREFIX}a`);
	});
	it("is stable when later photos join the cluster", () => {
		const first = meta("local-1", { takenAt: "2025-08-01T09:00:00Z" });
		const later = meta("local-2", { takenAt: "2025-08-02T09:00:00Z" });
		expect(uploadRollId([first])).toBe(uploadRollId([first, later]));
	});
	it("parses only legacy numeric ids", () => {
		expect(legacyUploadRollIndex("local-roll-3")).toBe(3);
		expect(legacyUploadRollIndex("local-roll-12345")).toBeNull();
		expect(legacyUploadRollIndex("local-roll-abc")).toBeNull();
		expect(legacyUploadRollIndex("demo")).toBeNull();
	});
});

describe("priorPose / hfovOf", () => {
	it("uses the compass heading, gravity and lens; heading 0 without a compass", () => {
		expect(priorPose(meta("a"))).toEqual({
			yaw: 120,
			pitch: 3,
			roll: -1,
			vfov: 55,
		});
		expect(priorPose(meta("a", { heading: null })).yaw).toBe(0);
	});
	it("corrects a magnetic heading for declination only under geoDecl, as the engines do", () => {
		const magnetic = meta("m", {
			local: { headingRef: "M" },
		} as Partial<PhotoMeta>);
		const d = headingDeclination(magnetic) as number;
		expect(Math.abs(d)).toBeGreaterThan(0.5);
		try {
			expect(priorPose(magnetic).yaw).toBe(120); // flag off (default): unchanged
			setFlagOverride("geoDecl", "on");
			expect(priorPose(magnetic).yaw).toBeCloseTo(120 + d, 9);
			expect(priorPose(meta("t")).yaw).toBe(120); // no ref (bundled): unchanged
			expect(priorPose(meta("n", { heading: null })).yaw).toBe(0);
		} finally {
			setFlagOverride("geoDecl", undefined);
		}
	});
	it("converts vfov to hfov through the aspect", () => {
		expect(hfovOf({ yaw: 0, pitch: 0, roll: 0, vfov: 60 }, 1)).toBeCloseTo(
			60,
			9,
		);
		const wide = hfovOf({ yaw: 0, pitch: 0, roll: 0, vfov: 60 }, 16 / 9);
		expect(wide).toBeGreaterThan(60);
		expect(wide).toBeLessThan(180);
	});
});

describe("resolvePose", () => {
	it("falls back to the EXIF prior with no stored or ground-truth data", () => {
		const r = resolvePose(meta("nothing-known"));
		expect(r.source).toBe("prior");
		expect(r.pose).toEqual(priorPose(meta("nothing-known")));
		expect(r.eyeAlt).toBe(1500);
		expect(r.confidence).toBeNull();
	});
	it("prefers a saved pose, then a solved pose", () => {
		const store = stubStorage();
		const m = meta("p1");
		store.set(
			storageKey("solvedPose", "p1"),
			JSON.stringify({
				pose: { yaw: 10, pitch: 0, roll: 0, vfov: 50 },
				confidence: 0.8,
				method: "cascade",
				at: "t",
			}),
		);
		const solved = resolvePose(m);
		expect(solved.source).toBe("solved");
		expect(solved.confidence).toBe(0.8);
		expect(solved.pose.yaw).toBe(10);
		store.set(
			storageKey("savedPose", "p1"),
			JSON.stringify({ yaw: 99, pitch: 1, roll: 2, vfov: 40 }),
		);
		const saved = resolvePose(m);
		expect(saved.source).toBe("saved");
		expect(saved.pose.yaw).toBe(99);
		// ignoreStored skips both
		expect(resolvePose(m, { ignoreStored: true }).source).toBe("prior");
	});
	it("rejects a saved pose with a bad vfov", () => {
		const store = stubStorage();
		store.set(
			storageKey("savedPose", "p2"),
			JSON.stringify({ yaw: 1, pitch: 1, roll: 1, vfov: 400 }),
		);
		expect(resolvePose(meta("p2")).source).toBe("prior");
	});
});

describe("solved pose storage", () => {
	it("saves, loads and clears", () => {
		stubStorage();
		const s = {
			pose: { yaw: 1, pitch: 2, roll: 3, vfov: 4 },
			confidence: 0.5,
			method: "cascade" as const,
			at: "x",
		};
		expect(loadSolvedPose("a")).toBeNull();
		saveSolvedPose("a", s);
		expect(loadSolvedPose("a")).toEqual(s);
		saveSolvedPose("a", null);
		expect(loadSolvedPose("a")).toBeNull();
	});
	it("tolerates missing storage and corrupt JSON", () => {
		expect(loadSolvedPose("a")).toBeNull(); // no localStorage in node
		expect(() => saveSolvedPose("a", null)).not.toThrow();
		const store = stubStorage();
		store.set(storageKey("solvedPose", "a"), "{not json");
		expect(loadSolvedPose("a")).toBeNull();
	});
});

describe("makeRoll", () => {
	const photos = [
		north("c", 2000, 600),
		north("a", 0, 0),
		north("b", VIEWPOINT_RADIUS_M - 50, 120),
	];
	const roll = makeRoll("r1", "Test", photos, "x");

	it("sorts by capture time and stamps seconds since the first photo", () => {
		expect(roll.photos.map((p) => p.meta.id)).toEqual(["a", "b", "c"]);
		expect(roll.photos.map((p) => p.t)).toEqual([0, 120, 600]);
	});
	it("groups photos within the viewpoint radius of a viewpoint's first photo", () => {
		expect(roll.viewpoints).toHaveLength(2);
		expect(roll.photos.map((p) => p.viewpoint)).toEqual([0, 0, 1]);
		expect(roll.viewpoints[0].photoIds).toEqual(["a", "b"]);
	});
	it("re-centres each viewpoint on its members", () => {
		const a = photos[1];
		const b = photos[2];
		expect(roll.viewpoints[0].lat).toBeCloseTo((a.lat + b.lat) / 2, 9);
	});
	it("computes the centroid and the largest centre distance", () => {
		const lats = photos.map((p) => p.lat);
		expect(roll.center.lat).toBeCloseTo(lats.reduce((a, b) => a + b) / 3, 9);
		expect(roll.radiusM).toBeGreaterThan(900);
		expect(roll.radiusM).toBeLessThan(1400);
		expect(roll.region).toBe("x");
	});
	it("handles an empty roll", () => {
		const r = makeRoll("e", "Empty", [], null);
		expect(r.photos).toEqual([]);
		expect(r.radiusM).toBe(0);
	});
});

describe("uploadRolls", () => {
	it("makes one roll per cluster, largest first, with ids and names from the cluster", () => {
		const ms = [
			north("local-x1", 0, 0),
			north("local-x2", 50, 10),
			north("local-y1", 90_000, 5),
		];
		const rolls = uploadRolls(ms);
		expect(rolls).toHaveLength(2);
		expect(rolls[0].photos).toHaveLength(2);
		expect(rolls[0].id).toBe(`${UPLOAD_ROLL_PREFIX}x1`);
		expect(rolls[1].id).toBe(`${UPLOAD_ROLL_PREFIX}y1`);
		expect(rolls[0].name).toMatch(/^Your photos near 46\.\d{3}°, 7\.\d{3}°$/);
	});
});
