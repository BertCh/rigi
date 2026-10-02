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
import type { PhotoLayer } from "./inks";
import {
	ARM,
	MOTION,
	nextArmed,
	RESET,
	shownShare,
	useMotionAllowed,
} from "./motion";
import type { LayerState, OverlayRole } from "./overlay";

// RealPhoto's layers in the grammar's overlay stack (grammar.md §2), and the hero bloom (pod P spec
// §4.1): photo, then the DEM horizons at a pose fade in (derived), then the eye's skyline draws on
// (measured, the evidence), then the names. Pure timing below; the hook only flips one phase, and every
// stroke moves by CSS transition, so a bloom costs a handful of renders.

/** The overlay role each photo layer belongs to. */
export const LAYER_ROLE: Record<PhotoLayer, OverlayRole> = {
	sky: "raster",
	prior: "derived",
	solved: "derived",
	skyline: "measured",
	weight: "measured",
	priorPeaks: "notes",
	peaks: "notes",
};

/** Draw order inside the photo's svg: the grammar's stack, bottom up. */
export const LAYER_ORDER: readonly PhotoLayer[] = [
	"sky",
	"prior",
	"solved",
	"skyline",
	"weight",
	"priorPeaks",
	"peaks",
];

/**
 * settled: everything shown is on (static frame, and the resting state after a bloom);
 * pending: armed for a bloom, layers hidden until the figure is in view;
 * play: the bloom is running, layers enter at their bloom delays.
 */
export type BloomPhase = "settled" | "pending" | "play";

/** Delay (ms) of a role's entrance in the bloom. */
export function bloomDelay(role: OverlayRole): number {
	switch (role) {
		case "raster":
		case "ground":
			return 0;
		case "derived":
			return MOTION.lead;
		case "measured":
			return MOTION.lead + MOTION.stagger;
		default:
			// the names arrive once most of the skyline is traced
			return MOTION.lead + MOTION.stagger + Math.round(MOTION.trace * 0.6);
	}
}

/** When a bloom with `labels` names is over (ms after it starts), so a replay is not cut short. */
export const bloomEnd = (labels = 8) =>
	bloomDelay("notes") +
	Math.max(0, labels - 1) * MOTION.staggerLabel +
	MOTION.fade;

/**
 * The state of `layer`: hidden while a bloom is pending; otherwise on when shown, ghost when listed
 * in `ghosts` (a superseded guess kept faint), else hidden.
 */
export function layerState(
	layer: PhotoLayer,
	shown: (l: PhotoLayer) => boolean,
	ghosts: readonly PhotoLayer[],
	phase: BloomPhase,
): LayerState {
	if (phase === "pending") return "hidden";
	if (shown(layer)) return "on";
	return ghosts.includes(layer) ? "ghost" : "hidden";
}

/** Delay (ms) for `layer` in `phase`: the bloom's stagger while playing, at once otherwise. */
export const layerEnterDelay = (layer: PhotoLayer, phase: BloomPhase) =>
	phase === "play" ? bloomDelay(LAYER_ROLE[layer]) : 0;

/**
 * WAAPI keyframes of a measured stroke's pen draw-on over a `pathLength=1` path: the trace sweeps
 * evenly across the frame. `fill: "backwards"` holds it undrawn through its delay; when it ends the
 * dash is dropped again, so the settled stroke is the plain path.
 */
export const DRAW_ON_KEYFRAMES: Keyframe[] = [
	{ strokeDasharray: "1 1", strokeDashoffset: 1 },
	{ strokeDasharray: "1 1", strokeDashoffset: 0 },
];
export const drawOnTiming = (delay: number): KeyframeAnimationOptions => ({
	duration: MOTION.trace,
	delay,
	easing: "linear",
	fill: "backwards",
});

/** True when a measured stroke should draw on: motion allowed and it just went from hidden to shown. */
export const shouldDrawOn = (
	allowed: boolean,
	previous: LayerState,
	next: LayerState,
) => allowed && previous === "hidden" && next !== "hidden";

