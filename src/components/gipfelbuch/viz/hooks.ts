// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

// Layout effect so the static state is in place before first paint (no fade under automation).
const useIsomorphicLayoutEffect =
	typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A1: the static state is the design. Reveals show at once when there is no IntersectionObserver,
 * under reduced motion, under webdriver automation and in print.
 */
export function revealsImmediately(): boolean {
	if (typeof window === "undefined") return false;
	return (
		typeof IntersectionObserver === "undefined" ||
		!!navigator.webdriver ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
		window.matchMedia("print").matches
	);
}

/** True once (or while, with `once: false`) the element is on screen. */
export function useInView<T extends Element = HTMLDivElement>(
	opts: { once?: boolean; margin?: string } = {},
): [RefObject<T | null>, boolean] {
	const { once = true, margin = "0px 0px -8% 0px" } = opts;
	const ref = useRef<T>(null);
	const [on, setOn] = useState(false);
	useIsomorphicLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const showNow = () => setOn(true);
		window.addEventListener("beforeprint", showNow);
		if (
			(once && revealsImmediately()) ||
			typeof IntersectionObserver === "undefined"
		) {
			setOn(true);
			return () => window.removeEventListener("beforeprint", showNow);
		}
		const io = new IntersectionObserver(
			([e]) => {
				if (e.isIntersecting) {
					setOn(true);
					if (once) io.disconnect();
				} else if (!once) setOn(false);
			},
			{ rootMargin: margin },
		);
		io.observe(el);
		return () => {
			io.disconnect();
			window.removeEventListener("beforeprint", showNow);
		};
	}, [once, margin]);
	return [ref, on];
}

export function useReducedMotion(): boolean {
	const [r, setR] = useState(() =>
		typeof window === "undefined"
			? false
			: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
	);
	useEffect(() => {
		const m = window.matchMedia("(prefers-reduced-motion: reduce)");
		const f = () => setR(m.matches);
		m.addEventListener("change", f);
		return () => m.removeEventListener("change", f);
	}, []);
	return r;
}

/** Calls `cb(seconds, dt)` every frame while `active`. Does not re-render. */
export function useRaf(cb: (t: number, dt: number) => void, active = true) {
	const fn = useRef(cb);
	fn.current = cb;
	useEffect(() => {
		if (!active) return;
		let raf = 0;
		let last = performance.now();
		const loop = (now: number) => {
			fn.current(now / 1000, Math.min(0.05, (now - last) / 1000));
			last = now;
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [active]);
}

/**
 * Seconds since the figure first came into view, re-rendering every frame while it is visible.
 * Attach `ref` to the figure's root. With reduced motion `t` is frozen at `still` (default 2).
 *   const [ref, t] = useTime(); <svg ref={ref}> ... Math.sin(t) ...
 */
export function useTime<T extends Element = HTMLDivElement>(
	still = 2,
): [RefObject<T | null>, number] {
	const [ref, inView] = useInView<T>({ once: false, margin: "80px" });
	const reduce = useReducedMotion();
	const [t, setT] = useState(still);
	const t0 = useRef<number | null>(null);
	useRaf((now) => {
		t0.current ??= now;
		setT(now - t0.current);
	}, inView && !reduce);
	return [ref, reduce ? still : t];
}

/** A3: same-document view transition for sheet-to-sheet links, off under reduced motion and webdriver. */
export function sheetTransition(): boolean {
	if (typeof window === "undefined") return false;
	return (
		!navigator.webdriver &&
		!window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Pen draw-on for a figure's strokes (notebook.css `nb-armed` / `nb-on`, the effect the notebook map
 * uses). Attach `ref` to the figure's root and `className` to it; give each stroke `draw` (and a `delay`
 * to stagger it) on SketchPath / PenArrow. Armed only on the client, so a static render, reduced motion,
 * webdriver automation and print all show every stroke. `on` is true once the figure has been in view.
 *   const { ref, className } = useDrawOn(); <div ref={ref} className={className}> ...
 */
export function useDrawOn<T extends Element = HTMLDivElement>(): {
	ref: RefObject<T | null>;
	armed: boolean;
	on: boolean;
	className: string;
} {
	const [ref, on] = useInView<T>();
	const reduce = useReducedMotion();
	const [armed, setArmed] = useState(false);
	useEffect(() => {
		setArmed(!reduce && !revealsImmediately());
	}, [reduce]);
	return {
		ref,
		armed,
		on,
		className: armed ? (on ? "nb-armed nb-on" : "nb-armed") : "",
	};
}

/** The value of a ping-pong scrub (min to max and back, linear) `elapsedMs` into a cycle of `period` ms. */
export function scrubValue(
	elapsedMs: number,
	{ min, max, period }: { min: number; max: number; period: number },
): number {
	const phase = (((elapsedMs / period) % 1) + 1) % 1;
	const u = phase < 0.5 ? 2 * phase : 2 - 2 * phase;
	return min + u * (max - min);
}

/**
 * A slider that plays itself until the reader takes it: `value` ping-pongs between `min` and `max` over
 * `period` ms while the figure is on screen; `setManual(v)` (call it from the slider's onChange) freezes
 * it at v; `resume()` plays on from where the reader left it. Under reduced motion and webdriver it holds
 * at `still` (default `max`, the solved end). Attach `ref` to the figure to pause it off screen.
 */
export function useAutoScrub({
	min,
	max,
	period,
	still = max,
}: {
	min: number;
	max: number;
	/** Milliseconds for one there-and-back cycle. */
	period: number;
	/** Where it rests when nothing animates (default `max`). */
	still?: number;
}): {
	value: number;
	setManual: (value: number) => void;
	isManual: boolean;
	resume: () => void;
	ref: RefObject<HTMLDivElement | null>;
} {
	const reduce = useReducedMotion();
	const frozen =
		reduce || (typeof window !== "undefined" && !!navigator.webdriver);
	const ref = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(true);
	const [manual, setManualValue] = useState<number | null>(null);
	const [auto, setAuto] = useState(still);
	// where the cycle would be when playing starts: a manual stop resumes from its own value
	const startFrac = useRef(0);
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), {
			rootMargin: "80px",
		});
		io.observe(el);
		return () => io.disconnect();
	}, []);
	const playing = !frozen && manual === null && visible;
	useEffect(() => {
		if (!playing) return;
		const t0 = performance.now() - (startFrac.current / 2) * period;
		let raf = 0;
		const tick = (now: number) => {
			setAuto(scrubValue(now - t0, { min, max, period }));
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [playing, min, max, period]);
	const setManual = (v: number) => {
		startFrac.current = Math.min(1, Math.max(0, (v - min) / (max - min || 1)));
		setManualValue(v);
	};
	return {
		value: manual ?? (frozen ? still : auto),
		setManual,
		isManual: manual !== null,
		resume: () => {
			if (manual !== null) setAuto(manual);
			setManualValue(null);
		},
		ref,
	};
}
