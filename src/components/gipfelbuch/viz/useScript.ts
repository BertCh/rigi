// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { revealsImmediately } from "./hooks";
import {
	type BeatState,
	beatAt,
	quantise,
	type Script,
	stepTime,
} from "./script";

const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Visible share of the figure that starts the script (the landing's how-it-works starts at 0.45). */
export const SCRIPT_START_RATIO = 0.45;
/** Below this share, a finished script re-arms and plays again when the reader comes back (RevealLoop). */
export const SCRIPT_REARM_RATIO = 0.2;

export interface ScriptClock<T extends Element> {
	ref: RefObject<T | null>;
	/** Seconds into the script, quantised to `fps`. */
	t: number;
	beat: BeatState;
	/** True while the clock runs. */
	playing: boolean;
	/** Reduced motion, webdriver, print or no IntersectionObserver: `t` is pinned to the settled frame. */
	still: boolean;
	/** True once the reader has stepped or scrubbed; the clock waits for `play`. */
	manual: boolean;
	/** Show beat `index` finished (a stepper button). */
	seek: (index: number) => void;
	/** Set the clock by hand (a scrubber), in seconds. */
	scrub: (t: number) => void;
	/** Play the script again from the start. */
	play: () => void;
}

/**
 * Runs a causal script (`script.ts`) once while the figure is on screen, then rests on its last frame.
 * It starts when `SCRIPT_START_RATIO` of the figure is visible, pauses when it leaves, and replays from
 * the start after the reader has scrolled it away (below `SCRIPT_REARM_RATIO`) and back. The clock commits
 * at most `fps` times a second and stops committing once settled, so a big SVG re-renders only while the
 * story plays. Reduced motion, webdriver and print show the settled frame and never start a frame loop.
 */
export function useScript<T extends Element = HTMLDivElement>(
	script: Script,
	{ fps = 30 }: { fps?: number } = {},
): ScriptClock<T> {
	const ref = useRef<T>(null);
	const [still, setStill] = useState(false);
	const [t, setT] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [manual, setManual] = useState(false);
	const visible = useRef(false);
	// the reader's step or scrub: the observer must neither restart nor resume the story over it
	const manualRef = useRef(false);
	const elapsed = useRef(0);
	const played = useRef(false);
	const raf = useRef(0);
	const settle = script.settle;

	const stop = useCallback(() => {
		cancelAnimationFrame(raf.current);
		raf.current = 0;
		setPlaying(false);
	}, []);

	const run = useCallback(() => {
		if (raf.current) return;
		setPlaying(true);
		let last = performance.now();
		const tick = (now: number) => {
			const dt = Math.min(0.05, (now - last) / 1000);
			last = now;
			if (!visible.current) {
				// paused off screen: keep the elapsed time, stop the loop
				raf.current = 0;
				setPlaying(false);
				return;
			}
			elapsed.current = Math.min(settle, elapsed.current + dt);
			setT((p) => {
				const q = quantise(elapsed.current, fps);
				return q === p ? p : q;
			});
			if (elapsed.current >= settle) {
				raf.current = 0;
				setPlaying(false);
				return;
			}
			raf.current = requestAnimationFrame(tick);
		};
		raf.current = requestAnimationFrame(tick);
	}, [fps, settle]);

	useIsomorphicLayoutEffect(() => {
		const toEnd = () => {
			cancelAnimationFrame(raf.current);
			raf.current = 0;
			elapsed.current = settle;
			setT(settle);
			setPlaying(false);
		};
		window.addEventListener("beforeprint", toEnd);
		if (revealsImmediately()) {
			setStill(true);
			toEnd();
			return () => window.removeEventListener("beforeprint", toEnd);
		}
		const el = ref.current;
		if (!el) return () => window.removeEventListener("beforeprint", toEnd);
		const io = new IntersectionObserver(
			([e]) => {
				const r = e.isIntersecting ? e.intersectionRatio : 0;
				visible.current = e.isIntersecting;
				if (
					r < SCRIPT_REARM_RATIO &&
					played.current &&
					elapsed.current >= settle
				)
					played.current = false; // scrolled away after the end: replay on return
				if (manualRef.current) return;
				if (r >= SCRIPT_START_RATIO && !played.current) {
					played.current = true;
					elapsed.current = 0;
					setT(0);
					run();
				} else if (
					e.isIntersecting &&
					played.current &&
					elapsed.current < settle
				)
					run(); // back on screen mid-story: resume
			},
			{ threshold: [0, SCRIPT_REARM_RATIO, SCRIPT_START_RATIO] },
		);
		io.observe(el);
		return () => {
			io.disconnect();
			cancelAnimationFrame(raf.current);
			raf.current = 0;
			window.removeEventListener("beforeprint", toEnd);
		};
		// the reader's manual state is read through refs; the observer is set up once per script
	}, [settle, run]);

	const seek = useCallback(
		(index: number) => {
			stop();
			manualRef.current = true;
			setManual(true);
			// just inside the beat's end, so it samples as that beat, finished
			elapsed.current = Math.max(0, stepTime(script, index) - 1e-3);
			setT(elapsed.current);
		},
		[script, stop],
	);
	const scrub = useCallback(
		(v: number) => {
			stop();
			manualRef.current = true;
			setManual(true);
			elapsed.current = Math.max(0, Math.min(settle, v));
			setT(elapsed.current);
		},
		[settle, stop],
	);
	const play = useCallback(() => {
		manualRef.current = false;
		setManual(false);
		played.current = true;
		elapsed.current = 0;
		setT(0);
		if (still) {
			elapsed.current = settle;
			setT(settle);
			return;
		}
		visible.current = true;
		run();
	}, [run, settle, still]);

	return {
		ref,
		// static shows the result until the reader steps or scrubs
		t: still && !manual ? settle : t,
		beat: beatAt(script, still && !manual ? settle : t),
		playing,
		still,
		manual,
		seek,
		scrub,
		play,
	};
}
