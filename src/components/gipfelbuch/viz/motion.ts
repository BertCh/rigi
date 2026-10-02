// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { revealsImmediately } from "./hooks";

// The explainer grammar's motion half (reports/gipfelbuch-explainers-2026-10-02/grammar.md §1). The
// tokens unify the landing's values (site/RevealLoop, FadeIn, the poster crossfades) with the
// notebook's own (GeoSpill's slide, the pen draw-on, PhotoStory's beat). Timelines are pure, so the
// order and timing of a figure's beats can be specced; the hooks re-render once per beat at most.

/** Durations in ms (except `resultHold`, a factor of `beat`, and `nearMargin`, in px). */
export const MOTION = {
	/** Hover, toggle, focus. */
	quick: 160,
	/** A layer enters or leaves (opacity). */
	fade: 420,
	/** A lit frame fades before a replay (RevealLoop FADE_OUT). */
	replayFade: 450,
	/** A pose or a mark settles on its new place (GeoSpill's slide). */
	settle: 620,
	/** Poster to image or engine. */
	crossfade: 700,
	/** Pen draw-on of one stroke (notebook.css nb-draw). */
	draw: 900,
	/** Figure entrance: fade and rise, once. */
	enter: 1000,
	/** Dwell of one beat in an auto-advancing sequence. */
	beat: 2800,
	/** A bloom or reveal across a whole frame (RevealLoop SWEEP). */
	sweep: 4200,
	/** Pause before a sweep or a first beat. */
	lead: 80,
	/** Pointer rest on a finished frame before it replays. */
	hoverReplay: 350,
	/** Between sibling strokes, stations or layers. */
	stagger: 110,
	/** Between the labels of one layer. */
	staggerLabel: 60,
	/** The result beat dwells this many beats. */
	resultHold: 1.6,
	/** Heavy content mounts this many px before it is on screen. */
	nearMargin: 600,
	/** Frame cap for any rAF loop (canvas, or a computed diagram's clock). */
	fps: 30,
	/** A camera turn drawn continuously (with EASE.inOut): long enough to follow, not a jump. */
	turn: 1600,
	/** The eye's trace sweeping across the frame (EASE.linear: an even scan). */
	trace: 1300,
	/** A short pen mark: a strike, a tick, a check. */
	mark: 280,
} as const;

/** Share of the frame (or of the viewport, if taller) on screen that arms a single sweep or bloom (RevealLoop). */
export const ARM = 0.75;
/** Share that arms a beat sequence (the landing's how-it-works scene): it starts while still rising into view. */
export const ARM_SEQUENCE = 0.45;
/** Below this share a sequence pauses, and a finished one re-arms to replay on return. */
export const RESET = 0.2;

/** Easings as CSS timing functions. No springs, no overshoot: a measured mark never passes its pixel. */
export const EASE = {
	/** Blooms, settles, a mark arriving: `1-(1-t)^3`. */
	out: "cubic-bezier(0.33, 1, 0.68, 1)",
	/** Figure entrance (Tailwind ease-out, as the landing's FadeIn). */
	enter: "cubic-bezier(0, 0, 0.2, 1)",
	/** Pen draw-on. */
	draw: "cubic-bezier(0.55, 0.1, 0.3, 1)",
	/** A programmed scrub or wipe between two states (never a drag). */
	inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
	/** UI chrome, view transitions. */
	standard: "cubic-bezier(0.2, 0, 0, 1)",
	/** A ping-pong demo scrub, a replay fade, a reader's drag. */
	linear: "linear",
} as const;
export type EaseName = keyof typeof EASE;

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of t ∈ [0, 1] (Newton, then bisection). */
export function cubicBezier(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
): (t: number) => number {
	const bez = (u: number, a: number, b: number) =>
		3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
	const dBez = (u: number, a: number, b: number) =>
		3 * a * (1 - u) ** 2 + 6 * (b - a) * u * (1 - u) + 3 * (1 - b) * u ** 2;
	return (t: number) => {
		if (t <= 0) return 0;
		if (t >= 1) return 1;
		let u = t;
		for (let i = 0; i < 8; i++) {
			const err = bez(u, x1, x2) - t;
			if (Math.abs(err) < 1e-7) return bez(u, y1, y2);
			const d = dBez(u, x1, x2);
			if (Math.abs(d) < 1e-6) break;
			u -= err / d;
		}
		let lo = 0;
		let hi = 1;
		u = t;
		for (let i = 0; i < 40; i++) {
			const x = bez(u, x1, x2);
			if (Math.abs(x - t) < 1e-7) break;
			if (x < t) lo = u;
			else hi = u;
			u = (lo + hi) / 2;
		}
		return bez(u, y1, y2);
	};
}

