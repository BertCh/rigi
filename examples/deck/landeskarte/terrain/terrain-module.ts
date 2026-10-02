// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type {ShaderModule} from '@luma.gl/shadertools';
import type {TerrainUniforms} from '../types';

// One table drives the WGSL struct, the GLSL std140 block and luma's `uniformTypes`, so the three
// cannot drift. The order is the field order of `TerrainUniforms` in types.ts. luma pads the vec3
// members to 16 bytes itself, exactly as WGSL structs and std140 do.
const UNIFORM_FIELDS = [
  ['originSinLatitude', 'f32'],
  ['originCosLatitude', 'f32'],
  ['meridionalRadius', 'f32'],
  ['primeVerticalRadius', 'f32'],
  ['earthRadius', 'f32'],
  ['curvatureScale', 'f32'],
  ['refractionK', 'f32'],
  ['lakeLevel', 'f32'],
  ['originHeight', 'f32'],
  ['hazeStrength', 'f32'],
  ['panoramaMix', 'f32'],
  ['revealProgress', 'f32'],
  ['shadowEnabled', 'f32'],
  ['layerMask', 'f32'],
  ['shadowOriginEast', 'f32'],
  ['shadowOriginNorth', 'f32'],
  ['shadowSizeMeters', 'f32'],
  ['viewportHeight', 'f32'],
  ['cameraPosition', 'vec3<f32>'],
  ['sunDirection', 'vec3<f32>'],
  ['sunColor', 'vec3<f32>'],
  ['skyColor', 'vec3<f32>']
] as const satisfies readonly (readonly [keyof TerrainUniforms, 'f32' | 'vec3<f32>'])[];

const GLSL_TYPES = {f32: 'float', 'vec3<f32>': 'vec3'} as const;

const wgslMembers = UNIFORM_FIELDS.map(([name, type]) => `  ${name}: ${type},`).join('\n');
const glslMembers = UNIFORM_FIELDS.map(([name, type]) => `  ${GLSL_TYPES[type]} ${name};`).join(
  '\n'
);
const glslBlock = `layout(std140) uniform terrainUniforms {\n${glslMembers}\n} terrain;`;

/** Uniforms shared by the WGSL and GLSL terrain shaders (instance name `terrain`). */
export const terrainModule = {
  name: 'terrain',
  bindingLayout: [{name: 'terrain', group: 0}],
  source: /* wgsl */ `struct TerrainUniforms {
${wgslMembers}
};
@group(0) @binding(auto) var<uniform> terrain: TerrainUniforms;`,
  vs: glslBlock,
  fs: glslBlock,
  uniformTypes: Object.fromEntries(UNIFORM_FIELDS) as {
    [K in keyof TerrainUniforms]: TerrainUniforms[K] extends number ? 'f32' : 'vec3<f32>';
  }
} as const satisfies ShaderModule<TerrainUniforms>;
