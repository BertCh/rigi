// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import {
	type AnyCanvas,
	composeAnnotatedPng,
	DEFAULT_ATTRIBUTION,
} from "../annotate";

type Call = [string, ...unknown[]];

function recorder() {
	const calls: Call[] = [];
	const ctx = new Proxy(
		{ measureText: (t: string) => ({ width: t.length * 5 }) } as Record<
			string,
			unknown
		>,
		{
			get: (t, k: string) =>
				k in t ? t[k] : (...a: unknown[]) => calls.push([k, ...a]),
			set: (t, k: string, v) => {
				calls.push([`set:${k}`, v]);
				t[k] = v;
				return true;
			},
		},
	);
	let made: { w: number; h: number } | null = null;
	const createCanvas = (cw: number, ch: number): AnyCanvas => {
		made = { w: cw, h: ch };
		return {
			width: cw,
			height: ch,
			getContext: () => ctx,
			convertToBlob: async (o) => new Blob(["x"], { type: o?.type }),
		};
	};
	return { calls, createCanvas, size: () => made };
}
const drawable = (w: number, h: number) =>
	({ width: w, height: h }) as unknown as CanvasImageSource & {
		width: number;
		height: number;
	};

describe("composeAnnotatedPng", () => {
	it("adds a footer below the photo and draws photo then overlays stretched to the photo rect", async () => {
		const r = recorder();
		await composeAnnotatedPng(drawable(1000, 500), [drawable(10, 10)], {
			createCanvas: r.createCanvas,
		});
		// footer = max(22, 500 * 0.026) = 22
		expect(r.size()).toEqual({ w: 1000, h: 522 });
		const draws = r.calls.filter((c) => c[0] === "drawImage");
		expect(draws).toHaveLength(2);
		expect(draws[1].slice(2)).toEqual([0, 0, 1000, 500]);
	});
	it("scales the footer with the image height", async () => {
		const r = recorder();
		await composeAnnotatedPng(drawable(4000, 3000), [], {
			createCanvas: r.createCanvas,
		});
		expect(r.size()?.h).toBe(3000 + Math.round(3000 * 0.026));
	});
	it("uses the default attribution, right-aligned with a maxWidth", async () => {
		const r = recorder();
		await composeAnnotatedPng(drawable(1000, 500), [], {
			createCanvas: r.createCanvas,
		});
		const t = r.calls.find((c) => c[0] === "fillText");
		expect(t?.[1]).toBe(DEFAULT_ATTRIBUTION);
		expect(t?.[4]).toBeGreaterThan(0);
		expect(r.calls).toContainEqual(["set:textAlign", "right"]);
	});
	it("omits the footer entirely with attribution false and no title", async () => {
		const r = recorder();
		await composeAnnotatedPng(drawable(300, 200), [], {
			createCanvas: r.createCanvas,
			attribution: false,
		});
		expect(r.size()).toEqual({ w: 300, h: 200 });
		expect(r.calls.some((c) => c[0] === "fillText")).toBe(false);
	});
	it("draws a title on the left and shrinks the credit's maxWidth", async () => {
		const withTitle = recorder();
		await composeAnnotatedPng(drawable(1000, 500), [], {
			createCanvas: withTitle.createCanvas,
			title: "Niederhorn",
		});
		const texts = withTitle.calls.filter((c) => c[0] === "fillText");
		expect(texts[0][1]).toBe("Niederhorn");
		const plain = recorder();
		await composeAnnotatedPng(drawable(1000, 500), [], {
			createCanvas: plain.createCanvas,
		});
		const wTitle = texts[1][4] as number;
		const wPlain = plain.calls.find((c) => c[0] === "fillText")?.[4] as number;
		expect(wTitle).toBeLessThan(wPlain);
	});
	it("honours explicit size, footerHeight, type and quality", async () => {
		const convert = vi.fn(async () => new Blob(["x"], { type: "image/jpeg" }));
		const canvas: AnyCanvas = {
			width: 0,
			height: 0,
			getContext: () => new Proxy({}, { get: () => () => {} }),
			convertToBlob: convert,
		};
		const make = vi.fn(() => canvas);
		const blob = await composeAnnotatedPng(drawable(10, 10), [], {
			width: 640.4,
			height: 480.6,
			footerHeight: 30,
			type: "image/jpeg",
			quality: 0.7,
			createCanvas: make,
		});
		expect(make).toHaveBeenCalledWith(640, 511);
		expect(convert).toHaveBeenCalledWith({ type: "image/jpeg", quality: 0.7 });
		expect(blob.type).toBe("image/jpeg");
	});
	it("falls back to toBlob and rejects when it yields null", async () => {
		const mk = (b: Blob | null): AnyCanvas => ({
			width: 1,
			height: 1,
			getContext: () => new Proxy({}, { get: () => () => {} }),
			toBlob: (cb) => cb(b),
		});
		const ok = await composeAnnotatedPng(drawable(5, 5), [], {
			attribution: false,
			createCanvas: () => mk(new Blob(["z"])),
		});
		expect(ok.size).toBe(1);
		await expect(
			composeAnnotatedPng(drawable(5, 5), [], {
				attribution: false,
				createCanvas: () => mk(null),
			}),
		).rejects.toThrow(/null/);
	});
	it("throws when the canvas has no 2d context or no encoder", async () => {
		await expect(
			composeAnnotatedPng(drawable(5, 5), [], {
				createCanvas: () => ({ width: 1, height: 1, getContext: () => null }),
			}),
		).rejects.toThrow(/2d context/);
		await expect(
			composeAnnotatedPng(drawable(5, 5), [], {
				attribution: false,
				createCanvas: () => ({
					width: 1,
					height: 1,
					getContext: () => new Proxy({}, { get: () => () => {} }),
				}),
			}),
		).rejects.toThrow(/cannot encode/);
	});
	it("throws a clear error when there is no canvas in node", async () => {
		await expect(composeAnnotatedPng(drawable(5, 5), [])).rejects.toThrow(
			/no canvas available/,
		);
	});
});
