// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DemPatch, type GipfelbuchPhotoData } from "../viz/real";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const data = JSON.parse(
	fs.readFileSync(path.join(DEMO, "demo-09.json"), "utf8"),
) as GipfelbuchPhotoData;

afterEach(cleanup);

describe("DemPatch", () => {
	it("grounds on the figure wash with a paper fallback", () => {
		const { container } = render(<DemPatch data={data} imprint={false} />);
		expect(container.querySelector("svg > rect")?.getAttribute("fill")).toBe(
			"var(--fig-wash, var(--gb-paper, #ece6da))",
		);
	});

	it("draws the camera dot in ink, not red", () => {
		const { container } = render(<DemPatch data={data} imprint={false} />);
		expect(container.innerHTML).not.toContain("--gb-red");
		expect(container.innerHTML).not.toContain("var(--accent)");
	});

	it("keeps the scale line by default and drops it with furniture={false}", () => {
		const on = render(<DemPatch data={data} imprint={false} />);
		expect(on.getByText(/N↑/)).toBeTruthy();
		on.unmount();
		const off = render(
			<DemPatch data={data} imprint={false} furniture={false} />,
		);
		expect(off.queryByText(/N↑/)).toBeNull();
	});

	it("letters peak names and the scale through HandLabel", () => {
		const { container } = render(<DemPatch data={data} imprint={false} />);
		const texts = [...container.querySelectorAll("text")];
		expect(texts.length).toBeGreaterThan(1);
		for (const t of texts)
			expect(t.getAttribute("class")).toMatch(/nb-label|nb-hand-small/);
		const names = data.peaks.filter((p) => p.labelled).map((p) => p.name);
		expect(texts.some((t) => names.includes(t.textContent ?? ""))).toBe(true);
		expect(texts.some((t) => t.style.fontStyle === "italic")).toBe(true);
	});
});
