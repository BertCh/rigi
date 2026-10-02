// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Photo-view compositing for the deck backend: the deck.gl counterpart of engine.ts's
// geometry pass → layer pass → composite (see composite-shader.ts for the shader port).
//
//   PhotoCompositor (a deck Effect): in preRender, for the photo viewport, draws the Deck's terrain
//     tiles twice offscreen — the geometry pass (range, r32float, 1024 px long side like geoRT) and
//     the colour pass (the layer's style, linear rgb + straight alpha, rgba16float at canvas size
//     like layerRT). Terrain layers opt in with `offscreen: true` so they skip the canvas pass.
//   PhotoCompositeLayer: one full-screen triangle that mixes photo + colour + ridges/skyline +
//     distance tint + blend masks + people mask in linear light and writes sRGB. Put it first in
//     the screen view (under labels / markers).
//
// deck's own post-process path (PostProcessEffect) renders layers into colour-only buffers with no
// depth attachment, which breaks the log-depth terrain; hence an Effect that only pre-renders and
// a layer that draws the result.
import {
	type Effect,
	type EffectContext,
	Layer,
	type LayerProps,
	type PreRenderOptions,
	project32,
	type UpdateParameters,
	type Viewport,
} from "@deck.gl/core";
import {
	type Buffer,
	type Device,
	type Framebuffer,
	Texture,
} from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { Pose } from "../camera";
import type { compositeValues, harmonizeValues } from "../look/composite";
import { COMP_BLOCK, HARM_BLOCK } from "../look/glsl/composite";
import type { LookDefine } from "../look/look-key";
import {
	isDeckSplatLayer,
	SplatColorPass,
	splatDrawKey,
} from "../nearfield/deck-splat-layer";
import type { RevealUniforms } from "../reveal/config";
import {
	type DeckCompositeStyle,
	deckCompositeStyle,
} from "../style/deck-apply";
import { CLASSIC } from "../style/defaults";
import {
	type CompositeModuleProps,
	compositeFs,
	compositeModule,
	compositeVs,
	LOOK_COMPOSITE_MODULES,
} from "./composite-shader";
import {
	GeometryTarget,
	geometrySize,
	glFence,
	gpuDone,
	type ReadbackTiming,
	readbackBuffer,
	readbackQuiet,
	readTextureQuiet,
	TerrainPassRenderer,
} from "./geometry-pass";
import { glOf } from "./gl";
import type { PhotoViewport } from "./photo-view";
import {
	isTerrainTile,
	maskTexture,
	SharedPhotoTexture,
} from "./terrain-layer";
import { isTrailLayer } from "./trail-layer";

export type BlendMethod = "swipe" | "lens" | "range" | "brush";

/** The composite's share of engine.ts Settings (same names and defaults). */
export type CompositeSettings = {
	/** overlay = contours/bands over the photo; replace = a rendered map blended in by `method`. */
	mode: "overlay" | "replace";
	layerOpacity: number;
	ridges: number;
	depthTint: number;
	method: BlendMethod;
	swipe: number;
	/** Lens centre, u right / v DOWN (0..1). */
	lens: [number, number];
	lensR: number;
	rangeKm: number;
	keepSky: boolean;
	feather: number;
	/** Ridge lines fade over terrain closer than this (m). 0 = off. */
	nearFade: number;
	protectPeople: boolean;
};

export const defaultCompositeSettings: CompositeSettings = {
	mode: "overlay",
	layerOpacity: 0.9,
	ridges: 0.8,
	depthTint: 0,
	method: "lens",
	swipe: 0.5,
	lens: [0.5, 0.4],
	lensR: 0.18,
	rangeKm: 3,
	keepSky: true,
	feather: 0.03,
	nearFade: 60,
	protectPeople: true,
};

const METHOD = { swipe: 0, lens: 1, range: 2, brush: 3 } as const;

/**
 * MSAA sample policy of the settled on-screen colour pass: three's layerRT uses 4 samples (exports
 * keep 4 at any DPR). At device-pixel ratio ≥ 2 the colour target already supersamples the CSS
 * pixel, so it takes 2 (MSAA_SAMPLES_HIDPI): measured 2026-09-30 on M3 Pro / ANGLE Metal at
 * 2160×1620, colour pass 35–47 → 23–31 ms GPU and half the MSAA memory; the settled frame differs
 * from 4× only in edge coverage (1–2% of pixels, visually identical at 4× zoom). DPR < 2 is
 * unchanged (bit-identical). While interactive (setInteractive) the colour pass has no MSAA.
 */
export const MSAA_SAMPLES = 4;
export const MSAA_SAMPLES_HIDPI = 2;

/** The settled colour pass's MSAA samples at a device-pixel ratio (capped by `max`; 0 = off). */
export function msaaSamplesFor(dpr: number, max = MSAA_SAMPLES) {
	return Math.min(max, dpr >= 2 ? MSAA_SAMPLES_HIDPI : MSAA_SAMPLES);
}

