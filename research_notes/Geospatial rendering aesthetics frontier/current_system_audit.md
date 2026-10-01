# Rigi current visual/rendering system: baseline audit (codebase, 2026-09-30)

Scope: this is a read-only audit of the working tree at the repository root (branch master, HEAD 0544df0, with uncommitted landing/demo work). Every source below is a repo path, with `:line` where useful, relative to the repo root. No dev server was run, so statements about how things look on screen are inferred from code and comments, not from screenshots.

*Update (2026-10-01): a snapshot at 0544df0. The three.js `PhotoEngine` it cites (`src/lib/engine.ts`, `src/lib/materials.ts`) was removed in 583e2b7, and deck.gl on WebGPU is now the default renderer.*

---

## 1. What visual layers exist, and what is on by default versus behind flags or presets?

### Takeaway
A complete "look" system exists: physical aerial perspective, Swiss relief, Alpine tint, Tanaka contours, ink lines, Oklab harmonisation, guided-filter masks, PBR Neutral output, and panorama label layout. **None of it is on by default.** The default style preset is `classic`, which sets no `LOOK_*` shader define and is pixel-pinned to the original hard-coded look:
- grey exponential haze
- Lambert with an ambient sky term
- a 5-stop hypsometric ramp
- "cool" contours
- log-range ridge detection
- Manrope DOM labels with a drop shadow

Users reach the advanced look only by choosing a preset or a toggle in the Look panel. The only visual flourish on by default is the overlay "reveal" animation (bloom).

### Cited Findings

**Architecture: style is data, not flags**
- The look is a `ViewStyle` data object with these sections:
  - `terrain` (sun, ambient/direct, relief ramp, haze, atmosphere, relief, albedo)
  - `overlay` (contours, bands, ridges, depth tint, slope)
  - `replace`
  - `world` (sky, frame, drape harmonise)
  - `composite` (refine, harmonize, ink, sky source, output)
  - `trails`
  - `labels`

  Source: [src/lib/style/types.ts:40-253](src/lib/style/types.ts)
- The resolved style is `merge(CLASSIC, PRESETS[preset], overrides)`. Source: [src/lib/style/presets.ts:1-3, 352-357](src/lib/style/presets.ts)
- Persistence:
  - The style is stored per user in localStorage under `mt-image.viewStyle.v1`.
  - `?style=<preset>` wins over storage.
  - The default state is `preset: "classic"`.

  Source: [src/lib/style/store.ts:1-3, 19-20](src/lib/style/store.ts)
- `?style` and `?reveal` are "text" flags owned by their stores. They are declared in [src/lib/flags/index.ts:74-76](src/lib/flags/index.ts) and are the only render-look flags. The other render flags are:
  - `renderer` (deck default)
  - `terrain` (batched default)
  - `gpu` / `gpuHorizon` / `lookgpu` (all on)
  - `tiles3d` (off)
  - `nearfield` (auto)
  - `cammodes` (off)

  Source: [src/lib/flags/index.ts:33-77](src/lib/flags/index.ts)
- Shader features compile in through `LOOK_*` defines chosen from the style:
  - The defines are `LOOK_ALPINE`, `LOOK_ATMOSPHERE`, `LOOK_HARMONIZE`, `LOOK_INK`, `LOOK_OUTPUT`, `LOOK_REFINE`, `LOOK_RELIEF`, `LOOK_SLOPE` and `LOOK_TANAKA`.
  - The comment says "CLASSIC needs none, so the shader sources stay byte-identical to the classic ones."

  Source: [src/lib/look/look-key.ts:1-31](src/lib/look/look-key.ts)
- `CLASSIC` is "a literal transcription of today's hard-coded look… changing a number here changes the classic look, so don't". Every new look feature is set to off there:
  - `atmosphere: classic`
  - `relief: lambert`
  - `albedo: ramp`
  - `composite.refine false`, `harmonize 0`, `ridges "classic"`, `sky "dem"`, `output "classic"`

  Source: [src/lib/style/defaults.ts:1-4, 18-20, 107-121](src/lib/style/defaults.ts)
- The roadmap makes pixel identity a principle: "Classic view stays pixel-identical, and both renderers… stay at parity." Source: [reports/roadmap.md:16](reports/roadmap.md)

**View modes and layer settings (defaults)**

Source for this group: [src/lib/settings.ts:5-58](src/lib/settings.ts)
- `ViewMode = "overlay" | "replace" | "world"`. The default is `overlay`.
- `overlayStyle` is `contours | bands | slope | none`. The default is `contours`, at a 50 m interval.
- Other overlay defaults:
  - `layerOpacity 0.9`
  - `ridges 0.8`
  - `depthTint 0` (off)
  - `trails false`
- The replace `mapStyle` is satellite, topo, hillshade or bands, with blend method `lens` by default (also swipe, range, brush) and `keepSky true`.
- The world `worldStyle` is satellite, topo or hillshade.

**Terrain shading (classic, three and deck share the GLSL)**
- The uber-shader `uStyle` modes are hillshade, imagery, contours, geometry, elevation, slopeClass and normal. Source: [src/lib/materials.ts:1-8, 27-35](src/lib/materials.ts)
- Shading is `uShadeAmbient * (0.5 + 0.5 n.z) + uShadeDirect * max(n·sun, 0)`, with ambient 0.25, direct 0.85 and a fixed sun `(-0.5,-0.4,0.75)`. Sources: [src/lib/materials.ts:352-356](src/lib/materials.ts); [src/lib/style/defaults.ts:10-12](src/lib/style/defaults.ts)
- Haze is `mix(col, toLinear(uHazeColor), clamp(1-exp(-range*1.8e-5*uHaze), 0, 0.85))`:
  - The haze colour is `#b9cde0`.
  - The colour is deliberately "double linearised" to keep the classic look.

  Sources: [src/lib/materials.ts:358-363](src/lib/materials.ts); [src/lib/style/defaults.ts:15-17](src/lib/style/defaults.ts)
- Under `LOOK_ATMOSPHERE`, `applyAtmosphere` replaces `haze()`, and under `LOOK_RELIEF`, `reliefShade` replaces `shade`. Source: [src/lib/materials.ts:458-463, 521-525](src/lib/materials.ts)
- Imagery adjust is saturation, contrast around 0.18, brightness, and a constant-luminance tint. Source: [src/lib/materials.ts:449-456](src/lib/materials.ts)