/** The easings as JS functions, matching `EASE`. */
export const ease: Record<EaseName, (t: number) => number> = {
	out: (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3,
	enter: cubicBezier(0, 0, 0.2, 1),
	draw: cubicBezier(0.55, 0.1, 0.3, 1),
	inOut: cubicBezier(0.65, 0, 0.35, 1),
	standard: cubicBezier(0.2, 0, 0, 1),
	linear: (t) => Math.min(1, Math.max(0, t)),
};

/** A CSS `transition` for `props`, from tokens: `transitionOf(["opacity"], "fade", "out", 110)`. */
export function transitionOf(
	props: readonly string[],
	duration: keyof typeof MOTION | number,
	easing: EaseName = "out",
	delay = 0,
): string {
	const ms = typeof duration === "number" ? duration : MOTION[duration];
	return props
		.map((p) => `${p} ${ms}ms ${EASE[easing]}${delay ? ` ${delay}ms` : ""}`)
		.join(", ");
}

/** Delay (ms) of the i-th sibling: strokes, stations, layers (`staggerLabel` for labels). */
export const stagger = (i: number, step: number = MOTION.stagger, base = 0) =>
	base + Math.max(0, i) * step;

// ---- beats: the causal script (grammar §1.3) ----

export type BeatKind = "setup" | "evidence" | "change" | "result";
export const BEAT_ORDER: readonly BeatKind[] = [
	"setup",
	"evidence",
	"change",
	"result",
];

export interface BeatSpec {
	id: string;
	kind: BeatKind;
	/** Stepper text. */
	label?: string;
	/** ms on this beat while auto-advancing; default `MOTION.beat` (the result beat ×1.6). */
	dwell?: number;
}

export interface TimedBeat {
	id: string;
	kind: BeatKind;
	start: number;
	end: number;
}

export interface Timeline {
	beats: TimedBeat[];
	total: number;
}

/** The default dwell of a beat of `kind`. */
export const dwellOf = (kind: BeatKind, beat: number = MOTION.beat) =>
	kind === "result" ? Math.round(beat * MOTION.resultHold) : beat;

/** Start and end (ms) of each beat. */
export function buildTimeline(beats: readonly BeatSpec[]): Timeline {
	let t = 0;
	const out = beats.map((b) => {
		const start = t;
		t += Math.max(0, b.dwell ?? dwellOf(b.kind));
		return { id: b.id, kind: b.kind, start, end: t };
	});
	return { beats: out, total: t };
}

/**
 * Why a script breaks the grammar, or null: kinds must not go backwards (setup → evidence → change →
 * result, each may repeat or be skipped) and the last beat must be a result. For specs and dev checks.
 */
export function beatScriptProblem(beats: readonly BeatSpec[]): string | null {
	if (!beats.length) return "no beats";
	for (let i = 1; i < beats.length; i++)
		if (
			BEAT_ORDER.indexOf(beats[i].kind) < BEAT_ORDER.indexOf(beats[i - 1].kind)
		)
			return `beat ${beats[i].id} (${beats[i].kind}) comes after ${beats[i - 1].kind}`;
	if (beats[beats.length - 1].kind !== "result")
		return "the last beat is not a result";
	return null;
}

export interface TimelineSample {
	index: number;
	kind: BeatKind;
	/** 0..1 within the beat. */
	progress: number;
	/** Past the end (never, with `loop`). */
	done: boolean;
}

/** Where a timeline is `ms` after it started. Assumes at least one beat. */
export function sampleTimeline(
	tl: Timeline,
	ms: number,
	{ loop = false }: { loop?: boolean } = {},
): TimelineSample {
	const last = tl.beats.length - 1;
	if (tl.total <= 0)
		return { index: last, kind: tl.beats[last].kind, progress: 1, done: true };
	let t = Math.max(0, ms);
	if (loop) t %= tl.total;
	else if (t >= tl.total)
		return { index: last, kind: tl.beats[last].kind, progress: 1, done: true };
	for (let i = 0; i <= last; i++) {
		const b = tl.beats[i];
		if (t < b.end) {
			const span = b.end - b.start;
			return {
				index: i,
				kind: b.kind,
				progress: span > 0 ? (t - b.start) / span : 1,
				done: false,
			};
		}
	}
	return { index: last, kind: tl.beats[last].kind, progress: 1, done: true };
}

/** The spill's pose for a beat: the guess (0) until the change, the solved pose (1) from it. */
export const spillTAt = (kind: BeatKind): 0 | 1 =>
	kind === "change" || kind === "result" ? 1 : 0;

// ---- playback state (pure, so the rules are specced) ----

export type Playback = "loop" | "once";

export interface BeatState {
	index: number;
	playing: boolean;
	/** The reader took the stepper: autoplay stays off until `play`. */
	manual: boolean;
}

export type BeatAction =
	| { type: "start" }
	| { type: "advance" }
	| { type: "set"; index: number }
	| { type: "play" }
	| { type: "pause" }
	| { type: "replay" };

/** The static frame: the last beat, not playing. */
export const settledBeats = (count: number): BeatState => ({
	index: Math.max(0, count - 1),
	playing: false,
	manual: false,
});

/**
 * One step of a sequence's playback. `start` (motion allowed, on the client) rewinds to the first beat
 * and plays; `advance` is the timer; `set` is the reader (it ends autoplay); `play` resumes (from the
 * first beat when a `once` sequence has finished); `replay` restarts a finished sequence.
 */
export function beatReducer(
	s: BeatState,
	a: BeatAction,
	count: number,
	playback: Playback,
): BeatState {
	const last = Math.max(0, count - 1);
	switch (a.type) {
		case "start":
			return { index: 0, playing: count > 1, manual: false };
		case "advance": {
			if (!s.playing) return s;
			if (s.index < last) return { ...s, index: s.index + 1 };
			return playback === "loop"
				? { ...s, index: 0 }
				: { ...s, playing: false };
		}
		case "set":
			return {
				index: Math.min(last, Math.max(0, Math.round(a.index))),
				playing: false,
				manual: true,
			};
		case "play":
			return {
				index: playback === "once" && s.index >= last ? 0 : s.index,
				playing: count > 1,
				manual: false,
			};
		case "pause":
			return { ...s, playing: false };
		case "replay":
			return { index: 0, playing: count > 1, manual: false };
	}
}

/** Share of an element on screen: its visible height over its height, or the viewport's if taller. */
export function shownShare(
	visibleHeight: number,
	height: number,
	viewHeight: number,
): number {
	const span = Math.min(height, viewHeight);
	return span > 0 ? Math.min(1, Math.max(0, visibleHeight / span)) : 0;
}

/** Hysteresis between ARM and RESET: armed from `arm` up, disarmed below `reset`, else unchanged. */
export const nextArmed = (
	armed: boolean,
	share: number,
	arm = ARM,
	reset = RESET,
): boolean => (share >= arm ? true : share < reset ? false : armed);

// ---- hooks ----

/**
 * False under reduced motion, webdriver, print and without IntersectionObserver, and on the server and
 * first paint (the static frame is the design); true on a client where motion is fine.
 */
export function useMotionAllowed(): boolean {
	const [allowed, setAllowed] = useState(false);
	useEffect(() => {
		const update = () => setAllowed(!revealsImmediately());
		const off = () => setAllowed(false);
		update();
		const m = window.matchMedia("(prefers-reduced-motion: reduce)");
		m.addEventListener?.("change", update);
		window.addEventListener("beforeprint", off);
		window.addEventListener("afterprint", update);
		return () => {
			m.removeEventListener?.("change", update);
			window.removeEventListener("beforeprint", off);
			window.removeEventListener("afterprint", update);
		};
	}, []);
	return allowed;
}

const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * `armed` while the element is shown past ARM (with hysteresis down to RESET); `near` once it is within
 * `MOTION.nearMargin` px (one-shot, for mounting heavy content). Without IntersectionObserver both are true.
 */
export function useArmedInView<T extends Element = HTMLDivElement>(
	opts: { arm?: number; reset?: number; nearMargin?: number } = {},
): { ref: RefObject<T | null>; armed: boolean; near: boolean } {
	const { arm = ARM, reset = RESET, nearMargin = MOTION.nearMargin } = opts;
	const ref = useRef<T>(null);
	const [armed, setArmed] = useState(false);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (typeof IntersectionObserver === "undefined") {
			setArmed(true);
			setNear(true);
			return;
		}
		const armIo = new IntersectionObserver(
			([e]) => {
				const viewH = e.rootBounds?.height ?? window.innerHeight;
				const share = e.isIntersecting
					? shownShare(
							e.intersectionRect.height,
							e.boundingClientRect.height,
							viewH,
						)
					: 0;
				setArmed((a) => nextArmed(a, share, arm, reset));
			},
			{ threshold: THRESHOLDS },
		);
		const nearIo = new IntersectionObserver(
			([e]) => {
				if (e.isIntersecting) {
					setNear(true);
					nearIo.disconnect();
				}
			},
			{ rootMargin: `${nearMargin}px 0px` },
		);
		armIo.observe(el);
		nearIo.observe(el);
		return () => {
			armIo.disconnect();
			nearIo.disconnect();
		};
	}, [arm, reset, nearMargin]);
	return { ref, armed, near };
}

