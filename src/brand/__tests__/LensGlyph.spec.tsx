// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LensGlyph } from "../LensGlyph";

afterEach(cleanup);

describe("LensGlyph", () => {
	it("renders one circle and one ridge polyline with currentColor", () => {
		const { container } = render(<LensGlyph />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
		expect(svg?.getAttribute("stroke")).toBe("currentColor");
		expect(svg?.getAttribute("fill")).toBe("none");
		expect(container.querySelectorAll("circle")).toHaveLength(1);
		expect(container.querySelectorAll("polyline")).toHaveLength(1);
		expect(svg?.getAttribute("width")).toBe("14");
	});
	it("is decorative without a title", () => {
		const { container } = render(<LensGlyph size={20} />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
		expect(svg?.getAttribute("role")).toBeNull();
		expect(svg?.getAttribute("width")).toBe("20");
	});
	it("is an image with a title when given one", () => {
		const { container } = render(<LensGlyph title="Lens" />);
		const svg = container.querySelector("svg");
		expect(svg?.getAttribute("role")).toBe("img");
		expect(svg?.getAttribute("aria-hidden")).toBeNull();
		expect(container.querySelector("title")?.textContent).toBe("Lens");
	});
	it("contains no hex colour literal", () => {
		const { container } = render(<LensGlyph title="Lens" />);
		expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});
});
