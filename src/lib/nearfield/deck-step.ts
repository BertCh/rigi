// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside for the deck backend (DeckEngine.enterStepInside): the pieces three's engine.ts builds
// inline for its step view.
//   stepMasks()     the drape mask while stepping (Object pixels that splats really cover, so from the
//                   photo camera everything else drapes exactly) and the photo-sky mask (Sky pixels,
//                   dilated 2 cells). Same rules as engine.ts rebuildNearFieldMasks.
//   PhotoSkyLayer   the photo projected on a far sphere around the viewing camera, only on the photo's
//                   Sky pixels (step-camera.ts makePhotoSky): drawn first, no depth, alpha-blended over
//                   the world sky; the terrain draws over it.
import { Layer, type LayerProps, type UpdateParameters } from "@deck.gl/core";
import type { Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { makeTexture, maskTexture } from "../deck/terrain-layer";
import { SKY_VS, skyRayMatrix } from "../look/glsl/atmosphere";
import { defineBlock } from "../look/glsl/block";
import {
	buildMeasureGrid,
	type MeasurableScene,
	type MeasureContext,
} from "./measure";
import { type NearFieldScene, PixelClass } from "./types";

export type ByteMask = { width: number; height: number; data: Uint8Array };

function dilate(src: Uint8Array, W: number, H: number, r: number) {
	const out = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			let hit = 0;
			for (let dj = -r; dj <= r && !hit; dj++) {
				const y = j + dj;
				if (y < 0 || y >= H) continue;
				for (let di = -r; di <= r; di++) {
					const x = i + di;
					if (x >= 0 && x < W && src[y * W + x]) {
						hit = 255;
						break;
					}
				}
			}
			out[j * W + i] = hit;
		}
	return out;
}

/**
 * Step-view masks at split resolution (row 0 = top, 0 / 255).
 *   step  Object pixels whose splat stands clearly in front of the terrain (demRange); dilated coverage
 *   sky   Sky pixels, dilated 2 cells (where the photo sky may show)
 */
export function stepMasks(
	scene: NearFieldScene,
	ctx: MeasureContext,
	demRange: (u: number, v: number) => number | null,
): { step: ByteMask; sky: ByteMask } {
	const { width: W, height: H, cls } = scene.split;
	const isObj = new Uint8Array(W * H);
	const isSky = new Uint8Array(W * H);
	for (let k = 0; k < W * H; k++) {
		isObj[k] = cls[k] === PixelClass.Object ? 1 : 0;
		isSky[k] = cls[k] === PixelClass.Sky ? 1 : 0;
	}
	const grid =
		(scene as MeasurableScene).measure ?? buildMeasureGrid(scene, ctx);
	const hasSplat = new Uint8Array(W * H);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			const r = grid.range[k];
			if (!(r > 0)) continue;
			const dem = demRange((i + 0.5) / W, (j + 0.5) / H) ?? 0;
			hasSplat[k] = !(dem > 0) || r < dem * 0.97 - 0.5 ? 1 : 0;
		}
	const covered = dilate(hasSplat, W, H, 1);
	const step = new Uint8Array(W * H);
	for (let k = 0; k < W * H; k++) step[k] = isObj[k] && covered[k] ? 255 : 0;
	return {
		step: { width: W, height: H, data: step },
		sky: { width: W, height: H, data: dilate(isSky, W, H, 2) },
	};
}

const PSKY_BLOCK = defineBlock("psky", "psky", {
	ray: "mat4",
	photoViewProj: "mat4",
	photoPos: "vec3",
});

const PSKY_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vNdc;
uniform sampler2D photoTexture;
uniform sampler2D skyMask;
out vec4 fragColor;
void main() {
  vec4 p = psky_ray * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w);
  vec4 clip = psky_photoViewProj * vec4(psky_photoPos + dir * 20000.0, 1.0);
  if (clip.w <= 0.0) discard;
  vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
  vec2 e = min(puv, 1.0 - puv);
  float inside = smoothstep(-0.02, 0.0, min(e.x, e.y));
  // photo + mask rows run top → bottom (terrain-layer.ts)
  vec2 c = clamp(vec2(puv.x, 1.0 - puv.y), 0.0, 1.0);
  inside *= texture(skyMask, c).r;
  if (inside <= 0.0) discard;
  // the photo texel is already sRGB, as the canvas expects
  fragColor = vec4(texture(photoTexture, c).rgb * inside, inside);
}
`;

/** Drawn first, no depth; premultiplied over the world sky. Pass as the layer's `parameters` too (deck applies those). */
export const PHOTO_SKY_PARAMETERS = {
	depthCompare: "always",
	depthWriteEnabled: false,
	blend: true,
	blendColorOperation: "add",
	blendColorSrcFactor: "one",
	blendColorDstFactor: "one-minus-src-alpha",
	blendAlphaOperation: "add",
	blendAlphaSrcFactor: "one",
	blendAlphaDstFactor: "one-minus-src-alpha",
} as const;

type PhotoSkyProps = LayerProps & {
	photo: HTMLImageElement;
	/** Sky pixels (row 0 = top), from stepMasks(); keep the same object while it is unchanged. */
	skyMask: ByteMask;
	photoViewProj: number[];
	photoPos: [number, number, number];
};

/** The photo on a far sphere (Sky pixels only), premultiplied over the world sky. Draw it first. */
export class PhotoSkyLayer extends Layer<PhotoSkyProps> {
	static layerName = "PhotoSkyLayer";
	declare state: { model?: Model; photo?: Texture; mask?: Texture };

	initializeState() {
		this.setState({
			model: new Model(this.context.device, {
				id: this.props.id,
				vs: `#version 300 es\n${SKY_VS}`,
				fs: PSKY_FS,
				modules: [PSKY_BLOCK.lumaModule],
				topology: "triangle-list",
				vertexCount: 3,
				bufferLayout: [],
				parameters: PHOTO_SKY_PARAMETERS,
			}),
		});
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		const device = this.context.device;
		if (props.photo !== oldProps.photo || !this.state.photo) {
			this.state.photo?.destroy();
			this.setState({ photo: makeTexture(device, props.photo, false) });
		}
		if (props.skyMask !== oldProps.skyMask || !this.state.mask) {
			this.state.mask?.destroy();
			this.setState({ mask: maskTexture(device, props.skyMask) });
		}
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
		this.state.photo?.destroy();
		this.state.mask?.destroy();
	}

	draw() {
		const { model, photo, mask } = this.state;
		const vp = this.context.viewport;
		if (!model || !photo || !mask) return;
		model.setBindings({ photoTexture: photo, skyMask: mask });
		model.shaderInputs.setProps({
			psky: PSKY_BLOCK.pack({
				ray: skyRayMatrix(vp.projectionMatrix, vp.viewMatrix),
				photoViewProj: this.props.photoViewProj,
				photoPos: this.props.photoPos,
			}),
		});
		model.draw(this.context.renderPass);
	}
}
