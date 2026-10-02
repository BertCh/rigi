// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { LV95_EPSG_CODE, LV95_PROJ_DEFINITION } from "../lv95";

// The string both scripts/lib/lv95.ts and concord/occl/swiss-cog.ts carried before it was shared.
const PREVIOUS_COPY =
	"+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs";

describe("LV95 definition", () => {
	it("is byte-identical to the two copies it replaced", () => {
		expect(LV95_PROJ_DEFINITION).toBe(PREVIOUS_COPY);
		expect(LV95_EPSG_CODE).toBe(2056);
	});
});
