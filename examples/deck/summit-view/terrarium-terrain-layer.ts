// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
  Layer,
  project32,
  type LayerContext,
  type LayerProps,
  type UpdateParameters
} from '@deck.gl/core';
import {Buffer, type RenderPass, type Texture} from '@luma.gl/core';
import {Model} from '@luma.gl/engine';
import type {ShaderModule} from '@luma.gl/shadertools';
import {GRID_SEGMENTS, type DemTile, type LocalFrame} from './dem-tiles';

type Vector3 = [number, number, number];

export type TerrariumTerrainLayerProps = LayerProps & {
  /** Loaded tiles to draw; each names its layer in `demTexture`. */
  tiles: readonly DemTile[];
  /** rgba8unorm 2d-array of Terrarium-encoded tiles. Borrowed: the application owns it. */
  demTexture: Texture;
  /** Local frame the tile offsets are relative to. */
  frame: LocalFrame;
  /** 1 - k for earth curvature with refraction; 0 for a flat earth. */
  curvatureScale?: number;
  /** Camera position in the local frame, for haze. */
  cameraPosition: Vector3;
  /** Distance at which haze reaches 63 %, metres. */
  hazeDistance?: number;
  hazeColor?: Vector3;
  /** Unit vector towards the sun, local frame. */
  lightDirection?: Vector3;
};

type SummitTerrainUniforms = {
  originSinLatitude: number;
  originCosLatitude: number;
  meridionalRadius: number;
  primeVerticalRadius: number;
  earthRadius: number;
  curvatureScale: number;
  hazeDistance: number;
  cameraPosition: Vector3;
  hazeColor: Vector3;
  lightDirection: Vector3;
};

/** Uniforms shared by the WGSL and GLSL terrain shaders. */
const summitTerrain = {
  name: 'summitTerrain',
  bindingLayout: [{name: 'summitTerrain', group: 0}],
  source: /* wgsl */ `struct SummitTerrainUniforms {
  originSinLatitude: f32,
  originCosLatitude: f32,
  meridionalRadius: f32,
  primeVerticalRadius: f32,
  earthRadius: f32,
  curvatureScale: f32,
  hazeDistance: f32,
  cameraPosition: vec3<f32>,
  hazeColor: vec3<f32>,
  lightDirection: vec3<f32>,
};
@group(0) @binding(auto) var<uniform> summitTerrain: SummitTerrainUniforms;`,
  vs: /* glsl */ `layout(std140) uniform summitTerrainUniforms {
  float originSinLatitude;
  float originCosLatitude;
  float meridionalRadius;
  float primeVerticalRadius;
  float earthRadius;
  float curvatureScale;
  float hazeDistance;
  vec3 cameraPosition;
  vec3 hazeColor;
  vec3 lightDirection;
} summitTerrain;`,
  fs: /* glsl */ `layout(std140) uniform summitTerrainUniforms {
  float originSinLatitude;
  float originCosLatitude;
  float meridionalRadius;
  float primeVerticalRadius;
  float earthRadius;
  float curvatureScale;
  float hazeDistance;
  vec3 cameraPosition;
  vec3 hazeColor;
  vec3 lightDirection;
} summitTerrain;`,
  uniformTypes: {
    originSinLatitude: 'f32',
    originCosLatitude: 'f32',
    meridionalRadius: 'f32',
    primeVerticalRadius: 'f32',
    earthRadius: 'f32',
    curvatureScale: 'f32',
    hazeDistance: 'f32',
    cameraPosition: 'vec3<f32>',
    hazeColor: 'vec3<f32>',
    lightDirection: 'vec3<f32>'
  }
} as const satisfies ShaderModule<SummitTerrainUniforms>;

/**
 * Draws Terrarium DEM tiles as one instanced grid mesh. Elevations are decoded from the tile bytes
 * in the vertex shader, placed in the camera's local frame with earth curvature and refraction, and
 * shaded with a hillshade and distance haze.
 */
export class TerrariumTerrainLayer extends Layer<TerrariumTerrainLayerProps> {
  static override layerName = 'TerrariumTerrainLayer';
  static override defaultProps = {
    curvatureScale: 0.87,
    hazeDistance: 60_000,
    hazeColor: [0.72, 0.78, 0.86],
    // Afternoon sun in the south-west: azimuth 235°, elevation 35°.
    lightDirection: [-0.67, -0.47, 0.57]
  };
  declare state: {
    model?: Model;
    gridBuffer?: Buffer;
    indexBuffer?: Buffer;
    tileBuffer?: Buffer;
  };

