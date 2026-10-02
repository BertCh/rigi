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
import {LAKE_BRIENZ_ELEVATION} from '../data/scene-data';
import type {LoadedTile, ShadowField, TerrainUniforms} from '../types';
import {ATMO_GLSL} from './atmo.glsl';
import {ATMO_WGSL} from './atmo.wgsl';
import {DEM_TILE_SIZE, GRID_SEGMENTS} from './dem-tiles';
import {INK_GLSL} from './ink.glsl';
import {INK_WGSL} from './ink.wgsl';
import {RELIEF_GLSL} from './relief.glsl';
import {RELIEF_WGSL} from './relief.wgsl';
import {terrainModule} from './terrain-module';

export type TerrainLayerProps = LayerProps & {
  /** Decoded tiles; each names its slice in the DEM texture array through `layer`. */
  tiles: LoadedTile[];
  uniforms: TerrainUniforms;
  /** Cast-shadow and sky-view fields. Null binds 1x1 white textures: lit, open sky. */
  shadowField: ShadowField | null;
  /** Slices in the DEM texture array: the largest `layer + 1` the tile streamer will assign. */
  maxLayers: number;
};

/** Paper ground, #f4f4f4 at 90 % over #ffdb8b at 10 % (the sheet colour the relief rises out of). */
const PAPER_COLOR = '0.961, 0.947, 0.916';
/** Flat lake water, a pale Landeskarte blue. */
const LAKE_COLOR = '0.690, 0.820, 0.890';
/** Brienzersee is flat at its own level; `lakeLevel` carries Thunersee. */
const SECOND_LAKE_LEVEL = `${LAKE_BRIENZ_ELEVATION}.0`;
/** Elevation range the contour reveal sweeps through, lake level up to above the Jungfrau. */
const REVEAL_SWEEP_TOP = 4800;
const REVEAL_SWEEP_BAND = 500;
/** How much of the plan-sheet linework survives in the panorama (contours, rock stripes). */
const PANORAMA_INK_LOSS = 0.6;

/**
 * Draws Terrarium DEM tiles as one instanced grid mesh in the Landeskarte style. The vertex shader
 * decodes the tile bytes, applies earth curvature, and passes tile UV so the fragment shader can
 * re-read the DEM: contours need the bilinear elevation per pixel, not a value interpolated across
 * a 76 m triangle. The fragment shader composes, in order: hypsometric tint times Imhof relief,
 * map ink (contours, scree, rock stripes), then in panorama the sun and shadow grade and the
 * aerial perspective. Plan mode uses the fixed north-west light and ignores the shadow field.
 */
export class TerrainLayer extends Layer<TerrainLayerProps> {
  static override layerName = 'TerrainLayer';
  declare state: {
    model?: Model;
    gridBuffer?: Buffer;
    indexBuffer?: Buffer;
    tileBuffer?: Buffer;
    demTexture?: Texture;
    fallbackShadow?: Texture;
    fallbackAmbient?: Texture;
    /** The bytes last written into each slice, to upload only tiles that are new or replaced. */
    uploaded: Map<number, Uint8Array>;
    /** True after the texture is recreated: every tile must be written again. */
    needsUpload: boolean;
    instanceCount: number;
  };

  override getAttributeManager() {
    return null;
  }

  /** deck.gl applies this to `state.model` after every update: one instance per drawn tile. */
  override getNumInstances(): number {
    return this.state.instanceCount;
  }

