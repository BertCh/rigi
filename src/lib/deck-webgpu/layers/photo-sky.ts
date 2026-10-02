// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's photo sky on WebGPU: the port of nearfield/deck-step.ts PhotoSkyLayer (itself the
// deck twin of step-camera.ts makePhotoSky). The photo on a far sphere around the viewing camera,
// shown only on the photo's Sky pixels (stepMasks().sky, dilated 2 cells), premultiplied over the
// atmosphere sky.
//
// How it maps onto the foundation (README.md):
//   - colour pass, full-screen triangle at clip.z = 0 (fullscreenWGSL) with test-only reversed-Z
//     depth: `greater-equal` against the cleared 0 passes only where nothing was drawn, i.e. the
//     same "sky pixels only" trick atm-sky uses. Order 91: after atm-sky (90), so the photo sky is
//     blended over it. The WebGL layer drew first with no depth and let the terrain overdraw it;
//     the visible result is the same.
//   - the ray: camera_ray(ndc) of the VIEW camera (world / step orbit camera).
//   - into the photo: DIRECTION ONLY. The WebGL shader projected photoPos + dir·20 km through the
//     absolute photo viewProj; with photoCam's camera-relative viewProj that is exactly
//     photoCam.viewProj · (dir, 0) for x, y, w (w = photoCam.forward · dir) — no eye translation,
//     no 20 km constant, no f32 loss at large ENU offsets.
//   - photo = imageTexture (rgba8unorm-srgb: samples come back LINEAR, as the colour target wants;
//     the WebGL path wrote sRGB texels straight to the canvas — the compositor's encode restores
//     that). Mask = maskTexture (r8unorm, linear filter). Both rows top-first, photo_uv v down.
//   - output premultiplied: (photo·inside, inside), blended one / one-minus-src-alpha.
//
// Visible only in the world view (FrameState.view === "world") and only once photo, sky mask and
// photo camera are set. Never in the geometry pass (queries must see the real sky as sky).
//
// Wiring (assembler / engine.ts):
//   const psky = createPhotoSkyCore();                 // add to the host's cores
//   psky.setPhoto(photoImg);                           // HTMLImageElement / ImageBitmap (or a Texture you own)
//   psky.setSkyMask(stepMasks(scene, ctx, demRange).sky);  // nearfield/deck-step.ts (CPU)
//   psky.setPhotoCamera(cameraUniforms(photoCamera({pose, eye, width: g.width, height: g.height})));
//   psky.setEnabled(stepping);                         // engine: stepping && view === 'step'
// Re-set the mask / photo only when they change (same object → no re-upload).
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { ByteMask } from "#/lib/ontology/core/geometry";
import {
	type CameraUniforms,
	cameraModule,
	photoCameraModule,
} from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
	targetKey,
} from "../pass";
import { imageTexture, maskTexture } from "../textures";
import { fullscreenWGSL } from "../wgsl";

/** Byte mask, row 0 = top, 0 / 255 (nearfield/deck-step.ts ByteMask; stepMasks().sky). */
export type SkyMask = ByteMask;

export type PhotoSource =
	| ImageBitmap
	| HTMLImageElement
	| HTMLCanvasElement
	| OffscreenCanvas;

/** Frame-edge feather in photo uv (step-camera.ts uFeather; deck-step.ts hard-codes 0.02). */
export const PHOTO_SKY_FEATHER = 0.02;
/** Colour-pass order: after atm-sky (90). */
export const PHOTO_SKY_ORDER = 91;

export const pskyModule = {
	name: "psky",
	source: /* wgsl */ `\
struct PhotoSkyUniforms { feather: f32, opacity: f32, pad0: f32, pad1: f32 };
@group(0) @binding(auto) var<uniform> psky: PhotoSkyUniforms;
`,
	uniformTypes: {
		feather: "f32",
		opacity: "f32",
		pad0: "f32",
		pad1: "f32",
	},
	bindingLayout: [{ name: "psky", group: 0 }],
} as const satisfies ShaderModule;

