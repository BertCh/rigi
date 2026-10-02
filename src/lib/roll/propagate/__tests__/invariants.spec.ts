// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// R5 suggestion-only invariants end to end (plan + run + store, service client mocked).
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({ up: vi.fn(), relRot: vi.fn() }));
vi.mock("../estimator", () => ({
	relRotAvailable: client.up,
	relRot: client.relRot,
}));

import { storageKey } from "#/lib/ontology/core/storage";
import type { Pose } from "../../../camera";
import { destination } from "../../../geodesy";
import { relRFromPoses } from "../../../nearfield/propagate";
import type { PhotoMeta } from "../../../photos";
import { loadSolvedPose, saveSolvedPose } from "../../roll";
import type { Roll, RollPhoto } from "../../types";
import { ACCEPTED_METHOD, anchorKind, type RelRotResult } from "../plan";
import { persistRun, runPropagation } from "../run";
import {
	acceptSuggestion,
	revertAccepted,
	type StoredSuggestion,
	suggestionsFor,
} from "../store";

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
		vfov: 55,
		gravity: null,
		pitch: 0,
		roll: 0,
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
const rel = (from: number, to: number): RelRotResult => ({
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
});

let store: Map<string, string>;
beforeEach(() => {
	client.up.mockReset().mockResolvedValue(true);
	// anchor (yaw 90) → target (yaw 100); target → target is the identity, so triplet cycles close
	client.relRot
		.mockReset()
		.mockImplementation(async (a: { src: string }) =>
			a.src === "anchor.jpg" ? rel(90, 100) : rel(100, 100),
		);
	store = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
});

async function pending(): Promise<StoredSuggestion> {
	const anchor = photo("anchor", "saved", 90);
	const run = await runPropagation(
		rollOf([anchor, photo("t", "prior", 100, 20)]),
		anchor,
		"saved",
		"on",
		() => {},
	);
	persistRun(run);
	return suggestionsFor("t")[0];
}

