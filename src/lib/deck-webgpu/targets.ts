// Render targets of the WebGPU renderer, with formats and usages fixed here so the compute side
// (src/lib/gpu look kernels, mt-image-03) can bind them directly on the same device.
//
//   geometry pass  (single-sample, `geometrySize`, default long side 1024 = deck/geometry-pass.ts)
//     geometry  rgba32float   xyz = ENU metres of the visible surface, w = range from the eye (m);
//                             cleared to 0 (w == 0 → sky / no surface, the existing `seen > 0` rule)
//     normal    rgba16float   xyz = unit ENU surface normal, w = material class (0 terrain, 1 trail,
//                             2 object/splat, 3 tiles3d; /255 not applied, plain float)
//     depth     depth32float  reversed-Z (depth.ts), sampleable as texture_depth_2d
//   colour pass    (4× MSAA, canvas device pixels ≤ 2 DPR)
//     colorMS   rgba16float ×4 samples, transient (RENDER only)
//     depthMS   depth32float ×4 samples, transient
//     color     rgba16float   the resolve: LINEAR light, PREMULTIPLIED alpha (sky = 0,0,0,0).
//                             Premultiplied so the MSAA resolve averages edges correctly and
//                             splats / trails blend with one "over" (the WebGL path's straight-
//                             alpha layerRT needed a separate splat merge pass). The compositor
//                             does photo·(1 − a) + rgb and encodes sRGB.
//
// Row order: WebGPU textures are top-down (row 0 = top of the image), unlike WebGL readPixels.
import type { Device, Framebuffer, Texture } from "@luma.gl/core";
import { REVERSED_Z } from "./depth";

/** GPUTextureUsage bits (luma's Texture.* statics mirror these). */
export const USAGE = {
	COPY_SRC: 0x01,
	COPY_DST: 0x02,
	SAMPLE: 0x04,
	STORAGE: 0x08,
	RENDER: 0x10,
} as const;

/** Readable by render passes, compute kernels (storage + sampled) and CPU readback. */
const SHARED = USAGE.RENDER | USAGE.SAMPLE | USAGE.STORAGE | USAGE.COPY_SRC;

export const TARGET_FORMATS = {
	geometry: { format: "rgba32float", usage: SHARED, samples: 1 },
	normal: { format: "rgba16float", usage: SHARED, samples: 1 },
	geometryDepth: {
		format: REVERSED_Z.format,
		usage: USAGE.RENDER | USAGE.SAMPLE | USAGE.COPY_SRC,
		samples: 1,
	},
	colorMS: { format: "rgba16float", usage: USAGE.RENDER, samples: 4 },
	colorDepthMS: { format: REVERSED_Z.format, usage: USAGE.RENDER, samples: 4 },
	color: { format: "rgba16float", usage: SHARED, samples: 1 },
} as const;

export const GEOMETRY_LONG_SIDE = 1024;
export const MSAA_SAMPLES = 4;

/** Geometry target size for a photo aspect (deck/geometry-pass.ts geometrySize, same rule). */
export function geometrySize(aspect: number, longSide = GEOMETRY_LONG_SIDE) {
	return aspect >= 1
		? { width: longSide, height: Math.max(1, Math.round(longSide / aspect)) }
		: { width: Math.max(1, Math.round(longSide * aspect)), height: longSide };
}

type Spec = (typeof TARGET_FORMATS)[keyof typeof TARGET_FORMATS];

function tex(
	device: Device,
	id: string,
	s: Spec,
	width: number,
	height: number,
) {
	return device.createTexture({
		id,
		format: s.format,
		usage: s.usage,
		samples: s.samples,
		width,
		height,
		sampler: {
			minFilter: "nearest",
			magFilter: "nearest",
			addressModeU: "clamp-to-edge",
			addressModeV: "clamp-to-edge",
		},
	});
}

/** The geometry pass's MRT target. */
export class GeometryTargets {
	geometry!: Texture;
	normal!: Texture;
	depth!: Texture;
	fbo!: Framebuffer;

	constructor(
		readonly device: Device,
		width: number,
		height: number,
		readonly id = "geometry",
	) {
		this.create(width, height);
	}

	get width() {
		return this.fbo.width;
	}
	get height() {
		return this.fbo.height;
	}

