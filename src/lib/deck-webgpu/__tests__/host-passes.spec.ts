// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device, RenderPass } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import {
	prewarmReducedColor,
	runColorPass,
	runGeometryPass,
	runOffscreenPasses,
	runScreenPass,
	targetOf,
} from "../hosts/passes";
import type { GpuLayerCore, PassContext, PassKind } from "../pass";
import { MSAA_SAMPLES } from "../targets";

const photo = {
	eye: [0, 0, 0],
	forward: [0, 1, 0],
	up: [0, 0, 1],
	vfov: 40,
} as never;
const frame = { frame: 1, time: 0, view: "world" } as const;

function fakeDevice(log: string[]) {
	const renderPass = { end: () => log.push("end") };
	const device = {
		commandEncoder: { id: "enc" },
		beginRenderPass: vi.fn((p: { id: string }) => {
			log.push(`begin:${p.id}`);
			return renderPass;
		}),
		submit: vi.fn(() => log.push("submit")),
	};
	return { device: device as unknown as Device & typeof device, renderPass };
}

function core(
	id: string,
	passes: PassKind[],
	log: string[],
	extra: Partial<GpuLayerCore> = {},
): GpuLayerCore {
	return {
		id,
		passes,
		draw: (ctx: PassContext) =>
			log.push(`draw:${id}:${ctx.kind}:${ctx.frame.view}`),
		destroy: () => {},
		...extra,
	};
}

const geometry = { width: 1024, height: 683, fbo: { id: "g" } } as never;
const colorRaw = {
	width: 800,
	height: 600,
	samples: MSAA_SAMPLES,
	passFbo: { id: "c" },
	color: { id: "ct" },
	setReduced: vi.fn(),
};
const color = colorRaw as never;

