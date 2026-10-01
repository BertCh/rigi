// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WP-B checks (node, synthetic, no network): npx tsx src/lib/concord/priors/priors.check.ts
import { focalPxFromF35 } from "../../camera/focal";
import type { Vec3 } from "../core/types";
import {
	altitudeContourCost,
	concordEye,
	EYE_PRIOR_DEFAULTS,
	eyePriorFromExif,
	floorEye,
	isoBandSeeds,
	refineEyeOptions,
} from "./altitude";
import {
	DEFAULT_LENS,
	focalPrior,
	LENS_TABLE,
	lensEntry,
	lensModelFromCamera,
} from "./focal-table";
import { type GroundFn, groundFromHeightAt, offsetLatLon } from "./ground";

let fails = 0;
function check(name: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) fails++;
}

const LAT = 46.71;
const LON = 7.77;
const meta = (alt: number | null, hAcc: number | null = 14) => ({
	lat: LAT,
	lon: LON,
	alt,
	hAcc,
});
const opts = { sigmaA: 3, altBias: 0 };

// ---- ground: a plane rising 0.3 m/m to the north + 1000 m (the fix sits at 1000 m)
const slope: GroundFn = (_e, n) => 1000 + 0.3 * n;
const flat: GroundFn = () => 500;

// 1. old rule bit-identical
{
	let bad = 0;
	for (let i = 0; i < 1000; i++) {
		const g = 500 + Math.random() * 3000;
		const alt = Math.random() < 0.2 ? null : g + (Math.random() - 0.5) * 80;
		if (floorEye(alt, g) !== Math.max(alt ?? g, g + 1.6)) bad++;
	}
	check(
		"floorEye ≡ Math.max(alt ?? ground, ground + 1.6)",
		bad === 0,
		`${bad} mismatches / 1000`,
	);
}

// 2. consistent fix: alt = DEM(fix) + 1.6 ⇒ MAP at the fix
{
	const p = eyePriorFromExif(meta(1001.6), slope, opts);
	const m = p.mapEye as Vec3;
	check(
		"consistent fix → contour prior, MAP ≈ fix",
		p.source === "gps+alt-contour" &&
			Math.hypot(m[0], m[1]) < 0.5 &&
			Math.abs(m[2] - 1001.6) < 0.2,
		`MAP [${m.map((x) => x.toFixed(2)).join(", ")}]`,
	);
}

// 3. fix 12 m below the DEM (up-slope fix): MAP moves downhill (south) towards the iso-band, not onto it
//    completely (it is a prior: GPS horizontal term vs contour term), and within 2σH
{
	const alt = 1001.6 - 12; // band at n = −40 m; σH 30 so 2σH = 60 m
	const p = eyePriorFromExif(meta(alt, 30), slope, opts);
	const m = p.mapEye as Vec3;
	// analytic MAP on the plane: minimise n²/σH² + (0.3 n + 12)²/σA²
	const sH = 30;
	const sA = 3;
	const nStar = (-0.3 * 12) / sA ** 2 / (1 / sH ** 2 + 0.09 / sA ** 2);
	check(
		"up-slope fix → MAP moves downhill to the analytic optimum",
		Math.abs(m[1] - nStar) < 0.5 &&
			Math.abs(m[0]) < 0.5 &&
			Math.hypot(m[0], m[1]) <= 2 * sH,
		`n* ${nStar.toFixed(2)} vs MAP ${m[1].toFixed(2)}`,
	);
	check(
		"MAP eye stands on the ground (z = DEM + 1.6 at the MAP xy)",
		Math.abs(m[2] - (slope(m[0], m[1]) + 1.6)) < 1e-9,
	);
	const c0 = altitudeContourCost([0, 0, alt], p);
	const cB = altitudeContourCost([0, -40, alt], p);
	check(
		"contour cost: 0 on the band, (12/σA)² at the fix",
		Math.abs(cB) < 1e-9 && Math.abs(c0 - 16) < 1e-9,
		`${c0.toFixed(3)} / ${cB.toFixed(3)}`,
	);
	const seeds = isoBandSeeds(p, 8);
	const ok = seeds.every(
		(s) =>
			Math.abs(slope(s[0], s[1]) + 1.6 - alt) <= 3 + 1e-9 &&
			Math.hypot(s[0], s[1]) <= 2 * sH + 1e-9 &&
			Math.abs(s[2] - slope(s[0], s[1]) - 1.6) < 1e-9,
	);
	let sep = Infinity;
	for (let i = 0; i < seeds.length; i++)
		for (let j = i + 1; j < seeds.length; j++)
			sep = Math.min(
				sep,
				Math.hypot(seeds[i][0] - seeds[j][0], seeds[i][1] - seeds[j][1]),
			);
	check(
		"isoBandSeeds: on the band, within 2σH, ≥ σH/4 apart",
		seeds.length > 0 && seeds.length <= 8 && ok && sep >= sH / 4 - 1e-9,
		`${seeds.length} seeds, min sep ${sep.toFixed(1)} m`,
	);
	const r = refineEyeOptions(p);
	check(
		"refineEyeOptions carries σH, σA and the ground",
		r.sigmaH === 30 && r.sigmaV === 3 && r.ground === slope,
	);
}

