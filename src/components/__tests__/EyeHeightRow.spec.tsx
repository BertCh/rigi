// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAltitude } from "#/lib/geo/eye-rule";
import { EyeHeightRow, eyeRuleNote } from "../EyeHeightRow";

vi.mock("#/lib/tiles3d/geoid", () => ({ geoidUndulation: () => 48.6 }));
afterEach(cleanup);

const G = 1950;
const row = (p: Partial<Parameters<typeof EyeHeightRow>[0]>) =>
	render(
		<dl>
			<EyeHeightRow
				alt={null}
				ground={G}
				eyeAlt={G + 1.8}
				lat={46.7}
				lon={7.8}
				{...p}
			/>
		</dl>,
	);
const verdict = () =>
	document
		.querySelector("[data-eye-verdict]")
		?.getAttribute("data-eye-verdict");

describe("eyeRuleNote", () => {
	it("names the branch of the rule", () => {
		expect(eyeRuleNote(checkAltitude(null, G), G + 1.8)).toBe(
			"ground + 1.8 m: no GPS altitude",
		);
		expect(eyeRuleNote(checkAltitude(G - 20, G), G + 1.6)).toBe(
			"ground + 1.6 m: GPS altitude 20 m below",
		);
		expect(eyeRuleNote(checkAltitude(G + 11.6, G), G + 11.6)).toBe(
			"GPS altitude, 10 m above standing height",
		);
	});

	it("says lake level when the engine raised the eye above the rule", () => {
		expect(eyeRuleNote(checkAltitude(null, G), G + 6)).toBe(
			"raised to the lake level",
		);
	});
});

describe("EyeHeightRow", () => {
	it("shows a dash and no note before the engine placed the eye", () => {
		row({ eyeAlt: 0, ground: Number.NaN });
		expect(screen.getByText("—")).toBeTruthy();
		expect(verdict()).toBeUndefined();
	});

	it("shows the eye and the rule's branch", () => {
		row({ alt: G + 30, eyeAlt: G + 30 });
		expect(screen.getByText(`${G + 30} m`)).toBeTruthy();
		expect(verdict()).toBe("raised");
	});

	it("names the floor when the GPS altitude is underground", () => {
		row({ alt: G - 40, eyeAlt: G + 1.6 });
		expect(verdict()).toBe("underground");
		expect(
			screen.getByText("ground + 1.6 m: GPS altitude 40 m below"),
		).toBeTruthy();
	});

	it("says so when the engine has no DEM at the camera", () => {
		row({ alt: 1200, ground: Number.NaN, eyeAlt: 1201.6 });
		expect(verdict()).toBe("no-ground");
	});

	it("shows a lake-level raise", () => {
		row({ alt: null, eyeAlt: G + 7 });
		expect(screen.getByText("raised to the lake level")).toBeTruthy();
	});

	it("flags a geoid-sized lift on an Android model", () => {
		row({ alt: G + 1.6 + 49, eyeAlt: G + 50.6, model: "Pixel 8" });
		expect(verdict()).toBe("ellipsoid-suspect");
		expect(screen.getByText(/above the ellipsoid/)).toBeTruthy();
	});

	it("never flags an iPhone", () => {
		row({ alt: G + 1.6 + 49, eyeAlt: G + 50.6, model: "iPhone 15 Pro" });
		expect(verdict()).toBe("raised");
	});
});
