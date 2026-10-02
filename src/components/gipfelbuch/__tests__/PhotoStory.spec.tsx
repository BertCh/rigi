// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GipfelbuchPhotoData } from "../viz/real";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const read = (id: string) =>
	JSON.parse(
		fs.readFileSync(path.join(DEMO, `${id}.json`), "utf8"),
	) as GipfelbuchPhotoData;
const accepted = read("demo-09");
const refused = read("demo-07");

const state = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../viz/real", async (importOriginal) => ({
	...(await importOriginal<typeof import("../viz/real")>()),
	useGipfelbuchPhoto: () => state.data,
}));
vi.mock("../notebook/useNotebookPhoto", () => ({
	useNotebookPhoto: () => ["demo-09", () => {}],
}));

import { PhotoStory } from "../viz/PhotoStory";

beforeAll(() => {
	// the static frame: webdriver automation shows the settled film
	Object.defineProperty(navigator, "webdriver", {
		value: true,
		configurable: true,
	});
	vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));
});
afterEach(cleanup);

describe("PhotoStory static frame", () => {
	it("an accepted photo settles on strikes, the solved line and the verdict", () => {
		state.data = accepted;
		const { container, getAllByText, getByText } = render(
			<PhotoStory photoId="demo-09" />,
		);
		expect(
			container.querySelectorAll('[data-film="strike"]').length,
		).toBeGreaterThan(0);
		expect(
			container
				.querySelector('[data-film="solved-line"]')
				?.getAttribute("opacity"),
		).toBe("1");
		expect(
			container.querySelector('[data-film="verdict"]')?.getAttribute("opacity"),
		).toBe("1");
		expect(
			getByText(`confidence ${accepted.solved.confidence.toFixed(2)}`),
		).toBeTruthy();
		// four beats, the last is snap
		expect(getAllByText("snap").length).toBeGreaterThan(0);
		expect(getByText("From the phone's pose to the solved pose")).toBeTruthy();
	});

	it("a refused photo ends on keep, with no strikes and a stamp", () => {
		state.data = refused;
		const { container, getAllByText, queryByText } = render(
			<PhotoStory photoId="demo-07" />,
		);
		expect(getAllByText("keep").length).toBeGreaterThan(0);
		expect(queryByText("snap")).toBeNull();
		expect(container.querySelectorAll('[data-film="strike"]')).toHaveLength(0);
		expect(
			getAllByText(/refused: confidence 0\.46 < 0\.5/).length,
		).toBeGreaterThan(0);
	});

	it("focus eye shows the GPS-under-the-ground note in the static frame", () => {
		state.data = accepted;
		const { getByText } = render(<PhotoStory photoId="demo-09" focus="eye" />);
		expect(getByText(/under the ground → eye at 1915 m/)).toBeTruthy();
	});

	it("focus gaps shows the p90 readout and the extra turn numbers", () => {
		state.data = accepted;
		const { getByText } = render(<PhotoStory photoId="demo-09" focus="gaps" />);
		expect(getByText(/p90 36→24 · ≤5 px 21%→74%/)).toBeTruthy();
		expect(getByText(/focal ×1\.02/)).toBeTruthy();
	});

	it("focus snap labels how far each summit moved", () => {
		state.data = accepted;
		const { container } = render(<PhotoStory photoId="demo-09" focus="snap" />);
		const moved = container.querySelectorAll('[data-film="moved"]');
		expect(moved.length).toBeGreaterThan(0);
		expect(moved[0].textContent).toMatch(/^moved \d+ px$/);
	});
});
