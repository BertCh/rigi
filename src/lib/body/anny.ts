// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A coarse Anny body (naver/anny, code Apache-2.0, MakeHuman assets CC0) evaluated on the CPU: linear shape
// blendshapes + linear blend skinning on a reduced 13-bone rig. The data is baked by scripts/models/anny.py
// (public/models/anny-lod10.<hash>.safetensors; see that file for what is linearised and reduced).
//
// Body frame (Anny's): x = the person's left, y = backwards, z = up, metres, origin at the root (pelvis).
// Pose model: world-aligned joint frames. Joint j has a rest position J_j(β) and a local rotation R_j (axis-angle
// θ_j in the rest axes); G_root = [R_root | J_root], G_j = G_parent · [R_j | J_j − J_parent], and a point p with
// skin weights w moves to Σ_j w_j · G_j · [I | −J_j] · p. Rotating only kept joints is exact w.r.t. Anny's own LBS on
// the full 104-bone rig (the producer measures it); nn has no scatter, so this stays TypeScript.
import { fetchModel } from "#/lib/nn/fetch";
import { entryF32, parseSafetensors } from "#/lib/nn/safetensors";

export const ANNY_FILE = "anny-lod10.7f7971fa.safetensors";

/** A rigged body: rest data at β = 0, linear shape directions, a joint tree and top-k skin weights. */
export type BodyModel = {
	vertexCount: number;
	/** triangle vertex indices [F · 3] */
	faces: Uint32Array;
	/** rest vertices at β = 0 [V · 3] */
	vertices: Float32Array;
	/** shape directions [S · V · 3] (per unit β) */
	shapeVertices: Float32Array;
	jointCount: number;
	/** rest joint positions [J · 3]; joint 0 is the root */
	joints: Float32Array;
	shapeJoints: Float32Array;
	/** parent per joint (−1 for the root; parents precede children) */
	parents: Int32Array;
	/** influences per vertex (4) */
	influences: number;
	skinIndex: Uint16Array;
	skinWeight: Float32Array;
	/** skinned landmark points (COCO-17 keypoints for Anny) */
	keypointCount: number;
	keypoints: Float32Array;
	shapeKeypoints: Float32Array;
	keypointIndex: Uint16Array;
	keypointWeight: Float32Array;
	/** standing height at β = 0 and its linear change per unit β */
	stature: number;
	shapeStature: Float32Array;
	shapeNames: readonly string[];
	jointNames: readonly string[];
};

/** Parse the producer's safetensors bytes. */
export function annyFromBytes(bytes: ArrayBuffer | Uint8Array): BodyModel {
	const st = parseSafetensors(bytes);
	const get = (name: string) => {
		const e = st.entries.get(name);
		if (!e) throw new Error(`anny: missing ${name}`);
		return { data: entryF32(e), shape: e.shape };
	};
	const v = get("template.vertices");
	const j = get("template.joints");
	const k = get("template.keypoints");
	const si = get("skin.index");
	const ki = get("keypoints.index");
	const shapes = (st.metadata.shapes ?? "").split(",").filter(Boolean);
	return {
		vertexCount: v.shape[0],
		faces: Uint32Array.from(get("faces").data),
		vertices: v.data,
		shapeVertices: get("shape.dirs").data,
		jointCount: j.shape[0],
		joints: j.data,
		shapeJoints: get("shape.joints").data,
		parents: Int32Array.from(get("joints.parent").data),
		influences: si.shape[1],
		skinIndex: Uint16Array.from(si.data),
		skinWeight: get("skin.weight").data,
		keypointCount: k.shape[0],
		keypoints: k.data,
		shapeKeypoints: get("shape.keypoints").data,
		keypointIndex: Uint16Array.from(ki.data),
		keypointWeight: get("keypoints.weight").data,
		stature: get("template.stature").data[0],
		shapeStature: get("shape.stature").data,
		shapeNames: shapes,
		jointNames: (st.metadata.joints ?? "").split(",").filter(Boolean),
	};
}

