// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type {Effect, EffectContext, Layer, PreRenderOptions} from '@deck.gl/core';
import {Texture, type Device, type Framebuffer} from '@luma.gl/core';
import {Matrix4} from '@math.gl/core';
import type {PhotoDrapeProps, PhotoDrapeUniforms} from './photo-drape-module';
import {PhotoDrapeTerrainLayer} from './photo-drape-terrain-layer';
import {getCameraAxes} from './photo-orbit-view';
import type {CameraPose} from './scene-data';

type Vector3 = [number, number, number];

export type PhotoDrapeEffectProps = {
  /** Photo camera position in the local frame, metres. */
  position: Vector3;
  pose: CameraPose;
  /**
   * Changes whenever the terrain under the photo changes; null while it is still streaming in.
   * The shadow map is redrawn when this, the position or the pose changes, never per frame.
   */
  terrainRevision: number | null;
  /** The photo (borrowed), or null to show only the shadow test. */
  photo: Texture | null;
  /** 0 leaves the hillshade, 1 shows the photo wherever the camera saw the terrain. */
  opacity: number;
  /** Tint surfaces inside the photo frame that the camera did not see. */
  showShadowedAreas: boolean;
  /** Shadow-map size; its aspect ratio must be the photo's. */
  shadowMapWidth: number;
  shadowMapHeight: number;
};

/** Terrain nearer than this to the lens is not trustworthy (GPS error, DEM resolution). */
const PHOTO_NEAR_PLANE = 80;
const PHOTO_FAR_PLANE = 250_000;
const DEGREES_TO_RADIANS = Math.PI / 180;

/** Photo camera view-projection matrix, OpenGL clip conventions. */
export function getPhotoViewProjectionMatrix(
  position: Vector3,
  pose: CameraPose,
  aspect: number
): Matrix4 {
  const {forward, up} = getCameraAxes(pose);
  const center = position.map((value, index) => value + forward[index]);
  const view = new Matrix4().lookAt({eye: position, center, up});
  return new Matrix4()
    .perspective({
      fovy: pose.verticalFieldOfView * DEGREES_TO_RADIANS,
      aspect,
      near: PHOTO_NEAR_PLANE,
      far: PHOTO_FAR_PLANE
    })
    .multiplyRight(view);
}

/**
 * A deck.gl effect that projects a photo onto {@link PhotoDrapeTerrainLayer}s, like a slide
 * projector with a shadow map.
 *
 * `preRender` runs before deck.gl's layer pass, outside any render pass. When the photo pose or
 * the terrain changed, it opens a luma.gl render pass on its own framebuffer (an r16float range
 * target plus depth) and asks each drape layer to draw its terrain from the photo camera. Every
 * other frame it does nothing, so orbiting costs no extra pass. `getShaderModuleProps` hands the
 * photo camera, the photo and the shadow map to those layers' `photoDrape` shader module.
 */
export class PhotoDrapeEffect implements Effect {
  id = 'photo-drape';
  props: PhotoDrapeEffectProps;
  /** Number of shadow-map renders so far. */
  shadowMapPasses = 0;
  private device: Device | null = null;
  private shadowMap: Texture | null = null;
  private framebuffer: Framebuffer | null = null;
  private placeholderPhoto: Texture | null = null;
  /** Key of the inputs the shadow map currently holds; null before the first render. */
  private shadowMapKey: string | null = null;

  constructor(props: PhotoDrapeEffectProps) {
    this.props = props;
  }

  setup({device}: EffectContext): void {
    this.device = device;
    const {shadowMapWidth: width, shadowMapHeight: height} = this.props;
    this.shadowMap = device.createTexture({
      id: 'photo-drape-shadow-map',
      format: 'r16float',
      width,
      height,
      usage: Texture.SAMPLE | Texture.RENDER,
      sampler: {minFilter: 'nearest', magFilter: 'nearest'}
    });
    this.framebuffer = device.createFramebuffer({
      id: 'photo-drape-shadow-framebuffer',
      width,
      height,
      colorAttachments: [this.shadowMap],
      depthStencilAttachment: 'depth24plus'
    });
    this.placeholderPhoto = device.createTexture({
      id: 'photo-drape-placeholder',
      format: 'rgba8unorm',
      width: 1,
      height: 1,
      data: new Uint8Array([255, 255, 255, 255])
    });
  }

  setProps(props: Partial<PhotoDrapeEffectProps>): void {
    this.props = {...this.props, ...props};
  }

  /** True when the shadow map holds the current pose and terrain. */
  get isShadowMapCurrent(): boolean {
    return this.shadowMapKey !== null && this.shadowMapKey === this.getShadowMapKey();
  }

  preRender({layers}: PreRenderOptions): void {
    const {device, framebuffer} = this;
    if (!device || !framebuffer || this.props.terrainRevision === null) return;
    if (this.isShadowMapCurrent) return;
    const drapeLayers = layers.filter(isPhotoDrapeLayer);
    if (drapeLayers.length === 0) return;
    const renderPass = device.beginRenderPass({
      id: 'photo-drape-shadow-map',
      framebuffer,
      clearColor: [0, 0, 0, 0],
      clearDepth: 1
    });
    let drawn = true;
    for (const layer of drapeLayers) {
      drawn = layer.drawPhotoDepth(renderPass, this.getUniforms(false)) && drawn;
    }
    renderPass.end();
    if (drawn) {
      this.shadowMapKey = this.getShadowMapKey();
      this.shadowMapPasses++;
    } else {
      // A pipeline was still compiling: try again on the next frame.
      for (const layer of drapeLayers) layer.setNeedsRedraw();
    }
  }

  getShaderModuleProps(layer: Layer): {photoDrape?: PhotoDrapeProps} {
    if (!isPhotoDrapeLayer(layer) || !this.shadowMap || !this.placeholderPhoto) return {};
    return {
      photoDrape: {
        ...this.getUniforms(this.isShadowMapCurrent),
        photoDrapeShadowMap: this.shadowMap,
        photoDrapeImage: this.props.photo ?? this.placeholderPhoto
      }
    };
  }

  cleanup(): void {
    this.framebuffer?.destroy();
    this.shadowMap?.destroy();
    this.placeholderPhoto?.destroy();
    this.framebuffer = null;
    this.shadowMap = null;
    this.placeholderPhoto = null;
    this.shadowMapKey = null;
  }

  private getUniforms(shadowMapReady: boolean): PhotoDrapeUniforms {
    const {position, pose, photo, opacity, showShadowedAreas} = this.props;
    const {shadowMapWidth, shadowMapHeight} = this.props;
    const viewProjectionMatrix = getPhotoViewProjectionMatrix(
      position,
      pose,
      shadowMapWidth / shadowMapHeight
    );
    return {
      viewProjectionMatrix,
      eye: position,
      opacity: photo ? opacity : 0,
      shadowedTint: showShadowedAreas ? 1 : 0,
      texelAngle: (pose.verticalFieldOfView * DEGREES_TO_RADIANS) / shadowMapHeight,
      shadowMapReady: shadowMapReady ? 1 : 0
    };
  }

  private getShadowMapKey(): string {
    const {position, pose, terrainRevision} = this.props;
    return JSON.stringify([position, pose, terrainRevision]);
  }
}

function isPhotoDrapeLayer(layer: Layer): layer is PhotoDrapeTerrainLayer {
  return layer instanceof PhotoDrapeTerrainLayer && layer.props.visible;
}
