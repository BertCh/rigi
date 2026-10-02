// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure CPU checks for geo/geodesy.ts and geo/lv95.ts. Run: npx tsx checks/geo.check.ts

import assert from 'node:assert/strict';
import {
  EARTH_R,
  REFRACTION_K,
  curvatureDrop,
  elevationAngle,
  geometricHorizon,
  haversine,
  makeFrame
} from '../geo/geodesy';
import {lv95ToWgs84, wgs84ToLv95} from '../geo/lv95';

const SUMMIT = {lat: 46.7102, lon: 7.7733, h: 1919};
const frame = makeFrame(SUMMIT.lat, SUMMIT.lon, SUMMIT.h);

function pass(name: string, detail: string): void {
  console.log(`PASS ${name}: ${detail}`);
}

// 1. Constants and origin.
assert.equal(EARTH_R, 6371008.8);
assert.equal(REFRACTION_K, 0.13);
{
  const o = frame.toEnu(SUMMIT.lat, SUMMIT.lon, SUMMIT.h);
  assert.deepEqual(o, [0, 0, 0]);
  pass('origin', 'toEnu(origin) = [0, 0, 0]');
}

// 1b. Axis signs and scale: +lat is north, +lon is east, and a degree is ~111 km / ~76 km here.
{
  const north = frame.toEnu(SUMMIT.lat + 0.01, SUMMIT.lon, SUMMIT.h);
  const east = frame.toEnu(SUMMIT.lat, SUMMIT.lon + 0.01, SUMMIT.h);
  assert.ok(north[1] > 1100 && north[1] < 1120 && Math.abs(north[0]) < 1e-6, `north ${north}`);
  assert.ok(east[0] > 750 && east[0] < 780 && Math.abs(east[1]) < 1, `east ${east}`);
  assert.equal(frame.toEnu(SUMMIT.lat, SUMMIT.lon, SUMMIT.h + 100)[2], 100);
  const e1 = wgs84ToLv95(SUMMIT.lat, SUMMIT.lon + 0.01);
  const e0 = wgs84ToLv95(SUMMIT.lat, SUMMIT.lon);
  const n1 = wgs84ToLv95(SUMMIT.lat + 0.01, SUMMIT.lon);
  assert.ok(e1.e > e0.e && n1.n > e0.n, 'LV95 axes point east and north');
  pass('axis-signs', `0.01 deg north = ${north[1].toFixed(1)} m, east = ${east[0].toFixed(1)} m`);
}

// 2. ENU round trip to 1 mm over a 150 km box (and a range of heights).
{
  let worst = 0;
  for (let i = 0; i <= 12; i++) {
    for (let j = 0; j <= 12; j++) {
      const east = (i - 6) * 25000;
      const north = (j - 6) * 25000;
      const up = ((i * 7 + j * 3) % 11) * 400 - 1000;
      const geo = frame.toGeo([east, north, up]);
      const back = frame.toEnu(geo.lat, geo.lon, geo.h);
      worst = Math.max(worst, Math.hypot(back[0] - east, back[1] - north, back[2] - up));
    }
  }
  assert.ok(worst < 1e-3, `ENU round trip ${worst} m`);
  pass('enu-roundtrip', `max error ${worst.toExponential(2)} m over +-150 km (limit 1e-3)`);
}

// 3. Frame agrees with the great circle (haversine) to the accuracy of the ellipsoid/sphere gap.
{
  const target = {lat: 46.5586, lon: 8.1218};
  const [east, north] = frame.toEnu(target.lat, target.lon, SUMMIT.h);
  const planar = Math.hypot(east, north);
  const hv = haversine(SUMMIT, target);
  const rel = Math.abs(planar - hv.distance) / hv.distance;
  assert.ok(rel < 3e-3, `planar vs haversine ${rel}`);
  const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
  // The ellipsoid frame and the sphere disagree by ~0.1 deg in bearing at 46.7 N (east-west and
  // north-south radii differ), so this limit is looser than the distance one.
  assert.ok(Math.abs(bearing - hv.bearing) < 0.15, `bearing ${bearing} vs ${hv.bearing}`);
  pass(
    'frame-vs-haversine',
    `${(planar / 1000).toFixed(2)} km vs ${(hv.distance / 1000).toFixed(2)} km (${(rel * 100).toFixed(3)}%), bearing delta ${Math.abs(bearing - hv.bearing).toFixed(4)} deg`
  );
}

// 4. Haversine known values: one degree of latitude on the mean sphere, due east, due north.
{
  const deg = (Math.PI * EARTH_R) / 180;
  const north = haversine({lat: 0, lon: 0}, {lat: 1, lon: 0});
  assert.ok(Math.abs(north.distance - deg) < 1e-3 && Math.abs(north.bearing) < 1e-9);
  const east = haversine({lat: 0, lon: 0}, {lat: 0, lon: 1});
  assert.ok(Math.abs(east.distance - deg) < 1e-3 && Math.abs(east.bearing - 90) < 1e-9);
  const west = haversine({lat: 46, lon: 8}, {lat: 46, lon: 7});
  assert.ok(west.bearing > 269 && west.bearing < 271);
  pass('haversine', `1 deg = ${deg.toFixed(1)} m; bearings 0, 90, ${west.bearing.toFixed(2)}`);
}