export type CompositeTiming = {
	/** CPU time to encode the geometry / colour passes (ms); GPU time only with `benchmark`. */
	geometryMs: number;
	colorMs: number;
	/** Whether the geometry pass was skipped (pose, eye and tiles unchanged). */
	geometryCached: boolean;
	/** With `benchmark = true` the passes are gl.finish()ed, so the times include the GPU. */
	synced: boolean;
};

/** The look composite (look/glsl/composite.ts) as the engine hands it over; defines [] = classic. */
export type DeckCompositeLook = {
	/** the composite LOOK_* defines: a change rebuilds the composite program */
	defines: LookDefine[];
	/** COMP_BLOCK values for an output size (px) */
	values:
		| ((width: number, height: number) => ReturnType<typeof compositeValues>)
		| null;
	harmonize: ReturnType<typeof harmonizeValues> | null;
	/** refined masks (RGBA8, row 0 = top), look/composite.ts */
	mask: { w: number; h: number; data: Uint8Array } | null;
	/** the terrain's normal pass (ink creases): drawn once per new value (a settled geometry generation), null = none */
	normal: number | null;
};

const NO_LOOK: DeckCompositeLook = {
	defines: [],
	values: null,
	harmonize: null,
	mask: null,
	normal: null,
};

/** The composite program's shaders for a look (classic: no look modules, no defines). */
function compositeShaders(defines: LookDefine[], modules: ShaderModule[]) {
	return defines.length
		? {
				vs: compositeVs,
				fs: compositeFs,
				modules: [...modules, ...LOOK_COMPOSITE_MODULES],
				defines: Object.fromEntries(defines.map((d) => [d, true])),
			}
		: { vs: compositeVs, fs: compositeFs, modules };
}

export class PhotoCompositor implements Effect {
	id = "photo-composite";
	props = {};
	/** Which deck viewport is the photo camera. */
	viewId = "photo";
	enabled = true;
	/** gl.finish() after each pass so `timing` includes GPU time (debug only: stalls the frame). */
	benchmark = false;
	settings: CompositeSettings = { ...defaultCompositeSettings };
	/** The view style's composite uniforms (ridges, hairline, depth tint); see setStyle. */
	style: DeckCompositeStyle = deckCompositeStyle(CLASSIC);
	timing: CompositeTiming | null = null;
	/** The overlay reveal's uniforms (src/lib/reveal); null = off. */
	reveal: RevealUniforms | null = null;
	/** The look composite (setLook). */
	look: DeckCompositeLook = NO_LOOK;
	readonly brushCanvas: HTMLCanvasElement;
	/** Bumped on every change the canvas can't see (brush, mask, photo): feed it to the layer. */
	version = 0;
	onChange?: () => void;

	private device?: Device;
	private renderer?: TerrainPassRenderer;
	private geo?: GeometryTarget;
	private color?: Framebuffer;
	private empty?: Texture;
	/**
	 * The photo's GPU copy. The engine hands in its own holder (sharePhotoTexture) so the drape layer
	 * shares the one upload; a bare compositor owns its holder and releases it in cleanup().
	 */
	private photoShared = new SharedPhotoTexture();
	private ownsPhotoShared = true;
	private photoSrc: HTMLImageElement | ImageBitmap | null = null;
	private fgTex?: Texture;
	/** concord DSM occluder dim mask (setOccluder); null = off. */
	private occlMask: { width: number; height: number; data: Uint8Array } | null =
		null;
	private occlTex?: Texture;
	private occlDirty = false;
	private fgMask: { width: number; height: number; data: Uint8Array } | null =
		null;
	private fgDirty = false;
	private brushTex?: Texture;
	private brushDirty = true;
	private geoKey: unknown[] = [];
	private normal?: Framebuffer;
	private normalKey: number | null = null;
	private maskTex?: Texture;
	private maskSrc: Uint8Array | null = null;
	private colorKey: unknown[] = [];
	/** Step Inside: the splats' merge over the cached terrain colour (DeckSplatLayer pass "color"). */
	private splatPass?: SplatColorPass;
	private splatKey: unknown[] = [];
	/** True once the colour + geometry targets hold a frame for the current viewport. */
	ready = false;
	/** setInteractive: the colour pass draws without MSAA until the interaction ends. */
	private interactive = false;
	/** The cached colour frame was drawn at interactive (reduced) quality. */
	private colorReduced = false;

	constructor(aspect = 4 / 3) {
		this.brushCanvas = document.createElement("canvas");
		this.brushCanvas.width = 512;
		this.brushCanvas.height = Math.max(1, Math.round(512 / aspect));
	}

	setup({ device }: EffectContext) {
		this.device = device;
	}

	setSettings(s: Partial<CompositeSettings>) {
		this.settings = { ...this.settings, ...s };
	}

	/**
	 * Interaction quality switch (the engine calls it on camera / pose / lens interaction start and
	 * again ~150 ms after input idles). While active the colour pass renders without MSAA (about
	 * 7x cheaper on Apple GPUs at DPR 2); a frame cached at full quality stays in use. On
	 * setInteractive(false) a colour frame drawn at reduced quality is redrawn at full quality, the
	 * same frame as if the interaction never switched modes.
	 */
	setInteractive(active: boolean) {
		if (active === this.interactive) return;
		this.interactive = active;
		// settle: request a frame so preRender replaces the reduced colour frame (if any)
		if (!active && this.colorReduced) this.bump();
	}