// 4. fallbacks: empty band, no altitude, pin, flag off, no DEM
{
	const far = eyePriorFromExif(meta(1001.6 - 40, 14), slope, opts); // band at n = −133 m ≫ 2σH = 28 m
	check(
		"iso-band empty within 2σH → gps+dem-floor, eye0 = old rule",
		far.source === "gps+dem-floor" &&
			far.eye0[2] === floorEye(1001.6 - 40, 1000) &&
			!far.isoBand,
		far.reason,
	);
	check(
		"concordEye null on empty band",
		concordEye(meta(1001.6 - 40, 14), slope, { eye: true, opts }) === null,
	);
	check(
		"concordEye null without altitude",
		concordEye(meta(null), slope, { eye: true, opts }) === null,
	);
	check(
		"concordEye null for a pin",
		concordEye({ ...meta(1001.6), fromPin: true }, slope, {
			eye: true,
			opts,
		}) === null,
	);
	check(
		"concordEye null when the flag is off",
		concordEye(meta(1001.6), slope, { eye: false }) === null,
	);
	check(
		"no DEM at the fix → fallback",
		eyePriorFromExif(meta(1000), () => Number.NaN, opts).source ===
			"gps+dem-floor",
	);
	const pin = eyePriorFromExif({ ...meta(null), fromPin: true }, slope);
	check(
		"pin → source 'pin', eye0 = DEM + 1.6",
		pin.source === "pin" && pin.eye0[2] === 1001.6,
	);
}

// 5. flat ground (lake shore): MAP never moves horizontally
{
	const c = concordEye(meta(500 + 1.6 - 1), flat, { eye: true, opts });
	check(
		"flat ground → no horizontal shift",
		!!c && c.shiftM === 0 && Math.abs(c.alt - 501.6) < 1e-9,
		c ? `alt ${c.alt}` : "null",
	);
}

// 6. defaults: altBias shifts the target altitude
{
	const p = eyePriorFromExif(meta(1001.6), slope);
	check(
		"defaults: iso-band target = alt − altBias",
		p.isoBand?.alt === 1001.6 - EYE_PRIOR_DEFAULTS.altBias &&
			p.isoBand.sigmaA === EYE_PRIOR_DEFAULTS.sigmaA,
		`target ${p.isoBand?.alt}`,
	);
}

// 7. concordEye lat/lon matches the offset
{
	const c = concordEye(meta(1001.6 - 12, 30), slope, { eye: true, opts });
	const back = c && offsetLatLon(LAT, LON, c.dE, c.dN);
	check(
		"concordEye lat/lon = fix + (dE, dN)",
		!!c && !!back && back.lat === c.lat && back.lon === c.lon,
	);
	// groundFromHeightAt round trip: a sampler that returns latitude-derived heights
	const g = groundFromHeightAt(LAT, LON, (la) => (la - LAT) * 1e6);
	const dN = 37;
	const want = (offsetLatLon(LAT, LON, 0, dN).lat - LAT) * 1e6;
	check(
		"groundFromHeightAt uses the same offset",
		Math.abs(g(0, dN) - want) < 1e-9,
	);
}

// 8. focal table
{
	const px = { width: 4032, height: 3024 };
	const main = lensEntry("iPhone 11 Pro back triple camera 4.25mm f/1.8", 26);
	const zoom = lensEntry("iPhone 11 Pro back triple camera 4.25mm f/1.8", 48);
	const uw = lensEntry("iPhone 11 Pro back triple camera 1.54mm f/2.4", 13);
	const other = lensEntry("iPhone 12 back dual wide camera 4.2mm f/1.6", 26);
	check(
		"lensEntry: main 26 mm",
		main === LENS_TABLE[0] && main.fScale === 1.0173,
	);
	check(
		"lensEntry: digital zoom (f35 48) → zoom entry",
		zoom === LENS_TABLE[1],
	);
	check("lensEntry: ultra wide", uw === LENS_TABLE[2]);
	check(
		"lensEntry: unknown lens → default",
		other === DEFAULT_LENS && lensEntry(undefined, 26) === DEFAULT_LENS,
	);
	const fp = focalPrior(
		"iPhone 11 Pro back triple camera 4.25mm f/1.8",
		26,
		px,
	);
	const fe = focalPxFromF35(26, px);
	check(
		"focalPrior = focalPxFromF35 × fScale",
		Math.abs(fp.fPx - fe * 1.0173) < 1e-9 &&
			Math.abs(fp.sigmaPx - fp.fPx * 0.0064) < 1e-9,
		`${fp.fPx.toFixed(1)} ± ${fp.sigmaPx.toFixed(1)} px (EXIF ${fe.toFixed(1)})`,
	);
	const crop = focalPrior(
		"x",
		26,
		{ width: 3000, height: 3000 },
		{ width: 4032, height: 3024 },
	);
	check(
		"focalPrior passes the crop through",
		Math.abs(
			crop.fPx -
				focalPxFromF35(
					26,
					{ width: 3000, height: 3000 },
					{ width: 4032, height: 3024 },
				),
		) < 1e-9,
	);
}

check(
	"lensModelFromCamera: 11 Pro 26 → main, 13/14 → ultra wide, other → undefined",
	lensEntry(lensModelFromCamera("iPhone 11 Pro", 26), 26) === LENS_TABLE[0] &&
		lensEntry(lensModelFromCamera("iPhone 11 Pro", 13), 13) === LENS_TABLE[2] &&
		lensEntry(lensModelFromCamera("iPhone 11 Pro", 14), 14) === LENS_TABLE[2] &&
		lensModelFromCamera("iPhone 12", 26) === undefined,
);

console.log(fails ? `\n${fails} FAILED` : "\nall PASS");
process.exit(fails ? 1 : 0);
