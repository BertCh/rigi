// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// "Show a pose fast, certify it later" as numbers: User Timing marks for the /photo workspace's phases,
// so a harness (or the devtools Performance panel) reads time-to-first-overlay and time-to-certified
// without instrumenting the engines. Marks only; nothing reads them in the app.
//
//   rigi:photo:start          the engine effect starts (the renderer chunk and probe may still load)
//   rigi:photo:engine         engine.init resolved (photo, terrain and labels exist; pose not final)
//   rigi:photo:first-overlay  the loading card clears ([data-ready]): a pose is on screen
//   rigi:photo:certified      the background second opinion settled, detail.verdict says how
//                             ("none" = no second opinion ran: a saved, shared or unknown-sensor pose,
//                             whose matcher upgrade may still follow; "aborted" = the user took over)
//
// Each mount clears the previous photo's marks at "start", so the entries describe one photo.

export const WORKSPACE_PHASES = [
	"start",
	"engine",
	"first-overlay",
	"certified",
] as const;
export type WorkspacePhase = (typeof WORKSPACE_PHASES)[number];

const markName = (phase: WorkspacePhase) => `rigi:photo:${phase}`;

/** Records `phase` (detail attached when given). Returns its time in ms, null where User Timing is missing. */
export function markWorkspace(
	phase: WorkspacePhase,
	detail?: Record<string, unknown>,
): number | null {
	const perf = globalThis.performance;
	if (typeof perf?.mark !== "function") return null;
	try {
		if (phase === "start" && typeof perf.clearMarks === "function")
			for (const p of WORKSPACE_PHASES) perf.clearMarks(markName(p));
		return perf.mark(markName(phase), detail ? { detail } : undefined)
			.startTime;
	} catch {
		return null;
	}
}

/** The latest time of each recorded phase, in ms since time origin. */
export function workspaceTimings(): Partial<Record<WorkspacePhase, number>> {
	const perf = globalThis.performance;
	const out: Partial<Record<WorkspacePhase, number>> = {};
	if (typeof perf?.getEntriesByName !== "function") return out;
	for (const p of WORKSPACE_PHASES) {
		const e = perf.getEntriesByName(markName(p), "mark");
		const last = e[e.length - 1];
		if (last) out[p] = last.startTime;
	}
	return out;
}
