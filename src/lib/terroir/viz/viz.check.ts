// node: npx tsx src/lib/terroir/viz/viz.check.ts
import { strict as assert } from "node:assert";
import { FIXTURE_COVER, FIXTURE_PACK } from "../__fixtures__/pack";
import {
	approxDistM,
	aspectWord,
	clockHM,
	formatDist,
	niceTicks,
	parseTz,
	pointInMulti,
	pointInPolygon,
	resampleLine,
	sunIncidenceDeg,
	surfaceNormal,
} from "./geo";
import { splitRuns } from "./runs";
import { sunArc } from "./sunarc";
import { viewStats } from "./view";

// sun arc: 2026-09-07 15:39 local (+02:00) at 46.71N 7.77E
const at = new Date("2026-09-07T15:39:00+02:00");
const arc = sunArc(at, 46.71, 7.77, 120);
const { sunPosition } = await import("../../look/sun");
const s = sunPosition(at, 46.71, 7.77);
console.log("sun at capture", s.azimuth.toFixed(1), s.elevation.toFixed(1));
assert.ok(s.azimuth > 215 && s.azimuth < 245, "az");
assert.ok(s.elevation > 33 && s.elevation < 45, "el");
assert.ok(arc.rise && arc.set, "rise/set");
const day = (arc.set?.t - arc.rise?.t) / 3600000;
console.log(
	"daylight h",
	day.toFixed(2),
	"rise az",
	arc.rise?.az.toFixed(0),
	"set az",
	arc.set?.az.toFixed(0),
);
assert.ok(day > 12 && day < 13.5, "Sept day length");
assert.ok(
	arc.rise?.az > 80 &&
		arc.rise?.az < 100 &&
		arc.set?.az > 260 &&
		arc.set?.az < 280,
);
assert.ok(arc.pts.every((p) => p.el >= 0));
assert.ok(arc.pts.filter((p) => p.hour != null).length >= 12);
assert.equal(clockHM(at, parseTz("+02:00")), "15:39");
assert.equal(clockHM(at, null), "13:39 UTC");

// point in polygon (fixture glacier 1850 square 7.70..7.72 × 46.70..46.72)
const g = FIXTURE_PACK.glaciers[0];
assert.ok(pointInMulti(7.71, 46.71, g.polygons));
assert.ok(!pointInMulti(7.75, 46.71, g.polygons));
const donut = [
	[
		[0, 0],
		[10, 0],
		[10, 10],
		[0, 10],
		[0, 0],
	],
	[
		[4, 4],
		[6, 4],
		[6, 6],
		[4, 6],
		[4, 4],
	],
] as [number, number][][];
assert.ok(pointInPolygon(2, 2, donut));
assert.ok(!pointInPolygon(5, 5, donut));

// aspect words
assert.deepEqual([0, 44, 46, 90, 180, 270, 315, 359].map(aspectWord), [
	"north",
	"northeast",
	"northeast",
	"east",
	"south",
	"west",
	"northwest",
	"north",
]);

// surface normal: plane rising to the north (z = 0.5 y) faces south, slope atan(0.5)=26.6 deg
const n = surfaceNormal([-3, 0, 0], [3, 0, 0], [0, 3, 1.5], [0, -3, -1.5]);
if (!n) throw new Error("surfaceNormal returned null");
assert.ok(Math.abs(n.slope - 26.565) < 0.1, `slope ${n.slope}`);
assert.ok(Math.abs(n.aspect - 180) < 0.1, `aspect ${n.aspect}`);
assert.ok(sunIncidenceDeg(n.normal, [0, -0.6, 0.8]) < 90);
assert.ok(sunIncidenceDeg(n.normal, [0, 0.9, 0.2]) > 90);

// profile resampling
const line = resampleLine({ lat: 46.7, lon: 7.7 }, { lat: 46.7, lon: 7.8 }, 10);
assert.equal(line.length, 11);
assert.ok(Math.abs(line[10].d - approxDistM(46.7, 7.7, 46.7, 7.8)) < 1e-6);
assert.ok(Math.abs(line[5].lon - 7.75) < 1e-9 && line[0].d === 0);

// formatting, ticks, runs
assert.equal(formatDist(820), "820 m");
assert.equal(formatDist(3800), "3.8 km");
assert.equal(formatDist(21400), "21 km");
assert.deepEqual(
	niceTicks(400, 3500, 7),
	[500, 1000, 1500, 2000, 2500, 3000, 3500],
);
const pts = [1, 1, 0, 1, 1].map((ok, i) => ({ x: i, y: 0, dist: 1, ok: !!ok }));
assert.equal(splitRuns(pts, false).length, 2);
assert.equal(
	splitRuns(pts, true).length,
	1,
	"closed ring merges across the seam",
);
assert.equal(splitRuns(pts, true)[0].length, 4);

// view stats over a fake sampler on the fixture cover
const st0 = viewStats(
	(u, v) => ({
		lat: 46.6 + (1 - v) * 0.2,
		lon: 7.6 + u * 0.3,
		h: 500 + u * 1000,
	}),
	FIXTURE_COVER,
);
if (!st0) throw new Error("viewStats returned null");
const st = st0;
console.log(
	"view",
	st.hMin.toFixed(0),
	st.hMax.toFixed(0),
	[...st.cover.keys()].sort((a, b) => a - b),
);
assert.ok(st.hMin < 560 && st.hMax > 1440 && st.cover.size >= 4);
console.log("viz.check OK");