  override getAttributeManager() {
    return null;
  }

  /** deck.gl applies this to `state.model` after every update: one instance per tile. */
  override getNumInstances(): number {
    return this.props.tiles.length;
  }

  override initializeState(): void {
    const device = this.context.device;
    const {gridPositions, indices} = makeGridMesh(GRID_SEGMENTS);
    const gridBuffer = device.createBuffer({data: gridPositions});
    const indexBuffer = device.createBuffer({usage: Buffer.INDEX, data: indices});
    const tileBuffer = device.createBuffer({byteLength: 24});
    const model = new Model(device, {
      ...this.getShaders({
        source: SOURCE,
        vs: VERTEX_SHADER,
        fs: FRAGMENT_SHADER,
        modules: [project32, summitTerrain]
      }),
      id: `${this.id}-mesh`,
      topology: 'triangle-list',
      bufferLayout: [
        {name: 'gridPosition', format: 'float32x3'},
        {
          name: 'tiles',
          stepMode: 'instance',
          byteStride: 24,
          attributes: [
            {attribute: 'tileLatitudes', format: 'float32x3', byteOffset: 0},
            {attribute: 'tileLongitudes', format: 'float32x2', byteOffset: 12},
            {attribute: 'tileLayer', format: 'float32', byteOffset: 20}
          ]
        }
      ],
      attributes: {gridPosition: gridBuffer, tiles: tileBuffer},
      indexBuffer,
      vertexCount: indices.length,
      isInstanced: true,
      instanceCount: 0,
      bindings: {demTiles: this.props.demTexture},
      parameters: {depthCompare: 'less-equal', depthWriteEnabled: true, cullMode: 'none'}
    });
    this.setState({model, gridBuffer, indexBuffer, tileBuffer});
  }

  override updateState({props, oldProps}: UpdateParameters<this>): void {
    const model = this.state.model!;
    if (props.demTexture !== oldProps.demTexture) {
      model.setBindings({demTiles: props.demTexture});
    }
    if (props.tiles !== oldProps.tiles) {
      const tileData = new Float32Array(Math.max(props.tiles.length, 1) * 6);
      props.tiles.forEach((tile, index) => {
        tileData.set(
          [...tile.latitudeOffsets, ...tile.longitudeOffsets, tile.layer],
          index * 6
        );
      });
      this.state.tileBuffer?.destroy();
      const tileBuffer = this.context.device.createBuffer({data: tileData});
      model.setAttributes({tiles: tileBuffer});
      this.setState({tileBuffer});
    }
  }

  override getModels(): Model[] {
    return this.state.model ? [this.state.model] : [];
  }

  override draw({renderPass}: {renderPass: RenderPass}): void {
    const {model} = this.state;
    if (!model || this.props.tiles.length === 0) return;
    const {frame} = this.props;
    const uniforms: SummitTerrainUniforms = {
      originSinLatitude: frame.sinLatitude,
      originCosLatitude: frame.cosLatitude,
      meridionalRadius: frame.meridionalRadius,
      primeVerticalRadius: frame.primeVerticalRadius,
      earthRadius: frame.earthRadius,
      curvatureScale: this.props.curvatureScale!,
      hazeDistance: this.props.hazeDistance!,
      cameraPosition: this.props.cameraPosition,
      hazeColor: this.props.hazeColor!,
      lightDirection: this.props.lightDirection!
    };
    model.shaderInputs.setProps({summitTerrain: uniforms});
    model.draw(renderPass);
  }

  override finalizeState(context: LayerContext): void {
    this.state.model?.destroy();
    this.state.gridBuffer?.destroy();
    this.state.indexBuffer?.destroy();
    this.state.tileBuffer?.destroy();
    super.finalizeState(context);
  }
}

/**
 * A (segments + 1)² vertex grid, row 0 = north, plus a skirt: a copy of the boundary vertices
 * (z = 1) that the shader drops vertically to hide cracks between tiles of different zoom levels.
 */
