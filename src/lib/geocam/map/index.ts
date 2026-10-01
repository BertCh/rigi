// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GA1 MAP solver with priors + Laplace covariance (reports/geometry-first-pose.md G3).
//   solveMap(problem, x0, opts) → MapResult (x, cam, cov, σ per param, σ_EN, perFamily info, MAD)
//   factors: gps / alt / ground / gravity / compass / focal priors; skyline (eye-linearised horizon),
//   point (2D–3D), concord cue factors (edge / level / shore / point).

export type {
	CueFamily,
	Factor,
	FamilyReport,
	GeoState,
	Loss,
	MapFree,
	MapOpts,
	MapProblem,
	MapResult,
	ParamName,
} from "../core";
export * from "./cluster";
export * from "./covariance";
export * from "./factors";
export * from "./joint-residual";
export * from "./lm";
export * from "./solve";