export interface Beats<T extends Element> extends BeatState {
	ref: RefObject<T | null>;
	kind: BeatKind;
	/** The spill's pose for the current beat (`spillTAt`). */
	spillT: 0 | 1;
	/** Go to a beat (the reader): ends autoplay. */
	setIndex: (index: number) => void;
	play: () => void;
	pause: () => void;
	replay: () => void;
	/** Hold while hovered or focused (not manual: letting go resumes). */
	hold: (on: boolean) => void;
	/** Motion is allowed here (false: the static last frame). */
	motion: boolean;
}

export interface PlaybackOptions {
	/** `once` (default): play, rest on the result, replay on return; `loop`: ambient demos only. */
	playback?: Playback;
	/** Share that arms it (default `ARM_SEQUENCE`). */
	arm?: number;
}

/**
 * A beat sequence's playback, one timer per beat: the static last beat on the server, first paint, reduced
 * motion, webdriver and print; on a client where motion is fine it rewinds to the first beat and advances
 * while the figure is armed (`ref` on the frame), resumes where it was when re-armed, and (`once`) replays
 * when the reader comes back after scrolling it away. Re-renders once per beat; anything finer is a CSS
 * transition keyed off `data-beat`. Touching the stepper (`setIndex`) ends autoplay; `hold` pauses it.
 *   const b = useBeats(SCRIPT); <div ref={b.ref} data-beat={b.kind}> ... <RealPhoto spillT={b.spillT} />
 */
