// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type GipfelbuchPhotoData, RealPhoto, rowsPath } from "../viz/real";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const data = JSON.parse(
	fs.readFileSync(path.join(DEMO, "demo-09.json"), "utf8"),
) as GipfelbuchPhotoData;

afterEach(cleanup);

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
