# Wild v3: held-out benchmark (FROZEN)

**This set is held out. No method may be developed, tuned, debugged or sanity-checked on it.** Do not open these photos
in the app, and do not render overlays of them. Do not use them for threshold picking, and do not use them to spot-check a
change. Evaluate the set **once**, with a pre-registered method and accept rule, and then report the numbers as they are.
A second evaluation must be labelled post hoc.

It replaces the test half of `tools/bench/data` (split.json), which was spent on 2026-09-26.

- `manifest.json`: same schema as `data/manifest.json`, with ids `w3_0001`…`w3_0074`. There is one extra tag,
  `tags.country`, which is `CH` or `other`.
- `photos/`: Wikimedia Commons photos, resized to at most 2048 px on the long edge (JPEG q88). The set is 74 photos
  (about 41 MB).
- `ATTRIBUTION.md`: the author, licence and file page for each photo. All licences are free (CC BY / BY-SA / CC0 / PD).
- `FROZEN.sha1`: the sha1 of `manifest.json`, the freeze timestamp, and a digest of the photos. Check it before
  evaluating. If it does not match, the set has been changed and is no longer this frozen set.

## Contents

- `w3_0001`–`w3_0060` are 60 Swiss photos.
- `w3_0061`–`w3_0074` are 14 non-Swiss mountain photos: 2 each from the French Alps, the Italian Alps/Dolomites, the
  Julian Alps, the Tatra, the Pyrenees, Tenerife and North America (Rockies/Sierra).
- Report the Swiss 60 and the non-Swiss 14 separately. Outside CH the DEM is Mapterhorn z15–16.

| stratum | Swiss 60 | non-Swiss 14 |
|---|---|---|
| focalClass tele / normal / wide / unknown | 18 / 16 / 13 / 13 | 2 / 3 / 5 / 4 |
| skylineDist near / far | 34 / 26 | 8 / 6 |
| season summer / winter | 38 / 22 | 12 / 2 |
| weather clear / cloudy / clouds_on_skyline | 35 / 13 / 12 | 8 / 2 / 4 |
| headingKnown yes / no | 32 / 28 | 8 / 6 |
| positionSource exif-gps / manual | 28 / 32 | 6 / 8 |
| hard yes / no | 25 / 35 | 5 / 9 |

Swiss regions: graubuenden 9, central 9, valais 8, vaud 8, ticino 8, bernese 7, jura 5, appenzell 3, glarus 3.
All 74 photos have Commons `coordType: camera`.

## Provenance and disjointness

The set was built by `tools/bench/collect_v3/` (see `run.sh`), which reads the v1 collection read-only.
- Candidates come from the v1 Commons metadata, plus extra metadata fetched for under-represented Swiss regions, plus a
  small geosearch at 18 non-Swiss mountain points.
- **None of the 100 v1 photos is included.** Candidates were also dropped if they matched a v1 photo in any of these
  ways:
  - same author, within 3 km, and the same day (or an unknown date): this removed 127 candidates;
  - within 150 m of any v1 camera position;
  - by a v1 author within 2 km of that author's v1 photo, on any date.
- Within the set: at most 2 photos per author, at most 1 per ~2 km cell, and at most 1 per author per day.

Screening was visual only, from contact sheets (`collect_v3/screen_notes.txt`). No pose-estimation method was run on
these photos, and no render overlays were made.
