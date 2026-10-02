// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import { openErrorScopes, submittedWorkDone } from "../queue";

/** A WebGPU-typed device whose native handle records the scope calls. */
function scopedDevice(errors: ({ message: string } | null)[]) {
	const log: string[] = [];
	const handle = {
		pushErrorScope: (f: string) => log.push(`push ${f}`),
		popErrorScope: () => {
			log.push("pop");
			return Promise.resolve(errors.shift() ?? null);
		},
	};
	return { device: { type: "webgpu", handle } as unknown as Device, log };
}

describe("openErrorScopes", () => {
	it("is null on a non-WebGPU device", () => {
		expect(openErrorScopes({ type: "webgl" } as unknown as Device)).toBeNull();
		expect(openErrorScopes({ type: "webgpu" } as unknown as Device)).toBeNull();
	});

	it("pushes out-of-memory then validation, pops both, resolves null when clean", async () => {
		const { device, log } = scopedDevice([null, null]);
		const close = openErrorScopes(device);
		expect(log).toEqual(["push out-of-memory", "push validation"]);
		expect(await close?.()).toBeNull();
		expect(log).toEqual([
			"push out-of-memory",
			"push validation",
			"pop",
			"pop",
		]);
	});

	it("reports the validation error before the out-of-memory one", async () => {
		const both = scopedDevice([{ message: "bad bind" }, { message: "oom" }]);
		expect(await openErrorScopes(both.device)?.()).toEqual({
			kind: "validation",
			message: "bad bind",
		});
		const oom = scopedDevice([null, { message: "oom" }]);
		expect(await openErrorScopes(oom.device)?.()).toEqual({
			kind: "out-of-memory",
			message: "oom",
		});
	});
});

describe("submittedWorkDone", () => {
	it("awaits a luma fence and destroys it", async () => {
		const destroy = vi.fn();
		let signal = () => {};
		const signaled = new Promise<void>((r) => {
			signal = r;
		});
		const device = {
			createFence: () => ({ signaled, destroy }),
		} as unknown as Device;
		let done = false;
		const p = submittedWorkDone(device).then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(done).toBe(false);
		signal();
		await p;
		expect(done).toBe(true);
		expect(destroy).toHaveBeenCalledTimes(1);
	});
});
