<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Summit view

A portable WebGPU/WebGL2 example that renders real alpine terrain through the lens of a real photo.
The camera is the solved pose of a phone photo taken on the Niederhorn above Lake Thun (Bernese
Oberland, 7 September 2026). Drag Photo blend to cross-fade the photo over the render: the
shoreline, ridges and skyline line up to within a pixel or two. Peak labels mark summits that
are both in the frame and not hidden behind nearer terrain. Earth curvature toggles the curvature
drop and refraction lift. With it off, distant ridges rise above their position in the photo.

Run `npm start` from this folder (npm adds the ancestor `node_modules/.bin`, so the repository
root's Vite is used), or `npx vite examples/deck/summit-view` from the repository root. Select
the backend with `?backend=webgpu` or `?backend=webgl`. Without a query, the example uses
WebGPU when an adapter is available and falls back to WebGL2 otherwise.

## How it works

`TerrariumTerrainLayer` (`terrarium-terrain-layer.ts`) is a custom deck.gl `Layer` with WGSL
and GLSL shaders. It draws every DEM tile with one instanced, indexed draw call:

- One shared 129 × 129 grid mesh, plus a skirt that hides cracks between zoom levels.
- One instance per tile, carrying the tile's latitude and longitude offsets from the camera
  and its layer in an `rgba8unorm` 2d-array texture.
- The vertex shader decodes Terrarium bytes (`R·256 + G + B/256 − 32768`) with
  `textureLoad`/`texelFetch`, interpolates them bilinearly, and builds the normal from
  neighbouring samples.
- Positions are local east/north/up metres at the camera, using the WGS84 radii of curvature,
  minus the curvature drop `(1 − k)·d² / 2R` with refraction coefficient k = 0.13.

Small-angle polynomials replace large-argument trigonometry, so single-precision shaders stay
within 0.005° of an exact ellipsoid transform out to 150 km. `dem-tiles.ts` mirrors the same
function on the CPU, and the labels use that copy. Shading is a Lambert hillshade with an
approximate afternoon sun, colours by elevation and slope, flat lakes, and exponential distance
haze. The layer borrows the texture: the application creates it, fills one layer per tile as
tiles arrive, and destroys it in `finalize()`.

`SummitView`/`SummitViewport` (`summit-view.ts`) is a perspective view with full yaw, pitch,
roll and vertical field of view. deck.gl's `FirstPersonView` has no roll, which a hand-held photo
almost always has. The terrain uses `COORDINATE_SYSTEM.CARTESIAN` in local metres.

The near plane sits 80 m from the lens. GPS places the lens to within about 30 m, and at zoom
14 the DEM puts this lens 15 m below the summit surface, so terrain closer than 80 m is not
trustworthy.

The photo, the label leaders, dots and text are deck.gl `BitmapLayer`, `LineLayer`,
`ScatterplotLayer` and `TextLayer` layers in a second, pixel-space `OrthographicView`. A
`layerFilter` sends `screen-` layers there. deck.gl sizes `'pixels'` units relative to one focal
distance, so pixel-sized text in a perspective view spanning 5–150 km would shrink to nothing.
The labels are therefore projected on the CPU with the same viewport and placed in screen space.
Label occlusion marches the sight line through the loaded DEM tiles on the CPU.

Tiles come from a quadtree selection. Zoom 14 (about 3 m per pixel) is used near the camera,
zoom 9 is used out to 150 km, and only tiles inside the horizontal view wedge are kept: 77 tiles
for this view. The tiles are fetched six at a time, nearest first.

The camera pose and peak list are typed constants in `scene-data.ts`, with their provenance.

## Tests

`npm run test:visual` (or `node examples/deck/summit-view/scripts/visual-smoke.mjs` from the
repository root) starts Vite on a free port and runs headless Chromium with GPU flags against
both backends. It asserts:

- the requested backend, no page or GPU errors, rendered frames, and at least 90 % of DEM tiles
  loaded;
- four summits project within 1 % of the canvas width of where Rigi's own renderer places them
  for this photo (they agree to under 1 px);
- the render without the photo has a bright sky above shaded, darker terrain;
- the photo blend changes the canvas, and turning curvature off raises distant summits;
- `finalize()` is idempotent, and the default backend falls back to WebGL2 without `navigator.gpu`.

Screenshots go to `$SUMMIT_VIEW_SCREENSHOTS`, or to the OS temp directory by default.
`SUMMIT_VIEW_BACKEND=webgpu` limits the run to one backend.

## Packages

`package.json` lists the versions this example is written against: deck.gl 9.4.0-beta.4,
luma.gl 10.0.0-alpha.2 and math.gl 5 alpha. Inside the Rigi repository they resolve to the root
install, which vendors those versions. The Vite config adds no source aliases. Only public
deck.gl APIs are used (no underscore-prefixed exports). One type-level detail: deck.gl does not
export its `CommonViewState` type by name, so `summit-view.ts` infers it from `View`.

## Data and licences

- **Terrain**: [Mapterhorn](https://mapterhorn.com) Terrarium WebP tiles
  (`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`). The data carries each source's licence, see
  [mapterhorn.com/attribution](https://mapterhorn.com/attribution). This view is drawn mainly from
  swisstopo swissALTI3D (Swiss OGD) and Copernicus GLO-30. Credit: © Mapterhorn.
- **Peaks**: OpenStreetMap `natural=peak` nodes, © OpenStreetMap contributors, available under
  the [ODbL](https://www.openstreetmap.org/copyright).
- **Photo and pose**: `niederhorn.jpg` is Rigi demo photo `demo-01` (`public/demo/manifest.json`).
  The yaw, pitch, roll and field of view were solved by Rigi's skyline matcher against the
  Mapterhorn DEM.

The on-screen attribution line carries the Mapterhorn and OpenStreetMap credits.