	private create(width: number, height: number) {
		const d = this.device;
		this.geometry = tex(
			d,
			`${this.id}-xyzr`,
			TARGET_FORMATS.geometry,
			width,
			height,
		);
		this.normal = tex(
			d,
			`${this.id}-normal`,
			TARGET_FORMATS.normal,
			width,
			height,
		);
		this.depth = tex(
			d,
			`${this.id}-depth`,
			TARGET_FORMATS.geometryDepth,
			width,
			height,
		);
		this.fbo = d.createFramebuffer({
			id: `${this.id}-fbo`,
			width,
			height,
			colorAttachments: [this.geometry, this.normal],
			depthStencilAttachment: this.depth,
		});
	}

	resize(width: number, height: number) {
		if (width === this.width && height === this.height) return false;
		this.destroy();
		this.create(width, height);
		return true;
	}

	destroy() {
		this.fbo.destroy();
		this.geometry.destroy();
		this.normal.destroy();
		this.depth.destroy();
	}
}

/** The colour pass: 4× MSAA attachments + the single-sample resolve other passes read. */
export class ColorTargets {
	colorMS!: Texture;
	depthMS!: Texture;
	color!: Texture;
	fbo!: Framebuffer;
	/** Interactive variant (setReduced): 1× depth + a framebuffer drawing straight into `color`.
	 * Allocated on first use, so a session that never drags pays nothing. */
	private depth1: Texture | null = null;
	private fbo1: Framebuffer | null = null;
	private reducedMode = false;

	constructor(
		readonly device: Device,
		width: number,
		height: number,
		readonly id = "color",
	) {
		this.create(width, height);
	}

	get width() {
		return this.fbo.width;
	}
	get height() {
		return this.fbo.height;
	}

	private create(width: number, height: number) {
		const d = this.device;
		this.colorMS = tex(
			d,
			`${this.id}-ms`,
			TARGET_FORMATS.colorMS,
			width,
			height,
		);
		this.depthMS = tex(
			d,
			`${this.id}-depth-ms`,
			TARGET_FORMATS.colorDepthMS,
			width,
			height,
		);
		this.color = tex(
			d,
			`${this.id}-resolve`,
			TARGET_FORMATS.color,
			width,
			height,
		);
		this.fbo = d.createFramebuffer({
			id: `${this.id}-fbo`,
			width,
			height,
			colorAttachments: [this.colorMS],
			depthStencilAttachment: this.depthMS,
		});
	}

	/** Samples per pixel the colour pass draws with: MSAA_SAMPLES, or 1 while reduced. */
	get samples() {
		return this.reducedMode ? 1 : MSAA_SAMPLES;
	}

	/**
	 * Interactive quality (no MSAA): the colour pass draws into `color` directly, no resolve.
	 * Returns whether the mode changed (the caller redraws at full quality on leaving it).
	 */
	setReduced(reduced: boolean) {
		if (reduced === this.reducedMode) return false;
		this.reducedMode = reduced;
		return true;
	}

	/** The colour pass framebuffer for the current mode (MSAA + resolve, or 1× direct). */
	get passFbo(): Framebuffer {
		if (!this.reducedMode) return this.fbo;
		if (!this.fbo1) this.fbo1 = this.createReduced();
		return this.fbo1;
	}

	private createReduced() {
		const d = this.device;
		this.depth1 = tex(
			d,
			`${this.id}-depth-1x`,
			{ ...TARGET_FORMATS.colorDepthMS, samples: 1 },
			this.width,
			this.height,
		);
		return d.createFramebuffer({
			id: `${this.id}-fbo-1x`,
			width: this.width,
			height: this.height,
			colorAttachments: [this.color],
			depthStencilAttachment: this.depth1,
		});
	}

	resize(width: number, height: number) {
		if (width === this.width && height === this.height) return false;
		this.destroy();
		this.create(width, height);
		return true;
	}

	destroy() {
		this.fbo1?.destroy();
		this.depth1?.destroy();
		this.fbo1 = this.depth1 = null;
		this.fbo.destroy();
		this.colorMS.destroy();
		this.depthMS.destroy();
		this.color.destroy();
	}
}

/** Attachment formats a pipeline drawing into each pass must declare (pass.ts passModelProps). */
export const PASS_ATTACHMENTS = {
	geometry: {
		colorAttachmentFormats: [
			TARGET_FORMATS.geometry.format,
			TARGET_FORMATS.normal.format,
		],
		depthStencilAttachmentFormat: REVERSED_Z.format,
		sampleCount: 1,
	},
	color: {
		colorAttachmentFormats: [TARGET_FORMATS.colorMS.format],
		depthStencilAttachmentFormat: REVERSED_Z.format,
		sampleCount: MSAA_SAMPLES,
	},
} as const;
