// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSettings } from "#/lib/settings";
import { getStyleStore } from "#/lib/style";
import { StylePanel } from "../StylePanel";

function Harness() {
	const store = getStyleStore();
	return (
		<StylePanel
			mode="world"
			settings={defaultSettings}
			style={store.getStyle()}
			state={store.getState()}
		/>
	);
}

/** Mounts the world-view panel and reopens it after every store edit (the real panel is store-driven). */
function mount() {
	const view = render(<Harness />);
	return () => view.rerender(<Harness />);
}

beforeEach(() => {
	localStorage.clear();
	getStyleStore().setState({ preset: "classic", overrides: {} });
});
afterEach(cleanup);

describe("StylePanel world layers", () => {
	it("switches weather with the variant default and shows its sliders only when on", () => {
		const refresh = mount();
		fireEvent.click(screen.getByText("Water, wind and weather"));
		expect(screen.queryByText("Weather wind")).toBeNull();
		fireEvent.click(screen.getByText("Snow"));
		refresh();
		expect(getStyleStore().getStyle().world.weather).toEqual({
			mode: "snow",
			intensity: 0.6,
			wind: 1,
		});
		expect(screen.getByText("Weather wind")).toBeTruthy();
		fireEvent.click(screen.getByText("Rain"));
		refresh();
		expect(getStyleStore().getStyle().world.weather).toEqual({
			mode: "rain",
			intensity: 0.6,
			wind: 3,
		});
		fireEvent.click(screen.getByText("Clear"));
		refresh();
		expect(getStyleStore().getStyle().world.weather).toEqual({ mode: "off" });
		expect(screen.queryByText("Weather wind")).toBeNull();
	});

	it("switches the atmosphere to physical with its defaults", () => {
		const refresh = mount();
		fireEvent.click(screen.getAllByText("Haze")[0]);
		fireEvent.click(screen.getByText("Physical"));
		refresh();
		const a = getStyleStore().getStyle().terrain.atmosphere;
		expect(a.mode).toBe("physical");
		expect(screen.getByText("Valley fog")).toBeTruthy();
	});
});
