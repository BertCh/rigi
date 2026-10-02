# Lake water

`water.ts` (LOOK_WATER, `terrain.albedo { mode: 'alpine', water: true }`) shades the alpine lakes with a
depth tint and a Schlick-Fresnel sky reflection, in both engines (GLSL chunk in `deck/terrain-layer.ts`,
WGSL in `deck-webgpu/layers/terrain-styles.ts`). Colours are linear. The DEM has no bathymetry, so there is
no refraction.

## Animated waves (LF3)

`style.world.water: 'flat' | 'waves'` (default `'flat'`). `'waves'` adds the `LOOK_WATER_WAVES` define,
which `style/deck-apply.ts` sets **only for the world view** program (never the photo overlay or replace
views), and only when the lake shading is already on. `waves.ts` ports the wave normal of luma's
`riverWaterMaterial` (#3311): six advected, noise-modulated cosine packets, summed to a tilt added to the
lake normal. It is a port, not the public module, because the module is a full material (uv, lights,
`waterMaterial` uniforms) and the terrain shader has its own lighting and fog; the ported function keeps the
material's constants (the table is `WAVE_TABLE`) and is emitted into both the GLSL and the WGSL from one source.
Differences: input is the ENU position, the flow direction is fixed, and the `fwidth` attenuation is replaced
by a range-based pixel footprint (WGSL derivatives must be in uniform control flow, the lake test is not).

- Flat is pixel-identical to before: no define, no extra uniform block, the WGSL is the same text.
- Time: `waterWaveSeconds()`. Under `navigator.webdriver` it returns the fixed `WAVE_STILL_TIME` and the
  engines do not run the redraw loop, so harness renders stay deterministic (as the weather and reveal
  animations).
- The world camera loop (`kickWorld` in both engines) keeps drawing one frame per tick while waves animate.
- Verification: `__tests__/waves.test.ts` (flags, define scoping, the JS reference tilt, webdriver gating,
  both shader languages carry the table); the WGSL program compiles in `terrain-styles.check.ts`.

## Screen-space reflections: skipped

`ssrCameraTemporal` (`@luma.gl/effects`) is only the temporal filter of an SSR pass, WebGPU only. It needs
the current depth and normal textures, a colour history, and the previous frame's packed depth and normals
(`ssrCameraDepthHistoryCopy`), plus the SSR ray march that produces the input. The deck world view draws
terrain with log depth straight into the canvas (MSAA) and has no normal or depth scene buffer, and the
WebGL engine has no equivalent at all. Adding a G-buffer pass to every world frame to reflect mountains in
lakes is not cheap, and a reflection of the sky already comes from the Fresnel term. Revisit if the world
view ever grows a depth+normal pre-pass for another reason (e.g. outlines, `selectionOutline`).
