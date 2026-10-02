// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// INIT -> TRACK -> LOST phase machine. Pure: it sees one verdict per image solve and says when a
// relocalisation is needed; the tracker owns the I/O.
import type { TrackerPhase } from "../live/contract";

/** Verdict of one image solve. "skip" = unobserved frame (too few columns), not a failure. */
export type SolveVerdict = "good" | "bad" | "skip";

export interface MachineConfig {
	lostAfterFailures: number;
	relocaliseRetrySeconds: number;
}

export class TrackStateMachine {
	phase: TrackerPhase = "init";
	private failures = 0;
	private lastRelocaliseTime = Number.NEGATIVE_INFINITY;
	/** Relocalisation is running. */
	relocalising = false;

	constructor(private readonly config: MachineConfig) {}

	/** Consecutive failed solves in TRACK. */
	get failureCount() {
		return this.failures;
	}

	/** A solve of a TRACK frame. Returns the new phase. */
	observe(verdict: SolveVerdict): TrackerPhase {
		if (this.phase !== "track") return this.phase;
		if (verdict === "good") this.failures = 0;
		else if (verdict === "bad") {
			this.failures++;
			if (this.failures >= this.config.lostAfterFailures) this.phase = "lost";
		}
		return this.phase;
	}

	/** True when a relocalise should start now (INIT or LOST, none running, retry interval over). */
	shouldRelocalise(time: number): boolean {
		if (this.phase === "track" || this.relocalising) return false;
		return time - this.lastRelocaliseTime >= this.config.relocaliseRetrySeconds;
	}

	beginRelocalise(time: number) {
		this.relocalising = true;
		this.lastRelocaliseTime = time;
	}

	/** A relocalise ended; `accepted` moves to TRACK. */
	endRelocalise(accepted: boolean) {
		this.relocalising = false;
		if (accepted) {
			this.phase = "track";
			this.failures = 0;
		}
	}

	/** Back to INIT (reset). */
	reset() {
		this.phase = "init";
		this.failures = 0;
		this.relocalising = false;
		this.lastRelocaliseTime = Number.NEGATIVE_INFINITY;
	}
}
