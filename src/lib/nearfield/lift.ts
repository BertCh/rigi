// Depth-lift: one Gaussian per kept depth-grid block (camera frame), and the camera → ENU transform that
// places any camera-frame cloud with the app's solved pose.
//
// Camera frame = OpenCV (x right, y down, z forward). World → camera is R = [right; −up; forward] with the
// app's basis (src/lib/camera poseBasis, tools/research/tm/cache/FORMAT.md "Frames and conventions"), so
// camera → ENU is Rᵀ: columns right, −up, forward (= camera.poseToOpenCV R_cam2enu).
import { type Pose, poseBasis } from "../camera";
import { anchoredRange } from "./anchor";
import { type IntrinsicsNorm, rayFactor } from "./geom";
import {
	type AnchorFit,
	type GaussianCloud,
	type NearFieldDepth,
	PixelClass,
	PROVENANCE_CODE,
	type SplitResult,
} from "./types";

/** RGBA image, row 0 = top (ImageData is one). May differ in resolution from the depth grid. */
export type RGBAImage = {
	width: number;
	height: number;
	data: Uint8ClampedArray | Uint8Array;
};

export type LiftOpts = {
	/** Depth-grid cells per Gaussian along each axis. Default 2. */
	stride?: number;
	/** Classes to keep. Default [Object]. */
	keep?: PixelClass[];
	/** Anchoring applied to the model depth (default scale 1, shift 0 = raw model metres). */
	anchor?: Pick<AnchorFit, "scale" | "shift">;
	/**
	 * Drop blocks on depth discontinuities ("flying pixels"): max |log(z_neighbour / z)| over the 4 stride
	 * neighbours above this. Default 0.1; Infinity keeps everything.
	 */
	edgeLog?: number;
	/** Gaussian std-dev as a fraction of the block's footprint. Default 0.6. */
	footprint?: number;
	/** Alpha 0..255. Default 255. */
	alpha?: number;
	/** Provenance code for every Gaussian. Default observed. */
	provenance?: number;
};

/**
 * Lift the kept cells of `split` to Gaussians in the camera frame. `K` = normalised photo intrinsics
 * (geom.intrinsicsFromPose). Each Gaussian covers a stride×stride block: centre = anchored ray through the
 * block centre, colour = the photo's mean over the block, std-dev = footprint·block size at that depth.
 * With model normals the Gaussian is a disc facing the normal (thin along it), else isotropic.
 */
