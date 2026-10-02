// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Robust solvers ported from the Python services (poselib / opencv / numpy): see README.md in ../.
export {
	type AbsolutePoseOptions,
	type AbsolutePoseResult,
	absolutePoseLoop,
	absolutePoseRansac,
	dltFocal,
	p3pGrunert,
} from "./absolute";
export {
	absolutePoseRansacAsync,
	cameraRotationRansacAsync,
	createScorer,
	type GpuScoringOptions,
	rotationRansacAsync,
} from "./async";
export {
	type BatchScorer,
	type BatchWinner,
	chord2OfAngle,
	driveAsync,
	driveSync,
	HYP_STRIDE,
	type HypothesisBatch,
	type RansacLoop,
	type ScoreMode,
	scoreBatchCpu,
	scoreHypothesis,
} from "./batch";
export {
	type CameraRotationOptions,
	type CameraRotationResult,
	cameraRotationLoop,
	cameraRotationRansac,
	type Intrinsics,
	triad,
} from "./camera-rotation";
export { type Loss, type PoseLmOptions, refinePoseLm } from "./lm";
export {
	expSO3,
	kabsch,
	rotationAngleDeg,
	rotationDistanceDeg,
	rotationFromCovariance,
	transpose3,
} from "./rot3";
export {
	type RotationRansacOptions,
	type RotationRansacResult,
	refineRotation,
	rotationRansac,
	rotationRansacLoop,
} from "./rotation";