export function useBeats<T extends Element = HTMLDivElement>(
	beats: readonly BeatSpec[],
	{ playback = "once", arm = ARM_SEQUENCE }: PlaybackOptions = {},
): Beats<T> {
	const count = beats.length;
	const motion = useMotionAllowed();
	const { ref, armed } = useArmedInView<T>({ arm });
	const [state, setState] = useState<BeatState>(() => settledBeats(count));
	const [held, setHeld] = useState(false);
	const dispatch = (a: BeatAction) =>
		setState((s) => beatReducer(s, a, count, playback));
	// rewind and play once motion is known to be fine; settle when it is not
	useEffect(() => {
		setState(
			motion
				? beatReducer(settledBeats(count), { type: "start" }, count, playback)
				: settledBeats(count),
		);
	}, [motion, count, playback]);
	// a finished `once` sequence replays when the reader comes back (armed again after RESET)
	const wasArmed = useRef(armed);
	useEffect(() => {
		const back = armed && !wasArmed.current;
		wasArmed.current = armed;
		if (back && motion)
			setState((s) =>
				!s.playing && !s.manual && s.index >= count - 1
					? beatReducer(s, { type: "replay" }, count, playback)
					: s,
			);
	}, [armed, motion, count, playback]);
	const index = Math.min(state.index, Math.max(0, count - 1));
	const beat = beats[index];
	const dwell = beat ? (beat.dwell ?? dwellOf(beat.kind)) : 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: each new beat (index) starts its own timer
	useEffect(() => {
		if (!motion || !state.playing || !armed || held || count < 2) return;
		const id = window.setTimeout(
			() =>
				setState((s) => beatReducer(s, { type: "advance" }, count, playback)),
			dwell,
		);
		return () => window.clearTimeout(id);
	}, [motion, state.playing, armed, held, index, dwell, count, playback]);
	const kind = beat?.kind ?? "result";
	return {
		...state,
		index,
		ref,
		kind,
		spillT: spillTAt(kind),
		motion,
		setIndex: (i) => dispatch({ type: "set", index: i }),
		play: () => dispatch({ type: "play" }),
		pause: () => dispatch({ type: "pause" }),
		replay: () => dispatch({ type: "replay" }),
		hold: setHeld,
	};
}