**Hypsometric and colour ramps**
- Named ramps: `hypso-classic`, `cool`, `turbo`, `swiss`, `grey`, `viridis`, `night`, `mono-ink`, plus the absolute-elevation `berann`, `swiss-ok` and `patterson`.
- Ramps mix in sRGB, then `pow 2.2`, with up to 8 stops.

Sources: [src/lib/style/ramps.ts:1-2, 11-129](src/lib/style/ramps.ts); [src/lib/style/types.ts:20-31](src/lib/style/types.ts)
- The classic relief ramp is local min/max within 25 km. Source: [src/lib/style/defaults.ts:13-14](src/lib/style/defaults.ts)

**Contours**
- Contours are anti-aliased with `fwidth`:
  - majors every 5, width 1.2 px, major ×1.8
  - minor alpha 0.45, major alpha 0.95
  - density fade
  - distance fade from 4 km to 25 km, down to a floor of 0.3
  - a dark casing `(0.02,0.03,0.06)` at +2 px and alpha 0.55
  - the "cool" ramp colour

  Sources: [src/lib/style/defaults.ts:23-40](src/lib/style/defaults.ts); [src/lib/materials.ts:365, 404-436](src/lib/materials.ts)
- Tanaka (illuminated) contours exist under `LOOK_TANAKA`. Source: [src/lib/look/glsl/ramps.ts header](src/lib/look/glsl/ramps.ts)

**Ridges and skyline (composite pass)**
- The silhouette is `max |Δ log(range)|` over ±1.25 geometry texels, then `smoothstep(0.12, 0.45)`, with a skyline flag where the texel above is sky.
- The inner colour is `(1,0.95,0.85)` and the skyline colour `(1,0.45,0.25)`, with gain 0.9.

Sources: [src/lib/deck/composite-shader.ts:265-273, 294-295](src/lib/deck/composite-shader.ts); [src/lib/style/defaults.ts:51-56](src/lib/style/defaults.ts)
- The optional `LOOK_INK` anti-aliased silhouettes have distance-falling width and opacity, normal-buffer creases, and a skyline snapped to the refined coverage. Source: [src/lib/look/glsl/composite.ts:1-12](src/lib/look/glsl/composite.ts)

**Depth tint**
- This is a Turbo colormap over log range from 200 m to 80 km, at gain 0.75, with luma kept. It is off by default (`depthTint: 0`). Sources: [src/lib/style/defaults.ts:57-63](src/lib/style/defaults.ts); [src/lib/deck/composite-shader.ts:285-288](src/lib/deck/composite-shader.ts); [src/lib/settings.ts:42](src/lib/settings.ts)

**Slope layer**
- This shows the FATMAP 30/35/40/45° classes:
  - yellow → orange → red → purple
  - alpha 0.5

  Source: [src/lib/style/defaults.ts:64-72](src/lib/style/defaults.ts)

**Trails**
- Trails are 2.2 px at 0.95 opacity:
  - hiking: yellow `(1,0.82,0.25)`
  - mountain: red `(1,0.32,0.36)`
  - alpine: blue `(0.3,0.67,0.97)`

  They are off by default. Sources: [src/lib/style/defaults.ts:122-131](src/lib/style/defaults.ts); [src/lib/settings.ts:43-44](src/lib/settings.ts)

**Sky**
- The world-view sky is flat by default, clear `#9fb8d0` and background `#a9c2da`. Source: [src/lib/style/defaults.ts:96](src/lib/style/defaults.ts)
- Under `world.sky.mode "atmosphere"` it becomes a "Preetham-like analytic sky: zenith→horizon gradient keyed to sun height, with a Mie aureole". This is *not* Hosek-Wilkie or Hillaire. Sources: [src/lib/look/glsl/atmosphere.ts:84-87](src/lib/look/glsl/atmosphere.ts); [src/lib/look/atmosphere.ts:7](src/lib/look/atmosphere.ts)
- In the photo view the sky is the photo itself.

**Photo drape (world view, Step Inside)**
- The drape is projective texturing with a single-texel range "shadow map" test, `r < seen*1.015 + 15`, and incidence weight `mix(0.35, 1, inc)`. Sources: [src/lib/materials.ts:466-492](src/lib/materials.ts); [src/lib/deck/terrain-layer.ts:534-536](src/lib/deck/terrain-layer.ts)
- The Step Inside "Truth" provenance tint uses Okabe-Ito colours:
  - observed: `(0,158,115)`
  - reconstructed: `(86,180,233)`
  - dem: `(230,159,0)`
  - generated: `(204,121,167)`

  Sources: [src/lib/nearfield/provenance.ts:7-11](src/lib/nearfield/provenance.ts); [src/lib/materials.ts:137-138, 497-511](src/lib/materials.ts)

**Peak labels (classic default)**
- The DOM label is a 6 px white dot with a black glow, a 28 px vertical leader fading from white/90 to 0, and two text lines:
  - name: Manrope 12 px / 600, white
  - sub line: "ele · dist" at 10 px, white/75
- The halo is `drop-shadow(0 1px 3px rgba(0,0,0,.9))`, with at most 28 labels.

Source: [src/lib/style/defaults.ts:132-161](src/lib/style/defaults.ts)
- Classic ranking is `prominence·3 + elevation − range·0.012`. Source: [src/lib/look/labels/rank.ts header](src/lib/look/labels/rank.ts)
- Classic placement:
  - names wrap onto 2–3 lines
  - labels are edge-clamped, with angled leaders when a label slides sideways
  - labels never overlap
  - hysteresis applies while dragging

  Source: [src/lib/look/labels/classic.ts header](src/lib/look/labels/classic.ts)
