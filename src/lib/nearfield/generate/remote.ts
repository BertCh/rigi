// Step Inside P3: request builders for REMOTE DEM-conditioned video generators. NOT EXECUTED anywhere in
// Rigi: there are no API keys, no endpoints and no network calls here. Both models need rented Linux GPUs
// (research_notes/step_inside_models_2026-09.md §3). These functions only package Rigi's true geometry into
// each model's documented input format so a researcher can run it by hand. Flag: `?nearfield=gen-remote`
// (REMOTE_GEN_FLAG); the lab only offers a download of the package.
//
// Everything is in an eye-centred ENU world (x east, y north, z up, metres, origin = the photo eye) and
// OpenCV cameras (x right, y down, z forward). w2c = [R | −R·c] with R rows = [right; −up; forward] of the
// app pose (camera.poseBasis), c = camera centre.
//
// ---- GEN3C (nv-tlabs/GEN3C @ db2ffe12ce, 2026-06-15; code Apache-2.0, weights nvidia/GEN3C-Cosmos-7B under the
//      NVIDIA Open Model License: commercial use allowed; Linux + Ampere/Hopper/Blackwell only) ----
// Entry point that takes an external RGB-D cache: cosmos_predict1/diffusion/inference/gen3c_multiview.py
//   --npz_path <file> --num_video_frames 120·N+1 (121, 241, 361, …; the script asserts (T−1) % 120 == 0) --height 704 --width 1280
//   --trajectory none --camera_rotation no_rotation (our w2cs_all is the path) --guidance 1
//   [--foreground_masking] [--filter_points_threshold 0.05] --checkpoint_dir checkpoints
// NPZ keys (read verbatim from gen3c_multiview.py lines 180–188):
//   images_key_frames (N, 3, H, W) float32 in [−1, 1]      the key RGB frames the 3D cache is built from
//   depth_key_frames  (N, 1, H, W) float32                  z-depth (camera z, metres here)
//   mask_key_frames   (N, 1, H, W) float32 {0, 1}           1 = valid cache point
//   K_key_frames      (N, 3, 3)    float32                  OpenCV intrinsics in pixels of H×W
//   w2cs_key_frames   (N, 4, 4)    float32                  world → camera of each key frame
//   w2cs_all          (T, 4, 4)    float32                  the camera path to generate
//   Ks_all            (T, 3, 3)    float32 (optional)       per-frame intrinsics (else the last key K)
// Rigi's key frame is the PHOTO itself with DEM-true depth (DEM range → z on terrain pixels, anchored model
// depth on near-field object pixels, mask 0 on sky / unknown / letterbox), so GEN3C only fills disocclusions
// on true geometry. Optionally the rendered cache views (cache-render.ts) as further key frames.
//
// ---- LingBot-World v1 base-cam (robbyant/lingbot-world @ a43bec7f80; code + weights Apache-2.0; 160 GB;
//      8-GPU CUDA in the README) ----
//   torchrun --nproc_per_node=8 generate.py --task i2v-A14B --size 480*832 (or 720*1280)
//     --ckpt_dir lingbot-world-base-cam --image <image.jpg> --action_path <dir> --frame_num 161
//     --dit_fsdp --t5_fsdp --ulysses_size 8 --prompt "<text>"
//   <dir>/intrinsics.npy  [num_frames, 4] = [fx, fy, cx, cy]
//   <dir>/poses.npy       [num_frames, 4, 4] "transformation matrix in OpenCV coordinates" (README wording)
// UNVERIFIED (README only): whether poses are camera-to-world (ViPE's convention, which the README says
// produces them; we write c2w) and in which pixel units the intrinsics are (we write pixels of --size).
// LingBot conditions on camera pose ONLY, not geometry: it can invent terrain. Its output would need
// reconstruction + DEM re-anchoring before any use, and is always `generated`.
import { type Pose, poseBasis } from "../../camera";
import { intrinsicsFromPose } from "../geom";
import type { NovelCamera } from "./trajectory";

/** Opt-in flag for building (never sending) remote generator packages. */
export const REMOTE_GEN_FLAG = "gen-remote";

