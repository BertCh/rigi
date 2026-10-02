// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NodeInspection } from "#/lib/gpu/core/inspect";
import { describeNode, GraphProvenance } from "../GraphProvenance";

const none = { samples: 0 };
const nodes: NodeInspection[] = [
	{
		id: "argmin",
		type: "compute",
		condition: "cpu skip",
		maximumInvocationCount: 4096,
		cpu: none,
		gpu: { samples: 3, p50Ms: 0.25 },
	},
	{ id: "bare", cpu: none, gpu: none },
];

describe("GraphProvenance", () => {
	it("describes only the fields a node has", () => {
		expect(describeNode(nodes[0])).toEqual([
			"compute",
			"cpu skip",
			"up to 4096 invocations",
			"gpu p50 0.250 ms",
		]);
		expect(describeNode(nodes[1])).toEqual([]);
	});

	it("is collapsed by default and lists only nodes with facts when opened", () => {
		render(<GraphProvenance nodes={nodes} />);
		expect(screen.queryByText(/argmin/)).toBeNull();
		fireEvent.click(screen.getByRole("button"));
		expect(screen.getByText("argmin")).toBeTruthy();
		expect(screen.queryByText("bare")).toBeNull();
	});

	it("renders nothing when no node has data", () => {
		const { container } = render(<GraphProvenance nodes={[nodes[1]]} />);
		expect(container.innerHTML).toBe("");
	});
});
