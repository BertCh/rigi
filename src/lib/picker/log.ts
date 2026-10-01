// Correction log for the top-3 picker / tap-a-peak (roadmap R4: "log every correction"). Every event the
// user causes is appended to a local ring in localStorage so it can later become training / eval data;
// `downloadPickerLog()` saves it as JSON. Nothing is sent anywhere.
//
// Hygiene: the log records poses and candidate rankings only (no pixels). It is user-confirmed data,
// never ground truth on its own: a pick is what a person chose between suggestions, and must be
// blind-verified before it enters a benchmark (reports/wild-benchmark rules).
import type { Pose } from "#/lib/camera";
import { storageKey } from "#/lib/ontology/core/storage";
import type { AlignState, Verify } from "#/lib/ontology/crosswalk/pose";
import type { CandidateSource } from "./candidates";

export const PICKER_LOG_KEY = storageKey("pickerLog");
/** Ring size: oldest events drop first (a few hundred bytes each). */
export const PICKER_LOG_MAX = 2000;

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
	renderer: "three" | "deck";
	/** app state when the event happened */
	alignState: AlignState | null;
	verify: Verify;
	/** one id per picker session (engine lifetime), to group events */
	session: string;
};

const mem: PickerLogEntry[] = [];

function read(): PickerLogEntry[] {
	try {
		const s = localStorage.getItem(PICKER_LOG_KEY);
		const a = s ? JSON.parse(s) : [];
		return Array.isArray(a) ? a : [];
	} catch {
		return [...mem];
	}
}

/** Append one event (localStorage when available, else in memory for this page). Never throws. */
export function logPickerEvent(e: PickerLogEntry): void {
	const all = read();
	all.push(e);
	const trimmed = all.slice(-PICKER_LOG_MAX);
	mem.splice(0, mem.length, ...trimmed);
	try {
		localStorage.setItem(PICKER_LOG_KEY, JSON.stringify(trimmed));
	} catch {
		/* private mode / quota: the in-memory copy still downloads */
	}
	if (import.meta.env?.DEV) window.__pickerLog = trimmed;
}

export function readPickerLog(): PickerLogEntry[] {
	return read();
}

/** Save the whole log as `rigi-picker-log-<date>.json`. */
export function downloadPickerLog(): void {
	const blob = new Blob(
		[JSON.stringify({ schema: "rigi.picker.log.v1", events: read() }, null, 1)],
		{ type: "application/json" },
	);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `rigi-picker-log-${new Date().toISOString().slice(0, 10)}.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
