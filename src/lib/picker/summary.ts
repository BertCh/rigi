// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Owner-trial summary of a picker log (pure). One "episode" = one `shown` event (the picker opened on a
// photo) up to the next `shown` for the same session + photo; its outcome is the last pick / dismiss in it.
// Picks are the user's choices, not ground truth: these counts say how the picker was used, not how often
// it was right.
import { TAP_MAX_PX } from "./candidates";
import type { PickerLogEntry } from "./schema";

export type EpisodeOutcome =
	| "keptShown"
	| "differentRank"
	| "tapPeak"
	| "dismissed"
	| "noDecision";

export type PickerSummary = {
	events: number;
	sessions: number;
	photos: number;
	firstT: string | null;
	lastT: string | null;
	byKind: Record<string, number>;
	byRenderer: Record<string, number>;
	episodes: number;
	/** episodes by outcome; they sum to `episodes` */
	outcomes: Record<EpisodeOutcome, number>;
	/** candidate picks by rank ("shown" = the pose the app showed when it is not in the top 3) */
	pickRanks: Record<string, number>;
	/** episodes that used tap-a-peak at all */
	episodesWithTap: number;
	tapSolves: {
		count: number;
		/** best result within TAP_MAX_PX */
		consistent: number;
		/** results empty, or the best one worse than TAP_MAX_PX */
		poorOrEmpty: number;
		/** picks that came from a tap solve */
		picked: number;
		/** median best tapPx over solves with results, null when none */
		medianBestPx: number | null;
	};
	/** pick / dismiss events seen before any `shown` for their session + photo (ring trimmed the start) */
	orphanEvents: number;
};

const OUTCOMES: EpisodeOutcome[] = [
	"keptShown",
	"differentRank",
	"tapPeak",
	"dismissed",
	"noDecision",
];

const bump = (r: Record<string, number>, k: string) => {
	r[k] = (r[k] ?? 0) + 1;
};

type Episode = { shownIndex: number; outcome: EpisodeOutcome; tap: boolean };

export function summarizeLog(events: PickerLogEntry[]): PickerSummary {
	const sessions = new Set<string>();
	const photos = new Set<string>();
	const byKind: Record<string, number> = {};
	const byRenderer: Record<string, number> = {};
	const pickRanks: Record<string, number> = {};
	const open = new Map<string, Episode>();
	const done: Episode[] = [];
	const bestPx: number[] = [];
	let consistent = 0;
	let solves = 0;
	let solvePoor = 0;
	let solvePicked = 0;
	let orphanEvents = 0;
	let firstT: string | null = null;
	let lastT: string | null = null;

	for (const e of events) {
		sessions.add(e.session);
		photos.add(e.photoId);
		bump(byKind, e.kind);
		bump(byRenderer, e.renderer);
		if (firstT === null || e.t < firstT) firstT = e.t;
		if (lastT === null || e.t > lastT) lastT = e.t;
		const key = `${e.session}\u0000${e.photoId}`;
		let ep = open.get(key);
		if (e.kind === "shown") {
			if (ep) done.push(ep);
			ep = { shownIndex: e.shownIndex, outcome: "noDecision", tap: false };
			open.set(key, ep);
			continue;
		}
		if (e.kind === "tap") {
			if (ep) ep.tap = true;
			continue;
		}
		if (e.kind === "tap-solve") {
			if (ep) ep.tap = true;
			solves++;
			const best = e.results.length
				? Math.min(...e.results.map((r) => r.tapPx))
				: null;
			if (best === null || best > TAP_MAX_PX) solvePoor++;
			else consistent++;
			if (best !== null) bestPx.push(best);
			continue;
		}
		if (e.kind === "pick") {
			if (e.source === "tap") solvePicked++;
			else
				bump(
					pickRanks,
					e.rank < 0 || e.source === "shown" ? "shown" : String(e.rank),
				);
			if (!ep) {
				orphanEvents++;
				continue;
			}
			ep.outcome =
				e.source === "tap"
					? "tapPeak"
					: e.source === "shown" || e.rank === ep.shownIndex
						? "keptShown"
						: "differentRank";
			continue;
		}
		if (e.kind === "dismiss") {
			if (!ep) orphanEvents++;
			else if (ep.outcome === "noDecision") ep.outcome = "dismissed";
		}
	}
	for (const ep of open.values()) done.push(ep);

	const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<
		EpisodeOutcome,
		number
	>;
	let episodesWithTap = 0;
	for (const ep of done) {
		outcomes[ep.outcome]++;
		if (ep.tap) episodesWithTap++;
	}
	bestPx.sort((a, b) => a - b);
	const m = bestPx.length;
	const medianBestPx = m
		? m % 2
			? bestPx[(m - 1) / 2]
			: (bestPx[m / 2 - 1] + bestPx[m / 2]) / 2
		: null;

	return {
		events: events.length,
		sessions: sessions.size,
		photos: photos.size,
		firstT,
		lastT,
		byKind,
		byRenderer,
		episodes: done.length,
		outcomes,
		pickRanks,
		episodesWithTap,
		tapSolves: {
			count: solves,
			consistent,
			poorOrEmpty: solvePoor,
			picked: solvePicked,
			medianBestPx,
		},
		orphanEvents,
	};
}

/** Plain-text report for the CLI. */
export function formatSummary(s: PickerSummary): string {
	const pct = (n: number) =>
		s.episodes ? ` (${((100 * n) / s.episodes).toFixed(0)}%)` : "";
	const L: string[] = [];
	L.push(
		`events ${s.events}  sessions ${s.sessions}  photos ${s.photos}  ${s.firstT ?? "-"} .. ${s.lastT ?? "-"}`,
	);
	L.push(`renderers ${JSON.stringify(s.byRenderer)}`);
	L.push(`episodes (picker opened on a photo): ${s.episodes}`);
	const names: Record<EpisodeOutcome, string> = {
		keptShown: "kept the shown pose",
		differentRank: "picked a different candidate",
		tapPeak: "solved from tapped peak(s)",
		dismissed: "dismissed",
		noDecision: "no decision (left open)",
	};
	for (const o of OUTCOMES)
		L.push(`  ${names[o].padEnd(30)} ${s.outcomes[o]}${pct(s.outcomes[o])}`);
	L.push(`episodes that used tap-a-peak: ${s.episodesWithTap}`);
	const ranks = Object.keys(s.pickRanks).sort();
	L.push(
		`candidate pick ranks: ${ranks.length ? ranks.map((r) => `${r}:${s.pickRanks[r]}`).join("  ") : "none"}`,
	);
	const t = s.tapSolves;
	L.push(
		`tap solves ${t.count}: tap-consistent ${t.consistent}, poor/empty ${t.poorOrEmpty}, picked ${t.picked}, median best ${t.medianBestPx === null ? "-" : `${t.medianBestPx.toFixed(1)} px`}`,
	);
	if (s.orphanEvents) L.push(`orphan pick/dismiss events: ${s.orphanEvents}`);
	L.push("Picks are the user's choice between suggestions, not ground truth.");
	return L.join("\n");
}
