// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { setFlagOverride } from "#/lib/flags";
import { headingDeclination } from "#/lib/geocam/priors/heading";
import type { Pose } from "../../../camera";
import { destination } from "../../../geodesy";
import { relRFromPoses } from "../../../nearfield/propagate";
import type { PhotoMeta } from "../../../photos";
import type { Roll, RollPhoto } from "../../types";
import {
	ACCEPTED_METHOD,
	anchorKind,
	COMPASS_MARGIN_DEG,
	candidatesFor,
	cycleDeg,
	isTarget,
	MAX_NEIGHBOURS,
	poseDeltaDeg,
	propose,
	type RelRotResult,
} from "../plan";

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
		alt: null,
		hAccuracy: null,
		heading: 0,
		f35: 26,
		vfov: 55,
		gravity: null,
		pitch: 0,
		roll: 0,
		holding: null,
		region: "x",
		...o,
	} as PhotoMeta;
}
const pose = (yaw: number, vfov = 55): Pose => ({
	yaw,
	pitch: 0,
	roll: 0,
	vfov,
});
function rp(
	m: PhotoMeta,
	src: RollPhoto["poseSource"],
	p: Pose = pose(m.heading ?? 0),
): RollPhoto {
	return {
		meta: m,
		pose: p,
		poseSource: src,
		confidence: null,
		eyeAlt: null,
		t: 0,
		viewpoint: 0,
	};
}
const rollOf = (photos: RollPhoto[]): Roll => ({
	id: "r",
	name: "r",
	photos,
	viewpoints: [],
	center: { lat: 46.7, lon: 7.7 },
	radiusM: 0,
	region: null,
});

describe("anchorKind", () => {
	const m = meta("a");
	it("is null for every photo when propagation is off", () => {
		for (const s of ["saved", "solved", "ground-truth", "prior"] as const)
			expect(anchorKind(rp(m, s), "off", "cascade")).toBeNull();
	});
	it("saved poses anchor; priors never do", () => {
		expect(anchorKind(rp(m, "saved"), "on", null)).toBe("saved");
		expect(anchorKind(rp(m, "prior"), "dev", null)).toBeNull();
	});
	it("solved poses anchor unless they came from an accepted suggestion (no chaining)", () => {
		expect(anchorKind(rp(m, "solved"), "on", "cascade")).toBe("solved");
		expect(anchorKind(rp(m, "solved"), "on", ACCEPTED_METHOD)).toBeNull();
		expect(anchorKind(rp(m, "solved"), "on", null)).toBeNull();
	});
	it("ground truth anchors only in dev mode", () => {
		expect(anchorKind(rp(m, "ground-truth"), "on", null)).toBeNull();
		expect(anchorKind(rp(m, "ground-truth"), "dev", null)).toBe("ground-truth");
	});
});

describe("isTarget", () => {
	const m = meta("a");
	it("on: only EXIF-prior photos; dev: every photo; off: none", () => {
		expect(isTarget(rp(m, "prior"), "on")).toBe(true);
		expect(isTarget(rp(m, "saved"), "on")).toBe(false);
		expect(isTarget(rp(m, "solved"), "on")).toBe(false);
		expect(isTarget(rp(m, "saved"), "dev")).toBe(true);
		expect(isTarget(rp(m, "prior"), "off")).toBe(false);
	});
});

describe("candidatesFor", () => {
	const anchor = rp(meta("anchor", { heading: 90 }), "saved", pose(90));
	const at = (
		id: string,
		metres: number,
		secs: number,
		heading: number | null = 90,
	) => {
		const d = destination(46.7, 7.7, 0, metres);
		return rp(
			meta(id, {
				lat: d.lat,
				lon: d.lon,
				heading,
				takenAt: new Date(T0 + secs * 1000).toISOString(),
			}),
			"prior",
		);
	};

	it("excludes the anchor itself and non-targets, and sorts nearest first then by time", () => {
		const roll = rollOf([
			anchor,
			at("far", 100, 10),
			at("near2", 10, 50),
			at("near1", 10, 5),
			rp(meta("saved2"), "saved"),
		]);
		const c = candidatesFor(roll, anchor, "on");
		expect(c.map((x) => x.target.meta.id)).toEqual(["near1", "near2", "far"]);
		expect(c[0].baselineM).toBeCloseTo(10, 0);
		expect(c[0].dtS).toBe(5);
	});

	it("skips pairs beyond the baseline gate", () => {
		const c = candidatesFor(rollOf([anchor, at("t", 400, 1)]), anchor, "on");
		expect(c[0].skip).toMatch(/baseline 400 m > 250 m/);
	});

	it("skips opposite-heading targets in 'on' mode only", () => {
		const t = at("back", 20, 1, 270);
		expect(candidatesFor(rollOf([anchor, t]), anchor, "on")[0].skip).toMatch(
			/compass/,
		);
		// dev mode: anchor and target are both usable (target is any photo)
		expect(
			candidatesFor(rollOf([anchor, t]), anchor, "dev")[0].skip,
		).toBeNull();
	});

	it("keeps targets whose heading is just inside the margin", () => {
		// hfov of 55 deg vfov at 4:3 is ~ 70; two halves = ~70, + margin 45
		const t = at("side", 20, 1, 90 + 70 + COMPASS_MARGIN_DEG - 5);
		expect(candidatesFor(rollOf([anchor, t]), anchor, "on")[0].skip).toBeNull();
	});

	it("targets without a compass have null overlap and are never compass-skipped", () => {
		const c = candidatesFor(
			rollOf([anchor, at("nocompass", 20, 1, null)]),
			anchor,
			"on",
		)[0];
		expect(c.compassOverlap).toBeNull();
		expect(c.compassDeltaDeg).toBeNull();
		expect(c.skip).toBeNull();
	});

	it("caps the rows sent to the estimator at MAX_NEIGHBOURS but keeps the skipped rows", () => {
		const photos = Array.from({ length: MAX_NEIGHBOURS + 3 }, (_, i) =>
			at(`t${i}`, 10 + i, i),
		);
		const c = candidatesFor(rollOf([anchor, ...photos]), anchor, "on");
		expect(c).toHaveLength(MAX_NEIGHBOURS + 3);
		expect(c.filter((x) => !x.skip)).toHaveLength(MAX_NEIGHBOURS);
		expect(
			c
				.slice(MAX_NEIGHBOURS)
				.every((x) => /beyond the 8 nearest/.test(x.skip ?? "")),
		).toBe(true);
	});
});