- Alternative layouts are `panorama` (PeakFinder/Berann-style: a 1 px leader to a band above the local skyline, text rotated 50°, priority from log prominence + elevation − log distance + centre bias + isolation, with hysteresis) and `inline`. Sources: [src/lib/look/labels/layout.ts:1-16, 44-45](src/lib/look/labels/layout.ts); [src/lib/look/labels/PeakLabelsSvg.tsx](src/lib/look/labels/PeakLabelsSvg.tsx)
- In those layouts, weight steps by tier (700/600/500) and the fade lasts 220 ms. Sources: [src/lib/look/labels/layout.ts:89](src/lib/look/labels/layout.ts); [src/lib/look/labels/PeakLabelsSvg.tsx:19](src/lib/look/labels/PeakLabelsSvg.tsx)
- **No preset selects `panorama` or `inline`.** The only `layout:` value in `src/lib/style` is `"classic"` in defaults. The other layouts are reachable only through the Look panel's Label style selector. Sources: grep of `src/lib/style/` (only [src/lib/style/defaults.ts:133](src/lib/style/defaults.ts)); [src/components/StylePanel.tsx:1604-1615](src/components/StylePanel.tsx)
- Labels in export are drawn on a 2D canvas (`look/labels/canvas.ts`), with metrics scaled to `W/1400`. Source: [src/lib/style/defaults.ts:147-160](src/lib/style/defaults.ts)

**Typography**
- One label font family is used everywhere: `Manrope, ui-sans-serif, system-ui, sans-serif`. Sources: [src/lib/look/labels/layout.ts:77-78](src/lib/look/labels/layout.ts); [src/styles.css:121](src/styles.css)

**Reveal animation (on by default)**
- Presets:

  | Preset | Colour | Duration |
  |---|---|---|
  | bloom | `#ffd58a` | 2.8 s |
  | alpenglow | `#ff8a5c` | 3.4 s |
  | tide | `#5ee7ff` | — |
  | shockwave | `#bfe9ff` | — |
  | terraces | `#c9a7ff` | — |
  | sunsweep | `#ffe7a3` | — |
  | stardust | `#ffffff` | — |

- The reveal is a per-pixel arrival field built from log range, elevation and screen position. A light band rides the front, ridges lead it, and fbm grain is added.

Sources: [src/lib/reveal/config.ts:1-6, 11-28, 48-125](src/lib/reveal/config.ts); [src/lib/reveal/glsl.ts:10, 44-73](src/lib/reveal/glsl.ts)
- Defaults:
  - `onLoad: true`, `preset: "bloom"`, and labels pop in as the front reaches them
  - off under `navigator.webdriver` or `?reveal=off`

  Source: [src/lib/reveal/config.ts:154-160, 297](src/lib/reveal/config.ts)

**Post-processing and output (classic)**
- The three.js renderer is WebGL with:
  - `antialias: true`
  - `logarithmicDepthBuffer: true`
  - `outputColorSpace = SRGB`
  - the layer target at `HalfFloatType` with 4× MSAA
  - the geometry target float RGBA, 1024 px on the long side

  There is **no tone mapping** in classic. Source: [src/lib/engine.ts:545-585](src/lib/engine.ts)
- PBR Neutral, the exact sRGB OETF, IGN dither and photo-matched grain exist only under `LOOK_OUTPUT` (composite `output: "neutral"`). Sources: [src/lib/style/types.ts:188-189](src/lib/style/types.ts); [src/lib/engine.ts:263-322](src/lib/engine.ts)

**Other surfaces**
- /roll panorama strip:
  - Photos are warped onto a cylindrical az×el canvas with WebGL2 and feathered edges.
  - Behind them, a 2D canvas draws "depth-layered ridgelines" traced from the DEM, with heavier strokes for ridges.
  - Viewpoint colours: `#dca27a, #6cc3d5, #9ad07a, #d58bd8, #e9d267, #ef8a7a, #7aa2ef, #7fd6b0`.

  Sources: [src/lib/roll/mosaic/PanoramaStrip.tsx:1-6](src/lib/roll/mosaic/PanoramaStrip.tsx); [src/lib/roll/mosaic/ridgelines.ts:1-6](src/lib/roll/mosaic/ridgelines.ts); [src/lib/roll/mosaic/panoGL.ts:1-2](src/lib/roll/mosaic/panoGL.ts); [src/lib/roll/mosaic/style.ts:6-16](src/lib/roll/mosaic/style.ts)
- /roll 3D map:
  - Many photos are draped at once (`MultiDrapeLayer`), each weighted by incidence, ground resolution and an edge feather, then "sharpened so the best photo wins overlaps without ghosting".
  - The visibility test is a 2×2 PCF-style vote with slope-scaled bias.
  - The basemap is satellite and the background is `WORLD_SKY`.

  Sources: [src/lib/roll/map/multi-drape-layer.ts:1-37](src/lib/roll/map/multi-drape-layer.ts); [src/lib/roll/map/roll-map.ts:156, 184](src/lib/roll/map/roll-map.ts)
- Step Inside 3D Tiles:
  - One material is used: Google tiles get unlit textures, swisstopo tiles a flat colour with derivative normals.
  - "Fill" blend: the photo wins inside the frame.
  - A dithered radius fade hands over to the DEM.

  `?tiles3d` is off by default. Sources: [src/lib/tiles3d/material.ts:1-12](src/lib/tiles3d/material.ts); [src/lib/flags/index.ts:49](src/lib/flags/index.ts)
- Step Inside splats are EWA Gaussian splats with premultiplied alpha, sorted back to front in a worker and occluded by the log-depth terrain. `?nearfield=auto` probes the :8767 service. Sources: [src/lib/nearfield/deck-splat-layer.ts:1-10](src/lib/nearfield/deck-splat-layer.ts); [src/lib/flags/index.ts:55](src/lib/flags/index.ts)
- `/studio` no longer exists. There is no studio route under `src/routes/`; comments call it "the former studio" whose composite was ported into `look/`. Sources: [src/lib/look/glsl/composite.ts:12](src/lib/look/glsl/composite.ts); [src/lib/style/defaults.ts:111](src/lib/style/defaults.ts); route listing

### Inferences
- First-time users, the demo export (`scripts/demo/export-overlay.ts` loads `/photo/<id>` with no `?style`) and the landing shots all show the **classic** look. Most of the aesthetic investment (atmosphere, relief, ink, harmonise, Neutral output, panorama labels) is invisible unless someone picks a preset. The most leveraged change may be the defaults, not new techniques.
- Classic defaults lean "technical overlay" rather than "cartographic": cyan-to-magenta contours with dark casing, warm-orange skyline, and white DOM labels with a drop shadow.

### Gaps
- No rendered screenshots were inspected, so on-screen quality (banding, aliasing, label legibility) is not assessed here. Existing preset stills are at `out/lead/deck-parity/style-presets/IMG_7086__*.jpg` (classic, minimal, night, topo-map and high-contrast only).