	get isInteractive() {
		return this.interactive;
	}

	/** Ridge / skyline / hairline / depth-tint look (src/lib/style/deck-apply.ts deckCompositeStyle). */
	setStyle(style: DeckCompositeStyle) {
		if (style === this.style) return;
		this.style = style;
		this.bump();
	}

	setReveal(r: RevealUniforms | null) {
		if (!r && !this.reveal) return;
		this.reveal = r;
		this.bump();
	}

	/** The look composite: defines, values, masks (see DeckCompositeLook). */
	setLook(look: DeckCompositeLook) {
		this.look = look;
		this.bump();
	}

	setPhoto(img: HTMLImageElement | ImageBitmap | null) {
		if (img === this.photoSrc) return;
		this.photoSrc = img;
		this.photoShared.setSource(img);
		this.bump();
	}

	/** Use the caller's shared photo texture holder (the caller owns and releases it). */
	sharePhotoTexture(shared: SharedPhotoTexture) {
		if (shared === this.photoShared) return;
		if (this.ownsPhotoShared) this.photoShared.release();
		this.photoShared = shared;
		this.ownsPhotoShared = false;
		shared.setSource(this.photoSrc);
		this.bump();
	}

	/** People mask from segmentForeground (row 0 = top); null clears it. */
	setForegroundMask(
		mask: { width: number; height: number; data: Uint8Array } | null,
	) {
		this.fgMask = mask;
		this.fgDirty = true;
		this.bump();
	}

	get hasForeground() {
		return !!this.fgMask;
	}

	/** concord DSM occluder dim mask (composite-only change); null = off: the composite is bit-identical. */
	setOccluder(m: { width: number; height: number; data: Uint8Array } | null) {
		if (!m && !this.occlMask) return;
		this.occlMask = m;
		this.occlDirty = true;
		this.bump();
	}

	/** engine.ts paint(): into the brush mask (normalised coords, v down). */
	paint(u: number, v: number, radius: number, erase: boolean) {
		const ctx = this.brushCanvas.getContext("2d") as CanvasRenderingContext2D;
		const x = u * this.brushCanvas.width;
		const y = v * this.brushCanvas.height;
		const r = radius * this.brushCanvas.width;
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		const c = erase ? "0,0,0" : "255,255,255";
		g.addColorStop(0, `rgba(${c},0.9)`);
		g.addColorStop(0.6, `rgba(${c},0.5)`);
		g.addColorStop(1, `rgba(${c},0)`);
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		this.brushDirty = true;
		this.bump();
	}

	clearBrush(fill = false) {
		const ctx = this.brushCanvas.getContext("2d") as CanvasRenderingContext2D;
		ctx.fillStyle = fill ? "#fff" : "#000";
		ctx.fillRect(0, 0, this.brushCanvas.width, this.brushCanvas.height);
		this.brushDirty = true;
		this.bump();
	}

	private bump() {
		this.version++;
		this.onChange?.();
	}

	/** The layer that puts the composite on screen (id must pass the app's layerFilter). */
	layer(id = "screen-composite") {
		return new PhotoCompositeLayer({
			id,
			compositor: this,
			version: this.version,
			settings: this.settings,
			defines: this.look.defines,
			pickable: false,
			parameters: {
				depthCompare: "always",
				depthWriteEnabled: false,
				blend: false,
			},
		});
	}

	// ---------- Effect ----------