// 5. Curvature table of the spec, within 0.1 m of the closed form.
{
  const rows: [number, number][] = [
    [10000, 6.8],
    [23500, 37.7],
    [40000, 109],
    [100000, 683]
  ];
  for (const [d, expected] of rows) {
    const drop = curvatureDrop(d);
    const closed = ((1 - 0.13) * d * d) / (2 * 6371008.8);
    assert.ok(Math.abs(drop - closed) < 0.1);
    assert.ok(Math.abs(drop - expected) < 0.5, `${d}: ${drop} vs table ${expected}`);
  }
  assert.equal(curvatureDrop(12345, 1), 0);
  pass(
    'curvature-drop',
    rows.map(([d]) => `${d / 1000} km ${curvatureDrop(d).toFixed(2)} m`).join(', ')
  );
}

// 6. Geometric horizon from 1919 m: 167.6 km.
{
  const d = geometricHorizon(1919);
  assert.ok(Math.abs(d - 167600) < 100, `${d}`);
  // Round trip: the drop at the horizon distance equals the eye height.
  assert.ok(Math.abs(curvatureDrop(d) - 1919) < 1e-6);
  pass('geometric-horizon', `${(d / 1000).toFixed(2)} km from 1919 m (spec 167.6 km)`);
}

// 7. Elevation angle. k = 1 cancels the drop entirely (refraction bends the ray as the Earth curves).
{
  const flat = elevationAngle([0, 0, 0], [1000, 0, 1000], 1);
  assert.ok(Math.abs(flat - 45) < 1e-12);
  assert.ok(Math.abs(elevationAngle([0, 0, 5], [0, 3000, 5], 1)) < 1e-12);
  // 40 km away, target at eye height: sits 109 m below the eye line.
  const far = elevationAngle([0, 0, 0], [0, 40000, 0]);
  const expected = (-Math.atan(curvatureDrop(40000) / 40000) * 180) / Math.PI;
  assert.ok(Math.abs(far - expected) < 1e-9 && far < 0);
  // Uses planar distance: moving the target along a ring leaves the angle unchanged.
  const a = elevationAngle([0, 0, 0], [3000, 4000, 800]);
  const b = elevationAngle([0, 0, 0], [5000, 0, 800]);
  assert.ok(Math.abs(a - b) < 1e-12);
  pass('elevation-angle', `45 deg flat, 40 km level target ${far.toFixed(4)} deg`);
}

// 8. LV95: Bern reference and round trips.
{
  const bern = wgs84ToLv95(46.951082877, 7.438632495);
  const dBern = Math.hypot(bern.e - 2600000, bern.n - 1200000);
  assert.ok(dBern < 0.25, `Bern ${dBern} m`);
  const back = lv95ToWgs84(2600000, 1200000);
  const hv = haversine(back, {lat: 46.951082877, lon: 7.438632495});
  assert.ok(hv.distance < 2, `inverse Bern ${hv.distance} m`);

  // The two polynomial approximations drift apart away from Bern, so the 1.5 m limit holds over
  // the map's region (Bernese Oberland) and the whole Swiss box only to a few metres.
  const roundTrip = (latMin: number, latMax: number, lonMin: number, lonMax: number): number => {
    let worst = 0;
    for (let lat = latMin; lat <= latMax; lat += 0.05) {
      for (let lon = lonMin; lon <= lonMax; lon += 0.05) {
        const {e, n} = wgs84ToLv95(lat, lon);
        const g = lv95ToWgs84(e, n);
        const dn = (g.lat - lat) * ((Math.PI * EARTH_R) / 180);
        const de = (g.lon - lon) * ((Math.PI * EARTH_R) / 180) * Math.cos((lat * Math.PI) / 180);
        worst = Math.max(worst, Math.hypot(dn, de));
      }
    }
    return worst;
  };
  const worst = roundTrip(46.3, 47.1, 7.2, 8.4);
  const worstSwiss = roundTrip(46.0, 47.6, 6.2, 10.2);
  assert.ok(worst < 1.5, `LV95 round trip ${worst} m`);
  assert.ok(worstSwiss < 4, `LV95 round trip (Switzerland) ${worstSwiss} m`);
  const s = wgs84ToLv95(SUMMIT.lat, SUMMIT.lon);
  // Independent sanity: LV95 is conformal with scale ~1 near Bern, so the planar distance from
  // the datum to the summit must match the great circle to 0.2% (the mean sphere vs the ellipsoid differs by ~0.13% here).
  const planar = Math.hypot(s.e - 2600000, s.n - 1200000);
  const ref = haversine({lat: 46.951082877, lon: 7.438632495}, SUMMIT).distance;
  assert.ok(Math.abs(planar - ref) / ref < 2e-3, `${planar} vs ${ref}`);
  pass(
    'lv95',
    `Bern off by ${dBern.toFixed(3)} m, round trip max ${worst.toFixed(3)} m (Switzerland ${worstSwiss.toFixed(2)} m), summit E ${s.e.toFixed(0)} N ${s.n.toFixed(0)}`
  );
}

console.log('geo.check: all passed');
