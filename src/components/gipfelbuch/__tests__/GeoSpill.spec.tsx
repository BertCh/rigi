// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import fs from "node:fs";
import path from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TafelBake } from "../tafel/useTafelBake";
import { GeoSpill, type SpillCursor, type SpillEcho } from "../viz/GeoSpill";
import type { PhotoLayer } from "../viz/inks";
import type { GipfelbuchPhotoData } from "../viz/real";

const DEMO = path.resolve(__dirname, "../../../../public/demo/gipfelbuch");
const data = JSON.parse(
	fs.readFileSync(path.join(DEMO, "demo-09.json"), "utf8"),
) as GipfelbuchPhotoData;
const bake = JSON.parse(
	fs.readFileSync(path.join(DEMO, "tafel/demo-09.json"), "utf8"),
) as TafelBake;

// a 600 px photo centred in a 1400 px window, so each side has 400 px of room
beforeEach(() => {
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
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function Spill({
	layers,
	cursor,
	t = 1,
	states,
	shown,
}: {
	layers: PhotoLayer[];
	cursor?: SpillCursor;
	t?: number;
	states?: SpillEcho["states"];
	shown?: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	return (
		<div ref={ref}>
			<GeoSpill
				hostRef={ref}
				data={data}
				bake={bake}
				frame={[0, 0, data.photo.width, data.photo.height]}
				maxSpill={0.5}
				t={t}
				immediate
				echo={{ layers, states }}
				cursor={cursor}
				shown={shown}
			/>
		</div>
	);
}

describe("GeoSpill", () => {
	it("draws plain ridges and no echo for a bare photo", async () => {
		const { getByTestId, queryByTestId } = render(<Spill layers={[]} />);
		await act(async () => {});
		expect(getByTestId("gb-geo-spill")).toBeTruthy();
		expect(queryByTestId("gb-geo-spill-echo")).toBeNull();
	});

	it("carries the sky, the skyline and both poses past the frame", async () => {
		const { getByTestId, getByText } = render(
			<Spill layers={["sky", "skyline", "prior", "solved"]} />,
		);
		await act(async () => {});
		const echo = getByTestId("gb-geo-spill-echo");
		// hachure + three lines, each with at least one path
		expect(echo.querySelectorAll("path").length).toBeGreaterThanOrEqual(4);
		expect(getByText(/same turn/)).toBeTruthy();
	});

	it("marks a cursor bearing on the ruler and drops it past the frame", async () => {
		const az = data.solved.yaw - data.solved.hfov / 2 - 12; // left of the frame
		const { getByTestId, getByText } = render(
			<Spill layers={[]} cursor={{ az }} />,
		);
		await act(async () => {});
		const mark = getByTestId("gb-geo-spill-cursor");
		expect(mark.querySelector("circle")).toBeTruthy();
		expect(getByText(`${Math.round(((az % 360) + 360) % 360)}°`)).toBeTruthy();
	});

	it("reads its reveal from --gb-spill-reveal, defaulting to shown", async () => {
		const { getByTestId } = render(<Spill layers={[]} />);
		await act(async () => {});
		expect(getByTestId("gb-geo-spill").style.opacity).toBe(
			"var(--gb-spill-reveal, 1)",
		);
	});

	it("puts no transition on a reveal its figure drives itself", async () => {
		const { getByTestId } = render(<Spill layers={[]} />);
		await act(async () => {});
		// PhotoStory writes --gb-spill-reveal per frame: an eased opacity would lag its wipe
		expect(getByTestId("gb-geo-spill").style.transition).toBe("");
	});

	it("hides itself while its figure's bloom is pending", async () => {
		const { getByTestId } = render(<Spill layers={[]} shown={false} />);
		await act(async () => {});
		expect(getByTestId("gb-geo-spill").style.opacity).toBe(
			"calc(var(--gb-spill-reveal, 1) * 0)",
		);
	});

	it("keeps each echo line in step with its layer in the photo", async () => {
		const { getByTestId, queryByText } = render(
			<Spill
				layers={["prior", "solved", "skyline"]}
				states={{
					prior: { state: "ghost" },
					solved: { state: "on", delay: 80 },
					skyline: { state: "hidden" },
				}}
			/>,
		);
		await act(async () => {});
		const layers = [
			...getByTestId("gb-geo-spill-echo").querySelectorAll("[data-layer]"),
		].map(
			(g) => `${g.getAttribute("data-layer")}:${g.getAttribute("data-state")}`,
		);
		// stack order: the two derived horizons under the measured skyline
		expect(layers).toEqual(["derived:ghost", "derived:on", "measured:hidden"]);
		// the note names what is on, not the hidden skyline: both poses count (ghost included)
		expect(queryByText(/same turn/)).toBeTruthy();
	});

	it("labels a column cursor with its bearing at the spill's pose", async () => {
		const { getByText, getByTestId } = render(
			<Spill layers={[]} cursor={{ x: data.photo.width / 2 }} />,
		);
		await act(async () => {});
		// inside the frame: no drop ring
		expect(
			getByTestId("gb-geo-spill-cursor").querySelector("circle"),
		).toBeNull();
		expect(getByText(`${Math.round(data.solved.yaw)}°`)).toBeTruthy();
	});
});
