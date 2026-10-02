// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MOTION } from "../viz/motion";
import {
	GHOST_OPACITY,
	layerDelay,
	layerDuration,
	layerOpacity,
	OVERLAY_ROLES,
	OVERLAY_STACK,
	OverlayLayer,
	overlayStyle,
	sortByStack,
} from "../viz/overlay";

describe("overlay stack", () => {
	it("orders the roles from the image up, with unique z", () => {
		expect(OVERLAY_ROLES.map((r) => OVERLAY_STACK[r].z)).toEqual([
			0, 1, 2, 3, 4, 5, 6,
		]);
	});

	it("keeps RealPhoto's line weights", () => {
		expect(OVERLAY_STACK.measured.weight).toBe(1.7);
		expect(OVERLAY_STACK.derived.weight).toBe(2.2);
	});

	it("never fades the raster", () => {
		expect(layerOpacity("raster", "on")).toBe(1);
		expect(layerOpacity("measured", "ghost")).toBe(GHOST_OPACITY);
		expect(layerOpacity("notes", "hidden")).toBe(0);
	});

	it("enters in stack order and leaves backwards, quicker", () => {
		expect(layerDelay("derived")).toBeLessThan(layerDelay("measured"));
		expect(layerDelay("measured")).toBeLessThan(layerDelay("notes"));
		expect(layerDelay("notes", true)).toBeLessThan(
			layerDelay("measured", true),
		);
		expect(layerDuration("notes")).toBe(MOTION.fade);
		expect(layerDuration("notes", true)).toBeLessThan(MOTION.fade);
		expect(layerDuration("raster")).toBe(MOTION.crossfade);
		expect(layerDuration("ground")).toBe(0);
	});

	it("styles a leaving layer with the leave timing", () => {
		const leaving = overlayStyle("notes", "hidden", { previous: "on" });
		expect(leaving.opacity).toBe(0);
		expect(leaving.transition).toContain(`${Math.round(MOTION.fade * 0.6)}ms`);
		const entering = overlayStyle("notes", "on", { delay: 0 });
		expect(entering.transition).toBe(
			`opacity ${MOTION.fade}ms cubic-bezier(0.33, 1, 0.68, 1)`,
		);
		expect(entering.pointerEvents).toBe("none");
		expect(overlayStyle("interaction", "on").pointerEvents).toBeUndefined();
	});

	it("answers the pointer at once, clears quickly and drops transitions under reduced motion", () => {
		expect(layerDelay("interaction")).toBe(0);
		expect(layerDelay("ground", true)).toBeLessThanOrEqual(2 * MOTION.stagger);
		expect(
			overlayStyle("notes", "on", { reduce: true }).transition,
		).toBeUndefined();
	});

	it("sorts mixed items into stack order, stably", () => {
		const items = [
			{ layer: "notes" as const, id: "n" },
			{ layer: "measured" as const, id: "m1" },
			{ layer: "raster" as const, id: "r" },
			{ layer: "measured" as const, id: "m2" },
		];
		expect(sortByStack(items).map((i) => i.id)).toEqual(["r", "m1", "m2", "n"]);
	});

	it("renders a tagged layer as a <g> or a <div>", () => {
		const { container } = render(
			<div>
				<svg aria-hidden="true">
					<OverlayLayer layer="derived" state="ghost">
						<path d="M0 0L1 1" />
					</OverlayLayer>
				</svg>
				<OverlayLayer layer="notes" as="div">
					note
				</OverlayLayer>
			</div>,
		);
		const g = container.querySelector('g[data-layer="derived"]') as SVGGElement;
		expect(g.dataset.state).toBe("ghost");
		expect(g.style.opacity).toBe(String(GHOST_OPACITY));
		const div = container.querySelector(
			'div[data-layer="notes"]',
		) as HTMLDivElement;
		expect(div.style.zIndex).toBe("5");
		expect(div.style.position).toBe("absolute");
	});
});
