// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import {
	type OverlayPhoto,
	type OverlayState,
	rollOverlays,
	SELECTION_RGBA,
	viewpointColor,
} from "../overlays";

const POSE = { yaw: 0, pitch: 0, roll: 0, vfov: 50 };
const photo = (id: string, x: number, viewpoint = 0): OverlayPhoto => ({
	id,
	pose: POSE,
	eye: [x, 0, 0],
	aspect: 1.5,
	viewpoint,
});

const state = (over: Partial<OverlayState> = {}): OverlayState => ({
	placed: [photo("a", 0), photo("b", 1000), photo("c", 2000)],
	gain: () => 1,
	selected: null,
	hoverId: null,
	flyingId: null,
	flightActive: false,
	photoPlaneOpacity: 1,
	thumbs: new Map(),
	gizmos: true,
	...over,
});

describe("rollOverlays", () => {
	it("a hidden photo (gain 0) has no frustum and no pin", () => {
		const o = rollOverlays(state({ gain: (id) => (id === "b" ? 0 : 1) }));
		expect(o.gizmos.map((g) => g.id)).toEqual(["a", "c"]);
		expect(o.pins.map((p) => p.id)).toEqual(["a", "c"]);
	});

	it("settings.gizmos off drops the frustums but keeps the pins", () => {
		const o = rollOverlays(state({ gizmos: false }));
		expect(o.gizmos).toEqual([]);
		expect(o.pins).toHaveLength(3);
	});

	it("selected: bigger frustum and pin, opaque line, brand ring, thumbnail only on it", () => {
		const thumb = {} as ImageBitmap;
		const o = rollOverlays(
			state({
				selected: "b",
				gain: (id) => (id === "b" ? 3 : 0.3),
				thumbs: new Map([
					["a", thumb],
					["b", thumb],
				]),
			}),
		);
		const [a, b] = o.gizmos;
		expect(b.pinRadiusM).toBe(26);
		expect(a.pinRadiusM).toBe(16);
		expect(b.planeOpacity).toBe(0.95);
		expect(a.planeOpacity).toBe(0.8);
		expect(b.lineColor[3]).toBe(255);
		expect(a.lineColor[3]).toBe(90);
		expect(b.image).toBe(thumb);
		expect(a.image).toBeNull();
		const pinB = o.pins.find((p) => p.id === "b");
		expect(pinB?.radiusPx).toBe(8);
		expect(pinB?.line).toEqual(SELECTION_RGBA);
		expect(pinB?.lineWidthPx).toBe(2.5);
	});

	it("no selection: every thumbnail shows, lines at 200", () => {
		const thumb = {} as ImageBitmap;
		const o = rollOverlays(state({ thumbs: new Map([["a", thumb]]) }));
		expect(o.gizmos[0].image).toBe(thumb);
		expect(o.gizmos[1].image).toBeNull();
		expect(o.gizmos.every((g) => g.lineColor[3] === 200)).toBe(true);
	});

	it("hover: radius 7, thick white ring", () => {
		const p = rollOverlays(state({ hoverId: "c" })).pins[2];
		expect(p.radiusPx).toBe(7);
		expect(p.lineWidthPx).toBe(2.5);
		expect(p.line).toEqual([255, 255, 255, 230]);
		expect(p.fill).toEqual([...viewpointColor(0), 255]);
	});

	it("plain pin: radius 5, hairline", () => {
		const p = rollOverlays(state()).pins[0];
		expect(p.radiusPx).toBe(5);
		expect(p.lineWidthPx).toBe(1.2);
	});

	it("flying in: neighbours within 500 m are skipped, far ones stay", () => {
		const placed = [photo("a", 0), photo("n", 300), photo("f", 3000)];
		const o = rollOverlays(
			state({ placed, flyingId: "a", flightActive: true }),
		);
		expect(o.gizmos.map((g) => g.id)).toEqual(["a", "f"]);
		expect(o.gizmos[0].planeOpacity).toBe(1);
	});

	it("flying in: the flown-into frustum goes once its plane has faded", () => {
		const o = rollOverlays(
			state({ flyingId: "a", flightActive: true, photoPlaneOpacity: 0.01 }),
		);
		expect(o.gizmos.map((g) => g.id)).toEqual(["b", "c"]);
	});

	it("arrived (no flight): neighbours keep their frustums, the flown photo uses the plane opacity", () => {
		const placed = [photo("a", 0), photo("n", 300)];
		const o = rollOverlays(
			state({
				placed,
				flyingId: "a",
				flightActive: false,
				photoPlaneOpacity: 0.4,
			}),
		);
		expect(o.gizmos.map((g) => g.id)).toEqual(["a", "n"]);
		expect(o.gizmos[0].planeOpacity).toBe(0.4);
	});

	it("pins within 30 m of the viewpoint the camera is in are skipped", () => {
		const placed = [photo("a", 0), photo("same", 20), photo("near", 40)];
		const o = rollOverlays(state({ placed, flyingId: "a" }));
		expect(o.pins.map((p) => p.id)).toEqual(["near"]);
	});
});