describe("suggestion-only invariants", () => {
	it("a full run and persist write no pose slot and leave the suggestion pending", async () => {
		const s = await pending();
		expect(s.status).toBe("pending");
		expect(s.provenance).toBe("propagated-suggestion");
		expect(loadSolvedPose("t")).toBeNull();
		expect(
			[...store.keys()].filter((k) => k !== storageKey("propagate")),
		).toEqual([]);
	});

	it("an accepted pose is method propagated-suggestion, confidence 0, and never an anchor", async () => {
		const s = await pending();
		expect(acceptSuggestion(s, "prior")).toBe(true);
		const solved = loadSolvedPose("t");
		expect(solved).toMatchObject({ method: ACCEPTED_METHOD, confidence: 0 });
		const asPhoto = photo("t", "solved", 100, 20);
		expect(anchorKind(asPhoto, "on", solved?.method ?? null)).toBeNull();
		expect(anchorKind(asPhoto, "dev", solved?.method ?? null)).toBeNull();
	});

	it.each([
		"saved",
		"ground-truth",
		"solved",
	] as const)("accept is refused on a %s photo and writes nothing", async (source) => {
		const s = await pending();
		expect(acceptSuggestion(s, source)).toBe(false);
		expect(loadSolvedPose("t")).toBeNull();
		expect(suggestionsFor("t")[0].status).toBe("pending");
	});

	it("accept is refused when a solved pose is already stored, even if the caller does not know", async () => {
		const s = await pending();
		const aligner = {
			pose: pose(7),
			confidence: 0.9,
			method: "cascade" as const,
			at: "x",
		};
		saveSolvedPose("t", aligner);
		expect(acceptSuggestion(s)).toBe(false);
		expect(loadSolvedPose("t")).toEqual(aligner);
	});

	it("accept is refused when the user saved a pose in the workspace", async () => {
		const s = await pending();
		store.set(storageKey("savedPose", "t"), JSON.stringify(pose(5)));
		expect(acceptSuggestion(s)).toBe(false);
		expect(loadSolvedPose("t")).toBeNull();
	});

	it("a second suggestion needs undo first, and undo of a non-accepted record leaves the slot alone", async () => {
		const first = await pending();
		const second: StoredSuggestion = {
			...first,
			anchorId: "other",
			pose: pose(111),
		};
		expect(acceptSuggestion(first, "prior")).toBe(true);
		expect(acceptSuggestion(second, "solved")).toBe(false);
		expect(acceptSuggestion(second)).toBe(false);
		revertAccepted(second); // never accepted: must not clear the first accept
		expect(loadSolvedPose("t")?.pose).toEqual(first.pose);
		revertAccepted(first);
		expect(loadSolvedPose("t")).toBeNull();
		expect(acceptSuggestion(second, "prior")).toBe(true);
		expect(loadSolvedPose("t")?.pose).toEqual(pose(111));
	});

	it("undo keeps a pose that has since been replaced by an aligner solve", async () => {
		const s = await pending();
		acceptSuggestion(s, "prior");
		saveSolvedPose("t", {
			pose: pose(3),
			confidence: 0.8,
			method: "cascade" as const,
			at: "x",
		});
		revertAccepted(s);
		expect(loadSolvedPose("t")?.method).toBe("cascade");
	});

	it("service down: no suggestion, no pose change", async () => {
		client.up.mockResolvedValue(false);
		const anchor = photo("anchor", "saved", 90);
		const run = await runPropagation(
			rollOf([anchor, photo("t", "prior", 100, 20)]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		persistRun(run);
		expect(client.relRot).not.toHaveBeenCalled();
		expect(suggestionsFor("t")).toEqual([]);
		expect(loadSolvedPose("t")).toBeNull();
	});

	it("baseline over 250 m never reaches the estimator", async () => {
		const anchor = photo("anchor", "saved", 90);
		const run = await runPropagation(
			rollOf([anchor, photo("far", "prior", 100, 400)]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		expect(client.relRot).not.toHaveBeenCalled();
		expect(run.rows[0].status).toBe("skipped");
	});

	it("sends at most the 8 nearest neighbours to the estimator", async () => {
		const anchor = photo("anchor", "saved", 90);
		const ts = Array.from({ length: 12 }, (_, i) =>
			photo(`t${i}`, "prior", 90, 10 + i),
		);
		client.relRot.mockImplementation(async () => rel(90, 90));
		await runPropagation(
			rollOf([anchor, ...ts]),
			anchor,
			"saved",
			"on",
			() => {},
		);
		const pass1 = client.relRot.mock.calls.filter(
			(c) => c[0].src === "anchor.jpg",
		);
		expect(pass1).toHaveLength(8);
		expect(new Set(pass1.map((c) => c[1].src))).not.toContain("t11.jpg");
	});

	it("a re-run whose gate now rejects drops only the pending card, keeping decisions", async () => {
		const anchor = photo("anchor", "saved", 90);
		const targets = [
			photo("p", "prior", 100, 10),
			photo("acc", "prior", 100, 11),
			photo("dis", "prior", 100, 12),
		];
		const r = rollOf([anchor, ...targets]);
		persistRun(await runPropagation(r, anchor, "saved", "on", () => {}));
		const [acc] = suggestionsFor("acc");
		acceptSuggestion(acc, "prior");
		const { dismissSuggestion } = await import("../store");
		dismissSuggestion(suggestionsFor("dis")[0]);
		// now every estimate has too few inliers: the gate rejects all three
		client.relRot.mockImplementation(async () => ({
			...rel(90, 100),
			inliers: 5,
		}));
		persistRun(await runPropagation(r, anchor, "saved", "on", () => {}));
		expect(suggestionsFor("p")).toEqual([]);
		expect(suggestionsFor("acc")[0].status).toBe("accepted");
		expect(suggestionsFor("dis")[0].status).toBe("dismissed");
		expect(loadSolvedPose("acc")?.method).toBe(ACCEPTED_METHOD);
	});
});
