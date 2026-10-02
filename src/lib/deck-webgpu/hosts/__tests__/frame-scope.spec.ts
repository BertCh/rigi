// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { mergeScope, OffscreenDirty } from "../frame-scope";

describe("mergeScope", () => {
	it("keeps the widest scope", () => {
		expect(mergeScope("screen", "color")).toBe("color");
		expect(mergeScope("color", "all")).toBe("all");
		expect(mergeScope("all", "screen")).toBe("all");
		expect(mergeScope("all", "color")).toBe("all");
		expect(mergeScope("color", "screen")).toBe("color");
		expect(mergeScope("screen", "screen")).toBe("screen");
	});
});

describe("OffscreenDirty", () => {
	it("starts fully dirty and clears on take", () => {
		const d = new OffscreenDirty();
		expect(d.take()).toEqual({ geometry: true, color: true });
		expect(d.take()).toEqual({ geometry: false, color: false });
	});

	it("a colour request leaves geometry cached", () => {
		const d = new OffscreenDirty();
		d.take();
		d.request("color");
		expect(d.take()).toEqual({ geometry: false, color: true });
	});

	it("an all request dirties both; screen dirties nothing", () => {
		const d = new OffscreenDirty();
		d.take();
		d.request("screen");
		expect(d.take()).toEqual({ geometry: false, color: false });
		d.request("color");
		d.request("all");
		expect(d.take()).toEqual({ geometry: true, color: true });
	});

	it("a colour request after an all request keeps geometry dirty", () => {
		const d = new OffscreenDirty();
		d.take();
		d.request("all");
		d.request("color");
		expect(d.take()).toEqual({ geometry: true, color: true });
	});

	it("marks: colour resize, geometry recreate", () => {
		const d = new OffscreenDirty();
		d.take();
		d.markColor();
		expect(d.take()).toEqual({ geometry: false, color: true });
		d.markGeometry();
		expect(d.take()).toEqual({ geometry: true, color: true });
	});
});