/** Load the baked Anny body from public/models (Cache Storage in the browser, the file in node). */
export async function loadAnny(file: string = ANNY_FILE): Promise<BodyModel> {
	return annyFromBytes(await fetchModel(file));
}

/** Rodrigues: axis-angle (x, y, z) → row-major 3 × 3 rotation, written to `out` at `o`. */
export function rotationFromAxisAngle(
	x: number,
	y: number,
	z: number,
	out: Float64Array = new Float64Array(9),
	o = 0,
): Float64Array {
	const th = Math.hypot(x, y, z);
	if (th < 1e-12) {
		out.fill(0, o, o + 9);
		out[o] = out[o + 4] = out[o + 8] = 1;
		// first-order term keeps tiny finite-difference steps meaningful
		out[o + 1] = -z;
		out[o + 2] = y;
		out[o + 3] = z;
		out[o + 5] = -x;
		out[o + 6] = -y;
		out[o + 7] = x;
		return out;
	}
	const kx = x / th;
	const ky = y / th;
	const kz = z / th;
	const s = Math.sin(th);
	const c = 1 - Math.cos(th);
	out[o] = 1 - c * (ky * ky + kz * kz);
	out[o + 1] = -s * kz + c * kx * ky;
	out[o + 2] = s * ky + c * kx * kz;
	out[o + 3] = s * kz + c * kx * ky;
	out[o + 4] = 1 - c * (kx * kx + kz * kz);
	out[o + 5] = -s * kx + c * ky * kz;
	out[o + 6] = -s * ky + c * kx * kz;
	out[o + 7] = s * kx + c * ky * kz;
	out[o + 8] = 1 - c * (kx * kx + ky * ky);
	return out;
}

/** Linear shape: base [N · 3] + Σ β_s · dirs[s] → out. */
export function applyShape(
	base: Float32Array,
	dirs: Float32Array,
	beta: ArrayLike<number>,
	out: Float64Array = new Float64Array(base.length),
): Float64Array {
	const n = base.length;
	for (let i = 0; i < n; i++) out[i] = base[i];
	for (let s = 0; s < beta.length; s++) {
		const b = beta[s];
		if (b === 0) continue;
		const off = s * n;
		for (let i = 0; i < n; i++) out[i] += b * dirs[off + i];
	}
	return out;
}

/**
 * Forward kinematics. `pose` [J · 3] axis-angles (joint 0's rotates the whole body about the root). Returns the
 * skinning transforms G_j · [I | −J_j] as row-major 3 × 4 blocks [J · 12] and the posed joint positions [J · 3].
 */
export function forwardKinematics(
	model: Pick<BodyModel, "jointCount" | "parents">,
	restJoints: ArrayLike<number>,
	pose: ArrayLike<number>,
	out: { skin: Float64Array; joints: Float64Array } = {
		skin: new Float64Array(model.jointCount * 12),
		joints: new Float64Array(model.jointCount * 3),
	},
): { skin: Float64Array; joints: Float64Array } {
	const J = model.jointCount;
	const G = new Float64Array(J * 12);
	const R = new Float64Array(9);
	for (let j = 0; j < J; j++) {
		rotationFromAxisAngle(pose[3 * j], pose[3 * j + 1], pose[3 * j + 2], R);
		const p = model.parents[j];
		const g = 12 * j;
		if (p < 0) {
			for (let r = 0; r < 3; r++) {
				G[g + 4 * r] = R[3 * r];
				G[g + 4 * r + 1] = R[3 * r + 1];
				G[g + 4 * r + 2] = R[3 * r + 2];
				G[g + 4 * r + 3] = restJoints[3 * j + r];
			}
		} else {
			const q = 12 * p;
			const ox = restJoints[3 * j] - restJoints[3 * p];
			const oy = restJoints[3 * j + 1] - restJoints[3 * p + 1];
			const oz = restJoints[3 * j + 2] - restJoints[3 * p + 2];
			for (let r = 0; r < 3; r++) {
				const a = G[q + 4 * r];
				const b = G[q + 4 * r + 1];
				const c = G[q + 4 * r + 2];
				G[g + 4 * r] = a * R[0] + b * R[3] + c * R[6];
				G[g + 4 * r + 1] = a * R[1] + b * R[4] + c * R[7];
				G[g + 4 * r + 2] = a * R[2] + b * R[5] + c * R[8];
				G[g + 4 * r + 3] = a * ox + b * oy + c * oz + G[q + 4 * r + 3];
			}
		}
		for (let r = 0; r < 3; r++) {
			out.joints[3 * j + r] = G[g + 4 * r + 3];
			const s = out.skin;
			s[g + 4 * r] = G[g + 4 * r];
			s[g + 4 * r + 1] = G[g + 4 * r + 1];
			s[g + 4 * r + 2] = G[g + 4 * r + 2];
			s[g + 4 * r + 3] =
				G[g + 4 * r + 3] -
				(G[g + 4 * r] * restJoints[3 * j] +
					G[g + 4 * r + 1] * restJoints[3 * j + 1] +
					G[g + 4 * r + 2] * restJoints[3 * j + 2]);
		}
	}
	return out;
}

