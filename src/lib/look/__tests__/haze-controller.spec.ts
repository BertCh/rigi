// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { unprojectDir } from "#/lib/camera";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import { HazeController, rangeGeo, wantsHazeFit } from "../haze-controller";
import type { HazeGeo, SkyMask } from "../haze-fit";

const fitted = mergeStyle(CLASSIC, {
	terrain: {
		atmosphere: { mode: "physical", strength: 1, airlight: "fitted" },
	},
} as never);
const physical = mergeStyle(CLASSIC, {
	terrain: {
		atmosphere: { mode: "physical", strength: 1, airlight: "physical" },
	},
} as never);
const pose = { yaw: 10, pitch: 2, roll: 0, vfov: 40 };
const img = { naturalWidth: 64, naturalHeight: 48 } as HTMLImageElement;
const sun: [number, number, number] = [0, 0.6, 0.8];

describe("wantsHazeFit", () => {
	it("is true only for physical atmosphere with a fitted airlight", () => {
		expect(wantsHazeFit(fitted)).toBe(true);
		expect(wantsHazeFit(physical)).toBe(false);
		expect(wantsHazeFit(CLASSIC)).toBe(false);
	});
});

describe("rangeGeo", () => {
	const w = 3;
	const h = 2;
	// deck buffer, row 0 = top; Infinity = sky
	const range = Float32Array.from([
		Number.POSITIVE_INFINITY,
		100,
		200, // top row
		300,
		Number.POSITIVE_INFINITY,
		500, // bottom row
	]);
	const geo = rangeGeo(range, w, h, pose);
	it("flips rows to bottom-first and maps non-finite (sky) to 0", () => {
		expect(geo.kind).toBe("range");
		expect(Array.from(geo.data)).toEqual([300, 0, 500, 0, 100, 200]);
	});
	it("ray() unprojects the buffer pixel centre through the pose", () => {
		if (geo.kind !== "range") throw new Error("kind");
		const r = geo.ray(1, 0);
		const want = unprojectDir(pose, w / h, 1.5 / w, 1 - 0.5 / h);
		for (let i = 0; i < 3; i++) expect(r[i]).toBeCloseTo(want[i], 12);
	});
});

// stub of the canvas the controller reads the photo through
function stubCanvas() {
	const drawImage = vi.fn();
	vi.stubGlobal("document", {
		createElement: () => ({
			width: 0,
			height: 0,
			getContext: () => ({
				drawImage,
				getImageData: (_x: number, _y: number, w: number, h: number) => ({
					width: w,
					height: h,
					data: new Uint8ClampedArray(w * h * 4).fill(180),
				}),
			}),
		}),
	});
	return drawImage;
}

const makeGeo = (w: number, h: number) => () => {
	const range = new Float32Array(w * h);
	for (let i = 0; i < range.length; i++)
		range[i] = i < w * 4 ? Number.POSITIVE_INFINITY : 500 + (i % 50) * 1000;
	return { geo: rangeGeo(range, w, h, pose) as HazeGeo, w, h };
};

describe("HazeController", () => {
	it("does nothing without a fitted style or without an image", () => {
		const c = new HazeController();
		const o = {
			pose,
			eyeAlt: 1000,
			sunDir: sun,
			fg: null,
			geo: makeGeo(32, 24),
		};
		expect(c.isDue({ ...o, style: physical, img })).toBe(false);
		expect(c.update({ ...o, style: physical, img })).toBe(false);
		expect(c.isDue({ ...o, style: fitted, img: undefined })).toBe(false);
		expect(c.update({ ...o, style: fitted, img: undefined })).toBe(false);
		expect(c.fit).toBeNull();
	});
	it("`want` forces a fit for a non-fitted style", () => {
		const c = new HazeController();
		expect(
			c.isDue({ style: CLASSIC, pose, img, eyeAlt: 1, fg: null, want: true }),
		).toBe(true);
	});
	it("fits once per (pose, eye, fg), refits on a change, and decimates the geometry by 2", () => {
		const draw = stubCanvas();
		const c = new HazeController();
		const geoFn = vi.fn(makeGeo(32, 24));
		const o = {
			style: fitted,
			pose,
			img,
			eyeAlt: 1000,
			sunDir: sun,
			fg: null,
			geo: geoFn,
		};
		expect(c.isDue(o)).toBe(true);
		expect(c.update(o)).toBe(true);
		expect(c.fit).not.toBeNull();
		expect(geoFn).toHaveBeenCalledTimes(1);
		expect(draw).toHaveBeenCalledWith(img, 0, 0, 32, 24); // photo at 2 x (32/2, 24/2)
		// same key: no refit, geometry not even requested
		expect(c.isDue(o)).toBe(false);
		expect(c.update(o)).toBe(false);
		expect(geoFn).toHaveBeenCalledTimes(1);
		// a pose change refits; the photo read is cached
		const moved = { ...o, pose: { ...pose, yaw: 11 } };
		expect(c.isDue(moved)).toBe(true);
		expect(c.update(moved)).toBe(true);
		expect(geoFn).toHaveBeenCalledTimes(2);
		expect(draw).toHaveBeenCalledTimes(1);
		// eye altitude change and a new foreground mask both refit
		expect(c.update({ ...moved, eyeAlt: 1200 })).toBe(true);
		const fg: SkyMask = { width: 1, height: 1, data: new Uint8Array(1) };
		expect(c.update({ ...moved, eyeAlt: 1200, fg })).toBe(true);
		expect(c.update({ ...moved, eyeAlt: 1200, fg })).toBe(false);
	});
	it("setSky invalidates the cache so the next update refits", () => {
		stubCanvas();
		const c = new HazeController();
		const o = {
			style: fitted,
			pose,
			img,
			eyeAlt: 1000,
			sunDir: sun,
			fg: null,
			geo: makeGeo(32, 24),
		};
		c.update(o);
		expect(c.update(o)).toBe(false);
		const mask: SkyMask = { width: 4, height: 4, data: new Uint8Array(16) };
		c.setSky(mask);
		expect(c.sky).toBe(mask);
		expect(c.update(o)).toBe(true);
	});
	it("swallows a fit failure into fit = null but still reports an update", () => {
		vi.stubGlobal("document", {
			createElement: () => ({
				getContext: () => ({
					drawImage: () => {},
					getImageData: () => {
						throw new Error("tainted canvas");
					},
				}),
			}),
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const c = new HazeController();
		const out = c.update({
			style: fitted,
			pose,
			img,
			eyeAlt: 0,
			sunDir: sun,
			fg: null,
			geo: makeGeo(8, 8),
		});
		expect(out).toBe(true);
		expect(c.fit).toBeNull();
	});
});