	preRender(opts: PreRenderOptions) {
		const device = this.device;
		if (!this.enabled || !device || opts.isPicking) return;
		const vp = opts.viewports.find((v: Viewport) => v.id === this.viewId) as
			| (Viewport & Partial<PhotoViewport>)
			| undefined;
		if (!vp?.pose || !vp.eye) return;
		this.renderer ??= new TerrainPassRenderer(device);
		const pose: Pose = vp.pose;
		const eye = vp.eye;
		const dpr = device.canvasContext?.cssToDeviceRatio() ?? 1;
		const cw = Math.max(1, Math.round(vp.width * dpr));
		const ch = Math.max(1, Math.round(vp.height * dpr));
		const gs = geometrySize(vp.width / vp.height);
		if (!this.geo) this.geo = new GeometryTarget(device, gs.width, gs.height);
		else this.geo.resize(gs.width, gs.height);
		if (!this.color || this.color.width !== cw || this.color.height !== ch) {
			this.destroyColor();
			this.color = device.createFramebuffer({
				id: "composite-color",
				width: cw,
				height: ch,
				colorAttachments: [
					device.createTexture({
						id: "composite-color-tex",
						format: "rgba16float",
						width: cw,
						height: ch,
						sampler: {
							minFilter: "nearest",
							magFilter: "nearest",
							addressModeU: "clamp-to-edge",
							addressModeV: "clamp-to-edge",
						},
					}),
				],
				depthStencilAttachment: "depth24plus",
			});
			this.colorKey = [];
		}
		const layers = opts.layers.filter((l) => isTerrainTile(l));
		// the colour pass also draws the trails (after the tiles, depth-tested against them)
		const colorLayers = opts.layers.filter(
			(l) => isTerrainTile(l) || isTrailLayer(l),
		);
		const gl = glOf(device);
		// geometry: pose, eye, size and the tile meshes (not their styling)
		const geoKey = [
			pose.yaw,
			pose.pitch,
			pose.roll,
			pose.vfov,
			...eye,
			gs.width,
			gs.height,
			...layers.map((l) => (l.props as { mesh?: unknown }).mesh),
		];
		const t0 = performance.now();
		const geoCached = sameKey(geoKey, this.geoKey);
		if (!geoCached) {
			this.renderer.render("geometry", layers, this.geo.fbo, pose, eye);
			this.geoKey = geoKey;
			if (this.benchmark) gl.finish();
		}
		// the normal pass for the ink creases, once the pose settles (not per drag frame)
		const nk = this.look.normal;
		if (nk != null && nk !== this.normalKey) {
			this.normal = this.floatTarget(
				this.normal,
				gs.width,
				gs.height,
				"rgba16float",
			);
			this.renderer.render("normal", layers, this.normal, pose, eye);
			this.normalKey = nk;
		}
		const t1 = performance.now();
		// colour: any prop change re-creates the tile layer instances
		const colorKey: unknown[] = [
			pose.yaw,
			pose.pitch,
			pose.roll,
			pose.vfov,
			...eye,
			cw,
			ch,
			...colorLayers,
		];
		// Step Inside splats (opt-in): drawn over a snapshot of the terrain colour, so a splat-only
		// change (opacity, truth, a new sort order) skips the terrain; none → the classic path as-is
		const splatLayers = opts.layers.filter((l) => isDeckSplatLayer(l));
		if (splatLayers.length) colorKey.push("splats");
		let colorDrawn = false;
		// a full-quality frame serves an interaction too; a reduced one must be redrawn on settle
		if (
			!sameKey(colorKey, this.colorKey) ||
			(this.colorReduced && !this.interactive)
		) {
			const samples = this.interactive
				? 0
				: msaaSamplesFor(dpr, this.msaaSamples);
			this.renderColor(
				colorLayers,
				this.color,
				pose,
				eye,
				splatLayers.length > 0,
				samples,
			);
			this.colorKey = colorKey;
			this.colorReduced = this.interactive;
			colorDrawn = true;
			if (this.benchmark) gl.finish();
		}
		if (splatLayers.length) {
			const splatKey = [...colorKey, ...splatDrawKey(splatLayers)];
			if (colorDrawn || !sameKey(splatKey, this.splatKey)) {
				this.splatPass?.draw(splatLayers, this.color, pose, eye);
				this.splatKey = splatKey;
				if (this.benchmark) gl.finish();
			}
		} else if (this.splatPass) {
			this.splatPass.destroy();
			this.splatPass = undefined;
			this.splatKey = [];
		}
		const t2 = performance.now();
		this.timing = {
			geometryMs: t1 - t0,
			colorMs: t2 - t1,
			geometryCached: geoCached,
			synced: this.benchmark,
		};
		this.ready = true;
	}

	/** A float colour + depth target of this size (`fbo` reused when it matches). */
	private floatTarget(
		fbo: Framebuffer | undefined,
		width: number,
		height: number,
		format: "rgba16float" | "rgba32float",
	): Framebuffer {
		if (fbo?.width === width && fbo.height === height) return fbo;
		if (fbo) destroyTarget(fbo);
		const device = this.device as Device;
		return device.createFramebuffer({
			width,
			height,
			colorAttachments: [
				device.createTexture({
					format,
					width,
					height,
					sampler: {
						minFilter: "nearest",
						magFilter: "nearest",
						addressModeU: "clamp-to-edge",
						addressModeV: "clamp-to-edge",
					},
				}),
			],
			depthStencilAttachment: "depth24plus",
		});
	}

	/** The band stats' layer: the terrain colour pass of `layers` through `pose` into a fresh rgba32float target. */
	private renderLayer(
		device: Device,
		layers: Layer[],
		pose: Pose,
		eye: [number, number, number],
		width: number,
		height: number,
	): Framebuffer {
		this.renderer ??= new TerrainPassRenderer(device);
		const fbo = this.floatTarget(undefined, width, height, "rgba32float");
		try {
			this.renderer.render(
				"color",
				layers.filter((l) => isTerrainTile(l)),
				fbo,
				pose,
				eye,
			);
		} catch (e) {
			destroyTarget(fbo);
			throw e;
		}
		return fbo;
	}

	/** Timing of the last readLayerAsync that landed, ms. */
	lastStatsRead: ReadbackTiming | null = null;

