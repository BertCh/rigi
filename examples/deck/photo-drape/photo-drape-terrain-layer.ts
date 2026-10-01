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
import {
  PHOTO_DRAPE_GLSL,
  PHOTO_DRAPE_WGSL,
  photoDrape,
  type PhotoDrapeUniforms
} from './photo-drape-module';

type Vector3 = [number, number, number];

export type PhotoDrapeTerrainLayerProps = LayerProps & {
  /** Loaded tiles to draw; each names its layer in `demTexture`. */
  tiles: readonly DemTile[];
  /** rgba8unorm 2d-array of Terrarium-encoded tiles. Borrowed: the application owns it. */
  demTexture: Texture;
  /** Local frame the tile offsets are relative to. */
  frame: LocalFrame;
  /** 1 - k for earth curvature with refraction; 0 for a flat earth. */
  curvatureScale?: number;
  /** Distance from the viewing camera at which haze reaches 63 %, metres. */
  hazeDistance?: number;
  hazeColor?: Vector3;
  /** Unit vector towards the sun, local frame. */
  lightDirection?: Vector3;
};

type TerrariumTerrainUniforms = {
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

const TERRAIN_UNIFORM_BLOCK = /* glsl */ `layout(std140) uniform terrariumTerrainUniforms {
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
} terrariumTerrain;`;

/** Uniforms shared by the WGSL and GLSL terrain shaders. */
const terrariumTerrain = {
  name: 'terrariumTerrain',
  bindingLayout: [{name: 'terrariumTerrain', group: 0}],
  source: /* wgsl */ `struct TerrariumTerrainUniforms {
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
@group(0) @binding(auto) var<uniform> terrariumTerrain: TerrariumTerrainUniforms;`,
  vs: TERRAIN_UNIFORM_BLOCK,
  fs: TERRAIN_UNIFORM_BLOCK,
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
} as const satisfies ShaderModule<TerrariumTerrainUniforms>;

/**
 * Terrarium DEM tiles as one instanced grid mesh, draped with a photo.
 *
 * Two models share the mesh and per-tile buffers. The colour model is drawn by deck.gl in the
 * layer's views: a hillshade with distance haze, onto which `photoDrape_apply` projects the photo.
 * The depth model is drawn only when {@link PhotoDrapeEffect} asks for it through
 * {@link drawPhotoDepth}: it renders the range from the photo camera into the effect's shadow map.
 * The effect supplies the `photoDrape` module props (photo camera, photo and shadow map) to the
 * colour model, as deck.gl's LightingEffect supplies lights and its shadow maps.
 */
export class PhotoDrapeTerrainLayer extends Layer<PhotoDrapeTerrainLayerProps> {
  static override layerName = 'PhotoDrapeTerrainLayer';
  static override defaultProps = {
    curvatureScale: 0.87,
    hazeDistance: 90_000,
    hazeColor: [0.72, 0.78, 0.86],
    // Afternoon sun in the south-west: azimuth 235°, elevation 35°.
    lightDirection: [-0.67, -0.47, 0.57]
  };
  declare state: {
    model?: Model;
    depthModel?: Model;
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
    const sharedModelProps = {
      topology: 'triangle-list' as const,
      bufferLayout: [
        {name: 'gridPosition', format: 'float32x3' as const},
        {
          name: 'tiles',
          stepMode: 'instance' as const,
          byteStride: 24,
          attributes: [
            {attribute: 'tileLatitudes', format: 'float32x3' as const, byteOffset: 0},
            {attribute: 'tileLongitudes', format: 'float32x2' as const, byteOffset: 12},
            {attribute: 'tileLayer', format: 'float32' as const, byteOffset: 20}
          ]
        }
      ],
      attributes: {gridPosition: gridBuffer, tiles: tileBuffer},
      indexBuffer,
      vertexCount: indices.length,
      isInstanced: true,
      instanceCount: 0,
      bindings: {demTiles: this.props.demTexture}
    };
    const model = new Model(device, {
      ...this.getShaders({
        source: COLOR_SOURCE,
        vs: COLOR_VERTEX_SHADER,
        fs: COLOR_FRAGMENT_SHADER,
        modules: [project32, terrariumTerrain, photoDrape]
      }),
      ...sharedModelProps,
      id: `${this.id}-color`,
      parameters: {depthCompare: 'less-equal', depthWriteEnabled: true, cullMode: 'none'}
    });
    // Plain luma.gl shaders: the depth pass runs outside deck.gl's layer passes.
    const depthModel = new Model(device, {
      source: DEPTH_SOURCE,
      vs: DEPTH_VERTEX_SHADER,
      fs: DEPTH_FRAGMENT_SHADER,
      modules: [terrariumTerrain, photoDrape],
      ...sharedModelProps,
      id: `${this.id}-photo-depth`,
      parameters: {depthCompare: 'less', depthWriteEnabled: true, cullMode: 'none'}
    });
    this.setState({model, depthModel, gridBuffer, indexBuffer, tileBuffer});
  }

  override updateState({props, oldProps}: UpdateParameters<this>): void {
    const {model, depthModel} = this.state;
    if (props.demTexture !== oldProps.demTexture) {
      model!.setBindings({demTiles: props.demTexture});
      depthModel!.setBindings({demTiles: props.demTexture});
    }
    if (props.tiles !== oldProps.tiles) {
      const tileData = new Float32Array(Math.max(props.tiles.length, 1) * 6);
      props.tiles.forEach((tile, index) => {
        tileData.set([...tile.latitudeOffsets, ...tile.longitudeOffsets, tile.layer], index * 6);
      });
      this.state.tileBuffer?.destroy();
      const tileBuffer = this.context.device.createBuffer({data: tileData});
      model!.setAttributes({tiles: tileBuffer});
      depthModel!.setAttributes({tiles: tileBuffer});
      depthModel!.setInstanceCount(props.tiles.length);
      this.setState({tileBuffer});
    }
  }

  override getModels(): Model[] {
    return this.state.model ? [this.state.model] : [];
  }

  override draw({renderPass}: {renderPass: RenderPass}): void {
    const {model} = this.state;
    if (!model || this.props.tiles.length === 0) return;
    model.shaderInputs.setProps({terrariumTerrain: this.getTerrainUniforms()});
    model.draw(renderPass);
  }

  /**
   * Draws the range from the photo camera into `renderPass`, whose colour target is the shadow
   * map. Returns false when nothing could be drawn yet (no tiles, or the pipeline is not ready).
   */
  drawPhotoDepth(renderPass: RenderPass, uniforms: PhotoDrapeUniforms): boolean {
    const {depthModel} = this.state;
    if (!depthModel || this.props.tiles.length === 0) return false;
    depthModel.shaderInputs.setProps({
      terrariumTerrain: this.getTerrainUniforms(),
      photoDrape: uniforms
    });
    return depthModel.draw(renderPass);
  }

  override finalizeState(context: LayerContext): void {
    this.state.model?.destroy();
    this.state.depthModel?.destroy();
    this.state.gridBuffer?.destroy();
    this.state.indexBuffer?.destroy();
    this.state.tileBuffer?.destroy();
    super.finalizeState(context);
  }

  private getTerrainUniforms(): TerrariumTerrainUniforms {
    const {frame} = this.props;
    // Non-geospatial viewports report the camera position in the layer's local metres.
    const cameraPosition = (this.context.viewport?.cameraPosition ?? [0, 0, 0]) as Vector3;
    return {
      originSinLatitude: frame.sinLatitude,
      originCosLatitude: frame.cosLatitude,
      meridionalRadius: frame.meridionalRadius,
      primeVerticalRadius: frame.primeVerticalRadius,
      earthRadius: frame.earthRadius,
      curvatureScale: this.props.curvatureScale!,
      hazeDistance: this.props.hazeDistance!,
      cameraPosition,
      hazeColor: this.props.hazeColor!,
      lightDirection: this.props.lightDirection!
    };
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

/** Terrarium decoding and tile placement, shared by the colour and depth WGSL shaders. */
const TERRAIN_WGSL = /* wgsl */ `
@group(0) @binding(auto) var demTiles: texture_2d_array<f32>;

const DEM_TILE_SIZE: f32 = 512.0;
const GRID_STEP: f32 = ${1 / GRID_SEGMENTS};

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
  let cosLatitude = terrariumTerrain.originCosLatitude * (1.0 - getSmallVersine(latitudeOffset)) - terrariumTerrain.originSinLatitude * getSmallSine(latitudeOffset);
  let heightScale = 1.0 + elevation / terrariumTerrain.earthRadius;
  let east = terrariumTerrain.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  let north = (terrariumTerrain.meridionalRadius * getSmallSine(latitudeOffset) + terrariumTerrain.primeVerticalRadius * cosLatitude * terrariumTerrain.originSinLatitude * getSmallVersine(longitudeOffset)) * heightScale;
  let up = elevation - terrariumTerrain.curvatureScale * (east * east + north * north) / (2.0 * terrariumTerrain.earthRadius);
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

// Skirt vertices drop by 2 % of the tile width plus 10 m.
fn getSkirtDrop(gridPosition: vec3<f32>, tileLongitudes: vec2<f32>) -> f32 {
  let tileWidth = terrariumTerrain.primeVerticalRadius * terrariumTerrain.originCosLatitude * (tileLongitudes.y - tileLongitudes.x);
  return select(0.0, 0.02 * tileWidth + 10.0, gridPosition.z > 0.5);
}
`;

const COLOR_SOURCE = /* wgsl */ `${TERRAIN_WGSL}
${PHOTO_DRAPE_WGSL}

struct TerrainVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) elevation: f32,
};

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
  position.z -= getSkirtDrop(gridPosition, tileLongitudes);
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
  let light = 0.35 + 0.75 * max(dot(normal, terrariumTerrain.lightDirection), 0.0);
  let haze = 1.0 - exp(-distance(localPosition, terrariumTerrain.cameraPosition) / terrariumTerrain.hazeDistance);
  return mix(color * light, terrariumTerrain.hazeColor, haze);
}

@fragment fn fragmentMain(input: TerrainVertex) -> @location(0) vec4<f32> {
  let normal = normalize(input.normal);
  let color = photoDrape_apply(getTerrainColor(input.localPosition, normal, input.elevation), input.localPosition, normal);
  return vec4<f32>(color, layer.opacity);
}
`;

const DEPTH_SOURCE = /* wgsl */ `${TERRAIN_WGSL}

struct DepthVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) range: f32,
};

@vertex fn vertexMain(
  @location(0) gridPosition: vec3<f32>,
  @location(1) tileLatitudes: vec3<f32>,
  @location(2) tileLongitudes: vec2<f32>,
  @location(3) tileLayer: f32
) -> DepthVertex {
  var position = getTilePosition(tileLatitudes, tileLongitudes, i32(tileLayer + 0.5), gridPosition.xy).xyz;
  position.z -= getSkirtDrop(gridPosition, tileLongitudes);
  var clip = photoDrape.viewProjectionMatrix * vec4<f32>(position, 1.0);
  // OpenGL clip depth (-w..w) to WebGPU's (0..w).
  clip.z = 0.5 * (clip.z + clip.w);
  var output: DepthVertex;
  output.position = clip;
  output.range = distance(position, photoDrape.eye);
  return output;
}

// Kilometres: r16float keeps 11 bits of mantissa, well inside the 1 % bias.
@fragment fn fragmentMain(input: DepthVertex) -> @location(0) vec4<f32> {
  return vec4<f32>(input.range / 1000.0, 0.0, 0.0, 1.0);
}
`;

/** GLSL twin of {@link TERRAIN_WGSL}. */
const TERRAIN_GLSL = /* glsl */ `
uniform sampler2DArray demTiles;

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
  float cosLatitude = terrariumTerrain.originCosLatitude * (1.0 - getSmallVersine(latitudeOffset)) - terrariumTerrain.originSinLatitude * getSmallSine(latitudeOffset);
  float heightScale = 1.0 + elevation / terrariumTerrain.earthRadius;
  float east = terrariumTerrain.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  float north = (terrariumTerrain.meridionalRadius * getSmallSine(latitudeOffset) + terrariumTerrain.primeVerticalRadius * cosLatitude * terrariumTerrain.originSinLatitude * getSmallVersine(longitudeOffset)) * heightScale;
  float up = elevation - terrariumTerrain.curvatureScale * (east * east + north * north) / (2.0 * terrariumTerrain.earthRadius);
  return vec3(east, north, up);
}

vec4 getTilePosition(vec3 latitudes, vec2 longitudes, int layerIndex, vec2 uv) {
  float v = uv.y;
  float latitudeOffset = latitudes.x * (2.0 * v * v - 3.0 * v + 1.0) + latitudes.y * (4.0 * v - 4.0 * v * v) + latitudes.z * (2.0 * v * v - v);
  float longitudeOffset = mix(longitudes.x, longitudes.y, uv.x);
  float tileElevation = getElevation(layerIndex, uv);
  return vec4(getLocalPosition(latitudeOffset, longitudeOffset, tileElevation), tileElevation);
}

float getSkirtDrop(vec3 grid, vec2 longitudes) {
  float tileWidth = terrariumTerrain.primeVerticalRadius * terrariumTerrain.originCosLatitude * (longitudes.y - longitudes.x);
  return grid.z > 0.5 ? 0.02 * tileWidth + 10.0 : 0.0;
}
`;

const COLOR_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec3 gridPosition;
in vec3 tileLatitudes;
in vec2 tileLongitudes;
in float tileLayer;

out vec3 localPosition;
out vec3 normal;
out float elevation;
${TERRAIN_GLSL}
void main() {
  int layerIndex = int(tileLayer + 0.5);
  vec2 uv = gridPosition.xy;
  vec4 center = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv);
  vec3 east = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv + vec2(GRID_STEP, 0.0)).xyz;
  vec3 west = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv - vec2(GRID_STEP, 0.0)).xyz;
  vec3 south = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv + vec2(0.0, GRID_STEP)).xyz;
  vec3 north = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, uv - vec2(0.0, GRID_STEP)).xyz;
  vec3 position = center.xyz;
  position.z -= getSkirtDrop(gridPosition, tileLongitudes);
  geometry.worldPosition = position;
  gl_Position = project_position_to_clipspace(position, vec3(0.0), vec3(0.0));
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  localPosition = position;
  normal = normalize(cross(east - west, north - south));
  elevation = center.w;
}
`;

const COLOR_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in vec3 localPosition;
in vec3 normal;
in float elevation;

out vec4 fragColor;
${PHOTO_DRAPE_GLSL}
vec3 getTerrainColor(vec3 position, vec3 surfaceNormal, float surfaceElevation) {
  vec3 grass = vec3(0.33, 0.40, 0.25);
  vec3 rock = vec3(0.50, 0.48, 0.45);
  vec3 snow = vec3(0.93, 0.95, 0.98);
  float steepness = 1.0 - surfaceNormal.z;
  vec3 color = mix(grass, rock, clamp(max((surfaceElevation - 1700.0) / 600.0, steepness * 2.5 - 0.6), 0.0, 1.0));
  color = mix(color, snow, clamp((surfaceElevation - 2900.0) / 300.0, 0.0, 1.0) * clamp(1.6 - steepness * 3.0, 0.0, 1.0));
  if (surfaceNormal.z > 0.99995 && surfaceElevation < 1000.0) { color = vec3(0.22, 0.38, 0.48); }
  float light = 0.35 + 0.75 * max(dot(surfaceNormal, terrariumTerrain.lightDirection), 0.0);
  float haze = 1.0 - exp(-distance(position, terrariumTerrain.cameraPosition) / terrariumTerrain.hazeDistance);
  return mix(color * light, terrariumTerrain.hazeColor, haze);
}

void main() {
  vec3 surfaceNormal = normalize(normal);
  vec3 color = photoDrape_apply(getTerrainColor(localPosition, surfaceNormal, elevation), localPosition, surfaceNormal);
  fragColor = vec4(color, layer.opacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;

const DEPTH_VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

in vec3 gridPosition;
in vec3 tileLatitudes;
in vec2 tileLongitudes;
in float tileLayer;

out float range;
${TERRAIN_GLSL}
void main() {
  vec3 position = getTilePosition(tileLatitudes, tileLongitudes, int(tileLayer + 0.5), gridPosition.xy).xyz;
  position.z -= getSkirtDrop(gridPosition, tileLongitudes);
  gl_Position = photoDrape.viewProjectionMatrix * vec4(position, 1.0);
  range = distance(position, photoDrape.eye);
}
`;

const DEPTH_FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

in float range;
out vec4 fragColor;

void main() {
  fragColor = vec4(range / 1000.0, 0.0, 0.0, 1.0);
}
`;
