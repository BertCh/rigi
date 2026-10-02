// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";

const made: { loseDevice: () => void; destroy: () => void }[] = [];
vi.mock("@luma.gl/webgl", () => ({
	WebGLDevice: class {
		loseDevice = vi.fn();
		destroy = vi.fn();
		constructor() {
			made.push(this);
		}
	},
}));

import { PanoGL } from "../panoGL";

const canvasStub = (connected: boolean) =>
	({ isConnected: connected }) as unknown as HTMLCanvasElement;

describe("PanoGL.dispose", () => {
	afterEach(() => {
		made.length = 0;
		vi.useRealTimers();
	});

	it("loses and destroys the device once the canvas is detached", () => {
		vi.useFakeTimers();
		const canvas = canvasStub(false);
		new PanoGL(canvas, () => {}).dispose();
		expect(made[0].loseDevice).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(made[0].loseDevice).toHaveBeenCalledTimes(1);
		expect(made[0].destroy).toHaveBeenCalledTimes(1);
	});

	it("keeps the device while the canvas is still attached (effect re-run)", () => {
		vi.useFakeTimers();
		const canvas = canvasStub(true);
		new PanoGL(canvas, () => {}).dispose();
		new PanoGL(canvas, () => {});
		vi.runAllTimers();
		expect(made).toHaveLength(1);
		expect(made[0].loseDevice).not.toHaveBeenCalled();
	});
});
