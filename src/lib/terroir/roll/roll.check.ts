// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Checks for the terroir roll/site furniture. Run: npx tsx src/lib/terroir/roll/roll.check.ts
import {
	fmtScale,
	luminance,
	mercatorLat,
	mercatorMPerPx,
	niceFloor,
	POSE_GLYPH,
	priorFanPath,
	scaleBar,
	sunBandColor,
	sunEvents,
} from "./logic";

const fails: string[] = [];
const ok = (c: boolean, m: string) => {
	if (!c) fails.push(m);
};

// sun band: luminance non-decreasing in elevation, ends clamped, golden hour warmer than day
let prev = -1;
for (let e = -30; e <= 90; e += 0.5) {
	const l = luminance(sunBandColor(e));
	ok(l >= prev - 1e-9, `luminance not monotonic at ${e}°`);
	prev = l;
}
ok(sunBandColor(-90).join() === sunBandColor(-18).join(), "night clamp");
ok(sunBandColor(90).join() === sunBandColor(60).join(), "day clamp");
const [gr, , gb] = sunBandColor(3);
ok(gr > gb + 80, "golden hour is warm (r >> b)");
const [nr, , nb] = sunBandColor(-15);
ok(nb > nr, "night is blue");

// sun events on a synthetic day
const el = Array.from(
	{ length: 49 },
	(_, i) => 40 * Math.sin(((i / 48) * 2 - 0.5) * Math.PI),
);
const ev = sunEvents(
	el,
	el.map((_, i) => i / 48),
);
ok(ev.filter((e) => e.kind === "sunrise").length === 1, "one sunrise");
ok(ev.filter((e) => e.kind === "sunset").length === 1, "one sunset");
ok(ev.filter((e) => e.kind === "noon").length === 1, "one noon");

// scale bar: 1/2/5 × 10^n
for (const x of [0.37, 1, 1.9, 2, 4.99, 5, 9.99, 73, 180, 1234, 99999]) {
	const n = niceFloor(x);
	const m = n / 10 ** Math.floor(Math.log10(n));
	ok(
		n <= x && [1, 2, 5].some((k) => Math.abs(m - k) < 1e-9),
		`nice ${x} → ${n}`,
	);
	ok(x < n * 2.5 + 1e-9, `nice ${x} tight`);
}
ok(
	fmtScale(500) === "500 m" &&
		fmtScale(1000) === "1 km" &&
		fmtScale(2500) === "2.5 km",
	"labels",
);
const mpp = mercatorMPerPx(46.7, 14);
const b = scaleBar(mpp, 96);
ok(b.px <= 96 && b.px > 20, `bar px ${b.px}`);
ok(
	Math.abs(
		mercatorLat(
			(0.5 -
				Math.log(Math.tan(Math.PI / 4 + (46.7 * Math.PI) / 360)) /
					(2 * Math.PI)) *
				256 *
				2 ** 14,
			14,
		) - 46.7,
	) < 1e-6,
	"mercator lat roundtrip",
);

// glyphs: complete and pairwise distinct for every pose source
const srcs = ["saved", "ground-truth", "solved", "prior"] as const;
for (const s of srcs) ok(!!POSE_GLYPH[s], `glyph for ${s}`);
ok(
	new Set(srcs.map((s) => POSE_GLYPH[s])).size === srcs.length,
	"glyphs distinct",
);
ok(Object.keys(POSE_GLYPH).length === srcs.length, "no stray glyphs");

// prior fan is wider than the wedge by ±10°
ok(priorFanPath(0, 0, 10, 0, 60).startsWith("M0,0 L"), "fan path");

if (fails.length) {
	console.error(fails.join("\n"));
	process.exit(1);
}
console.log("terroir roll checks: ok");