---

## 2. What does the landing page and demo showcase look like?

### Takeaway
The landing page is a dark, single-scroll story page with:
- ink `#0e1012`, paper `#ece6da` and a warm copper "glow" accent `#dca27a`
- Manrope with uppercase mono eyebrows
- IntersectionObserver fade-ups

It shows the bundled Niederhorn demo trip as a before/after slider, a CSS-mask reveal of a pre-rendered overlay, the live panorama strip, a topo board, and a live 3D drape. The global CSS still carries an unused TanStack starter-template palette (sea-ink/lagoon/palm) and loads a Fraunces font that nothing uses.

### Cited Findings
- Structure:
  - hero: kicker, H1 "Mountain photos, aligned to a terrain model.", before/after `Compare` of `demo-09.jpg` against `shots/hero.jpg`
  - 01 Single photo: `RevealLoop`
  - 02 Panorama: full-bleed `DemoPanorama`
  - 03 Map: `TopoBoard`
  - 04 3D: `LiveRollMap` with poster `shots/drape.jpg`
  - 05 Method: `RigiPanorama` SVG
  - 06 Data: four "local" cards
  - pitch: one photo or a roll
  - footer with attributions

  Source: [src/routes/index.tsx:51-264](src/routes/index.tsx)
- Theme tokens are set inline on `<main>`: `--rigi-glow:#dca27a`, `--rigi-ink:#0e1012`, `--rigi-paper:#ece6da`. Source: [src/components/site/SiteNav.tsx:6-7](src/components/site/SiteNav.tsx)
- Type scale:
  - H1 `2.2rem` → `sm:text-5xl`, tracking −0.025em, semibold
  - eyebrows `font-mono 11px tracking-[0.18em] uppercase` in the glow colour
  - body 15px at `text-white/55–60`
  - captions mono 10.5px at `white/35–40`

  Source: [src/routes/index.tsx:61-67, 292-301](src/routes/index.tsx)
- Fonts: `styles.css` imports Fraunces (opsz 9..144, 500/700) and Manrope (400–800) from Google Fonts. `--font-sans` is Manrope. Source: [src/styles.css:1, 121](src/styles.css)
- `.display-title` (Fraunces) and the template tokens `--sea-ink`, `--lagoon`, `--palm`, `.island-shell` and `.feature-card` are defined in `styles.css`, but a grep of `src/` outside `styles.css` finds no use of `display-title`, `Fraunces`, `island-shell`, `sea-ink` or `lagoon`. `body` still sets `color: var(--sea-ink)` and background `#0b0f14`. Sources: [src/styles.css:9-28, 166-172, 213-224](src/styles.css); grep result
- The shadcn zinc oklch tokens and a `.dark` variant are present (the default shadcn palette). Source: [src/styles.css:30-118](src/styles.css)
- Motion:
  - `FadeIn`: a 1000 ms ease-out translate-y-6 → 0 with opacity, fired once by IntersectionObserver at a −12% bottom margin, and `motion-reduce:transition-none`. Source: [src/components/site/FadeIn.tsx:13-35](src/components/site/FadeIn.tsx)
  - `RevealLoop` is a CSS radial mask sweep, not the engine shader:
    - It arms at 75 % in view and resets below 20 %.
    - The sweep runs 4600 ms with in-out-cubic easing and a hover replay after 350 ms.
    - It uses `mix-blend-mode: screen` for the front band.
    - It respects `prefers-reduced-motion`.

    Source: [src/components/site/RevealLoop.tsx:1-7, 20-67](src/components/site/RevealLoop.tsx)
  - `LiveRollMap` starts the real roll engine when the section scrolls into view and orbits slowly until grabbed. Source: [src/components/site/LiveRollMap.tsx:1-3](src/components/site/LiveRollMap.tsx)
  - Per project memory, the landing embeds have no wheel zoom and use touch `pan-y`.
- Brand assets:
  - `RigiMark` is contour lines of the Rigi Kulm summit (1550–1780 m, swissALTI3D).
  - `RigiPanorama` is the view south from Rigi Kulm as depth-layered ridgelines with vertical exaggeration `VEX`.

  Sources: [src/brand/RigiMark.tsx:1](src/brand/RigiMark.tsx); [src/brand/RigiPanorama.tsx:1-5](src/brand/RigiPanorama.tsx)
- Demo assets: `public/demo/` holds `manifest.json`, photos, thumbs, and `shots/{hero,demo-01-overlay,drape}.jpg`.
  - The overlay shot comes from `exportImage(true)` on `/photo/<id>` with no style param.
  - A reveal video script exists that outputs `public/demo/video/reveal.{mp4,webm,jpg}`, but `public/demo/video` is not present and the landing uses the CSS `RevealLoop` instead.

  Sources: `ls public/demo`; [scripts/demo/export-overlay.ts:21-36](scripts/demo/export-overlay.ts); [scripts/demo/reveal-video.ts:1-4](scripts/demo/reveal-video.ts)
- The code review flags this landing/demo work as uncommitted, tracked as CR-W1…W6, and notes a stale "Summit Lens" string in `upload.tsx:45`. Source: [reports/code-review-2026-09-30.md:16, 75-88](reports/code-review-2026-09-30.md)

### Inferences
- The landing visuals are pre-rendered **classic-style** exports, except the live drape and panorama. A refreshed default look (or a photo-matched/Swiss hero) would change the showcase directly.
- Two type systems are latent: Manrope sans everywhere, and Fraunces serif loaded but unused. A display face decision and removal of the template CSS are low-cost cleanups.

### Gaps
- No visual check of contrast ratios. `white/35` captions on `#0e1012` may fall below WCAG AA for small text, but this was not measured.

---

## 3. What render "looks" exist, and how are they exposed (including src/lib/gpu)?

### Takeaway
There are 10 presets. Five of them turn on `LOOK_*` features (photo-matched, swiss, berann, topo-ink, slope). Presets are chips in the "Look" panel, with per-view "Customize" disclosures, and can also be set with `?style=`.
- `src/lib/look` holds the CPU and shader implementations.
- `src/lib/gpu/look` holds WebGPU compute **accelerators** for the CPU look passes (relief field, haze fit, guided filter, band stats). These are on by default via `?lookgpu=on`, but they only run when a look preset needs them. They are not visual styles in their own right.