/** ms quantised down to the frame grid of `fps`. */
export const quantiseMs = (ms: number, fps: number = MOTION.fps) =>
	Math.floor((ms * fps) / 1000) * (1000 / fps);

export interface BeatClock<T extends Element> extends TimelineSample {
	ref: RefObject<T | null>;
	/** Story time in ms, quantised to `fps` (`total` when settled or static). */
	ms: number;
	total: number;
	playing: boolean;
	manual: boolean;
	motion: boolean;
	/** Show beat `index` finished (a stepper): ends autoplay. */
	seek: (index: number) => void;
	/** Set the story time by hand (a scrub): ends autoplay. */
	scrub: (ms: number) => void;
	/** Play on (from the start if it had finished). */
	play: () => void;
	hold: (on: boolean) => void;
}

/**
 * A continuous story clock for figures that compute each frame from time (a ray march's running maximum,
 * a camera turn, a solver converging), where CSS cannot interpolate. Same rules as `useBeats` (static =
 * the end; arms at ARM_SEQUENCE; pauses off screen and resumes; `once` replays on return; touch ends
 * autoplay; `hold` pauses), but it commits at most `fps` times a second, and only while playing.
 *   const c = useBeatClock(SCRIPT); const t = c.kind === "change" ? ease.inOut(c.progress) : ...
 */
export function useBeatClock<T extends Element = HTMLDivElement>(
	beats: readonly BeatSpec[],
	{
		playback = "once",
		arm = ARM_SEQUENCE,
		fps = MOTION.fps,
	}: PlaybackOptions & { fps?: number } = {},
): BeatClock<T> {
	// callers pass a module constant; the key keeps an inline array from restarting the clock
	const key = beats.map((b) => `${b.id}:${b.kind}:${b.dwell ?? ""}`).join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the script's content, not its identity
	const tl = useMemo(() => buildTimeline(beats), [key]);
	const total = tl.total;
	const loop = playback === "loop";
	const motion = useMotionAllowed();
	const { ref, armed } = useArmedInView<T>({ arm });
	const [ms, setMs] = useState(total);
	const [playing, setPlaying] = useState(false);
	const [manual, setManual] = useState(false);
	const [held, setHeld] = useState(false);
	const elapsed = useRef(total);
	// exact for the ends, a seek and a scrub; the running clock commits on the fps grid (tick below)
	const set = (v: number) => {
		elapsed.current = v;
		setMs(v);
	};
	// rewind and play where motion is fine; rest on the end where it is not
	// biome-ignore lint/correctness/useExhaustiveDependencies: restarts only when the gate or the script changes
	useEffect(() => {
		setManual(false);
		if (motion && total > 0) {
			set(0);
			setPlaying(true);
		} else {
			set(total);
			setPlaying(false);
		}
	}, [motion, total]);
	// a finished `once` clock replays when the reader comes back
	const wasArmed = useRef(armed);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reacts to arming only
	useEffect(() => {
		const back = armed && !wasArmed.current;
		wasArmed.current = armed;
		if (back && motion && !manual && !playing && elapsed.current >= total) {
			set(0);
			setPlaying(true);
		}
	}, [armed]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: set() only writes refs and state
	useEffect(() => {
		if (!motion || !playing || !armed || held) return;
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const dt = Math.min(50, now - last);
			last = now;
			let next = elapsed.current + dt;
			if (next >= total) {
				if (loop) next %= total;
				else {
					set(total);
					setPlaying(false);
					return;
				}
			}
			elapsed.current = next;
			const q = quantiseMs(next, fps);
			setMs((p) => (p === q ? p : q));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [motion, playing, armed, held, total, loop, fps]);
	const shown = motion ? ms : total;
	const sample = sampleTimeline(tl, shown, { loop: false });
	return {
		...sample,
		ref,
		ms: shown,
		total,
		playing,
		manual,
		motion,
		seek: (index) => {
			const b = tl.beats[Math.min(tl.beats.length - 1, Math.max(0, index))];
			setPlaying(false);
			setManual(true);
			// the beat finished: just before its end, so it samples as this beat at progress ~1
			if (b) set(Math.max(b.start, b.end - 1));
		},
		scrub: (v) => {
			setPlaying(false);
			setManual(true);
			set(Math.min(total, Math.max(0, v)));
		},
		play: () => {
			setManual(false);
			if (elapsed.current >= total) set(0);
			setPlaying(motion && total > 0);
		},
		hold: setHeld,
	};
}
