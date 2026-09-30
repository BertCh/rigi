// npx tsx src/lib/geocam/priors/priors.check.ts — WMM2025 against NOAA's official test values, the
// declination-corrected heading prior, and the GEO flags' defaults. Exit 1 on failure.
import { FLAG_NAMES, FLAG_SCHEMA, RESTART_FLAGS } from "../../flags";
import { IDX, NP } from "../core";
import { headingDeclination, isMagneticRef, priorHeading } from "./heading";
import { mapPriorsFromPhoto, sigmaHFromHAcc } from "./photo-priors";
import { magField } from "./wmm";
import { WMM2025_TEST_VALUES } from "./wmm-test-values";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	if (!cond) {
		fails++;
		console.error(`FAIL ${msg}`);
	}
};
const dAng = (a: number, b: number) => ((((a - b) % 360) + 540) % 360) - 180;

// 1. WMM2025: all 100 NOAA test points (D printed to 0.01°, X/Y/Z to 1e-6 nT)
let worstD = 0;
let worstXYZ = 0;
for (const [yr, altKm, lat, lon, D, X, Y, Z] of WMM2025_TEST_VALUES) {
	const f = magField(lat, lon, altKm * 1000, yr);
	worstD = Math.max(worstD, Math.abs(dAng(f.decl, D)));
	worstXYZ = Math.max(
		worstXYZ,
		Math.abs(f.X - X),
		Math.abs(f.Y - Y),
		Math.abs(f.Z - Z),
	);
}
ok(WMM2025_TEST_VALUES.length === 100, "100 NOAA test values");
ok(
	worstD <= 0.0051,
	`WMM D worst |Δ| ${worstD.toFixed(4)}° ≤ 0.005° (rounding)`,
);
ok(
	worstXYZ < 0.01,
	`WMM X/Y/Z worst |Δ| ${worstXYZ.toExponential(2)} nT < 0.01`,
);
// the Bernese Oberland in 2025: D ≈ +3.3° (east); sanity only
const decl = magField(46.71, 7.77, 1900, new Date("2025-08-01T12:00:00Z")).decl;
ok(
	decl > 2.5 && decl < 4,
	`Thun 2025 declination ${decl.toFixed(2)}° in (2.5, 4)`,
);

// 2. heading prior
const base = {
	lat: 46.71,
	lon: 7.77,
	alt: 1900,
	takenAt: "2025-08-01T12:00:00Z",
	takenAtUtc: "2025-08-01T12:00:00Z",
};
const mag = { ...base, heading: 100, local: { headingRef: "M" } };
const tru = { ...base, heading: 100, local: { headingRef: "T" } };
const none = { ...base, heading: 100 };
const noHeading = { ...base, heading: null, local: { headingRef: "M" } };
ok(priorHeading(mag, false) === 100, "flag off: magnetic heading unchanged");
ok(priorHeading(tru, false) === 100, "flag off: true heading unchanged");
ok(priorHeading(noHeading, true) === null, "no heading stays null");
ok(priorHeading(tru, true) === 100, "flag on: T ref unchanged");
ok(priorHeading(none, true) === 100, "flag on: no ref (bundled) unchanged");
const d = headingDeclination(mag) as number;
ok(
	Math.abs((priorHeading(mag, true) as number) - (100 + d)) < 1e-9,
	"flag on: M ref gets + declination",
);
ok(
	Math.abs(
		(priorHeading({ ...mag, heading: 359 }, true) as number) -
			((359 + d) % 360),
	) < 1e-9,
	"wraps into [0, 360)",
);
ok(
	isMagneticRef("M") && isMagneticRef("m") && !isMagneticRef("T"),
	"ref parse",
);
ok(
	priorHeading(mag) === 100,
	"default (no override): geoDecl is off, heading unchanged",
);

// 3. every geo* flag exists, defaults off; the engine-construction ones restart the engine
const geo = FLAG_NAMES.filter((n) => n.startsWith("geo"));
for (const want of [
	"geoDecl",
	"geoLakeFloor",
	"geoLakes",
	"geoInliers",
	"geoMap",
])
	ok((geo as string[]).includes(want), `flag ${want} declared`);
for (const n of geo) {
	const def = FLAG_SCHEMA[n] as { kind: string; def?: string };
	ok(def.kind === "enum" && def.def === "off", `${n} defaults off`);
}
ok(
	RESTART_FLAGS.includes("geoDecl") && RESTART_FLAGS.includes("geoLakeFloor"),
	"geoDecl / geoLakeFloor are restart flags",
);

// 4. photo → prior factors
const photo = {
	...mag,
	hAccuracy: 2,
	pitch: 3,
	roll: -1,
	gravity: [0, -1, 0],
	local: { headingRef: "M" },
};
const fs = mapPriorsFromPhoto(photo, [0, 0, 0], (e, n) => 1890 + 0 * (e + n), {
	zDatum: 1900,
	lakeFloorM: 1905,
});
ok(
	fs.map((f) => f.family).join(",") ===
		"gps,alt,ground,gravity,compass,lakeFloor",
	`families ${fs.map((f) => f.family).join(",")}`,
);
ok(
	sigmaHFromHAcc(2) === 5 &&
		sigmaHFromHAcc(null) === 20 &&
		sigmaHFromHAcc(500) === 100,
	"σH clamp",
);
const x = new Float64Array(NP);
x[IDX.E] = 10;
x[IDX.yaw] = (100 + d) % 360;
const r = (fam: string) =>
	fs.find((f) => f.family === fam)?.residual(x)[0] ?? Number.NaN;
ok(Math.abs(r("gps") - 10 / 5) < 1e-9, "gps residual uses the clamped σH");
ok(
	Math.abs(r("compass")) < 1e-9,
	"compass is TRUE north (declination applied)",
);
ok(
	r("lakeFloor") > 0 && Number.isFinite(r("lakeFloor")),
	"lake floor binds at U = 0 < 5 m",
);
x[IDX.U] = 6;
ok(r("lakeFloor") === 0, "lake floor inactive above");
const pinned = mapPriorsFromPhoto(
	{ ...photo, heading: null, gravity: null, local: { positionSource: "pin" } },
	[0, 0, 0],
);
ok(pinned.length === 0, `pinned, no sensors → no priors (${pinned.length})`);

console.log(
	`priors.check: WMM worst ΔD ${worstD.toFixed(4)}°, ΔXYZ ${worstXYZ.toExponential(1)} nT; Thun D ${decl.toFixed(2)}°; ${fails ? `${fails} FAILED` : "all passed"}`,
);
process.exit(fails ? 1 : 0);
