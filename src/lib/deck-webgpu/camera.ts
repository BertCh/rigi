// Shared camera for every WebGPU layer: one uniform block (`camera`, bind group 0) that both the
// photo camera (pose yaw/pitch/roll/vfov at the eye, camera-anchored ENU) and the world orbit
// camera (world-view.ts WorldViewState: eye / forward / up / camFov) fill.
//
// Projection: camera-RELATIVE (vertex = worldENU - eye, done in f32 on the GPU; ENU positions
// within 150 km of the frame origin keep ~1 cm) and reversed infinite-far Z:
//     clip = (fx·(right·r), fy·(up·r), near, forward·r)      →  depth = near / viewDepth
// so depth is 1 at the near plane and → 0 at infinity. With depth32float and a 'greater-equal'
// compare (depth.ts) this resolves 5 m … 150 km (and beyond) without the GLSL log-depth trick.
//
// Conventions (match src/lib/camera + deck/photo-view.ts):
//   - ENU metres, x east, y north, z up; pose basis from camera.poseBasis.
//   - Clip y up; WebGPU framebuffer row 0 is the TOP (image order, unlike WebGL readPixels).
//   - `viewport` is the render target size in pixels (not CSS pixels).
import type { ShaderModule } from "@luma.gl/shadertools";
import { type Pose, poseBasis } from "#/lib/camera";
import { REVERSED_Z } from "./depth";

type V3 = [number, number, number];

/** The generic camera every WebGPU layer is drawn with. */
export type CameraState = {
	/** ENU metres (camera-anchored frame). */
	eye: V3;
	/** Unit view direction (ENU). */
	forward: V3;
	/** Unit up vector (ENU), orthogonal to forward. */
	up: V3;
	/** Vertical field of view, degrees. */
	vfov: number;
	/** Render target size, pixels. */
	width: number;
	height: number;
	/** Near plane, metres (default 1; the world view uses 5, Step Inside 0.3). */
	near?: number;
	/** Principal point offset in NDC (0,0 = centred). For tiled / sub-rect renders. */
	offset?: [number, number];
};

/** The photo camera: pose at `eye` (deck/photo-view.ts PhotoViewport). */
export function photoCamera(p: {
	pose: Pose;
	eye: V3;
	width: number;
	height: number;
	near?: number;
}): CameraState {
	const { forward, up } = poseBasis(p.pose);
	return {
		eye: p.eye,
		forward,
		up,
		vfov: p.pose.vfov,
		width: p.width,
		height: p.height,
		near: p.near,
	};
}

/** The world orbit camera (deck/world-view.ts WorldViewState / WorldCamera.viewState()). */
export function worldCamera(p: {
	eye: V3;
	forward: V3;
	up: V3;
	camFov: number;
	width: number;
	height: number;
	near?: number;
}): CameraState {
	// WorldCamera's up is three's camera.up transformed; re-orthogonalise for safety
	const f = norm(p.forward);
	const r = norm(cross(f, p.up));
	return {
		eye: p.eye,
		forward: f,
		up: cross(r, f),
		vfov: p.camFov,
		width: p.width,
		height: p.height,
		near: p.near ?? 5,
	};
}

export type CameraUniforms = {
	viewProj: number[];
	eye: V3;
	near: number;
	right: V3;
	aspect: number;
	up: V3;
	tanHalfY: number;
	forward: V3;
	tanHalfX: number;
	viewport: [number, number];
	offset: [number, number];
};

