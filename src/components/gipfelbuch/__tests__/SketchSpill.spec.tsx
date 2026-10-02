// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	declutterSummits,
	rulerKey,
	runKey,
	SketchSpill,
} from "../viz/SketchSpill";

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

describe("SketchSpill v2", () => {
	const named = [
		{ u: -0.3, row: 0.5, name: "EIGER", sub: "3967 m" },
		{ u: -0.28, row: 0.45, name: "MONCH" },
		{ u: 0.5, row: 0.5, name: "INSIDE" },
		{ u: 1.2, row: 0.5, name: "JUNGFRAU" },
	];
	const withSummits = (
		summits = named,
		reveal?: number,
		at?: (u: number) => number,
	) => (
		<SketchSpill
			seed="t"
			bearing={(u) => u * 40 - 20}
			ridges={[{ at: at ?? ((u) => 0.4 + 0.1 * Math.sin(u * 7)), depth: true }]}
			summits={summits}
			reveal={reveal}
		>
			<div>frame</div>
		</SketchSpill>
	);

	it("applies reveal as opacity and keeps the spill mounted at 0", async () => {
		const { getByTestId } = render(withSummits(named, 0.3));
		await act(async () => {});
		expect(getByTestId("gb-sketch-spill").style.opacity).toBe("0.3");
		cleanup();
		const zero = render(withSummits(named, 0));
		await act(async () => {});
		expect(zero.getByTestId("gb-sketch-spill").style.opacity).toBe("0");
	});

	it("draws only margin summits and declutters an overlapping one", async () => {
		const { queryByText } = render(withSummits());
		await act(async () => {});
		expect(queryByText("EIGER")).toBeTruthy();
		expect(queryByText("3967 m")).toBeTruthy();
		expect(queryByText("MONCH")).toBeNull();
		expect(queryByText("INSIDE")).toBeNull();
		expect(queryByText("JUNGFRAU")).toBeTruthy();
	});

	it("re-rendering with an equivalent ridge function gives identical paths", async () => {
		const paths = (c: HTMLElement) =>
			[...c.querySelectorAll("svg path")].map((p) => p.getAttribute("d"));
		const { container, rerender } = render(withSummits());
		await act(async () => {});
		const before = paths(container);
		rerender(withSummits(named, 1, (u) => 0.4 + 0.1 * Math.sin(u * 7)));
		await act(async () => {});
		expect(paths(container)).toEqual(before);
	});
});

describe("spill helpers", () => {
	it("declutter drops overlaps, keeps 4 per side, sides are independent", () => {
		const left = (x: number, name = "AAAA") => ({
			x,
			name,
			side: "left" as const,
		});
		expect(declutterSummits([left(100), left(110), left(300)])).toEqual([0, 2]);
		const many = [0, 1, 2, 3, 4, 5].map((i) => left(i * 200));
		expect(declutterSummits(many)).toHaveLength(4);
		expect(
			declutterSummits([left(100), { x: 100, name: "AAAA", side: "right" }]),
		).toEqual([0, 1]);
	});

	it("ruler key ignores function identity, follows geometry", () => {
		const room = { W: 600, H: 300, L: 100, R: 100 };
		const k = rulerKey(room, 5, 0.5, (u) => u * 40 - 20);
		expect(rulerKey(room, 5, 0.5, (u) => u * 40 - 20)).toBe(k);
		expect(rulerKey(room, 5, 0.5, (u) => u * 41 - 20)).not.toBe(k);
		expect(runKey([[1, 2]], "s")).toBe(runKey([[1.01, 2.02]], "s"));
	});
});
