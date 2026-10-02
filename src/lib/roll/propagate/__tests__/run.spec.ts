// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ up: vi.fn(), relRot: vi.fn() }));
vi.mock("../client", () => ({
	propagateServiceUp: client.up,
	relRot: client.relRot,
}));

import type { Pose } from "../../../camera";
import { destination } from "../../../geodesy";
import { relRFromPoses } from "../../../nearfield/propagate";
import type { PhotoMeta } from "../../../photos";
import type { Roll, RollPhoto } from "../../types";
import type { RelRotResult } from "../plan";
import { type PropagateRun, persistRun, runPropagation } from "../run";
import { suggestionsFor } from "../store";

const T0 = Date.parse("2025-08-01T10:00:00Z");
const pose = (yaw: number): Pose => ({ yaw, pitch: 0, roll: 0, vfov: 55 });
function photo(
	id: string,
	src: RollPhoto["poseSource"],
	yaw: number,
	metres = 0,
): RollPhoto {
	const d = destination(46.7, 7.7, 0, metres);
	const meta = {
		id,
		src: `${id}.jpg`,
		width: 4000,
		height: 3000,
		takenAt: new Date(T0 + metres * 1000).toISOString(),
		lat: d.lat,
		lon: d.lon,
		alt: null,
		heading: yaw,
		f35: 26,
		vfov: 55,
		gravity: null,
		pitch: 0,
		roll: 0,
		region: "x",
	} as unknown as PhotoMeta;
	return {
		meta,
		pose: pose(yaw),
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
/** An estimator result for the true rotation between two yaws. */
const rel = (
	from: number,
	to: number,
	o: Partial<RelRotResult> = {},
): RelRotResult => ({
	method: "rot",
	relR: relRFromPoses(pose(from), pose(to)) as number[],
	inliers: 120,
	n: 200,
	rmsPx: 1,
	bwd: null,
	fwdBwdDeg: 0.1,
	sizeA: [1024, 768],
	sizeB: [1024, 768],
	seconds: 1,
	...o,
});

let store: Map<string, string>;
beforeEach(() => {
	client.up.mockReset().mockResolvedValue(true);
	client.relRot.mockReset();
	store = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
});

describe("runPropagation", () => {
	const anchor = photo("anchor", "saved", 90);

	it("marks every queued row as an error when the service is down", async () => {
		client.up.mockResolvedValue(false);
		const t = photo("t", "prior", 90, 10);
		const updates: PropagateRun[] = [];
		const run = await runPropagation(
			rollOf([anchor, t]),
			anchor,
			"saved",
			"on",
			(r) => updates.push(r),
		);
		expect(run.serviceUp).toBe(false);
		expect(run.done).toBe(true);
		expect(run.rows[0].status).toBe("error");
		expect(run.rows[0].reasons).toEqual(["relative-rotation service is down"]);
		expect(client.relRot).not.toHaveBeenCalled();
		expect(updates).toHaveLength(1);
	});

	it("keeps skipped rows skipped (with their reason) even when the service is down", async () => {
		client.up.mockResolvedValue(false);
		const far = photo("far", "prior", 90, 400);
		const run = await runPropagation(
			rollOf([anchor, far]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		expect(run.rows[0].status).toBe("skipped");
		expect(run.rows[0].reasons[0]).toMatch(/baseline/);
	});

	it("turns a gated estimate into a pending stored suggestion", async () => {
		const t = photo("t", "prior", 90, 10);
		client.relRot.mockResolvedValue(rel(90, 115));
		const statuses: string[] = [];
		const run = await runPropagation(
			rollOf([anchor, t]),
			anchor,
			"saved",
			"on",
			(r) => statuses.push(r.rows[0].status),
		);
		const row = run.rows[0];
		expect(statuses).toContain("running");
		expect(row.status).toBe("suggested");
		expect(row.suggestion?.pose.yaw).toBeCloseTo(115, 5);
		expect(row.suggestion?.status).toBe("pending");
		expect(row.suggestion?.anchorKind).toBe("saved");
		expect(row.suggestion?.evidence).toMatchObject({
			inliers: 120,
			baselineM: row.candidate.baselineM,
			cycleDeg: null,
		});
		expect(row.deltaToCurrentDeg).toBeCloseTo(25, 5);
		expect(run.done).toBe(true);
		// the anchor image goes first, with the anchor's accepted vfov
		expect(client.relRot.mock.calls[0][0]).toEqual({
			src: "anchor.jpg",
			vfov: 55,
		});
	});

	it("rejects a row that fails the gate and records why", async () => {
		const t = photo("t", "prior", 90, 10);
		client.relRot.mockResolvedValue(rel(90, 115, { inliers: 5 }));
		const run = await runPropagation(
			rollOf([anchor, t]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		expect(run.rows[0].status).toBe("rejected");
		expect(run.rows[0].reasons.length).toBeGreaterThan(0);
		expect(run.rows[0].suggestion).toBeUndefined();
	});

	it("reports estimator errors and estimates with no rotation", async () => {
		const a = photo("a", "prior", 90, 10);
		const b = photo("b", "prior", 90, 20);
		client.relRot
			.mockResolvedValueOnce("service unreachable (x)")
			.mockResolvedValueOnce(rel(90, 100, { relR: null }));
		const run = await runPropagation(
			rollOf([anchor, a, b]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		expect(run.rows[0]).toMatchObject({
			status: "error",
			reasons: ["service unreachable (x)"],
		});
		expect(run.rows[1].status).toBe("error");
		expect(run.rows[1].reasons[0]).toMatch(/no rotation/);
	});

	it("stops sending pairs once aborted", async () => {
		const ac = new AbortController();
		const a = photo("a", "prior", 90, 10);
		const b = photo("b", "prior", 90, 20);
		client.relRot.mockImplementation(async () => {
			ac.abort();
			return rel(90, 100);
		});
		const run = await runPropagation(
			rollOf([anchor, a, b]),
			anchor,
			"saved",
			"on",
			() => {},
			ac.signal,
		);
		expect(client.relRot).toHaveBeenCalledTimes(1);
		expect(run.rows[1].status).toBe("queued");
		expect(run.done).toBe(true);
	});

	it("runs the triplet cycle check against the strongest other trusted estimate", async () => {
		const b = photo("b", "prior", 90, 10);
		const c = photo("c", "prior", 90, 20);
		client.relRot.mockImplementation(
			async (a: { src: string }, t: { src: string }) => {
				if (a.src === "anchor.jpg" && t.src === "b.jpg")
					return rel(90, 110, { inliers: 80 });
				if (a.src === "anchor.jpg" && t.src === "c.jpg")
					return rel(90, 130, { inliers: 150 });
				if (a.src === "b.jpg" && t.src === "c.jpg") return rel(110, 130);
				return "unexpected";
			},
		);
		const run = await runPropagation(
			rollOf([anchor, b, c]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		const rb = run.rows.find((r) => r.candidate.target.meta.id === "b");
		expect(rb?.cycleWith).toBe("c");
		expect(rb?.suggestion?.evidence.cycleDeg).toBeCloseTo(0, 5);
		// b->c was asked for b, with c as the cycle partner; c's own partner is b
		expect(
			client.relRot.mock.calls.some(
				(x) => x[0].src === "b.jpg" && x[1].src === "c.jpg",
			),
		).toBe(true);
	});

	it("a cycle that disagrees demotes the suggestion", async () => {
		const b = photo("b", "prior", 90, 10);
		const c = photo("c", "prior", 90, 20);
		client.relRot.mockImplementation(
			async (a: { src: string }, t: { src: string }) => {
				if (a.src === "anchor.jpg" && t.src === "b.jpg")
					return rel(90, 110, { inliers: 80 });
				if (a.src === "anchor.jpg" && t.src === "c.jpg")
					return rel(90, 130, { inliers: 150 });
				if (a.src === "b.jpg" && t.src === "c.jpg") return rel(110, 150); // 20 deg off
				return "unexpected";
			},
		);
		const run = await runPropagation(
			rollOf([anchor, b, c]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		const rb = run.rows.find((r) => r.candidate.target.meta.id === "b");
		expect(rb?.status).toBe("rejected");
		expect(rb?.reasons.join(" ")).toMatch(/cycle/i);
	});
});

describe("persistRun", () => {
	it("stores suggested rows and drops stale pending cards of rejected rows", async () => {
		const anchor = photo("anchor", "saved", 90);
		const good = photo("good", "prior", 90, 10);
		const bad = photo("bad", "prior", 90, 20);
		const answer =
			(badInliers: number) =>
			async (a: { src: string }, t: { src: string }) => {
				if (a.src === "anchor.jpg")
					return t.src === "good.jpg"
						? rel(90, 110)
						: rel(90, 100, { inliers: badInliers });
				return a.src === "good.jpg" ? rel(110, 100) : rel(100, 110);
			};
		client.relRot.mockImplementation(answer(100));
		const first = await runPropagation(
			rollOf([anchor, good, bad]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		persistRun(first);
		expect(suggestionsFor("good")).toHaveLength(1);
		expect(suggestionsFor("bad")).toHaveLength(1);

		// a re-run where "bad" no longer gates
		client.relRot.mockImplementation(answer(3));
		const second = await runPropagation(
			rollOf([anchor, good, bad]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		persistRun(second);
		expect(suggestionsFor("good")).toHaveLength(1);
		expect(suggestionsFor("bad")).toEqual([]);
	});
});
