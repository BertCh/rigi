// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SketchSpill } from "../viz/SketchSpill";

// a 600 x 300 frame centred in a 1400 px window
beforeEach(() => {
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
		x: 400,
		y: 100,
		left: 400,
		right: 1000,
		top: 100,
		bottom: 400,
		width: 600,
		height: 300,
		toJSON: () => ({}),
	});
	vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
		1400,
	);
	vi.stubGlobal("innerWidth", 1400);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const spill = (cursor?: { u: number }) => (
	<SketchSpill
		seed="t"
		// 40° across the frame, centred on 0
		bearing={(u) => u * 40 - 20}
		ridges={[{ at: (u) => 0.4 + 0.1 * Math.sin(u * 7), depth: true }]}
		cursor={cursor}
	>
		<div>frame</div>
	</SketchSpill>
);

describe("SketchSpill", () => {
	it("letters the ruler in the figure's bearings, past the frame on both sides", async () => {
		const { getByText, getByTestId } = render(spill());
		await act(async () => {});
		expect(getByTestId("gb-sketch-spill")).toBeTruthy();
		// spill is half the frame per side: bearings -40 .. +40, lettered every 15°
		for (const deg of ["-30°", "-15°", "0°", "+15°", "+30°"])
			expect(getByText(deg)).toBeTruthy();
	});

	it("draws the ridge in the margins only, as separate runs per side", async () => {
		const { getByTestId } = render(spill());
		await act(async () => {});
		const svg = getByTestId("gb-sketch-spill").querySelector("svg");
		// 2 sides x 3 depth copies, plus the ruler and its ticks
		expect(svg?.querySelectorAll("path").length).toBeGreaterThanOrEqual(8);
	});

	it("marks the cursor with its bearing", async () => {
		const { getByText, getByTestId } = render(spill({ u: 0.75 }));
		await act(async () => {});
		expect(getByTestId("gb-sketch-spill-cursor")).toBeTruthy();
		expect(getByText("+10°")).toBeTruthy();
	});
});