function makeGridMesh(segments: number): {gridPositions: Float32Array; indices: Uint32Array} {
  const rowLength = segments + 1;
  const boundary: number[] = [];
  for (let index = 0; index < segments; index++) boundary.push(index);
  for (let index = 0; index < segments; index++) boundary.push(index * rowLength + segments);
  for (let index = segments; index > 0; index--) boundary.push(segments * rowLength + index);
  for (let index = segments; index > 0; index--) boundary.push(index * rowLength);
  const gridPositions = new Float32Array((rowLength * rowLength + boundary.length) * 3);
  for (let row = 0; row < rowLength; row++) {
    for (let column = 0; column < rowLength; column++) {
      gridPositions.set([column / segments, row / segments, 0], (row * rowLength + column) * 3);
    }
  }
  boundary.forEach((vertex, index) => {
    const offset = (rowLength * rowLength + index) * 3;
    gridPositions.set([gridPositions[vertex * 3], gridPositions[vertex * 3 + 1], 1], offset);
  });
  const indices: number[] = [];
  for (let row = 0; row < segments; row++) {
    for (let column = 0; column < segments; column++) {
      const topLeft = row * rowLength + column;
      const bottomLeft = topLeft + rowLength;
      indices.push(topLeft, bottomLeft, topLeft + 1, topLeft + 1, bottomLeft, bottomLeft + 1);
    }
  }
  boundary.forEach((vertex, index) => {
    const nextIndex = (index + 1) % boundary.length;
    const skirt = rowLength * rowLength + index;
    const nextSkirt = rowLength * rowLength + nextIndex;
    indices.push(vertex, skirt, boundary[nextIndex], boundary[nextIndex], skirt, nextSkirt);
  });
  return {gridPositions, indices: new Uint32Array(indices)};
}

