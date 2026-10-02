// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The causal script of an animated diagram (pod D spec,
// reports/gipfelbuch-explainers-2026-10-02/D-diagrams.md). A diagram does not loop a sine wave: it plays
// a short story once, in a fixed order, and then rests on its last frame:
//   setup    → the scene and the starting state (the phone's guess, an empty profile);
//   evidence → what is measured (the photo's skyline, a tap, a ray sample);
//   change   → what the method does with it (the solver turns, the running maximum climbs);
//   result   → the answer, held (the pose locks, the horizon is drawn, the residual is small).
// Every overlay's progress is a pure function of the clock, so the settled frame is just `t = settle`, and
// reduced motion, webdriver and print show it without running anything. Nothing here touches React.

export type BeatKind = "setup" | "evidence" | "change" | "result";

export interface Beat {
	/** Stable id, used by the stepper and by specs ("guess", "tap-1", "sweep"). */
	id: string;
	kind: BeatKind;
	/** Seconds the beat plays. The last beat is the rest pose: its end is the settled frame. */
	dur: number;
	/** A short hand caption for the stepper ("the phone's guess"). */
	label?: string;
}

export interface Script {
	beats: readonly Beat[];
	/** Start time (s) of each beat. */
	starts: readonly number[];
	/** End of the last beat: the settled frame. */
	settle: number;
}

export interface BeatState {
	index: number;
	beat: Beat;
	/** Seconds into the beat. */
	local: number;
	/** Progress through the beat, 0..1 (linear; ease it with `ramp` or an easing). */
	u: number;
	/** True at and after the settled frame. */
	settled: boolean;
}

/** Builds a script. The kinds must keep the causal order: setup ≤ evidence ≤ change ≤ result. */
export function defineScript(beats: readonly Beat[]): Script {
	const order: Record<BeatKind, number> = {
		setup: 0,
		evidence: 1,
		change: 2,
		result: 3,
	};
	// A script out of causal order (a result before its evidence) is a figure bug, not a runtime case.
	for (let i = 1; i < beats.length; i++)
		if (order[beats[i].kind] < order[beats[i - 1].kind])
			throw new Error(
				`script: beat "${beats[i].id}" (${beats[i].kind}) after "${beats[i - 1].id}" (${beats[i - 1].kind})`,
			);
	const starts: number[] = [];
	let t = 0;
	for (const b of beats) {
		starts.push(t);
		t += Math.max(0, b.dur);
	}
	return { beats, starts, settle: t };
}

/** The beat playing at `t` seconds (clamped to the script; past the end it is the settled last beat). */
export function beatAt(script: Script, t: number): BeatState {
	const n = script.beats.length;
	const tt = Math.max(0, Math.min(script.settle, t));
	let index = 0;
	while (index < n - 1 && script.starts[index + 1] <= tt) index++;
	const beat = script.beats[index];
	const local = tt - script.starts[index];
	return {
		index,
		beat,
		local,
		u: beat.dur > 0 ? Math.min(1, local / beat.dur) : 1,
		settled: t >= script.settle,
	};
}

/** Start time (s) of a beat by id; throws on an unknown id (a typo in a figure). */
export function startOf(script: Script, id: string): number {
	const i = script.beats.findIndex((b) => b.id === id);
	if (i < 0) throw new Error(`script: no beat "${id}"`);
	return script.starts[i];
}

/** Smoothstep, the landing's ramp (how-it-works `ramp`). */
export const smooth = (x: number) => {
	const k = Math.max(0, Math.min(1, x));
	return k * k * (3 - 2 * k);
};

/** Cubic ease-out, the landing's reveal sweep: lunges, then slows onto the answer. */
export const easeOut = (x: number) => {
	const k = Math.max(0, Math.min(1, x));
	return 1 - (1 - k) ** 3;
};

/**
 * 0..1 progress of an overlay that starts `delay` s into beat `id` and takes `dur` s, eased (smoothstep by
 * default). Before it starts it is 0; after it ends it stays 1, so a later beat keeps what earlier beats drew.
 */
export function ramp(
	script: Script,
	t: number,
	id: string,
	delay = 0,
	dur = 0.8,
	ease: (x: number) => number = smooth,
): number {
	const t0 = startOf(script, id) + delay;
	if (dur <= 0) return t >= t0 ? 1 : 0;
	return ease((t - t0) / dur);
}

/**
 * True while beat `id` (or any later beat) is playing: the layer it introduces stays drawn from then on.
 * Use it for layers that switch on, `ramp` for layers that grow.
 */
export function reached(script: Script, t: number, id: string): boolean {
	return t >= startOf(script, id);
}

/**
 * The time a stepper button jumps to: the end of beat `index` (its state complete), so stepping shows each
 * beat's finished picture, and the last step is the settled frame.
 */
export function stepTime(script: Script, index: number): number {
	const i = Math.max(0, Math.min(script.beats.length - 1, index));
	return script.starts[i] + script.beats[i].dur;
}

/**
 * Quantises a clock to `fps` frames per second, so a figure that re-renders from the clock commits at most
 * that often (the landing's how-it-works commits at about 30 per second).
 */
export function quantise(t: number, fps = 30): number {
	return Math.round(t * fps) / fps;
}
