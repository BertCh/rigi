// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
  COORDINATE_SYSTEM,
  Layer,
  project32,
  type LayerContext,
  type LayerProps,
  type UpdateParameters
} from '@deck.gl/core';
import {Buffer, type RenderPass} from '@luma.gl/core';
import {Model} from '@luma.gl/engine';
import type {ShaderModule} from '@luma.gl/shadertools';
import type {Frame, Vec3} from '../types';
import {NEBELMEER_FS, NEBELMEER_VS} from './nebelmeer.glsl';
import {NEBELMEER_WGSL} from './nebelmeer.wgsl';

// luma.gl's shadertools ships a public `heightFog` module. It is a per-fragment term for a lit
// scene (distance fog with an exponential height falloff); it has no slab geometry, no noise
// and no premultiplied output, and it fogs surfaces by their own height rather than painting a
// sea over a valley. So this layer is analytic: one translucent surface at the fog top.

export type NebelmeerLayerProps = LayerProps & {
  /** Local frame; `frame.origin.h` is the ENU zero height. */
  frame: Frame;
  /** Fog base = lake level, metres above sea level. */
  baseHeight?: number;
  /** 0..1: how closed the sea is. Also sets the thickness, 40 m to 400 m. */
  density?: number;
  /** 0..1: softness of the gaps in the sea (0 crisp banks, 1 feathered). */
  falloff?: number;
  /** Seconds, for the slow drift of the noise. Pass a constant for a still frame. */
  time?: number;
  /** Draw nothing when false. Off by default: the Nebelmeer is an optional layer. */
  enabled?: boolean;
  /** 1 - k, the same curvature factor as the terrain. */
  curvatureScale?: number;
  /** Camera position in the local frame (for view angle and haze). */
  cameraPosition: Vec3;
  sunDirection: Vec3;
  /** Linear RGB, as for the terrain. */
  sunColor: Vec3;
  skyColor: Vec3;
  /** Half side of the square slab, metres. */
  extent?: number;
  /** Slab centre, ENU east/north. */
  center?: [number, number];
};

type NebelmeerUniforms = {
  baseHeight: number;
  thickness: number;
  density: number;
  falloff: number;
  time: number;
  originHeight: number;
  curvatureScale: number;
  earthRadius: number;
  extent: number;
  centerEast: number;
  centerNorth: number;
  cameraPosition: Vec3;
  sunDirection: Vec3;
  sunColor: Vec3;
  skyColor: Vec3;
};

// One table for the WGSL struct, the GLSL std140 block and luma's uniformTypes (as in the
// terrain module). Floats first, vec3 last: luma pads each vec3 to 16 bytes itself.
const UNIFORM_FIELDS = [
  ['baseHeight', 'f32'],
  ['thickness', 'f32'],
  ['density', 'f32'],
  ['falloff', 'f32'],
  ['time', 'f32'],
  ['originHeight', 'f32'],
  ['curvatureScale', 'f32'],
  ['earthRadius', 'f32'],
  ['extent', 'f32'],
  ['centerEast', 'f32'],
  ['centerNorth', 'f32'],
  ['cameraPosition', 'vec3<f32>'],
  ['sunDirection', 'vec3<f32>'],
  ['sunColor', 'vec3<f32>'],
  ['skyColor', 'vec3<f32>']
] as const satisfies readonly (readonly [keyof NebelmeerUniforms, 'f32' | 'vec3<f32>'])[];

const GLSL_TYPES = {f32: 'float', 'vec3<f32>': 'vec3'} as const;
const glslBlock = `layout(std140) uniform nebelmeerUniforms {
${UNIFORM_FIELDS.map(([name, type]) => `  ${GLSL_TYPES[type]} ${name};`).join('\n')}
} nebelmeer;`;

const nebelmeerModule = {
  name: 'nebelmeer',
  bindingLayout: [{name: 'nebelmeer', group: 0}],
  source: /* wgsl */ `struct NebelmeerUniforms {
${UNIFORM_FIELDS.map(([name, type]) => `  ${name}: ${type},`).join('\n')}
};
@group(0) @binding(auto) var<uniform> nebelmeer: NebelmeerUniforms;`,
  vs: glslBlock,
  fs: glslBlock,
  uniformTypes: Object.fromEntries(UNIFORM_FIELDS) as {
    [K in keyof NebelmeerUniforms]: NebelmeerUniforms[K] extends number ? 'f32' : 'vec3<f32>';
  }
} as const satisfies ShaderModule<NebelmeerUniforms>;

