// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Callout } from "../viz/Callout";

afterEach(cleanup);

describe("Callout", () => {
	it("defaults to the note voice", () => {
		render(<Callout>hello</Callout>);
		expect(screen.getByText("I notice")).toBeTruthy();
		expect(screen.getByText("hello")).toBeTruthy();
	});
	it.each([
		["lesson", "So:"],
		["warning", "Careful, trap!"],
		["result", "Result"],
		["negative", "Tried this"],
	] as const)("%s has its default title", (tone, label) => {
		render(<Callout tone={tone}>x</Callout>);
		expect(screen.getByText(label)).toBeTruthy();
	});
	it("uses an explicit title and marks negative results", () => {
		render(
			<Callout tone="negative" title="Joint solve">
				body
			</Callout>,
		);
		expect(screen.getByText("Joint solve")).toBeTruthy();
		expect(screen.getByText(/didn't work/)).toBeTruthy();
	});
	it("renders as an aside", () => {
		render(<Callout>x</Callout>);
		expect(screen.getByRole("complementary")).toBeTruthy();
	});
	it("is deterministic across renders", () => {
		const a = render(<Callout tone="lesson">x</Callout>).container.innerHTML;
		cleanup();
		const b = render(<Callout tone="lesson">x</Callout>).container.innerHTML;
		expect(a).toBe(b);
	});
});