### Cited Findings
- Preset ids and labels:
  - `classic` (Classic)
  - `minimal` (Minimal)
  - `topo-map` (Topo)
  - `night` (Night)
  - `high-contrast` (High contrast)
  - `photo-matched` (Photo-matched)
  - `swiss` (Swiss relief)
  - `berann` (Berann)
  - `topo-ink` (Topo ink)
  - `slope` (Slope angle)

  Source: [src/lib/style/presets.ts:8-32](src/lib/style/presets.ts)
- `LOOK_PRESETS = photo-matched, swiss, berann, topo-ink, slope`. "The rest stay classic-compatible." Source: [src/lib/style/presets.ts:336-342](src/lib/style/presets.ts)
- Preset contents, all starting at [src/lib/style/presets.ts](src/lib/style/presets.ts):
  - **minimal** (`:49`): white contours with no casing, grey bands, softened ridges, a paler world sky, labels at 11 px with only elevation shown.
  - **topo-map** (`:89`):
    - sun at 315°/45°, Swiss ramp
    - brown contours `#9a6a3a/#6b4423` with a cream casing
    - a paper tint `#f4ecd8` on the world
    - dark labels with a white stroke halo
  - **night** (`:127`): haze `#1a2436`, cyan/magenta ridges `#7fe9ff/#ff4fd8`, a dark blue-tinted world.
  - **high-contrast** (`:165`): yellow `#ffd400` contours at 2 px with a black casing, viridis bands, 14 px bold labels with a stroke halo.
  - **photo-matched** (`:211`):
    - sun from photo time
    - physical atmosphere with fitted airlight
    - world atmosphere sky, `drapeHarmonize 0.8`
    - composite `refine`, `sky: photo`, `harmonize 0.8`, `ridges: ink`, `output: neutral`
  - **swiss** (`:235`):
    - photo-time sun
    - Swiss relief (realism 0.15, generalise 0.6, curvature 0.5)
    - Alpine albedo, Tanaka contours, blue-black ink
  - **berann** (`:257`): Berann absolute ramp, relief realism 0.55, ink with creases.
  - **topo-ink** (`:280`): a flat paper ramp `#f0ece3`, cartographic relief, dark ink strength 1 and width 1.35, ink contours.
  - **slope** (`:316`): FATMAP slope layer at alpha 0.7 over Alpine relief, light ink. Choosing it switches `overlayStyle` to `slope` (`:330-333`).
- The look modules (headers in `src/lib/look/`):
  - `atmosphere.ts` (+ `glsl/atmosphere.ts`):
    - Rayleigh β_R(λ) with H_R 8 km, plus Mie with H_M 1.2 km
    - analytic altitude-aware optical depth
    - airlight either fitted or from Rayleigh + Cornette-Shanks phase plus ambient
    - Preetham-like sky
  - `haze-fit.ts`: Koschmieder per channel, airlight A from a sky band above the skyline, dark-object 5th percentile per log-range bin, per-channel β fit (about 50 ms at 1024²).
  - `sun.ts`: NOAA/Meeus ephemeris from EXIF UTC time, plus `sunColor`.
  - `relief/field.ts`: CPU field over 12 km ahead of the camera, holding a soft cast shadow (line sweep), SVF (8 azimuths), curvature, and a ≈60 m generalised normal.
  - `glsl/relief.ts`:
    - cartographic mode: 4 lights around NW, Mark aspect weights, warm-lit/cool-shade, Imhof elevation contrast, SVF
    - photographic mode: sun × shadow × sun colour plus sky × SVF plus bounce
    - the two are blended by `realism`
  - `glsl/ramps.ts`: Alpine albedo (Patterson-style, slope rock, snow, lakes), Tanaka, slope classes.
  - `color-stats.ts`: Oklab per-distance-band Reinhard transfer, 4 log-range bands.
  - `guided-filter.ts`: He et al. 2013 grey-guide filter at ≤512 px, a few ms.
  - `glsl/composite.ts`: `REFINE`/`INK`/`HARMONIZE`/`OUTPUT`.

  Sources: those files' header comments: [src/lib/look/atmosphere.ts:1-9](src/lib/look/atmosphere.ts), [src/lib/look/haze-fit.ts:1-9](src/lib/look/haze-fit.ts), [src/lib/look/sun.ts:1-3](src/lib/look/sun.ts), [src/lib/look/relief/field.ts:1-9](src/lib/look/relief/field.ts), [src/lib/look/glsl/relief.ts:1-8](src/lib/look/glsl/relief.ts), [src/lib/look/glsl/ramps.ts:1-6](src/lib/look/glsl/ramps.ts), [src/lib/look/color-stats.ts:1-16](src/lib/look/color-stats.ts), [src/lib/look/guided-filter.ts:1-4](src/lib/look/guided-filter.ts), [src/lib/look/glsl/composite.ts:1-12](src/lib/look/glsl/composite.ts)
- The composite look (refine, harmonize, colour stats) runs on the CPU once per pose settle at ≤512 px ("P4 amendment: no GPU passes"). Source: [src/lib/look/composite.ts:1-6](src/lib/look/composite.ts)
- `needsPhotoSky` loads the photo sky-segmentation model (about 4.5 MB) only for fitted-airlight, `sky: photo` or `refine` styles, "never for classic". Source: [src/lib/look/look-key.ts:51-56](src/lib/look/look-key.ts)
- UI exposure: `StylePanel.tsx` is "the 'Look' panel: preset chips shared by every view, plus a per-view 'Customize' disclosure, and the nested 'Label style' / 'Trail style' disclosures". It includes:
  - Map colours
  - Relief (sun mode, azimuth/elevation, "Real sun" realism, "Alpine colours", "Shadow depth")
  - Haze
  - contours (Tanaka toggle, casing, distance fade)
  - bands
  - ridges / ink
  - composite (refine / harmonize / Neutral output toggles)
  - world sky (flat or atmosphere)
  - label layout (Classic / Panorama / Inline)

  Source: [src/components/StylePanel.tsx:1-4, 199-395, 738-748, 1183-1220, 1409-1443, 1604-1615](src/components/StylePanel.tsx)
