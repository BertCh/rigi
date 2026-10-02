// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Per-device record of propagated suggestions and the user's decisions (localStorage; client only).
// Accepting stores the pose through the roll's own solved-pose slot with method "propagated-suggestion"
// and confidence 0, so it is never HIGH, never anchors further suggestions (plan.ts anchorKind) and is
// distinguishable everywhere the solved pose is read. Nothing here feeds benchmarks.

import { storageKey } from "#/lib/ontology/core/storage";
import type { Pose } from "../../camera";
import { loadSavedPose } from "../../photos";
import { loadSolvedPose, saveSolvedPose } from "../roll";
import type { RollPhoto } from "../types";
import { ACCEPTED_METHOD, type AnchorKind, type PROVENANCE } from "./plan";

export type StoredSuggestion = {
	provenance: typeof PROVENANCE;
	targetId: string;
	anchorId: string;
	anchorKind: AnchorKind;
	pose: Pose;
	seedRadiusDeg: number;
	evidence: {
		inliers: number;
		rmsPx: number | null;
		overlap: number;
		fwdBwdDeg: number | null;
		cycleDeg: number | null;
		baselineM: number;
		dtS: number;
	};
	cautions: string[];
	status: "pending" | "accepted" | "dismissed";
	at: string;
};

const KEY = storageKey("propagate");

function readAll(): Record<string, StoredSuggestion> {
	try {
		const raw = localStorage.getItem(KEY);
		return raw ? (JSON.parse(raw) as Record<string, StoredSuggestion>) : {};
	} catch {
		return {};
	}
}
function writeAll(all: Record<string, StoredSuggestion>) {
	try {
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		// storage unavailable: suggestions live for this page only
	}
}
const k = (anchorId: string, targetId: string) => `${anchorId}>${targetId}`;

export function suggestionsFor(targetId: string): StoredSuggestion[] {
	return Object.values(readAll()).filter((s) => s.targetId === targetId);
}

/** Record a fresh gated suggestion (a dismissed one stays dismissed; an accepted one is kept). */
export function putSuggestion(s: StoredSuggestion) {
	const all = readAll();
	const prev = all[k(s.anchorId, s.targetId)];
	// an accepted record keeps the pose that was written to the solved slot (Undo must match it)
	if (prev?.status === "accepted") return;
	all[k(s.anchorId, s.targetId)] =
		prev?.status === "dismissed" ? { ...s, status: "dismissed" } : s;
	writeAll(all);
}

/** A re-run no longer gates this pair: forget a still-pending suggestion (decisions are kept). */
export function dropPending(anchorId: string, targetId: string) {
	const all = readAll();
	if (all[k(anchorId, targetId)]?.status !== "pending") return;
	delete all[k(anchorId, targetId)];
	writeAll(all);
}

/**
 * User accepts: the pose becomes the photo's solved pose with provenance kept. Refused (returns false, nothing
 * written) when the photo already has a saved, ground-truth or solved pose: `poseSource` is the photo's current
 * source when the caller knows it, and the saved and solved slots are checked here regardless. A second
 * suggestion therefore needs the first accept undone (revertAccepted) first.
 */
export function acceptSuggestion(
	s: StoredSuggestion,
	poseSource?: RollPhoto["poseSource"],
): boolean {
	if (poseSource !== undefined && poseSource !== "prior") return false;
	if (loadSolvedPose(s.targetId) || loadSavedPose(s.targetId)) return false;
	saveSolvedPose(s.targetId, {
		pose: s.pose,
		confidence: 0,
		method: ACCEPTED_METHOD,
		at: new Date().toISOString(),
	});
	const all = readAll();
	all[k(s.anchorId, s.targetId)] = { ...s, status: "accepted" };
	writeAll(all);
	return true;
}

export function dismissSuggestion(s: StoredSuggestion) {
	const all = readAll();
	all[k(s.anchorId, s.targetId)] = { ...s, status: "dismissed" };
	writeAll(all);
}

/** Undo an accept: remove the solved pose only if it is still the propagated one. */
export function revertAccepted(s: StoredSuggestion) {
	// only the accepted record owns the solved slot: undo of another suggestion for this target must not clear it
	const mine = readAll()[k(s.anchorId, s.targetId)]?.status === "accepted";
	if (mine && loadSolvedPose(s.targetId)?.method === ACCEPTED_METHOD)
		saveSolvedPose(s.targetId, null);
	const all = readAll();
	all[k(s.anchorId, s.targetId)] = { ...s, status: "pending" };
	writeAll(all);
}