/** Uniform values for the `camera` module. */
export function cameraUniforms(c: CameraState): CameraUniforms {
	const near = c.near ?? 1;
	const aspect = c.width / Math.max(1, c.height);
	const f = norm(c.forward);
	const r = norm(cross(f, c.up));
	const u = cross(r, f);
	const tanHalfY = Math.tan((c.vfov * Math.PI) / 360);
	const tanHalfX = tanHalfY * aspect;
	const fy = 1 / tanHalfY;
	const fx = fy / aspect;
	const [ox, oy] = c.offset ?? [0, 0];
	// column-major; clip = M · (world - eye, 1). The offset shifts x/y in NDC: x_c += ox·w_c.
	const viewProj = [
		fx * r[0] + ox * f[0],
		fy * u[0] + oy * f[0],
		0,
		f[0],
		fx * r[1] + ox * f[1],
		fy * u[1] + oy * f[1],
		0,
		f[1],
		fx * r[2] + ox * f[2],
		fy * u[2] + oy * f[2],
		0,
		f[2],
		0,
		0,
		near,
		0,
	];
	return {
		viewProj,
		eye: [...c.eye],
		near,
		right: r,
		aspect,
		up: u,
		tanHalfY,
		forward: f,
		tanHalfX,
		viewport: [c.width, c.height],
		offset: [ox, oy],
	};
}

/**
 * CPU twin of camera_clip + the viewport transform: ENU point → target pixel (x right, y DOWN,
 * row 0 = top) and reversed-Z depth; null behind the camera. Harnesses use it to check shaders.
 */
export function projectToPixel(u: CameraUniforms, p: V3) {
	const d: V3 = [p[0] - u.eye[0], p[1] - u.eye[1], p[2] - u.eye[2]];
	const m = u.viewProj;
	const cx = m[0] * d[0] + m[4] * d[1] + m[8] * d[2];
	const cy = m[1] * d[0] + m[5] * d[1] + m[9] * d[2];
	const w = m[3] * d[0] + m[7] * d[1] + m[11] * d[2];
	if (w <= 0) return null;
	return {
		x: ((cx / w + 1) / 2) * u.viewport[0],
		y: ((1 - cy / w) / 2) * u.viewport[1],
		depth: u.near / w,
		range: Math.hypot(d[0], d[1], d[2]),
	};
}

/**
 * WGSL: the `camera` block and helpers.
 *   camera_clip(enu)        clip position (reversed infinite Z)
 *   camera_range(enu)       metres from the eye
 *   camera_view_depth(enu)  metres along forward
 *   camera_ray(ndc)         unit ENU ray through an NDC point (sky / screen-space passes)
 *   camera_depth_from_view_depth(z)  the depth value a fragment at view depth z gets (for
 *                                    @builtin(frag_depth) writers such as splats)
 */
export const cameraWGSL = /* wgsl */ `\
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  eye: vec3<f32>,
  near: f32,
  right: vec3<f32>,
  aspect: f32,
  up: vec3<f32>,
  tanHalfY: f32,
  forward: vec3<f32>,
  tanHalfX: f32,
  viewport: vec2<f32>,
  offset: vec2<f32>,
};

@group(0) @binding(auto) var<uniform> camera: CameraUniforms;

fn camera_clip(enu: vec3<f32>) -> vec4<f32> {
  return camera.viewProj * vec4<f32>(enu - camera.eye, 1.0);
}

fn camera_range(enu: vec3<f32>) -> f32 {
  return length(enu - camera.eye);
}

fn camera_view_depth(enu: vec3<f32>) -> f32 {
  return dot(enu - camera.eye, camera.forward);
}

fn camera_ray(ndc: vec2<f32>) -> vec3<f32> {
  let p = ndc - camera.offset;
  return normalize(camera.forward + p.x * camera.tanHalfX * camera.right + p.y * camera.tanHalfY * camera.up);
}

fn camera_depth_from_view_depth(z: f32) -> f32 {
  return clamp(camera.near / max(z, 1e-6), 0.0, 1.0);
}
`;