export const GEN3C_SIZE = { width: 1280, height: 704 } as const;
/** Neutral prompt used when the caller gives none (GEN3C needs one; see buildGen3cRequest argv). */
export const GEN3C_DEFAULT_PROMPT =
	"A static real-world mountain landscape photographed in daylight; the camera moves slowly; no people appear or disappear.";

/** A dense row-major float32 array with its shape (what numpy's .npy stores). */
export type NdArray = { shape: number[]; data: Float32Array };

/** OpenCV world→camera 4×4 (row-major) of a pose at `eye` (eye-centred world: pass eye − origin). */
export function w2cOpenCV(pose: Pose, eye: ArrayLike<number>): number[] {
	const { forward: F, right: R, up: U } = poseBasis(pose);
	const rows = [R, [-U[0], -U[1], -U[2]], F];
	const t = rows.map((r) => -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]));
	return [...rows[0], t[0], ...rows[1], t[1], ...rows[2], t[2], 0, 0, 0, 1];
}

/** Inverse of a rigid 4×4 (row-major). */
export function invRigid(m: number[]): number[] {
	const r = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
	const t = [m[3], m[7], m[11]];
	const rt = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
	const ti = [0, 1, 2].map(
		(i) => -(rt[3 * i] * t[0] + rt[3 * i + 1] * t[1] + rt[3 * i + 2] * t[2]),
	);
	return [
		rt[0],
		rt[1],
		rt[2],
		ti[0],
		rt[3],
		rt[4],
		rt[5],
		ti[1],
		rt[6],
		rt[7],
		rt[8],
		ti[2],
		0,
		0,
		0,
		1,
	];
}

/** Pixel intrinsics (3×3 row-major) for a pose rendered at W×H (aspect = W/H of the content). */
export function kPixels(pose: Pose, W: number, H: number): number[] {
	const k = intrinsicsFromPose(pose, W / H);
	return [k.fx * W, 0, k.cx * W, 0, k.fy * H, k.cy * H, 0, 0, 1];
}

/**
 * Camera path for T frames from the photo eye through the novel cameras (piecewise linear in position,
 * yaw/pitch/roll/vfov linear too; the first frame is the photo camera).
 */
export function interpolatePath(
	photo: { pose: Pose; eye: [number, number, number] },
	cams: NovelCamera[],
	T: number,
): { pose: Pose; eye: [number, number, number] }[] {
	const keys = [photo, ...cams.map((c) => ({ pose: c.pose, eye: c.eye }))];
	if (keys.length === 1 || T <= 1)
		return Array.from({ length: T }, () => keys[0]);
	const out: { pose: Pose; eye: [number, number, number] }[] = [];
	const segs = keys.length - 1;
	const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
	const lerpYaw = (a: number, b: number, s: number) => {
		const d = ((((b - a) % 360) + 540) % 360) - 180;
		return (((a + d * s) % 360) + 360) % 360;
	};
	for (let f = 0; f < T; f++) {
		const x = (f / (T - 1)) * segs;
		const i = Math.min(segs - 1, Math.floor(x));
		const s = x - i;
		const A = keys[i];
		const B = keys[i + 1];
		out.push({
			pose: {
				yaw: lerpYaw(A.pose.yaw, B.pose.yaw, s),
				pitch: lerp(A.pose.pitch, B.pose.pitch, s),
				roll: lerp(A.pose.roll, B.pose.roll, s),
				vfov: lerp(A.pose.vfov, B.pose.vfov, s),
			},
			eye: [
				lerp(A.eye[0], B.eye[0], s),
				lerp(A.eye[1], B.eye[1], s),
				lerp(A.eye[2], B.eye[2], s),
			],
		});
	}
	return out;
}

/** One GEN3C key frame at the photo's own size: sRGB RGBA + z-depth (m; ≤ 0 / NaN = invalid). */
export type Gen3cKeyFrame = {
	width: number;
	height: number;
	rgba: ArrayLike<number>;
	zDepth: ArrayLike<number>;
	pose: Pose;
	/** Camera centre, ENU in the engine frame. */
	eye: [number, number, number];
};

