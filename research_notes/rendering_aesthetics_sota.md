# Rendering & aesthetics SoTA for Summit Lens (Sep 2026)

Scope: techniques that can ship in WebGL2 GLSL / TypeScript (three.js r186, deck.gl 9.4) within days. Each section gives (a) state of the art, (b) the recommended technique for this app, with formulas and parameters, and (c) cost.

**Current baseline** (from `src/lib/materials.ts`, `src/lib/deck/terrain-layer.ts`, `src/lib/engine.ts`):
- Haze is one grey exponential term: `1-exp(-range*1.8e-5*uHaze)`, clamped at 0.85, with a fixed colour `(0.725,0.804,0.878)`.
- Shading is Lambert with a `0.25*sky` term.
- The hypsometric ramp is a hand-made 5-stop ramp.
- Contours use `fwidth` with density fade.
- The photo drape uses a range-buffer shadow test with incidence weighting at `mix(0.35,1,inc)`.
- `logarithmicDepthBuffer: true`.

Most of the upgrades below slot into these existing functions.

---

## 1. Aerial perspective and atmosphere

### (a) SoTA
- **Hillaire 2020**, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR / CGF 39(4)), is the Unreal Engine sky. It uses four small LUTs:
  - transmittance, 256×64
  - multiple-scattering, 32×32
  - sky-view, 192×108, lat-long around the camera with extra resolution near the horizon
  - aerial-perspective froxel volume, 32×32×32, covering about 32 km of depth
  - Multiple scattering uses an analytic infinite-order approximation, so no high-dimensional precompute is needed and atmosphere parameters can be animated.
  - Paper: https://onlinelibrary.wiley.com/doi/abs/10.1111/cgf.14050
  - Reference code: https://github.com/sebh/UnrealEngineSkyAtmosphere
  - Shadertoy port: https://www.shadertoy.com/view/slSXRW
- **Bruneton & Neyret 2008**, precomputed scattering (new 2017 implementation, which also ships a WebGL2 demo): 4D scattering and 2D irradiance textures, which are costly to regenerate. https://ebruneton.github.io/precomputed_atmospheric_scattering/ and https://github.com/ebruneton/precomputed_atmospheric_scattering
  - **@takram/three-atmosphere** is a production three.js port. It has an `AerialPerspective` post-effect that takes a depth buffer and adds transmittance plus sun and sky inscatter. It is the fastest path to physically correct AP in three.js. https://www.npmjs.com/package/@takram/three-atmosphere and https://github.com/takram-design-engineering/three-geospatial
