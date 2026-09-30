// Step Inside 3D Tiles for DeckEngine (deck.gl 9.4, CARTESIAN camera-anchored ENU): draws the visible
// meshes of a Tiles3DSet (tiles.ts) — the same THREE tile selector as the three engine, driven by the
// deck world camera (a THREE camera), so both engines show identical tiles.
//   · one luma Model per tile mesh, made on first draw from its THREE geometry (positions / uv / colour
//     converted to float32 once), freed when the tile unloads (Tiles3DSet.onDisposeMesh)
//   · i3dm (instanced trees): the InstancedMesh matrices as four per-instance vec4 attributes
//   · the terrain's LOGARITHMIC gl_FragDepth (deck/terrain-layer.ts LOG_DEPTH_FAR), w scaled by the
//     source's depth bias, depthWrite on, 'less-equal': opaque, so it must come before the splats
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
import type * as THREE from "three";
import { getFlag } from "#/lib/flags";
import {
	LOG_DEPTH_FAR,
	makeTexture,
	maskTexture,
	type PhotoRangeMap,
} from "../deck/terrain-layer";
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

/** THREE BufferAttribute (interleaved / normalised / any type) → a tight Float32Array of `size`. */
function floats(
	attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
	size: number,
) {
	const n = attr.count;
	const out = new Float32Array(n * size);
	const get = [attr.getX, attr.getY, attr.getZ, attr.getW];
	for (let i = 0; i < n; i++)
		for (let k = 0; k < size; k++)
			out[i * size + k] = k < attr.itemSize ? get[k].call(attr, i) : 1;
	return out;
}

function textureOf(
	device: Device,
	map: THREE.Texture | null,
): Texture | undefined {
	const img = map?.image as ImageBitmap | HTMLImageElement | undefined;
	if (!img || !(img.width > 0)) return undefined;
	// the glTF uv origin is top-left, like an uploaded image's first row: no flip
	return makeTexture(device, img, true);
}

type State = {
	meshes: Map<THREE.Mesh, MeshGpu>;
	range?: Texture;
	fg?: Texture;
	empty: Texture;
	onDispose: (m: THREE.Mesh) => void;
};

/** Draw counters (dev probes read window.__tiles3dDeck). */
export const tiles3dDeckStats = { layers: 0, draws: 0, meshes: 0, models: 0 };
if (typeof window !== "undefined")
	(
		window as unknown as { __tiles3dDeck: typeof tiles3dDeckStats }
	).__tiles3dDeck = tiles3dDeckStats;

export class Tiles3DDeckLayer extends Layer<Tiles3DDeckLayerProps> {
	static layerName = "Tiles3DDeckLayer";
	declare state: State;

	initializeState() {
		tiles3dDeckStats.layers++;
		const meshes = new Map<THREE.Mesh, MeshGpu>();
		const onDispose = (m: THREE.Mesh) => {
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
			this.state.range?.destroy();
			const r = props.photoRange;
			this.setState({
				range: r
					? device.createTexture({
							data: r.data,
							width: r.width,
							height: r.height,
							format: "r32float",
							sampler: {
								minFilter: "nearest",
								magFilter: "nearest",
								addressModeU: "clamp-to-edge",
								addressModeV: "clamp-to-edge",
							},
						})
					: undefined,
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
		this.state.range?.destroy();
		this.state.fg?.destroy();
		this.state.empty.destroy();
	}

	private gpuFor(mesh: THREE.Mesh): MeshGpu | null {
		const have = this.state.meshes.get(mesh);
		if (have) return have;
		const geo = mesh.geometry;
		const pos = geo.attributes.position;
		if (!pos?.count) return null;
		const device = this.context.device;
		const n = pos.count;
		const uv = geo.attributes.uv;
		const col = geo.attributes.color;
		const inst = (mesh as THREE.InstancedMesh).isInstancedMesh
			? (mesh as THREE.InstancedMesh)
			: null;
		const attributes: Record<string, { size: number; value: Float32Array }> = {
			positions: { size: 3, value: floats(pos, 3) },
			texCoords: {
				size: 2,
				value: uv ? floats(uv, 2) : new Float32Array(n * 2),
			},
			colors: {
				size: 3,
				value: col ? floats(col, 3) : new Float32Array(n * 3).fill(1),
			},
		};
		const index = geo.index
			? {
					size: 1,
					value:
						geo.index.array instanceof Uint16Array
							? geo.index.array
							: new Uint32Array(geo.index.array),
				}
			: undefined;
		const mat = mesh.material as THREE.ShaderMaterial;
		const map = textureOf(
			device,
			(mat.uniforms?.uMap?.value as THREE.Texture | null) ?? null,
		);
		const model = new Model(device, {
			...this.getShaders({ vs, fs, modules: [project32, tileModule] }),
			id: `${this.props.id}-${mesh.uuid}`,
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
			instanceCount: inst ? inst.count : undefined,
			parameters: PARAMETERS,
		});
		if (inst)
			model.setAttributes({
				instanceMatrix: device.createBuffer({
					data: new Float32Array(inst.instanceMatrix.array),
				}),
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
		const fade = u.uFade.value;
		const clear = u.uClear.value;
		const eye = u.uEye.value;
		const color = (m: THREE.Mesh) => {
			const c = (m.material as THREE.ShaderMaterial).uniforms?.uColor?.value as
				| THREE.Color
				| undefined;
			return c ? [c.r, c.g, c.b, 1] : [0.7, 0.7, 0.7, 1];
		};
		tiles3dDeckStats.draws++;
		tiles3dDeckStats.models = this.state.meshes.size;
		tiles3dDeckStats.meshes = 0;
		for (const { mesh, source } of set.visibleMeshes()) {
			if (p.hideDisplayOnly && source.displayOnly) continue;
			const g = this.gpuFor(mesh);
			if (!g) continue;
			const mu = (mesh.material as THREE.ShaderMaterial).uniforms;
			const props: TileModuleProps = {
				model: Array.from(mesh.matrixWorld.elements),
				photoViewProj: p.photoViewProj,
				color: color(mesh),
				truthColor: [...p.truthColor, 1],
				photoPos: [...p.photoPos, 0],
				eye: [eye.x, eye.y, eye.z, 0],
				cam: [...p.camera, 0],
				fadeClear: [fade.x, fade.y, clear.x, clear.y],
				hasMap: g.map ? 1 : 0,
				depthBias:
					(mu?.uDepthBias?.value as number | undefined) ?? source.depthBias,
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
			if (g.instanced)
				g.model.setInstanceCount((mesh as THREE.InstancedMesh).count);
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
