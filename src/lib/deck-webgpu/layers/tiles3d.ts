// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside 3D Tiles on WebGPU: the port of tiles3d/deck-layer.ts Tiles3DDeckLayer (itself the deck
// twin of tiles3d/material.ts) to a host-agnostic GpuLayerCore (README.md "Layer contract"). It draws
// the visible meshes of a Tiles3DSet (tiles3d/tiles.ts, the same loaders.gl tile selector the WebGL
// engines use), so every renderer shows identical tiles.
//
// What is the same as the WebGL layer (the reference look):
//   - each TileMesh (tiles3d/content.ts: plain typed arrays) is uploaded ONCE, on first draw (positions,
//     uv, vertex colour; interleaved here), and freed when the tile unloads (Tiles3DSet.onDisposeMesh)
//   - i3dm (instanced trees): the instance matrices as four per-instance vec4 attributes
//     (stepMode "instance")
//   - material.ts's rules: the fill test against the photo range map + the foreground mask, the eye
//     clear zone (uClear around uEye) and the camera clear zone (5 → 10 m around the view camera), the
//     radius fade (uFade), dithered (the same interleaved-gradient dither, gl_FragCoord y-up
//     reproduced), derivative shading for untextured meshes, the Truth tint, the refraction lift
//   - colour maths in sRGB like the deck layer (texture bytes raw = rgba8unorm, flat colour × vertex
//     colour shaded in sRGB, Truth mixed in sRGB); the result is srgb_decode()d at the end because the
//     colour target is linear (the compositor's encode restores the deck layer's bytes). No fog:
//     the deck layer had none (tiles live within 3 km).
//   - opaque, depth written, drawn before the splats; cullMode none (glTF DoubleSide)
//   - tile textures: rgba8unorm, mipmapped, anisotropic 8. luma's generateMipmapsWebGPU submits on
//     its own, which is illegal while a render pass is open (and draw() is always inside one), so a
//     new tile first draws with a single-level copy and the mipmapped texture is built in a later
//     task (flushMips) and swapped in; onChange then asks for a redraw.
//
// What changed with the foundation:
//   - depth: the GLSL wrote gl_FragDepth = log2(1 + w·bias)·FC. In reversed-Z (depth.ts, depth =
//     near / viewDepth) "w scaled by bias" is clip.z × (1 / bias): a small multiplicative clip.z
//     factor, no frag_depth write, early-Z stays on.
//   - the fill test: the photo camera is `photoCam` (photoCameraModule) and the range map is the
//     geometry target of this frame (ctx.geometry.geometry, .w = range from the photo eye, 0 = sky,
//     textureLoad, rows top-first like the WebGL PhotoRangeMap) — no CPU rangeMapFrom().
//   - derivatives: dpdx / dpdy are taken first thing in the fragment shader (uniform control flow),
//     the tile texture is sampled there too. WebGPU's y runs down, so the WebGL normal
//     cross(dFdx, dFdy) is cross(dpdx, −dpdy) here (same camera-facing normal, same shading).
//   - pipelines / uniforms: ONE Model per (pass kind, instanced?) shared by every tile, like
//     terrain.ts, instead of one Model per tile. The camera / photoCam / `tiles3d` frame modules are
//     therefore uploaded once per pass (the shared camera UBO), and per-tile values (model matrix,
//     colour, has-texture, depth bias) live in a small per-tile uniform Buffer (`tileData`, 96
//     bytes, explicit layout) that is rewritten only when a value changes and swapped with
//     setBindings per draw. Vertex / index / instance buffers are swapped with setAttributes /
//     setIndexBuffer per draw.
//   - geometry pass (class 3 in normal.w): OFF by default (`geometry: false`) because the WebGL
//     geometry pass never contained tiles and turning it on changes what queries / drape / the fill
//     test see (a tile building then occludes the terrain behind it in the range map, so the drape
//     stops painting the photo there while fill drops the building: a hole). When on, only tiles
//     whose source is NOT display-only are drawn (Google tiles must never be read back), with the
//     eye clear zone and radius fade as a hard cut at keep = 0.5 (no dither, no fill, no camera
//     clear); normals face the photo eye.
//
// Order in the colour pass: 10 — opaque, after the terrain (0), before the sky cores (atm-sky 90,
// photo-sky 91: they fill depth == 0 only) and the splats (95).
//
// Wiring (assembler / engine.ts; deck/engine.ts is the reference):
//   const dt = DeckTiles3D.create(() => host.requestRender());   // tiles3d/deck-tiles.ts driver: set
//                                                                //   lifecycle, refine, attribution
//   const tiles = createTiles3DCore(host.device, tiles3dCoreOptions(tiles3dConfig()));  // host.cores
//   tiles.onChange = () => host.requestRender();         // a mipmapped tile texture landed
//   on enter step:  dt.enter(lat, lon, eyeVec)          on exit: dt.exit()
//   each stepping world frame: dt.update({ position, viewMatrix, projectionMatrix, fovY, aspect }, canvas.width, canvas.height);
//     tiles.setSet(dt.tiles);                             // same object → no-op
//     tiles.setEnabled(step?.view === "step" && !!dt.tiles);
//     tiles.setPhotoCamera(cameraUniforms(photoCamera({pose, eye, width: g.width, height: g.height})));
//     tiles.setPhotoFg(people-or-object byte mask | null);   // the drape mask (0/255, row 0 = top)
//     tiles.setOptions({ truth, hideDisplayOnly: truth || exporting });
//   exports: tiles.setOptions({hideDisplayOnly: true}) around the capture (or dt.withoutDisplayOnly
//     plus a matching setOptions), as deck-tiles.ts does.
//   DeckTiles3D.layer() (the WebGL deck layer) is simply not called on this renderer.
// Diagnostics: tiles.stats (meshes drawn per pass, GPU meshes held, triangles, uploads).
//
// luma 10: Model / Buffer / Texture / ShaderModule only; nothing deck-specific.
import type { Buffer, Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { getFlag } from "#/lib/flags";
import {
	PROVENANCE_COLORS,
	PROVENANCE_TINT_MIX,
} from "#/lib/nearfield/provenance";
import type { Tiles3DConfig } from "#/lib/tiles3d/config";
import type { TileImage, TileMesh } from "#/lib/tiles3d/content";
import { REFRACTION_LIFT } from "#/lib/tiles3d/material";
import type { Tiles3DSet } from "#/lib/tiles3d/tiles";
import {
	type CameraUniforms,
	cameraModule,
	photoCameraModule,
	sphereInView,
} from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { USAGE } from "../targets";
import { generateTextureMipmaps, maskTexture } from "../textures";
import { colorWGSL } from "../wgsl";

/** GPUBufferUsage bits. */
const BUF = {
	INDEX: 0x0010,
	VERTEX: 0x0020,
	UNIFORM: 0x0040,
	COPY_DST: 0x0008,
} as const;

/** Colour-pass order: opaque, before the sky cores (90 / 91) and the splats (95). */
export const TILES3D_ORDER = 10;
/** Geometry-pass class written to normal.w (targets.ts). */
export const TILES3D_CLASS = 3;
/** Interleaved vertex: position (3), uv (2), colour (3) floats. */
const VERTEX_FLOATS = 8;
/** Per-tile uniform block (tileData): mat4 + 2 × vec4 = 24 floats = 96 bytes. */
const TILE_FLOATS = 24;

export type Tiles3DOptions = {
	/** material.ts uFill: tiles only where the photo does not cover the view ("fill" blend). */
	fill: boolean;
	/** The Truth view: tint every tile with the DEM provenance colour. */
	truth: boolean;
	/** Hide display-only (Google) sources: the Truth view and exports. */
	hideDisplayOnly: boolean;
	/** Draw non-display-only tiles into the geometry pass (class 3). Default false (see header). */
	geometry: boolean;
	/** Override the camera clear-zone centre (ENU m); default = the view camera's eye. */
	clearCamera: [number, number, number] | null;
};

export const DEFAULT_TILES3D_OPTIONS: Tiles3DOptions = {
	fill: true,
	truth: false,
	hideDisplayOnly: false,
	geometry: false,
	clearCamera: null,
};

/** Options from the page's 3D Tiles config (tiles3d/config.ts tiles3dConfig()). */
export function tiles3dCoreOptions(
	config: Tiles3DConfig | null,
): Partial<Tiles3DOptions> {
	return config ? { fill: config.blend === "fill" } : {};
}

/** The Truth tint: DEM provenance colour (sRGB 0..1), mix PROVENANCE_TINT_MIX (deck-tiles.ts). */
const TRUTH_COLOR = PROVENANCE_COLORS.dem.map((c) => c / 255) as [
	number,
	number,
	number,
];

/** The per-pass frame block (one upload per pass for all tiles). */
export const tiles3dModule = {
	name: "tiles3d",
	source: /* wgsl */ `\
struct Tiles3DUniforms {
  fadeClear: vec4<f32>,
  truthColor: vec4<f32>,
  fadeEye: vec3<f32>,
  lift: f32,
  clearCam: vec3<f32>,
  fill: f32,
  fgOn: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};
@group(0) @binding(auto) var<uniform> tiles3d: Tiles3DUniforms;
`,
	uniformTypes: {
		fadeClear: "vec4<f32>",
		truthColor: "vec4<f32>",
		fadeEye: "vec3<f32>",
		lift: "f32",
		clearCam: "vec3<f32>",
		fill: "f32",
		fgOn: "f32",
		pad0: "f32",
		pad1: "f32",
		pad2: "f32",
	},
	bindingLayout: [{ name: "tiles3d", group: 0 }],
} as const satisfies ShaderModule;

export type Tiles3DUniformValues = {
	/** (fadeStart, radius, clearStart, clearEnd) metres. */
	fadeClear: [number, number, number, number];
	/** sRGB rgb, a = Truth mix (0 = off). */
	truthColor: [number, number, number, number];
	fadeEye: [number, number, number];
	lift: number;
	clearCam: [number, number, number];
	/** 1 = run the fill test (fill blend AND a photo camera + range map this frame). */
	fill: number;
	fgOn: number;
	pad0: number;
	pad1: number;
	pad2: number;
};

/**
 * The tile program. Colour pass by default; GEOMETRY_PASS for the class-3 geometry contribution.
 * tileData (per tile, explicit layout, 96 bytes):
 *   model   mat4   local → ENU (TileMesh.matrix, column-major)
 *   color   vec4   sRGB albedo (untextured), a = 1 when the tile has a texture
 *   params  vec4   x = 1 / depth bias (reversed-Z clip.z scale), yzw unused
 */
export const tiles3dWGSL = /* wgsl */ `\
${colorWGSL}
struct TileData {
  model: mat4x4<f32>,
  color: vec4<f32>,
  params: vec4<f32>,
};
@group(0) @binding(auto) var<uniform> tileData: TileData;
#ifndef GEOMETRY_PASS
@group(0) @binding(auto) var tileMap: texture_2d<f32>;
@group(0) @binding(auto) var tileMapSampler: sampler;
@group(0) @binding(auto) var tileGeo: texture_2d<f32>;
@group(0) @binding(auto) var tileFg: texture_2d<f32>;
@group(0) @binding(auto) var tileFgSampler: sampler;
#endif

struct VertexIn {
  @location(0) positions: vec3<f32>,
  @location(1) texCoords: vec2<f32>,
  @location(2) colors: vec3<f32>,
#ifdef INSTANCED
  @location(3) instM0: vec4<f32>,
  @location(4) instM1: vec4<f32>,
  @location(5) instM2: vec4<f32>,
  @location(6) instM3: vec4<f32>,
#endif
};

struct Varyings {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) world: vec3<f32>,
};

@vertex fn vertexMain(a: VertexIn) -> Varyings {
#ifdef INSTANCED
  var w = tileData.model * mat4x4<f32>(a.instM0, a.instM1, a.instM2, a.instM3) * vec4<f32>(a.positions, 1.0);
#else
  var w = tileData.model * vec4<f32>(a.positions, 1.0);
#endif
  // geodesy.ts EnuFrame.fromGeo's curvature + refraction lift, as the terrain has it
  w.z += tiles3d.lift * dot(w.xy, w.xy);
  var v: Varyings;
  v.world = w.xyz;
  v.uv = a.texCoords;
  v.color = a.colors;
  var clip = camera_clip(w.xyz);
  // the source's depth bias (w·bias in the log depth): reversed-Z depth = near / (w·bias)
  clip.z *= tileData.params.x;
  v.position = clip;
  return v;
}

fn tile_dither(fc: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(fc, vec2<f32>(0.06711056, 0.00583715))));
}
fn tile_shade(n: vec3<f32>, albedo: vec3<f32>) -> vec3<f32> {
  let L = normalize(vec3<f32>(0.45, 0.35, 0.82));
  return albedo * (0.55 + 0.45 * max(dot(n, L), 0.0));
}
// eye clear zone × radius fade (material.ts), horizontal distance from the Step Inside eye
fn tile_keep(world: vec3<f32>) -> f32 {
  let d = length(world.xy - tiles3d.fadeEye.xy);
  return (1.0 - smoothstep(tiles3d.fadeClear.x, tiles3d.fadeClear.y, d))
    * smoothstep(tiles3d.fadeClear.z, tiles3d.fadeClear.w, d);
}

#ifdef GEOMETRY_PASS
struct GeometryOut {
  @location(0) xyzr: vec4<f32>,
  @location(1) normal: vec4<f32>,
};
@fragment fn fragmentMain(v: Varyings) -> GeometryOut {
  let dx = dpdx(v.world);
  let dy = dpdy(v.world);
  if (tile_keep(v.world) < 0.5) { discard; }
  var n = normalize(cross(dx, -dy));
  // face the (photo) eye: the target's normals are surface normals toward the viewer
  if (dot(n, camera.eye - v.world) < 0.0) { n = -n; }
  var o: GeometryOut;
  o.xyzr = vec4<f32>(v.world, camera_range(v.world));
  o.normal = vec4<f32>(n, ${TILES3D_CLASS.toFixed(1)});
  return o;
}
#else
// fill: 1 where the photo covers this surface (drop the tile); a 0.4% feather at the frame edge
fn tile_covered_by_photo(puv: vec2<f32>, r: f32, seen: f32, masked: bool) -> f32 {
  if (any(puv < vec2<f32>(0.0)) || any(puv > vec2<f32>(1.0))) { return 0.0; }
  let e = min(puv, vec2<f32>(1.0) - puv);
  let edge = smoothstep(0.0, 0.004, min(e.x, e.y));
  // range 0 = sky (the photo shows sky: no tile there either); a surface well behind the
  // photographed one (a disocclusion) keeps the tile
  let occluded = seen > 0.0 && r > seen * 1.08 + 25.0;
  if (occluded || (masked && seen > 0.0)) { return 0.0; }
  return edge;
}

@fragment fn fragmentMain(v: Varyings) -> @location(0) vec4<f32> {
  // uniform control flow: derivatives and the implicit-LOD texture sample come first
  let dx = dpdx(v.world);
  let dy = dpdy(v.world);
  let texel = textureSample(tileMap, tileMapSampler, v.uv);

  // gl_FragCoord (y up) of the WebGL dither: same pattern on the same pixels
  let fc = vec2<f32>(v.position.x, camera.viewport.y - v.position.y);
  let dith = tile_dither(fc);
  var keep = tile_keep(v.world) * smoothstep(5.0, 10.0, length(v.world - tiles3d.clearCam));
  if (tiles3d.fill > 0.5) {
    let p = photo_uv(v.world);
    if (p.z > 0.0) {
      let dims = vec2<i32>(textureDimensions(tileGeo));
      let t = clamp(vec2<i32>(floor(p.xy * vec2<f32>(dims))), vec2<i32>(0), dims - vec2<i32>(1));
      let seen = textureLoad(tileGeo, t, 0).w;
      let masked = tiles3d.fgOn > 0.5 && textureSampleLevel(tileFg, tileFgSampler, p.xy, 0.0).r > 0.5;
      keep *= 1.0 - tile_covered_by_photo(p.xy, photo_range(v.world), seen, masked);
    }
  }
  if (keep <= dith) { discard; }
  var base: vec3<f32>;
  if (tileData.color.a > 0.5) {
    base = texel.rgb;
  } else {
    base = tile_shade(normalize(cross(dx, -dy)), tileData.color.rgb * v.color);
  }
  if (tiles3d.truthColor.a > 0.0) { base = mix(base, tiles3d.truthColor.rgb, tiles3d.truthColor.a); }
#ifdef TILES3D_DEBUG
  let d = length(v.world.xy - tiles3d.fadeEye.xy);
  base = vec3<f32>(tiles3d.fadeClear.y / 4000.0, tiles3d.fadeEye.z / 1000.0, d / 4000.0);
#endif
  // sRGB maths like the deck layer; the colour target is linear, opaque (premultiplied = itself)
  return vec4<f32>(srgb_decode(clamp(base, vec3<f32>(0.0), vec3<f32>(1.0))), 1.0);
}
#endif
`;

type Sphere = [number, number, number, number];

type MeshGpu = {
	vertices: Buffer;
	indices: Buffer;
	indexCount: number;
	instances?: Buffer;
	instanceVersion: number;
	instanceCapacity: number;
	map?: Texture;
	tile: Buffer;
	/** The tileData values last written. */
	tileValues: Float32Array;
	/** Bounding sphere in the mesh's local frame (null → never culled). */
	localSphere: Sphere | null;
};

export type Tiles3DStats = {
	/** GPU copies held (one per tile mesh ever drawn and not yet unloaded). */
	meshes: number;
	/** Meshes drawn in the last pass of each kind. */
	drawn: { geometry: number; color: number };
	/** Triangles (× instances) in the last colour pass. */
	triangles: number;
	/** Meshes uploaded (converted) so far / freed so far. */
	uploads: number;
	frees: number;
	/** tileData rewrites (matrix / colour / bias changes). */
	tileWrites: number;
	/** Single-level tile textures replaced by their mipmapped version. */
	mipSwaps: number;
};

/** `size` floats per vertex of `src` into `out` at `offset` with `stride` (deck-layer.ts attributes,
 * interleaved). */
function interleave(
	src: Float32Array,
	size: number,
	out: Float32Array,
	offset: number,
	stride: number,
) {
	const n = src.length / size;
	for (let i = 0; i < n; i++)
		for (let k = 0; k < size; k++)
			out[i * stride + offset + k] = src[i * size + k];
}

/** Local sphere → ENU through a column-major matrix (radius × the largest axis scale, + 1 m for
 * the refraction lift within the 3 km radius). */
function worldSphere(s: Sphere, m: ArrayLike<number>): Sphere {
	const x = m[0] * s[0] + m[4] * s[1] + m[8] * s[2] + m[12];
	const y = m[1] * s[0] + m[5] * s[1] + m[9] * s[2] + m[13];
	const z = m[2] * s[0] + m[6] * s[1] + m[10] * s[2] + m[14];
	const sx = Math.hypot(m[0], m[1], m[2]);
	const sy = Math.hypot(m[4], m[5], m[6]);
	const sz = Math.hypot(m[8], m[9], m[10]);
	return [x, y, z, s[3] * Math.max(sx, sy, sz) + 1];
}

type Visible = {
	mesh: TileMesh;
	displayOnly: boolean;
	depthBias: number;
};

export class Tiles3DCore implements GpuLayerCore {
	readonly order = TILES3D_ORDER;
	options: Tiles3DOptions = { ...DEFAULT_TILES3D_OPTIONS };
	stats: Tiles3DStats = {
		meshes: 0,
		drawn: { geometry: 0, color: 0 },
		triangles: 0,
		uploads: 0,
		frees: 0,
		tileWrites: 0,
		mipSwaps: 0,
	};
	/** Called when a mipmapped tile texture has been swapped in (hook host.requestRender() here). */
	onChange?: () => void;
	private set: Tiles3DSet | null = null;
	private enabled = true;
	private meshes = new Map<TileMesh, MeshGpu>();
	private models = new ModelCache();
	private photoCam: CameraUniforms | null = null;
	private fg: Texture | null = null;
	private fgSrc: unknown = null;
	private readonly emptyMap: Texture;
	private readonly emptyMask: Texture;
	private readonly noGeometry: Texture;
	/** set.visibleMeshes() once per frame (both passes share it). */
	private visibleCache: { frame: number; list: Visible[] } | null = null;
	private readonly onDispose = (m: TileMesh) => this.free(m);

	constructor(
		readonly device: Device,
		readonly id = "tiles3d",
	) {
		this.emptyMap = device.createTexture({
			id: `${id}-empty-map`,
			format: "rgba8unorm",
			width: 1,
			height: 1,
			usage: USAGE.SAMPLE | USAGE.COPY_DST,
		});
		this.emptyMap.writeData(new Uint8Array([255, 255, 255, 255]) as never, {
			width: 1,
			height: 1,
		});
		this.emptyMask = maskTexture(
			device,
			new Uint8Array(4),
			1,
			1,
			`${id}-empty-fg`,
		);
		// 1×1 range 0 (= sky): the fill test sees nothing when the host has no geometry target
		this.noGeometry = device.createTexture({
			id: `${id}-no-geometry`,
			format: "rgba32float",
			width: 1,
			height: 1,
			usage: USAGE.SAMPLE | USAGE.COPY_DST,
		});
		this.noGeometry.writeData(new Float32Array(4) as never, {
			width: 1,
			height: 1,
			bytesPerRow: 16,
		});
	}

	get passes(): readonly PassKind[] {
		return this.options.geometry ? ["geometry", "color"] : ["color"];
	}

	visible() {
		return this.enabled && !!this.set;
	}

	setEnabled(on: boolean) {
		this.enabled = on;
	}

	setOptions(o: Partial<Tiles3DOptions>) {
		this.options = { ...this.options, ...o };
	}

	/** The tile set to draw (DeckTiles3D.tiles); same object → no-op, null clears. */
	setSet(set: Tiles3DSet | null) {
		if (set === this.set) return;
		this.set?.onDisposeMesh.delete(this.onDispose);
		this.freeAll();
		this.set = set;
		this.visibleCache = null;
		set?.onDisposeMesh.add(this.onDispose);
	}

	/** Photo camera uniforms sized to the geometry target (cameraUniforms(photoCamera(...))).
	 * null → no fill test. */
	setPhotoCamera(u: CameraUniforms | null) {
		this.photoCam = u;
	}

	/** The drape's foreground mask (people / Object pixels; 0/255, row 0 = top); null = none. */
	setPhotoFg(
		mask: {
			width: number;
			height: number;
			data: Uint8Array | Uint8ClampedArray;
		} | null,
	) {
		if (mask === this.fgSrc) return;
		this.fg?.destroy();
		this.fg = null;
		this.fgSrc = mask;
		if (mask?.width && mask.height)
			this.fg = maskTexture(
				this.device,
				mask.data,
				mask.width,
				mask.height,
				`${this.id}-fg`,
			);
	}

	private visibleList(frame: number): Visible[] {
		const set = this.set;
		if (!set) return [];
		if (this.visibleCache?.frame === frame) return this.visibleCache.list;
		const list: Visible[] = [];
		for (const mesh of set.visibleMeshes())
			list.push({
				mesh,
				displayOnly: mesh.source.displayOnly,
				depthBias: mesh.depthBias,
			});
		this.visibleCache = { frame, list };
		return list;
	}

	private model(kind: "geometry" | "color", instanced: boolean) {
		const debug = getFlag("tiles3dDebug") === "on";
		const key = `${kind}|${instanced ? "i" : "m"}|${debug ? "d" : ""}`;
		return this.models.get(key, () => {
			const geometry = kind === "geometry";
			const modules = geometry
				? [cameraModule, tiles3dModule]
				: [cameraModule, photoCameraModule, tiles3dModule];
			return new Model(this.device, {
				id: `${this.id}-${kind}-${instanced ? "i3dm" : "mesh"}`,
				source: tiles3dWGSL,
				vertexEntryPoint: "vertexMain",
				fragmentEntryPoint: "fragmentMain",
				modules: modules as never,
				defines: {
					...(geometry ? { GEOMETRY_PASS: true } : {}),
					...(instanced ? { INSTANCED: true } : {}),
					...(debug && !geometry ? { TILES3D_DEBUG: true } : {}),
				},
				...passModelProps(kind),
				topology: "triangle-list",
				bufferLayout: [
					{
						name: "tileVerts",
						byteStride: VERTEX_FLOATS * 4,
						attributes: [
							{ attribute: "positions", format: "float32x3", byteOffset: 0 },
							{ attribute: "texCoords", format: "float32x2", byteOffset: 12 },
							{ attribute: "colors", format: "float32x3", byteOffset: 20 },
						],
					},
					...(instanced
						? [
								{
									name: "instanceMatrix",
									stepMode: "instance",
									byteStride: 64,
									attributes: [
										{ attribute: "instM0", format: "float32x4", byteOffset: 0 },
										{
											attribute: "instM1",
											format: "float32x4",
											byteOffset: 16,
										},
										{
											attribute: "instM2",
											format: "float32x4",
											byteOffset: 32,
										},
										{
											attribute: "instM3",
											format: "float32x4",
											byteOffset: 48,
										},
									],
								},
							]
						: []),
				],
				isInstanced: true,
				instanceCount: 1,
			} as never);
		});
	}

	/** The GPU copy of a tile mesh (converted once), or null when it has no triangles. */
	private gpuFor(mesh: TileMesh): MeshGpu | null {
		const have = this.meshes.get(mesh);
		if (have) return have;
		const n = mesh.positions.length / 3;
		if (!n) return null;
		const d = this.device;
		const v = new Float32Array(n * VERTEX_FLOATS);
		interleave(mesh.positions, 3, v, 0, VERTEX_FLOATS);
		if (mesh.uvs) interleave(mesh.uvs, 2, v, 3, VERTEX_FLOATS);
		if (mesh.colors) interleave(mesh.colors, 3, v, 5, VERTEX_FLOATS);
		else
			for (let i = 0; i < n; i++)
				v.fill(1, i * VERTEX_FLOATS + 5, i * VERTEX_FLOATS + 8);
		// indices: uint16 kept (padded to a 4-byte multiple), anything else → uint32; none → 0..n-1
		let idx: Uint16Array | Uint32Array;
		let indexCount: number;
		const src = mesh.indices;
		if (src instanceof Uint16Array) {
			indexCount = src.length;
			idx = new Uint16Array(indexCount + (indexCount & 1));
			idx.set(src);
		} else if (src) {
			indexCount = src.length;
			idx = new Uint32Array(src);
		} else {
			indexCount = n;
			idx = new Uint32Array(n);
			for (let i = 0; i < n; i++) idx[i] = i;
		}
		if (!indexCount) return null;
		const map = this.textureOf(mesh.image, mesh.key, false);
		if (map && Math.max(map.width, map.height) > 1) this.queueMips(mesh);
		const tileValues = new Float32Array(TILE_FLOATS);
		const g: MeshGpu = {
			vertices: d.createBuffer({
				id: `${this.id}-${mesh.key}-v`,
				data: v,
				usage: BUF.VERTEX | BUF.COPY_DST,
			}),
			indices: d.createBuffer({
				id: `${this.id}-${mesh.key}-i`,
				data: idx,
				usage: BUF.INDEX | BUF.COPY_DST,
			}),
			indexCount,
			instanceVersion: -1,
			instanceCapacity: 0,
			map,
			tile: d.createBuffer({
				id: `${this.id}-${mesh.key}-u`,
				data: tileValues,
				usage: BUF.UNIFORM | BUF.COPY_DST,
			}),
			tileValues,
			localSphere: mesh.boundingSphere,
		};
		// force the first tileData write (values start all-zero)
		tileValues[15] = Number.NaN;
		if (mesh.instances) this.syncInstances(g, mesh);
		this.meshes.set(mesh, g);
		this.stats.uploads++;
		this.stats.meshes = this.meshes.size;
		return g;
	}

	/** Upload an instanced mesh's matrices (static per tile: once). */
	private syncInstances(g: MeshGpu, mesh: TileMesh) {
		const data = mesh.instances;
		if (!data || g.instances) return;
		g.instances = this.device.createBuffer({
			id: `${this.id}-${mesh.key}-inst`,
			data: new Float32Array(data),
			usage: BUF.VERTEX | BUF.COPY_DST,
		});
		g.instanceCapacity = data.byteLength;
	}

	/**
	 * The tile's glTF texture as raw sRGB bytes (rgba8unorm), like the deck layer's makeTexture: the
	 * glTF uv origin is top-left, like an uploaded image's first row (no flip). `mips`: a full chain
	 * via luma's generateMipmapsWebGPU, which SUBMITS on its own — so never inside a render pass.
	 * draw() therefore makes a single-level texture and queues the mipmapped one (flushMips).
	 */
	private textureOf(
		img: TileImage | null,
		key: string,
		mips: boolean,
	): Texture | undefined {
		if (!img || !(img.width > 0)) return undefined;
		const { width, height } = img;
		const mipLevels = mips
			? Math.floor(Math.log2(Math.max(width, height))) + 1
			: 1;
		try {
			const tex = this.device.createTexture({
				id: `${this.id}-${key}-map${mips ? "" : "-l0"}`,
				format: "rgba8unorm",
				width,
				height,
				mipLevels,
				usage: USAGE.SAMPLE | USAGE.COPY_DST | USAGE.RENDER,
				sampler: {
					minFilter: "linear",
					magFilter: "linear",
					mipmapFilter: "linear",
					addressModeU: "clamp-to-edge",
					addressModeV: "clamp-to-edge",
					maxAnisotropy: mips ? 8 : 1,
				},
			});
			if ("data" in img && ArrayBuffer.isView(img.data))
				tex.writeData(img.data as never, { width, height });
			else tex.copyExternalImage({ image: img as never, width, height });
			if (mipLevels > 1) generateTextureMipmaps(this.device, tex);
			return tex;
		} catch (e) {
			console.warn(`[deck-webgpu tiles3d] texture upload failed: ${String(e)}`);
			return undefined;
		}
	}

	/** Meshes whose single-level texture waits for its mipmapped replacement. */
	private mipQueue = new Set<TileMesh>();
	private mipTimer: ReturnType<typeof setTimeout> | null = null;

	private queueMips(mesh: TileMesh) {
		this.mipQueue.add(mesh);
		// a later task: the frame that is encoding now has been submitted by then
		this.mipTimer ??= setTimeout(() => this.flushMips(), 0);
	}

	/** Swap in the mipmapped textures (outside any pass), then ask for a redraw. */
	flushMips() {
		this.mipTimer = null;
		let swapped = 0;
		for (const mesh of this.mipQueue) {
			const g = this.meshes.get(mesh);
			if (!g) continue;
			const tex = this.textureOf(mesh.image, mesh.key, true);
			if (!tex) continue;
			g.map?.destroy();
			g.map = tex;
			swapped++;
		}
		this.mipQueue.clear();
		this.stats.mipSwaps += swapped;
		if (swapped) this.onChange?.();
	}

	/** Refresh a tile's tileData from its mesh (matrix, colour, texture flag, bias); write on change. */
	private syncTile(g: MeshGpu, vis: Visible) {
		const { mesh } = vis;
		const e = mesh.matrix;
		const c = mesh.color;
		const vals = g.tileValues;
		const next = [
			...Array.from(e),
			c[0],
			c[1],
			c[2],
			g.map ? 1 : 0,
			1 / Math.max(1e-3, vis.depthBias),
			0,
			0,
			0,
		];
		let changed = false;
		for (let i = 0; i < TILE_FLOATS; i++)
			if (vals[i] !== Math.fround(next[i])) {
				changed = true;
				break;
			}
		if (!changed) return;
		vals.set(next);
		g.tile.write(vals);
		this.stats.tileWrites++;
	}

	/** Frame block for this pass (the WebGL layer's per-draw tile3d uniforms that are per frame). */
	frameUniforms(ctx: PassContext): Tiles3DUniformValues {
		const u = this.set?.uniforms;
		const fade = u?.fade;
		const clear = u?.clear;
		const eye = u?.eye;
		const o = this.options;
		const fill =
			ctx.kind === "color" && o.fill && !!this.photoCam && !!ctx.geometry;
		return {
			fadeClear: [
				fade?.[0] ?? 2200,
				fade?.[1] ?? 3000,
				clear?.[0] ?? 25,
				clear?.[1] ?? 40,
			],
			truthColor: [...TRUTH_COLOR, o.truth ? PROVENANCE_TINT_MIX : 0],
			fadeEye: [eye?.[0] ?? 0, eye?.[1] ?? 0, eye?.[2] ?? 0],
			lift: REFRACTION_LIFT,
			clearCam: o.clearCamera ?? [...ctx.camera.eye],
			fill: fill ? 1 : 0,
			fgOn: fill && this.fg ? 1 : 0,
			pad0: 0,
			pad1: 0,
			pad2: 0,
		};
	}

	draw(ctx: PassContext) {
		if (ctx.kind === "screen" || !this.set) return;
		const kind = ctx.kind;
		if (kind === "geometry" && !this.options.geometry) return;
		const list = this.visibleList(ctx.frame.frame);
		const frame = this.frameUniforms(ctx);
		const prepared = new Set<Model>();
		let drawn = 0;
		let tris = 0;
		for (const vis of list) {
			// Google (display-only) never enters the geometry target; hidden for Truth / exports
			if (
				vis.displayOnly &&
				(kind === "geometry" || this.options.hideDisplayOnly)
			)
				continue;
			const g = this.gpuFor(vis.mesh);
			if (!g) continue;
			if (
				g.localSphere &&
				!sphereInView(ctx.camera, worldSphere(g.localSphere, vis.mesh.matrix))
			)
				continue;
			const inst = vis.mesh.instances ? vis.mesh : null;
			if (inst) {
				if (inst.instanceCount <= 0) continue;
				this.syncInstances(g, inst);
			}
			this.syncTile(g, vis);
			const model = this.model(kind, !!inst);
			if (!prepared.has(model)) {
				prepared.add(model);
				model.shaderInputs.setProps({
					camera: ctx.camera,
					tiles3d: frame,
					...(kind === "color"
						? { photoCam: this.photoCam ?? ctx.camera }
						: {}),
				} as never);
			}
			model.setBindings(
				(kind === "color"
					? {
							tileData: g.tile,
							tileMap: g.map ?? this.emptyMap,
							tileGeo: ctx.geometry?.geometry ?? this.noGeometry,
							tileFg: this.fg ?? this.emptyMask,
						}
					: { tileData: g.tile }) as never,
			);
			model.setAttributes(
				(inst
					? { tileVerts: g.vertices, instanceMatrix: g.instances }
					: { tileVerts: g.vertices }) as never,
			);
			model.setIndexBuffer(g.indices);
			model.setIndexCount(g.indexCount);
			model.setInstanceCount(inst ? inst.instanceCount : 1);
			model.draw(ctx.renderPass);
			drawn++;
			tris += (g.indexCount / 3) * (inst ? inst.instanceCount : 1);
		}
		this.stats.drawn[kind] = drawn;
		if (kind === "color") this.stats.triangles = tris;
	}

	private free(mesh: TileMesh) {
		const g = this.meshes.get(mesh);
		if (!g) return;
		g.vertices.destroy();
		g.indices.destroy();
		g.instances?.destroy();
		g.tile.destroy();
		g.map?.destroy();
		this.meshes.delete(mesh);
		this.stats.frees++;
		this.stats.meshes = this.meshes.size;
		this.visibleCache = null;
	}

	private freeAll() {
		this.mipQueue.clear();
		for (const m of [...this.meshes.keys()]) this.free(m);
	}

	destroy() {
		if (this.mipTimer) clearTimeout(this.mipTimer);
		this.mipTimer = null;
		this.setSet(null);
		this.models.destroy();
		this.fg?.destroy();
		this.fg = null;
		this.emptyMap.destroy();
		this.emptyMask.destroy();
		this.noGeometry.destroy();
	}
}

/** Factory for the assembler (see the header for wiring). */
export function createTiles3DCore(
	device: Device,
	opts: Partial<Tiles3DOptions> = {},
	id = "tiles3d",
): Tiles3DCore {
	const core = new Tiles3DCore(device, id);
	core.setOptions(opts);
	return core;
}
