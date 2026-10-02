// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside 3D Tiles for DeckEngine (deck.gl 9.4, CARTESIAN camera-anchored ENU): draws the visible
// meshes of a Tiles3DSet (tiles.ts) — the loaders.gl tile selector driven by the world camera, so both
// deck engines show identical tiles.
//   · one luma Model per TileMesh (content.ts: plain typed arrays), made on first draw, freed when the
//     tile unloads (Tiles3DSet.onDisposeMesh)
//   · i3dm (instanced trees): the instance matrices as four per-instance vec4 attributes
//   · the terrain's LOGARITHMIC depth convention (deck/terrain-layer.ts LOG_DEPTH_FAR), written
//     exactly per fragment (gl_FragDepth) with w scaled by the source's depth bias, depthWrite on,
//     'less-equal' (the terrain writes it per vertex, TERRAIN_DEPTH): opaque, so it must come
//     before the splats
//   · material.ts's rules ported: fill test against the photo range map + foreground mask, the eye /
//     camera clear zones, the radius fade, derivative shading for untextured meshes, the Truth tint
// Output is sRGB bytes as-is on the canvas (as DeckSplatLayer's canvas pass).

import {
	COORDINATE_SYSTEM,
	Layer,
	type LayerProps,
	project32,
} from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { getFlag } from "#/lib/flags";
import {
	LOG_DEPTH_FAR,
	makeTexture,
	maskTexture,
	type PhotoRangeMap,
	rangeTexture,
} from "../deck/terrain-layer";
import type { TileImage, TileMesh } from "./content";
import { REFRACTION_LIFT, TILE_GLSL_COMMON } from "./material";
import type { Tiles3DSet } from "./tiles";

export type Tiles3DDeckLayerProps = LayerProps & {
	set: Tiles3DSet;
	/** Tiles3DSet.version (+ anything else that changes the frame): a new value redraws. */
	version: number;
	/** material.ts uFill: 1 = only where the photo does not cover the view. */
	fill: boolean;
	photoViewProj: number[];
	photoPos: [number, number, number];
	photoRange: PhotoRangeMap | null;
	photoFg: { width: number; height: number; data: Uint8Array } | null;
	/** Truth tint mix (0 = off), sRGB 0..1 colour. */
	truth: number;
	truthColor: [number, number, number];
	/** Hide display-only (Google) sources: Truth view and exports. */
	hideDisplayOnly: boolean;
	/** The world camera's position (ENU m): the 5→10 m camera clear zone. */
	camera: [number, number, number];
};

const uniformBlock = /* glsl */ `\
layout(std140) uniform tile3dUniforms {
  mat4 model;
  mat4 photoViewProj;
  vec4 color;
  vec4 truthColor;
  vec4 photoPos;
  vec4 eye;
  vec4 cam;
  vec4 fadeClear;
  float hasMap;
  float depthBias;
  float lift;
  float fill;
  float fgOn;
  float truth;
  float logDepthFC;
  float hasRange;
} tile;
`;

type TileModuleProps = {
	model: number[];
	photoViewProj: number[];
	color: number[];
	truthColor: number[];
	photoPos: number[];
	eye: number[];
	cam: number[];
	fadeClear: number[];
	hasMap: number;
	depthBias: number;
	lift: number;
	fill: number;
	fgOn: number;
	truth: number;
	logDepthFC: number;
	hasRange: number;
	tileMap?: Texture;
	tileRange?: Texture;
	tileFg?: Texture;
};

const tileModule = {
	name: "tile3d",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		model: "mat4x4<f32>",
		photoViewProj: "mat4x4<f32>",
		color: "vec4<f32>",
		truthColor: "vec4<f32>",
		photoPos: "vec4<f32>",
		eye: "vec4<f32>",
		cam: "vec4<f32>",
		fadeClear: "vec4<f32>",
		hasMap: "f32",
		depthBias: "f32",
		lift: "f32",
		fill: "f32",
		fgOn: "f32",
		truth: "f32",
		logDepthFC: "f32",
		hasRange: "f32",
	},
} as const satisfies ShaderModule;