export type Gen3cRequest = {
	npz: Record<string, NdArray>;
	argv: string[];
	/** Human notes (what is and is not verified). */
	notes: string[];
};

/**
 * Package key frames + a path into GEN3C's gen3c_multiview.py NPZ. Each key frame is letterboxed (aspect
 * kept, nearest-neighbour; bars get mask 0) into 1280×704 and its intrinsics are adjusted accordingly.
 * `origin` (usually the photo eye) is subtracted from every camera centre. T is rounded up to 120·N + 1 (gen3c_multiview.py asserts (T − 1) % 120 == 0).
 */
export function buildGen3cRequest(
	keys: Gen3cKeyFrame[],
	path: { pose: Pose; eye: [number, number, number] }[],
	origin: [number, number, number],
	opts: { prompt?: string; foregroundMasking?: boolean } = {},
): Gen3cRequest {
	const { width: GW, height: GH } = GEN3C_SIZE;
	const N = keys.length;
	const img = new Float32Array(N * 3 * GH * GW);
	const dep = new Float32Array(N * GH * GW);
	const msk = new Float32Array(N * GH * GW);
	const Kk = new Float32Array(N * 9);
	const Wk = new Float32Array(N * 16);
	const rel = (e: ArrayLike<number>) => [
		e[0] - origin[0],
		e[1] - origin[1],
		e[2] - origin[2],
	];
	keys.forEach((kf, n) => {
		const s = Math.min(GW / kf.width, GH / kf.height);
		const w = Math.round(kf.width * s);
		const h = Math.round(kf.height * s);
		const ox = (GW - w) >> 1;
		const oy = (GH - h) >> 1;
		for (let y = 0; y < GH; y++)
			for (let x = 0; x < GW; x++) {
				const xi = x - ox;
				const yi = y - oy;
				if (xi < 0 || yi < 0 || xi >= w || yi >= h) {
					for (let c = 0; c < 3; c++) img[((n * 3 + c) * GH + y) * GW + x] = -1;
					continue;
				}
				const sx = Math.min(
					kf.width - 1,
					Math.floor(((xi + 0.5) / w) * kf.width),
				);
				const sy = Math.min(
					kf.height - 1,
					Math.floor(((yi + 0.5) / h) * kf.height),
				);
				const k = sy * kf.width + sx;
				for (let c = 0; c < 3; c++)
					img[((n * 3 + c) * GH + y) * GW + x] =
						(kf.rgba[4 * k + c] / 255) * 2 - 1;
				const z = kf.zDepth[k];
				if (z > 0 && Number.isFinite(z)) {
					dep[(n * GH + y) * GW + x] = z;
					msk[(n * GH + y) * GW + x] = 1;
				}
			}
		const K = kPixels(kf.pose, w, h);
		Kk.set([K[0], 0, K[2] + ox, 0, K[4], K[5] + oy, 0, 0, 1], 9 * n);
		Wk.set(w2cOpenCV(kf.pose, rel(kf.eye)), 16 * n);
	});
	const Nf = Math.max(1, Math.ceil((path.length - 1) / 120));
	const T = 120 * Nf + 1;
	const full =
		path.length >= T
			? path.slice(0, T)
			: [...path, ...Array(T - path.length).fill(path[path.length - 1])];
	const Wall = new Float32Array(T * 16);
	const Kall = new Float32Array(T * 9);
	const k0 = keys[0];
	const s0 = Math.min(GW / k0.width, GH / k0.height);
	const w0 = Math.round(k0.width * s0);
	const h0 = Math.round(k0.height * s0);
	full.forEach((p, f) => {
		Wall.set(w2cOpenCV(p.pose, rel(p.eye)), 16 * f);
		const K = kPixels(p.pose, w0, h0);
		Kall.set(
			[
				K[0],
				0,
				K[2] + ((GW - w0) >> 1),
				0,
				K[4],
				K[5] + ((GH - h0) >> 1),
				0,
				0,
				1,
			],
			9 * f,
		);
	});
	const argv = [
		"python",
		"-m",
		"cosmos_predict1.diffusion.inference.gen3c_multiview",
		"--checkpoint_dir",
		"checkpoints",
		"--npz_path",
		"rigi_cache.npz",
		"--num_video_frames",
		String(T),
		"--height",
		String(GH),
		"--width",
		String(GW),
		"--trajectory",
		"none",
		"--camera_rotation",
		"no_rotation",
		"--guidance",
		"1",
		"--video_save_name",
		"rigi_gen3c",
		...(opts.foregroundMasking ? ["--foreground_masking"] : []),
		// gen3c_multiview.py skips a prompt-less item when the upsampler is disabled ("Prompt is missing, skipping
		// world generation"), and --prompt has no default: always pass one, verbatim.
		"--prompt",
		opts.prompt ?? GEN3C_DEFAULT_PROMPT,
		"--disable_prompt_upsampler",
	];
	return {
		npz: {
			images_key_frames: { shape: [N, 3, GH, GW], data: img },
			depth_key_frames: { shape: [N, 1, GH, GW], data: dep },
			mask_key_frames: { shape: [N, 1, GH, GW], data: msk },
			K_key_frames: { shape: [N, 3, 3], data: Kk },
			w2cs_key_frames: { shape: [N, 4, 4], data: Wk },
			w2cs_all: { shape: [T, 4, 4], data: Wall },
			Ks_all: { shape: [T, 3, 3], data: Kall },
		},
		argv,
		notes: [
			"NPZ keys, shapes and the CLI flags are from nv-tlabs/GEN3C gen3c_multiview.py and README @ db2ffe12ce.",
			"--trajectory none is listed in gen3c_multiview.py's choices; whether 'none' makes it use w2cs_all verbatim is UNVERIFIED (read the script before a paid run).",
			"Depth is metric z in an eye-centred ENU world; GEN3C was trained on ViPE/MoGe-scale depth (scale-agnostic cache rendering, but UNVERIFIED on 100 m-10 km ranges).",
			"The output video is GENERATED content: reconstruct it (e.g. DA3 /multiview with these poses) and tag every splat 'generated'.",
		],
	};
}

