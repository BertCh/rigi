// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import {
	DeckExtrasOverlay,
	type OverlayDeck,
	type OverlayDeckProps,
} from "../webgpu-deck-overlay";

function harness() {
	const calls: string[] = [];
	let props!: OverlayDeckProps;
	const deck: OverlayDeck = {
		setProps: (p) => calls.push(`setProps:${Object.keys(p).sort().join(",")}`),
		redraw: (r) => {
			calls.push(`redraw:${r}`);
			props.customRender(r ?? "");
		},
		finalize: () => calls.push("finalize"),
		layerManager: { updateLayers: () => calls.push("update") },
		_drawLayers: (r, o) => calls.push(`draw:${r}:${JSON.stringify(o)}`),
	};
	const onNeedFrame = vi.fn();
	const created = vi.fn((p: OverlayDeckProps) => {
		props = p;
		return deck;
	});
	const overlay = new DeckExtrasOverlay({} as never, {
		pixelRatio: 2,
		onNeedFrame,
		createDeck: created,
	});
	return { overlay, calls, onNeedFrame, created, props: () => props };
}

describe("DeckExtrasOverlay", () => {
	it("creates no deck until there are layers", () => {
		const h = harness();
		h.overlay.setLayers([]);
		expect(h.created).not.toHaveBeenCalled();
		expect(h.overlay.active).toBe(false);
		h.overlay.setLayers([{}]);
		expect(h.created).toHaveBeenCalledTimes(1);
		expect(h.created.mock.calls[0][0].useDevicePixels).toBe(2);
		expect(h.overlay.active).toBe(true);
	});

	it("asks the host for a frame when the deck loads, then paints with clearCanvas false", () => {
		const h = harness();
		const layer = {};
		h.overlay.setViewState({ v: 1 });
		h.overlay.setLayers([layer]);
		h.overlay.draw(); // not loaded yet
		expect(h.calls).toEqual([]);
		h.props().onLoad();
		expect(h.onNeedFrame).toHaveBeenCalledTimes(1);
		h.overlay.draw();
		expect(h.calls).toEqual([
			"setProps:layers,viewState",
			"update",
			"redraw:rigi",
			'draw:rigi:{"clearCanvas":false}',
		]);
		expect(h.overlay.paints).toBe(1);
		// unchanged layers are not re-sent
		h.calls.length = 0;
		h.overlay.setLayers([layer]);
		h.overlay.draw();
		expect(h.calls[0]).toBe("setProps:viewState");
	});

	it("a deck-initiated redraw outside a frame requests a host frame instead of painting", () => {
		const h = harness();
		h.overlay.setLayers([{}]);
		h.props().customRender("icon atlas");
		expect(h.onNeedFrame).toHaveBeenCalledTimes(1);
		expect(h.overlay.paints).toBe(0);
	});

	it("draws nothing without a view state, pushes an emptied list once, and finalizes once", () => {
		const h = harness();
		h.overlay.setLayers([{}]);
		h.props().onLoad();
		h.overlay.draw();
		expect(h.overlay.paints).toBe(0);
		h.overlay.setViewState({});
		h.overlay.setLayers([]);
		// the emptied list reaches deck once, so it drops the old layers
		h.overlay.draw();
		expect(h.overlay.paints).toBe(1);
		h.overlay.draw();
		expect(h.overlay.paints).toBe(1);
		h.overlay.destroy();
		h.overlay.destroy();
		expect(h.calls.filter((c) => c === "finalize")).toHaveLength(1);
		h.overlay.setLayers([{}]);
		expect(h.created).toHaveBeenCalledTimes(1);
	});
});