/** Linear blend skinning of rest points [N · 3] with k influences each. */
export function skinPoints(
	rest: ArrayLike<number>,
	index: ArrayLike<number>,
	weight: ArrayLike<number>,
	influences: number,
	skin: Float64Array,
	out: Float64Array = new Float64Array(rest.length),
): Float64Array {
	const n = rest.length / 3;
	for (let i = 0; i < n; i++) {
		const x = rest[3 * i];
		const y = rest[3 * i + 1];
		const z = rest[3 * i + 2];
		let ox = 0;
		let oy = 0;
		let oz = 0;
		for (let c = 0; c < influences; c++) {
			const w = weight[influences * i + c];
			if (w === 0) continue;
			const m = 12 * index[influences * i + c];
			ox += w * (skin[m] * x + skin[m + 1] * y + skin[m + 2] * z + skin[m + 3]);
			oy +=
				w * (skin[m + 4] * x + skin[m + 5] * y + skin[m + 6] * z + skin[m + 7]);
			oz +=
				w *
				(skin[m + 8] * x + skin[m + 9] * y + skin[m + 10] * z + skin[m + 11]);
		}
		out[3 * i] = ox;
		out[3 * i + 1] = oy;
		out[3 * i + 2] = oz;
	}
	return out;
}

export type PosedBody = {
	/** posed vertices in the body frame [V · 3] */
	vertices: Float64Array;
	/** posed keypoints [K · 3] */
	keypoints: Float64Array;
	/** posed joints [J · 3] */
	joints: Float64Array;
	/** standing height of the shape (m) */
	stature: number;
};

/** Shape + pose → posed vertices, keypoints and joints in the body frame. */
export function evaluateBody(
	model: BodyModel,
	beta: ArrayLike<number>,
	pose: ArrayLike<number>,
	opts: { vertices?: boolean } = {},
): PosedBody {
	const restJ = applyShape(model.joints, model.shapeJoints, beta);
	const fk = forwardKinematics(model, restJ, pose);
	const restK = applyShape(model.keypoints, model.shapeKeypoints, beta);
	const keypoints = skinPoints(
		restK,
		model.keypointIndex,
		model.keypointWeight,
		model.influences,
		fk.skin,
	);
	let vertices: Float64Array = new Float64Array(0);
	if (opts.vertices !== false) {
		const restV = applyShape(model.vertices, model.shapeVertices, beta);
		vertices = skinPoints(
			restV,
			model.skinIndex,
			model.skinWeight,
			model.influences,
			fk.skin,
		);
	}
	let stature = model.stature;
	for (let s = 0; s < beta.length; s++)
		stature += beta[s] * (model.shapeStature[s] ?? 0);
	return { vertices, keypoints, joints: fk.joints, stature };
}