const SOURCE = /* wgsl */ `
@group(0) @binding(auto) var demTiles: texture_2d_array<f32>;

const DEM_TILE_SIZE: f32 = 512.0;
const GRID_STEP: f32 = ${1 / GRID_SEGMENTS};

struct TerrainVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) elevation: f32,
};

fn decodeTerrarium(tileLayer: i32, pixel: vec2<i32>) -> f32 {
  let color = textureLoad(demTiles, clamp(pixel, vec2<i32>(0), vec2<i32>(511)), tileLayer, 0);
  let bytes = floor(color.rgb * 255.0 + 0.5);
  return bytes.r * 256.0 + bytes.g + bytes.b / 256.0 - 32768.0;
}

// Bilinear elevation at tile fraction uv; pixel centres sit at (i + 0.5) / 512.
fn getElevation(tileLayer: i32, uv: vec2<f32>) -> f32 {
  let pixel = clamp(uv * DEM_TILE_SIZE - 0.5, vec2<f32>(0.0), vec2<f32>(DEM_TILE_SIZE - 1.0));
  let corner = vec2<i32>(floor(pixel));
  let weight = pixel - floor(pixel);
  let upper = mix(decodeTerrarium(tileLayer, corner), decodeTerrarium(tileLayer, corner + vec2<i32>(1, 0)), weight.x);
  let lower = mix(decodeTerrarium(tileLayer, corner + vec2<i32>(0, 1)), decodeTerrarium(tileLayer, corner + vec2<i32>(1, 1)), weight.x);
  return mix(upper, lower, weight.y);
}

fn getSmallSine(angle: f32) -> f32 { return angle - angle * angle * angle / 6.0; }
fn getSmallVersine(angle: f32) -> f32 { let squared = angle * angle; return squared / 2.0 - squared * squared / 24.0; }

// dem-tiles.ts getLocalPositionFromOffsets.
fn getLocalPosition(latitudeOffset: f32, longitudeOffset: f32, elevation: f32) -> vec3<f32> {
  let cosLatitude = summitTerrain.originCosLatitude * (1.0 - getSmallVersine(latitudeOffset)) - summitTerrain.originSinLatitude * getSmallSine(latitudeOffset);
  let heightScale = 1.0 + elevation / summitTerrain.earthRadius;
  let east = summitTerrain.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  let north = (summitTerrain.meridionalRadius * getSmallSine(latitudeOffset) + summitTerrain.primeVerticalRadius * cosLatitude * summitTerrain.originSinLatitude * getSmallVersine(longitudeOffset)) * heightScale;
  let up = elevation - summitTerrain.curvatureScale * (east * east + north * north) / (2.0 * summitTerrain.earthRadius);
  return vec3<f32>(east, north, up);
}

// Latitude is quadratic in the Mercator row to within a few centimetres for zoom 7 and finer.
fn getTilePosition(tileLatitudes: vec3<f32>, tileLongitudes: vec2<f32>, tileLayer: i32, uv: vec2<f32>) -> vec4<f32> {
  let v = uv.y;
  let latitudeOffset = tileLatitudes.x * (2.0 * v * v - 3.0 * v + 1.0) + tileLatitudes.y * (4.0 * v - 4.0 * v * v) + tileLatitudes.z * (2.0 * v * v - v);
  let longitudeOffset = mix(tileLongitudes.x, tileLongitudes.y, uv.x);
  let elevation = getElevation(tileLayer, uv);
  return vec4<f32>(getLocalPosition(latitudeOffset, longitudeOffset, elevation), elevation);
}

@vertex fn vertexMain(
  @location(0) gridPosition: vec3<f32>,
  @location(1) tileLatitudes: vec3<f32>,
  @location(2) tileLongitudes: vec2<f32>,
  @location(3) tileLayer: f32
) -> TerrainVertex {
  let layerIndex = i32(tileLayer + 0.5);
  let uv = gridPosition.xy;
  let center = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv);
  let east = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv + vec2<f32>(GRID_STEP, 0.0)).xyz;
  let west = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv - vec2<f32>(GRID_STEP, 0.0)).xyz;
  let south = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv + vec2<f32>(0.0, GRID_STEP)).xyz;
  let north = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv - vec2<f32>(0.0, GRID_STEP)).xyz;
  var position = center.xyz;
  if (gridPosition.z > 0.5) {
    // Skirt depth grows with tile size: 2 % of the tile width.
    let tileWidth = summitTerrain.primeVerticalRadius * summitTerrain.originCosLatitude * (tileLongitudes.y - tileLongitudes.x);
    position.z -= 0.02 * tileWidth + 10.0;
  }
  var output: TerrainVertex;
  output.position = project_position_to_clipspace(position, vec3<f32>(0.0), vec3<f32>(0.0));
  output.localPosition = position;
  output.normal = normalize(cross(east - west, north - south));
  output.elevation = center.w;
  return output;
}

fn getTerrainColor(localPosition: vec3<f32>, normal: vec3<f32>, elevation: f32) -> vec3<f32> {
  let grass = vec3<f32>(0.33, 0.40, 0.25);
  let rock = vec3<f32>(0.50, 0.48, 0.45);
  let snow = vec3<f32>(0.93, 0.95, 0.98);
  let steepness = 1.0 - normal.z;
  var color = mix(grass, rock, clamp(max((elevation - 1700.0) / 600.0, steepness * 2.5 - 0.6), 0.0, 1.0));
  color = mix(color, snow, clamp((elevation - 2900.0) / 300.0, 0.0, 1.0) * clamp(1.6 - steepness * 3.0, 0.0, 1.0));
  // Lakes are perfectly flat in the DEM.
  if (normal.z > 0.99995 && elevation < 1000.0) { color = vec3<f32>(0.22, 0.38, 0.48); }
  let light = 0.35 + 0.75 * max(dot(normal, summitTerrain.lightDirection), 0.0);
  let haze = 1.0 - exp(-distance(localPosition, summitTerrain.cameraPosition) / summitTerrain.hazeDistance);
  return mix(color * light, summitTerrain.hazeColor, haze);
}

@fragment fn fragmentMain(input: TerrainVertex) -> @location(0) vec4<f32> {
  return vec4<f32>(getTerrainColor(input.localPosition, normalize(input.normal), input.elevation), layer.opacity);
}
`;

const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray demTiles;

in vec3 gridPosition;
in vec3 tileLatitudes;
in vec2 tileLongitudes;
in float tileLayer;

out vec3 localPosition;
out vec3 normal;
out float elevation;

const float DEM_TILE_SIZE = 512.0;
const float GRID_STEP = ${1 / GRID_SEGMENTS};

float decodeTerrarium(int tileLayer, ivec2 pixel) {
  vec4 color = texelFetch(demTiles, ivec3(clamp(pixel, ivec2(0), ivec2(511)), tileLayer), 0);
  vec3 bytes = floor(color.rgb * 255.0 + 0.5);
  return bytes.r * 256.0 + bytes.g + bytes.b / 256.0 - 32768.0;
}

float getElevation(int tileLayer, vec2 uv) {
  vec2 pixel = clamp(uv * DEM_TILE_SIZE - 0.5, vec2(0.0), vec2(DEM_TILE_SIZE - 1.0));
  ivec2 corner = ivec2(floor(pixel));
  vec2 weight = pixel - floor(pixel);
  float upper = mix(decodeTerrarium(tileLayer, corner), decodeTerrarium(tileLayer, corner + ivec2(1, 0)), weight.x);
  float lower = mix(decodeTerrarium(tileLayer, corner + ivec2(0, 1)), decodeTerrarium(tileLayer, corner + ivec2(1, 1)), weight.x);
  return mix(upper, lower, weight.y);
}