export function liftToGaussians(
	depth: NearFieldDepth,
	photo: RGBAImage,
	K: IntrinsicsNorm,
	split: SplitResult,
	opts: LiftOpts = {},
): GaussianCloud {
	const st = Math.max(1, Math.round(opts.stride ?? 2));
	const keep = new Set<number>(opts.keep ?? [PixelClass.Object]);
	const anchor = opts.anchor ?? { scale: 1, shift: 0 };
	const edgeLog = opts.edgeLog ?? 0.1;
	const fp = opts.footprint ?? 0.6;
	const alpha = opts.alpha ?? 255;
	const prov = opts.provenance ?? PROVENANCE_CODE.observed;
	const { width: W, height: H } = depth;
	if (split.width !== W || split.height !== H)
		throw new Error("liftToGaussians: split and depth grids differ");

	// anchored z at a cell (NaN when invalid)
	const zAt = (i: number, j: number) => {
		const k = j * W + i;
		const z = depth.depth[k];
		if (!depth.valid[k] || !(z > 0) || !Number.isFinite(z)) return Number.NaN;
		const u = (i + 0.5) / W;
		const v = (j + 0.5) / H;
		const f = rayFactor(K, u, v);
		return anchoredRange(anchor, z * f) / f;
	};

	const pos: number[] = [];
	const scl: number[] = [];
	const rot: number[] = [];
	const col: number[] = [];
	const pw = photo.width;
	const ph = photo.height;
	for (let j0 = 0; j0 < H; j0 += st)
		for (let i0 = 0; i0 < W; i0 += st) {
			const i = Math.min(W - 1, i0 + (st >> 1));
			const j = Math.min(H - 1, j0 + (st >> 1));
			if (!keep.has(split.cls[j * W + i])) continue;
			const z = zAt(i, j);
			if (!(z > 0)) continue;
			if (edgeLog < Number.POSITIVE_INFINITY) {
				let edge = false;
				for (const [di, dj] of [
					[st, 0],
					[-st, 0],
					[0, st],
					[0, -st],
				]) {
					const ii = i + di;
					const jj = j + dj;
					if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
					const zn = zAt(ii, jj);
					if (zn > 0 && Math.abs(Math.log(zn / z)) > edgeLog) {
						edge = true;
						break;
					}
				}
				if (edge) continue;
			}
			// block centre in normalised coords
			const bw = Math.min(st, W - i0);
			const bh = Math.min(st, H - j0);
			const u = (i0 + bw / 2) / W;
			const v = (j0 + bh / 2) / H;
			const x = ((u - K.cx) / K.fx) * z;
			const y = ((v - K.cy) / K.fy) * z;
			pos.push(x, y, z);
			const sx = (fp * (bw / W) * z) / K.fx;
			const sy = (fp * (bh / H) * z) / K.fy;
			const s = 0.5 * (sx + sy);
			const n = depth.normal;
			const k = j * W + i;
			const nx = n ? n[3 * k] : 0;
			const ny = n ? n[3 * k + 1] : 0;
			const nz = n ? n[3 * k + 2] : 0;
			const nl = Math.hypot(nx, ny, nz);
			if (n && nl > 1e-6 && Number.isFinite(nl)) {
				// disc: local z axis → normal; the in-plane scale grows as the surface tilts away from the ray
				// a disc is symmetric about its plane: use the normal's +z hemisphere so the shortest-arc
				// quaternion stays well conditioned (camera-facing normals have z < 0 in OpenCV)
				const sg = nz < 0 ? -1 / nl : 1 / nl;
				const q = quatFromZ(nx * sg, ny * sg, nz * sg);
				const cosT =
					Math.abs(x * nx + y * ny + z * nz) / (nl * Math.hypot(x, y, z));
				const grow = 1 / Math.max(0.25, cosT);
				scl.push(
					s * Math.min(2, Math.sqrt(grow)),
					s * Math.min(2, Math.sqrt(grow)),
					0.15 * s,
				);
				rot.push(q[0], q[1], q[2], q[3]);
			} else {
				scl.push(s, s, s);
				rot.push(1, 0, 0, 0);
			}
			// mean photo colour over the block
			const px0 = Math.floor((i0 / W) * pw);
			const py0 = Math.floor((j0 / H) * ph);
			const px1 = Math.max(px0 + 1, Math.floor(((i0 + bw) / W) * pw));
			const py1 = Math.max(py0 + 1, Math.floor(((j0 + bh) / H) * ph));
			let r = 0;
			let g = 0;
			let b = 0;
			let m = 0;
			for (let py = py0; py < Math.min(py1, ph); py++)
				for (let px = px0; px < Math.min(px1, pw); px++) {
					const o = 4 * (py * pw + px);
					r += photo.data[o];
					g += photo.data[o + 1];
					b += photo.data[o + 2];
					m++;
				}
			m = m || 1;
			col.push(Math.round(r / m), Math.round(g / m), Math.round(b / m), alpha);
		}
	const count = pos.length / 3;
	return {
		count,
		frame: "camera",
		positions: Float32Array.from(pos),
		scales: Float32Array.from(scl),
		rotations: Float32Array.from(rot),
		colors: Uint8Array.from(col),
		provenance: new Uint8Array(count).fill(prov),
	};
}

/** Shortest-arc unit quaternion (w,x,y,z) rotating +z onto the unit vector (x,y,z). */
function quatFromZ(
	x: number,
	y: number,
	z: number,
): [number, number, number, number] {
	if (z < -0.999999) return [0, 1, 0, 0];
	// q = normalise(1 + z, (0,0,1) × n) = (1 + z, −y, x, 0)
	const w = 1 + z;
	const l = Math.hypot(w, y, x);
	return [w / l, -y / l, x / l, 0];
}

