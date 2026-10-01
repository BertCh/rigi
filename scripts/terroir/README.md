# Terroir pack builder

Bakes the data side of the terroir cartography feature (`reports/terroir-cartography.md` section 4 phase 1) into
`public/terroir/`. The contract is `src/lib/terroir/types.ts`; the loader is `src/lib/terroir/pack.ts`.
Display only: nothing here feeds the matcher, pose or measurements.

## Rebuild

```
npx tsx scripts/terroir/build-pack.ts --id thunersee --bbox 7.35,46.45,8.25,46.95 --name "Thunersee · Bernese Oberland"
npx tsx scripts/terroir/inspect-pack.ts thunersee   # counts, top names, histogram, glacier years, sizes
npx tsx scripts/terroir/pack.check.ts               # schema + sanity points (pure node)
```

`pack.check.ts` runs in the CI fast tier as `terroir-pack`.

Shader identity proofs (not pack tools): `shader-identity-snap.ts` (deck WebGL terrain shaders) and
`wgsl-identity-snap.ts` (deck-webgpu terrain-styles WGSL) dump the terrain programs with every terroir switch off;
diffing a run before and after a change proves the terroir shading is additive. Usage is in each file's header.

Output: `public/terroir/index.json` (entries merged by id, others kept) and `public/terroir/<id>/{pack.json,cover.png}`.
Everything is fetched by node at build time and cached in `TERROIR_CACHE` (default `~/.cache/rigi/terroir`; about 350 MB
extracted, of which the swissNAMES3D shapefiles are most). Delete the cache dir to free disk; the next run re-downloads.
No npm dependencies: PNG, shapefile/dBase, LV95 and scanline rasteriser code is in `lib/`. Needs the system `unzip`.

## Sources actually used

| Layer | Source | Licence / credit |
|---|---|---|
| Names | swissNAMES3D 2026 (data.geo.admin.ch STAC: CSV for anchors + Z, shapefile for line/polygon geometry) | swisstopo OGD, "© swisstopo" |
| Peak tiers | OSM peak prominence/ele from the bundled region JSON (`public/demo/manifest.json`, `public/photos/region-*.json`) | ODbL, "© OpenStreetMap contributors" |
| Cover base | swisstopo VECTOR25 primary surfaces (`ch.swisstopo.vec25-primaerflaechen`), WMS render at 25 m, classified by palette | swisstopo OGD |
| Cover refinement | OSM via Overpass: scree/shingle, vineyard, orchard, `leaf_type` woods (one query) | ODbL |
| Cover refinement | AWS Terrarium DEM z12 (elevation rules) and GLAMOS SGI 2016/2023 (glacier vs firn) | see below |
| Glaciers | GLAMOS Swiss Glacier Inventory 1850, 1931 (LV03), 1973, 2016, 2023 (doi.glamos.ch) | CC BY 4.0 |
| Lithology | swisstopo GK500 lithology main groups (`Lithologie_Aggregiert`, LV03) | swisstopo OGD |
| Elevation | AWS Terrarium tiles (names without Z, glacier vertices, cover rules) | Mapzen / terrain-tiles attribution |

The API `identify` endpoint is capped at about 50 features per call, so the full swissNAMES3D file is used instead.
`index.json`/`pack.json` keep swisstopo and OSM as separate `sources[]` entries. OSM geometry is never merged into any
swisstopo-derived vector record; OSM contributes only to the baked cover raster (a produced work, attributed) and to
OSM-only peak names (`src: "osm"`, only where swissNAMES3D has no peak within 300 m).

## How the pieces are derived

- **Names**: objektart -> `NameClass`. Peaks: `Hauptgipfel`/`Gipfel`/`Alpiner Gipfel` tiered by matched OSM prominence
  (>= 300 m major, >= 100 m peak, else minor; no match: Hauptgipfel >= 3500 m major, Hauptgipfel/Alpiner/>= 2200 m peak).
  `Haupthuegel`/`Felskopf` -> peak-minor. Places by `EINWOHNERKATEGORIE` (>= 10k city, >= 1k town, >= 100 village,
  20-99 hamlet; < 20 dropped). Huts, alps and lifts come from name patterns and `Luftseilbahn`/`Gondelbahn`/`Sesselbahn`.
  Official + usual/informal variants of one name group are merged (`alt`). Anchors: Z from swissNAMES3D, else DEM;
  polygon label point = coarse pole of inaccessibility; lines get a downsampled `line` and an along-line midpoint anchor;
  elongated ridge/valley polygons get a binned medial `line`. Per-class caps and a 4000 budget trim the long tail.
- **Cover** classes: VECTOR25 gives ice, rock, forest, open land, built, water and shrub forest. Rules on top:
  forest below 750 m -> broadleaf (6) unless OSM `leaf_type` says otherwise; open land >= 1400 m -> alpine pasture (8),
  >= 2500 m -> scree (4); OSM scree -> 4 on rock; OSM vineyard/orchard -> 10/11; ice outside the SGI 2016/2023 outlines
  above 2400 m -> firn (2). Cell size is about 25 m; row 0 is north, plain lon/lat grid; class in R (8-bit grey PNG).
- **Glaciers**: Douglas-Peucker 15-20 m in LV95, clipped to the bbox, per-vertex `heights` from the DEM, names by SGI id
  from the 2016/2023 inventories (1850/1931/1973 outlines carry the name of their successor glacier).
- **Lithology**: GK500 main groups mapped to the `LithologyUnit` classes by keyword, simplified at 120 m. Water and ice
  polygons are skipped.

## Known gaps

- No swissTLM3D land cover (the TLM is multi-GB) and no GeoCover (1:25k geology): cover comes from the VECTOR25 render and
  geology is the 1:500k GK500, which is coarse and has no separate flysch unit (Mergelschiefer/Kalkphyllite -> `marl-shale`).
- VECTOR25 has no conifer/broadleaf split and no scree class; both are inferred (elevation rule, OSM overlays) and the
  OSM tag coverage is patchy. Vineyard/orchard exist only where OSM maps them (practically none in this bbox).
- Antialiased WMS edges and the "open forest" hatch are snapped to the nearest palette colour, so thin features
  (small streams) can be broken up.
- Ridge and valley names have an approximate medial line only when the polygon is elongated; rivers use the real line.
- Peak prominence is only known where the bundled OSM region data carries it.
- Terrarium is a mixed-resolution DEM: heights of vertices on glaciers are good to a few metres at best.
- Only one pack (thunersee) is built; pass `--bbox`/`--id` for others. Coverage outside Switzerland would need
  WorldCover/RGI; not implemented.
