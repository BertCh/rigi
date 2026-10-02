// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { type AnyCanvas, composeAnnotatedPng } from "../annotate";

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
	const createCanvas = (w: number, h: number): AnyCanvas => ({
		width: w,
		height: h,
		getContext: () => ctx,
		convertToBlob: async (o) => new Blob(["x"], { type: o?.type }),
	});
	return { calls, createCanvas };
}

const photo = { width: 1000, height: 600 } as unknown as CanvasImageSource & {
	width: number;
	height: number;
};

describe("composeAnnotatedPng watermark", () => {
	it("draws the mark inside the photo area, above the footer", async () => {
		const r = recorder();
		await composeAnnotatedPng(photo, [], {
			watermark: "Rigi · shared view",
			createCanvas: r.createCanvas,
		});
		const mark = r.calls.find(
			(c) => c[0] === "fillText" && c[1] === "Rigi · shared view",
		);
		expect(mark).toBeDefined();
		const [, , x, y] = mark as [string, string, number, number];
		expect(x).toBeGreaterThan(0);
		expect(y).toBeLessThan(600);
		// drawn after the photo, before the footer fill
		const iMark = r.calls.indexOf(mark as Call);
		const iFooter = r.calls.findIndex((c) => c[0] === "fillRect");
		const iPhoto = r.calls.findIndex((c) => c[0] === "drawImage");
		expect(iPhoto).toBeLessThan(iMark);
		expect(iMark).toBeLessThan(iFooter);
	});

	it("draws nothing extra without the option", async () => {
		const r = recorder();
		await composeAnnotatedPng(photo, [], { createCanvas: r.createCanvas });
		const texts = r.calls.filter((c) => c[0] === "fillText");
		expect(texts).toHaveLength(1); // the attribution only
	});
});
