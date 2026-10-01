<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Photo drape

A portable WebGPU/WebGL2 example that projects a real photo onto real alpine terrain from the
camera that took it, then lets you orbit around the result. This is Rigi's "In map" mode. The photo
was taken on the Niederhorn above Lake Thun (Bernese Oberland, 7 September 2026). It is projected
from its solved pose like a slide projector. A shadow map makes sure only surfaces the camera
actually saw receive photo pixels. Slopes hidden behind ridges keep a plain hillshade, and **Show
shadowed areas** tints them. **Fly into the photo** animates the orbit camera into the photo
camera: at the end of the flight the canvas is the photo again, now drawn on terrain.

The examples resolve `@luma.gl/*` and `@deck.gl/*` from this repository's vendored tarballs (`vendor/`), so run them from this repository (after `npm install` at the root); they are not meant to be copied out on their own.

Run `npm start` from this folder (npm adds the ancestor `node_modules/.bin`, so the repository
root's Vite is used), or `npx vite examples/deck/photo-drape` from the repository root. Select the
backend with `?backend=webgpu` or `?backend=webgl`. Without a query, the example uses WebGPU when
an adapter is available and falls back to WebGL2 otherwise.

## How it works

Two passes, as in shadow mapping, with the photo camera as the light:

1. **Shadow map, once per pose.** `PhotoDrapeEffect` (`photo-drape-effect.ts`) is a deck.gl
   `Effect`, the public hook deck.gl's own `LightingEffect` uses for its shadow maps. Its
   `preRender` runs before deck.gl's layer pass, outside any render pass. When the photo pose or the
   terrain changed, it begins a luma.gl render pass on its own `Framebuffer`: an `r16float` colour
   target of 1024 × 768 texels (the photo's 4:3, about 0.07° per texel) plus `depth24plus`. It asks
   each `PhotoDrapeTerrainLayer` to draw its terrain from the photo camera. The layer draws a
   second luma.gl `Model`, built from plain WGSL/GLSL without deck.gl's project module, that shares
   the terrain mesh and tile buffers. That model writes the range from the lens in kilometres. On
   every other frame `preRender` returns at once, so orbiting costs no extra pass
   (`diagnostics.shadowMapPasses` stays 1). The pass waits until every DEM tile has loaded, so a
   partly streamed terrain is never baked in.
2. **Drape, every frame.** The effect's `getShaderModuleProps` hands the layer's `photoDrape`
   shader module (`photo-drape-module.ts`) the photo camera's view-projection matrix, the photo
   (mipmapped `DynamicTexture`) and the shadow map. In the terrain's fragment shader,
   `photoDrape_apply` projects the fragment into the photo. Inside the frame, it compares the
   fragment's range with the nearest range the shadow map recorded. The bias is 1 % of range +
   10 m + a slope-scaled term (`1.5 · range · texelAngle / sin(incidence)`), and back faces never
   pass. The four nearest texels vote and are weighted bilinearly (percentage-closer filtering).
   Seen fragments take the photo colour, blended by Drape opacity. Unseen ones keep the hillshade,
   or take a purple tint with Show shadowed areas. WebGPU render targets store row 0 at the top and
   WebGL2 targets at the bottom; each shader language reads the shadow map its own way.

The terrain itself is the Terrarium tile mesh of the [summit view](../summit-view) example: one
instanced draw call over a shared 129 × 129 grid, decoded in the vertex shader. It is placed in
local east/north/up metres with earth curvature and refraction, shaded with a hillshade and haze
measured from the viewing camera. The tile selection keeps the photo's 150 km view wedge and adds
every tile within 25 km in all directions, so the orbit view has context: 158 tiles.

**Orbit view with roll.** `PhotoOrbitView` (`photo-orbit-view.ts`) is deck.gl's `OrbitView`
(orbit axis Z, `OrbitController`) with a viewport that can roll. A hand-held photo almost always
has some roll (−2.4° here), which `OrbitViewport` cannot express. The roll is folded into the
viewport's projection matrix. The view uses the photo's vertical field of view (52.1°), and the
canvas keeps the photo's 4:3 aspect.

**Flying in.** `flyIntoPhoto()` is a deck.gl view-state transition (`LinearInterpolator` over
`target`, `zoom`, `rotationX`, `rotationOrbit`). It ends at the view state that puts the orbit eye
exactly on the lens, with the target 1 km ahead: `rotationOrbit` = yaw, `rotationX` = −pitch, and
`zoom` derived from OrbitViewport's eye distance (`focalDistance · height / 2^zoom`). The roll
cannot be a view-state field, because deck.gl's orbit controller and transitions keep only their
own fields. Instead, the view takes a `rollAnchor` (the photo position and roll), and the
viewport's roll fades from the photo's roll at the lens to 0 at 2 km. The flight therefore ends
in the photo's framing, and orbiting away levels the horizon again. The visual smoke test measures
the eye 0.00 m from the lens and the roll at −2.413°.

The photo camera's near plane is 80 m. GPS places the lens to within about 30 m, and at zoom 14
the DEM puts it 15 m below the summit surface. Nearer terrain receives no photo; a few near-field
DEM facets left of the lens show through as hillshade when flown in.

## Tests

`npm run test:visual` (or `node examples/deck/photo-drape/scripts/visual-smoke.mjs` from the
repository root; in Rigi, `node scripts/examples.mjs smoke deck/photo-drape` wraps it in the render
lock) starts Vite on a free port and runs headless Chromium with GPU flags against both backends.
It asserts:

- the requested backend, no page or GPU errors, rendered frames, every DEM tile loaded with none
  failed, and a canvas that is not uniform;
- exactly one shadow-map pass after loading, still one after orbiting and after the flight;
- with the photo: the drape changes the orbit view against the plain hillshade, and Show shadowed
  areas tints part of a side view;
- after `flyIntoPhoto()`: the orbit eye is on the lens, the photo's roll is applied, and below the
  skyline the canvas matches the photo, downscaled in the page, to a mean absolute difference under
  8 of 255 per channel (measured 1.6 on WebGPU and 1.7 on WebGL2; the hillshade alone scores
  42.5);
- `finalize()` is idempotent, and the default backend falls back to WebGL2 without `navigator.gpu`.

Screenshots (orbit, hillshade, side, shadow tint, flown in) go to `$PHOTO_DRAPE_SCREENSHOTS`, or
to the OS temp directory by default. `PHOTO_DRAPE_BACKEND=webgpu` limits the run to one backend.

## Packages

`package.json` lists the versions this example is written against: deck.gl 9.4.0-beta.4,
luma.gl 10.0.0-alpha.2 and math.gl 5 alpha. Inside the Rigi repository they resolve to the root
install, which vendors those versions (luma.gl as `10.0.0-alpha.2-rigi.2`, an alpha.2 build with
unmerged upstream fixes; see `vendor/luma/README.md`). The Vite config adds no source aliases. Only public
deck.gl and luma.gl APIs are used (no underscore-prefixed exports).

## Upstream notes

API observations from this example, collected for deck.gl and luma.gl:

- **An offscreen pass is possible with public API, through `Effect`.** Here, `Effect.preRender` plus
  a luma.gl render pass on the effect's own framebuffer does the job. The layer has to expose a method
  (`drawPhotoDepth`) and own a second `Model`, because a layer's `draw()` runs inside deck.gl's open
  render pass. `Effect`, `EffectContext` and `PreRenderOptions` are exported only as types, and
  deck.gl documents custom effects only loosely. Rigi's app used `_LayersPass` for its range pass;
  it now re-creates that pass's draw sequence from public pieces (`src/lib/deck/offscreen-layers.ts`:
  `filterSubLayer`, `activateViewport`, `setShaderModuleProps`, `getModels`, `context.renderPass`,
  `draw()`, and luma's `WebGLDevice.withParametersWebGL`). deck.gl has no public "draw these layers
  through this viewport into this framebuffer" call, so that file copies `LayersPass` internals
  (module props, polygon offset, parameter merging) that can drift between deck.gl versions.
- **Orbit controller state drops custom view-state fields.** `OrbitState` keeps only its own
  fields, so `roll` (or any extra field) is lost during interaction and transitions, and
  `OrbitState` is not exported for subclassing. Roll is therefore a view prop (`rollAnchor`) here.
  An `OrbitView` `roll` would make photo-matched orbit views direct.
- **`OrbitViewport` derives its eye distance from `projectionMatrix[5]`.** A custom projection
  matrix with roll shortens the eye distance by cos(roll). This example compensates when it
  computes `zoom`.
- `OrbitView` is not generic over its view state in the type declarations. As in the summit view,
  the common view-state type is inferred from `View`.
- The shadow map is `r16float` holding kilometres, not `r32float` metres. luma.gl reflects a WGSL
  `texture_2d<f32>` as sample type `float`, and `r32float` is only `unfilterable-float` without
  the `float32-filterable` feature. Half floats keep 11 bits of mantissa, far inside the 1 % bias.

## Data and licences

- **Terrain**: [Mapterhorn](https://mapterhorn.com) Terrarium WebP tiles
  (`https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`). The data carries each source's licence, see
  [mapterhorn.com/attribution](https://mapterhorn.com/attribution). This view is drawn mainly from
  swisstopo swissALTI3D (Swiss OGD) and Copernicus GLO-30. Credit: © Mapterhorn.
- **Photo availability**: the photo is not distributed in the example directory; copy `public/demo/photos/demo-01.jpg` to `examples/deck/photo-drape/niederhorn.jpg` to enable the photo layer (it stays gitignored there). Without it the example runs render-only. The shadow
  map is still drawn, and Show shadowed areas still works, but there is no drape: the Drape opacity
  control is disabled, `diagnostics.photoLoaded` is false, and the smoke test skips the photo
  checks. The pose in `scene-data.ts` is solved for the Niederhorn viewpoint, so use a photo taken there.
- **Photo and pose**: `niederhorn.jpg` is Rigi demo photo `demo-01` (`public/demo/manifest.json`).
  The yaw, pitch, roll and field of view were solved by Rigi's skyline matcher against the
  Mapterhorn DEM.

The on-screen attribution line carries the Mapterhorn credit. The example draws no labels, so no
OpenStreetMap data is used.
