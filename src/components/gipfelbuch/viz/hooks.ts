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
