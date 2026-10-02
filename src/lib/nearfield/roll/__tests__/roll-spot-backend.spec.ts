// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import type { RollMapEngine } from "../../../roll/map/roll-map";
import { layerExtensions } from "../../../terroir/roll/roll-map-extras";
import type { GaussianCloud } from "../../types";
import { setSpot } from "../roll-spot";

function fakeEngine(kind: "webgl" | "webgpu", device: unknown = null) {
	return {
		backendKind: kind,
		renderDevice: device,
		setExtraLayers: vi.fn(),
		setExtraCores: vi.fn(),
	} as unknown as RollMapEngine & {
		setExtraLayers: ReturnType<typeof vi.fn>;
		setExtraCores: ReturnType<typeof vi.fn>;
	};
}
const cloud = { count: 0 } as unknown as GaussianCloud;

describe("setSpot", () => {
	it("WebGL: a DeckSplatLayer through setExtraLayers, null clears", async () => {
		const e = fakeEngine("webgl");
		expect(await setSpot(e, cloud)).toBe(true);
		const layers = e.setExtraLayers.mock.calls[0][1] as { id: string }[];
		expect(layers).toHaveLength(1);
		expect(layers[0].id).toBe("spot3d");
		await setSpot(e, null);
		expect(e.setExtraLayers).toHaveBeenLastCalledWith("spot3d", null);
		expect(e.setExtraCores).not.toHaveBeenCalled();
	});

	it("WebGPU: nothing to show before the device exists; clearing is safe", async () => {
		const e = fakeEngine("webgpu");
		expect(await setSpot(e, cloud)).toBe(false);
		expect(e.setExtraLayers).not.toHaveBeenCalled();
		expect(await setSpot(e, null)).toBe(true);
		expect(e.setExtraCores).toHaveBeenCalledWith("spot3d", null);
	});
});

describe("layerExtensions", () => {
	it("log depth on WebGL2 only", () => {
		expect(layerExtensions("webgl")).toHaveLength(1);
		expect(layerExtensions("webgpu")).toEqual([]);
	});
});
