// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The layer contract (README.md): a layer is a host-agnostic `GpuLayerCore` that draws into one
// or more pass kinds. Hosts (hosts/direct.ts: plain luma; hosts/deck.ts: deck.gl on WebGPU) own
// the device, targets and render passes and call `draw(ctx)` once per pass the core takes part in.
import type {
	CommandEncoder,
	Device,
	RenderPass,
	RenderPipelineParameters,
} from "@luma.gl/core";
import type { Model, ModelProps } from "@luma.gl/engine";
import { WGSLShaderAssembler } from "@luma.gl/shadertools";
import type { CameraUniforms } from "./camera";
import { REVERSED_Z } from "./depth";
import type { ColorTargets, GeometryTargets } from "./targets";
import { MSAA_SAMPLES, PASS_ATTACHMENTS } from "./targets";

/**
 * Pass kinds, drawn in this order each frame:
 *   geometry  photo camera → GeometryTargets (MRT: xyz+range, normal+class), reversed-Z. The
 *             queries / align / drape / look kernels read it. Opaque only, no blending.
 *   color     the view's camera → ColorTargets (4× MSAA rgba16float, linear, premultiplied α),
 *             reversed-Z; resolved into ColorTargets.color after the pass.
 *   screen    the canvas: composite / present / screen-space overlays. No 3D depth.
 */
export type PassKind = "geometry" | "color" | "screen";
export const PASS_ORDER: readonly PassKind[] = ["geometry", "color", "screen"];

/** What the render target of the running pass looks like (pipelines must match it). */
export type PassTarget = {
	width: number;
	height: number;
	colorFormats: readonly string[];
	depthFormat: string | null;
	samples: number;
};

export type FrameState = {
	/** Monotonic frame counter (host). */
	frame: number;
	/** performance.now() at frame start. */
	time: number;
	/** Which camera the color pass uses: the photo camera or the world orbit camera. */
	view: "photo" | "world";
};

export type PassContext = {
	device: Device;
	kind: PassKind;
	renderPass: RenderPass;
	/** Camera for this pass and target (geometry: always the photo camera). */
	camera: CameraUniforms;
	target: PassTarget;
	frame: FrameState;
	/** Earlier passes' outputs this frame (color may read geometry; screen may read both). */
	geometry?: GeometryTargets;
	color?: ColorTargets;
};

/**
 * What a core's prepass sees: the pass it is about to take part in, and the command encoder that
 * pass will be recorded on (device.commandEncoder), with no render pass open yet.
 */
export type PrepassContext = Omit<
	PassContext,
	"renderPass" | "geometry" | "color"
> & { commandEncoder: CommandEncoder };

export interface GpuLayerCore {
	readonly id: string;
	/** Pass kinds this core draws in. */
	readonly passes: readonly PassKind[];
	/** Draw order within a pass (lower first; opaque < transparent). Default 0. */
	readonly order?: number;
	/** Pipeline parameters for the screen pass when hosted by deck (deck merges its defaults
	 * — premultiplied blending, less-equal depth — under these). */
	readonly screenParameters?: RenderPipelineParameters;
	/** Draw into ctx.renderPass. Never begin/end passes or submit here. */
	draw(ctx: PassContext): void;
	/**
	 * Optional, geometry / colour passes: record compute work the coming draw(ctx) consumes (e.g. a
	 * GPU cull writing indirect draw records) on ctx.commandEncoder. Hosts call it right before they
	 * begin that pass, on the same encoder, once per pass the core is drawn in. Never submit here.
	 */
	prepass?(ctx: PrepassContext): void;
	/** Visible this frame? (hosts skip draw when false). */
	visible?(): boolean;
	destroy(): void;
}

/**
 * The WGSL assembler every deck-webgpu Model uses (passModelProps / screenModelProps carry it).
 * luma's shared default assembler is process-global and deck.gl's shaderlib registers its default
 * modules on it (`geometry`, …), so under the deck host those leaked into our pipelines while the
 * direct host assembled without them. Our own assembler has no default modules or hooks: both
 * hosts now assemble byte-identical WGSL, and the *.check.ts files assemble with one exactly like
 * it. Module-level rather than per device: it holds no GPU objects, only the default module / hook
 * lists and a deterministic auto-binding registry, and the callers' props carry no device.
 */
export const RIGI_WGSL_ASSEMBLER = new WGSLShaderAssembler();

/**
 * Sample count of the colour pass being recorded (hosts/passes.ts runColorPass sets it for the
 * duration of the pass, then restores MSAA_SAMPLES). WebGPU pipelines bake their sample count, so
 * the Models a layer builds for "color" must match the target it is drawn into: while the colour
 * pass runs without MSAA (ColorTargets.setReduced, the interactive mode) passModelProps("color")
 * declares 1 and ModelCache keeps a second Model per key. Outside the colour pass it reads
 * MSAA_SAMPLES, so geometry / screen models and everything created elsewhere are unaffected.
 */
