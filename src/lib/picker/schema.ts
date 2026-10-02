// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Event schema of the picker correction log (roadmap R4), version 1, and the parser for stored / exported
// logs. Pure: type-only imports, no DOM, so node scripts (scripts/picker/summarize-log.ts) can use it.
//
// Storage is a bare JSON array of PickerLogEntry under PICKER_LOG_KEY; the exported file wraps the same
// array as PickerLogFile. Rules for changing this: additive optional fields keep version 1; anything that
// renames or re-types a field bumps PICKER_LOG_VERSION and gets a new key + schema string. The parser
// drops entries it cannot recognise instead of throwing, so an older or damaged log still loads.
//
// Hygiene: poses and rankings only (no pixels). A pick is the user's choice between suggestions, never
// ground truth; it must be blind-verified before it enters a benchmark.
import type { Pose } from "#/lib/camera";
import type { AlignState, Verify } from "#/lib/ontology/crosswalk/pose";
import type { CandidateSource } from "./candidates";

export const PICKER_LOG_VERSION = 1;
/** `schema` field of the exported file. */
export const PICKER_LOG_SCHEMA = "rigi.picker.log.v1";

export type LoggedCandidate = {
	rank: number;
	source: CandidateSource;
	sourceRank: number;
	score: number | null;
	pose: Pose;
	/** separation from the pose shown when the picker opened (deg) */
	sepFromShownDeg: number;
};

export type PickerEvent =
	| {
			kind: "shown";
			candidates: LoggedCandidate[];
			/** index into candidates of the pose the app showed, -1 when none is within the dedupe radius */
			shownIndex: number;
	  }
	| { kind: "preview"; rank: number; source: CandidateSource }
	| {
			kind: "pick";
			rank: number;
			source: CandidateSource;
			before: Pose;
			after: Pose;
			/** "tap" picks: the tapped peaks that produced it */
			taps?: LoggedTap[];
	  }
	| { kind: "revert"; to: Pose }
	/** the app moved the pose itself mid-preview (e.g. a late matcher upgrade): the preview was dropped */
	| { kind: "superseded"; to: Pose }
	| {
			kind: "tap";
			u: number;
			v: number;
			/** names offered, nearest first, with their angular distance to the tap ray (deg) */
			offered: { name: string; sepDeg: number; distKm: number }[];
			chosen: string | null;
	  }
	| {
			kind: "tap-solve";
			taps: LoggedTap[];
			before: Pose;
			results: {
				pose: Pose;
				tapPx: number;
				skyline: number | null;
				from: CandidateSource;
				fromRank: number;
			}[];
	  }
	| { kind: "dismiss" };

export type LoggedTap = {
	name: string;
	world: [number, number, number];
	u: number;
	v: number;
};

export type PickerLogEntry = PickerEvent & {
	t: string;
	photoId: string;
	/** "three": entries logged before the three.js renderer was removed (2026-10-01). */
	renderer: "three" | "deck" | "webgpu";
	/** app state when the event happened */
	alignState: AlignState | null;
	verify: Verify;
	/** one id per picker session (engine lifetime), to group events */
	session: string;
};

export const PICKER_EVENT_KINDS = [
	"shown",
	"preview",
	"pick",
	"revert",
	"superseded",
	"tap",
	"tap-solve",
	"dismiss",
] as const satisfies readonly PickerEvent["kind"][];

/** The exported file. `app` is whatever build info the page has (no git stamp exists in the app). */
export type PickerLogFile = {
	schema: typeof PICKER_LOG_SCHEMA;
	version: typeof PICKER_LOG_VERSION;
	exportedAt: string;
	app: { name: "rigi"; mode: string | null; userAgent: string | null };
	count: number;
	events: PickerLogEntry[];
};

const isObj = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number =>
	typeof x === "number" && Number.isFinite(x);
const isPose = (x: unknown): boolean =>
	isObj(x) &&
	["yaw", "pitch", "roll", "vfov"].every((k) => isNum((x as never)[k]));

/** Structural check of one entry (envelope + the fields the summariser reads). */
export function isPickerLogEntry(x: unknown): x is PickerLogEntry {
	if (!isObj(x)) return false;
	if (typeof x.t !== "string" || typeof x.photoId !== "string") return false;
	if (typeof x.session !== "string") return false;
	if (
		x.renderer !== "three" &&
		x.renderer !== "deck" &&
		x.renderer !== "webgpu"
	)
		return false;
	switch (x.kind) {
		case "shown":
			return (
				Array.isArray(x.candidates) &&
				x.candidates.every((c) => isObj(c) && isNum(c.rank)) &&
				isNum(x.shownIndex)
			);
		case "preview":
			return isNum(x.rank) && typeof x.source === "string";
		case "pick":
			return (
				isNum(x.rank) &&
				typeof x.source === "string" &&
				isPose(x.before) &&
				isPose(x.after)
			);
		case "revert":
		case "superseded":
			return isPose(x.to);
		case "tap":
			return isNum(x.u) && isNum(x.v) && Array.isArray(x.offered);
		case "tap-solve":
			return (
				Array.isArray(x.taps) &&
				Array.isArray(x.results) &&
				x.results.every((r) => isObj(r) && isNum(r.tapPx))
			);
		case "dismiss":
			return true;
		default:
			return false;
	}
}

/**
 * Entries from a stored value or an exported file: accepts the bare array, a PickerLogFile, or its `events`.
 * Anything unrecognised (corrupt, other version, wrong shape) is dropped; never throws.
 */
export function parsePickerLog(raw: unknown): {
	entries: PickerLogEntry[];
	dropped: number;
} {
	let list: unknown[] = [];
	if (Array.isArray(raw)) list = raw;
	else if (isObj(raw) && Array.isArray(raw.events)) {
		const v = raw.version;
		if (v === undefined || v === PICKER_LOG_VERSION) list = raw.events;
		else return { entries: [], dropped: raw.events.length };
	}
	const entries = list.filter(isPickerLogEntry);
	return { entries, dropped: list.length - entries.length };
}

/** parsePickerLog on JSON text; null when the text is not JSON. */
export function parsePickerLogText(text: string) {
	try {
		return parsePickerLog(JSON.parse(text));
	} catch {
		return null;
	}
}