/** Camera → ENU rotation for a pose, row-major 3×3: columns right, −up, forward. */
export function camToEnuMatrix(pose: Pose): number[] {
	const { forward: F, right: R, up: U } = poseBasis(pose);
	return [R[0], -U[0], F[0], R[1], -U[1], F[1], R[2], -U[2], F[2]];
}

/** Unit quaternion (w,x,y,z) of a proper rotation matrix (row-major). */
export function quatFromMatrix(m: number[]): [number, number, number, number] {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
	const tr = m00 + m11 + m22;
	let w: number;
	let x: number;
	let y: number;
	let z: number;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s;
		x = (m21 - m12) / s;
		y = (m02 - m20) / s;
		z = (m10 - m01) / s;
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		w = (m21 - m12) / s;
		x = 0.25 * s;
		y = (m01 + m10) / s;
		z = (m02 + m20) / s;
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		w = (m02 - m20) / s;
		x = (m01 + m10) / s;
		y = 0.25 * s;
		z = (m12 + m21) / s;
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		w = (m10 - m01) / s;
		x = (m02 + m20) / s;
		y = (m12 + m21) / s;
		z = 0.25 * s;
	}
	const l = Math.hypot(w, x, y, z);
	return [w / l, x / l, y / l, z / l];
}

/**
 * Place a camera-frame cloud in ENU: p_enu = eye + M·p_cam with M = camToEnuMatrix(pose); rotations
 * q_enu = q_M ⊗ q_cam. `eye` is the camera position in Renderer.frame (Renderer.eye), so the result lives
 * in that frame (its WGS84 origin is Renderer.frame.lat/lon/h; pass it to encodeSplatV1 when exporting).
 * An ENU cloud is returned unchanged. Scales, colours, provenance and source are copied.
 */
export function toEnu(
	cloud: GaussianCloud,
	pose: Pose,
	eye: { x: number; y: number; z: number } | ArrayLike<number>,
): GaussianCloud {
	if (cloud.frame === "enu") return cloud;
	const e =
		"x" in eye
			? [eye.x, eye.y, eye.z]
			: [
					(eye as ArrayLike<number>)[0],
					(eye as ArrayLike<number>)[1],
					(eye as ArrayLike<number>)[2],
				];
	const m = camToEnuMatrix(pose);
	const [qw, qx, qy, qz] = quatFromMatrix(m);
	const n = cloud.count;
	const P = new Float32Array(3 * n);
	const Q = new Float32Array(4 * n);
	const p = cloud.positions;
	const r = cloud.rotations;
	for (let i = 0; i < n; i++) {
		const x = p[3 * i];
		const y = p[3 * i + 1];
		const z = p[3 * i + 2];
		P[3 * i] = e[0] + m[0] * x + m[1] * y + m[2] * z;
		P[3 * i + 1] = e[1] + m[3] * x + m[4] * y + m[5] * z;
		P[3 * i + 2] = e[2] + m[6] * x + m[7] * y + m[8] * z;
		const bw = r[4 * i];
		const bx = r[4 * i + 1];
		const by = r[4 * i + 2];
		const bz = r[4 * i + 3];
		Q[4 * i] = qw * bw - qx * bx - qy * by - qz * bz;
		Q[4 * i + 1] = qw * bx + qx * bw + qy * bz - qz * by;
		Q[4 * i + 2] = qw * by - qx * bz + qy * bw + qz * bx;
		Q[4 * i + 3] = qw * bz + qx * by - qy * bx + qz * bw;
	}
	return {
		count: n,
		frame: "enu",
		positions: P,
		scales: cloud.scales.slice(),
		rotations: Q,
		colors: cloud.colors.slice(),
		provenance: cloud.provenance.slice(),
		...(cloud.source ? { source: cloud.source.slice() } : {}),
	};
}
