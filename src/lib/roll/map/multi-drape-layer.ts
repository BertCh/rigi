// Many photos projected onto the terrain at once: the roll map's drape.
//
// terrain-layer.ts drapes ONE photo inside its uber-shader. This layer is drawn over a normal
// TerrainLayer instead: the same tile meshes and vertex path, a log depth that passes 'less-equal'
// on the terrain's own surface (see the note on depth), and a fragment shader that blends the
// photos that can reach the fragment:
//   - photos live in up to four mip-mapped RGBA atlases, their range maps (the shadow map: metres
//     from each photo camera, 0 = sky) in one r32float atlas, people masks in one r8 atlas
//     (./drape-atlas.ts);
//   - a fragment takes photo k if it is inside k's frustum, visible from k (a 2×2 filtered range
//     test, below) and beyond k's min range; photos are weighted by incidence, distance (ground
//     resolution) and a feather at the frame edges, then sharpened so the best photo wins overlaps
//     without ghosting.
//
// Any number of photos, ONE blend. Chunking a big roll into several layers of ≤ 16 photos would
// make the result depend on draw order (a later chunk alpha-blends over a better photo of an
// earlier one). Instead every photo competes in the same loop and the same normalised weighted
// sum, whatever the roll size. What keeps that loop cheap:
//   - per-tile candidate lists, built on the CPU: a photo is listed for a tile only if the tile's
//     box meets the photo's frustum, lies within its reach and is not entirely hidden from it
//     (tested against the photo's range map max-pooled to 8×8 texel blocks). Each tile's block
//     of one shared uniform buffer holds its candidates' parameters inline (view-projection, eye,
//     gain, atlas rects), nearest camera first, so the loop reads uniforms instead of chasing an
//     index into a shared texture;
//   - the drape does not write gl_FragDepth, so hidden fragments are rejected before shading
//     (see the note on depth below);
//   - the TOP_K best weights win: candidates are scored first (the cheap tests, then the range
//     test and mask only if their unoccluded weight could still make the top list — exact
//     pruning), and only the winners' pixels are sampled (the anisotropic reads). With the
//     default sharpness (weights cubed) photos outside the top 4 add a few percent at most.
//
// Clear air + exposure (./drape-clear.ts, ./drape-gains.ts). Raw photo texels carry each photo's own
// haze (far ground veiled toward its airlight) and its own exposure / white balance, so overlaps
// seamed and far ground washed out. Each photo has 4 RGBA32F texels in the `photoParams` texture
// (row = its atlas slot k, kept in slot texel 8): [airlight.rgb, amount], [betaR.rgb, betaM],
// [hR, hM, floor, 0], [exposure.rgb, 0]. A winner's texel is decoded to linear, inverted along ITS
// camera's ray (look/clear-air.ts: J = (I - A)/max(T, floor) + A, T = exp(-∫β ds) from the photo eye
// to the fragment, altitude-aware), multiplied by its exposure gain and re-encoded, all before the
// weighted sum, so overlapping photos agree and the blend carries the ground's own colour. The
// frame is the roll's ENU frame at the roll centre (origin at sea level, curvature + refraction
// baked into z by EnuFrame), the same as the clear-air maths assumes: altitude = z + (x² + y²)·ATM_CURV.
// Candidates are also weighted by sqrt(green T) (photos that see the fragment through less haze win
// overlaps), applied after the exact-pruning bounds, which stay valid since T ≤ 1.
//
// Occlusion ("drape acne"). The range map is point-sampled at 512 px: at every silhouette the
// nearest texel flips between the near ridge and the far ground, and the old one-texel min-dilation
// widened that into a 1–2 texel band behind every hummock where the photo was rejected, so the
// satellite ground (or a worse photo) showed through as thin dark lines across meadows. Now the
// raw range map is used and the TEST is filtered, like PCF shadow mapping: the four nearest texels
// each vote visible/occluded (range test + slope-scaled bias) and the votes are bilinearly
// weighted into a soft visibility that scales the photo's weight. The ridge/background boundary
// lands at the true silhouette ± half a texel and fades over one texel instead of stair-stepping.
import {
	COORDINATE_SYSTEM,
	CompositeLayer,
	Layer,
	type LayerProps,
	project32,
	type UpdateParameters,
} from "@deck.gl/core";
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import { Geometry, Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { LOG_DEPTH_FAR } from "#/lib/deck/terrain-layer";
import { ATM_CURV } from "#/lib/look/atmosphere";
import { COARSE, type DrapeAtlas } from "./drape-atlas";

/**
 * The slope-scaled range bias grows as 1/sin(incidence) down to this (≈ 0.7°). Lakes and meadows
 * seen from a few tens of metres above them sit at 1–3° from the camera; a larger floor (0.03)
 * left them striped with rejected rows.
 */
const MIN_SIN_INC = 0.012;
/** Photos blended per fragment (the best by weight; see the header). */
const TOP_K = 4;
/** Texels per candidate in a tile's row. */
const SLOT_W = 9;
/** Most candidates per tile (nearest kept): bounds the row width and the worst-case loop. */
const MAX_PER_TILE = 48;

export type DrapePhoto = {
	id: string;
	/** Column-major view-projection (photoViewProjection) in the roll frame. */
	viewProj: ArrayLike<number>;
	eye: [number, number, number];
	/** Terrain nearer than this (m) is not draped (GPS error). */
	minRange: number;
	/** Weight multiplier: 1 normal, >1 highlighted, <1 dimmed, 0 hidden. */
	gain: number;
	/** Width / height of the photo. */
	aspect: number;
	/** Vertical FOV (deg), for the range map's angular texel size. */
	vfov: number;
};

const uniformBlock = /* glsl */ `\
layout(std140) uniform drapeUniforms {
  float logDepthFC;
  float opacity;
  float sharpness;
  float falloffM;
  float outline;
  float reachM;
  float people;
  float tileCount;
  float cellM;
  float clear;
} drape;
`;

type DrapeModuleProps = {
	logDepthFC: number;
	opacity: number;
	sharpness: number;
	falloffM: number;
	outline: number;
	reachM: number;
	people: number;
	tileCount: number;
	cellM: number;
	clear: number;
	photoParams: Texture;
	photo0: Texture;
	photo1: Texture;
	photo2: Texture;
	photo3: Texture;
	rangeAtlas: Texture;
	maskAtlas: Texture;
};

const drapeModule = {
	name: "drape",
	vs: uniformBlock,
	fs: uniformBlock,
	uniformTypes: {
		logDepthFC: "f32",
		opacity: "f32",
		sharpness: "f32",
		falloffM: "f32",
		outline: "f32",
		reachM: "f32",
		people: "f32",
		tileCount: "f32",
		cellM: "f32",
		clear: "f32",
	},
} as const satisfies ShaderModule;

/*
 * Depth: the terrain writes an exact per-fragment log depth (gl_FragDepth). Writing it here too
 * would switch off early depth testing, so every drape fragment of every tile, hidden or not,
 * would run the photo loop (at eye level that overdraw is several × the screen). Instead the log
 * depth goes out per vertex. The hardware's screen-linear interpolation of it is never nearer
 * than the exact value (log is concave: Jensen) and at most (ln ρ)²/8 (ln units) farther, for a
 * triangle whose far/near distance ratio is ρ ≤ 1 + size/distance. Each vertex is pulled forward
 * by that gap for its tile's mesh cell size, so the drape always passes on its own surface, while
 * hidden ground (and the tile skirts under it) fails the test before shading: a few centimetres
 * of slack far away, a few metres only right next to the camera (inside the photos' min range).
 */

// the vertex path of terrain-layer.ts, plus the log depth per vertex (above)
const vs = /* glsl */ `#version 300 es
#define SHADER_NAME roll-drape-vs
#define LN2 0.6931471805599453
in vec3 positions;
in vec3 normals;
out vec3 vWorld;
out vec3 vNormal;
out float vLogW;
out vec3 vCamera;
void main() {
  vWorld = positions;
  // cameraPosition is relative to project.coordinateOrigin (0 in the orbit world view, the eye in
  // a photo view)
  vCamera = project.cameraPosition + project.coordinateOrigin;
  vNormal = normals;
  vec4 posCommon;
  gl_Position = project_position_to_clipspace(positions, vec3(0.0), vec3(0.0), posCommon);
  vLogW = 1.0 + max(gl_Position.w, 1e-6);
  // log depth per VERTEX, pulled forward by this triangle size's worst interpolation gap (see
  // the note on depth above)
  float g = log(1.0 + 2.0 * drape.cellM / max(gl_Position.w, 1.0));
  float d = log2(vLogW) * drape.logDepthFC - (g * g / 8.0) * drape.logDepthFC / LN2 - 2e-6;
  gl_Position.z = (2.0 * d - 1.0) * gl_Position.w;
}
`;

const fs = /* glsl */ `#version 300 es
#define SHADER_NAME roll-drape-fs
#define TOP_K ${TOP_K}
#define SLOT_W ${SLOT_W}
#define MAX_PER_TILE ${MAX_PER_TILE}
#define MIN_SIN_INC ${MIN_SIN_INC}
precision highp float;
uniform sampler2D photo0;
uniform sampler2D photo1;
uniform sampler2D photo2;
uniform sampler2D photo3;
uniform highp sampler2D rangeAtlas;
uniform sampler2D maskAtlas;
uniform highp sampler2D photoParams; // 4 texels × photo slot (see the header)
// this tile's candidates, SLOT_W vec4 each (a range of one shared uniform buffer)
layout(std140) uniform tileSlots {
  vec4 slots[MAX_PER_TILE * SLOT_W];
};
in vec3 vWorld;
in vec3 vNormal;
in vec3 vCamera;
out vec4 fragColor;

vec2 photoUv(mat4 M, vec3 p, out float w) {
  vec4 clip = M * vec4(p, 1.0);
  w = clip.w;
  vec2 uv = clip.xy / (abs(clip.w) > 1e-6 ? clip.w : 1e-6) * 0.5 + 0.5;
  return vec2(uv.x, 1.0 - uv.y); // photo + range rows run top → bottom
}

vec4 slot(int i, int c) {
  return slots[i * SLOT_W + c];
}

mat4 slotMatrix(int i) {
  return mat4(slot(i, 0), slot(i, 1), slot(i, 2), slot(i, 3));
}

vec3 photoTexel(int a, vec2 uv, vec2 gx, vec2 gy) {
  if (a == 0) return textureGrad(photo0, uv, gx, gy).rgb;
  if (a == 1) return textureGrad(photo1, uv, gx, gy).rgb;
  if (a == 2) return textureGrad(photo2, uv, gx, gy).rgb;
  return textureGrad(photo3, uv, gx, gy).rgb;
}

vec3 srgbToLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// look/clear-air.ts altitude / optical path (the clr_* macros of its block would need one uniform
// block for all photos; here the values are per photo, from photoParams)
float dcAlt(vec3 p) {
  return p.z + dot(p.xy, p.xy) * ${ATM_CURV.toExponential(9)};
}
float dcPath(float h0, float h1, float L, float H) {
  float x = (h1 - h0) / H;
  float f = abs(x) < 1e-3 ? 1.0 - 0.5 * x : (1.0 - exp(-x)) / x;
  return exp(-h0 / H) * L * f;
}
// per-channel transmittance from the photo eye to p (1 when the photo has no fit: amount 0)
vec3 dcTransmittance(int k, vec3 p, vec3 eye) {
  vec4 a = texelFetch(photoParams, ivec2(0, k), 0);
  if (a.w <= 0.0) return vec3(1.0);
  vec4 b = texelFetch(photoParams, ivec2(1, k), 0);
  vec4 c = texelFetch(photoParams, ivec2(2, k), 0);
  float L = length(p - eye);
  float h0 = dcAlt(eye);
  float h1 = dcAlt(p);
  return exp(-(b.rgb * dcPath(h0, h1, L, c.x) + vec3(b.w * dcPath(h0, h1, L, c.y))));
}
// one winner's photo texel (sRGB) → clear air → exposure → sRGB
vec3 clearAndExpose(vec3 s, vec3 p, vec3 eye, int k) {
  vec4 a = texelFetch(photoParams, ivec2(0, k), 0);
  vec3 g = texelFetch(photoParams, ivec2(3, k), 0).rgb;
  bool fixT = a.w > 0.0;
  bool fixG = any(notEqual(g, vec3(1.0)));
  if (!fixT && !fixG) return s;
  vec3 pc = srgbToLin(s);
  if (fixT) {
    float floorT = texelFetch(photoParams, ivec2(2, k), 0).z;
    vec3 T = dcTransmittance(k, p, eye);
    vec3 J = clamp((pc - a.rgb) / max(T, vec3(floorT)) + a.rgb, 0.0, 1.0);
    pc = mix(pc, J, a.w);
  }
  return linToSrgb(pc * g);
}

// one range texel's vote: visible from the photo camera (range test of terrain-layer.ts + bias)
float seenBy(ivec2 t, float r, float slack) {
  float seen = texelFetch(rangeAtlas, t, 0).r;
  return seen > 0.0 && r < seen * 1.015 + 15.0 + slack ? 1.0 : 0.0;
}

// percentage-closer filtering of the range test over the 2×2 nearest texels of the cell rr
float visibility(vec4 rr, vec2 uv, float r, float slack) {
  vec2 tc = uv * rr.zw - 0.5;
  vec2 f = fract(tc);
  ivec2 b = ivec2(floor(tc));
  ivec2 lo = ivec2(rr.xy);
  ivec2 hi = lo + ivec2(rr.zw) - 1;
  float v00 = seenBy(clamp(lo + b, lo, hi), r, slack);
  float v10 = seenBy(clamp(lo + b + ivec2(1, 0), lo, hi), r, slack);
  float v01 = seenBy(clamp(lo + b + ivec2(0, 1), lo, hi), r, slack);
  float v11 = seenBy(clamp(lo + b + ivec2(1, 1), lo, hi), r, slack);
  return mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y);
}

void main() {
  vec3 n = normalize(vNormal);
  // world-space footprint of this pixel, taken in uniform control flow; each photo's uv
  // gradients are derived from it below (implicit derivatives are undefined inside the loop)
  vec3 dwx = dFdx(vWorld);
  vec3 dwy = dFdy(vWorld);
  vec3 view = normalize(vWorld - vCamera);
  vec2 rangeSize = vec2(textureSize(rangeAtlas, 0));
  int count = int(drape.tileCount);
  // pass 1: score every candidate; keep the TOP_K best (descending)
  float topW[TOP_K];
  int topI[TOP_K];
  for (int j = 0; j < TOP_K; j++) {
    topW[j] = 0.0;
    topI[j] = 0;
  }
  float wmax = 0.0;
  float edge = 0.0;
  for (int i = 0; i < count; i++) {
    vec4 eye = slot(i, 4); // xyz, gain
    vec4 ex = slot(i, 7); // minRange, aspect, range-map rad/px, atlas
    vec3 d = vWorld - eye.xyz;
    float r = length(d);
    if (r < ex.x) continue;
    // beyond the reach a photo shows hazy, low-resolution far country: fade it out
    float reach = 1.0 - smoothstep(0.55 * drape.reachM, drape.reachM, r);
    // exact pruning, first on distance alone: every other factor of the weight is ≤ 1
    if (pow(eye.w * reach / (1.0 + r / drape.falloffM), drape.sharpness) <= topW[TOP_K - 1]) continue;
    float cw;
    vec2 uv = photoUv(slotMatrix(i), vWorld, cw);
    if (cw <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
    float sinInc = -dot(d / r, n);
    float inc = clamp(sinInc * 3.0, 0.0, 1.0);
    // feather the frame edges (in photo height units, so it is even on all four sides)
    vec2 e2 = min(uv, 1.0 - uv) * vec2(ex.y, 1.0);
    float feather = smoothstep(0.0, 0.05, min(e2.x, e2.y));
    // grazing projections smear, unless the viewer looks along the photo's own rays (fly-in)
    float along = smoothstep(0.985, 0.9995, dot(view, d / r));
    float graze = mix(smoothstep(0.08, 0.3, sinInc), 1.0, along);
    // how much this photo could cover the fragment on its own (before occlusion + people)
    float cover = eye.w * feather * reach * graze;
    if (cover <= 0.0) continue;
    float wBase = cover * mix(0.25, 1.0, inc) / (1.0 + r / drape.falloffM);
    // then on the unoccluded weight: visibility and the people mask only lower it, so a candidate
    // that cannot make the top list is dropped before its texture reads
    if (pow(wBase, drape.sharpness) <= topW[TOP_K - 1]) continue;
    vec4 rr = slot(i, 6); // range/mask cell (texels)
    // slope-scaled bias: at grazing incidence one range texel spans r·Δθ/sin(incidence) metres of
    // ground (lakes and meadows seen edge-on would otherwise stripe)
    float slack = 1.5 * r * ex.z / max(sinInc, MIN_SIN_INC);
    float vis = visibility(rr, uv, r, slack);
    if (vis <= 0.0) continue;
    // people in the photo would smear across the ground behind them: soft cut-out
    vec2 muv = (rr.xy + clamp(uv * rr.zw, vec2(0.5), rr.zw - 0.5)) / rangeSize;
    float keep = 1.0 - drape.people * smoothstep(0.25, 0.6, texture(maskAtlas, muv).r);
    float seen = smoothstep(0.0, 0.75, vis) * keep;
    if (seen <= 0.0) continue;
    // prefer the clearer view: sqrt of the green transmittance from this photo's eye (≤ 1, so the
    // pruning bounds above hold)
    float tw = 1.0;
    if (drape.clear > 0.5) tw = sqrt(max(dcTransmittance(int(slot(i, 8).x), vWorld, eye.xyz).g, 0.05));
    float w = pow(wBase * seen * tw, drape.sharpness);
    wmax = max(wmax, cover * seen);
    // a thin frame line where this photo's footprint ends (selection outline)
    if (eye.w > 1.5) edge = max(edge, 1.0 - smoothstep(0.0, 0.006, min(e2.x, e2.y)));
    if (w <= topW[TOP_K - 1]) continue;
    int at = TOP_K - 1;
    for (int q = TOP_K - 1; q > 0; q--) {
      if (topW[q - 1] >= w) break;
      topW[q] = topW[q - 1];
      topI[q] = topI[q - 1];
      at = q - 1;
    }
    topW[at] = w;
    topI[at] = i;
  }
  // pass 2: sample the winners' pixels
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = 0; j < TOP_K; j++) {
    if (topW[j] <= 0.0) break;
    int i = topI[j];
    mat4 M = slotMatrix(i);
    vec4 pr = slot(i, 5); // photo atlas rect (uv)
    float atlas = slot(i, 7).w;
    float cw, cwx, cwy;
    vec2 uv = photoUv(M, vWorld, cw);
    vec2 gx = (photoUv(M, vWorld + dwx, cwx) - uv) * pr.zw;
    vec2 gy = (photoUv(M, vWorld + dwy, cwy) - uv) * pr.zw;
    vec2 auv = pr.xy + clamp(uv, vec2(0.001), vec2(0.999)) * pr.zw;
    vec3 texel = photoTexel(int(atlas), auv, gx, gy);
    if (drape.clear > 0.5) texel = clearAndExpose(texel, vWorld, slot(i, 4).xyz, int(slot(i, 8).x));
    acc += texel * topW[j];
    wsum += topW[j];
  }
  if (wsum <= 0.0) discard;
  vec3 c = acc / wsum;
  if (drape.outline > 0.0) c = mix(c, vec3(1.0, 0.72, 0.45), edge * drape.outline);
  fragColor = vec4(c, drape.opacity * clamp(wmax, 0.0, 1.0));
}
`;

type Textures = Pick<
	DrapeModuleProps,
	| "photo0"
	| "photo1"
	| "photo2"
	| "photo3"
	| "rangeAtlas"
	| "maskAtlas"
	| "photoParams"
>;

/** Bytes of one tile's slot block (the std140 vec4 array). */
const BLOCK_BYTES = MAX_PER_TILE * SLOT_W * 16;

type TileProps = LayerProps & {
	mesh: TileMesh;
	/** This tile's candidate slots: its range of the shared uniform buffer. */
	slots: { buffer: Buffer; offset: number; size: number };
	tileCount: number;
	opacity: number;
	sharpness: number;
	falloffM: number;
	outline: number;
	reachM: number;
	people: number;
	/** 1 = clear air + exposure + clearer-view weighting on (the roll map's `clearAir`). */
	clear: number;
	textures: Textures;
	/** Atlas contents version (redraw when a photo lands). */
	version: number;
	paramsVersion: number;
};

class DrapeTileLayer extends Layer<TileProps> {
	static layerName = "RollDrapeTileLayer";
	declare state: { model?: Model };

	getShaders() {
		return super.getShaders({ vs, fs, modules: [project32, drapeModule] });
	}

	initializeState() {
		this.setState({ model: this.makeModel() });
	}

	private makeModel() {
		const { mesh } = this.props;
		return new Model(this.context.device, {
			...this.getShaders(),
			id: this.props.id,
			geometry: new Geometry({
				topology: "triangle-list",
				// the grid only: the skirts after it (terrain-data.ts buildMesh) hang just under the
				// neighbouring surface, within the depth slack, and would drape as lines on tile seams
				indices: mesh.indices.subarray(0, mesh.seg * mesh.seg * 6),
				attributes: {
					positions: { size: 3, value: mesh.positions },
					normals: { size: 3, value: mesh.normals },
				},
			}),
			bufferLayout: [],
		});
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		if (props.mesh !== oldProps.mesh && oldProps.mesh) {
			this.state.model?.destroy();
			this.setState({ model: this.makeModel() });
		}
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.model?.destroy();
	}

	draw() {
		const { model } = this.state;
		if (!model) return;
		const p = this.props;
		model.shaderInputs.setProps({
			drape: {
				logDepthFC: 1 / Math.log2(LOG_DEPTH_FAR + 1),
				opacity: p.opacity,
				sharpness: p.sharpness,
				falloffM: p.falloffM,
				outline: p.outline,
				reachM: p.reachM,
				people: p.people,
				tileCount: p.tileCount,
				cellM: cellSize(p.mesh),
				clear: p.clear,
				...p.textures,
			} satisfies DrapeModuleProps,
		});
		model.setBindings({ tileSlots: p.slots });
		model.draw(this.context.renderPass);
	}
}

export type MultiDrapeLayerProps = LayerProps & {
	tiles: TileMesh[];
	/** The atlases (./drape-atlas.ts); photos without a range map or pixels yet are left out. */
	atlas: DrapeAtlas | null;
	/** Bump when the atlas contents change (DrapeAtlas.version). */
	atlasVersion?: number;
	/** Per-photo projection state (matched to the atlas by id). */
	photos: DrapePhoto[];
	/** 0..1 overall drape opacity. */
	opacity?: number;
	/** Exponent on the per-photo weights: 1 = soft blend, higher = best photo wins. */
	sharpness?: number;
	/** Distance (m) at which a photo's weight halves (prefers the nearer camera). */
	falloffM?: number;
	/** Outline the footprint of highlighted (gain > 1.5) photos. */
	outline?: number;
	/** Terrain further than this from a photo's camera (m) fades out of its drape. */
	reachM?: number;
	/** 0..1: how strongly people masks cut photos out of the drape. */
	people?: number;
	/**
	 * Per-photo clear air + exposure (DrapeClear.texture: 4 RGBA32F texels × atlas slot, see the
	 * header). Null = never fitted: the raw photos are blended.
	 */
	photoParams?: Texture | null;
	/** Bump when photoParams' contents change (DrapeClear.version). */
	paramsVersion?: number;
	/** Apply photoParams (default true when photoParams is set). */
	clearAir?: boolean;
};

type State = {
	slotBuffer?: Buffer;
	/** Per tile id: [block index in slotBuffer, candidate count]. */
	tileRows: Map<string, [number, number]>;
	/** DrapeAtlas.readyVersion the rows were built for. */
	readyVersion: number;
	/** Stand-in photoParams (all photos unfitted) when the host gives none. */
	blank?: Texture;
};

export class MultiDrapeLayer extends CompositeLayer<MultiDrapeLayerProps> {
	static layerName = "RollMultiDrapeLayer";
	declare state: State;

	initializeState() {
		this.setState({ tileRows: new Map(), readyVersion: -1 });
	}

	updateState({ props, oldProps }: UpdateParameters<this>) {
		const a = props.atlas;
		const stale =
			props.atlas !== oldProps.atlas ||
			(a?.readyVersion ?? -1) !== this.state.readyVersion ||
			props.photos !== oldProps.photos ||
			props.tiles !== oldProps.tiles ||
			props.reachM !== oldProps.reachM;
		if (!stale) return;
		this.state.slotBuffer?.destroy();
		const built = a
			? buildTileSlots(
					this.context.device,
					props.tiles,
					a,
					props.photos,
					props.reachM ?? 8000,
				)
			: null;
		this.setState({
			slotBuffer: built?.buffer,
			tileRows: built?.rows ?? new Map(),
			readyVersion: a?.readyVersion ?? -1,
		});
	}

	finalizeState(context: Parameters<Layer["finalizeState"]>[0]) {
		super.finalizeState(context);
		this.state.slotBuffer?.destroy();
		this.state.blank?.destroy();
	}

	/** Canvas only: never in the offscreen terrain passes (it would pollute the range maps). */
	filterSubLayer({ renderPass }: { renderPass: string }) {
		return !renderPass.startsWith("terrain-");
	}

	renderLayers() {
		const { slotBuffer, tileRows } = this.state;
		const a = this.props.atlas;
		if (!a || !slotBuffer) return [];
		const p = this.props;
		const ph = (i: number) => a.photo[Math.min(i, a.photo.length - 1)];
		if (!p.photoParams && !this.state.blank) {
			// amount 0 / exposure 1 for every photo: a 4 × 1 texture, clamped rows
			const t = new Float32Array(16);
			t.set([1, 1, 1, 1], 12);
			this.state.blank = this.context.device.createTexture({
				width: 4,
				height: 1,
				format: "rgba32float",
				data: t,
				sampler: { minFilter: "nearest", magFilter: "nearest" },
			});
		}
		const params = p.photoParams ?? (this.state.blank as Texture);
		const textures: Textures = {
			photo0: ph(0),
			photo1: ph(1),
			photo2: ph(2),
			photo3: ph(3),
			rangeAtlas: a.range,
			maskAtlas: a.mask,
			photoParams: params,
		};
		const out: DrapeTileLayer[] = [];
		for (const mesh of p.tiles) {
			const l = tileRows.get(mesh.id);
			if (!l) continue;
			out.push(
				new DrapeTileLayer({
					...this.getSubLayerProps({ id: mesh.id }),
					coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
					pickable: false,
					parameters: {
						cullMode: "none",
						depthWriteEnabled: false,
						depthCompare: "less-equal",
						blend: true,
						blendColorSrcFactor: "src-alpha",
						blendColorDstFactor: "one-minus-src-alpha",
						blendAlphaSrcFactor: "one",
						blendAlphaDstFactor: "one-minus-src-alpha",
					},
					mesh,
					slots: {
						buffer: slotBuffer,
						offset: l[0] * BLOCK_BYTES,
						size: BLOCK_BYTES,
					},
					tileCount: l[1],
					opacity: p.opacity ?? 1,
					sharpness: p.sharpness ?? 3,
					falloffM: p.falloffM ?? 2500,
					outline: p.outline ?? 1,
					reachM: p.reachM ?? 8000,
					people: p.people ?? 1,
					clear: p.clearAir !== false && p.photoParams ? 1 : 0,
					textures,
					version: p.atlasVersion ?? 0,
					paramsVersion: p.paramsVersion ?? 0,
				}),
			);
		}
		return out;
	}
}

/** A tile mesh's grid spacing (m): its size over its segments. */
function cellSize(m: TileMesh) {
	const b = meshBox(m);
	return Math.max(b[3] - b[0], b[4] - b[1]) / Math.max(1, m.seg);
}

/** World-space bounding box of a tile mesh (cached: meshes are immutable). */
const boxes = new WeakMap<TileMesh, Float64Array>();
function meshBox(m: TileMesh) {
	let b = boxes.get(m);
	if (!b) {
		b = new Float64Array([
			Infinity,
			Infinity,
			Infinity,
			-Infinity,
			-Infinity,
			-Infinity,
		]);
		const p = m.positions;
		for (let i = 0; i < p.length; i += 3)
			for (let j = 0; j < 3; j++) {
				if (p[i + j] < b[j]) b[j] = p[i + j];
				if (p[i + j] > b[j + 3]) b[j + 3] = p[i + j];
			}
		boxes.set(m, b);
	}
	return b;
}

/** One photo's slot (SLOT_W texels) in the shader's layout. */
function slotData(atlas: DrapeAtlas, k: number, p: DrapePhoto) {
	const c = atlas.cells[k];
	const out = new Float32Array(SLOT_W * 4);
	for (let i = 0; i < 16; i++) out[i] = p.viewProj[i];
	out.set([...p.eye, p.gain], 16);
	out.set(c.photo, 20);
	out.set(c.range, 24);
	out.set(
		[p.minRange, p.aspect, (p.vfov * Math.PI) / 180 / c.range[3], c.atlas],
		28,
	);
	// atlas slot = row of this photo's photoParams texels
	out[32] = k;
	return out;
}

/**
 * Could photo k see any of box b? False only when certain: the box is entirely outside one side
 * plane of the frustum (homogeneous clip space: valid for corners behind the camera too), beyond
 * the reach, or behind the terrain the photo sees (its coarse range map over the box's projected
 * rect, one block of margin for the 2×2 filter, against the shader's largest bias).
 */
function reaches(
	b: Float64Array,
	p: DrapePhoto,
	atlas: DrapeAtlas,
	k: number,
	reachM: number,
	radPerPx: number,
) {
	let d2 = 0;
	for (let j = 0; j < 3; j++) {
		const v = Math.max(b[j] - p.eye[j], 0, p.eye[j] - b[j + 3]);
		d2 += v * v;
	}
	if (d2 > reachM * reachM) return false;
	const M = p.viewProj;
	// outcodes: a bit stays set while every corner so far is outside that plane
	let all = 0b11111;
	let u0 = Infinity;
	let u1 = -Infinity;
	let v0 = Infinity;
	let v1 = -Infinity;
	let behind = false;
	for (let q = 0; q < 8; q++) {
		const x0 = q & 1 ? b[3] : b[0];
		const y0 = q & 2 ? b[4] : b[1];
		const z0 = q & 4 ? b[5] : b[2];
		const x = M[0] * x0 + M[4] * y0 + M[8] * z0 + M[12];
		const y = M[1] * x0 + M[5] * y0 + M[9] * z0 + M[13];
		const w = M[3] * x0 + M[7] * y0 + M[11] * z0 + M[15];
		let code = 0;
		if (x > w) code |= 1;
		if (x < -w) code |= 2;
		if (y > w) code |= 4;
		if (y < -w) code |= 8;
		if (w <= 0) code |= 16;
		all &= code;
		if (w <= 0) behind = true;
		else {
			const u = (x / w) * 0.5 + 0.5;
			const v = 0.5 - (y / w) * 0.5;
			u0 = Math.min(u0, u);
			u1 = Math.max(u1, u);
			v0 = Math.min(v0, v);
			v1 = Math.max(v1, v);
		}
	}
	if (all) return false;
	const cr = atlas.coarse[k];
	if (behind || !cr) return true;
	const [, , rw, rh] = atlas.cells[k].range;
	const bx0 = Math.max(0, Math.floor((Math.max(0, u0) * rw) / COARSE) - 1);
	const bx1 = Math.min(
		cr.width - 1,
		Math.floor((Math.min(1, u1) * rw) / COARSE) + 1,
	);
	const by0 = Math.max(0, Math.floor((Math.max(0, v0) * rh) / COARSE) - 1);
	const by1 = Math.min(
		cr.height - 1,
		Math.floor((Math.min(1, v1) * rh) / COARSE) + 1,
	);
	let far = 0;
	for (let y = by0; y <= by1; y++)
		for (let x = bx0; x <= bx1; x++)
			far = Math.max(far, cr.data[y * cr.width + x]);
	// the shader accepts r < seen·1.015 + 15 + 1.5·r·Δθ/MIN_SIN_INC at most
	return (
		Math.sqrt(d2) * Math.max(0, 1 - (1.5 / MIN_SIN_INC) * radPerPx) <=
		far * 1.015 + 15
	);
}

/**
 * Per tile, its candidate photos' slots (nearest camera first) in one block of a shared uniform
 * buffer. Only ready photos with a gain are listed; tiles no photo reaches get no block (no draw).
 */
function buildTileSlots(
	device: Device,
	tiles: TileMesh[],
	atlas: DrapeAtlas,
	photos: DrapePhoto[],
	reachM: number,
) {
	const byId = new Map(photos.map((p) => [p.id, p]));
	const cams: {
		k: number;
		p: DrapePhoto;
		slot: Float32Array;
		radPerPx: number;
	}[] = [];
	for (const [k, id] of atlas.ids.entries()) {
		const p = byId.get(id);
		if (!p || !atlas.ready[k] || p.gain <= 0) continue;
		cams.push({
			k,
			p,
			slot: slotData(atlas, k, p),
			radPerPx: (p.vfov * Math.PI) / 180 / atlas.cells[k].range[3],
		});
	}
	const rows = new Map<string, [number, number]>();
	const lists: Float32Array[][] = [];
	for (const t of tiles) {
		const b = meshBox(t);
		const list: [Float32Array, number][] = [];
		for (const c of cams) {
			if (!reaches(b, c.p, atlas, c.k, reachM, c.radPerPx)) continue;
			const e = c.p.eye;
			const cx = (b[0] + b[3]) / 2 - e[0];
			const cy = (b[1] + b[4]) / 2 - e[1];
			list.push([c.slot, cx * cx + cy * cy]);
		}
		if (!list.length) continue;
		// nearest cameras first: they usually weigh most, so the shader's pruning bites early
		list.sort((x, y) => x[1] - y[1]);
		const kept = list.slice(0, MAX_PER_TILE).map((e) => e[0]);
		rows.set(t.id, [lists.length, kept.length]);
		lists.push(kept);
	}
	const data = new Float32Array((Math.max(1, lists.length) * BLOCK_BYTES) / 4);
	for (const [r, l] of lists.entries())
		for (const [i, s] of l.entries())
			data.set(s, (r * BLOCK_BYTES) / 4 + i * SLOT_W * 4);
	const buffer = device.createBuffer({
		usage: Buffer.UNIFORM | Buffer.COPY_DST,
		data,
	});
	return { buffer, rows };
}