let colorSamples = MSAA_SAMPLES;

/**
 * Bumped when a MSAA-variant Model is created or any cache is invalidated: the layer set (or a
 * shader variant) changed, so the interactive 1× variants may be missing (engine prewarm).
 */
let modelEpochN = 0;
export const modelEpoch = () => modelEpochN;
export function setColorSamples(n: number) {
	colorSamples = n;
}

/**
 * Model props for drawing into `kind` (attachment formats, sample count, reversed-Z depth).
 * Spread into `new Model(device, {...passModelProps(kind), ...yours})`; `parameters` merge:
 * pass `{...passModelProps(kind).parameters, ...mine}` if you override any.
 */
export function passModelProps(
	kind: Exclude<PassKind, "screen">,
	opts: { depth?: "write" | "test" | "none"; blend?: boolean } = {},
): Pick<
	ModelProps,
	| "colorAttachmentFormats"
	| "depthStencilAttachmentFormat"
	| "parameters"
	| "shaderAssembler"
> {
	const a = PASS_ATTACHMENTS[kind];
	const depth =
		opts.depth === "test"
			? REVERSED_Z.testOnly
			: opts.depth === "none"
				? REVERSED_Z.none
				: REVERSED_Z.parameters;
	const blend =
		opts.blend && kind === "color"
			? {
					// PREMULTIPLIED alpha into the linear colour target (targets.ts): shaders output
					// (rgb·a, a); "over" = one, one-minus-src-alpha for both channels
					blend: true,
					blendColorOperation: "add",
					blendColorSrcFactor: "one",
					blendColorDstFactor: "one-minus-src-alpha",
					blendAlphaOperation: "add",
					blendAlphaSrcFactor: "one",
					blendAlphaDstFactor: "one-minus-src-alpha",
				}
			: {};
	return {
		shaderAssembler: RIGI_WGSL_ASSEMBLER,
		colorAttachmentFormats: [...a.colorAttachmentFormats] as never,
		depthStencilAttachmentFormat: a.depthStencilAttachmentFormat,
		parameters: {
			cullMode: "none",
			sampleCount: kind === "color" ? colorSamples : a.sampleCount,
			...depth,
			...blend,
		} as RenderPipelineParameters,
	};
}

/** Screen-pass model props derived from the running pass's target. */
export function screenModelProps(
	t: PassTarget,
): Pick<
	ModelProps,
	| "colorAttachmentFormats"
	| "depthStencilAttachmentFormat"
	| "parameters"
	| "shaderAssembler"
> {
	return {
		shaderAssembler: RIGI_WGSL_ASSEMBLER,
		colorAttachmentFormats: [...t.colorFormats] as never,
		depthStencilAttachmentFormat: (t.depthFormat ?? undefined) as never,
		// luma adds a depth-stencil state (preferred format) as soon as ANY depth parameter is set:
		// pipelines for depth-less targets must carry none
		parameters: {
			sampleCount: t.samples,
			...(t.depthFormat
				? { depthWriteEnabled: false, depthCompare: "always" }
				: {}),
		} as RenderPipelineParameters,
	};
}

/**
 * One Model per (pass kind, target signature). WebGPU writes uniforms with queue.writeBuffer, so a
 * Model drawn twice in one submit with different uniforms shows the LAST values in both draws;
 * separate models per pass keep the photo camera (geometry) and view camera (color) apart.
 */
export class ModelCache {
	private models = new Map<string, Model>();

	/** `key` plus the colour-pass sample variant: the MSAA and the interactive 1× Model of one
	 * key coexist (pipelines are created once per variant, never per switch). Geometry and screen
	 * draws always see the MSAA variant, so they keep a single Model. */
	get(key: string, make: () => Model): Model {
		const k = colorSamples === MSAA_SAMPLES ? key : `${key}|x${colorSamples}`;
		let m = this.models.get(k);
		if (!m) {
			m = make();
			this.models.set(k, m);
			if (colorSamples === MSAA_SAMPLES) modelEpochN++;
		}
		return m;
	}

	/** Drop models whose key starts with `prefix` (e.g. after a shader define change). */
	invalidate(prefix = "") {
		modelEpochN++;
		for (const [k, m] of this.models)
			if (k.startsWith(prefix)) {
				m.destroy();
				this.models.delete(k);
			}
	}

	/** Debug (lab `_debug.bindings` / `_debug.wgsl`): the cached models whose key starts with
	 * `prefix`. */
	entries(prefix = ""): [string, Model][] {
		return [...this.models].filter(([k]) => k.startsWith(prefix));
	}

	destroy() {
		this.invalidate();
	}
}

/** Key describing a pass target, for ModelCache keys. */
export const targetKey = (ctx: PassContext) =>
	`${ctx.kind}|${ctx.target.colorFormats.join(",")}|${ctx.target.depthFormat}|${ctx.target.samples}`;
