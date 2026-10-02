// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "#/lib/ontology/core/storage";
import {
	Button,
	ColorSwatch,
	PanelBand,
	Section,
	SectionAccordion,
	Segmented,
	Slider,
	Toggle,
} from "../controls";

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal("navigator", { ...navigator, webdriver: false });
});
afterEach(cleanup);

describe("Section", () => {
	it("is always open without collapse", () => {
		render(
			<Section title="View">
				<p>body</p>
			</Section>,
		);
		expect(screen.getByText("body")).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("toggles and remembers its state", () => {
		const { unmount } = render(
			<Section title="Pose" collapse={{ id: "t1", defaultOpen: false }}>
				<p>body</p>
			</Section>,
		);
		const btn = screen.getByRole("button");
		expect(btn.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("body")).toBeNull();
		fireEvent.click(btn);
		expect(btn.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("body")).toBeTruthy();
		expect(localStorage.getItem(storageKey("panel", "t1"))).toBe("1");
		unmount();
		render(
			<Section title="Pose" collapse={{ id: "t1", defaultOpen: false }}>
				<p>body</p>
			</Section>,
		);
		expect(screen.getByText("body")).toBeTruthy();
	});

	it("shows the summary only while closed", () => {
		render(
			<Section
				title="Pose"
				summary="3 changes"
				collapse={{ id: "t2", defaultOpen: false }}
			>
				x
			</Section>,
		);
		expect(screen.getByText("3 changes")).toBeTruthy();
		fireEvent.click(screen.getByRole("button"));
		expect(screen.queryByText("3 changes")).toBeNull();
	});

	it("starts open under webdriver", () => {
		vi.stubGlobal("navigator", { ...navigator, webdriver: true });
		render(
			<Section title="A" collapse={{ id: "t3", defaultOpen: false }}>
				<p>body</p>
			</Section>,
		);
		expect(screen.getByText("body")).toBeTruthy();
	});
});

describe("SectionAccordion", () => {
	const panel = () => (
		<SectionAccordion id="acc" defaultOpen="a">
			<Section title="A" collapse={{ id: "a" }}>
				<p>body a</p>
			</Section>
			<Section title="B" collapse={{ id: "b" }}>
				<p>body b</p>
			</Section>
			<Section title="Fixed">
				<p>body fixed</p>
			</Section>
		</SectionAccordion>
	);

	it("opens only the default section at first", () => {
		render(panel());
		expect(screen.getByText("body a")).toBeTruthy();
		expect(screen.queryByText("body b")).toBeNull();
		expect(screen.getByText("body fixed")).toBeTruthy();
	});

	it("opening one closes the other and is remembered", () => {
		const { unmount } = render(panel());
		fireEvent.click(screen.getByText("B"));
		expect(screen.getByText("body b")).toBeTruthy();
		expect(screen.queryByText("body a")).toBeNull();
		expect(localStorage.getItem(storageKey("panel", "acc"))).toBe("b");
		unmount();
		render(panel());
		expect(screen.getByText("body b")).toBeTruthy();
		expect(screen.queryByText("body a")).toBeNull();
	});

	it("closing the open section leaves all closed", () => {
		render(panel());
		fireEvent.click(screen.getByText("A"));
		expect(screen.queryByText("body a")).toBeNull();
		expect(screen.queryByText("body b")).toBeNull();
	});

	it("opens every section under webdriver", () => {
		vi.stubGlobal("navigator", { ...navigator, webdriver: true });
		render(panel());
		expect(screen.getByText("body a")).toBeTruthy();
		expect(screen.getByText("body b")).toBeTruthy();
	});
});

describe("PanelBand", () => {
	it("renders label and hint", () => {
		render(<PanelBand label="Advanced" hint="rarely" />);
		expect(screen.getByText("Advanced")).toBeTruthy();
		expect(screen.getByText("rarely")).toBeTruthy();
	});
});

describe("Slider", () => {
	it("formats the value and reports numbers", () => {
		const onChange = vi.fn();
		render(
			<Slider label="Haze" value={0.5} min={0} max={1} onChange={onChange} />,
		);
		expect(screen.getByText("0.50")).toBeTruthy();
		fireEvent.change(screen.getByRole("slider"), { target: { value: "0.75" } });
		expect(onChange).toHaveBeenCalledWith(0.75);
	});
	it("uses a custom format", () => {
		render(
			<Slider
				label="FOV"
				value={40}
				min={10}
				max={90}
				onChange={() => {}}
				format={(v) => `${v}°`}
			/>,
		);
		expect(screen.getByText("40°")).toBeTruthy();
	});
});

describe("Segmented", () => {
	it("calls onChange with the clicked option", () => {
		const onChange = vi.fn();
		render(
			<Segmented
				value="a"
				onChange={onChange}
				options={[
					{ value: "a", label: "A" },
					{ value: "b", label: "B", title: "Bee" },
				]}
			/>,
		);
		fireEvent.click(screen.getByTitle("Bee"));
		expect(onChange).toHaveBeenCalledWith("b");
	});
	it("marks the selected option pressed", () => {
		render(
			<Segmented
				value="b"
				onChange={() => {}}
				options={[
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				]}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "A" }).getAttribute("aria-pressed"),
		).toBe("false");
		expect(
			screen.getByRole("button", { name: "B", pressed: true }),
		).toBeTruthy();
	});
});

describe("Toggle", () => {
	it("flips the checked value", () => {
		const onChange = vi.fn();
		render(<Toggle label="Labels" checked={false} onChange={onChange} />);
		fireEvent.click(screen.getByRole("switch", { name: "Labels" }));
		expect(onChange).toHaveBeenCalledWith(true);
	});
	it("exposes its state as a switch", () => {
		const { rerender } = render(
			<Toggle label="Labels" checked={false} onChange={() => {}} />,
		);
		expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
			"false",
		);
		rerender(<Toggle label="Labels" checked onChange={() => {}} />);
		expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
			"true",
		);
	});
	it("flips back when checked", () => {
		const onChange = vi.fn();
		render(<Toggle label="Labels" checked onChange={onChange} />);
		fireEvent.click(screen.getByRole("switch"));
		expect(onChange).toHaveBeenCalledWith(false);
	});
});

describe("ColorSwatch", () => {
	it("reports a hex colour", () => {
		const onChange = vi.fn();
		render(<ColorSwatch label="Sky" value="#112233" onChange={onChange} />);
		const input = screen.getByLabelText("Sky") as HTMLInputElement;
		expect(input.type).toBe("color");
		fireEvent.change(input, { target: { value: "#aabbcc" } });
		expect(onChange).toHaveBeenCalledWith("#aabbcc");
	});
});

describe("Button", () => {
	it("clicks and disables", () => {
		const onClick = vi.fn();
		const { rerender } = render(<Button onClick={onClick}>Go</Button>);
		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		expect(onClick).toHaveBeenCalledTimes(1);
		rerender(
			<Button onClick={onClick} disabled>
				Go
			</Button>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Go" }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
