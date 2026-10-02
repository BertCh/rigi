// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** Types for the node-side users of precision-gate-score.mjs (precision-gate-node.ts). */
type Pose = { yaw: number; pitch: number; roll: number; vfov: number };
export type ScoredRow = {
	id: string;
	status: string;
	issues: string[];
	falseAccept?: boolean;
	lostCorrect?: boolean;
	newAccept?: boolean;
	lostAccept?: boolean;
	changedAccept?: boolean;
	noise?: string[] | null;
	diff?: string[];
	quality: Record<
		string,
		{ accepted: boolean; kind?: string; verdict: string | null }
	>;
};
export const EXIT: Record<string, number>;
export function nearPose(a: Pose, b: Pose): boolean;
export function loadVerifiedPoses(root: string): unknown[];
export function scorePhoto(
	id: string,
	modes: Record<string, unknown>,
	verified: unknown[],
): ScoredRow;
export function decide(args: {
	rows: ScoredRow[];
	evalArm: unknown;
	vacuous: string[];
}): {
	verdict: string;
	reasons: string[];
	quality: Record<string, Record<string, number>>;
	unverifiedNewAccepts: string[];
	identity: {
		identical: number;
		withinNoise: number;
		differs: string[];
		noisy: string[];
	};
	errors: string[];
};
