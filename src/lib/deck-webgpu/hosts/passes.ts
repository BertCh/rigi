// The offscreen half of a frame, shared by both hosts: the geometry pass (photo camera) and the
// MSAA colour pass (view camera) with its resolve (1×, no resolve, while interactive). Hosts differ only in who owns the device /
// canvas and how the screen pass is driven.
import type { Device, Framebuffer, RenderPass } from "@luma.gl/core";
import {
	type CameraState,
	type CameraUniforms,
	cameraUniforms,
} from "../camera";
import { REVERSED_Z } from "../depth";
import {
	type FrameState,
	type GpuLayerCore,
	type PassContext,
	type PassKind,
	type PassTarget,
	setColorSamples,
} from "../pass";
import {
	type ColorTargets,
	type GeometryTargets,
	MSAA_SAMPLES,
	PASS_ATTACHMENTS,
} from "../targets";

/** A camera without a target size (hosts size it per target). */
export type CameraPose = Omit<CameraState, "width" | "height">;

export type PassTiming = {
	geometryMs: number;
	colorMs: number;
	screenMs: number;
};

export function camerasFor(
	pose: CameraPose,
	width: number,
	height: number,
): CameraUniforms {
	return cameraUniforms({ ...pose, width, height });
}

function sorted(cores: readonly GpuLayerCore[], kind: PassKind) {
	return cores
		.filter((c) => c.passes.includes(kind) && (c.visible?.() ?? true))
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * The geometry pass alone: `cores`' geometry draws through the photo camera into `geometry`.
 * Also what off-frame renders use (queries / align, layers/geometry-source.ts): pass your own
 * GeometryTargets, then device.submit() and read back.
 */
export function runGeometryPass(o: {
	device: Device;
	cores: readonly GpuLayerCore[];
	geometry: GeometryTargets;
	photo: CameraPose;
	frame: FrameState;
}) {
	const { device, geometry } = o;
	// the geometry pass always looks through the photo camera
	const frame: FrameState =
		o.frame.view === "photo" ? o.frame : { ...o.frame, view: "photo" };
	const cam = camerasFor(o.photo, geometry.width, geometry.height);
	const renderPass = device.beginRenderPass({
		id: "rigi-geometry",
		framebuffer: geometry.fbo,
		clearColor: [0, 0, 0, 0],
		clearDepth: REVERSED_Z.clearDepth,
	});
	const target: PassTarget = {
		width: geometry.width,
		height: geometry.height,
		colorFormats: PASS_ATTACHMENTS.geometry.colorAttachmentFormats,
		depthFormat: PASS_ATTACHMENTS.geometry.depthStencilAttachmentFormat,
		samples: 1,
	};
	for (const c of sorted(o.cores, "geometry"))
		c.draw({
			device,
			kind: "geometry",
			renderPass,
			camera: cam,
			target,
			frame,
		} satisfies PassContext);
	renderPass.end();
}

/** The MSAA colour pass through the view camera, resolved into color.color at the pass end. */
export function runColorPass(o: {
	device: Device;
	cores: readonly GpuLayerCore[];
	geometry: GeometryTargets;
	color: ColorTargets;
	view: CameraPose;
	frame: FrameState;
}) {
	const { device, geometry, color, frame } = o;
	const cam = camerasFor(o.view, color.width, color.height);
	const samples = color.samples;
	const renderPass = device.beginRenderPass({
		id: "rigi-color",
		framebuffer: color.passFbo,
		clearColor: [0, 0, 0, 0],
		clearDepth: REVERSED_Z.clearDepth,
		// MSAA: resolve at the end of the pass; the multisampled contents are not needed afterwards.
		// Interactive (1×): the pass draws into color.color itself
		...(samples > 1 ? { resolveTargets: [color.color], discard: true } : {}),
	} as never);
	const target: PassTarget = {
		width: color.width,
		height: color.height,
		colorFormats: PASS_ATTACHMENTS.color.colorAttachmentFormats,
		depthFormat: PASS_ATTACHMENTS.color.depthStencilAttachmentFormat,
		samples,
	};
	// layers build their colour Models while drawing: they must see this pass's sample count
	setColorSamples(samples);
	try {
		for (const c of sorted(o.cores, "color"))
			c.draw({
				device,
				kind: "color",
				renderPass,
				camera: cam,
				target,
				frame,
				geometry,
			} satisfies PassContext);
	} finally {
		setColorSamples(MSAA_SAMPLES);
	}
	renderPass.end();
}

export function runOffscreenPasses(o: {
	device: Device;
	cores: readonly GpuLayerCore[];
	geometry: GeometryTargets;
	color: ColorTargets;
	photo: CameraPose;
	view: CameraPose;
	frame: FrameState;
	timing: PassTiming;
}) {
	let t = performance.now();
	runGeometryPass(o);
	o.timing.geometryMs = performance.now() - t;
	t = performance.now();
	runColorPass(o);
	o.timing.colorMs = performance.now() - t;
}

/** Target description of a render pass (screen passes: the canvas framebuffer deck / we opened). */
export function targetOf(renderPass: RenderPass): PassTarget {
	const fb = ((renderPass.props as { framebuffer?: Framebuffer }).framebuffer ??
		(renderPass as unknown as { framebuffer?: Framebuffer })
			.framebuffer) as Framebuffer;
	const color = fb.colorAttachments.map((a) => a.texture.format);
	return {
		width: fb.width,
		height: fb.height,
		colorFormats: color,
		depthFormat: fb.depthStencilAttachment?.texture.format ?? null,
		samples: fb.colorAttachments[0]?.texture.samples ?? 1,
	};
}

export function runScreenPass(o: {
	device: Device;
	cores: readonly GpuLayerCore[];
	renderPass: RenderPass;
	camera: CameraUniforms;
	frame: FrameState;
	geometry: GeometryTargets;
	color: ColorTargets;
}) {
	const target = targetOf(o.renderPass);
	for (const c of sorted(o.cores, "screen"))
		c.draw({
			device: o.device,
			kind: "screen",
			renderPass: o.renderPass,
			camera: o.camera,
			target,
			frame: o.frame,
			geometry: o.geometry,
			color: o.color,
		});
}
