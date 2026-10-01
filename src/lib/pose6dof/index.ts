// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// 6-DoF ground-control-point solver + generic position refinement. Pure TS, no DOM.

export {
	type EyeHorizon,
	fitRotationToHorizon,
	type HorizonAtEye,
	type RefineEyeOptions,
	type RefineEyeResult,
	type RotationFitOptions,
	refineEyeFromSkyline,
	type SkylineFit,
	type SkylineSample,
	skylineResidualsPx,
} from "./eye";
export * from "./geo";
export {
	absoluteOrientation,
	bearing,
	dlt,
	p3p,
	poseFromRotation,
	rotationFromBearings,
	yawFromOnePoint,
} from "./minimal";
export {
	azElFromDir,
	basis,
	dirFromAzEl,
	NP,
	PARAM_NAMES,
	type ParamName,
	type Projection,
	poseFromAxes,
	project,
	type Target,
	unproject,
} from "./project";
export {
	type RefineOptions,
	type RefineResult,
	type ResidualFn,
	refinePosition,
	skylineResidual,
} from "./refine";
export { ladder, residualsPx, solvePose6dof } from "./solve";
export type * from "./types";
