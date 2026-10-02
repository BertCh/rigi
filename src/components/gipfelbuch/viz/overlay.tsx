// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { EASE, MOTION, stagger } from "./motion";

// The explainer grammar's overlay stack (reports/gipfelbuch-explainers-2026-10-02/grammar.md §2): one
// fixed order of layers from the image up, each with its opacity, weight and the way it enters. Layers
// change state through CSS transitions only (no per-frame render). The spill mirrors roles 2–5 past the
// frame in their paper inks.

export const OVERLAY_ROLES = [
	"ground",
	"raster",
	"derived",
	"measured",
	"furniture",
	"notes",
	"interaction",
] as const;
export type OverlayRole = (typeof OVERLAY_ROLES)[number];

/** hidden: not drawn yet; on: shown; ghost: a superseded guess, kept faint (and struck) to the end. */
export type LayerState = "hidden" | "on" | "ghost";

export interface OverlaySpec {
	/** Stack position from the image up (also the CSS z-index of an HTML layer). */
	z: number;
	/** Opacity when on. */
	opacity: number;
	/** Stroke weight in display px (RealPhoto's: skyline 1.7, prior and solved 2.2). */
	weight?: number;
	/** CrispLine halo width in display px. */
	halo?: number;
	/** How it arrives: the strokes draw on (useDrawOn), it fades, it crossfades from a poster, or not at all. */
	enter: "draw" | "fade" | "crossfade" | "quick" | "none";
}

export const OVERLAY_STACK: Record<OverlayRole, OverlaySpec> = {
	ground: { z: 0, opacity: 1, weight: 0.7, enter: "none" },
	raster: { z: 1, opacity: 1, enter: "crossfade" },
	// derived under measured: the thin traced line reads over the thicker model lines (RealPhoto's order)
	derived: { z: 2, opacity: 0.9, weight: 2.2, halo: 4.6, enter: "fade" },
	measured: { z: 3, opacity: 1, weight: 1.7, halo: 4, enter: "draw" },
	furniture: { z: 4, opacity: 0.85, weight: 1.2, enter: "draw" },
	notes: { z: 5, opacity: 1, enter: "fade" },
	interaction: { z: 6, opacity: 1, weight: 1.5, enter: "quick" },
};

/** Opacity of a superseded guess. */
export const GHOST_OPACITY = 0.35;
/** Leaving is quicker than entering. */
export const LEAVE_FACTOR = 0.6;

/** Opacity of `role` in `state`. */
export function layerOpacity(role: OverlayRole, state: LayerState): number {
	if (state === "hidden") return 0;
	if (state === "ghost") return GHOST_OPACITY;
	return OVERLAY_STACK[role].opacity;
}

/** Duration (ms) of an opacity change of `role` (a drawn layer fades its group as fast as `fade`). */
export function layerDuration(role: OverlayRole, leaving = false): number {
	const { enter } = OVERLAY_STACK[role];
	const ms =
		enter === "crossfade"
			? MOTION.crossfade
			: enter === "quick"
				? MOTION.quick
				: enter === "none"
					? 0
					: MOTION.fade;
	return Math.round(leaving ? ms * LEAVE_FACTOR : ms);
}

/**
 * Delay (ms) of a layer entering within a beat: in stack order, `MOTION.stagger` apart, the ground and
 * the raster first. Leaving runs the stack backwards.
 */
export function layerDelay(role: OverlayRole, leaving = false): number {
	const i = OVERLAY_STACK[role].z;
	return stagger(leaving ? OVERLAY_ROLES.length - 1 - i : Math.max(0, i - 2));
}

/** `items` sorted bottom to top by role (stable), for drawing into one svg in stack order. */
export function sortByStack<T extends { layer: OverlayRole }>(
	items: readonly T[],
): T[] {
	return items
		.map((item, i) => ({ item, i }))
		.sort(
			(a, b) =>
				OVERLAY_STACK[a.item.layer].z - OVERLAY_STACK[b.item.layer].z ||
				a.i - b.i,
		)
		.map(({ item }) => item);
}

/**
 * Style of a layer in `state`: opacity with its transition (enter or leave timing), z-index for HTML
 * layers (an SVG `<g>` takes its order from the DOM: draw in `OVERLAY_ROLES` order), and no pointer
 * events unless it is the interaction layer. `delay` overrides the stack delay (a beat's own stagger).
 */
export function overlayStyle(
	role: OverlayRole,
	state: LayerState,
	{ delay, previous }: { delay?: number; previous?: LayerState } = {},
): CSSProperties {
	const opacity = layerOpacity(role, state);
	const leaving = previous != null && layerOpacity(role, previous) > opacity;
	const ms = layerDuration(role, leaving);
	const wait = delay ?? layerDelay(role, leaving);
	return {
		zIndex: OVERLAY_STACK[role].z,
		opacity,
		transition: ms
			? `opacity ${ms}ms ${leaving ? EASE.linear : EASE.out}${wait ? ` ${wait}ms` : ""}`
			: undefined,
		pointerEvents: role === "interaction" ? undefined : "none",
	};
}

/**
 * One layer of the stack: a `<g>` inside an svg (default) or an absolutely placed `<div>` over the
 * photo. Marked `data-layer` / `data-state` so specs and the browser pass can find it. Under reduced
 * motion the transition is dropped by `motion-reduce:transition-none`.
 */
export function OverlayLayer({
	layer: role,
	state = "on",
	delay,
	as = "g",
	className,
	children,
}: {
	/** The layer's role in the stack (named `layer`, not `role`, so it never reads as an ARIA role). */
	layer: OverlayRole;
	state?: LayerState;
	delay?: number;
	as?: "g" | "div";
	className?: string;
	children: ReactNode;
}) {
	// the state shown before this render, so a layer that steps down leaves with the leave timing
	const shown = useRef(state);
	const previous = shown.current;
	useEffect(() => {
		shown.current = state;
	}, [state]);
	const style = overlayStyle(role, state, { delay, previous });
	const common = {
		"data-layer": role,
		"data-state": state,
		"aria-hidden": state === "hidden" ? true : undefined,
		className: `motion-reduce:transition-none ${className ?? ""}`.trim(),
	};
	if (as === "div")
		return (
			<div {...common} style={{ position: "absolute", inset: 0, ...style }}>
				{children}
			</div>
		);
	const { zIndex: _z, ...svgStyle } = style;
	return (
		<g {...common} style={svgStyle}>
			{children}
		</g>
	);
}