	/**
	 * The colour pass of `layers` through `pose` at width × height, read back (linear RGBA floats,
	 * premultiplied as the colour pass leaves them, GL rows): the band stats' layer (look/composite.ts,
	 * LOOK_HARMONIZE), ≤ 256 px. An RGBA/FLOAT readPixels (texture.readBuffer reads in the texture's
	 * own format) into a pack buffer copied out once a fence behind it signalled and the GPU queue is
	 * short (readTextureQuiet). Resolves a frame or more later; null = no device, context lost, or
	 * the compositor's device changed meanwhile.
	 */
	async readLayerAsync(
		layers: Layer[],
		pose: Pose,
		eye: [number, number, number],
		width: number,
		height: number,
	): Promise<Float32Array | null> {
		const device = this.device;
		if (!device) return null;
		const fbo = this.renderLayer(device, layers, pose, eye, width, height);
		try {
			const texture = fbo.colorAttachments[0].texture;
			const res = await readTextureQuiet(
				device,
				width * height * 16,
				"layer-readback",
				(buffer) => texture.readBuffer({}, buffer),
				() => this.device !== device,
			);
			if (!res) return null;
			this.lastStatsRead = res.timing;
			return new Float32Array(res.data.buffer, 0, width * height * 4);
		} finally {
			// the readPixels is queued (reads the target): the target can go right away
			destroyTarget(fbo);
		}
	}

	/** The look composite's module props (blocks + mask / normal textures) at an output size. */
	private lookProps(device: Device, width: number, height: number) {
		const L = this.look;
		if (!L.defines.length || !L.values) return null;
		if (L.mask?.data !== this.maskSrc) {
			this.maskTex?.destroy();
			this.maskTex = undefined;
			this.maskSrc = L.mask?.data ?? null;
			if (L.mask)
				this.maskTex = device.createTexture({
					data: L.mask.data,
					width: L.mask.w,
					height: L.mask.h,
					sampler: {
						minFilter: "linear",
						magFilter: "linear",
						addressModeU: "clamp-to-edge",
						addressModeV: "clamp-to-edge",
					},
				});
		}
		const empty = this.empty as Texture;
		return {
			[COMP_BLOCK.name]: {
				...COMP_BLOCK.pack(L.values(width, height)),
				maskTex: this.maskTex ?? empty,
				normalTex:
					(L.normal != null && this.normal?.colorAttachments[0].texture) ||
					empty,
			},
			[HARM_BLOCK.name]: HARM_BLOCK.pack(L.harmonize ?? {}),
		};
	}

	/** Max MSAA samples for the colour pass (three: layerRT samples 4); 0 = off. See msaaSamplesFor. */
	msaaSamples = MSAA_SAMPLES;
	private msaa?: {
		/** rgba16float + depth24plus attachments with `samples` samples (luma: multisample renderbuffers on WebGL) */
		fbo: Framebuffer;
		width: number;
		height: number;
		samples: number;
		/** the requested count (samples is it capped by MAX_SAMPLES) */
		want: number;
	} | null;

	/**
	 * The colour pass into `target`, multisampled when possible: rendered into an MSAA
	 * RGBA16F + depth pair, then resolved into target's texture, like three's layerRT (samples: 4).
	 * Falls back to drawing into `target` directly (also when samples < 2).
	 */
	private renderColor(
		layers: Layer[],
		target: Framebuffer,
		pose: Pose,
		eye: [number, number, number],
		splats = false,
		samples = this.msaaSamples,
	) {
		const renderer = this.renderer as TerrainPassRenderer;
		const ms =
			samples >= 2
				? this.ensureMsaa(target.width, target.height, samples)
				: null;
		if (!ms) {
			renderer.render("color", layers, target, pose, eye);
			if (splats) this.snapshotForSplats(target);
			return;
		}
		renderer.render("color", layers, ms.fbo, pose, eye);
		// The resolve: an empty pass on the MSAA target whose end() blits (NEAREST, full size) its colour
		// into target's texture (luma rigi.5 WebGL resolveTargets), and with `discard` invalidates the
		// multisampled contents, dead once resolved, so a tiler can skip storing them.
		(this.device as Device)
			.beginRenderPass({
				id: "composite-color-resolve",
				framebuffer: ms.fbo,
				clearColor: false,
				clearDepth: false,
				clearStencil: false,
				discard: true,
				resolveTargets: [target.colorAttachments[0]],
				// the splats depth-test against the terrain: resolve its depth too (Step Inside only)
				depthStencilResolveTarget: splats
					? target.depthStencilAttachment
					: null,
			})
			.end();
		if (splats) this.snapshotForSplats(target);
	}

	/** Keep the terrain colour for SplatColorPass (the splats are merged over it). */
	private snapshotForSplats(target: Framebuffer) {
		this.splatPass ??= new SplatColorPass(this.device as Device);
		this.splatPass.snapshot(target);
	}

