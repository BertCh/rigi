// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Offline bake: turns the Rigi demo manifest and trail extract into the three small JSON files
// this example ships (data/stations.json, data/peaks-niederhorn.json, data/trails-niederhorn.json).
// Run from anywhere: `node examples/deck/landeskarte/scripts/bake-data.mjs`.
//
// Inputs (read only, relative to the repository root):
//   public/demo/manifest.json  photos[] (EXIF time/position/heading), poses{} (solved angles),
//                              region.peaks[] (OSM natural=peak)
//   public/demo/trails.json    OSM highway=path/track ways with an sac_scale class
// No pixel of any photo is read: stations are geometry only.

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(here, '..');
const demoRoot = resolve(exampleRoot, '../../../public/demo');
const outDir = join(exampleRoot, 'data');

// Keep in sync with data/scene-data.ts.
const DAY_UTC_MS = Date.UTC(2026, 8, 7);
const SUMMIT = {lat: 46.710169444444446, lon: 7.773319444444445};
const BBOX = {west: 7.66, south: 46.64, east: 7.89, north: 46.78};
const PEAK_RADIUS_M = 80000;

const ODBL = 'OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)';

const EARTH_R = 6371008.8;

/** Equirectangular distance in metres; plenty for thinning and radius cuts at 80 km. */
function planarDistance(a, b) {
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * (Math.PI / 180) * Math.cos(meanLat) * EARTH_R;
  const dy = (b.lat - a.lat) * (Math.PI / 180) * EARTH_R;
  return Math.hypot(dx, dy);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function slug(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** One JSON object per line: small diffs, and still compact. */
function writeRows(file, header, key, rows) {
  const body = rows.map(row => `    ${JSON.stringify(row)}`).join(',\n');
  const head = Object.entries(header)
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)},\n`)
    .join('');
  const text = `{\n${head}  ${JSON.stringify(key)}: [\n${body}\n  ]\n}\n`;
  writeFileSync(join(outDir, file), text);
  return Buffer.byteLength(text);
}

const manifest = JSON.parse(readFileSync(join(demoRoot, 'manifest.json'), 'utf8'));
mkdirSync(outDir, {recursive: true});

// ---- Stations -------------------------------------------------------------------------------
// Position, time, heading and f35 come from the photo's EXIF. yaw/pitch/roll/vfov and confidence
// come from manifest.poses[id] (source 'solved'). `h` is the EXIF GPS altitude: the manifest holds
// no separately corrected lens height (except the demo-09 override below). The solved vfov replaces the EXIF-derived photo.vfov.
// demo-09 was shot from a lower point than its GPS fix says: EXIF altitude 1183 m at a position
// 100 m from the summit is a GPS error (the solved pose looks out from the ridge), so the spec
// pins it to the ridge height.
const ALTITUDE_OVERRIDES = {'demo-09': 1935.4};

const stations = manifest.photos.map(photo => {
  const solved = manifest.poses[photo.id];
  if (!solved || solved.source !== 'solved') {
    throw new Error(`no solved pose for ${photo.id}`);
  }
  return {
    id: photo.id,
    takenAtUtc: photo.takenAtUtc,
    minutes: round((Date.parse(photo.takenAtUtc) - DAY_UTC_MS) / 60000, 3),
    lat: round(photo.lat, 6),
    lon: round(photo.lon, 6),
    h: round(ALTITUDE_OVERRIDES[photo.id] ?? photo.alt, 2),
    yaw: round(solved.pose.yaw, 3),
    pitch: round(solved.pose.pitch, 3),
    roll: round(solved.pose.roll, 3),
    vfov: round(solved.pose.vfov, 3),
    aspect: round(photo.width / photo.height, 4),
    f35: photo.f35,
    exifHeading: typeof photo.heading === 'number' ? round(photo.heading, 2) : null,
    confidence: round(solved.confidence, 3)
  };
});
const stationBytes = writeRows(
  'stations.json',
  {
    _licence:
      'Rigi pose-solver output on photos taken by the project author, 2026-09-07. Geometry only, no pixels. Solved poses are not ground truth.',
    _source: 'public/demo/manifest.json photos[] + poses{}',
    _dayUtc: '2026-09-07T00:00:00Z'
  },
  'stations',
  stations
);

// ---- Peaks ----------------------------------------------------------------------------------
// Tiering is cartographic, not hand-picked per summit: isolation is the distance to the nearest
// higher peak in the set (a prominence proxy; the OSM tags carry no usable prominence).
const MAJOR_NAMES = new Set([
  'Eiger',
  'Mönch',
  'Jungfrau',
  'Schreckhorn',
  'Finsteraarhorn',
  'Wetterhorn',
  'Blüemlisalphorn',
  'Doldenhorn',
  'Stockhorn',
  'Niesen',
  'Niederhorn',
  'Gemmenalphorn',
  'Brienzer Rothorn',
  'Hohgant',
  'Sigriswiler Rothorn',
  'Morgenberghorn',
  'Aletschhorn',
  'Balmhorn',
  'Altels',
  'Gspaltenhorn',
  'Bietschhorn',
  'Wildstrubel',
  'Titlis',
  'Wildhorn',
  'Grosses Fiescherhorn',
  'Gross Grünhorn',
  'Dammastock'
]);

const candidates = manifest.region.peaks
  .filter(peak => typeof peak.ele === 'number' && peak.name)
  .map(peak => ({
    name: peak.name,
    lat: peak.lat,
    lon: peak.lon,
    ele: peak.ele,
    distance: planarDistance(SUMMIT, peak)
  }))
  .filter(peak => peak.distance <= PEAK_RADIUS_M);

// Equal elevations tie-break by name so the bake is deterministic.
const byHeight = [...candidates].sort((a, b) => b.ele - a.ele || a.name.localeCompare(b.name));
byHeight.forEach((peak, index) => {
  let isolation = Infinity;
  for (let other = 0; other < index; other++) {
    isolation = Math.min(isolation, planarDistance(peak, byHeight[other]));
  }
  peak.isolation = isolation;
});

function tierOf(peak) {
  const named = MAJOR_NAMES.has(peak.name) && peak.ele >= 1900 && peak.distance < 70000;
  if (named) return 'peak-major';
  if (peak.ele >= 2000 && peak.isolation >= 6000 && peak.distance < 60000) return 'peak-major';
  if (peak.ele >= 2000 && peak.isolation >= 2500 && peak.distance < 45000) return 'peak';
  if (peak.ele >= 2400 && peak.isolation >= 4000 && peak.distance < 70000) return 'peak';
  // Near the summit, lower tops still read as landmarks of the foreground.
  if (peak.ele >= 1500 && peak.isolation >= 1500 && peak.distance < 12000) return 'peak';
  if (peak.ele >= 800 && peak.isolation >= 900 && peak.distance < 9000) return 'minor';
  return null;
}

const usedIds = new Set();
const peaks = byHeight
  .map(peak => ({peak, tier: tierOf(peak)}))
  .filter(({tier}) => tier !== null)
  .map(({peak, tier}) => {
    let id = `${slug(peak.name)}-${Math.round(peak.ele)}`;
    for (let n = 2; usedIds.has(id); n++) id = `${slug(peak.name)}-${Math.round(peak.ele)}-${n}`;
    usedIds.add(id);
    return {
      id,
      name: peak.name,
      lat: round(peak.lat, 5),
      lon: round(peak.lon, 5),
      ele: peak.ele,
      tier
    };
  });
const peakBytes = writeRows(
  'peaks-niederhorn.json',
  {
    _licence: `Peaks: ${ODBL}. Derivative extract: offered under ODbL.`,
    _source: 'public/demo/manifest.json region.peaks, thinned by elevation and isolation',
    _radiusMeters: PEAK_RADIUS_M
  },
  'peaks',
  peaks
);

// ---- Trails ---------------------------------------------------------------------------------
// Ways are clipped to BBOX: runs of vertices inside the box, plus the neighbouring vertex on each
// side so a line still leaves the frame instead of stopping short of the edge.
function inside([lon, lat]) {
  return lon >= BBOX.west && lon <= BBOX.east && lat >= BBOX.south && lat <= BBOX.north;
}

function clipWay(coords) {
  const runs = [];
  let run = null;
  for (let i = 0; i < coords.length; i++) {
    if (inside(coords[i])) {
      if (!run) {
        run = [];
        if (i > 0) run.push(coords[i - 1]);
      }
      run.push(coords[i]);
    } else if (run) {
      run.push(coords[i]);
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs.filter(r => r.length >= 2);
}

const THIN_METERS = 10;

/** Drops vertices closer than ~10 m to the previous kept one (keeps the last). Inputs are 6 dp. */
function thin(coords) {
  const kept = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const [lon, lat] = coords[i];
    const [pLon, pLat] = kept[kept.length - 1];
    const dx = (lon - pLon) * 76000;
    const dy = (lat - pLat) * 111200;
    if (Math.hypot(dx, dy) >= THIN_METERS) kept.push(coords[i]);
  }
  kept.push(coords[coords.length - 1]);
  return kept;
}

const rawTrails = JSON.parse(readFileSync(join(demoRoot, 'trails.json'), 'utf8'));
const trails = [];
// Only graded (sac_scale) paths: roads and farm tracks are not hiking context and the legend
// lists hiking classes only.
for (const way of rawTrails.filter(candidate => candidate.sac)) {
  for (const part of clipWay(way.coords)) {
    const coords = thin(part).map(([lon, lat]) => [round(lon, 5), round(lat, 5)]);
    if (coords.length < 2) continue;
    // `name` is omitted when absent to save bytes; load.ts restores null.
    const row = {id: `w${trails.length}`, sac: way.sac, coords};
    if (way.name) row.name = way.name;
    trails.push(row);
  }
}
const trailBytes = writeRows(
  'trails-niederhorn.json',
  {
    _licence: `Trails: ${ODBL}. Derivative extract: offered under ODbL.`,
    _source: 'public/demo/trails.json clipped to bbox, graded paths only, vertices thinned to 10 m',
    _bbox: BBOX
  },
  'trails',
  trails
);

const tierCounts = peaks.reduce((counts, peak) => {
  counts[peak.tier] = (counts[peak.tier] ?? 0) + 1;
  return counts;
}, {});
console.log(`stations ${stations.length} (${stationBytes} B)`);
console.log(`peaks ${peaks.length} ${JSON.stringify(tierCounts)} (${peakBytes} B)`);
console.log(`trails ${trails.length} ways of ${rawTrails.length} (${trailBytes} B)`);
if (peakBytes > 40e3 || trailBytes > 300e3 || stationBytes > 10e3) {
  console.error('warning: an output exceeds its size budget');
  process.exitCode = 1;
}