float getSmallSine(float angle) { return angle - angle * angle * angle / 6.0; }
float getSmallVersine(float angle) { float squared = angle * angle; return squared / 2.0 - squared * squared / 24.0; }

vec3 getLocalPosition(float latitudeOffset, float longitudeOffset, float elevation) {
  float cosLatitude = summitTerrain.originCosLatitude * (1.0 - getSmallVersine(latitudeOffset)) - summitTerrain.originSinLatitude * getSmallSine(latitudeOffset);
  float heightScale = 1.0 + elevation / summitTerrain.earthRadius;
  float east = summitTerrain.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  float north = (summitTerrain.meridionalRadius * getSmallSine(latitudeOffset) + summitTerrain.primeVerticalRadius * cosLatitude * summitTerrain.originSinLatitude * getSmallVersine(longitudeOffset)) * heightScale;
  float up = elevation - summitTerrain.curvatureScale * (east * east + north * north) / (2.0 * summitTerrain.earthRadius);
  return vec3(east, north, up);
}

vec4 getTilePosition(int layerIndex, vec2 uv) {
  float v = uv.y;
  float latitudeOffset = tileLatitudes.x * (2.0 * v * v - 3.0 * v + 1.0) + tileLatitudes.y * (4.0 * v - 4.0 * v * v) + tileLatitudes.z * (2.0 * v * v - v);
  float longitudeOffset = mix(tileLongitudes.x, tileLongitudes.y, uv.x);
  float tileElevation = getElevation(layerIndex, uv);
  return vec4(getLocalPosition(latitudeOffset, longitudeOffset, tileElevation), tileElevation);
}

void main() {
  int layerIndex = int(tileLayer + 0.5);
  vec2 uv = gridPosition.xy;
  vec4 center = getTilePosition(layerIndex, uv);
  vec3 east = getTilePosition(layerIndex, uv + vec2(GRID_STEP, 0.0)).xyz;
  vec3 west = getTilePosition(layerIndex, uv - vec2(GRID_STEP, 0.0)).xyz;
  vec3 south = getTilePosition(layerIndex, uv + vec2(0.0, GRID_STEP)).xyz;
  vec3 north = getTilePosition(layerIndex, uv - vec2(0.0, GRID_STEP)).xyz;
  vec3 position = center.xyz;
  if (gridPosition.z > 0.5) {
    float tileWidth = summitTerrain.primeVerticalRadius * summitTerrain.originCosLatitude * (tileLongitudes.y - tileLongitudes.x);
    position.z -= 0.02 * tileWidth + 10.0;
  }
  geometry.worldPosition = position;
  gl_Position = project_position_to_clipspace(position, vec3(0.0), vec3(0.0));
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  localPosition = position;
  normal = normalize(cross(east - west, north - south));
  elevation = center.w;
}
`;

const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec3 localPosition;
in vec3 normal;
in float elevation;

out vec4 fragColor;

vec3 getTerrainColor(vec3 position, vec3 surfaceNormal, float surfaceElevation) {
  vec3 grass = vec3(0.33, 0.40, 0.25);
  vec3 rock = vec3(0.50, 0.48, 0.45);
  vec3 snow = vec3(0.93, 0.95, 0.98);
  float steepness = 1.0 - surfaceNormal.z;
  vec3 color = mix(grass, rock, clamp(max((surfaceElevation - 1700.0) / 600.0, steepness * 2.5 - 0.6), 0.0, 1.0));
  color = mix(color, snow, clamp((surfaceElevation - 2900.0) / 300.0, 0.0, 1.0) * clamp(1.6 - steepness * 3.0, 0.0, 1.0));
  if (surfaceNormal.z > 0.99995 && surfaceElevation < 1000.0) { color = vec3(0.22, 0.38, 0.48); }
  float light = 0.35 + 0.75 * max(dot(surfaceNormal, summitTerrain.lightDirection), 0.0);
  float haze = 1.0 - exp(-distance(position, summitTerrain.cameraPosition) / summitTerrain.hazeDistance);
  return mix(color * light, summitTerrain.hazeColor, haze);
}

void main() {
  fragColor = vec4(getTerrainColor(localPosition, normalize(normal), elevation), layer.opacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
