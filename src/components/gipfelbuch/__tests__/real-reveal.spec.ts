// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import type { PhotoLayer } from "../viz/inks";
import { MOTION } from "../viz/motion";
import { OVERLAY_STACK } from "../viz/overlay";
import {
	bloomDelay,
	bloomEnd,
	LAYER_ORDER,
	LAYER_ROLE,
	layerEnterDelay,
	layerState,
	shouldDrawOn,
} from "../viz/real-reveal";

const shown =
	(...ls: PhotoLayer[]) =>
	(l: PhotoLayer) =>
		ls.includes(l);

describe("real-reveal", () => {
	it("draws the photo's layers in the grammar's stack order", () => {
		const z = LAYER_ORDER.map((l) => OVERLAY_STACK[LAYER_ROLE[l]].z);
		expect(z).toEqual([...z].sort((a, b) => a - b));
		// derived (the horizons at a pose) under measured (the eye's skyline)
		expect(LAYER_ORDER.indexOf("solved")).toBeLessThan(
			LAYER_ORDER.indexOf("skyline"),
		);
		expect(new Set(LAYER_ORDER).size).toBe(Object.keys(LAYER_ROLE).length);
	});

	it("blooms in causal order: photo, derived, measured, names", () => {
		const order = ["raster", "derived", "measured", "notes"] as const;
		const delays = order.map(bloomDelay);
		expect(delays[0]).toBe(0);
		for (let i = 1; i < delays.length; i++)
			expect(delays[i]).toBeGreaterThan(delays[i - 1]);
		expect(bloomDelay("derived")).toBe(MOTION.lead);
		// the names wait for most of the trace, not all of it
		expect(bloomDelay("notes") - bloomDelay("measured")).toBeLessThan(
			MOTION.trace,
		);
		expect(bloomEnd(8)).toBeGreaterThan(bloomEnd(1));
		expect(bloomEnd(1)).toBe(bloomDelay("notes") + MOTION.fade);
	});

	it("hides everything while pending and ghosts a superseded layer", () => {
		const on = shown("solved", "skyline");
		expect(layerState("solved", on, [], "pending")).toBe("hidden");
		expect(layerState("solved", on, [], "settled")).toBe("on");
		expect(layerState("solved", on, [], "play")).toBe("on");
		expect(layerState("prior", on, ["prior"], "settled")).toBe("ghost");
		expect(layerState("prior", on, [], "settled")).toBe("hidden");
		// a shown layer listed as a ghost is still on
		expect(layerState("solved", on, ["solved"], "settled")).toBe("on");
	});

	it("delays entrances only during a bloom", () => {
		expect(layerEnterDelay("skyline", "play")).toBe(bloomDelay("measured"));
		expect(layerEnterDelay("skyline", "settled")).toBe(0);
		expect(layerEnterDelay("peaks", "pending")).toBe(0);
	});

	it("draws a measured stroke on only from hidden, and only with motion", () => {
		expect(shouldDrawOn(true, "hidden", "on")).toBe(true);
		expect(shouldDrawOn(false, "hidden", "on")).toBe(false);
		expect(shouldDrawOn(true, "on", "on")).toBe(false);
		expect(shouldDrawOn(true, "on", "hidden")).toBe(false);
	});
});
