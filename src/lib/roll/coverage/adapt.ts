// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// RollPhoto -> CoveragePhoto: the minimap's own wedge (heading, hfov from the pose and image aspect,
// EXIF-only poses uncertain).
import { isUncertainPose } from "../../terroir/roll/logic";
import { hfovOf } from "../roll";
import type { RollPhoto } from "../types";
import type { CoveragePhoto } from "./frame";

export const coveragePhotosOf = (
	photos: readonly RollPhoto[],
): CoveragePhoto[] =>
	photos.map((p) => ({
		lat: p.meta.lat,
		lon: p.meta.lon,
		yawDeg: p.pose.yaw,
		hfovDeg: Math.min(179, hfovOf(p.pose, p.meta.width / p.meta.height)),
		uncertain: isUncertainPose(p.poseSource),
	}));