  override initializeState(): void {
    const device = this.context.device;
    const {gridPositions, indices} = makeGridMesh(GRID_SEGMENTS);
    const gridBuffer = device.createBuffer({data: gridPositions});
    const indexBuffer = device.createBuffer({usage: Buffer.INDEX, data: indices});
    const tileBuffer = device.createBuffer({byteLength: 24});
    const demTexture = this.createDemTexture();
    const fallbackShadow = createWhiteTexture(this.context.device, `${this.id}-shadow-fallback`);
    const fallbackAmbient = createWhiteTexture(this.context.device, `${this.id}-ambient-fallback`);
    const model = new Model(device, {
      ...this.getShaders({
        source: WGSL_SOURCE,
        vs: VERTEX_SHADER,
        fs: FRAGMENT_SHADER,
        modules: [project32, terrainModule]
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
      bindings: {
        demTiles: demTexture,
        shadowTexture: fallbackShadow,
        ambientTexture: fallbackAmbient
      },
      parameters: {
        depthCompare: 'less-equal',
        depthWriteEnabled: true,
        cullMode: 'none',
        // The shader returns premultiplied colour, on both backends.
        blend: true,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one-minus-src-alpha',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one-minus-src-alpha'
      }
    });
    this.setState({
      model,
      gridBuffer,
      indexBuffer,
      tileBuffer,
      demTexture,
      fallbackShadow,
      fallbackAmbient,
      uploaded: new Map(),
      needsUpload: true,
      instanceCount: 0
    });
  }

  override updateState({props, oldProps}: UpdateParameters<this>): void {
    const model = this.state.model!;
    if (props.maxLayers !== oldProps.maxLayers && oldProps.maxLayers !== undefined) {
      // A resized array starts empty: drop the old one and re-upload every tile below.
      this.state.demTexture?.destroy();
      const demTexture = this.createDemTexture();
      model.setBindings({demTiles: demTexture});
      this.setState({demTexture, uploaded: new Map(), needsUpload: true});
    }
    if (props.shadowField !== oldProps.shadowField) {
      const {shadowField} = props;
      model.setBindings({
        shadowTexture: shadowField?.shadow ?? this.state.fallbackShadow!,
        ambientTexture: shadowField?.ambient ?? this.state.fallbackAmbient!
      });
    }
    if (props.tiles !== oldProps.tiles || this.state.needsUpload) {
      this.uploadTiles(props.tiles);
    }
  }

  override getModels(): Model[] {
    return this.state.model ? [this.state.model] : [];
  }

  override draw({renderPass}: {renderPass: RenderPass}): void {
    const {model} = this.state;
    if (!model || this.state.instanceCount === 0) return;
    const {uniforms, shadowField} = this.props;
    // The field owns its own placement, so a stale uniform can never disagree with the texture.
    model.shaderInputs.setProps({
      terrain: shadowField
        ? {
            ...uniforms,
            shadowOriginEast: shadowField.originEnu[0],
            shadowOriginNorth: shadowField.originEnu[1],
            shadowSizeMeters: shadowField.sizeMeters
          }
        : {...uniforms, shadowEnabled: 0}
    });
    model.draw(renderPass);
  }

  override finalizeState(context: LayerContext): void {
    this.state.model?.destroy();
    this.state.gridBuffer?.destroy();
    this.state.indexBuffer?.destroy();
    this.state.tileBuffer?.destroy();
    this.state.demTexture?.destroy();
    this.state.fallbackShadow?.destroy();
    this.state.fallbackAmbient?.destroy();
    super.finalizeState(context);
  }

  private createDemTexture(): Texture {
    return this.context.device.createTexture({
      id: `${this.id}-dem-tiles`,
      dimension: '2d-array',
      format: 'rgba8unorm',
      width: DEM_TILE_SIZE,
      height: DEM_TILE_SIZE,
      depth: Math.max(this.props.maxLayers, 1)
    });
  }

  /** Writes tiles that are new to their slice, then rebuilds the per-instance tile table. */
  private uploadTiles(tiles: LoadedTile[]): void {
    const {demTexture, uploaded, model} = this.state;
    const drawn: LoadedTile[] = [];
    for (const tile of tiles) {
      if (tile.layer >= this.props.maxLayers) continue;
      if (uploaded.get(tile.layer) !== tile.rgba) {
        demTexture!.writeData(tile.rgba, {z: tile.layer, depthOrArrayLayers: 1});
        uploaded.set(tile.layer, tile.rgba);
      }
      drawn.push(tile);
    }
    const tileData = new Float32Array(Math.max(drawn.length, 1) * 6);
    drawn.forEach((tile, index) => {
      tileData.set([...tile.latitudeOffsets, ...tile.longitudeOffsets, tile.layer], index * 6);
    });
    this.state.tileBuffer?.destroy();
    const tileBuffer = this.context.device.createBuffer({data: tileData});
    model!.setAttributes({tiles: tileBuffer});
    this.setState({tileBuffer, instanceCount: drawn.length, needsUpload: false});
  }
}

/** A 1x1 r8unorm texture holding 1.0: "lit" for the shadow field, "open sky" for the ambient. */
function createWhiteTexture(device: Layer['context']['device'], id: string): Texture {
  return device.createTexture({
    id,
    format: 'r8unorm',
    width: 1,
    height: 1,
    data: new Uint8Array([255])
  });
}

/**
 * A (segments + 1)^2 vertex grid, row 0 = north, plus a skirt: a copy of the boundary vertices
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

// ---------------------------------------------------------------------------------------------
// WGSL
// ---------------------------------------------------------------------------------------------

const WGSL_SOURCE = /* wgsl */ `
@group(0) @binding(auto) var demTiles: texture_2d_array<f32>;
@group(0) @binding(auto) var shadowTexture: texture_2d<f32>;
@group(0) @binding(auto) var ambientTexture: texture_2d<f32>;

const DEM_TILE_SIZE: f32 = ${DEM_TILE_SIZE}.0;
const GRID_STEP: f32 = ${1 / GRID_SEGMENTS};
const TERRAIN_TWO_PI: f32 = 6.283185307;
const PAPER_COLOR = vec3<f32>(${PAPER_COLOR});
const LAKE_COLOR = vec3<f32>(${LAKE_COLOR});

${RELIEF_WGSL}
${INK_WGSL}
${ATMO_WGSL}

struct TerrainVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) localPosition: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) tileUv: vec2<f32>,
  @location(3) @interpolate(flat) tileLayer: i32,
};

fn decodeTerrarium(tileLayer: i32, pixel: vec2<i32>) -> f32 {
  let last = i32(DEM_TILE_SIZE) - 1;
  let color = textureLoad(demTiles, clamp(pixel, vec2<i32>(0), vec2<i32>(last)), tileLayer, 0);
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

// dem-tiles.ts positions: small-angle polynomials on the WGS84 radii, curvature drop on up.
fn getLocalPosition(latitudeOffset: f32, longitudeOffset: f32, elevation: f32) -> vec3<f32> {
  let cosLatitude = terrain.originCosLatitude * (1.0 - getSmallVersine(latitudeOffset)) - terrain.originSinLatitude * getSmallSine(latitudeOffset);
  let heightScale = 1.0 + elevation / terrain.earthRadius;
  let east = terrain.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  let north = (terrain.meridionalRadius * getSmallSine(latitudeOffset) + terrain.primeVerticalRadius * cosLatitude * terrain.originSinLatitude * getSmallVersine(longitudeOffset)) * heightScale;
  let up = elevation - terrain.originHeight - terrain.curvatureScale * (east * east + north * north) / (2.0 * terrain.earthRadius);
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
  // Neighbours are clamped to the tile so edge vertices use one-sided differences: positions are
  // not extrapolated past the tile while the clamped DEM read cannot follow them.
  let east = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, clamp(uv + vec2<f32>(GRID_STEP, 0.0), vec2<f32>(0.0), vec2<f32>(1.0))).xyz;
  let west = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, clamp(uv - vec2<f32>(GRID_STEP, 0.0), vec2<f32>(0.0), vec2<f32>(1.0))).xyz;
  let south = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, clamp(uv + vec2<f32>(0.0, GRID_STEP), vec2<f32>(0.0), vec2<f32>(1.0))).xyz;
  let north = getTilePosition(tileLatitudes, tileLongitudes, layerIndex, clamp(uv - vec2<f32>(0.0, GRID_STEP), vec2<f32>(0.0), vec2<f32>(1.0))).xyz;
  var position = center.xyz;
  if (gridPosition.z > 0.5) {
    // Skirt depth grows with tile size: 2 % of the tile width.
    let tileWidth = terrain.primeVerticalRadius * terrain.originCosLatitude * (tileLongitudes.y - tileLongitudes.x);
    position.z -= 0.02 * tileWidth + 10.0;
  }
  var output: TerrainVertex;
  output.position = project_position_to_clipspace(position, vec3<f32>(0.0), vec3<f32>(0.0));
  output.localPosition = position;
  output.normal = normalize(cross(east - west, north - south));
  output.tileUv = uv;
  output.tileLayer = layerIndex;
  return output;
}

// Bilinear r8unorm lookup at texel coordinates p (texel centres at i + 0.5). textureLoad avoids
// a sampler binding; the two field textures are tiny.
fn sampleField(field: texture_2d<f32>, p: vec2<f32>) -> f32 {
  let size = vec2<i32>(textureDimensions(field));
  let clamped = clamp(p, vec2<f32>(0.0), vec2<f32>(size) - 1.0);
  let corner = vec2<i32>(floor(clamped));
  let weight = clamped - floor(clamped);
  let farCorner = min(corner + vec2<i32>(1), size - 1);
  let upper = mix(textureLoad(field, corner, 0).r, textureLoad(field, vec2<i32>(farCorner.x, corner.y), 0).r, weight.x);
  let lower = mix(textureLoad(field, vec2<i32>(corner.x, farCorner.y), 0).r, textureLoad(field, farCorner, 0).r, weight.x);
  return mix(upper, lower, weight.y);
}

// Shadow (x) and sky-view (y) at an ENU position. Texel (i, j) covers east origin + (i + 0.5) s,
// north origin - (j + 0.5) s. Outside the window the field is unknown: lit, open sky, with a
// four-texel fade so the window edge never shows as a line.
fn getFieldValues(position: vec2<f32>) -> vec2<f32> {
  let size = vec2<f32>(textureDimensions(shadowTexture));
  let texelMeters = terrain.shadowSizeMeters / size.x;
  let p = vec2<f32>(position.x - terrain.shadowOriginEast, terrain.shadowOriginNorth - position.y) / texelMeters - 0.5;
  let edge = min(min(p.x + 0.5, size.x - 0.5 - p.x), min(p.y + 0.5, size.y - 0.5 - p.y));
  let inside = smoothstep(0.0, 4.0, edge);
  let values = vec2<f32>(sampleField(shadowTexture, p), sampleField(ambientTexture, p));
  return mix(vec2<f32>(1.0), values, inside);
}

fn compositeInk(color: vec3<f32>, ink: vec4<f32>) -> vec3<f32> {
  return ink.rgb + color * (1.0 - ink.a);
}

@fragment fn fragmentMain(input: TerrainVertex) -> @location(0) vec4<f32> {
  // Derivatives first: they are only defined in uniform control flow, and the branches below are
  // not. Elevation is re-read from the DEM so contour lines follow the data, not the mesh.
  let elevation = getElevation(input.tileLayer, input.tileUv);
  let fwidthElevation = fwidth(elevation);
  let fwidthPosition = max(fwidth(input.localPosition.x), fwidth(input.localPosition.y));

  let normal = normalize(input.normal);
  let slope = acos(clamp(normal.z, -1.0, 1.0));
  // Downslope azimuth, clockwise from north: the horizontal part of the normal points downhill.
  // Level ground (a lake) has no aspect and atan2(0, 0) is not portable, so pin it to 0.
  var aspect = select(atan2(normal.x, normal.y), 0.0, normal.x == 0.0 && normal.y == 0.0);
  if (aspect < 0.0) { aspect += TERRAIN_TWO_PI; }

  let toCamera = input.localPosition - terrain.cameraPosition;
  let rangeM = length(toCamera);
  let panorama = terrain.panoramaMix;
  let layerMask = u32(terrain.layerMask + 0.5);
  let contoursOn = (layerMask & 1u) != 0u;
  let reliefOn = (layerMask & 2u) != 0u;
  let rockOn = (layerMask & 4u) != 0u;
  let screeOn = (layerMask & 8u) != 0u;
  // Lakes are exactly flat in the DEM; flatness alone would also catch the Interlaken plain.
  let atLakeLevel = abs(elevation - terrain.lakeLevel) <= 0.5 || abs(elevation - ${SECOND_LAKE_LEVEL}) <= 0.5;
  let isLake = select(0.0, 1.0, atLakeLevel && normal.z > 0.9999);

  // Reveal: relief rises out of the paper first, then ink sweeps up the valley from the lake.
  let reliefReveal = smoothstep(0.0, 0.55, terrain.revealProgress);
  let inkProgress = smoothstep(0.45, 0.9, terrain.revealProgress);
  let sweep = inkProgress * ${REVEAL_SWEEP_TOP}.0;
  let inkReveal = 1.0 - smoothstep(sweep - ${REVEAL_SWEEP_BAND}.0, sweep, elevation);
  let inkScale = inkReveal * (1.0 - ${PANORAMA_INK_LOSS} * panorama);

  // Base: hypsometric tint times relief tone. Without relief the tint is shown flat.
  var tone = vec4<f32>(1.0, 1.0, 1.0, 0.78);
  if (reliefOn) { tone = lk_relief(normal, elevation, rangeM, panorama); }
  let shade = tone.a;
  var land = lk_hypso(elevation, shade) * tone.rgb;
  // The lake reflects the sky a little more as the camera lowers into the panorama.
  let water = mix(LAKE_COLOR, terrain.skyColor, 0.3 * panorama);
  var color = mix(land, water, isLake);
  color = mix(PAPER_COLOR, color, reliefReveal);

  // Ink over the base. Every layer is premultiplied, so each composites with one multiply-add.
  if (contoursOn) {
    color = compositeInk(color, lk_ink(elevation, fwidthElevation, slope, aspect, shade, rangeM, isLake) * inkScale);
  }
  if (screeOn) {
    color = compositeInk(color, lk_scree(input.localPosition.xy, fwidthPosition, slope, elevation) * inkScale);
  }
  if (rockOn) {
    color = compositeInk(color, lk_hachure(input.localPosition.xy, fwidthPosition, aspect, slope, shade) * inkScale);
  }

  // Panorama: sun and shadow grade, then aerial perspective. Plan stays a flat paper map.
  if (panorama > 0.0005) {
    var shadow = 1.0;
    var ambient = 1.0;
    if (terrain.shadowEnabled > 0.5) {
      let field = getFieldValues(input.localPosition.xy);
      shadow = field.x;
      ambient = field.y;
    }
    let nDotL = dot(normal, normalize(terrain.sunDirection));
    let screenY01 = clamp(input.position.y / max(terrain.viewportHeight, 1.0), 0.0, 1.0);
    color = lk_grade(color, nDotL, shadow, ambient, terrain.sunColor, terrain.skyColor, panorama, screenY01);
    let eyeHeight = terrain.cameraPosition.z + terrain.originHeight;
    let hazed = lk_atmosphere(color, eyeHeight, elevation, rangeM, toCamera / max(rangeM, 1.0), normalize(terrain.sunDirection), terrain.sunColor, terrain.hazeStrength);
    color = mix(color, hazed, panorama);
  }
  return vec4<f32>(color * layer.opacity, layer.opacity);
}
`;

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------

/** Tile sampling shared by the vertex and fragment stages. */
const DEM_SAMPLING_GLSL = /* glsl */ `
uniform highp sampler2DArray demTiles;

const float DEM_TILE_SIZE = ${DEM_TILE_SIZE}.0;

float decodeTerrarium(int tileLayer, ivec2 pixel) {
  int last = int(DEM_TILE_SIZE) - 1;
  vec4 color = texelFetch(demTiles, ivec3(clamp(pixel, ivec2(0), ivec2(last)), tileLayer), 0);
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
`;

const VERTEX_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
${DEM_SAMPLING_GLSL}
in vec3 gridPosition;
in vec3 tileLatitudes;
in vec2 tileLongitudes;
in float tileLayer;

out vec3 localPosition;
out vec3 normal;
out vec2 tileUv;
flat out int tileLayerIndex;

const float GRID_STEP = ${1 / GRID_SEGMENTS};

float getSmallSine(float angle) { return angle - angle * angle * angle / 6.0; }
float getSmallVersine(float angle) { float squared = angle * angle; return squared / 2.0 - squared * squared / 24.0; }

vec3 getLocalPosition(float latitudeOffset, float longitudeOffset, float elevation) {
  float cosLatitude = terrain.originCosLatitude * (1.0 - getSmallVersine(latitudeOffset)) - terrain.originSinLatitude * getSmallSine(latitudeOffset);
  float heightScale = 1.0 + elevation / terrain.earthRadius;
  float east = terrain.primeVerticalRadius * cosLatitude * getSmallSine(longitudeOffset) * heightScale;
  float north = (terrain.meridionalRadius * getSmallSine(latitudeOffset) + terrain.primeVerticalRadius * cosLatitude * terrain.originSinLatitude * getSmallVersine(longitudeOffset)) * heightScale;
  float up = elevation - terrain.originHeight - terrain.curvatureScale * (east * east + north * north) / (2.0 * terrain.earthRadius);
  return vec3(east, north, up);
}

vec3 getTilePosition(int layerIndex, vec2 uv) {
  float v = uv.y;
  float latitudeOffset = tileLatitudes.x * (2.0 * v * v - 3.0 * v + 1.0) + tileLatitudes.y * (4.0 * v - 4.0 * v * v) + tileLatitudes.z * (2.0 * v * v - v);
  float longitudeOffset = mix(tileLongitudes.x, tileLongitudes.y, uv.x);
  return getLocalPosition(latitudeOffset, longitudeOffset, getElevation(layerIndex, uv));
}

void main() {
  int layerIndex = int(tileLayer + 0.5);
  vec2 uv = gridPosition.xy;
  vec3 center = getTilePosition(layerIndex, uv);
  // Neighbours clamped to the tile: one-sided differences on the edge (see the WGSL copy).
  vec3 east = getTilePosition(layerIndex, clamp(uv + vec2(GRID_STEP, 0.0), vec2(0.0), vec2(1.0)));
  vec3 west = getTilePosition(layerIndex, clamp(uv - vec2(GRID_STEP, 0.0), vec2(0.0), vec2(1.0)));
  vec3 south = getTilePosition(layerIndex, clamp(uv + vec2(0.0, GRID_STEP), vec2(0.0), vec2(1.0)));
  vec3 north = getTilePosition(layerIndex, clamp(uv - vec2(0.0, GRID_STEP), vec2(0.0), vec2(1.0)));
  vec3 position = center;
  if (gridPosition.z > 0.5) {
    float tileWidth = terrain.primeVerticalRadius * terrain.originCosLatitude * (tileLongitudes.y - tileLongitudes.x);
    position.z -= 0.02 * tileWidth + 10.0;
  }
  geometry.worldPosition = position;
  gl_Position = project_position_to_clipspace(position, vec3(0.0), vec3(0.0));
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  localPosition = position;
  normal = normalize(cross(east - west, north - south));
  tileUv = uv;
  tileLayerIndex = layerIndex;
}
`;

const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
// The default sampler precision in a fragment shader is lowp: too coarse for the field lookups.
precision highp sampler2D;
${DEM_SAMPLING_GLSL}
uniform sampler2D shadowTexture;
uniform sampler2D ambientTexture;

in vec3 localPosition;
in vec3 normal;
in vec2 tileUv;
flat in int tileLayerIndex;

out vec4 fragColor;

const float TERRAIN_TWO_PI = 6.283185307;
const vec3 PAPER_COLOR = vec3(${PAPER_COLOR});
const vec3 LAKE_COLOR = vec3(${LAKE_COLOR});

${RELIEF_GLSL}
${INK_GLSL}
${ATMO_GLSL}

// Bilinear r8unorm lookup at texel coordinates p (texel centres at i + 0.5), as in the WGSL twin.
float sampleField(sampler2D field, vec2 p) {
  ivec2 size = textureSize(field, 0);
  vec2 clamped = clamp(p, vec2(0.0), vec2(size) - 1.0);
  ivec2 corner = ivec2(floor(clamped));
  vec2 weight = clamped - floor(clamped);
  ivec2 farCorner = min(corner + ivec2(1), size - 1);
  float upper = mix(texelFetch(field, corner, 0).r, texelFetch(field, ivec2(farCorner.x, corner.y), 0).r, weight.x);
  float lower = mix(texelFetch(field, ivec2(corner.x, farCorner.y), 0).r, texelFetch(field, farCorner, 0).r, weight.x);
  return mix(upper, lower, weight.y);
}

vec2 getFieldValues(vec2 position) {
  vec2 size = vec2(textureSize(shadowTexture, 0));
  float texelMeters = terrain.shadowSizeMeters / size.x;
  vec2 p = vec2(position.x - terrain.shadowOriginEast, terrain.shadowOriginNorth - position.y) / texelMeters - 0.5;
  float edge = min(min(p.x + 0.5, size.x - 0.5 - p.x), min(p.y + 0.5, size.y - 0.5 - p.y));
  float inside = smoothstep(0.0, 4.0, edge);
  vec2 values = vec2(sampleField(shadowTexture, p), sampleField(ambientTexture, p));
  return mix(vec2(1.0), values, inside);
}

vec3 compositeInk(vec3 color, vec4 ink) {
  return ink.rgb + color * (1.0 - ink.a);
}

void main() {
  // Derivatives first, in uniform control flow (see the WGSL twin).
  float elevation = getElevation(tileLayerIndex, tileUv);
  float fwidthElevation = fwidth(elevation);
  float fwidthPosition = max(fwidth(localPosition.x), fwidth(localPosition.y));

  vec3 surfaceNormal = normalize(normal);
  float slope = acos(clamp(surfaceNormal.z, -1.0, 1.0));
  float aspect = (surfaceNormal.x == 0.0 && surfaceNormal.y == 0.0) ? 0.0 : atan(surfaceNormal.x, surfaceNormal.y);
  if (aspect < 0.0) { aspect += TERRAIN_TWO_PI; }

  vec3 toCamera = localPosition - terrain.cameraPosition;
  float rangeM = length(toCamera);
  float panorama = terrain.panoramaMix;
  int layerMask = int(terrain.layerMask + 0.5);
  bool contoursOn = (layerMask & 1) != 0;
  bool reliefOn = (layerMask & 2) != 0;
  bool rockOn = (layerMask & 4) != 0;
  bool screeOn = (layerMask & 8) != 0;
  bool atLakeLevel = abs(elevation - terrain.lakeLevel) <= 0.5 || abs(elevation - ${SECOND_LAKE_LEVEL}) <= 0.5;
  float isLake = (atLakeLevel && surfaceNormal.z > 0.9999) ? 1.0 : 0.0;

  float reliefReveal = smoothstep(0.0, 0.55, terrain.revealProgress);
  float inkProgress = smoothstep(0.45, 0.9, terrain.revealProgress);
  float sweep = inkProgress * ${REVEAL_SWEEP_TOP}.0;
  float inkReveal = 1.0 - smoothstep(sweep - ${REVEAL_SWEEP_BAND}.0, sweep, elevation);
  float inkScale = inkReveal * (1.0 - ${PANORAMA_INK_LOSS} * panorama);

  vec4 tone = vec4(1.0, 1.0, 1.0, 0.78);
  if (reliefOn) { tone = lk_relief(surfaceNormal, elevation, rangeM, panorama); }
  float shade = tone.a;
  vec3 land = lk_hypso(elevation, shade) * tone.rgb;
  vec3 water = mix(LAKE_COLOR, terrain.skyColor, 0.3 * panorama);
  vec3 color = mix(land, water, isLake);
  color = mix(PAPER_COLOR, color, reliefReveal);

  if (contoursOn) {
    color = compositeInk(color, lk_ink(elevation, fwidthElevation, slope, aspect, shade, rangeM, isLake) * inkScale);
  }
  if (screeOn) {
    color = compositeInk(color, lk_scree(localPosition.xy, fwidthPosition, slope, elevation) * inkScale);
  }
  if (rockOn) {
    color = compositeInk(color, lk_hachure(localPosition.xy, fwidthPosition, aspect, slope, shade) * inkScale);
  }

  if (panorama > 0.0005) {
    float shadow = 1.0;
    float ambient = 1.0;
    if (terrain.shadowEnabled > 0.5) {
      vec2 field = getFieldValues(localPosition.xy);
      shadow = field.x;
      ambient = field.y;
    }
    float nDotL = dot(surfaceNormal, normalize(terrain.sunDirection));
    // gl_FragCoord is bottom-up, WebGPU's position is top-down: flip to screenY01 = 0 at the top.
    float screenY01 = clamp(1.0 - gl_FragCoord.y / max(terrain.viewportHeight, 1.0), 0.0, 1.0);
    color = lk_grade(color, nDotL, shadow, ambient, terrain.sunColor, terrain.skyColor, panorama, screenY01);
    float eyeHeight = terrain.cameraPosition.z + terrain.originHeight;
    vec3 hazed = lk_atmosphere(color, eyeHeight, elevation, rangeM, toCamera / max(rangeM, 1.0), normalize(terrain.sunDirection), terrain.sunColor, terrain.hazeStrength);
    color = mix(color, hazed, panorama);
  }
  fragColor = vec4(color * layer.opacity, layer.opacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