export type LingbotRequest = {
	files: { "intrinsics.npy": NdArray; "poses.npy": NdArray };
	argv: string[];
	notes: string[];
};

/**
 * Package a camera path for LingBot-World v1 base-cam (image + camera poses). `size` is the --size preset;
 * intrinsics are written in its pixels (UNVERIFIED unit), poses as OpenCV camera-to-world in an eye-centred
 * ENU world (UNVERIFIED direction; ViPE convention). frame_num is rounded to 4n+1 (Wan2.x video length rule,
 * UNVERIFIED for LingBot).
 */
export function buildLingbotRequest(
	path: { pose: Pose; eye: [number, number, number] }[],
	origin: [number, number, number],
	opts: { size?: "480*832" | "720*1280"; prompt?: string } = {},
): LingbotRequest {
	const size = opts.size ?? "480*832";
	const [H, W] = size.split("*").map(Number);
	const T0 = path.length;
	const T = Math.max(5, 4 * Math.ceil((T0 - 1) / 4) + 1);
	const full =
		T0 >= T ? path.slice(0, T) : [...path, ...Array(T - T0).fill(path[T0 - 1])];
	const intr = new Float32Array(T * 4);
	const poses = new Float32Array(T * 16);
	full.forEach((p, f) => {
		const K = kPixels(p.pose, W, H);
		intr.set([K[0], K[4], K[2], K[5]], 4 * f);
		const rel = [
			p.eye[0] - origin[0],
			p.eye[1] - origin[1],
			p.eye[2] - origin[2],
		];
		poses.set(invRigid(w2cOpenCV(p.pose, rel)), 16 * f);
	});
	return {
		files: {
			"intrinsics.npy": { shape: [T, 4], data: intr },
			"poses.npy": { shape: [T, 4, 4], data: poses },
		},
		argv: [
			"torchrun",
			"--nproc_per_node=8",
			"generate.py",
			"--task",
			"i2v-A14B",
			"--size",
			size,
			"--ckpt_dir",
			"lingbot-world-base-cam",
			"--image",
			"image.jpg",
			"--action_path",
			".",
			"--dit_fsdp",
			"--t5_fsdp",
			"--ulysses_size",
			"8",
			"--frame_num",
			String(T),
			"--prompt",
			opts.prompt ??
				"A still alpine landscape, gentle camera move, no new objects.",
		],
		notes: [
			"Files, shapes and flags from robbyant/lingbot-world README @ a43bec7f80.",
			"poses.npy direction (c2w vs w2c) and intrinsics units are UNVERIFIED: the README only says '[fx, fy, cx, cy]' and 'transformation matrix in OpenCV coordinates'.",
			"LingBot-World conditions on camera pose only (no depth / DEM): it may invent terrain. Everything it outputs is 'generated'.",
		],
	};
}

