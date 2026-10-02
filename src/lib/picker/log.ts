// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Correction log for the top-3 picker / tap-a-peak (roadmap R4: "log every correction"). Every event the
// user causes is appended to a local ring in localStorage so it can later become training / eval data;
// `downloadPickerLog()` saves it as JSON, `clearPickerLog()` empties it. Nothing is sent anywhere.
// The event schema, versioning and the tolerant parser live in schema.ts; the summariser is summary.ts.
//
// Hygiene: the log records poses and candidate rankings only (no pixels). It is user-confirmed data,
// never ground truth on its own: a pick is what a person chose between suggestions, and must be
// blind-verified before it enters a benchmark (reports/wild-benchmark rules).
import { storageKey } from "#/lib/ontology/core/storage";
import {
	PICKER_LOG_SCHEMA,
	PICKER_LOG_VERSION,
	type PickerLogEntry,
	type PickerLogFile,
	parsePickerLog,
} from "./schema";

export * from "./schema";

export const PICKER_LOG_KEY = storageKey("pickerLog");
/** Ring size: oldest events drop first (a few hundred bytes each). */
export const PICKER_LOG_MAX = 2000;

/** In-memory copy: the fallback when storage throws or is corrupt, so the log still exports this page. */
const mem: PickerLogEntry[] = [];
/** setItem threw last time (quota / private mode): an empty store then means "not persisted", not "cleared". */
let persistFailed = false;
const listeners = new Set<() => void>();

/** Call `fn` after every append / clear (the panel's counter). Returns the unsubscribe. */
export function subscribePickerLog(fn: () => void): () => void {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}
const notify = () => {
	for (const fn of listeners) fn();
};

function read(): PickerLogEntry[] {
	// a failed write means storage holds a stale prefix; memory holds everything this page logged
	if (persistFailed) return [...mem];
	try {
		const s = localStorage.getItem(PICKER_LOG_KEY);
		if (s === null) return [];
		const { entries } = parsePickerLog(JSON.parse(s));
		return entries;
	} catch {
		// storage unavailable or the stored text is not JSON: whatever this page logged is still in memory
		return [...mem];
	}
}

function mirror(entries: PickerLogEntry[]) {
	try {
		if (import.meta.env?.DEV) window.__pickerLog = entries;
	} catch {
		/* no window (node) */
	}
}

/** Append one event (localStorage when available, else in memory for this page). Never throws. */
export function logPickerEvent(e: PickerLogEntry): void {
	const trimmed = [...read(), e].slice(-PICKER_LOG_MAX);
	mem.splice(0, mem.length, ...trimmed);
	try {
		localStorage.setItem(PICKER_LOG_KEY, JSON.stringify(trimmed));
		persistFailed = false;
	} catch {
		persistFailed = true;
		/* private mode / quota: the in-memory copy still downloads */
	}
	mirror(trimmed);
	notify();
}

export function readPickerLog(): PickerLogEntry[] {
	return read();
}

/** Number of stored events. */
export function countPickerLog(): number {
	return read().length;
}

/** Forget every event (storage and memory). Never throws. */
export function clearPickerLog(): void {
	mem.length = 0;
	persistFailed = false;
	try {
		localStorage.removeItem(PICKER_LOG_KEY);
	} catch {
		/* storage unavailable: nothing persisted to clear */
	}
	mirror([]);
	notify();
}

/** The exported file for the current log (pure apart from the clock). */
export function buildPickerLogFile(
	events: PickerLogEntry[],
	now = new Date(),
): PickerLogFile {
	let userAgent: string | null = null;
	try {
		userAgent = navigator.userAgent ?? null;
	} catch {
		/* no navigator */
	}
	return {
		schema: PICKER_LOG_SCHEMA,
		version: PICKER_LOG_VERSION,
		exportedAt: now.toISOString(),
		app: { name: "rigi", mode: import.meta.env?.MODE ?? null, userAgent },
		count: events.length,
		events,
	};
}

/** Save the whole log as `rigi-picker-log-<date>.json`. */
export function downloadPickerLog(): void {
	const blob = new Blob([JSON.stringify(buildPickerLogFile(read()), null, 1)], {
		type: "application/json",
	});
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `rigi-picker-log-${new Date().toISOString().slice(0, 10)}.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
