// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LiveFingerprint,
	LivePixelToPlace,
	LiveSideSection,
} from "../viz/live";

afterEach(cleanup);

describe("site/meta live plates", () => {
	it.each([
		["LiveFingerprint", LiveFingerprint, "Sliding the skyline"],
		["LiveSideSection", LiveSideSection, "farthest ridge"],
		["LivePixelToPlace", LivePixelToPlace, "Each pixel is a ray"],
	] as const)("%s shows its title and caption on the poster until it is near", (_name, Plate, title) => {
		// an observer that never fires: the plate is never near, stays on its poster, no figure is fetched
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe() {}
				disconnect() {}
				unobserve() {}
			},
		);
		const { container, getAllByText } = render(<Plate number="9" />);
		expect(getAllByText(new RegExp(title)).length).toBeGreaterThan(0);
		expect(container.textContent).toContain("9");
		expect(container.querySelector("svg[data-meta-figure]")).toBeNull();
		vi.unstubAllGlobals();
	});
});