- GPU looks (`src/lib/gpu/look`):
  - Kernels cover the relief field, haze fit (radix select, compact readback), guided filter and colour stats.
  - `textures.ts` has texture-input variants, but "Nothing in the app calls them yet".
  - Command-graph paths for haze and relief/guided/band-stats are opt-in (`graph: true`).

  Source: [src/lib/gpu/README.md](src/lib/gpu/README.md) ("Layers", "Texture inputs", "Kernels")
- The `lookgpu` flag defaults to on: "relief / haze look passes". Source: [src/lib/flags/index.ts:44-45](src/lib/flags/index.ts)
- The WebGPU port carries all look shaders: `terrain-styles.ts` passes "22/22 programs", and `atm-sky.ts` is within 1/255 of the GLSL. It runs only in `/lab/deck-webgpu`. Source: [src/lib/deck-webgpu/README.md:1-7, 245-263](src/lib/deck-webgpu/README.md)

### Inferences
- The look system is mature in code but under-exposed in product: preset chips plus a deep Customize tree. There is no automatic "best look for this photo".

### Gaps
- No quantitative or user evaluation of the look presets was found in `reports/`. A grep for `photo-matched`, `LOOK_INK`, `Tanaka` and `haze-fit` hits only the code review, concordance, leaderboard and the SoTA note. Visual quality per preset is therefore unmeasured.
- Stills exist for only 5 of the 10 presets (`out/lead/deck-parity/style-presets/`).

---

## 4. Which recommendations from `research_notes/rendering_aesthetics_sota.md` are implemented?

### Takeaway
The note's top 10 has largely been built as **opt-in** look features. The exceptions:
- the single-photo drape quality pass is only partly built: PCF and slope bias exist in /roll and WebGPU but not in the WebGL photo/world drape
- reversed-Z exists only in the unshipped WebGPU port
- AgX was not adopted; Neutral is used, and only in the composite
- Hosek-Wilkie/Hillaire sky and LUT atmosphere are not built
- a condensed label font was not adopted

The note's own "Current baseline" (grey haze, Lambert, 5-stop ramp, log depth) is still exactly the **default** look.

### Cited Findings
The status of each top-10 item (the list is at [research_notes/rendering_aesthetics_sota.md:382-395](research_notes/rendering_aesthetics_sota.md)):

1. **Photo-fitted aerial perspective** (A from the sky above the skyline, chromatic β, black level): **built**, opt-in through the `photo-matched` preset. Sources: [src/lib/look/haze-fit.ts:1-9](src/lib/look/haze-fit.ts); [src/lib/look/haze-controller.ts:1-4](src/lib/look/haze-controller.ts); [src/lib/style/presets.ts:211-216](src/lib/style/presets.ts)
   - Open bug: the haze-fit cache key omits the fg mask (CR-11). Source: [reports/code-review-2026-09-30.md:26](reports/code-review-2026-09-30.md)
2. **Height-integrated chromatic haze plus sun phase**: **built** as `LOOK_ATMOSPHERE` (Rayleigh/Mie scale heights, Cornette-Shanks), opt-in. Source: [src/lib/look/atmosphere.ts:1-9](src/lib/look/atmosphere.ts)
3. **EXIF/sun position plus cast shadows plus sun colour**: **built**:
   - `sun.ts` uses NOAA/Meeus rather than SunCalc.
   - Shadows come from a CPU line-sweep in `relief/field.ts` over 12 km, rather than horizon maps per tile or a shadow map.
   - `sunColor` exists.
   - Sun mode `photo-time` is opt-in, in the photo-matched, swiss, berann and slope presets.

   Sources: [src/lib/look/sun.ts:1-3](src/lib/look/sun.ts); [src/lib/look/relief/field.ts:1-9](src/lib/look/relief/field.ts); [src/lib/look/atmosphere.ts:12, 28](src/lib/look/atmosphere.ts)
4. **Guided-filter mask refinement**: **built** as `LOOK_REFINE` (CPU guided filter, plus a GPU twin). It is opt-in and on only in the photo-matched preset. Sources: [src/lib/look/guided-filter.ts](src/lib/look/guided-filter.ts); [src/lib/look/composite.ts:1-6](src/lib/look/composite.ts)
5. **Distance-binned Oklab harmonisation plus grain matching**: **built** as `LOOK_HARMONIZE` (4 log-range bands, Oklab) and `LOOK_OUTPUT` grain. The note's "sharpness matching" was not found. Sources: [src/lib/look/color-stats.ts:1-16](src/lib/look/color-stats.ts); [src/lib/look/glsl/composite.ts:5-9](src/lib/look/glsl/composite.ts)
6. **Screen-space ink lines** (silhouettes from ∇log range, depth-varying width, creases): **built** as `LOOK_INK`. Source: [src/lib/look/glsl/composite.ts:6-7](src/lib/look/glsl/composite.ts)
7. **Prominence-scored, skyline-banded, hysteretic labels**:
   - The layout is **built** (`panorama` / `inline`).
   - It is **not used by any preset**, so it is not default.
   - The font is still Manrope. A "condensed humanist font" was **not adopted**.
   - "Adaptive halos" was not verified; halo kinds are shadow, stroke or none.

   Sources: [src/lib/look/labels/layout.ts:1-16, 77-78](src/lib/look/labels/layout.ts); [src/lib/style/types.ts:198-204](src/lib/style/types.ts)
8. **Swiss-style relief** (multidirectional, generalised normals, Imhof contrast, SVF, Patterson/Alpine tints in an OKLab LUT, Tanaka): **built** (`LOOK_RELIEF`, `LOOK_ALPINE`, `LOOK_TANAKA`, `swiss-ok`/`patterson` ramps, an Oklab GLSL helper). It is opt-in. Sources: [src/lib/look/glsl/relief.ts:1-8](src/lib/look/glsl/relief.ts); [src/lib/look/glsl/ramps.ts:1-6](src/lib/look/glsl/ramps.ts); [src/lib/look/glsl/oklab.ts:1-3](src/lib/look/glsl/oklab.ts); [src/lib/style/ramps.ts:81-129](src/lib/style/ramps.ts)
9. **Drape quality pass** (slope-scaled bias plus PCF, stretch fade, seam feathering, mip/aniso): **partial**.
   - PCF-style 2×2 vote plus slope-scaled bias exist in the /roll `MultiDrapeLayer` and in the WebGPU `drape.ts`, where grazing acne went from 17.7 % to 0 %.
   - The shipping single-photo drape in `materials.ts` and `deck/terrain-layer.ts` still uses the classic single-texel binary test, `r < seen*1.015 + 15`.
   - No stretch fade, unseen-area desaturation or hatch was found in those shaders.

   Sources: [src/lib/roll/map/multi-drape-layer.ts:36-37, 56, 282](src/lib/roll/map/multi-drape-layer.ts); [src/lib/deck-webgpu/layers/drape.ts:22-23, 89, 280](src/lib/deck-webgpu/layers/drape.ts); [src/lib/deck-webgpu/README.md](src/lib/deck-webgpu/README.md) (status row "drape.ts"); [src/lib/materials.ts:480](src/lib/materials.ts); [src/lib/deck/terrain-layer.ts:536](src/lib/deck/terrain-layer.ts)
