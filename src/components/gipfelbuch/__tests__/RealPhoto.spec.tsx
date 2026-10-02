// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type GipfelbuchPhotoData,
	labelledPeaksIn,
	RealPhoto,
	rowsPath,
} from "../viz/real";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const data = JSON.parse(
	fs.readFileSync(path.join(DEMO, "demo-09.json"), "utf8"),
) as GipfelbuchPhotoData;

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** Paths whose `d` is exactly the measured row line (the halo and dark under-stroke of a CrispLine). */
const linePaths = (
	root: HTMLElement,
	rows: (number | null)[],
	maxJump: number,
) =>
	[...root.querySelectorAll("path")].filter(
		(p) => p.getAttribute("d") === rowsPath(rows, maxJump),
	);

describe("RealPhoto lines", () => {
	it("draws the skyline and the solved horizon by default", () => {
		const { container } = render(
			<RealPhoto data={data} layers={["skyline", "solved", "peaks"]} />,
		);
		expect(linePaths(container, data.skyline.rows, 8).length).toBeGreaterThan(
			0,
		);
		expect(linePaths(container, data.solvedRows, 12).length).toBeGreaterThan(0);
	});

	it("leaves the strokes to the caller with lines={false} but keeps the peaks", () => {
		const { container, getAllByText } = render(
			<RealPhoto
				data={data}
				layers={["skyline", "solved", "weight", "peaks"]}
				lines={false}
			>
				{() => <g data-testid="own-lines" />}
			</RealPhoto>,
		);
		expect(linePaths(container, data.skyline.rows, 8)).toHaveLength(0);
		expect(linePaths(container, data.solvedRows, 12)).toHaveLength(0);
		// weight ticks are plain <line>s
		expect(container.querySelectorAll("line")).toHaveLength(0);
		const named = data.peaks.find((p) => p.labelled && p.solved);
		if (named) expect(getAllByText(named.name).length).toBeGreaterThan(0);
		expect(container.querySelector('[data-testid="own-lines"]')).toBeTruthy();
	});
});

describe("RealPhoto overlay stack", () => {
	it("marks each layer group with its grammar role and state", () => {
		const { container } = render(
			<RealPhoto
				data={data}
				layers={["solved", "skyline", "peaks"]}
				ghosts={["prior"]}
			/>,
		);
		const state = (role: string) =>
			[...container.querySelectorAll(`[data-layer="${role}"]`)].map((g) =>
				g.getAttribute("data-state"),
			);
		// prior (ghost) and solved (on) are both derived, prior first in the stack
		expect(state("derived")).toEqual(["ghost", "on"]);
		expect(state("measured")).toEqual(["on"]);
		expect(state("notes")).toEqual(["on"]);
		const ghost = container.querySelector(
			'[data-layer="derived"][data-state="ghost"]',
		) as SVGGElement;
		expect(Number(ghost.style.opacity)).toBeCloseTo(0.35);
	});

	it("keeps the photo and a layer mounted when the layers change", () => {
		const { container, rerender } = render(
			<RealPhoto data={data} layers={["prior", "skyline"]} />,
		);
		const image = container.querySelector("image");
		rerender(<RealPhoto data={data} layers={["solved", "skyline"]} />);
		expect(container.querySelector("image")).toBe(image);
		// the prior stays mounted, hidden, so it can fade out instead of popping
		const prior = container.querySelector(
			'[data-layer="derived"]',
		) as SVGGElement;
		expect(prior.getAttribute("data-state")).toBe("hidden");
		expect(prior.style.opacity).toBe("0");
	});

	it("shows a spilled hero settled where motion is not allowed (static frame)", async () => {
		const bake = fs.readFileSync(path.join(DEMO, "tafel/demo-09.json"), "utf8");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(bake, {
						headers: { "content-type": "application/json" },
					}),
			),
		);
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
			x: 400,
			y: 100,
			left: 400,
			right: 1000,
			top: 100,
			bottom: 550,
			width: 600,
			height: 450,
			toJSON: () => ({}),
		});
		vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
			1400,
		);
		vi.stubGlobal("innerWidth", 1400);
		// happy-dom has no IntersectionObserver: revealsImmediately, so no bloom
		const { container, findByTestId } = render(
			<RealPhoto data={data} layers={["solved", "skyline", "peaks"]} bleed />,
		);
		await act(async () => {});
		expect(
			container.querySelector("[data-reveal]")?.getAttribute("data-reveal"),
		).toBe("settled");
		const spill = await findByTestId("gb-geo-spill");
		expect(spill.style.opacity).toBe("var(--gb-spill-reveal, 1)");
		// every layer is mounted for a spilled photo; only the shown ones are on
		const photo = container.querySelector('svg[role="img"]') as SVGSVGElement;
		expect(photo.querySelectorAll('[data-layer="derived"]')).toHaveLength(2);
		const echo = await findByTestId("gb-geo-spill-echo");
		const echoStates = [...echo.querySelectorAll("[data-layer]")].map(
			(g) => `${g.getAttribute("data-layer")}:${g.getAttribute("data-state")}`,
		);
		expect(echoStates).toContain("derived:on");
		expect(echoStates).toContain("derived:hidden");
		expect(echoStates).toContain("measured:on");
	});
});

describe("labelledPeaksIn", () => {
	it("keeps labelled summits inside the crop, in rank order, capped", () => {
		const { width: W, height: H } = data.photo;
		const all = labelledPeaksIn(data, [0, 0, W, H], 99);
		expect(all.solved.every((p) => p.labelled && p.solved)).toBe(true);
		expect(labelledPeaksIn(data, [0, 0, W, H], 2).solved).toEqual(
			all.solved.slice(0, 2),
		);
		const left = labelledPeaksIn(data, [0, 0, W / 2, H], 99).solved;
		expect(left.every((p) => (p.solved as [number, number])[0] <= W / 2)).toBe(
			true,
		);
		// the order is the data's ranking
		const rank = (p: (typeof left)[number]) => data.peaks.indexOf(p);
		expect(left.map(rank)).toEqual([...left.map(rank)].sort((a, b) => a - b));
	});
});
