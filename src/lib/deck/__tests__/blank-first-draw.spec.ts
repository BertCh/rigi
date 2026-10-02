// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import type { Pose } from "#/lib/camera";
import { pendingPrograms, waitForPrograms } from "../device-lost";
import { redrawIfBlank } from "../silhouette-mask";

const pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 } as Pose;

/** A device whose luma pipeline factory holds programs with the given link statuses. */
function deviceWith(statuses: string[]) {
	const cache: Record<string, { resource: { linkStatus: string } }> = {};
	statuses.forEach((linkStatus, i) => {
		cache[`p${i}`] = { resource: { linkStatus } };
	});
	const device = {
		_moduleData: {
			"@luma.gl/core": {
				defaultPipelineFactory: { _sharedRenderPipelineCache: cache },
			},
		},
	};
	return { device: device as unknown as Device, cache };
}

describe("waitForPrograms", () => {
	it("counts only pending programs; a device without a factory has none", () => {
		expect(pendingPrograms(deviceWith(["success", "pending"]).device)).toBe(1);
		expect(pendingPrograms({} as Device)).toBe(0);
	});

	it("resolves at once when nothing is linking", async () => {
		expect(await waitForPrograms(deviceWith(["success"]).device)).toBe(true);
	});

	it("waits until the last pending program links", async () => {
		const { device, cache } = deviceWith(["pending"]);
		setTimeout(() => {
			cache.p0.resource.linkStatus = "success";
		}, 30);
		expect(await waitForPrograms(device, 2000, 5)).toBe(true);
		expect(pendingPrograms(device)).toBe(0);
	});

	it("gives up after maxMs", async () => {
		expect(await waitForPrograms(deviceWith(["pending"]).device, 40, 5)).toBe(
			false,
		);
	});
});

describe("redrawIfBlank beforeRedraw", () => {
	const blank = () => new Float32Array(4).fill(Number.POSITIVE_INFINITY);

	it("runs between the blank read and the redraw, in that order", async () => {
		const order: string[] = [];
		const src = {
			range: blank(),
			render: vi.fn(async () => {
				order.push("render");
			}),
		};
		const redrew = await redrawIfBlank(src, pose, async () => {
			order.push("before");
		});
		expect(redrew).toBe(true);
		expect(order).toEqual(["before", "render"]);
	});

	it("is not called when the render holds terrain", async () => {
		const before = vi.fn(async () => {});
		const src = {
			range: new Float32Array([0, 120, Number.POSITIVE_INFINITY, 0]),
			render: vi.fn(async () => {}),
		};
		expect(await redrawIfBlank(src, pose, before)).toBe(false);
		expect(before).not.toHaveBeenCalled();
		expect(src.render).not.toHaveBeenCalled();
	});
});
