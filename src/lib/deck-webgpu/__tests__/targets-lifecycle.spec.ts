// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyColorTargetFormat,
	ColorTargets,
	GeometryTargets,
	MSAA_SAMPLES,
	PASS_ATTACHMENTS,
	TARGET_FORMATS,
	USAGE,
} from "../targets";

type Res = {
	kind: "texture" | "framebuffer";
	id: string;
	width: number;
	height: number;
	format?: string;
	samples?: number;
	usage?: number;
	attachments?: unknown[];
	depth?: unknown;
	destroyed: boolean;
	destroy(): void;
};

function fakeDevice() {
	const made: Res[] = [];
	const mk = (kind: Res["kind"], p: Record<string, unknown>) => {
		const r: Res = {
			kind,
			id: p.id as string,
			width: p.width as number,
			height: p.height as number,
			format: p.format as string | undefined,
			samples: p.samples as number | undefined,
			usage: p.usage as number | undefined,
			attachments: p.colorAttachments as unknown[] | undefined,
			depth: p.depthStencilAttachment,
			destroyed: false,
			destroy() {
				r.destroyed = true;
			},
		};
		made.push(r);
		return r;
	};
	const device = {
		createTexture: (p: Record<string, unknown>) => mk("texture", p),
		createFramebuffer: (p: Record<string, unknown>) => mk("framebuffer", p),
	} as unknown as Device;
	return {
		device,
		made,
		byId: (id: string) => made.filter((r) => r.id === id),
	};
}

afterEach(() => {
	// the colour format is module state: put it back
	applyColorTargetFormat({ features: new Set() } as never, "rgba16");
});

describe("GeometryTargets", () => {
	it("creates xyzr / normal / depth textures and an MRT framebuffer of the same size", () => {
		const { device, byId } = fakeDevice();
		const g = new GeometryTargets(device, 640, 480);
		expect([g.width, g.height]).toEqual([640, 480]);
		const [geo] = byId("geometry-xyzr");
		const [nor] = byId("geometry-normal");
		const [dep] = byId("geometry-depth");
		expect(geo.format).toBe("rgba32float");
		expect(nor.format).toBe("rgba16float");
		expect(dep.format).toBe(TARGET_FORMATS.geometryDepth.format);
		// compute reads the geometry target: it must be storage + sampled + copy-src
		for (const u of [USAGE.STORAGE, USAGE.SAMPLE, USAGE.COPY_SRC, USAGE.RENDER])
			expect((geo.usage ?? 0) & u).toBe(u);
		const [fbo] = byId("geometry-fbo");
		expect(fbo.attachments).toEqual([geo, nor]);
		expect(fbo.depth).toBe(dep);
	});

	it("resize is a no-op at the same size and rebuilds (destroying the old) otherwise", () => {
		const { device, made } = fakeDevice();
		const g = new GeometryTargets(device, 64, 32, "g2");
		const before = made.length;
		expect(g.resize(64, 32)).toBe(false);
		expect(made).toHaveLength(before);
		const old = [...made];
		expect(g.resize(128, 64)).toBe(true);
		expect(old.every((r) => r.destroyed)).toBe(true);
		expect(made.length).toBe(before * 2);
		expect([g.width, g.height]).toEqual([128, 64]);
		g.destroy();
		expect(made.every((r) => r.destroyed)).toBe(true);
	});
});

describe("ColorTargets", () => {
	it("is 4x MSAA with a single-sample resolve, MSAA textures render-only", () => {
		const { device, byId } = fakeDevice();
		const c = new ColorTargets(device, 100, 50);
		const [ms] = byId("color-ms");
		const [dms] = byId("color-depth-ms");
		const [res] = byId("color-resolve");
		expect(ms.samples).toBe(MSAA_SAMPLES);
		expect(dms.samples).toBe(MSAA_SAMPLES);
		expect(res.samples).toBe(1);
		expect(ms.usage).toBe(USAGE.RENDER);
		expect(c.fbo.id).toBe("color-fbo");
		expect(c.samples).toBe(MSAA_SAMPLES);
		expect(c.passFbo).toBe(c.fbo);
	});

	it("reduced mode draws 1x straight into the resolve, allocating its framebuffer once", () => {
		const { device, made, byId } = fakeDevice();
		const c = new ColorTargets(device, 100, 50);
		const base = made.length;
		expect(c.setReduced(false)).toBe(false);
		expect(c.setReduced(true)).toBe(true);
		expect(c.setReduced(true)).toBe(false);
		expect(c.samples).toBe(1);
		const fbo1 = c.passFbo;
		expect(c.passFbo).toBe(fbo1);
		expect(made.length).toBe(base + 2); // depth-1x + fbo-1x, once
		const [d1] = byId("color-depth-1x");
		expect(d1.samples).toBe(1);
		const [f1] = byId("color-fbo-1x");
		expect(f1.attachments).toEqual([c.color]);
		expect(f1.depth).toBe(d1);
		// leaving reduced mode returns to the MSAA framebuffer, keeps the 1x one for later
		expect(c.setReduced(false)).toBe(true);
		expect(c.passFbo).toBe(c.fbo);
		expect(f1.destroyed).toBe(false);
	});

	it("resize rebuilds everything including the reduced framebuffer, which is recreated lazily", () => {
		const { device, made, byId } = fakeDevice();
		const c = new ColorTargets(device, 100, 50);
		c.setReduced(true);
		void c.passFbo;
		expect(c.resize(100, 50)).toBe(false);
		expect(c.resize(200, 100)).toBe(true);
		for (const id of [
			"color-ms",
			"color-resolve",
			"color-fbo-1x",
			"color-depth-1x",
		])
			expect(byId(id)[0].destroyed).toBe(true);
		expect(byId("color-fbo-1x")).toHaveLength(1);
		const fresh = c.passFbo as unknown as Res;
		expect([fresh.width, fresh.height]).toEqual([200, 100]);
		expect(made.filter((r) => r.id === "color-fbo-1x")).toHaveLength(2);
		c.destroy();
		expect(made.every((r) => r.destroyed)).toBe(true);
	});

	it("rg11b10 colour target: resolve loses STORAGE, MSAA stays render-only", () => {
		applyColorTargetFormat(
			{ features: new Set(["rg11b10ufloat-renderable"]) } as never,
			"rg11b10",
		);
		const { device, byId } = fakeDevice();
		new ColorTargets(device, 8, 8);
		expect(byId("color-ms")[0].format).toBe("rg11b10ufloat");
		expect(byId("color-resolve")[0].format).toBe("rg11b10ufloat");
		expect((byId("color-resolve")[0].usage ?? 0) & USAGE.STORAGE).toBe(0);
		expect(PASS_ATTACHMENTS.color.colorAttachmentFormats).toEqual([
			"rg11b10ufloat",
		]);
	});
});

describe("PASS_ATTACHMENTS", () => {
	it("match the target formats pipelines must declare", () => {
		expect(PASS_ATTACHMENTS.geometry.colorAttachmentFormats).toEqual([
			"rgba32float",
			"rgba16float",
		]);
		expect(PASS_ATTACHMENTS.geometry.sampleCount).toBe(1);
		expect(PASS_ATTACHMENTS.color.sampleCount).toBe(MSAA_SAMPLES);
		expect(PASS_ATTACHMENTS.color.colorAttachmentFormats).toEqual([
			"rgba16float",
		]);
		expect(PASS_ATTACHMENTS.geometry.depthStencilAttachmentFormat).toBe(
			PASS_ATTACHMENTS.color.depthStencilAttachmentFormat,
		);
	});
});