	private ensureMsaa(width: number, height: number, want: number) {
		if (this.msaa === null || !this.device || want < 2) return null;
		const m = this.msaa;
		if (m && m.width === width && m.height === height && m.want === want)
			return m;
		const device = this.device;
		this.destroyMsaa();
		const gl = glOf(device);
		const samples = Math.min(want, gl.getParameter(gl.MAX_SAMPLES) as number);
		if (samples < 2) {
			this.msaa = null;
			return null;
		}
		const color = device.createTexture({
			id: "composite-color-msaa",
			format: "rgba16float",
			width,
			height,
			samples,
			usage: Texture.RENDER_ATTACHMENT,
		});
		const depth = device.createTexture({
			id: "composite-depth-msaa",
			format: "depth24plus",
			width,
			height,
			samples,
			usage: Texture.RENDER_ATTACHMENT,
		});
		try {
			// a framebuffer with multisampled attachments checks its completeness and throws if incomplete
			const fbo = device.createFramebuffer({
				id: "composite-color-msaa",
				width,
				height,
				colorAttachments: [color],
				depthStencilAttachment: depth,
			});
			this.msaa = { fbo, width, height, samples, want };
			return this.msaa;
		} catch {
			color.destroy();
			depth.destroy();
			console.warn(
				"[composite] MSAA colour target unsupported; drawing without AA",
			);
			this.msaa = null;
			return null;
		}
	}

	private destroyMsaa() {
		const m = this.msaa;
		if (!m) return;
		destroyTarget(m.fbo);
		this.msaa = undefined;
	}

	/**
	 * engine.ts exportImage's render: the composite of `layers` (terrain tiles + trails) through
	 * `pose` at width × height (the photo's full size), offscreen. The geometry pass keeps its
	 * 1024 px long side (three's geoRT is not resized for export either). Returns sRGB RGBA8
	 * bytes, row 0 = top, or null if the compositor isn't set up. The GPU work is encoded and every
	 * target freed synchronously; only the pixel readback is awaited (PBO + fence, no stall).
	 */
	async renderImage(
		layers: Layer[],
		pose: Pose,
		eye: [number, number, number],
		width: number,
		height: number,
	): Promise<Uint8Array | null> {
		const device = this.device;
		if (!device) return null;
		const buf = this.encodeImage(device, layers, pose, eye, width, height);
		if (!buf) return null;
		try {
			// fence, then the quiet-queue wait (readbackQuiet): a bare readAsync right behind the fence
			// is a 100-420 ms sync stall on ANGLE Metal while frames are queued
			const gl = glOf(device);
			const cancelled = () => this.device !== device;
			const fence = await glFence(gl, cancelled);
			if (!fence.ok) return null;
			const quiet = await readbackQuiet(gl, fence.ms, cancelled);
			if (!quiet.ok) return null;
			const px = await buf.readAsync(0, width * height * 4);
			// GL rows are bottom-up
			const row = width * 4;
			const flipped = new Uint8Array(px.length);
			for (let y = 0; y < height; y++)
				flipped.set(
					px.subarray((height - 1 - y) * row, (height - y) * row),
					y * row,
				);
			return flipped;
		} finally {
			buf.destroy();
		}
	}

	/**
	 * The terrain colour pass alone (no photo, no composite, no trails) through `pose`, offscreen at
	 * width × height, multisampled like the on-screen colour pass: linear RGB + straight alpha
	 * (0 = nothing drawn = sky), RGBA float, row 0 = top. DeckEngine.renderPoseView (the matcher's
	 * satellite drape, tools/matcher/server/render_worker.mjs).
	 */
	async renderColorPixels(
		layers: Layer[],
		pose: Pose,
		eye: [number, number, number],
		width: number,
		height: number,
	): Promise<Float32Array | null> {
		const device = this.device;
		if (!device) return null;
		this.renderer ??= new TerrainPassRenderer(device);
		const tex = device.createTexture({
			id: "pose-view-color-tex",
			format: "rgba16float",
			width,
			height,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		const fbo = device.createFramebuffer({
			id: "pose-view-color",
			width,
			height,
			colorAttachments: [tex],
			depthStencilAttachment: "depth24plus",
		});
		try {
			this.renderColor(
				layers.filter((l) => isTerrainTile(l)),
				fbo,
				pose,
				eye,
			);
			if (!(await gpuDone(device))) return null;
			const gl = glOf(device);
			const prev = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
			gl.bindFramebuffer(
				gl.READ_FRAMEBUFFER,
				(fbo as unknown as { handle: WebGLFramebuffer }).handle,
			);
			const px = new Float32Array(width * height * 4);
			gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, px);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prev);
			// GL rows are bottom-up
			const row = width * 4;
			const out = new Float32Array(px.length);
			for (let y = 0; y < height; y++)
				out.set(
					px.subarray((height - 1 - y) * row, (height - y) * row),
					y * row,
				);
			return out;
		} finally {
			fbo.destroy();
			tex.destroy();
		}
	}

