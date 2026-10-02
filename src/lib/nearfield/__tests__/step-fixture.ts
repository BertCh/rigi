// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared Step Inside spec fixture (not a spec): flat ground seen from a 10 m eye, its model depth with a
// box 8 m away, and a fake NearFieldHost that samples that ground at its current pose.
import { vi } from "vitest";
import { type Pose, poseBasis } from "../../camera";
import type { NearFieldHost } from "../controller";
import { intrinsicsFromPose, rayFactor } from "../geom";
import type { NearFieldDepth } from "../types";

export const ASPECT = 4 / 3;
const W = 64;
const H = 48;

/** Flat ground z = 0 seen from `eye` at `pose`: ray length per normalised pixel, or null above the horizon. */
export function groundRange(pose: Pose, eyeZ: number, u: number, v: number) {
	const K = intrinsicsFromPose(pose, ASPECT);
	const B = poseBasis(pose);
	const x = (u - K.cx) / K.fx;
	const y = (v - K.cy) / K.fy;
	const d = [0, 1, 2].map((a) => B.right[a] * x - B.up[a] * y + B.forward[a]);
	const dz = d[2] / Math.hypot(d[0], d[1], d[2]);
	return dz < -1e-6 ? -eyeZ / dz : null;
}

export const POSE: Pose = { yaw: 20, pitch: -15, roll: 0, vfov: 60 };
export const EYE_Z = 10;

/** The ground's model depth with a box 8 m away; `noise` scrambles it (a fit that cannot anchor). */
export function depthMap(noise = false): NearFieldDepth {
	const K = intrinsicsFromPose(POSE, ASPECT);
	const depth = new Float32Array(W * H);
	const valid = new Uint8Array(W * H);
	let s = 7;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const u = (i + 0.5) / W;
			const v = (j + 0.5) / H;
			const r = groundRange(POSE, EYE_Z, u, v);
			const k = j * W + i;
			s = (s * 16807) % 2147483647;
			if (i >= 26 && i <= 36 && j >= 26 && j <= 36) {
				depth[k] = 8;
				valid[k] = 1;
			} else if (r != null) {
				const z = r / rayFactor(K, u, v);
				depth[k] = noise ? z * Math.exp(4 * (s / 2147483647 - 0.5)) : z;
				valid[k] = 1;
			}
		}
	return {
		width: W,
		height: H,
		depth,
		valid,
		model: "moge2",
		seconds: 0,
		intrinsicsNorm: K,
	};
}

export type FakeHost = NearFieldHost & {
	pose: Pose;
	eye: { x: number; y: number; z: number };
	setNearField: ReturnType<typeof vi.fn>;
};

export function fakeHost(): FakeHost {
	const host: FakeHost = {
		pose: { ...POSE },
		aspect: ASPECT,
		eye: { x: 0, y: 0, z: EYE_Z },
		frame: { toGeo: () => ({ lat: 46.7, lon: 7.7, h: 0 }) },
		photoElement: undefined,
		sampleAt(u, v) {
			const r = groundRange(host.pose, EYE_Z, u, v);
			return r == null ? null : { range: r };
		},
		readback: async () => true,
		geometryReady: () => true,
		setNearField: vi.fn(),
	} as FakeHost;
	return host;
}