export const cameraModule = {
	name: "camera",
	source: cameraWGSL,
	uniformTypes: {
		viewProj: "mat4x4<f32>",
		eye: "vec3<f32>",
		near: "f32",
		right: "vec3<f32>",
		aspect: "f32",
		up: "vec3<f32>",
		tanHalfY: "f32",
		forward: "vec3<f32>",
		tanHalfX: "f32",
		viewport: "vec2<f32>",
		offset: "vec2<f32>",
	},
	// group 0, slot chosen by luma (@binding(auto)). Since luma #3304 a module may pin a group-0
	// slot >= 100 (< 100 is the application's), but auto keeps the binding registry stable: keep it
	bindingLayout: [{ name: "camera", group: 0 }],
} as const satisfies ShaderModule;

/** Depth a surface at `range` metres straight ahead gets (checks, tests). */
export const depthAtViewDepth = (near: number, viewDepth: number) =>
	Math.min(1, near / viewDepth);

export { REVERSED_Z };

function cross(a: V3 | readonly number[], b: V3 | readonly number[]): V3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

function norm(a: V3 | readonly number[]): V3 {
	const l = Math.hypot(a[0], a[1], a[2]) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Conservative frustum test for a bounding sphere (ENU centre + radius): false only when the
 * sphere is fully outside one of the four side planes or behind the near plane. Infinite far.
 */
export function sphereInView(
	u: CameraUniforms,
	s: readonly [number, number, number, number],
): boolean {
	const d: V3 = [s[0] - u.eye[0], s[1] - u.eye[1], s[2] - u.eye[2]];
	const r = s[3];
	const z = d[0] * u.forward[0] + d[1] * u.forward[1] + d[2] * u.forward[2];
	if (z < u.near - r) return false;
	const x = d[0] * u.right[0] + d[1] * u.right[1] + d[2] * u.right[2];
	const y = d[0] * u.up[0] + d[1] * u.up[1] + d[2] * u.up[2];
	const ox = u.offset[0] * u.tanHalfX;
	const oy = u.offset[1] * u.tanHalfY;
	// side planes through the eye: |x + ox·z| ≤ tanHalfX·z (+ r·√(1 + tan²)); ndc = x/(z·tan) + offset
	const kx = Math.sqrt(1 + u.tanHalfX * u.tanHalfX);
	const ky = Math.sqrt(1 + u.tanHalfY * u.tanHalfY);
	if (Math.abs(x + ox * z) > u.tanHalfX * z + r * kx) return false;
	if (Math.abs(y + oy * z) > u.tanHalfY * z + r * ky) return false;
	return true;
}

/**
 * The photo camera as a SECOND camera block (`photoCam`), for passes drawn with the view camera
 * that also need the photo camera: projective drape, occlusion test against the geometry target,
 * the world-view gizmo. Same struct and uniform values (cameraUniforms(photoCamera(...))), sized
 * to the geometry target so photo_uv() maps straight onto GeometryTargets texels.
 *   photo_clip(enu)   clip position in the photo camera
 *   photo_uv(enu)     (u, v) in 0..1, v DOWN (texture rows); w < 0 behind the photo camera
 *   photo_range(enu)  metres from the photo eye (compare with GeometryTargets.geometry.w)
 */
export const photoCameraModule = {
	name: "photoCam",
	source: /* wgsl */ `\
@group(0) @binding(auto) var<uniform> photoCam: CameraUniforms;

fn photo_clip(enu: vec3<f32>) -> vec4<f32> {
  return photoCam.viewProj * vec4<f32>(enu - photoCam.eye, 1.0);
}
fn photo_uv(enu: vec3<f32>) -> vec3<f32> {
  let c = photo_clip(enu);
  let w = select(c.w, 1e-6, abs(c.w) < 1e-6);
  return vec3<f32>(c.x / w * 0.5 + 0.5, 0.5 - c.y / w * 0.5, c.w);
}
fn photo_range(enu: vec3<f32>) -> f32 {
  return length(enu - photoCam.eye);
}
`,
	dependencies: [cameraModule],
	uniformTypes: cameraModule.uniformTypes,
	bindingLayout: [{ name: "photoCam", group: 0 }],
} as const satisfies ShaderModule;
