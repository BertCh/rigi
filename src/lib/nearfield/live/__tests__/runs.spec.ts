// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { DepthRunLedger, shouldRecalibrate, yawDifference } from "../runs";
import type { LiveCameraState } from "../types";

const cameraAt = (yawStep: number): LiveCameraState => ({
	camToEnu: [yawStep, 0, 0, 0, 1, 0, 0, 0, 1],
	eye: [yawStep, 0, 2],
	K: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
});

describe("DepthRunLedger", () => {
	it("hands back the camera and video time of the frame the run began on, not the latest", () => {
		const ledger = new DepthRunLedger<string>();
		const live = cameraAt(1);
		const stamp = ledger.begin(live, 12.5, 1000);
		// the camera moves on while the net runs (the live camera object is replaced and even mutated)
		(live.camToEnu as number[])[0] = 99;
		(live.eye as unknown as number[])[0] = 99;
		expect(ledger.finish(stamp, "outputs")).toBe(true);
		const run = ledger.take();
		expect(run?.camera.camToEnu[0]).toBe(1);
		expect(run?.camera.eye[0]).toBe(1);
		expect(run?.videoTime).toBe(12.5);
		expect(run?.outputs).toBe("outputs");
	});

	it("consumes a finished run once", () => {
		const ledger = new DepthRunLedger<number>();
		ledger.finish(ledger.begin(cameraAt(0), 0), 7);
		expect(ledger.peek()?.outputs).toBe(7);
		expect(ledger.take()?.outputs).toBe(7);
		expect(ledger.take()).toBeNull();
	});

	it("drops a run that finishes after a newer one", () => {
		const ledger = new DepthRunLedger<string>();
		const older = ledger.begin(cameraAt(1), 1);
		const newer = ledger.begin(cameraAt(2), 2);
		expect(ledger.finish(newer, "new")).toBe(true);
		expect(ledger.finish(older, "old")).toBe(false);
		const run = ledger.take();
		expect(run?.outputs).toBe("new");
		expect(run?.camera.eye[0]).toBe(2);
	});

	it("keeps ids increasing and lets discard drop the ready run", () => {
		const ledger = new DepthRunLedger<string>();
		const a = ledger.begin(cameraAt(0), 0);
		const b = ledger.begin(cameraAt(0), 0);
		expect(b.id).toBeGreaterThan(a.id);
		ledger.finish(a, "a");
		ledger.discard();
		expect(ledger.take()).toBeNull();
	});
});

describe("shouldRecalibrate", () => {
	const base = { eye: [0, 0, 0] as const, yaw: 350 };
	it("holds for small moves and turns", () => {
		expect(shouldRecalibrate(base, { eye: [5, 5, 1], yaw: 10 })).toBeNull();
	});
	it("fires when the eye moved", () => {
		expect(shouldRecalibrate(base, { eye: [30, 0, 0], yaw: 350 })).toBe(
			"moved",
		);
	});
	it("fires on a yaw change over 30 degrees across the wrap, not under", () => {
		expect(shouldRecalibrate(base, { eye: [0, 0, 0], yaw: 15 })).toBeNull();
		expect(shouldRecalibrate(base, { eye: [0, 0, 0], yaw: 21 })).toBe("turned");
	});
	it("wraps yaw differences", () => {
		expect(yawDifference(350, 10)).toBe(20);
		expect(yawDifference(10, 350)).toBe(20);
		expect(yawDifference(0, 180)).toBe(180);
	});
});