const vs = /* glsl */ `#version 300 es
#define SHADER_NAME tiles3d-vs
precision highp float;
in vec3 positions;
in vec2 texCoords;
in vec3 colors;
#ifdef INSTANCED
in vec4 instM0;
in vec4 instM1;
in vec4 instM2;
in vec4 instM3;
#endif
out vec2 vUv;
out vec3 vColor;
out vec3 vWorld;
out float vLogW;
void main() {
#ifdef INSTANCED
  vec4 w = tile.model * mat4(instM0, instM1, instM2, instM3) * vec4(positions, 1.0);
#else
  vec4 w = tile.model * vec4(positions, 1.0);
#endif
  w.z += tile.lift * dot(w.xy, w.xy);
  vWorld = w.xyz;
  vUv = texCoords;
  vColor = colors;
  vec4 pc;
  gl_Position = project_position_to_clipspace(w.xyz, vec3(0.0), vec3(0.0), pc);
  vLogW = 1.0 + max(gl_Position.w, 1e-6) * tile.depthBias;
}
`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME tiles3d-fs
precision highp float;
uniform sampler2D tileMap;
uniform sampler2D tileRange;
uniform sampler2D tileFg;
in vec2 vUv;
in vec3 vColor;
in vec3 vWorld;
in float vLogW;
out vec4 fragColor;
${TILE_GLSL_COMMON}
void main() {
  float dith = tileDither(gl_FragCoord.xy);
  float d = length(vWorld.xy - tile.eye.xy);
  float keep = (1.0 - smoothstep(tile.fadeClear.x, tile.fadeClear.y, d))
    * smoothstep(tile.fadeClear.z, tile.fadeClear.w, d)
    * smoothstep(5.0, 10.0, length(vWorld - tile.cam.xyz));
  if (tile.fill > 0.5 && tile.hasRange > 0.5) {
    vec4 clip = tile.photoViewProj * vec4(vWorld, 1.0);
    if (clip.w > 0.0) {
      vec2 puv = (clip.xy / clip.w) * 0.5 + 0.5;
      // the range map and the mask run top → bottom (terrain-layer.ts)
      vec2 tuv = vec2(puv.x, 1.0 - puv.y);
      float seen = textureLod(tileRange, tuv, 0.0).r;
      bool masked = tile.fgOn > 0.5 && textureLod(tileFg, tuv, 0.0).r > 0.5;
      keep *= 1.0 - tileCoveredByPhoto(puv, length(vWorld - tile.photoPos.xyz), seen, masked);
    }
  }
  if (keep <= dith) discard;
  vec3 base = tile.hasMap > 0.5 ? texture(tileMap, vUv).rgb : tileShade(vWorld, tile.color.rgb * vColor);
  if (tile.truth > 0.0) base = mix(base, tile.truthColor.rgb, tile.truth);
  fragColor = vec4(base, 1.0);
#ifdef TILES3D_DEBUG
  fragColor = vec4(tile.fadeClear.y / 4000.0, tile.eye.z / 1000.0, d / 4000.0, 1.0);
#endif
  gl_FragDepth = log2(vLogW) * tile.logDepthFC;
}
`;

type MeshGpu = { model: Model; map?: Texture; instanced: boolean };

const PARAMETERS = {
	cullMode: "none",
	depthWriteEnabled: true,
	depthCompare: "less-equal",
	blend: false,
} as const;

function textureOf(
	device: Device,
	image: TileImage | null,
): Texture | undefined {
	if (!image || !(image.width > 0)) return undefined;
	// the glTF uv origin is top-left, like an uploaded image's first row: no flip
	if ("data" in image && ArrayBuffer.isView(image.data)) {
		const tex = device.createTexture({
			data: image.data,
			width: image.width,
			height: image.height,
			format: "rgba8unorm",
			mipLevels: device.getMipLevelCount(image.width, image.height),
			sampler: {
				minFilter: "linear",
				magFilter: "linear",
				mipmapFilter: "linear",
				addressModeU: "clamp-to-edge",
				addressModeV: "clamp-to-edge",
			},
		});
		if (device.type === "webgl") tex.generateMipmapsWebGL();
		return tex;
	}
	return makeTexture(device, image as ImageBitmap | HTMLImageElement, true);
}

type State = {
	meshes: Map<TileMesh, MeshGpu>;
	range?: Texture;
	/** `range` was uploaded here from CPU data (not a caller-owned PhotoRangeMap.texture). */
	rangeOwned?: boolean;
	fg?: Texture;
	empty: Texture;
	onDispose: (m: TileMesh) => void;
};

/** Draw counters (dev probes read window.__tiles3dDeck). */
export const tiles3dDeckStats = { layers: 0, draws: 0, meshes: 0, models: 0 };
if (typeof window !== "undefined") window.__tiles3dDeck = tiles3dDeckStats;

export class Tiles3DDeckLayer extends Layer<Tiles3DDeckLayerProps> {
	static layerName = "Tiles3DDeckLayer";
	declare state: State;

	initializeState() {
		tiles3dDeckStats.layers++;
		const meshes = new Map<TileMesh, MeshGpu>();
		const onDispose = (m: TileMesh) => {
			const g = meshes.get(m);
			if (!g) return;
			g.model.destroy();
			g.map?.destroy();
			meshes.delete(m);
		};
		this.props.set.onDisposeMesh.add(onDispose);
		const empty = this.context.device.createTexture({
			data: new Float32Array([0]),
			width: 1,
			height: 1,
			format: "r32float",
		});
		this.setState({ meshes, onDispose, empty });
	}

	updateState({
		props,
		oldProps,
	}: {
		props: Tiles3DDeckLayerProps;
		oldProps: Partial<Tiles3DDeckLayerProps>;
	}) {
		const device = this.context.device;
		if (props.photoRange !== oldProps.photoRange) {
			if (this.state.rangeOwned) this.state.range?.destroy();
			const r = props.photoRange;
			this.setState({
				range: r ? (r.texture ?? rangeTexture(device, r)) : undefined,
				rangeOwned: !!r?.data,
			});
		}
		if (props.photoFg !== oldProps.photoFg) {
			this.state.fg?.destroy();
			this.setState({
				fg: props.photoFg ? maskTexture(device, props.photoFg) : undefined,
			});
		}
		if (props.set !== oldProps.set && oldProps.set) {
			oldProps.set.onDisposeMesh.delete(this.state.onDispose);
			this.freeAll();
			props.set.onDisposeMesh.add(this.state.onDispose);
		}
	}

	private freeAll() {
		for (const g of this.state.meshes.values()) {
			g.model.destroy();
			g.map?.destroy();
		}
		this.state.meshes.clear();
	}

	finalizeState() {
		this.props.set.onDisposeMesh.delete(this.state.onDispose);
		this.freeAll();
		if (this.state.rangeOwned) this.state.range?.destroy();
		this.state.fg?.destroy();
		this.state.empty.destroy();
	}

	private gpuFor(mesh: TileMesh): MeshGpu | null {
		const have = this.state.meshes.get(mesh);
		if (have) return have;
		const n = mesh.positions.length / 3;
		if (!n) return null;
		const device = this.context.device;
		const inst = mesh.instances;
		const attributes: Record<string, { size: number; value: Float32Array }> = {
			positions: { size: 3, value: mesh.positions },
			texCoords: { size: 2, value: mesh.uvs ?? new Float32Array(n * 2) },
			colors: {
				size: 3,
				value: mesh.colors ?? new Float32Array(n * 3).fill(1),
			},
		};
		const index = mesh.indices ? { size: 1, value: mesh.indices } : undefined;
		const map = textureOf(device, mesh.image);
		const model = new Model(device, {
			...this.getShaders({ vs, fs, modules: [project32, tileModule] }),
			id: `${this.props.id}-${mesh.key}`,
			defines: {
				...(inst ? { INSTANCED: 1 } : {}),
				...(getFlag("tiles3dDebug") === "on" ? { TILES3D_DEBUG: 1 } : {}),
			},
			geometry: new Geometry({
				topology: "triangle-list",
				attributes,
				indices: index as never,
			}),
			bufferLayout: inst
				? [
						{
							name: "instanceMatrix",
							stepMode: "instance",
							byteStride: 64,
							attributes: [
								{ attribute: "instM0", format: "float32x4", byteOffset: 0 },
								{ attribute: "instM1", format: "float32x4", byteOffset: 16 },
								{ attribute: "instM2", format: "float32x4", byteOffset: 32 },
								{ attribute: "instM3", format: "float32x4", byteOffset: 48 },
							],
						},
					]
				: [],
			isInstanced: !!inst,
			instanceCount: inst ? mesh.instanceCount : undefined,
			parameters: PARAMETERS,
		});
		if (inst)
			model.setAttributes({
				instanceMatrix: device.createBuffer({ data: inst }),
			});
		const g: MeshGpu = { model, map, instanced: !!inst };
		this.state.meshes.set(mesh, g);
		return g;
	}

	/** deck sets the project module's uniforms on these (one model per tile mesh). */
	getModels(): Model[] {
		return [...(this.state?.meshes.values() ?? [])].map((g) => g.model);
	}

	draw(opts?: { shaderModuleProps?: Record<string, unknown> }) {
		const p = this.props;
		const set = p.set;
		const u = set.uniforms;
		const fade = u.fade;
		const clear = u.clear;
		const eye = u.eye;
		tiles3dDeckStats.draws++;
		tiles3dDeckStats.models = this.state.meshes.size;
		tiles3dDeckStats.meshes = 0;
		for (const mesh of set.visibleMeshes()) {
			if (p.hideDisplayOnly && mesh.source.displayOnly) continue;
			const g = this.gpuFor(mesh);
			if (!g) continue;
			const props: TileModuleProps = {
				model: Array.from(mesh.matrix),
				photoViewProj: p.photoViewProj,
				color: [...mesh.color, 1],
				truthColor: [...p.truthColor, 1],
				photoPos: [...p.photoPos, 0],
				eye: [eye[0], eye[1], eye[2], 0],
				cam: [...p.camera, 0],
				fadeClear: [fade[0], fade[1], clear[0], clear[1]],
				hasMap: g.map ? 1 : 0,
				depthBias: mesh.depthBias,
				lift: REFRACTION_LIFT,
				fill: p.fill ? 1 : 0,
				fgOn: p.photoFg ? 1 : 0,
				truth: p.truth,
				logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
				hasRange: this.state.range ? 1 : 0,
			};
			// a model made in this draw missed deck's per-layer module props (project: the viewport)
			if (opts?.shaderModuleProps)
				g.model.shaderInputs.setProps(opts.shaderModuleProps as never);
			g.model.shaderInputs.setProps({
				tile3d: {
					...props,
					tileMap: g.map ?? this.state.empty,
					tileRange: this.state.range ?? this.state.empty,
					tileFg: this.state.fg ?? this.state.empty,
				},
			});
			if (g.instanced) g.model.setInstanceCount(mesh.instanceCount);
			g.model.setParameters(PARAMETERS);
			g.model.draw(this.context.renderPass);
			tiles3dDeckStats.meshes++;
		}
	}
}

Tiles3DDeckLayer.defaultProps = {
	coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
	pickable: false,
	parameters: PARAMETERS,
} as never;