	/** renderImage's GPU part: draws the export and queues its readback into a new Buffer. */
	private encodeImage(
		device: Device,
		layers: Layer[],
		pose: Pose,
		eye: [number, number, number],
		width: number,
		height: number,
	): Buffer | null {
		this.renderer ??= new TerrainPassRenderer(device);
		const tiles = layers.filter((l) => isTerrainTile(l));
		const colorLayers = layers.filter(
			(l) => isTerrainTile(l) || isTrailLayer(l),
		);
		const splatLayers = layers.filter((l) => isDeckSplatLayer(l));
		const gs = geometrySize(width / height);
		const geo = new GeometryTarget(device, gs.width, gs.height);
		const colorTex = device.createTexture({
			id: "export-color-tex",
			format: "rgba16float",
			width,
			height,
			sampler: {
				minFilter: "nearest",
				magFilter: "nearest",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		const color = device.createFramebuffer({
			id: "export-color",
			width,
			height,
			colorAttachments: [colorTex],
			depthStencilAttachment: "depth24plus",
		});
		const outTex = device.createTexture({
			id: "export-out-tex",
			format: "rgba8unorm",
			width,
			height,
		});
		const out = device.createFramebuffer({
			id: "export-out",
			width,
			height,
			colorAttachments: [outTex],
		});
		const model = new Model(device, {
			id: "export-composite",
			...compositeShaders(this.look.defines, [compositeModule]),
			geometry: new Geometry({
				topology: "triangle-list",
				attributes: {
					positions: {
						size: 2,
						value: new Float32Array([-1, -1, 3, -1, -1, 3]),
					},
				},
			}),
			bufferLayout: [],
			parameters: {
				depthCompare: "always",
				depthWriteEnabled: false,
				blend: false,
			},
		});
		try {
			this.renderer.render("geometry", tiles, geo.fbo, pose, eye);
			if (splatLayers.length) {
				// a fresh merge at the export size (the on-screen one keeps its snapshot)
				const onScreen = this.splatPass;
				this.splatPass = new SplatColorPass(device);
				try {
					this.renderColor(colorLayers, color, pose, eye, true);
					this.splatPass.draw(splatLayers, color, pose, eye);
				} finally {
					this.splatPass.destroy();
					this.splatPass = onScreen;
				}
			} else this.renderColor(colorLayers, color, pose, eye);
			if (this.look.normal != null) {
				this.normal = this.floatTarget(
					this.normal,
					gs.width,
					gs.height,
					"rgba16float",
				);
				this.renderer.render("normal", tiles, this.normal, pose, eye);
			}
			const props = this.propsFor(device, geo, colorTex, width, height);
			if (!props) return null;
			model.shaderInputs.setProps({
				composite: props,
				...this.lookProps(device, width, height),
			});
			const pass = device.beginRenderPass({
				framebuffer: out,
				clearColor: [0, 0, 0, 1],
				clearDepth: false,
			});
			model.draw(pass);
			pass.end();
			// the readPixels into the PBO is queued now; the targets below can go right away
			const buf = readbackBuffer(device, width * height * 4, "export-readback");
			outTex.readBuffer({}, buf);
			return buf;
		} finally {
			model.destroy();
			out.destroy();
			outTex.destroy();
			color.depthStencilAttachment?.texture.destroy();
			color.destroy();
			colorTex.destroy();
			geo.destroy();
			// the MSAA buffers were sized for the export (hundreds of MB at 12 MP): free them now;
			// the next frame rebuilds the on-screen ones and redraws the colour pass
			this.destroyMsaa();
			this.colorKey = [];
			// the normal pass was drawn for the export's pose: redraw it with the next frame
			this.normalKey = null;
		}
	}

	cleanup() {
		this.destroyMsaa();
		this.splatPass?.destroy();
		this.splatPass = undefined;
		this.splatKey = [];
		if (this.normal) destroyTarget(this.normal);
		this.maskTex?.destroy();
		this.normal = this.maskTex = undefined;
		this.normalKey = null;
		this.maskSrc = null;
		this.geo?.destroy();
		this.geo = undefined;
		this.destroyColor();
		this.empty?.destroy();
		if (this.ownsPhotoShared) this.photoShared.release();
		this.fgTex?.destroy();
		this.brushTex?.destroy();
		this.occlTex?.destroy();
		this.occlTex = undefined;
		this.occlDirty = !!this.occlMask;
		this.empty = this.fgTex = this.brushTex = undefined;
		this.fgDirty = !!this.fgMask;
		this.brushDirty = true;
		this.ready = false;
	}

	private destroyColor() {
		if (!this.color) return;
		this.color.colorAttachments[0].texture.destroy();
		this.color.depthStencilAttachment?.texture.destroy();
		this.color.destroy();
		this.color = undefined;
	}

	/** Uniforms + textures for the composite layer's draw (the look's blocks too, under its defines). */
	moduleProps(device: Device) {
		if (!this.ready || !this.geo || !this.color) return null;
		const { width, height } = this.color;
		const composite = this.propsFor(
			device,
			this.geo,
			this.color.colorAttachments[0].texture,
			width,
			height,
		);
		return composite && { composite, ...this.lookProps(device, width, height) };
	}

	private propsFor(
		device: Device,
		geo: GeometryTarget,
		layerTex: Texture,
		width: number,
		height: number,
	): CompositeModuleProps | null {
		this.empty ??= device.createTexture({
			data: new Uint8Array(4),
			width: 1,
			height: 1,
		});
		const photoTex = this.photoShared.get(device);
		if (this.fgDirty) {
			this.fgTex?.destroy();
			this.fgTex = this.fgMask ? maskTexture(device, this.fgMask) : undefined;
			this.fgDirty = false;
		}
		if (this.occlDirty) {
			this.occlTex?.destroy();
			this.occlTex = this.occlMask
				? maskTexture(device, this.occlMask)
				: undefined;
			this.occlDirty = false;
		}
		if (this.brushDirty) {
			if (!this.brushTex)
				this.brushTex = device.createTexture({
					width: this.brushCanvas.width,
					height: this.brushCanvas.height,
					sampler: {
						minFilter: "linear",
						magFilter: "linear",
						addressModeU: "clamp-to-edge",
						addressModeV: "clamp-to-edge",
					},
				});
			this.brushTex.copyExternalImage({ image: this.brushCanvas });
			this.brushDirty = false;
		}
		const s = this.settings;
		const st = this.style;
		const empty = this.empty;
		return {
			depthC0: st.depthRamp.c0,
			depthC1: st.depthRamp.c1,
			depthDE: st.depthRamp.de,
			depthN: st.depthRamp.n,
			depthRampKind: st.depthRampKind,
			depthLog: st.depthLog,
			depthGain: st.depthGain,
			depthLuma: st.depthLuma,
			ridgeInner: [...st.ridgeInner, 1],
			ridgeSky: [...st.ridgeSky, 1],
			ridgeInnerR: [...st.ridgeInnerR, 1],
			ridgeThr: st.ridgeThr,
			ridgeGainO: st.ridgeGainO,
			ridgeGainR: st.ridgeGainR,
			hair: st.hair,
			geoTexel: [1 / geo.width, 1 / geo.height],
			lens: s.lens,
			mode: s.mode === "overlay" ? 0 : 1,
			layerOpacity: s.layerOpacity,
			ridges: s.ridges,
			depthTint: s.depthTint,
			method: METHOD[s.method],
			swipe: s.swipe,
			lensR: s.lensR,
			rangeM: s.rangeKm * 1000,
			keepSky: s.keepSky ? 1 : 0,
			feather: s.feather,
			aspect: width / height,
			nearFade: s.nearFade,
			fgOn: s.protectPeople && this.fgTex ? 1 : 0,
			hasPhoto: photoTex ? 1 : 0,
			photoTex: photoTex ?? empty,
			layerTex,
			geoTex: geo.texture,
			brushTex: this.brushTex ?? empty,
			fgTex: this.fgTex ?? empty,
			occlTex: this.occlTex ?? empty,
			occlOn: this.occlTex ? 1 : 0,
			ridgeSketch: st.ridgeSketch,
			...revealProps(this.reveal),
		};
	}
}

const V0 = [0, 0, 0, 0];
function revealProps(r: RevealUniforms | null) {
	if (!r)
		return {
			reveal: V0,
			revealWin: V0,
			revealQD: V0,
			revealQE: V0,
			revealShape: V0,
			revealFocus: V0,
			revealGlow: V0,
			revealF: V0,
			revealR: V0,
			revealU: V0,
		};
	return {
		reveal: r.a,
		revealWin: r.win,
		revealQD: r.qD,
		revealQE: r.qE,
		revealShape: r.shape,
		revealFocus: r.focus,
		revealGlow: r.glow,
		revealF: [...r.F, 0],
		revealR: [...r.R, 0],
		revealU: [...r.U, 0],
	};
}

function destroyTarget(fbo: Framebuffer) {
	fbo.colorAttachments[0].texture.destroy();
	fbo.depthStencilAttachment?.texture.destroy();
	fbo.destroy();
}

function sameKey(a: unknown[], b: unknown[]) {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

type CompositeLayerProps = LayerProps & {
	compositor: PhotoCompositor;
	/** Change triggers only: the compositor holds the state. */
	version: number;
	settings: CompositeSettings;
	/** The look's composite defines: a change rebuilds the program. */
	defines: LookDefine[];
};

/** Full-screen composite of photo + terrain (see PhotoCompositor). */
export class PhotoCompositeLayer extends Layer<CompositeLayerProps> {
	static layerName = "PhotoCompositeLayer";
	declare state: { model?: Model };

	getShaders() {
		return super.getShaders(
			compositeShaders(this.props.defines, [project32, compositeModule]),
		);
	}

	initializeState() {
		this.setState({ model: this.makeModel() });
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		if (oldProps.defines && props.defines.join() !== oldProps.defines.join()) {
			this.state.model?.destroy();
			this.setState({ model: this.makeModel() });
		}
	}

	private makeModel() {
		const geometry = new Geometry({
			topology: "triangle-list",
			attributes: {
				positions: { size: 2, value: new Float32Array([-1, -1, 3, -1, -1, 3]) },
			},
		});
		return new Model(this.context.device, {
			...this.getShaders(),
			id: this.props.id,
			geometry,
			bufferLayout: [],
		});
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
	}

	draw() {
		const { model } = this.state;
		const props = this.props.compositor.moduleProps(this.context.device);
		if (!model || !props) return;
		model.shaderInputs.setProps(props);
		model.draw(this.context.renderPass);
	}
}
