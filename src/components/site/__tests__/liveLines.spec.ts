// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { createInputTracker } from "../LiveLines";
import { cachedWidth, midpointsOf } from "../lineArt";

describe("createInputTracker", () => {
	it("installs listeners on the first subscriber and removes them with the last", () => {
		const target = new EventTarget();
		let t = 100;
		const tracker = createInputTracker(target, () => t);
		expect(tracker.lastInput).toBe(-Infinity);
		// not listening yet
		target.dispatchEvent(new Event("wheel"));
		expect(tracker.lastInput).toBe(-Infinity);
		const a = tracker.subscribe();
		const b = tracker.subscribe();
		target.dispatchEvent(new Event("wheel"));
		expect(tracker.lastInput).toBe(100);
		a();
		t = 200;
		target.dispatchEvent(new Event("keydown"));
		expect(tracker.lastInput).toBe(200);
		b();
		t = 300;
		target.dispatchEvent(new Event("keydown"));
		expect(tracker.lastInput).toBe(200);
	});

	it("tracks a held pointer and ignores a repeated unsubscribe", () => {
		const target = new EventTarget();
		const tracker = createInputTracker(target, () => 5);
		const a = tracker.subscribe();
		const b = tracker.subscribe();
		target.dispatchEvent(new Event("pointerdown"));
		expect(tracker.held).toBe(true);
		target.dispatchEvent(new Event("pointercancel"));
		expect(tracker.held).toBe(false);
		a();
		a();
		// b still subscribed: a double unsubscribe of a must not drop the listeners
		target.dispatchEvent(new Event("pointerdown"));
		expect(tracker.held).toBe(true);
		b();
		expect(tracker.held).toBe(false);
	});
});

describe("lineArt draw helpers", () => {
	it("midpointsOf takes each stroke's middle point", () => {
		const pts = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 5, 5, 5, 9, 9, 9]);
		const out = midpointsOf({
			pts,
			start: new Uint32Array([0, 3, 5]),
			style: new Uint8Array(2),
		});
		expect(Array.from(out)).toEqual([1, 1, 1, 9, 9, 9]);
	});

	it("cachedWidth measures a name once", () => {
		const cache = new Map<string, number>();
		let calls = 0;
		const measure = (n: string) => {
			calls++;
			return n.length * 5;
		};
		expect(cachedWidth(cache, "Eiger", measure)).toBe(25);
		expect(cachedWidth(cache, "Eiger", measure)).toBe(25);
		expect(calls).toBe(1);
	});
});
