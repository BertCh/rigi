// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Page ↔ features worker messages (import-light: no runtime imports).
import type { FeatureMatches, FeatureSet, ImageInput } from "./index";

export type FeaturesRequest =
	| { id: number; op: "available" }
	| {
			id: number;
			op: "extract";
			image: ImageInput;
			maxKeypoints?: number;
			longSide?: number;
	  }
	| { id: number; op: "match"; a: FeatureSet; b: FeatureSet; minScore?: number }
	| { id: number; op: "abort" };

export type FeaturesResponse =
	| { id: number; ok: true; result: boolean | FeatureSet | FeatureMatches }
	| { id: number; ok: false; error: string; abort?: boolean };