const GRID_SEGMENTS = 64;
const MIN_THICKNESS = 40;
const THICKNESS_RANGE = 360;

/**
 * A sea of fog: one translucent, noise-broken surface at `baseHeight + thickness` in the
 * Cartesian ENU frame, bent with the earth like the terrain. Terrain poking above the surface
 * wins the depth test (peaks stand out of the fog); terrain below it is veiled. It writes no
 * depth and outputs premultiplied alpha, so it must draw after the terrain.
 */
export class NebelmeerLayer extends Layer<NebelmeerLayerProps> {
  static override layerName = 'NebelmeerLayer';
  static override defaultProps = {
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    baseHeight: 558,
    density: 0.6,
    falloff: 0.35,
    time: 0,
    enabled: false,
    curvatureScale: 0.87,
    extent: 80_000,
    center: [0, 0]
  };
  declare state: {model?: Model; gridBuffer?: Buffer; indexBuffer?: Buffer};

  override getAttributeManager() {
    return null;
  }

  override initializeState(): void {
    const device = this.context.device;
    const {gridPositions, indices} = makeGridMesh(GRID_SEGMENTS);
    const gridBuffer = device.createBuffer({data: gridPositions});
    const indexBuffer = device.createBuffer({usage: Buffer.INDEX, data: indices});
    const model = new Model(device, {
      ...this.getShaders({
        source: NEBELMEER_WGSL,
        vs: NEBELMEER_VS,
        fs: NEBELMEER_FS,
        modules: [project32, nebelmeerModule]
      }),
      id: `${this.id}-slab`,
      topology: 'triangle-list',
      bufferLayout: [{name: 'gridPosition', format: 'float32x2'}],
      attributes: {gridPosition: gridBuffer},
      indexBuffer,
      vertexCount: indices.length,
      parameters: {
        // Test against the terrain but never write: the fog is a veil, not a wall.
        depthCompare: 'less-equal',
        depthWriteEnabled: false,
        cullMode: 'none',
        blend: true,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one-minus-src-alpha',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one-minus-src-alpha'
      }
    });
    this.setState({model, gridBuffer, indexBuffer});
  }

  override updateState(_params: UpdateParameters<this>): void {}

  override getModels(): Model[] {
    return this.state.model ? [this.state.model] : [];
  }

  override draw({renderPass}: {renderPass: RenderPass}): void {
    const {model} = this.state;
    const props = this.props;
    if (!model || !props.enabled) return;
    const density = Math.min(Math.max(props.density!, 0), 1);
    const uniforms: NebelmeerUniforms = {
      baseHeight: props.baseHeight!,
      thickness: MIN_THICKNESS + THICKNESS_RANGE * density,
      density,
      falloff: Math.min(Math.max(props.falloff!, 0), 1),
      time: props.time!,
      originHeight: props.frame.origin.h,
      curvatureScale: props.curvatureScale!,
      earthRadius: props.frame.earthRadius,
      extent: props.extent!,
      centerEast: props.center![0],
      centerNorth: props.center![1],
      cameraPosition: props.cameraPosition,
      sunDirection: props.sunDirection,
      sunColor: props.sunColor,
      skyColor: props.skyColor
    };
    model.shaderInputs.setProps({nebelmeer: uniforms});
    model.draw(renderPass);
  }

  override finalizeState(context: LayerContext): void {
    this.state.model?.destroy();
    this.state.gridBuffer?.destroy();
    this.state.indexBuffer?.destroy();
    super.finalizeState(context);
  }
}

/** A (segments + 1)^2 grid over [-1, 1]^2; the vertex shader scales it to metres. */
function makeGridMesh(segments: number): {gridPositions: Float32Array; indices: Uint32Array} {
  const rowLength = segments + 1;
  const gridPositions = new Float32Array(rowLength * rowLength * 2);
  for (let row = 0; row < rowLength; row++) {
    for (let column = 0; column < rowLength; column++) {
      gridPositions.set(
        [(column / segments) * 2 - 1, (row / segments) * 2 - 1],
        (row * rowLength + column) * 2
      );
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let cursor = 0;
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const topLeft = row * rowLength + column;
      const bottomLeft = topLeft + rowLength;
      indices.set(
        [topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1],
        cursor
      );
      cursor += 6;
    }
  }
  return {gridPositions, indices};
}