10. **Output hygiene** (half-float linear, then AgX or PBR Neutral, then IGN dither; reversed-Z; unified async PBO readback): **partial**.
    - PBR Neutral, exact OETF, IGN dither and grain exist only as composite `LOOK_OUTPUT`. There is no AgX, and no tone mapping on render-only or world modes in classic.
    - three.js still uses `logarithmicDepthBuffer: true`. deck uses log depth (`LOG_DEPTH_FAR = 1e9`, `gl_FragDepth` in `terrain-layer.ts`).
    - Reversed-Z exists only in the WebGPU port's own pass runner, because deck's canvas pass "hard-codes `clearDepth: 1`".
    - Async PBO readback is used by the deck geometry source.

    Sources: [src/lib/style/types.ts:188-189](src/lib/style/types.ts); [src/lib/engine.ts:549](src/lib/engine.ts); [src/lib/deck/terrain-layer.ts:57, 397](src/lib/deck/terrain-layer.ts); [src/lib/deck-webgpu/README.md:24-40, 50-53](src/lib/deck-webgpu/README.md); [src/lib/deck/engine.ts:8-10](src/lib/deck/engine.ts)

Other items in the note:
- **Sky:** the note recommends Hosek-Wilkie or a Hillaire sky-view LUT. The build is a "Preetham-like" gradient, so this is **not done** as specified. Source: [src/lib/look/glsl/atmosphere.ts:84](src/lib/look/glsl/atmosphere.ts)
- **Hillaire 4-LUT atmosphere / @takram three-atmosphere:** not found.
- **Multi-resolution DEM under the drape** (swissALTI3D 0.5–2 m near the camera): the photo-view terrain uses Mapterhorn with `maxZoom: 14` in `terrain.ts`. A separate near DEM (z16/z17) exists for Step Inside, but a blended near-DEM feather for the drape was not found. Sources: [src/lib/terrain.ts:29, 297](src/lib/terrain.ts); [reports/negative-results.md:69](reports/negative-results.md) ("Unifying both renderers on near-DEM z16" regression)
- **Eduard neural shading pyramid:** not found.

### Inferences
- The remaining gap is now mostly productisation, not technique:
  - make a look the default, or choose one automatically per photo
  - run quality evaluation
  - port the /roll PCF drape into the single-photo drape
  - consider whether AgX or Neutral should apply to render-only modes
- The pixel-identity rule on classic ([reports/roadmap.md:16](reports/roadmap.md)) structurally discourages changing the default look. A new default would need an explicit decision and a re-baselined style-baseline CI gate.

### Gaps
- The quality of the built implementations (for example whether the Preetham-like sky or the haze fit looks convincing) was not visually verified.
- Whether "adaptive halos" or "sharpness matching" exist under other names was not exhaustively searched.

---

## 5. What do status, roadmap, negative-results and the code review record about render and aesthetic weaknesses?

### Takeaway
The reports are almost entirely about registration, perf and parity. There are no open aesthetic workstreams. The visual items recorded are:
- a stale style-baseline (0/16 identical)
- a CR item that leaves stale ink creases after a world-mode visit (three.js)
- haze-fit masking (CR-11)
- export memory blow-ups
- the WebGPU colour-space difference
- an iOS rendering-path gap (L3)
- a FUND finding that better appearance renders don't improve matching

### Cited Findings
- The style-baseline re-capture is pending: "0/16 identical back to a7287da: trails off by default since 71e846e, baseline never re-captured". Source: [reports/status.md:40](reports/status.md)
- Renderer status:
  - deck is the default since 3b121ae.
  - Canvas antialias is off at DPR ≥ 2 (408f989).
  - Open items: re-capture the three-pinned style-baseline, Windows/Safari smoke tests, and "optional line-AA for the world gizmo".

  Source: [reports/status.md:14](reports/status.md)
- CR-24: "Frustum gizmo isn't hidden in the normal/silhouette passes → stale ink creases after a world-mode visit (three.js)". Source: [reports/code-review-2026-09-30.md:39](reports/code-review-2026-09-30.md)
- CR-13: export renders 4× MSAA rgba16f at full photo size (1.4–2.9 GB), causing device loss on integrated GPUs. On WebGL, one failed export disables MSAA for the session. Source: [reports/code-review-2026-09-30.md:28](reports/code-review-2026-09-30.md)
- CR-11: the haze-fit cache key omits the fg mask. Source: [reports/code-review-2026-09-30.md:26](reports/code-review-2026-09-30.md)
- CR-37: GPU `look/textures.ts` compiles about 20 kernels twice, synchronously on the render thread. Source: [reports/code-review-2026-09-30.md:57](reports/code-review-2026-09-30.md)
- The duplication noted includes "three guided filters; four sRGB→linear tables; the harmonize WGSL in three copies". Source: [reports/code-review-2026-09-30.md:98](reports/code-review-2026-09-30.md)
- Negative result FUND E2: date-matched appearance renders (photo-time sun, snow, Sentinel-2) gave no matching gain, and "the flat snow tint wipes out rock texture". This is about matching renders, not display. Source: [reports/negative-results.md:55](reports/negative-results.md)
- Negative result: "Hillshade renders for matching" were worse than satellite renders. Source: [reports/negative-results.md:24](reports/negative-results.md)
- Negative result: deck colour-pass micro-fixes made no perf change ("The cost was MSAA fill plus `gl_FragDepth`"). Source: [reports/negative-results.md:109](reports/negative-results.md)
- Roadmap L3: "iOS rendering path (half-float or WebGPU). Splats make the gap bigger", due before the share-link beta reaches iOS. Source: [reports/roadmap.md:91](reports/roadmap.md)
- WebGPU colour space: "WebGPU blends in linear light into rgba16float; WebGL blended sRGB bytes on the canvas. Translucent edges… are slightly different by design." Source: [src/lib/deck-webgpu/README.md](src/lib/deck-webgpu/README.md) ("Known gaps")
- Step Inside smear gate: 4 % (three) / 15 % (deck) against an 80 % target. This is a visible near-field artefact. Source: [reports/status.md:13](reports/status.md)