describe("host passes", () => {
	it("geometry pass: photo camera at the target size, cores by order, hidden cores skipped, prepass before the pass opens", () => {
		const log: string[] = [];
		const { device } = fakeDevice(log);
		const cores = [
			core("late", ["geometry"], log, { order: 5 }),
			core("early", ["geometry"], log, {
				order: -1,
				prepass: (c) =>
					log.push(
						`prepass:${(c.commandEncoder as unknown as { id: string }).id}`,
					),
			}),
			core("hidden", ["geometry"], log, { visible: () => false }),
			core("colourOnly", ["color"], log),
			core("mid", ["geometry"], log),
		];
		runGeometryPass({ device, cores, geometry, photo, frame });
		expect(log).toEqual([
			"prepass:enc",
			"begin:rigi-geometry",
			"draw:early:geometry:photo", // geometry always looks through the photo camera
			"draw:mid:geometry:photo",
			"draw:late:geometry:photo",
			"end",
		]);
		const props = (
			device.beginRenderPass.mock.calls[0] as unknown as [
				Record<string, unknown>,
			]
		)[0];
		expect(props.framebuffer).toEqual({ id: "g" });
		expect(props.clearColor).toEqual([0, 0, 0, 0]);
	});

	it("the pass context carries the camera sized to the target", () => {
		const log: string[] = [];
		const { device } = fakeDevice(log);
		let seen: PassContext | null = null;
		const c = core("c", ["geometry"], log, {
			draw: (ctx) => {
				seen = ctx;
			},
		});
		runGeometryPass({ device, cores: [c], geometry, photo, frame });
		const ctx = seen as unknown as PassContext;
		expect(ctx.camera.viewport).toEqual([1024, 683]);
		expect(ctx.target.samples).toBe(1);
		expect(ctx.target.width).toBe(1024);
	});

	it("colour pass resolves MSAA into the colour target and gives the geometry to layers; 1x draws directly", () => {
		const log: string[] = [];
		const { device } = fakeDevice(log);
		let seen: PassContext | null = null;
		const c = core("c", ["color"], log, {
			draw: (ctx) => {
				seen = ctx;
			},
		});
		runColorPass({ device, cores: [c], geometry, color, view: photo, frame });
		const msaa = (
			device.beginRenderPass.mock.calls[0] as unknown as [
				Record<string, unknown>,
			]
		)[0];
		expect(msaa.resolveTargets).toEqual([{ id: "ct" }]);
		expect(msaa.discard).toBe(true);
		expect((seen as unknown as PassContext).geometry).toBe(geometry);
		expect((seen as unknown as PassContext).camera.viewport).toEqual([
			800, 600,
		]);
		const oneX = { ...colorRaw, samples: 1 } as never;
		runColorPass({
			device,
			cores: [c],
			geometry,
			color: oneX,
			view: photo,
			frame,
		});
		const direct = (
			device.beginRenderPass.mock.calls[1] as unknown as [
				Record<string, unknown>,
			]
		)[0];
		expect(direct.resolveTargets).toBeUndefined();
	});

	it("colour pass restores the MSAA sample setting even when a layer throws, and still propagates", () => {
		const log: string[] = [];
		const { device } = fakeDevice(log);
		const boom = core("boom", ["color"], log, {
			draw: () => {
				throw new Error("shader");
			},
		});
		expect(() =>
			runColorPass({
				device,
				cores: [boom],
				geometry,
				color: { ...colorRaw, samples: 1 } as never,
				view: photo,
				frame,
			}),
		).toThrow("shader");
		// a following normal pass sees the MSAA variant again (observable via passModelProps)
		return import("../pass").then(({ passModelProps }) => {
			expect(
				(passModelProps("color").parameters as { sampleCount: number })
					.sampleCount,
			).toBe(MSAA_SAMPLES);
		});
	});

	it("runOffscreenPasses records both passes and their timings", () => {
		const log: string[] = [];
		const { device } = fakeDevice(log);
		const timing = { geometryMs: -1, colorMs: -1, screenMs: 0 };
		runOffscreenPasses({
			device,
			cores: [core("a", ["geometry", "color"], log)],
			geometry,
			color,
			photo,
			view: photo,
			frame,
			timing,
		});
		expect(log.filter((l) => l.startsWith("begin"))).toEqual([
			"begin:rigi-geometry",
			"begin:rigi-color",
		]);
		expect(timing.geometryMs).toBeGreaterThanOrEqual(0);
		expect(timing.colorMs).toBeGreaterThanOrEqual(0);
	});

	it("targetOf reads the attachments of the pass's framebuffer", () => {
		const fb = {
			width: 640,
			height: 480,
			colorAttachments: [{ texture: { format: "bgra8unorm", samples: 4 } }],
			depthStencilAttachment: { texture: { format: "depth24plus" } },
		};
		expect(
			targetOf({ props: { framebuffer: fb } } as unknown as RenderPass),
		).toEqual({
			width: 640,
			height: 480,
			colorFormats: ["bgra8unorm"],
			depthFormat: "depth24plus",
			samples: 4,
		});
		const noDepth = {
			...fb,
			depthStencilAttachment: null,
			colorAttachments: [{ texture: { format: "rgba8unorm" } }],
		};
		const t = targetOf({
			props: {},
			framebuffer: noDepth,
		} as unknown as RenderPass);
		expect(t.depthFormat).toBeNull();
		expect(t.samples).toBe(1);
	});

	it("runScreenPass draws only visible screen cores in order, into the given pass", () => {
		const log: string[] = [];
		const { device, renderPass } = fakeDevice(log);
		const fb = {
			width: 10,
			height: 10,
			colorAttachments: [{ texture: { format: "bgra8unorm" } }],
			depthStencilAttachment: null,
		};
		(renderPass as unknown as { props: unknown }).props = { framebuffer: fb };
		runScreenPass({
			device,
			cores: [
				core("b", ["screen"], log, { order: 2 }),
				core("a", ["screen"], log, { order: 1 }),
				core("x", ["screen"], log, { visible: () => false }),
				core("g", ["geometry"], log),
			],
			renderPass: renderPass as unknown as RenderPass,
			camera: {} as never,
			frame,
			geometry,
			color,
		});
		expect(log).toEqual(["draw:a:screen:world", "draw:b:screen:world"]);
	});

	it("prewarmReducedColor draws each colour core once, yields between them and stops when stale", async () => {
		const log: string[] = [];
		const { device } = fakeDevice(log);
		const cores = [
			core("a", ["color"], log),
			core("geo", ["geometry"], log),
			core("b", ["color"], log),
		];
		let yields = 0;
		const ok = await prewarmReducedColor({
			device,
			cores,
			geometry,
			scratch: color,
			view: photo,
			frameView: "photo",
			yieldIdle: async () => {
				yields++;
			},
			stale: () => false,
		});
		expect(ok).toBe(true);
		expect(yields).toBe(2);
		expect(log.filter((l) => l.startsWith("draw"))).toEqual([
			"draw:a:color:photo",
			"draw:b:color:photo",
		]);
		expect(device.submit).toHaveBeenCalledTimes(2);
		expect(
			(color as unknown as { setReduced: ReturnType<typeof vi.fn> }).setReduced,
		).toHaveBeenCalledWith(true);
		// stale after the first core
		log.length = 0;
		let n = 0;
		const stopped = await prewarmReducedColor({
			device,
			cores,
			geometry,
			scratch: color,
			view: photo,
			frameView: "photo",
			yieldIdle: async () => {},
			stale: () => n++ > 0,
		});
		expect(stopped).toBe(false);
		expect(log.filter((l) => l.startsWith("draw")).length).toBe(1);
	});
});