- **Analytic skies:** Preetham 1999 (weak at sunset and high turbidity) and **Hosek-Wilkie 2012** (https://dl.acm.org/doi/10.1145/2185520.2185591), which is fitted to brute-force simulation, handles ground albedo, and is much better at low sun. A comparison of 8 clear-sky models is at https://arxiv.org/pdf/1612.04336.
- **Exponential height fog** with an analytic line integral, as in UE and Mapbox. Mapbox GL v3 fog has `range`, `horizon-blend`, `high-color`, `space-color`, and a "vertical" fog height term (https://docs.mapbox.com/style-spec/reference/fog/).

### (b) Recommended technique
The app's job is to **match a photograph**, not to simulate a planet. Physical LUTs matter less than getting A (airlight colour) and β (extinction) right for this photo. Build it in three layers.

**1. Analytic height-integrated optical depth (replaces `haze()`).**

Let the camera be at altitude h_c and the fragment at h_p, at slant distance d. The density scale height is H, with H_R = 8000 m for Rayleigh and H_M = 1200 m for Mie/aerosol. Then:

```
τ_i(d) = β_i · d · H_i · (e^{-h_c/H_i} − e^{-h_p/H_i}) / (h_p − h_c)     (|h_p−h_c| > 1 m)
τ_i(d) = β_i · d · e^{-h_c/H_i}                                        (otherwise)
T = exp(−(τ_R + τ_M))          // vec3, chromatic
L = L_surface · T + A · (1 − T)
```

Sea-level coefficients (Hillaire/Bruneton defaults, per metre):
- β_R = (5.802, 13.558, 33.1)·1e-6
- β_M,scatter = 3.996e-6
- β_M,ext = 4.40e-6
- Ozone absorption, (0.650, 1.881, 0.085)·1e-6, can be ignored below 10 km.

Scale β_M by a **turbidity/visibility** slider. Koschmieder gives V ≈ 3.912/β_ext, so a 50 km visibility means β_ext ≈ 7.8e-5 (mostly Mie near the ground). Rayleigh alone makes distant ridges blue. Mie makes them grey-white and brightens toward the sun. This chromatic split is exactly what reads as "Alpine depth".

**2. Airlight colour with sun phase.**

```
cosθ = dot(viewDir, sunDir)
P_R  = 3/(16π) · (1 + cos²θ)
P_M  = Cornette–Shanks: 3/(8π)·(1−g²)(1+cos²θ)/((2+g²)(1+g²−2g cosθ)^{1.5}),  g = 0.76–0.8
A    = E_sun · (β_R·P_R + β_M·P_M)/(β_R + β_M) + A_amb
```

Use this for the synthetic render modes. For the photo compositing modes, **replace A with a colour sampled from the photo's own sky just above the skyline in the same image column**. You already have a skyline and a sky mask. Take a median over a 20–40 px band, smoothed across columns. This one trick removes most of the "pasted-on" look of blend and swipe modes.

**3. Fit haze to the photo (dark channel + rendered depth).**

He, Sun & Tang's dark channel prior (CVPR 2009 / TPAMI 2011, https://projectsweb.cs.washington.edu/research/insects/CVPR2009/award/hazeremv_drkchnl.pdf, IPOL re-implementation https://www.ipol.im/pub/art/2024/530/article_lr.pdf) models the image as I = J·t + A(1−t).
- Normally t is unknown. **Here the rendered range d(x) is known**, so the problem becomes a well-posed regression.
- Algorithm (CPU or worker, on a 512 px downsample of photo plus range buffer):
  1. Mask out sky and any pixel with d < 500 m. Compute the dark channel `DC(x) = min_{Ω 15px} min_c I_c(x)`.
  2. A: the brightest 0.1 % of DC pixels, taking the max-intensity photo pixel among them (He's rule). Clamp it toward the horizon-sky median to be robust to snow. Snow violates the prior, so exclude pixels with high luminance and low saturation at d < 5 km.
  3. Bin pixels by log-distance (for example 16 bins from 0.5 to 150 km). In each bin take the 5th percentile per channel, p_c(d). These are the "dark objects".
  4. Fit per channel `p_c(d) = A_c − (A_c − J0_c)·exp(−β_c·d)` by grid search on β_c ∈ [1e-6, 3e-4] (log-spaced, 64 steps) with closed-form least squares for J0_c at each β. This gives a **chromatic β_c and a black level J0**.
  5. Feed (A, β_c) into the terrain shader's `haze()` so the rendered satellite or relief fades exactly like the photo. Use `t_photo = exp(−β·d)` for the depth-aware blends in section 5.
- Optional: "dehaze" the photo (J = (I−A)/max(t,0.1) + A) before draping it on the orbit view. Otherwise distant ridges look milky when seen from the side.

**4. Sky.** In render-only modes, draw the sky with Hosek-Wilkie (needs a coefficient table, ~15 KB; Bruneton's clear-sky-models repo has the C header) or with a Hillaire sky-view LUT, keyed to the SunCalc sun. In blend modes, keep the photo's sky.

### (c) Cost
- Analytic τ plus phase: under 1 hour, about 20 GLSL lines, negligible per-fragment cost.
- Haze fit: about 1 day, JS, runs once per photo in under 50 ms on a downsampled image.
- @takram/three-atmosphere: about 1–2 days to integrate, but it needs an ECEF/ellipsoid-scaled scene and `postprocessing`, and will not share with deck.gl.
- Full Hillaire LUTs in raw WebGL2: 3–5 days. Four passes, where the 3D texture is written slice-by-slice via `framebufferTextureLayer`.

---

## 2. Cartographic relief shading and matching lighting

### (a) SoTA
- **Swiss manual shading (Imhof)** principles:
  - Light from the upper-left (NW) regardless of the true sun.
  - Local rotation of the light to keep ridges readable.
  - Aerial perspective in the relief itself: high peaks get more contrast, valleys go grey and blue.
  - Generalisation, which removes small bumps.
- **Jenny et al. 2020, "Cartographic Relief Shading with Neural Networks"** (IEEE TVCG, https://arxiv.org/abs/2010.01256) trained a U-Net on swisstopo manual shadings. It is productised as **Eduard** (https://eduard.earth/, a macOS app plus Eduard Cloud; releases through 2025). Follow-up work adapts it to scale and resolution (IJGI 2024, https://doi.org/10.3390/ijgi13090326).
- **swisstopo's own multidirectional hillshade** combines 6 light directions, with the mean from NW (https://opendata.swiss/en/dataset/swissalti3d-reliefschattierung-multidirektional).
- **Sky-view factor** (Zakšek, Oštir & Kokalj 2011, https://www.mdpi.com/2072-4292/3/2/398; RVT toolbox https://github.com/EarthObservation/RVT_py) is diffuse illumination by visible-sky fraction. It separates ridges and gullies without directional bias.
- **Sun position**: SunCalc (https://github.com/mourner/suncalc). **Note: v2 returns degrees, azimuth clockwise from N, and refraction-corrected altitude. v1 returned radians, azimuth from S.** Pin the version.

### (b) Recommended technique
Offer two lighting modes. **"Photo light"** is physically matched, for blends and drape. **"Cartographic"** is Swiss-style, for the relief render and the orbit map.

**Photo light:**
- Sun direction comes from EXIF `DateTimeOriginal` plus `OffsetTimeOriginal`, or the timezone from lat/lon. Convert to ENU: `s = (sin az·cos alt, cos az·cos alt, sin alt)` with az clockwise from N.
- Irradiance split from a clear-sky model. Direct normal irradiance is roughly `E_dir = E0·exp(−τ_air·m)`, with air mass `m ≈ 1/(sin alt + 0.50572·(alt°+6.07995)^−1.6364)` (Kasten-Young) and τ_air ≈ 0.1–0.2. Diffuse is `E_sky ≈ 0.1–0.25·E0·sin alt`.
- Sun colour is the Rayleigh transmittance along the sun path, `exp(−β_R·8000·m)`. This is what makes the low sun warm. Evening light appears automatically.
- **Cast shadows** matter more than any shading model in mountain photos. Two options:
  - Render a shadow map of the terrain from the sun: an orthographic 2048² map over the visible AOI, with depth bias ≈ 2 texels · tan(slope).
  - Or, cheaper and alias-free on DEM grids, a **horizon-map** test: per DEM tile, precompute the horizon angle in 16 azimuths on a worker (or in a fragment pass that ray-marches the heightmap for 64 steps up to about 20 km). Shadowed means `sunAlt < horizon(az)` interpolated. The same data gives the SVF for free.
- Shading: `L = albedo·(E_dir·max(n·s,0)·shadow + E_sky·SVF·(0.5+0.5·n_z)) `, where `n_z` is the upward normal component, then AP as in section 1.
  - Albedo: snow 0.8 above a snowline set by the user or from imagery; rock 0.25; meadow 0.15.

**Cartographic (Swiss) shading, for GLSL on DEM normals:**
- Multidirectional, swisstopo-like. Use 6 azimuths at 270°, 300°, 315°, 330°, 360° and 225°, altitude 45°, with weights favouring NW, e.g. (0.1, 0.2, 0.3, 0.2, 0.1, 0.1). Or use Mark's 1992 aspect-weighted method: `w_i = sin²(aspect − az_i)`, which lights each slope from the direction that maximises its contrast.
- **Generalise:** shade from normals computed on a 2–4× downsampled or low-pass DEM mip (sample the height texture at a higher LOD for normals). Mix the fine normal back at 30 %. This is the core of the Eduard/Imhof look without a network.
- **Elevation-dependent contrast (Imhof aerial perspective):** `shade = mix(0.72, shade, k)` with `k = mix(0.55, 1.0, smoothstep(h_low, h_high, h))`. Valleys go flat blue-grey and peaks get full contrast.
- **SVF or ambient occlusion:** precompute per tile (16 directions × 32 steps over a 1–3 km radius). Multiply by `mix(0.6,1,SVF)`, or use `1 − SVF` as a blue-tinted "valley ink". Storing it in the alpha of the normal texture keeps a single fetch.
- **Neural option:** Eduard Cloud exports shaded rasters. For a fixed AOI such as the Swiss Alps, precompute a Swiss-style shading tile pyramid offline and drape it as imagery. It is a zero-runtime-cost "wow" layer, but licensing must be checked.

### (c) Cost
- SunCalc plus EXIF sun plus clear-sky colour: half a day.
- Multidirectional plus generalised normals plus elevation contrast: half a day of GLSL.
- Horizon/SVF precompute in a worker: 1–2 days. About 30 ms per 256² tile for 16 directions × 32 steps in JS; faster as a GPU pass.
- Sun shadow map in three.js: 1 day, but it has aliasing issues on 30 m DEMs. Horizon maps are preferable.

---

## 3. Panorama and landscape art styles

### (a) SoTA
- **Heinrich Berann**, as documented by Tom Patterson ("A View From On High", Cartographic Perspectives 36, https://cartographicperspectives.org/index.php/journal/article/view/cp36-patterson; https://www.shadedrelief.com/berann-panoramas/):
  - Progressive vertical exaggeration.
  - A curved "bent" ground plane so the foreground is seen from above and the background frontally.
  - Rotated and widened valleys.
  - Strong atmospheric blue in the background.
  - Warm-lit ridges against cool shadows.
  - Painted texture.
- Computational versions: Jenny's "terrain bender" and plan-oblique relief. deck.gl and three.js can do the bend in the vertex shader.
- **NPR lines:**
  - Silhouettes are depth discontinuities.
  - Suggestive contours (DeCarlo et al. SIGGRAPH 2003, https://gfx.cs.princeton.edu/pubs/DeCarlo_2003_SCF/) are zero crossings of radial curvature with positive derivative.
  - Ridge and valley lines are principal-curvature extrema, or simply DEM-based: plan curvature thresholds or flow accumulation.
  - PeakFinder's signature look is a clean black-on-white line panorama (https://www.peakfinder.com/mobile/).
- **Illuminated (Tanaka) contours:** Kennelly & Kimerling 2001 (https://doi.org/10.1559/152304001782173709). Line brightness follows `n·l` (white on lit slopes, dark on shaded ones) and line width ∝ |cos| to reduce terracing.
- **Hypsometric tints:** Patterson & Jenny's **cross-blended hypsometric tints** (https://www.shadedrelief.com/hypso/hypso.html; rationale https://cartographicperspectives.org/index.php/journal/article/view/cp69-patterson-jenny). Ramps are available in tidyterra (https://search.r-project.org/CRAN/refmans/tidyterra/html/scale_cross_blended.html).

### (b) Recommended technique
**Screen-space ink lines (post pass on the range and normal targets you already render):**
- **Silhouette/occluding lines:** use the log-depth or range buffer `r`. The edge strength is `e = |∇ log r|` via a Sobel filter on log range. A threshold of `e > 0.02–0.05` per pixel catches ridge-behind-ridge edges while ignoring slopes. **Depth-varying width:** width_px = clamp(3.0 − 0.8·log10(r/1000), 0.6, 3.0), so near ridges are about 3 px and 100 km ridges about 1 px. Implement it by dilating: sample the Sobel at radius = width. Opacity is `T(r)^0.5`, where T is the AP transmittance, so lines fade into haze like Berann's.
  - Only mark the **near side** of a discontinuity, the pixel with the smaller r, so the line sits on the foreground ridge.
- **Crease/ridge lines:** use screen-space normal discontinuity, `1 − dot(n, n_neighbor) > 0.15`. Alternatively use a DEM-space ridge mask (plan curvature `κ_p < −k` with slope > 20°) precomputed per tile and rendered as a texture channel.
- **Suggestive contours:** the screen-space approximation is valleys of `n·v` (where n·v has a local minimum and n·v < 0.3). The cheap version is DoG on `n·v`. Use it sparingly; for terrain, ridge/valley lines read better.
- The skyline line is special. Render it at 1.5× width, with optional white under-glow.

**Illuminated contours (Tanaka), in the existing `contourLine`:**
```
float lit = dot(normalize(n.xy), -normalize(sunDir.xy));   // aspect vs sun azimuth
vec3 lineCol = lit > 0.0 ? mix(base, vec3(1.0), 0.8*lit) : mix(base, vec3(0.1,0.1,0.15), -0.8*lit);
float w = widthPx * (0.6 + 0.8*abs(lit)) * mix(1.0, 1.6, slope01);   // Kennelly–Kimerling
```
Draw it over a mid-grey or over hypsometric bands. It is very effective in the orbit and "topo" views.

**Hypsometric tints:**
- Replace `hypso()` with a **1D LUT texture**, 256×1 RGBA. Load Patterson cross-blended ramps (humid, arid, polar variants) and an Alpine ramp: green lowlands → yellow-green → tan → grey rock → white.
- Interpolate in **OKLab**, not sRGB, when building the LUT in TS. This avoids muddy midtones.
- Key the ramp to **absolute elevation for the Alps**, e.g. stops at 400, 1000, 1800, 2400, 3000 and 4000 m, plus treeline and snowline sliders. Do not key it to the view's min/max. The current ramp uses `uElevRange`, which changes colour meaning between photos.
- **Shaded bands:** quantise elevation `floor(h/interval)`, colour from the LUT, multiply by `0.55 + 0.45·shade`. The current style 4 already does this. Add a 1-px darker band edge via `fwidth` for a printed-map crispness.

**Berann mode (orbit view, optional):**
- In the vertex shader, add progressive exaggeration and bend: `z' = z·(1 + k_v·s) − k_b·s²`, where s is the distance along the view axis beyond a pivot (k_v ≈ 0.5–1.0 and k_b chosen so the far terrain rises into view).
- Pair it with strong Rayleigh AP, warm key light from 30° elevation and cool fill `(0.55,0.65,0.85)` in shadows.

### (c) Cost
- Screen-space ink pass: 1 day. It needs a normal plus range MRT, and you already render range.
- Tanaka contours: 2 hours.
- LUT tints plus OKLab builder: half a day.
- Berann bend: half a day, but it breaks photo registration, so it is orbit-only.

---

## 4. Peak label placement in panoramas

### (a) SoTA
- **PeakFinder** and **PeakVisor** use vertical leader lines from the summit up to a label row. Text is often rotated about 45–60° or stacked, with a name plus elevation and distance. Visibility is tested against the terrain, and labels are revealed by zoom (https://peakvisor.com/panorama.html).
- The literature:
  - **Dynamic map labeling** (Been, Daiches & Yap 2006, https://dl.acm.org/doi/10.1109/TVCG.2006.136): no popping, invariant selection over zoom.
  - **Hedgehog labeling** (Tatzgern et al. IEEE VR 2014, https://www.researchgate.net/publication/261050920): external labels placed in 3D for temporal coherence.
  - AR clutter studies, e.g. https://arxiv.org/pdf/2507.00198.

### (b) Recommended technique
1. **Candidate set:**
   - Peaks from OSM/GeoNames, keeping those within the frustum and within max range (≈ 200 km in clear air).
   - **Occlusion:** compare the peak range against the range buffer at the projected pixel with tolerance `max(15 m, 0.003·r)`. Also sample a 5×5 neighbourhood above the summit, and call it visible if the summit is within 2 px of the rendered surface. Summits sit exactly on skylines where one pixel of error flips the result.
   - Read the range buffer once per pose via async readback (section 7).
2. **Priority score:**
   `score = w1·log(prominence+1) + w2·log(elev) − w3·log(dist) + w4·[named/famous] + w5·angularIsolation`
   Topographic prominence is the key variable. Use a precomputed prominence table (e.g. Kirmse & de Ferranti's worldwide prominence dataset) or approximate it with "highest point within 2–5 km". "Angular isolation" is the distance in screen degrees to a higher visible peak.
3. **Layout:**
   - Put labels in a band above the skyline. Each label's anchor x is the summit x. The label's y is `max(skylineY(x ± labelHalfWidth)) − margin`, so it never covers terrain.
   - Greedily place in descending score. Reject on overlap (AABB, or OBB for rotated text) and fall back to candidate positions: rotated 45°, stacked one level higher, or a shorter name.
   - Leader line: 1 px, from 6 px above the summit to the label, with a 4 px dot or triangle at the summit.
   - For dense ranges, use **rotated 50° text on a common baseline** (PeakFinder style). It packs about 3× more labels.
4. **Temporal stability** while swiping or orbiting: add hysteresis, keeping already-shown labels unless the score falls 20 % below the threshold. Fade in and out over 150 ms, and never swap in the same frame.
5. **Typography:**
   - Use a humanist sans with good small-size hinting: **Inter**, **Source Sans 3**, or **Frutiger**-likes. swisstopo maps use Frutiger for names, and "Swiss Sans"-style condensed faces suit rotated labels. Use a condensed width (e.g. Roboto Condensed, IBM Plex Sans Condensed) for panoramas.
   - Name at 600 weight, 13–15 px. Elevation at 400 weight, 11 px, 70 % opacity, tabular numerals, with a thin space before "m".
   - **Halo:** 2–3 px, colour = locally inverted photo luminance (dark halo over bright sky, light over dark), with 60–80 % opacity and a soft falloff. Or use SDF text in WebGL with halo via the SDF threshold `smoothstep(0.5−halo, 0.5−halo+aa, d)`.
   - Scale size and opacity mildly by distance (−15 % at 100 km), so near peaks dominate.

### (c) Cost
Prominence-scored greedy layout plus skyline band plus hysteresis: 1–2 days in TS/React DOM, fine for ≤ 150 labels. SDF text in deck.gl TextLayer is already available (`fontSettings.sdf`, `outlineWidth`).

---

## 5. Compositing photos with renders

### (a) SoTA
- Edge-aware mask refinement with the **guided filter** (He et al. 2010/2013, https://ieeexplore.ieee.org/document/6319316/; Fast GF https://arxiv.org/abs/1505.00996). Google's sky segmentation runs the network at low resolution, then uses a weighted guided filter for edge-aware upsampling (https://google.github.io/sky-optimization/).
- **Joint bilateral upsampling** (Kopf et al. 2007).
- Colour harmonisation:
  - Reinhard 2001 statistics transfer in lαβ (https://research-information.bris.ac.uk/en/publications/color-transfer-between-images/).
  - Histogram and CDF matching.
  - The Pitié MKL/IDT transfer.
  - Deep harmonisation (DoveNet and successors) is too heavy here.
- **Poisson / gradient-domain blending** (Pérez 2003) and **Laplacian-pyramid blending** (Burt & Adelson).
- Tone mapping:
  - **Khronos PBR Neutral** (https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/README.md)
  - **AgX** (minimal GLSL: https://iolite-engine.com/blog_posts/minimal_agx_implementation)
  - ACES
  - three.js ships all three (`NeutralToneMapping`, `AgXToneMapping`, `ACESFilmicToneMapping`).

### (b) Recommended technique
Order of the compositing pipeline, per output pixel:

1. **Masks:**
   - Sky mask. If it is coarse (from segmentation or skyline), refine with a **guided filter on the photo** at full resolution: r = 8–16 px, ε = 1e-3 to 1e-2 (intensities in [0,1]). Use the photo's luminance or the RGB covariance version.
   - In GLSL this is 2 box-filter passes (compute mean_I, mean_p, corr_Ip, var_I → a, b; then box(a), box(b)), about 6 separable blur passes. On a 12 MP photo, run the Fast GF with s = 4.
   - Result: soft, hair-accurate treeline and ridge edges.
2. **Colour harmonisation of the render to the photo:**
   - **Region-matched Reinhard in Lab** (use OKLab or CIELAB rather than lαβ, which is fine too). Compute μ and σ per channel over the pixels where both the photo terrain and the render are valid, **stratified by distance bin** (near, mid and far, e.g. <3 km, 3–15 km, >15 km). Apply `c' = (c − μ_r)·(σ_p/σ_r) + μ_p` per bin and interpolate between bins by range.
   - Clamp σ ratios to [0.5, 2].
   - This automatically matches haze, white balance and exposure. Combine it with the fitted AP from section 1: apply AP first, then residual stats.
   - Satellite imagery (captured at noon, from nadir) versus a photo at golden hour will never fully match. Harmonise luminance at 100 % and chroma at about 60 %, so the swap still reads as "map".
3. **Transition shaping:**
   - **Swipe:** a feathered edge of 1.5 % of image width, plus a 1-px bright hairline for the "UI" feel.
   - **Distance cut-off:** `α = smoothstep(d0·(1−f), d0·(1+f), r)` with f ≈ 0.08. Modulate it by the edge-aware mask, i.e. guided-filter α with the photo as guide, so the cut hugs ridges and does not slice across slopes. Better still, cut in *transmittance* space, `α = smoothstep(t0+δ, t0−δ, exp(−β r))`, which is perceptually uniform in haze.
   - **Brush:** paint at 1/4 resolution, then guided-filter upsample with the photo as guide. This gives "smart brush" behaviour for free.
   - Where the photo and render overlap at high-frequency boundaries, use a **Laplacian-pyramid blend** (5 levels via mip chain: blend each level with the mask at that level's blur). It is a big quality jump over alpha for about 10 texture passes. Full Poisson is unnecessary.
4. **Avoid the pasted-on look:**
   - Apply the photo's own AP (A, β) to the render.
   - Add matched **grain/noise**: estimate the photo noise σ from flat sky regions and add Gaussian luma noise of the same σ to the render.
   - Match **sharpness**: blur the render with σ_px ≈ 0.5–1.0 to match the iPhone's softness at 12 MP, or apply mild unsharp to low-resolution satellite.
   - Add a subtle vignette identical to the photo's.
5. **Tone mapping and output:**
   - Render terrain in linear HDR (HalfFloat target).
   - For **render-only modes**, use **AgX** for sunsets and snow (graceful highlight desaturation) or **Khronos PBR Neutral** for the "map" look (preserves the satellite and topo base colours in [0,0.8]).
   - For **blend modes**, do not tone-map the photo. Tone-map the render with Neutral with exposure chosen so its median luminance equals the photo's in the matched region.
   - PBR Neutral's `startCompression = 0.8 − 0.04` and `desaturation = 0.15` defaults are good.
   - **Dither** before 8-bit quantisation, because sky gradients and haze band badly: `col += (ign(gl_FragCoord.xy) − 0.5)/255.0`, where IGN is interleaved gradient noise `fract(52.9829189·fract(dot(p, vec2(0.06711056, 0.00583715))))`. Or use a triangular-PDF blue-noise texture. Do this in the final output pass only.

### (c) Cost
- Guided filter (GLSL, separable box): 1 day.
- Distance-binned Reinhard: half a day (stats on a 256² readback).
- Laplacian blend: 1 day.
- Grain, dither and tone-map switch: 2–3 hours.

---

## 6. Projective texturing and draping quality

### (a) SoTA
- Projective texture mapping with a shadow-map visibility test (Segal 1992; Everitt's NVIDIA notes). Photogrammetry texturing (e.g. Waechter et al. 2014, "Let There Be Color!") adds view selection by incidence and resolution, seam levelling, and Poisson colour adjustment.
- The drape already has a range-buffer occlusion test and incidence weighting.

### (b) Recommended upgrades
1. **Occlusion test quality:**
   - Replace the fixed `r < seen·1.015 + 15` with a **slope-scaled bias**: `bias = 2·texelFootprint(r)·tan(acos(clamp(dot(n,-ray),0.05,1)))`, where the texel footprint = `r·(fovRad/rangeTexWidth)`.
   - Use **PCF** with a 3×3 sample of the range texture, which softens the "shadow edges" of the photo at ridge silhouettes.
   - Store range as **R32F** (or RG16F with split) and sample NEAREST for the test.
2. **Stretch suppression:**
   - Compute the texel anisotropy directly as `stretch = 1/max(dot(n, −ray), 1e-3)` (texels of the photo stretched along the slope).
   - Weight `w = smoothstep(6.0, 2.5, stretch)`, i.e. full above an incidence of ~24° and zero below ~10°. Replace the photo there with the base render (satellite or relief) that has been *colour-matched* per section 5, so gaps look intentional.
   - Also fade by **photo resolution**: metres per photo pixel `= r·ifov`, and if that exceeds 4× the DEM cell, blend toward the base.
3. **Seam feathering:**
   - Near the occlusion boundary, feather over 3–6 photo pixels using a distance-to-occlusion-edge field. Compute it once: take the binary visibility in photo space → jump-flood or 2–3 dilate/blur passes → a soft mask texture.
   - Also feather the photo frame border (10–20 px) and foreground masks.
4. **Filtering:**
   - Upload the photo with mipmaps, `LinearMipmapLinear`, `anisotropy = renderer.capabilities.getMaxAnisotropy()` (typically 16).
   - For projective lookups use `textureGrad` with the derivatives of `puv` so mip selection is correct at grazing angles. Automatic derivatives are fine in three.js since `puv` is computed per fragment.
   - Keep the full 12–48 MP photo as a **2-level texture set**: a 4096² downsample plus on-demand crops when zoomed in, because WebGL `MAX_TEXTURE_SIZE` is often 8192–16384 on iOS.
5. **Multi-resolution DEM under the drape:** the drape is only as good as the geometry. Use swissALTI3D at 0.5–2 m within 2 km of the camera and Mapterhorn beyond, and feather the DEM transition over 200 m to avoid a visible step in the projected photo.
6. **Orbit view:** show unseen areas with the colour-matched satellite render desaturated by 30 %, plus a subtle hatch pattern at 5 % opacity. This communicates "no photo data here" and looks deliberate.

### (c) Cost
- Bias, PCF and stretch weighting: half a day.
- Seam distance field: 1 day.
- Photo mip, anisotropy and tiling: half a day.

---

## 7. Performance

### (a) SoTA
- **Terrain LOD:**
  - **CDLOD** (Strugar 2009, https://aggrobird.com/files/cdlod_latest.pdf; code https://github.com/fstrugar/CDLOD): a quadtree of fixed grids plus vertex-shader geomorphing, with a distance-based LOD function.
  - **Martini/RTIN** (https://github.com/mapbox/martini): irregular mesh per tile in about 1 ms per 257² tile, used by deck.gl's TerrainLayer.
  - Clipmaps.
- **Depth:**
  - **Reversed-Z** needs `EXT_clip_control`, now in Chrome and Safari, plus a float depth buffer. It is strictly better than log depth, which disables early-Z because it writes `gl_FragDepth` (https://github.com/KhronosGroup/WebGL/issues/2197).
  - three.js WebGLRenderer has `reverseDepthBuffer: true`, with fixes landing around r175 (https://github.com/mrdoob/three.js/pull/30809).
  - The Outerra log-depth formula is at https://outerra.blogspot.com/2013/07/logarithmic-depth-buffer-optimizations.html.
- **Readback:**
  - WebGL2 PBO plus `fenceSync` plus `getBufferSubData` gives non-blocking readback (MDN best practices, https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices).
  - three.js has `renderer.readRenderTargetPixelsAsync()`.
  - Float targets need `EXT_color_buffer_float`, which is universal in 2026.
- **WebGPU:**
  - Ships by default in Chrome/Edge (since 2023), Safari 26 (macOS/iOS 26, June 2025), and Firefox 141+ (Windows) and 145+ (Apple Silicon macOS). Linux and Android Firefox were due in 2026 (https://web.dev/blog/webgpu-supported-major-browsers, https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).
  - iPhone users on iOS 26 have it. Older iOS does not.
- **three.js:**
  - WebGPURenderer with **TSL** is the actively developed path, with automatic WebGL2 fallback (https://threejs.org/manual/en/webgpurenderer.html).
  - `ShaderMaterial` raw GLSL is **not** supported by WebGPURenderer. Materials must be TSL node materials.
  - Post-processing moves to the node-based `PostProcessing` class.
  - deck.gl 9.x is on luma.gl 9 with a WebGPU backend still maturing.
  - Mixing deck.gl and three.js in one WebGPU device is not practical yet.

### (b) Recommendations
1. **Depth:** switch `logarithmicDepthBuffer` → `reverseDepthBuffer: true` when `EXT_clip_control` is present (otherwise keep log depth). Gains:
   - early-Z comes back
   - custom shaders no longer need the `logdepthbuf_*` chunks
   - shadow and range tests get precise depth
   - Use near = 1 m and far = 400 km. With a 32F reversed buffer, precision is under 1 cm at 1 km and about 10 m at 300 km. Keep writing the linear range to a separate R32F target for all app logic; do not reconstruct from depth.
2. **LOD:**
   - For the photo camera (a static pose), use a **screen-space-error quadtree**: choose tile z so the DEM cell projects to ≤ 2 px. Per tile, use Martini with max error ε = 0.5 × (metres per pixel at that tile's distance). Near tiles get dense meshes and far ones sparse. Cracks are handled by skirts (Martini supports them; deck.gl does too).
   - Geomorphing is only needed in orbit/fly views. There, CDLOD-style morphing in the vertex shader on fixed grids is simpler than Martini and gives no popping.
   - Morph factor: `morph = clamp((dist − start)/(end − start), 0, 1)`, morphing the odd vertices to the even-vertex midpoint.
3. **Readback:** do all GPU→CPU work (range buffer for labels, haze fitting, colour statistics) through one async PBO path. Reduce first:
   - Build a 256² or 512² float range and luminance target on the GPU (or a mip chain for means), then read with `readRenderTargetPixelsAsync`.
   - Do not read full-resolution RGBA32F synchronously; that costs 30–100 ms stalls on iPhone.
4. **WebGPU:** do not migrate now. The app's value is in GLSL shaders shared between the three.js and deck.gl paths.
   - Revisit when deck.gl's WebGPU backend is GA.
   - In the meantime, write *new* heavy compute (horizon/SVF maps, guided filter) as **fragment passes in WebGL2**, or in a worker with TypedArrays. A WebGPU compute kernel behind `navigator.gpu` feature detection is optional for horizon maps, with a CPU fallback.
5. **Budget targets** (iPhone 15-class Safari):
   - Photo-view render at 1× DPR plus overlays in under 16 ms.
   - Composite passes (guided filter at s=4, Laplacian blend, tone-map) under 8 ms.
   - Heavy per-photo analysis (haze fit, stats) is one-shot and async.

### (c) Cost
- Reversed-Z: 2–4 hours plus testing.
- Async readback unification: half a day.
- SSE-driven Martini tiles: 1–2 days.
- CDLOD morphing: 2 days, and optional.

---

## 8. Reference products and their visual language

| Product | Visual language worth borrowing |
|---|---|
| **PeakFinder** (https://www.peakfinder.com) | Crisp black/white line-drawing panorama; silhouette lines only; rotated labels with vertical leaders; overlay is thin lines over the camera image, so it never hides the photo. |
| **PeakVisor** (https://peakvisor.com) | Shaded 3D terrain with seasonal and time-of-day lighting; semi-transparent terrain overlay for alignment; clean white labels with stacked name and elevation; zoom-dependent label density. |
| **FATMAP** (retired 1 Oct 2024, folded into Strava; https://techcrunch.com/2024/06/26/strava-to-shutter-3d-mapping-platform-fatmap-18-months-after-acquisition) | Best-in-class 3D satellite plus slope-angle overlays (avalanche colour classes 30/35/40/45°); soft AO; muted, desaturated satellite with bright route lines. **Slope-angle shading is a cheap, high-value overlay for ski-touring users.** |
| **Google Earth / Photorealistic 3D Tiles** (https://developers.google.com/maps/documentation/tile/3d-tiles) | Baked lighting in the textures (so re-lighting looks wrong); strong Rayleigh atmosphere at altitude; soft fog at the horizon. |
| **Apple Maps 3D / Flyover** | Painterly, low-saturation terrain; soft ambient lighting with little hard shadow; elegant SF Pro labels with thin halos; terrain colour by land cover rather than elevation. |
| **swisstopo 3D (map.geo.admin.ch 3D, Cesium-based)** | Swiss relief shading draped as imagery; Frutiger labels; restrained palette; swissALTI3D multidirectional hillshade (https://opendata.swiss/en/dataset/swissalti3d-reliefschattierung-multidirektional). |
| **Cesium** (https://cesium.com) | Globe atmosphere (Hillaire-inspired sky atmosphere in recent versions), dynamic lighting, 3D Tiles streaming. Photorealistic tiles do not re-light well. |
| **Mapbox Standard** (https://docs.mapbox.com/map-styles/standard/guides/; https://www.mapbox.com/blog/standard-core-style) | `lightPreset` (dawn, day, dusk, night) with directional plus ambient light; fog with `horizon-blend` and vertical fog; a strict desaturated base with saturated accents. **Light presets are a UI pattern worth copying for "Photo light / Golden / Map" modes.** |
| **Eduard** (https://eduard.earth) | The target look for "Relief" mode: Swiss manual shading from a network. |
| **@takram/three-geospatial** (https://github.com/takram-design-engineering/three-geospatial) | The state of the art for open three.js atmosphere, clouds and aerial perspective in a GIS context. |

**Research on photo plus terrain AR in mountains:**
- Baboud et al., CVPR 2011, photo-to-terrain alignment (https://dl.acm.org/doi/10.1109/CVPR.2011.5995727).
- Porzi/Fedorov et al., smartphone image-to-DEM alignment (https://link.springer.com/article/10.1007/s00138-016-0808-0).
- **LandscapeAR** (ECCV 2020), learned cross-domain photo↔DEM-render descriptors (https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123740290.pdf).
- The 2025 survey "Towards Precise Geo-Localization for Outdoor Mobile AR".

Recent (2024–26) work is concentrated on *localisation*, not on rendering aesthetics. I found no published system that fits haze to rendered depth for compositing, which makes the section 1 haze fit a genuine differentiator.

---

## Prioritised top-10 rendering and aesthetic upgrades

Ranked by visual impact per day of effort for this app.

1. **Photo-fitted aerial perspective** (§1 b3). Take airlight A from the photo sky above the skyline, and fit chromatic β_c and black level from the dark channel against rendered range. Apply both to every render mode. About 1 day. It fixes the biggest "pasted-on" cue.
2. **Height-integrated chromatic haze plus sun phase** replacing the grey `haze()` (§1 b1–2). About 2 hours. Distant ridges go correctly blue and grey, with forward-scatter glow toward the sun.
3. **EXIF/SunCalc sun plus horizon-map cast shadows plus clear-sky sun colour** (§2). About 2 days. Relief, satellite and drape renders then match the photo's actual light, and shadows alone make renders read as the same scene.
4. **Guided-filter mask refinement and edge-aware transitions** for the sky mask, brush and distance cut (§5 b1, b3). About 1 day. Ridge and treeline edges stop looking cut out.
5. **Distance-binned Reinhard/OKLab colour harmonisation plus grain and sharpness matching** of render to photo (§5 b2, b4). About 1 day.
6. **Screen-space ink lines**: silhouettes from ∇log(range) with depth-varying width and haze-faded opacity, plus crease lines (§3). About 1 day. This gives the PeakFinder/Berann look and a strong new overlay style.
7. **Prominence-scored, skyline-banded, hysteretic peak labels** with a condensed humanist font, adaptive halos and PCF-tolerant occlusion (§4). 1–2 days.
8. **Swiss-style relief**: multidirectional, generalised normals, elevation-dependent contrast and SVF, with Patterson cross-blended or Alpine absolute-elevation tints via an OKLab 1D LUT, and Tanaka contours (§2–3). About 1.5 days.
9. **Drape quality pass**: slope-scaled bias plus PCF on the range test, stretch- and resolution-based fade to a colour-matched base, seam distance-field feathering, and correct mip and anisotropy on the photo (§6). About 1.5 days.
10. **Output pipeline hygiene**: HalfFloat linear render → AgX (render modes) or PBR Neutral (map modes) → IGN dither, plus **reversed-Z** replacing the log depth buffer and a unified async PBO readback (§5 b5, §7). About 1 day. It removes banding in skies and haze, restores early-Z, and makes range queries cheap.

Honourable mentions:
- FATMAP-style slope-angle overlay (30/35/40/45°): 2 hours, and high user value.
- Berann bend for the orbit view.
- A precomputed Eduard-style relief tile pyramid for the Alps.