### Inferences
- No document tracks a "visual quality backlog". A new aesthetics report would be the first, so it should define its own acceptance measures (stills, A/B, user preference).

### Gaps
- `reports/README.md` and `out/lead/deck-parity/styling.md` (the styling design doc, §1–3) were not read in full. They may hold per-preset tuning notes.

---

## 6. What are the technical constraints?

### Technical constraints

#### Takeaway
The stack is:
- deck.gl 9.4.0-beta.4, vendored from PR #10752
- luma.gl 10.0.0-alpha.2 (alpha)
- three 0.186
- 3d-tiles-renderer 0.5.3
- React 19, TanStack Start, Tailwind 4, Vite 8

There is no MapLibre or Mapbox. WebGL2 ships, and WebGPU is lab-only. Perf gates are about 55–60 fps for photo interactions and ≥45 fps for world orbit. GLSL is shared between three and deck through a block abstraction, and must be re-ported to WGSL for WebGPU.

#### Cited Findings
- Dependencies:
  - `@deck.gl/core` and `@deck.gl/layers` from `vendor/deck/deck.gl-*-9.4.0-beta.4.tgz`
  - `@luma.gl/*` `10.0.0-alpha.2` (core, engine, gpgpu, shadertools, webgl, webgpu), with overrides
  - `three ^0.186.1`
  - `3d-tiles-renderer 0.5.3`
  - `@loaders.gl/* ^5.0.0-alpha.7`
  - `onnxruntime-web ^1.30.0`
  - `react ^19.2.0`, `tailwindcss ^4.1.18`, `vite ^8.0.0`, `@tanstack/react-start ^1.168.58`
  - `lucide-react`, `tw-animate-css`
  - no maplibre, mapbox or suncalc

  Source: [package.json:23-80](package.json)
- The luma alpha has broken manifests, worked around with overrides and `legacy-peer-deps`. Source: [src/lib/gpu/README.md](src/lib/gpu/README.md) ("Layers")
- Shared shader code: `defineBlock` gives one field table and two bindings, three uniforms and a luma std140 block (vec3 stored as vec4). Source: [src/lib/look/glsl/block.ts:1-6](src/lib/look/glsl/block.ts)
- Terrain defines exclude composite-only features because "deck's uniform blocks are not free on ANGLE/Metal". Source: [src/lib/look/look-key.ts:34-45](src/lib/look/look-key.ts)
- Perf budget, the deck flip gate:
  - photo interactions ≥ 55 fps
  - world orbit ≥ 45 fps
  - measured run D: photo drag 59.1–59.5, Blend lens 59.6–59.9, world orbit 59.3–59.9, overlay slider/reveal 59.8
  - export 103–131 ms cold, 76–87 ms warm
  - first terrain frame about 2.5–3.3 s
  - GPU colour pass 6.5–8.9 ms per drag frame, with MSAA off while interacting

  Sources: [reports/roadmap.md:28](reports/roadmap.md); [reports/deck-default.md:7-12, 41-56](reports/deck-default.md)
- Interactive quality trade-offs:
  - `PhotoCompositor.setInteractive` turns MSAA off during input and back to full on settle, with 2× MSAA at DPR ≥ 2.
  - Imagery uses about 96 MB pages under a 300 MB LRU budget.

  Source: [reports/deck-default.md:74-79](reports/deck-default.md)
- DPR is capped at 2 in both engines. Canvas antialias is off at DPR ≥ 2 on deck. Sources: [src/lib/engine.ts:553](src/lib/engine.ts); [src/lib/deck/engine.ts:533-548](src/lib/deck/engine.ts)
- WebGPU port, measured on Chrome / Apple Metal only:
  - first frame 2.4–2.5 s
  - GPU memory 350–398 MiB in the photo view, against 175–188 MiB for WebGL
  - `float32-filterable` required
  - deck WebGPU blockers: View `clear` broken, no WGSL layer-extension hooks, `LayersPass` `clearDepth: 1`, and Vite resolving deck's `visgl:webgl-only` build

  Source: [src/lib/deck-webgpu/README.md:16-44, 265-310](src/lib/deck-webgpu/README.md)
- `src/lib/three-webgpu` is a spike that is not wired in: three's `WebGPURenderer` with a TSL terrain material. Source: [src/lib/gpu/README.md](src/lib/gpu/README.md) ("three.js on WebGPU")
- Look passes are budgeted CPU-side at ≤512 px per pose settle, "a few ms" for the guided filter and about 50 ms for the haze fit at 1024². Sources: [src/lib/look/guided-filter.ts:4](src/lib/look/guided-filter.ts); [src/lib/look/haze-fit.ts:9](src/lib/look/haze-fit.ts)
- The roll panorama strip uses its own dependency-free WebGL2 renderer, separate from deck and three. Source: [src/lib/roll/mosaic/panoGL.ts:1-2](src/lib/roll/mosaic/panoGL.ts)

#### Inferences
- Any new visual technique has to be written four times: GLSL for three, GLSL for deck (through `block.ts`), WGSL for deck-webgpu, and CPU parity checks. Alternatively, it waits for the WebGPU switch. This cost argues for techniques that are post-process or composite-stage (screen space) over per-material changes.
- Depth-precision techniques (reversed-Z) are blocked on deck WebGL by the `LayersPass` clear. They are only realistic on the WebGPU path.

#### Gaps
- Mobile/iOS performance budgets are not measured. All bench numbers are on an Apple-Silicon Mac with Chrome; Firefox headless renders, and Safari/Windows smoke tests are open.
- Bundle-size impact of the look features was not found. The only figure seen is the sky model at about 4.5 MB.
