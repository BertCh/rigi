// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A tiny synthetic body for the src/lib/body specs (no weights): Anny's reduced 13-joint tree with made-up joint
// positions (body frame x left, y back, z up), COCO-17 keypoints rigidly attached to joints, and a closed mesh of
// subdivided axis-aligned boxes (torso, head, upper legs) each skinned to one joint. One shape direction: uniform 10 % scale.
import type { BodyModel } from "../anny";

const JOINTS: [string, number, [number, number, number]][] = [
	["root", -1, [0, 0, 0]],
	["upperleg01.L", 0, [0.1, 0, -0.05]],
	["lowerleg01.L", 1, [0.1, 0, -0.45]],
	["upperleg01.R", 0, [-0.1, 0, -0.05]],
	["lowerleg01.R", 3, [-0.1, 0, -0.45]],
	["spine03", 0, [0, 0, 0.15]],
	["spine01", 5, [0, 0, 0.35]],
	["upperarm01.L", 6, [0.18, 0, 0.45]],
	["lowerarm01.L", 7, [0.25, 0, 0.2]],
	["upperarm01.R", 6, [-0.18, 0, 0.45]],
	["lowerarm01.R", 9, [-0.25, 0, 0.2]],
	["neck01", 6, [0, 0, 0.55]],
	["head", 11, [0, 0, 0.62]],
];

/** COCO-17: position and the joint it moves with */
const KEYPOINTS: [[number, number, number], number][] = [
	[[0, -0.1, 0.72], 12],
	[[0.03, -0.09, 0.75], 12],
	[[-0.03, -0.09, 0.75], 12],
	[[0.07, 0, 0.72], 12],
	[[-0.07, 0, 0.72], 12],
	[[0.18, 0, 0.45], 7],
	[[-0.18, 0, 0.45], 9],
	[[0.25, 0, 0.2], 7],
	[[-0.25, 0, 0.2], 9],
	[[0.3, -0.02, -0.05], 8],
	[[-0.3, -0.02, -0.05], 10],
	[[0.1, 0, -0.05], 0],
	[[-0.1, 0, -0.05], 0],
	[[0.1, 0, -0.45], 1],
	[[-0.1, 0, -0.45], 3],
	[[0.1, 0, -0.85], 2],
	[[-0.1, 0, -0.85], 4],
];

/**
 * Axis-aligned box (min, max), each face an n × n grid of quads (two triangles each); edge vertices are repeated per
 * face, so the surface is closed geometrically (what a rasteriser needs) without shared topology.
 */
export function boxMesh(
	min: [number, number, number],
	max: [number, number, number],
	n = 1,
): { vertices: number[]; faces: number[] } {
	const vertices: number[] = [];
	const faces: number[] = [];
	// per face: the fixed axis, its side, and the two in-plane axes
	for (let axis = 0; axis < 3; axis++)
		for (const side of [0, 1]) {
			const a = (axis + 1) % 3;
			const b = (axis + 2) % 3;
			const base = vertices.length / 3;
			for (let j = 0; j <= n; j++)
				for (let i = 0; i <= n; i++) {
					const p = [0, 0, 0];
					p[axis] = side ? max[axis] : min[axis];
					p[a] = min[a] + ((max[a] - min[a]) * i) / n;
					p[b] = min[b] + ((max[b] - min[b]) * j) / n;
					vertices.push(p[0], p[1], p[2]);
				}
			for (let j = 0; j < n; j++)
				for (let i = 0; i < n; i++) {
					const q = base + j * (n + 1) + i;
					faces.push(q, q + 1, q + n + 2, q, q + n + 2, q + n + 1);
				}
		}
	return { vertices, faces };
}

export function syntheticBody(): BodyModel {
	const parts: {
		min: [number, number, number];
		max: [number, number, number];
		joint: number;
	}[] = [
		{ min: [-0.17, -0.1, -0.1], max: [0.17, 0.1, 0.5], joint: 5 },
		{ min: [-0.09, -0.1, 0.58], max: [0.09, 0.1, 0.8], joint: 12 },
		{ min: [0.03, -0.08, -0.45], max: [0.17, 0.08, -0.08], joint: 1 },
		{ min: [-0.17, -0.08, -0.45], max: [-0.03, 0.08, -0.08], joint: 3 },
	];
	const vertices: number[] = [];
	const faces: number[] = [];
	const skinIndex: number[] = [];
	const skinWeight: number[] = [];
	for (const p of parts) {
		const m = boxMesh(p.min, p.max, 4);
		const base = vertices.length / 3;
		vertices.push(...m.vertices);
		faces.push(...m.faces.map((f) => f + base));
		for (let i = 0; i < m.vertices.length / 3; i++) {
			skinIndex.push(p.joint, 0, 0, 0);
			skinWeight.push(1, 0, 0, 0);
		}
	}
	const joints = JOINTS.flatMap(([, , p]) => p);
	const kp = KEYPOINTS.flatMap(([p]) => p);
	const v = Float32Array.from(vertices);
	const j = Float32Array.from(joints);
	const k = Float32Array.from(kp);
	const stature = 0.8 + 0.85;
	return {
		vertexCount: v.length / 3,
		faces: Uint32Array.from(faces),
		vertices: v,
		shapeVertices: v.map((x) => 0.1 * x),
		jointCount: JOINTS.length,
		joints: j,
		shapeJoints: j.map((x) => 0.1 * x),
		parents: Int32Array.from(JOINTS.map(([, p]) => p)),
		influences: 4,
		skinIndex: Uint16Array.from(skinIndex),
		skinWeight: Float32Array.from(skinWeight),
		keypointCount: KEYPOINTS.length,
		keypoints: k,
		shapeKeypoints: k.map((x) => 0.1 * x),
		keypointIndex: Uint16Array.from(
			KEYPOINTS.flatMap(([, jj]) => [jj, 0, 0, 0]),
		),
		keypointWeight: Float32Array.from(KEYPOINTS.flatMap(() => [1, 0, 0, 0])),
		stature,
		shapeStature: Float32Array.from([0.1 * stature]),
		shapeNames: ["scale"],
		jointNames: JOINTS.map(([n]) => n),
	};
}
