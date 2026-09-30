// WebGPU port of deck/world-view.ts WorldGizmoLayer: the photo camera as seen from the world view
// ("In map"): the photo on a plane 150 m in front of the photo camera, the frustum edges and the
// pin at the eye. Colour pass only (never geometry: the gizmo must not occlude the drape's range
// map, as WorldGizmoLayer.filterSubLayer kept it out of the terrain passes), world view only.
//
// WebGL → WebGPU mapping (same inputs, same look as the classic style):
//   BitmapLayer (bounds [bl, tl, tr, br], opacity)   → `plane`: 6 vertices from the corner uniforms,
//        photo sampled from an rgba8unorm-srgb texture (linear), × planeOpacity; writes depth
//        (deck layers write depth by default, so the plane hides the frustum edges behind it).
//   LineLayer (1 px, widthUnits 'pixels', no AA)      → `edges`: 8 segments × 6 vertices,
//        screen-space quads `lineWidthPx` CSS px wide (× pixelRatio device px), the segment
//        clipped to the near plane first; depth test only.
//   ScatterplotLayer (billboard, radius px = pinR · fy · H/2 / distance, antialiasing)
//        → `pin`: a billboard disc at the eye with deck's smoothedge (±0.5 CSS px) edge; writes
//        depth where it covers.
//   LogDepthExtension (gl_FragDepth = log2(w)·FC)    → reversed-Z (depth.ts): clip.z = near,
//        clip.w = view depth, compare greater-equal. The billboard / line offsets keep z and w,
//        so their depth is the anchor's depth, as with the log-depth vertex w.
// Colours: style.world.frame via style/deck-apply.ts deckWorldStyle (0..255 sRGB RGBA), decoded
// to linear here; output is linear premultiplied (targets.ts), the compositor encodes sRGB.
//
// Wiring (assembler / engine port):
//   const gizmo = createGizmoCore(host.device);              // once, add to host.cores
//   gizmo.setProps({pose, eye, aspect, image: photoImgOrTexture,
//                   view: "world", planeOpacity: world.photoPlaneOpacity,
//                   ...deckWorldStyle(style)})                // each world frame / style change
//   gizmo.setProps({view: "photo"})                          // leaving the world view
// `lineColor`, `pinColor`, `pinRadiusM`, `planeOpacity` are exactly DeckWorldStyle's fields, so
// spreading deckWorldStyle(style) works (its extra `sky` is ignored). The host must be asked to
// re-render (requestRender("all")) after setProps: the gizmo lives in the colour pass.
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { ShaderModule } from "@luma.gl/shadertools";
import { type Pose, poseBasis } from "#/lib/camera";
import { cameraModule } from "../camera";
import {
	type GpuLayerCore,
	ModelCache,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { imageTexture } from "../textures";

type V3 = [number, number, number];
type RGBA255 = [number, number, number, number];
type ImageLike =
	| ImageBitmap
	| HTMLImageElement
	| HTMLCanvasElement
	| OffscreenCanvas;

export type GizmoProps = {
	/** Which view the colour pass renders; the gizmo draws only in "world" (default "photo"). */
	view: "photo" | "world";
	/** Photo camera pose (yaw / pitch / roll / vfov, degrees). */
	pose: Pose | null;
	/** Photo camera eye, ENU metres (the pin). */
	eye: V3 | null;
	/** Photo aspect (width / height): the plane's shape. */
	aspect: number;
	/** The photo: an image (uploaded here, sRGB + mips) or a luma Texture owned by the caller
	 * (must be rgba8unorm-srgb or another format that samples LINEAR). null: no plane. */
	image: ImageLike | Texture | null;
	/** Photo plane opacity (three: 0.95, fading during the flight). The gizmo hides at ≤ 0.02
	 * (deck/engine.ts worldLayers: "the frustum is hidden once the plane has faded"). */
	planeOpacity: number;
	/** Frustum edges, 0..255 sRGB RGBA (style.world.frame lineColor × lineOpacity). */
	lineColor: RGBA255;
	/** Pin colour, 0..255 sRGB RGBA, and radius in metres (style.world.frame). */
	pinColor: RGBA255;
	pinRadiusM: number;
	/** Edge width in CSS pixels (WebGL: LineLayer getWidth 1, widthUnits 'pixels'). */
	lineWidthPx: number;
	/** Device pixels per CSS pixel of the colour target (default min(devicePixelRatio, 2), the
	 * cap targets.ts applies to the canvas). */
	pixelRatio?: number;
	/** Distance of the photo plane in front of the eye, metres (engine.ts buildFrustum: 150). */
	planeDistance: number;
};

/** WorldGizmoLayer's defaults (world-view.ts renderLayers). */
export const GIZMO_DEFAULTS: GizmoProps = {
	view: "photo",
	pose: null,
	eye: null,
	aspect: 4 / 3,
	image: null,
	planeOpacity: 0.95,
	lineColor: [255, 255, 255, 230],
	pinColor: [255, 85, 51, 255],
	pinRadiusM: 18,
	lineWidthPx: 1,
	planeDistance: 150,
};

/** Draw order in the colour pass: after terrain (0) and trails, before splats / tiles (as the
 * WebGL world layer list: sky, terrain, trails, gizmo, tiles3d, splats). */
export const GIZMO_ORDER = 20;

// ---------- WGSL ----------

const gizmoModule = {
	name: "gizmo",
	source: /* wgsl */ `\
struct GizmoUniforms {
  // xyz: photo eye (ENU m), w: pin radius (m)
  eye: vec4<f32>,
  // plane corners (ENU m): top-left, top-right, bottom-right, bottom-left; w unused
  c0: vec4<f32>,
  c1: vec4<f32>,
  c2: vec4<f32>,
  c3: vec4<f32>,
  // linear rgb, straight alpha
  lineColor: vec4<f32>,
  pinColor: vec4<f32>,
  // x plane opacity, y line width (device px), z device px per CSS px, w unused
  params: vec4<f32>,
};
@group(0) @binding(auto) var<uniform> gizmo: GizmoUniforms;
`,
	uniformTypes: {
		eye: "vec4<f32>",
		c0: "vec4<f32>",
		c1: "vec4<f32>",
		c2: "vec4<f32>",
		c3: "vec4<f32>",
		lineColor: "vec4<f32>",
		pinColor: "vec4<f32>",
		params: "vec4<f32>",
	},
	bindingLayout: [{ name: "gizmo", group: 0 }],
} as const satisfies ShaderModule;

type GizmoUniforms = {
	eye: number[];
	c0: number[];
	c1: number[];
	c2: number[];
	c3: number[];
	lineColor: number[];
	pinColor: number[];
	params: number[];
};

const COMMON_WGSL = /* wgsl */ `\
fn gizmo_corner(i: u32) -> vec3<f32> {
  var c = array<vec3<f32>, 4>(gizmo.c0.xyz, gizmo.c1.xyz, gizmo.c2.xyz, gizmo.c3.xyz);
  return c[i & 3u];
}
// clip-space offset for a pixel offset (device px) at clip position p (keeps z and w: same depth)
fn gizmo_px_to_clip(p: vec4<f32>, px: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(p.xy + px * 2.0 / camera.viewport * p.w, p.z, p.w);
}
// a position the rasteriser clips away (depth > 1)
const GIZMO_CULLED: vec4<f32> = vec4<f32>(0.0, 0.0, 2.0, 1.0);
`;

/** Photo plane: two triangles over the corners, uv v down (row 0 = top of the photo). */
const PLANE_WGSL = /* wgsl */ `\
${COMMON_WGSL}
@group(0) @binding(auto) var photo: texture_2d<f32>;
@group(0) @binding(auto) var photoSampler: sampler;

struct PlaneOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> PlaneOut {
  // tl tr br | tl br bl
  var idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  var uvs = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
  let k = idx[vi];
  var o: PlaneOut;
  o.position = camera_clip(gizmo_corner(k));
  o.uv = uvs[k];
  return o;
}

@fragment fn fragmentMain(v: PlaneOut) -> @location(0) vec4<f32> {
  // rgba8unorm-srgb: the sample is linear; BitmapLayer: alpha = image alpha × opacity
  let c = textureSample(photo, photoSampler, v.uv);
  let a = c.a * gizmo.params.x;
  return vec4<f32>(c.rgb * a, a);
}
`;

/** Frustum edges: 8 segments (eye→tl, tr, br, bl; tl→tr→br→bl→tl), 6 vertices each. */
const EDGES_WGSL = /* wgsl */ `\
${COMMON_WGSL}
@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let seg = vi / 6u;
  let k = vi % 6u;
  var a: vec3<f32>;
  var b: vec3<f32>;
  if (seg < 4u) {
    a = gizmo.eye.xyz;
    b = gizmo_corner(seg);
  } else {
    a = gizmo_corner(seg - 4u);
    b = gizmo_corner(seg - 3u);
  }
  // (end, side) per quad vertex
  var ends = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0);
  var sides = array<f32, 6>(-1.0, 1.0, -1.0, 1.0, 1.0, -1.0);
  var ca = camera_clip(a);
  var cb = camera_clip(b);
  // clip the segment to the near plane (clip.w = view depth ≥ near) before the screen-space
  // extrusion; both ends behind → nothing
  let wmin = camera.near * 1.0001;
  if (ca.w < wmin && cb.w < wmin) { return GIZMO_CULLED; }
  if (ca.w < wmin) { ca = mix(ca, cb, (wmin - ca.w) / (cb.w - ca.w)); }
  if (cb.w < wmin) { cb = mix(cb, ca, (wmin - cb.w) / (ca.w - cb.w)); }
  let hv = camera.viewport * 0.5;
  let d = cb.xy / cb.w * hv - ca.xy / ca.w * hv;
  let len = length(d);
  let dir = select(vec2<f32>(1.0, 0.0), d / len, len > 1e-6);
  let n = vec2<f32>(-dir.y, dir.x);
  let p = select(ca, cb, ends[k] > 0.5);
  return gizmo_px_to_clip(p, n * sides[k] * gizmo.params.y * 0.5);
}

@fragment fn fragmentMain() -> @location(0) vec4<f32> {
  let c = gizmo.lineColor;
  return vec4<f32>(c.rgb * c.a, c.a);
}
`;

/** Pin: a billboard disc at the eye, radius from the camera distance (world-view.ts pxPerM). */
const PIN_WGSL = /* wgsl */ `\
${COMMON_WGSL}
struct PinOut {
  @builtin(position) position: vec4<f32>,
  // device-pixel offset from the centre
  @location(0) px: vec2<f32>,
  @location(1) @interpolate(flat) radius: f32,
};

@vertex fn vertexMain(@builtin(vertex_index) vi: u32) -> PinOut {
  var q = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
                              vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  var o: PinOut;
  let c = camera_clip(gizmo.eye.xyz);
  // deck: radius px = pinR · projectionMatrix[5] · height / 2 / max(1, focalDistance), where
  // focalDistance = |world camera − photo eye|; in device px directly (height = target px)
  let fy = 1.0 / camera.tanHalfY;
  let r = gizmo.eye.w * fy * camera.viewport.y * 0.5 / max(1.0, camera_range(gizmo.eye.xyz));
  // + the smoothedge band (SMOOTH_EDGE_RADIUS 0.5 CSS px)
  let ext = r + 0.5 * gizmo.params.z + 1.0;
  o.px = q[vi] * ext;
  o.radius = r;
  o.position = select(gizmo_px_to_clip(c, o.px), GIZMO_CULLED, c.w < camera.near);
  return o;
}

@fragment fn fragmentMain(v: PinOut) -> @location(0) vec4<f32> {
  // deck smoothedge(dist, outer) = smoothstep(dist − 0.5, dist + 0.5, outer), CSS px
  let e = 0.5 * gizmo.params.z;
  let inside = 1.0 - smoothstep(v.radius - e, v.radius + e, length(v.px));
  if (inside <= 0.0) { discard; }
  let a = gizmo.pinColor.a * inside;
  return vec4<f32>(gizmo.pinColor.rgb * a, a);
}
`;

// ---------- CPU side ----------

const srgbToLinear = (c: number) => {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** 0..255 sRGB RGBA → linear rgb + straight alpha. */
export function linearRGBA(c: readonly number[]): number[] {
	return [
		srgbToLinear(c[0]),
		srgbToLinear(c[1]),
		srgbToLinear(c[2]),
		(c[3] ?? 255) / 255,
	];
}

/**
 * The plane corners (tl, tr, br, bl) as world-view.ts computes them: `dist` metres along the pose
 * forward, half-height tan(vfov/2)·dist, half-width × aspect.
 */
export function gizmoCorners(
	pose: Pose,
	eye: readonly number[],
	aspect: number,
	dist = 150,
): [V3, V3, V3, V3] {
	const { forward, right, up } = poseBasis(pose);
	const hh = Math.tan((pose.vfov * Math.PI) / 360) * dist;
	const hw = hh * aspect;
	const corner = (sx: number, sy: number): V3 => [
		eye[0] + forward[0] * dist + right[0] * sx * hw + up[0] * sy * hh,
		eye[1] + forward[1] * dist + right[1] * sx * hw + up[1] * sy * hh,
		eye[2] + forward[2] * dist + right[2] * sx * hw + up[2] * sy * hh,
	];
	return [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
}

const isTexture = (x: unknown): x is Texture =>
	!!x &&
	typeof x === "object" &&
	"device" in x &&
	"format" in x &&
	typeof (x as { destroy?: unknown }).destroy === "function";

type Part = "plane" | "edges" | "pin";

const PARTS: Record<
	Part,
	{ source: string; vertexCount: number; depth: "write" | "test" }
> = {
	plane: { source: PLANE_WGSL, vertexCount: 6, depth: "write" },
	edges: { source: EDGES_WGSL, vertexCount: 48, depth: "test" },
	pin: { source: PIN_WGSL, vertexCount: 6, depth: "write" },
};

export class GizmoCore implements GpuLayerCore {
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = GIZMO_ORDER;
	readonly props: GizmoProps = { ...GIZMO_DEFAULTS };
	private models = new ModelCache();
	private owned: Texture | null = null;
	private ownedFrom: ImageLike | null = null;

	/**
	 * `device`: the render device. With it, a new `image` is uploaded (with mips) in setProps,
	 * OUTSIDE any render pass: luma's WebGPU mip generation opens a render pass of its own, which
	 * is invalid while the colour pass is open. Without it, draw() uploads without mips.
	 */
	constructor(
		readonly id = "world-gizmo",
		private device: Device | null = null,
	) {}

	setProps(p: Partial<GizmoProps>) {
		Object.assign(this.props, p);
		if (this.device && "image" in p) this.photoTexture(this.device, true);
	}

	/** Draws only in the world view, with a pose, and while the plane has not faded (≤ 0.02). */
	visible() {
		const p = this.props;
		return p.view === "world" && !!p.pose && !!p.eye && p.planeOpacity > 0.02;
	}

	/** Plane corners (tl, tr, br, bl) for the current props, or null. */
	corners() {
		const p = this.props;
		return p.pose && p.eye
			? gizmoCorners(p.pose, p.eye, p.aspect, p.planeDistance)
			: null;
	}

	/** `mips` only outside a render pass (see the constructor). */
	private photoTexture(device: Device, mips: boolean): Texture | null {
		const img = this.props.image;
		if (!img) return null;
		if (isTexture(img)) return img;
		if (this.ownedFrom !== img || !this.owned) {
			this.owned?.destroy();
			// copyExternalImage is a queue operation (fine mid-pass); mip generation is not
			this.owned = imageTexture(device, img, { id: `${this.id}-photo`, mips });
			this.ownedFrom = img;
		}
		return this.owned;
	}

	private model(device: Device, part: Part) {
		const spec = PARTS[part];
		return this.models.get(part, () => {
			return new Model(device, {
				id: `${this.id}-${part}`,
				source: spec.source,
				vertexEntryPoint: "vertexMain",
				fragmentEntryPoint: "fragmentMain",
				modules: [cameraModule, gizmoModule] as never,
				topology: "triangle-list",
				vertexCount: spec.vertexCount,
				bufferLayout: [],
				...passModelProps("color", { depth: spec.depth, blend: true }),
			} as never);
		});
	}

	private uniforms(): GizmoUniforms | null {
		const p = this.props;
		const c = this.corners();
		if (!c || !p.eye) return null;
		const pr =
			p.pixelRatio ??
			Math.min(
				(globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1,
				2,
			);
		return {
			eye: [...p.eye, p.pinRadiusM],
			c0: [...c[0], 0],
			c1: [...c[1], 0],
			c2: [...c[2], 0],
			c3: [...c[3], 0],
			lineColor: linearRGBA(p.lineColor),
			pinColor: linearRGBA(p.pinColor),
			params: [p.planeOpacity, p.lineWidthPx * pr, pr, 0],
		};
	}

	draw(ctx: PassContext) {
		if (ctx.kind !== "color" || !this.visible()) return;
		const u = this.uniforms();
		if (!u) return;
		// the WebGL order: plane (writes depth), edges (over it), pin
		const tex = this.photoTexture(ctx.device, false);
		const parts: Part[] = tex ? ["plane", "edges", "pin"] : ["edges", "pin"];
		for (const part of parts) {
			const m = this.model(ctx.device, part);
			m.shaderInputs.setProps({ camera: ctx.camera, gizmo: u } as never);
			if (part === "plane" && tex) m.setBindings({ photo: tex });
			m.draw(ctx.renderPass);
		}
	}

	destroy() {
		this.models.destroy();
		this.owned?.destroy();
		this.owned = null;
		this.ownedFrom = null;
	}
}

/** Factory for the assembler (see the wiring note at the top of the file). */
export function createGizmoCore(
	device: Device | null,
	props: Partial<GizmoProps> = {},
	id = "world-gizmo",
): GizmoCore {
	const g = new GizmoCore(id, device);
	g.setProps(props);
	return g;
}