// ---- .npy / .npz writers (numpy format 1.0, little-endian float32; zip 'stored', no compression) ----

export function encodeNpy(a: NdArray): Uint8Array {
	const shape =
		a.shape.length === 1 ? `(${a.shape[0]},)` : `(${a.shape.join(", ")})`;
	let header = `{'descr': '<f4', 'fortran_order': False, 'shape': ${shape}, }`;
	const pre = 10;
	const pad = 64 - ((pre + header.length + 1) % 64);
	header = header + " ".repeat(pad % 64) + "\n";
	const out = new Uint8Array(pre + header.length + a.data.byteLength);
	out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
	out[8] = header.length & 0xff;
	out[9] = header.length >> 8;
	for (let i = 0; i < header.length; i++) out[pre + i] = header.charCodeAt(i);
	const le = new Uint8Array(
		a.data.buffer,
		a.data.byteOffset,
		a.data.byteLength,
	);
	out.set(le, pre + header.length); // Float32Array is little-endian on every platform Rigi runs on
	return out;
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
function crc32(b: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < b.length; i++)
		c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with the given files stored uncompressed (numpy.load reads it as an .npz). */
export function zipStore(files: Record<string, Uint8Array>): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	const enc = new TextEncoder();
	for (const [name, data] of Object.entries(files)) {
		const nb = enc.encode(name);
		const crc = crc32(data);
		const lh = new DataView(new ArrayBuffer(30));
		lh.setUint32(0, 0x04034b50, true);
		lh.setUint16(4, 20, true);
		lh.setUint32(14, crc, true);
		lh.setUint32(18, data.length, true);
		lh.setUint32(22, data.length, true);
		lh.setUint16(26, nb.length, true);
		parts.push(new Uint8Array(lh.buffer), nb, data);
		const ch = new DataView(new ArrayBuffer(46));
		ch.setUint32(0, 0x02014b50, true);
		ch.setUint16(4, 20, true);
		ch.setUint16(6, 20, true);
		ch.setUint32(16, crc, true);
		ch.setUint32(20, data.length, true);
		ch.setUint32(24, data.length, true);
		ch.setUint16(28, nb.length, true);
		ch.setUint32(42, offset, true);
		central.push(new Uint8Array(ch.buffer), nb);
		offset += 30 + nb.length + data.length;
	}
	const cdSize = central.reduce((a, p) => a + p.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	const n = Object.keys(files).length;
	end.setUint16(8, n, true);
	end.setUint16(10, n, true);
	end.setUint32(12, cdSize, true);
	end.setUint32(16, offset, true);
	const all = [...parts, ...central, new Uint8Array(end.buffer)];
	const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
	let o = 0;
	for (const p of all) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** GEN3C request → .npz bytes (keys become `<key>.npy`). Sizes above 4 GB are not supported (zip32). */
export function gen3cNpz(req: Gen3cRequest): Uint8Array {
	const files: Record<string, Uint8Array> = {};
	for (const [k, v] of Object.entries(req.npz))
		files[`${k}.npy`] = encodeNpy(v);
	return zipStore(files);
}
