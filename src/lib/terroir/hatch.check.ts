// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir hatch (src/lib/terroir/hatch.ts): the shader code is spliced only while TERROIR_HATCH is on, and WGSL carries the same constants.
import { strict as assert } from "node:assert";
import { terroirTerrainFs } from "./glsl/terrain";
import type { TerroirShader } from "./glsl/values";
import { HATCH_GLSL, HATCH_WGSL } from "./hatch";
import { terroirFeatures, terroirWGSL } from "./wgsl/terrain";

// GLSL: spliced only with the define
const src =
	'x\nvec3 alpineAlbedo(float elev, vec3 n, vec2 xy) {\nvec3 hypso(float h) {\nA\n// "topology" ramp for contour lines\nB\n';
const on = terroirTerrainFs("deck", src, ["TERROIR_HATCH"]);
assert.ok(
	on.includes("float terHatch(") && on.includes("terHatch(n, xy, vElev"),
);
assert.ok(
	!terroirTerrainFs("deck", src, ["TERROIR_SNOW"]).includes("terHatch"),
);
assert.equal(terroirTerrainFs("deck", src, []), src);

// WGSL: feature only on hillshade with the define; same constants as the GLSL
const t = (defines: string[]) =>
	({
		defines,
		swissIndex: false,
		grid: null,
		fit: null,
		snowline: null,
	}) as unknown as TerroirShader;
assert.deepEqual(terroirFeatures("hillshade", t(["TERROIR_HATCH"]), false), {
	terHatch: true,
});
assert.deepEqual(terroirFeatures("contours", t(["TERROIR_HATCH"]), false), {});
assert.deepEqual(terroirFeatures("hillshade", null, false), {});
const wgsl = terroirWGSL({ terHatch: true }, { relief: false, water: false });
assert.ok(
	wgsl.includes("fn ter_hatch(") && wgsl.includes("ter_hatch(n, xy, s.elev"),
);
// hatch without a pack has no ter_pal (cover binds it), so the cover albedo must not be emitted (WGSL compile error)
assert.ok(
	!wgsl.includes("ter_cover_albedo") && !wgsl.includes("ter_pal("),
	"hatch-only WGSL references nothing from the cover pack",
);
const nums = (s: string) => (s.match(/\d+\.\d+/g) ?? []).join(" ");
assert.equal(
	nums(HATCH_GLSL),
	nums(HATCH_WGSL),
	"GLSL and WGSL constants agree",
);
console.log("hatch.check: ok");