/**
 * The hero bloom's phase for the figure at `ref`. Settled wherever motion is not allowed (server,
 * first paint, reduced motion, webdriver, print). On a client it hides the layers once (before paint)
 * and plays when ARM of the frame is in view; it re-arms below RESET (replay on return), on `key`
 * (a new photo), after a `hoverReplay` mouse rest on a settled frame and on a tap. `allowed` is
 * useMotionAllowed's answer, for strokes that draw on outside a bloom.
 */
export function useHeroBloom(
	ref: RefObject<HTMLElement | null>,
	{
		enabled,
		ready,
		key,
		labels,
		replay = true,
	}: {
		enabled: boolean;
		ready: boolean;
		key: string;
		labels?: number;
		/** Replay after a pointer rest on the settled frame (off for figures with toggles). */
		replay?: boolean;
	},
): { phase: BloomPhase; allowed: boolean } {
	const allowed = useMotionAllowed();
	const on = enabled && allowed && ready;
	const [phase, setPhase] = useState<BloomPhase>("settled");
	// a hover replay: the lit frame fades out over `replayFade` before the bloom plays again
	const replaying = useRef(false);
	const [armed, setArmed] = useState(false);
	// hide before paint (a client-side mount or a new photo), never in server HTML
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` re-arms the bloom for a new photo
	useLayoutEffect(() => {
		setPhase(on ? "pending" : "settled");
	}, [on, key]);
	useEffect(() => {
		const el = ref.current;
		if (!on || !el) return;
		if (typeof IntersectionObserver === "undefined") {
			setArmed(true);
			return;
		}
		const io = new IntersectionObserver(
			([e]) => {
				const viewH = e.rootBounds?.height ?? window.innerHeight;
				const share = e.isIntersecting
					? shownShare(
							e.intersectionRect.height,
							e.boundingClientRect.height,
							viewH,
						)
					: 0;
				setArmed((a) => nextArmed(a, share, ARM, RESET));
			},
			{ threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [ref, on]);
	// armed: play; disarmed after a bloom: pend again so it replays on return
	useEffect(() => {
		if (!on) return;
		if (armed && phase === "pending") {
			const wait = replaying.current ? MOTION.replayFade : 16;
			const id = setTimeout(() => {
				replaying.current = false;
				setPhase("play");
			}, wait);
			return () => clearTimeout(id);
		}
		if (!armed && phase !== "pending") setPhase("pending");
	}, [on, armed, phase]);
	// a played bloom settles, so later layer changes enter at once
	useEffect(() => {
		if (phase !== "play") return;
		const id = setTimeout(() => setPhase("settled"), bloomEnd(labels));
		return () => clearTimeout(id);
	}, [phase, labels]);
	// a mouse resting on a settled frame replays it, as does a tap on a phone: fade out, then bloom
	useEffect(() => {
		const el = ref.current;
		if (!on || !replay || !el || phase !== "settled") return;
		let rest: ReturnType<typeof setTimeout> | undefined;
		let touch = false;
		const again = () => {
			replaying.current = true;
			setPhase("pending");
		};
		const enter = (e: PointerEvent) => {
			clearTimeout(rest);
			// a finger crossing the frame while scrolling is not a rest
			if (e.pointerType === "touch") return;
			rest = setTimeout(again, MOTION.hoverReplay);
		};
		const leave = () => clearTimeout(rest);
		const down = (e: PointerEvent) => {
			touch = e.pointerType === "touch";
		};
		const cancel = () => {
			touch = false;
		};
		// a click follows a tap, never a scroll; a tap on a control inside the figure is the control's
		const tap = (e: Event) => {
			const control = (e.target as Element | null)?.closest?.(
				"button, a, input, select, [role=button], [role=slider]",
			);
			if (touch && !control) again();
			touch = false;
		};
		el.addEventListener("pointerenter", enter);
		el.addEventListener("pointerleave", leave);
		el.addEventListener("pointerdown", down);
		el.addEventListener("pointercancel", cancel);
		el.addEventListener("click", tap);
		return () => {
			clearTimeout(rest);
			el.removeEventListener("pointerenter", enter);
			el.removeEventListener("pointerleave", leave);
			el.removeEventListener("pointerdown", down);
			el.removeEventListener("pointercancel", cancel);
			el.removeEventListener("click", tap);
		};
	}, [ref, on, replay, phase]);
	return { phase: on ? phase : "settled", allowed };
}
