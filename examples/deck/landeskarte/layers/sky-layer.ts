// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {Layer, type LayerContext, type LayerProps} from '@deck.gl/core';
import type {RenderPass} from '@luma.gl/core';
import {Model} from '@luma.gl/engine';
import type {ShaderModule} from '@luma.gl/shadertools';
import type {RGB, Vec3} from '../types';
import {SKY_GLSL_FRAGMENT, SKY_GLSL_VERTEX} from './sky.glsl';
import {SKY_WGSL} from './sky.wgsl';

/**
 * The sheet's paper: #f4f4f4 at 90 % over #ffdb8b at 10 %, the same ground the page uses, so the
 * canvas and the page furniture meet without a seam. Display-referred sRGB, 0..1.
 */
export const PAPER_COLOR: RGB = [0.961, 0.947, 0.916];

export type SkyLayerProps = LayerProps & {
  /** Unit vector towards the sun in ENU. */
  sunDirection: Vec3;
  /** Direct sunlight colour after air-mass extinction (from the sun table). */
  sunColor: RGB;
  /** Fill-light colour of the dome, see `skyColorFor`; blended into the zenith. */
  skyColor: RGB;
  /** 0 = plan (paper only), 1 = panorama (sky). */
  panoramaMix: number;
  /** Camera basis in ENU, unit vectors. `cameraRight`/`cameraUp` already include the roll. */
  cameraForward: Vec3;
  cameraRight: Vec3;
  cameraUp: Vec3;
  /** tan(vfov / 2) of the perspective camera. */
  tanHalfVfov: number;
  /** Viewport width / height. */
  aspect: number;
  /** Eye height above sea level, metres: a summit eye sees through less air. Default 0. */
  eyeHeight?: number;
  /** Atmosphere density multiplier, the same `hazeStrength` the terrain uses. Default 1. */
  strength?: number;
  paperColor?: RGB;
};

type SkyUniforms = {
  sunDirection: Vec3;
  sunColor: Vec3;
  skyColor: Vec3;
  cameraForward: Vec3;
  cameraRight: Vec3;
  cameraUp: Vec3;
  paperColor: Vec3;
  panoramaMix: number;
  tanHalfVfov: number;
  aspect: number;
  eyeHeight: number;
  strength: number;
};

// Vectors first, scalars after: the WGSL struct and the std140 block then pack identically.
const SKY_STRUCT_FIELDS = [
  'vec3 sunDirection',
  'vec3 sunColor',
  'vec3 skyColor',
  'vec3 cameraForward',
  'vec3 cameraRight',
  'vec3 cameraUp',
  'vec3 paperColor',
  'float panoramaMix',
  'float tanHalfVfov',
  'float aspect',
  'float eyeHeight',
  'float strength'
];

const SKY_GLSL_BLOCK = /* glsl */ `layout(std140) uniform skyDomeUniforms {
${SKY_STRUCT_FIELDS.map(field => `  ${field};`).join('\n')}
} skyDome;`;

const SKY_WGSL_STRUCT = /* wgsl */ `struct SkyDomeUniforms {
${SKY_STRUCT_FIELDS.map(field => {
  const [type, name] = field.split(' ');
  return `  ${name}: ${type === 'float' ? 'f32' : 'vec3<f32>'},`;
}).join('\n')}
};
@group(0) @binding(auto) var<uniform> skyDome: SkyDomeUniforms;`;

const skyDome = {
  name: 'skyDome',
  bindingLayout: [{name: 'skyDome', group: 0}],
  source: SKY_WGSL_STRUCT,
  vs: SKY_GLSL_BLOCK,
  fs: SKY_GLSL_BLOCK,
  uniformTypes: {
    sunDirection: 'vec3<f32>',
    sunColor: 'vec3<f32>',
    skyColor: 'vec3<f32>',
    cameraForward: 'vec3<f32>',
    cameraRight: 'vec3<f32>',
    cameraUp: 'vec3<f32>',
    paperColor: 'vec3<f32>',
    panoramaMix: 'f32',
    tanHalfVfov: 'f32',
    aspect: 'f32',
    eyeHeight: 'f32',
    strength: 'f32'
  }
} as const satisfies ShaderModule<SkyUniforms>;

