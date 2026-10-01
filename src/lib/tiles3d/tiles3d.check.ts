// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Self-contained checks for Step Inside 3D Tiles (src/lib/tiles3d). Run: npx tsx src/lib/tiles3d/tiles3d.check.ts
// Exits 1 on any failure (prints every failure). Covers the pure parts: geoid lookup, the ECEF → ENU
// placement, the per-source datum, flag parsing and the display-only rules of the source table.
import * as THREE from "three";
import { EnuFrame, toEcef } from "../geodesy";
import { parseTiles3DSources, TILES3D_SOURCES } from "./config";
import { enuFromEcef } from "./frame";
import { geoidUndulation } from "./geoid";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(
		`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`,
	);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// EGM2008 N from PROJ (EPSG:4979 → EPSG:4326+3855, us_nga_egm08_25), 2026-09-29
for (const [name, lat, lon, n] of [
	["Niederhorn", 46.71, 7.77, 50.543],
	["Zermatt", 46.02, 7.75, 54.684],
	["Rigi", 47.056, 8.485, 48.401],
] as const) {
	const g = geoidUndulation(lat, lon);
	check(`geoid ${name}`, near(g, n, 0.2), `${g.toFixed(3)} vs ${n}`);
}
// outside the Alps grid: the 1° global fallback (Utah ≈ −17 m, Tenerife ≈ +50 m in EGM2008)
const utah = geoidUndulation(40.599, -111.607);
check(
	"geoid global fallback (Utah)",
	utah < -10 && utah > -25,
	utah.toFixed(2),
);
check(
	"geoid wraps longitude",
	near(geoidUndulation(10, 179.9), geoidUndulation(10, -180.1), 0.5),
);

// ENU placement: the photo's own point at ellipsoid height h lands at (0, 0, h - N)
const lat = 46.7197;
const lon = 7.7014;
for (const N of [0, 50.4]) {
	const m = enuFromEcef(lat, lon, N);
	const p = new THREE.Vector3(...toEcef(lat, lon, 800)).applyMatrix4(m);
	check(
		`enu origin N=${N}`,
		near(p.x, 0, 1e-6) && near(p.y, 0, 1e-6) && near(p.z, 800 - N, 1e-6),
		p
			.toArray()
			.map((v) => v.toFixed(6))
			.join(","),
	);
}
// …and agrees with geodesy.ts EnuFrame (without its refraction lift, negligible at 1 km)
{
	const m = enuFromEcef(lat, lon, 0);
	const f = new EnuFrame(lat, lon, 0);
	const q = f.fromGeo(lat + 0.009, lon + 0.013, 900);
	const qe = new THREE.Vector3(
		...toEcef(lat + 0.009, lon + 0.013, 900),
	).applyMatrix4(m);
	const d = Math.hypot(q[0] - qe.x, q[1] - qe.y, q[2] - qe.z);
	check("enu matches EnuFrame (1.3 km)", d < 0.2, `${d.toFixed(3)} m`);
}

// sources: Google is the only display-only, ellipsoidal one; swisstopo stores MSL in the ellipsoid slot
check(
	"google display-only",
	TILES3D_SOURCES.google.displayOnly &&
		TILES3D_SOURCES.google.heights === "ellipsoidal",
);
check(
	"swisstopo msl + measurable",
	!TILES3D_SOURCES["swisstopo-buildings"].displayOnly &&
		TILES3D_SOURCES["swisstopo-buildings"].heights === "msl" &&
		TILES3D_SOURCES["swisstopo-vegetation"].heights === "msl",
);
check(
	"depth bias < 1",
	Object.values(TILES3D_SOURCES).every(
		(s) => s.depthBias > 0.9 && s.depthBias < 1,
	),
);

// flags: off by default
check(
	"flag default off",
	parseTiles3DSources(null).length === 0 &&
		parseTiles3DSources("off").length === 0,
);
check(
	"flag swisstopo",
	parseTiles3DSources("swisstopo").join() ===
		"swisstopo-buildings,swisstopo-vegetation",
);
check("flag google", parseTiles3DSources("google").join() === "google");
check("flag all", parseTiles3DSources("ALL").length === 3);

if (failed) {
	console.log(`${failed} failed`);
	process.exit(1);
}
console.log("tiles3d: all checks passed");
