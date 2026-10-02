// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "#/lib/ontology/core/storage";
import { loadSolvedPose, saveSolvedPose } from "../../roll";
import { ACCEPTED_METHOD, PROVENANCE } from "../plan";
import {
	acceptSuggestion,
	dismissSuggestion,
	dropPending,
	putSuggestion,
	revertAccepted,
	type StoredSuggestion,
	suggestionsFor,
} from "../store";

let store: Map<string, string>;
beforeEach(() => {
	store = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
});
afterEach(() => vi.unstubAllGlobals());

const sug = (
	anchorId: string,
	targetId: string,
	o: Partial<StoredSuggestion> = {},
): StoredSuggestion => ({
	provenance: PROVENANCE,
	targetId,
	anchorId,
	anchorKind: "saved",
	pose: { yaw: 100, pitch: 1, roll: 0, vfov: 55 },
	seedRadiusDeg: 4,
	evidence: {
		inliers: 90,
		rmsPx: 1.2,
		overlap: 0.4,
		fwdBwdDeg: 0.1,
		cycleDeg: null,
		baselineM: 12,
		dtS: 30,
	},
	cautions: [],
	status: "pending",
	at: "2026-09-07T10:00:00.000Z",
	...o,
});

describe("suggestion store", () => {
	it("stores a suggestion per anchor>target pair and finds them by target", () => {
		putSuggestion(sug("a1", "t"));
		putSuggestion(sug("a2", "t"));
		putSuggestion(sug("a1", "other"));
		expect(
			suggestionsFor("t")
				.map((s) => s.anchorId)
				.sort(),
		).toEqual(["a1", "a2"]);
		expect(suggestionsFor("other")).toHaveLength(1);
		expect(suggestionsFor("nobody")).toEqual([]);
	});

	it("replaces a pending record with a fresh one", () => {
		putSuggestion(sug("a", "t", { seedRadiusDeg: 4 }));
		putSuggestion(sug("a", "t", { seedRadiusDeg: 9 }));
		const all = suggestionsFor("t");
		expect(all).toHaveLength(1);
		expect(all[0].seedRadiusDeg).toBe(9);
	});

	it("keeps a dismissed pair dismissed but refreshes its evidence", () => {
		putSuggestion(sug("a", "t"));
		dismissSuggestion(sug("a", "t"));
		putSuggestion(sug("a", "t", { seedRadiusDeg: 7 }));
		const [s] = suggestionsFor("t");
		expect(s.status).toBe("dismissed");
		expect(s.seedRadiusDeg).toBe(7);
	});

	it("never overwrites an accepted record", () => {
		const s = sug("a", "t");
		putSuggestion(s);
		acceptSuggestion(s);
		putSuggestion(
			sug("a", "t", {
				seedRadiusDeg: 99,
				pose: { yaw: 1, pitch: 0, roll: 0, vfov: 50 },
			}),
		);
		const [kept] = suggestionsFor("t");
		expect(kept.status).toBe("accepted");
		expect(kept.pose.yaw).toBe(100);
	});

	it("dropPending forgets pending records only", () => {
		putSuggestion(sug("a", "t"));
		dropPending("a", "t");
		expect(suggestionsFor("t")).toEqual([]);
		putSuggestion(sug("b", "t"));
		dismissSuggestion(sug("b", "t"));
		dropPending("b", "t");
		expect(suggestionsFor("t")).toHaveLength(1);
		expect(() => dropPending("none", "none")).not.toThrow();
	});
});

describe("accept and revert", () => {
	it("accept writes the pose to the solved slot with method propagated-suggestion and confidence 0", () => {
		const s = sug("a", "t");
		putSuggestion(s);
		acceptSuggestion(s);
		const solved = loadSolvedPose("t");
		expect(solved?.method).toBe(ACCEPTED_METHOD);
		expect(solved?.confidence).toBe(0);
		expect(solved?.pose).toEqual(s.pose);
		expect(suggestionsFor("t")[0].status).toBe("accepted");
	});

	it("revert removes the solved pose when it is still the propagated one and returns to pending", () => {
		const s = sug("a", "t");
		acceptSuggestion(s);
		revertAccepted(s);
		expect(loadSolvedPose("t")).toBeNull();
		expect(suggestionsFor("t")[0].status).toBe("pending");
	});

	it("revert leaves a later solved pose from another method alone", () => {
		const s = sug("a", "t");
		acceptSuggestion(s);
		saveSolvedPose("t", {
			pose: { yaw: 5, pitch: 0, roll: 0, vfov: 50 },
			confidence: 0.9,
			method: "cascade",
			at: "x",
		});
		revertAccepted(s);
		expect(loadSolvedPose("t")?.method).toBe("cascade");
	});

	it("is resilient to corrupt storage and a missing localStorage", () => {
		store.set(storageKey("propagate"), "{oops");
		expect(suggestionsFor("t")).toEqual([]);
		putSuggestion(sug("a", "t")); // overwrites the corrupt record
		expect(suggestionsFor("t")).toHaveLength(1);
		vi.unstubAllGlobals();
		expect(suggestionsFor("t")).toEqual([]);
		expect(() => putSuggestion(sug("a", "t"))).not.toThrow();
	});
});