/**
 * WGSL: `photo_sky_uv(dir)` is the direction-only projection (xy = uv, v down; z = w, > 0 in
 * front of the photo camera). CPU twin: photoSkyUv() below.
 */
export const photoSkyWGSL = /* wgsl */ `\
fn photo_sky_uv(dir: vec3<f32>) -> vec3<f32> {
  let c = photoCam.viewProj * vec4<f32>(dir, 0.0);
  let w = select(c.w, 1e-6, abs(c.w) < 1e-6);
  return vec3<f32>(c.x / w * 0.5 + 0.5, 0.5 - c.y / w * 0.5, c.w);
}
`;

export const PHOTO_SKY_WGSL = /* wgsl */ `\
${fullscreenWGSL}
${photoSkyWGSL}
@group(0) @binding(auto) var photoTexture: texture_2d<f32>;
@group(0) @binding(auto) var photoTextureSampler: sampler;
@group(0) @binding(auto) var skyMask: texture_2d<f32>;
@group(0) @binding(auto) var skyMaskSampler: sampler;

@fragment fn fragmentMain(v: FullscreenOut) -> @location(0) vec4<f32> {
  let dir = camera_ray(v.ndc);
  let p = photo_sky_uv(dir);
  let e = min(p.xy, vec2<f32>(1.0) - p.xy);
  let c = clamp(p.xy, vec2<f32>(0.0), vec2<f32>(1.0));
  // sample in uniform control flow (before any discard); single-level textures, so
  // textureSampleLevel is exact and immune to the derivative jump at the w = 0 horizon
  let mask = textureSampleLevel(skyMask, skyMaskSampler, c, 0.0).r;
  let photo = textureSampleLevel(photoTexture, photoTextureSampler, c, 0.0).rgb;
  if (p.z <= 0.0) { discard; }
  let inside = smoothstep(-psky.feather, 0.0, min(e.x, e.y)) * mask * psky.opacity;
  if (inside <= 0.0) { discard; }
  // premultiplied, linear (imageTexture decodes sRGB)
  return vec4<f32>(photo * inside, inside);
}
`;

/**
 * CPU twin of photo_sky_uv: unit ENU direction → photo uv (v down) and w; null behind the photo
 * camera. `photoCam` = cameraUniforms(photoCamera(...)).
 */
export function photoSkyUv(
	photoCam: CameraUniforms,
	dir: readonly [number, number, number],
): { u: number; v: number; w: number } | null {
	const m = photoCam.viewProj;
	const x = m[0] * dir[0] + m[4] * dir[1] + m[8] * dir[2];
	const y = m[1] * dir[0] + m[5] * dir[1] + m[9] * dir[2];
	const w = m[3] * dir[0] + m[7] * dir[1] + m[11] * dir[2];
	if (w <= 0) return null;
	return { u: (x / w) * 0.5 + 0.5, v: 0.5 - (y / w) * 0.5, w };
}

type Owned<T> = { value: T; owned: boolean };

