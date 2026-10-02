// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Terroir hatch (src/lib/terroir/hatch.ts): the shader code is spliced only while TERROIR_HATCH is on, and WGSL carries the same constants.
import { strict as assert } from "node:assert";
import { terroirTerrainFs } from "./glsl/terrain";
import type { TerroirShader } from "./glsl/values";
import { HATCH_GLSL, HATCH_WGSL } from "./hatch";
import {
	HATCH_LK,
	HATCH_LK_GLSL,
	HATCH_LK_WGSL,
	lkhHachure,
	lkhHash,
	lkhOctave,
	lkhStroke,
	lkhStrokes,
} from "./hatch-lk";
import { terroirFeatures, terroirWGSL } from "./wgsl/terrain";

// GLSL: spliced only with the define
const src =
	'x\nvec3 alpineAlbedo(float elev, vec3 n, vec2 xy) {\nvec3 hypso(float h) {\nA\n// "topology" ramp for contour lines\nB\n';
const on = terroirTerrainFs(src, ["TERROIR_HATCH"]);
assert.ok(
	on.includes("float terHatch(") && on.includes("terHatch(n, xy, vElev"),
);
assert.ok(!terroirTerrainFs(src, ["TERROIR_SNOW"]).includes("terHatch"));
assert.equal(terroirTerrainFs(src, []), src);

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

// ---- hatch v2 (landeskarte): splice gating, byte-identity of classic, twin constants, CPU maths ----
const lk = terroirTerrainFs(src, ["TERROIR_HATCH", "TERROIR_HATCH_LK"]);
assert.ok(
	lk.includes("vec4 terHatchLk(") && lk.includes("terHatchLk(n, xy, vElev"),
);
assert.ok(!lk.includes("float terHatch("), "v2 replaces the classic function");
assert.ok(!on.includes("terHatchLk"), "classic output carries no v2 code");
const lkOn = (defines: string[]) =>
	terroirFeatures("hillshade", t(defines), false);
assert.deepEqual(lkOn(["TERROIR_HATCH", "TERROIR_HATCH_LK"]), {
	terHatch: true,
	terHatchLk: true,
});
assert.deepEqual(lkOn(["TERROIR_HATCH"]), { terHatch: true });
const wgslLk = terroirWGSL(
	{ terHatch: true, terHatchLk: true },
	{ relief: false, water: false },
);
assert.ok(
	wgslLk.includes("fn ter_hatch_lk(") && !wgslLk.includes("fn ter_hatch("),
);
assert.ok(!wgsl.includes("ter_hatch_lk"), "classic WGSL carries no v2 code");
assert.equal(
	nums(HATCH_LK_GLSL),
	nums(HATCH_LK_WGSL),
	"v2 GLSL and WGSL constants agree",
);

// CPU reference of the line function
const H = HATCH_LK;
const mpp = 2;
// ground anchoring: shifting by a whole fine period along the stripe normal changes nothing
{
	const [fine] = lkhOctave(H.PERIOD_SHADE_PX * mpp, H.MIN_PERIOD_M);
	const a = lkhStroke(10.3, 4.1, 0, fine, mpp, H.WIDTH_PX, 1, 11);
	const b = lkhStroke(10.3, 4.1 + fine, 0, fine, mpp, H.WIDTH_PX, 1, 11);
	assert.ok(
		Math.abs(a - b) < 1e-9,
		"stroke field is periodic in ground metres",
	);
}
// octaves are nested: weights change with the footprint, positions do not
{
	const [p1, w1] = lkhOctave(3, 1.5);
	const [p2, w2] = lkhOctave(5.9, 1.5);
	assert.equal(p1, 3);
	assert.equal(w1, 0);
	assert.equal(p2, 3);
	assert.ok(w2 > 0.9 && w2 < 1);
	assert.deepEqual(lkhOctave(0.2, 1.5), [1.5, 0]);
	const [p3, w3] = lkhOctave(6, 1.5);
	assert.equal(p3, 6);
	assert.ok(Math.abs(w3) < 1e-12);
}
// no swim: coverage at a fixed ground point is continuous in the footprint across an octave boundary
{
	let worst = 0;
	for (const [x, y] of [
		[3.1, 7.7],
		[12.4, 1.2],
		[40.5, 33.3],
	]) {
		let prev = lkhStrokes(
			x,
			y,
			0.4,
			H.PERIOD_SHADE_PX,
			1.0,
			H.WIDTH_PX,
			H.KEEP,
			11,
		);
		for (let m = 1.0; m < 8.0; m *= 1.0005) {
			const v = lkhStrokes(
				x,
				y,
				0.4,
				H.PERIOD_SHADE_PX,
				m,
				H.WIDTH_PX,
				H.KEEP,
				11,
			);
			worst = Math.max(worst, Math.abs(v - prev));
			prev = v;
		}
	}
	assert.ok(worst < 0.08, `coverage continuous under zoom (max step ${worst})`);
}
// shade side is denser (more ink per area) than the lit side
{
	let shade = 0;
	let lit = 0;
	for (let i = 0; i < 4000; i++) {
		const x = (i * 7.31) % 211;
		const y = (i * 3.77) % 197;
		shade += lkhHachure(x, y, 0.7, 2, -0.3);
		lit += lkhHachure(x, y, 0.7, 2, 0.9);
	}
	assert.ok(shade > lit * 1.4, `shadow side denser (${shade} vs ${lit})`);
}
// taper: a stroke thins toward its ends along the fall line
{
	const [fine] = lkhOctave(H.PERIOD_SHADE_PX * mpp, H.MIN_PERIOD_M);
	const len = fine * H.LENGTH_PERIODS;
	const mid = lkhStroke(0.5 * len, 0, 0, fine, mpp, H.WIDTH_PX, 1, 11);
	const end = lkhStroke(0.02 * len, 0, 0, fine, mpp, H.WIDTH_PX, 1, 11);
	assert.ok(mid > 0.9 && end < 0.3, `taper ${mid} ${end}`);
}
// hash keep: about KEEP of the cells survive; hash stays in [0, 1)
{
	let kept = 0;
	const total = 20000;
	for (let i = 0; i < total; i++) {
		const h = lkhHash(i % 141, Math.floor(i / 141) - 70, 11);
		assert.ok(h >= 0 && h < 1);
		if (h <= H.KEEP) kept++;
	}
	assert.ok(Math.abs(kept / total - H.KEEP) < 0.02, "hash thinning rate");
}
console.log("hatch.check: ok");