describe("candidatesFor compass heading", () => {
	it("uses the true-north prior heading (priorPose's rule): declination only under geoDecl", () => {
		const anchor = rp(meta("anchor", { heading: 90 }), "saved", pose(90));
		const target = rp(
			meta("m", {
				heading: 100,
				local: { headingRef: "M" },
			} as Partial<PhotoMeta>),
			"prior",
		);
		const roll = rollOf([anchor, target]);
		const d = headingDeclination(target.meta) as number;
		expect(Math.abs(d)).toBeGreaterThan(0.5);
		const delta = () =>
			candidatesFor(roll, anchor, "on").find((c) => c.target.meta.id === "m")
				?.compassDeltaDeg;
		try {
			expect(delta()).toBeCloseTo(10, 9); // flag off: the stored heading, bit-identical
			setFlagOverride("geoDecl", "on");
			expect(delta()).toBeCloseTo(10 + d, 9);
		} finally {
			setFlagOverride("geoDecl", undefined);
		}
	});
});

describe("cycleDeg", () => {
	const A = pose(0);
	const B = pose(25);
	const C = pose(60);
	const ab = relRFromPoses(A, B);
	const bc = relRFromPoses(B, C);
	const ac = relRFromPoses(A, C);
	it("is zero when the three estimates agree", () => {
		expect(cycleDeg(ab, bc, ac)).toBeCloseTo(0, 6);
	});
	it("reports the inconsistency in degrees", () => {
		const bad = relRFromPoses(A, pose(63));
		expect(cycleDeg(ab, bc, bad)).toBeCloseTo(3, 6);
	});
});

describe("poseDeltaDeg", () => {
	it("is the geodesic angle between two poses", () => {
		expect(poseDeltaDeg(pose(10), pose(14))).toBeCloseTo(4, 9);
		expect(poseDeltaDeg(pose(355), pose(5))).toBeCloseTo(10, 9);
		expect(poseDeltaDeg(pose(30), pose(30))).toBeCloseTo(0, 6);
	});
});

describe("propose", () => {
	const anchor = rp(meta("anchor", { heading: 90 }), "saved", pose(90));
	const target = rp(meta("t", { heading: 90 }), "prior", pose(90));
	const cand = (baselineM: number) => ({
		target,
		baselineM,
		dtS: 1,
		compassOverlap: 1,
		compassDeltaDeg: 0,
		skip: null,
	});
	const rel = (dyaw: number): RelRotResult => ({
		method: "rot",
		relR: relRFromPoses(pose(90), pose(90 + dyaw)) as number[],
		inliers: 120,
		n: 200,
		rmsPx: 1,
		bwd: null,
		fwdBwdDeg: 0.1,
		sizeA: [1024, 768],
		sizeB: [1024, 768],
		seconds: 1,
	});

	it("returns an error, not a suggestion, when the estimator has no rotation", () => {
		const p = propose(anchor, cand(10), { ...rel(10), relR: null });
		expect(p.suggestion).toBeNull();
		expect(p.error).toMatch(/no rotation \(200 matches\)/);
		expect(
			propose(anchor, cand(10), { ...rel(10), relR: [1, 2, 3] }).error,
		).not.toBeNull();
	});
	it("proposes the rotated pose and is gated on clean evidence", () => {
		const p = propose(anchor, cand(10), rel(15));
		expect(p.error).toBeNull();
		expect(p.cautions).toEqual([]);
		expect(p.suggestion?.pose.yaw).toBeCloseTo(105, 6);
		expect(p.suggestion?.gated).toBe(true);
		expect(p.suggestion?.kind).toBe("suggestion");
	});
	it("adds a parallax caution above 50 m, scaled by baseline / 3 km", () => {
		const p = propose(anchor, cand(100), rel(10));
		expect(p.cautions).toHaveLength(1);
		expect(p.cautions[0]).toMatch(/100 m baseline ≈ 1\.9°/);
		expect(propose(anchor, cand(50), rel(10)).cautions).toEqual([]);
	});
	it("adds an ultrawide caution when either lens is above 80 deg", () => {
		const wide = rp(meta("w", { vfov: 85 }), "prior");
		const p = propose(anchor, { ...cand(10), target: wide }, rel(10));
		expect(p.cautions.join(" ")).toMatch(/ultrawide/);
	});
});