/**
 * Full-screen sky dome, drawn first. One oversized triangle; each pixel rebuilds its view ray from
 * the camera basis, so the layer needs no projection and follows the roll-capable view exactly. It
 * writes no depth, so the terrain always draws over it. In plan (`panoramaMix` 0) it is the paper.
 */
export class SkyLayer extends Layer<SkyLayerProps> {
  static override layerName = 'SkyLayer';
  static override defaultProps = {
    id: 'sky',
    pickable: false,
    eyeHeight: 0,
    strength: 1,
    paperColor: PAPER_COLOR
  };
  declare state: {model?: Model};

  override getAttributeManager() {
    return null;
  }

  override initializeState(): void {
    const model = new Model(this.context.device, {
      ...this.getShaders({
        source: SKY_WGSL,
        vs: SKY_GLSL_VERTEX,
        fs: SKY_GLSL_FRAGMENT,
        modules: [skyDome]
      }),
      id: `${this.id}-dome`,
      topology: 'triangle-list',
      vertexCount: 3,
      // Always passes and never writes: the dome is the background, not scene geometry.
      parameters: {depthCompare: 'always', depthWriteEnabled: false, cullMode: 'none'}
    });
    this.setState({model});
  }

  override getModels(): Model[] {
    return this.state.model ? [this.state.model] : [];
  }

  override draw({renderPass}: {renderPass: RenderPass}): void {
    const {model} = this.state;
    if (!model) return;
    const props = this.props;
    const uniforms: SkyUniforms = {
      sunDirection: props.sunDirection,
      sunColor: props.sunColor,
      skyColor: props.skyColor,
      cameraForward: props.cameraForward,
      cameraRight: props.cameraRight,
      cameraUp: props.cameraUp,
      paperColor: props.paperColor ?? PAPER_COLOR,
      panoramaMix: props.panoramaMix,
      tanHalfVfov: props.tanHalfVfov,
      aspect: props.aspect,
      eyeHeight: props.eyeHeight ?? 0,
      strength: props.strength ?? 1
    };
    model.shaderInputs.setProps({skyDome: uniforms});
    model.draw(renderPass);
  }

  override finalizeState(context: LayerContext): void {
    this.state.model?.destroy();
    super.finalizeState(context);
  }
}

// Sky fill colour (display-referred, 0..1) against the sun's apparent elevation in degrees: night,
// nautical and civil twilight, then a hazy alpine blue. The terrain grade uses it as the shade
// fill and the dome blends it into the zenith, so lit ground and sky share one hue plan.
const SKY_COLOR_STOPS: {elevation: number; color: RGB}[] = [
  {elevation: -18, color: [0.03, 0.04, 0.09]},
  {elevation: -6, color: [0.14, 0.17, 0.33]},
  {elevation: 0, color: [0.42, 0.46, 0.62]},
  {elevation: 6, color: [0.56, 0.68, 0.88]},
  {elevation: 30, color: [0.62, 0.75, 0.95]}
];

/** Fill colour of the sky for a sun elevation in degrees, smoothly interpolated and clamped. */
export function skyColorFor(sunEl: number): RGB {
  const stops = SKY_COLOR_STOPS;
  if (sunEl <= stops[0].elevation) return [...stops[0].color];
  const last = stops[stops.length - 1];
  if (sunEl >= last.elevation) return [...last.color];
  let index = 0;
  while (sunEl > stops[index + 1].elevation) index++;
  const from = stops[index];
  const to = stops[index + 1];
  const t = (sunEl - from.elevation) / (to.elevation - from.elevation);
  const eased = t * t * (3 - 2 * t);
  return [0, 1, 2].map(
    channel => from.color[channel] + (to.color[channel] - from.color[channel]) * eased
  ) as RGB;
}