export class PhotoSkyCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = PHOTO_SKY_ORDER;
	/** Frame-edge feather (photo uv). */
	feather = PHOTO_SKY_FEATHER;
	/** Global opacity (1 = the WebGL look; the engine may fade it on enter / leave). */
	opacity = 1;

	private models = new ModelCache();
	private enabled = true;
	private photoCam: CameraUniforms | null = null;
	private photoSrc: PhotoSource | Texture | null = null;
	private photoTex: Owned<Texture> | null = null;
	private photoDirty = false;
	private maskSrc: SkyMask | null = null;
	private maskTex: Texture | null = null;
	private maskDirty = false;

	constructor(readonly id = "photo-sky") {}

	/** On while stepping inside (engine: nearField stepping and view 'step'). */
	setEnabled(on: boolean) {
		this.enabled = on;
	}

	/**
	 * The photo. An image is uploaded once (rgba8unorm-srgb, no mips — deck-step makeTexture(…,
	 * false)) and owned here; a Texture (must be an sRGB format so samples are linear) is borrowed.
	 * Same object again → no-op.
	 */
	setPhoto(photo: PhotoSource | Texture | null) {
		if (photo === this.photoSrc) return;
		this.photoSrc = photo;
		this.photoDirty = true;
	}

	/** stepMasks().sky (row 0 = top). Keep the same object while unchanged. */
	setSkyMask(mask: SkyMask | null) {
		if (mask === this.maskSrc) return;
		this.maskSrc = mask;
		this.maskDirty = true;
	}

	/** The photo camera's uniforms: cameraUniforms(photoCamera({pose, eye, width, height})). Only
	 * viewProj (rotation + intrinsics) is used; any size with the photo's aspect works. */
	setPhotoCamera(u: CameraUniforms | null) {
		this.photoCam = u;
	}

	visible() {
		return (
			this.enabled &&
			this.opacity > 0 &&
			!!this.photoCam &&
			!!this.photoSrc &&
			!!this.maskSrc
		);
	}

	private sync(device: Device) {
		if (this.photoDirty) {
			this.photoDirty = false;
			if (this.photoTex?.owned) this.photoTex.value.destroy();
			this.photoTex = null;
			const src = this.photoSrc;
			if (src && isTexture(src)) this.photoTex = { value: src, owned: false };
			else if (src)
				this.photoTex = {
					value: imageTexture(device, src, {
						id: `${this.id}-photo`,
						mips: false,
					}),
					owned: true,
				};
		}
		if (this.maskDirty) {
			this.maskDirty = false;
			this.maskTex?.destroy();
			this.maskTex = null;
			const m = this.maskSrc;
			if (m && m.width > 0 && m.height > 0)
				this.maskTex = maskTexture(
					device,
					m.data,
					m.width,
					m.height,
					`${this.id}-mask`,
				);
		}
	}

	draw(ctx: PassContext) {
		if (ctx.kind !== "color" || ctx.frame.view !== "world") return;
		if (!this.visible() || !this.photoCam) return;
		this.sync(ctx.device);
		const photo = this.photoTex?.value;
		const mask = this.maskTex;
		if (!photo || !mask) return;
		const model = this.models.get(targetKey(ctx), () => {
			const p = passModelProps("color", { depth: "test", blend: true });
			return new Model(ctx.device, {
				id: `${this.id}-model`,
				source: PHOTO_SKY_WGSL,
				vertexEntryPoint: "fullscreenVertex",
				fragmentEntryPoint: "fragmentMain",
				modules: [cameraModule, photoCameraModule, pskyModule] as never,
				topology: "triangle-list",
				vertexCount: 3,
				bufferLayout: [],
				...p,
			} as never);
		});
		model.shaderInputs.setProps({
			camera: ctx.camera,
			photoCam: this.photoCam,
			psky: {
				feather: this.feather,
				opacity: Math.min(1, Math.max(0, this.opacity)),
				pad0: 0,
				pad1: 0,
			},
		} as never);
		model.setBindings({ photoTexture: photo, skyMask: mask });
		model.draw(ctx.renderPass);
	}

	destroy() {
		this.models.destroy();
		if (this.photoTex?.owned) this.photoTex.value.destroy();
		this.photoTex = null;
		this.maskTex?.destroy();
		this.maskTex = null;
	}
}

function isTexture(x: unknown): x is Texture {
	return (
		!!x &&
		typeof (x as { createView?: unknown }).createView === "function" &&
		typeof (x as { format?: unknown }).format === "string"
	);
}

/** Factory for the assembler: one core per renderer; feed it with the setters above. */
export function createPhotoSkyCore(id = "photo-sky") {
	return new PhotoSkyCore(id);
}
