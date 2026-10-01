# Photo ↔ Terrain Visual Fusion: Frontier Techniques (2023–2026)

Scope: techniques that make a registered mountain photo plus DEM-derived layers look bespoke rather than like a "GIS overlay on a photo". The app already knows the camera pose, per-pixel metric depth from the DEM, and a sky mask. That makes most "monocular" research pipelines easier: the hardest step in most of these papers (estimating geometry from one image) is already solved for us at terrain scale.

This builds on `research_notes/rendering_aesthetics_sota.md`. That note already covers:
- aerial perspective (AP) fit,
- the guided-filter mask,
- distance-binned Reinhard harmonisation,
- Laplacian blend, grain, dither and tone mapping,
- prominence-scored greedy label layout with skyline band, hysteresis and adaptive halo.

None of that is repeated here except where something goes beyond it.

**Licence legend:**
- **[COMMERCIAL-OK]** = permissive for a product.
- **[NC]** = non-commercial or research-only weights or code. Not usable in a shipped product without a separate licence.
- **[?]** = not verified.

---

## 1. Depth-aware photo effects using known geometry (parallax/Ken Burns, DoF, relighting/time-of-day, sky replacement, aerial-perspective-consistent overlays, terrain shadows on overlays)

### Takeaway
- **Cheap, high-payoff and fully in the browser, with no ML:**
  - 2.5D parallax "Ken Burns" moves,
  - depth-of-field,
  - AP-consistent overlays,
  - terrain-cast shadows on overlays.

  Our DEM depth is metric and occlusion-correct, unlike the monocular depth these papers must estimate. The only learned piece we would need is disocclusion fill near the foreground.
- **True relighting / time-of-day change is server-only and licence-fraught:**
  - The strongest single-image *outdoor* method (Careaga & Aksoy SIGGRAPH 2025) and its intrinsic-decomposition backbone are academic-only.
  - IC-Light code is Apache-2.0 but SD1.5-based and object-centric.
  - NVIDIA's Cosmos DiffusionRenderer has commercially usable weights but needs 16–48 GB GPUs.
- The pragmatic product path is **DEM-shading-ratio relighting**: multiply the photo by (new DEM shading ÷ fitted old DEM shading). This is a physically grounded "intrinsic-lite" trick that runs in a shader.

### Cited Findings

**Parallax / 3D Ken Burns**
- **3D Ken Burns Effect from a Single Image** (Niklaus et al., 2019) is the canonical pipeline:
  - depth prediction,
  - map the image to a point cloud,
  - render from the moving camera,
  - context-aware colour *and* depth inpainting to fill disocclusions "in the extreme views of the camera path".

  Supports automatic and interactive camera paths. — [arXiv 1909.05483](https://arxiv.org/abs/1909.05483v1)
- **Apple iOS 26 "Spatial Scenes"** is the production reference for consumer depth-parallax:
  - Separates foreground from background, builds a depth map, splits the frame into several layers, and parallaxes them with device motion.
  - Runs on the Neural Engine, on iPhone 12 and newer, with no Apple Intelligence requirement.

  — [9to5Mac](https://9to5mac.com/2025/06/10/psa-spatial-scenes-will-work-on-any-iphone-running-ios-26/); [stereoscopy.blog](https://stereoscopy.blog/2025/09/21/new-ios-26-ushers-in-spatial-scene-convert-any-photo-to-a-dynamic-3-d-scene/)
- **Apple SHARP** (Dec 2025):
  - Regresses a metric 3D Gaussian scene from a single photo in one feed-forward pass, in under 1 s on a standard GPU.
  - Outputs a `.ply` usable by standard 3DGS renderers.
  - Reduces LPIPS by 25–34 % and DISTS by 21–43 % vs prior best, and is ~1000× faster.

  — [GitHub apple/ml-sharp](https://github.com/apple/ml-sharp); [Auganix](https://www.auganix.org/?p=17974)

  **[NC]** The weights licence says "Research Purposes does not include any commercial exploitation, product development or use in any commercial product or service." — [LICENSE_MODEL](https://raw.githubusercontent.com/apple/ml-sharp/main/LICENSE_MODEL)

**Depth-of-field**
- **BokehMe** (CVPR 2022) is a hybrid of a classical scattering-based renderer and a neural renderer:
  - Inputs: a single image and an "imperfect" disparity map.
  - Controls: blur size, focal plane and aperture shape.
  - The neural part fixes only the classical renderer's error regions at depth discontinuities, via a computed error map.

  — [arXiv 2206.12614](https://arxiv.org/pdf/2206.12614)

**Relighting and intrinsic decomposition**
- **Careaga & Aksoy, "Physically Controllable Relighting of Photographs"** (SIGGRAPH 2025):
  - Pipeline: monocular geometry + intrinsic components → coloured mesh → user places lights in 3D → **path tracer** renders new lighting → feed-forward neural renderer makes it photoreal.
  - Supports "in-the-wild" images and extreme day↔night changes.

  — [arXiv 2508.05626](https://arxiv.org/abs/2508.05626)

  Paper is CC BY-NC-SA; no code link found.
- **Careaga & Aksoy intrinsic decomposition:**
  - Ordinal Shading (2023).
  - Colorful Diffuse Intrinsic (2024): albedo, colourful diffuse shading and a specular/non-diffuse residual.

  — [arXiv 2409.13690](https://arxiv.org/abs/2409.13690v1); [arXiv 2311.12792](https://arxiv.org/abs/2311.12792v1)

  **[NC]** Repo says "provided for academic use only"; commercial use goes through the SFU licensing office. — [compphoto/Intrinsic](https://github.com/compphoto/Intrinsic)
- **IC-Light** (lllyasviel), "Imposing Consistent Light":
  - Built on SD1.5. Variants: text+foreground (`fc`), offset-noise (`fcon`), foreground+background (`fbc`).
  - Code is Apache-2.0, but the bundled background remover BRIA RMBG 1.4 is non-commercial (swap in BiRefNet).
  - Relightings are consistent enough to "be merged as normal maps".

  — [GitHub IC-Light](https://github.com/lllyasviel/IC-Light)
- **LumiNet** (CVPR 2025):
  - Transfers lighting from a target image to a source image.
  - Uses latent intrinsics from the source and latent extrinsics from the target via a modified ControlNet + MLP adaptor.
  - Explicitly an *indoor*-scene method.

  — [arXiv 2412.00177](https://arxiv.org/abs/2412.00177v3); [CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/html/Xing_LumiNet_Latent_Intrinsics_Meets_Diffusion_Models_for_Indoor_Scene_Relighting_CVPR_2025_paper.html)
- **NVIDIA DiffusionRenderer** (CVPR 2025 Oral):
  - Video-diffusion inverse rendering (G-buffers) plus forward rendering (G-buffer + lighting → image).
  - Enables relighting, material edits and object insertion.
  - Original release is under the NVIDIA Source Code License. — [NVIDIA](https://research.nvidia.com/labs/toronto-ai/publication/2025_cvpr_diffusionrenderer); [GitHub](https://github.com/nv-tlabs/diffusion-renderer)
  - **Cosmos-Transfer1-DiffusionRenderer:**
    - Apache-2.0 code; weights under the **NVIDIA Open Model License**.
    - Supports HDRI env-map relighting.
    - Needs 16 GB VRAM minimum, 48 GB+ recommended.

    — [GitHub](https://github.com/nv-tlabs/cosmos-transfer1-diffusion-renderer)
  - **[COMMERCIAL-OK]** NVIDIA Open Model License: models "are commercially usable"; royalty-free, with an AUP and litigation-termination clause. — [NVIDIA Open Model Agreement](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-agreement/)
- **Google LightLab** (SIGGRAPH 2025):
  - Diffusion fine-tuned on real raw on/off photo pairs plus synthetic renders.
  - Gives parametric control of the intensity and colour of *visible light sources* and of ambient light.

  — [arXiv 2505.09608](https://arxiv.org/pdf/2505.09608)

  No weights found. Targets lamps, not sun position.
- **Older outdoor single-image relighting:**
  - OutCast (2022): predicts cast shadows for novel sun directions from one image. — [arXiv 2204.09341](https://arxiv.org/pdf/2204.09341)
  - Self-supervised outdoor relighting (2021). — [arXiv 2107.03106](https://arxiv.org/pdf/2107.03106)
  - Shih et al.'s time-lapse-database time-of-day hallucination. — [MIT](https://people.csail.mit.edu/yichangshih/time_lapse/time_lapse.pdf)
- **Newer relighting papers from search (not deep-read):**
  - RelightVid (video, Jan 2025). — [arXiv 2501.16330](https://arxiv.org/pdf/2501.16330)
  - SyncLight (multi-view, 2026). — [arXiv 2601.16981](https://arxiv.org/pdf/2601.16981)
  - Consistent Feature Transport for relighting (2026). — [arXiv 2607.17833](https://arxiv.org/pdf/2607.17833)
  - GaRe and LumiGauss: outdoor relightable 3DGS from photo collections, using sun/sky/indirect decomposition. — [arXiv 2507.20512](https://arxiv.org/pdf/2507.20512); [arXiv 2408.04474](https://arxiv.org/pdf/2408.04474)

**Sky replacement**
- **"Clear Skies Ahead"** (Halperin et al., CGF 2019): automatic sky replacement in video at near-real-time on mobile. — [Eurographics DL](https://diglib.eg.org/items/413ed610-0f7e-4aba-b50c-74f0169e3d19/full)
- Commercial sky-replacement tools now relight the foreground to match the new sky: ambient colour temperature, shadow direction and surface brightness. — [Autoenhance docs](https://docs.autoenhance.ai/images/basic-enhancements/sky-replacement); [Skylum Sky AI](https://support.skylum.com/editing-tools/landscape-tools/sky-ai?c_url=3)

### Inferences

**Ken Burns / parallax with the DEM**
- Build a displaced grid mesh at about 1/4 resolution from the DEM depth, and texture it with the photo (projective texturing, which is already in the stack). Animate the camera along a short dolly-plus-orbit path.
- DEM depth has no near-field objects (people, trees, huts). So:
  - **Clamp parallax magnitude** so the nearest DEM range moves at most ~2–3 % of image width. Mountain scenes are far-field dominated, which is why they parallax beautifully with small baselines.
  - **Fill disocclusions with the sky mask plus a cheap fill.** Behind ridges the disoccluded region is usually sky or more-distant terrain. Fill it by stretching the background layer (layered depth, as in Spatial Scenes) or with a small inpainter (LaMa-class, licence [?]) on the server.
  - The repo's Step Inside near-field splats can supply the foreground layer.
- SHARP is the ideal near-field generator but is **[NC]**, so it must not ship.

**Depth-of-field**
- Use a classical scatter or gather bokeh driven by DEM range, e.g. a CoC from a thin-lens model with focus at a chosen peak. A tilt-shift "miniature" look (very shallow DoF on a distant summit) is a striking stylistic option.
- DEM depth edges are exact at the skyline but wrong for foreground objects. Use BokehMe's idea: apply the classical result except where the sky mask or the Step-Inside foreground mask indicates a discontinuity, and soften there.

**Relighting without diffusion: the shading-ratio method**
1. Fit the photo's actual sun azimuth/elevation and ambient ratio by regressing photo luminance against DEM Lambert shading per land-cover band.
2. Render the DEM hillshade + shadow-map for the *target* sun.
3. Multiply: `photo' = photo × clamp((ka + kd·S_new)/(ka + kd·S_old), 0.3, 3)`, then blur the ratio with a guided filter guided by the photo.
4. Add colour temperature from a sky model (Hosek/Prague) for the new sun.

This is the terrain-scale analogue of Careaga's "mesh + path-trace + neural cleanup" pipeline, minus the neural stage. It is WebGL-feasible and **[COMMERCIAL-OK]**. Expected failure points: cloud shadows baked into the photo, snow albedo, and DEM resolution vs photo detail.

**Relighting with diffusion (server)**
- **Best licence-clean option:** Cosmos DiffusionRenderer, fed our *own* G-buffers. Normals and depth come from the DEM; albedo could come from orthophoto or albedo estimation. This is a heavy GPU job, more for "golden-hour hero renders" than interactive use.
- **IC-Light fbc:**
  - Can be used with an SD1.5 base. SD1.5's CreativeML OpenRAIL-M permits commercial use with use restrictions — not verified in this session; check.
  - Object-centric, so landscape behaviour is unproven.

**Sky replacement**
- Trivially seam-free for us: we have the sky mask and know the sun position.
- Render a physically based sky (Hillaire / Bruneton) for the photo's timestamp or a new time, and composite with the guided-filter mask.
- Then **re-fit the AP colour** of the distant terrain to the new sky's horizon colour so distant ridges "belong" to the new sky. This is what commercial tools approximate heuristically.

**Terrain shadows on overlays**
- Render a sun shadow map from the DEM. Darken *overlay* layers (contours, trails, labels' leader lines, glow) where they fall in terrain shadow, with soft PCF.
- This is the single cheapest cue that makes vector overlays look like they are "in" the photo and not on glass.
- Combine with AP on overlays: `overlay_rgb = mix(overlay_rgb, A_fitted, 1 − exp(−β r))`.

### Gaps
- No open-weight, commercially licensed, *outdoor/sun-position* single-image relighting model was found. The 2026 relighting papers surfaced (SyncLight, Consistent Feature Transport, Relit-LiVE) were not deep-read, and their weights and licences are unverified.
- IC-Light v2 (Flux-based) availability and licence were not verified.
- BokehMe code/weights licence not verified.
- No published evaluation was found of shading-ratio relighting against DEM shading for alpine photos. It is an inference and needs a prototype.

---

## 2. Overlay blending styles (blend modes, luminance-preserving tints, ink ridgelines, draped contours with occlusion, glow, x-ray, hologram/blueprint, wireframe↔photo morphs, depth-sliced bands)

### Takeaway
Nearly all of these are shader recipes over buffers we already have (photo, DEM range, normals, sky mask). The literature value is in **line-extraction theory** (where ink lines go) and **edge-aware abstraction filters**. The distinctive looks come from:
- computing lines from DEM geometry, not photo edges,
- modulating them by photo luminance and AP,
- occluding them with the range buffer.

### Cited Findings

**Where lines go**
- **"Line drawings via abstracted shading"** (Lee, Markosian, Lee & Hughes, SIGGRAPH 2007):
  - Treats line drawing as an abstraction of a shaded image: lines go on tone boundaries or thin dark areas.
  - Yields silhouettes, creases, ridges and a light-dependent generalisation of suggestive contours.
  - Real time, with no mesh-curvature computation.

  — [SIGGRAPH history](https://history.siggraph.org/?p=115327)
- **Apparent ridges** (Judd, Durand & Adelson, SIGGRAPH 2007): maxima of view-dependent normal variation in screen space. A principled "which ridges would an artist ink" definition. — [MIT PDF](https://people.csail.mit.edu/tjudd/apparentLines.pdf)

**Painterly abstraction filters**
- **Anisotropic Kuwahara filtering** (Kyprianidis, Kang & Döllner, CGF 2009):
  - Edge-preserving, painterly flattening along feature directions, driven by the smoothed structure tensor.
  - Real-time GPU on video.
  - The 2010 polynomial-weighting version avoids convolution and is faster.

  — [EG DL 2009](https://diglib.eg.org/handle/10.2312/CGF.v28i7pp1955-1963); [EG DL 2010](https://diglib.eg.org/items/9865e5fe-3d23-470e-8cf6-e571bebafb9b)
- **Flow-based / coherent line drawing** (Kang et al.) is the companion technique for ink edges from photos. — [Kang CGF09](https://umsl.edu/~kangh/Papers/kang_cgf09.pdf)

**Production reference**
- PeakFinder's *default* UI is a black-and-white line drawing of the landscape, with a camera button switching to AR. PeakVisor defaults to AR with a draggable peak outline for manual alignment. — [livingin.swiss review](https://livingin.swiss/mountain-peak-finders-apps-review/); [PeakVisor tutorial](https://peakvisor.com/tutorial_en.html)

### Inferences (recipes, all WebGL2/WebGPU-feasible)

**Ink ridgelines and silhouettes**
- Compute from the DEM render, not the photo:
  - **depth-discontinuity silhouettes** (range jump > k·r) give every occluding ridge, layered by distance;
  - **apparent-ridge / crease lines** come from normal variation.
- Weight line width and opacity by **distance-in-transmittance**: `w = w0·exp(−β r)^γ`. Far ridges become thin and pale, Berann/Imfeld-style.
- Snap lines to photo edges within ±2 px using the photo's gradient (a mini "active contour") so ink sits *exactly* on the real ridge. This hides residual pose error, which is a big perceived-quality win.

**Glowing ridgelines**
- Same line mask, bloomed (dual-Kawase blur) and added in linear light.
- Colour from the fitted sky horizon colour, or warm at golden hour.
- Gate by the sky mask so the glow only spills into sky, never onto foreground rock.

**Luminance-preserving tint**
- Use OKLab: keep the photo's L, replace a and b with a mix toward the overlay hue weighted by mask: `ab' = mix(ab_photo, ab_tint, α·(1 − L^2))`.
- This "colour" blend (Photoshop Color mode) keeps texture and is the right default for land-cover, slope-angle and avalanche tints. Multiply darkens; Overlay/Soft-light boosts contrast. Expose all three as presets.

**Draped contours with occlusion**
- Generate contours per-pixel from the DEM elevation at each photo pixel: `fract(h/Δ)` with screen-space derivative AA, i.e. `fwidth`-based isolines.
- Occlusion comes for free, because each photo pixel's elevation comes from the range buffer of the visible surface.
- Fade with AP. Use an index contour every 5th at 1.6× width.
- Because they are computed on the visible surface, contours behave correctly at ridges with no geometry pass.

**X-ray / see-through terrain**
- Render hidden objects (trails behind ridges, the far side of a valley, peaks behind a nearer ridge) using a second range pass with depth-test inverted, or by comparing the object range against the range buffer.
- Draw hidden parts dashed or at 30 % opacity with a "hologram" tint and fresnel-like edge.

**Hologram / blueprint looks**
- Desaturate the photo to L, posterise, tint cyan or blue.
- Add scanlines aligned to *elevation*, i.e. contours, rather than screen rows. This keeps the look geographic.
- Add a wireframe of the DEM mesh with depth-fade, plus additive glow.
- Blueprint = inverted-L photo on Prussian blue + white contour/ridge ink.

**Wireframe → photo morph**
- Animate a threshold over *range*: `t(r) = smoothstep(r0 − w, r0, r)`.
- Pixels nearer than the sweep show the photo, farther ones show the wireframe/ink, and the sweep moves outward over 1–1.5 s.
- Range-ordered reveals read as "the world resolving", far more bespoke than a global crossfade. The repo's reveal-animation presets could add this mode.

**Depth-sliced bands**
- Quantise transmittance into 4–6 bands. Tint each band with a progressively lighter, bluer flat colour multiplied over the photo.
- This is the classic "layered ridges" poster look (Japanese woodblock / Imfeld). It is the most "designed" look per line of code.

### Gaps
- No 2023–2026 paper specifically on stylised overlays *over registered photos of terrain* was found. These recipes are synthesised from NPR fundamentals and product conventions.
- No Shadertoy or GitHub reference implementations were verified in this session for contour-from-DEM-on-photo or range-ordered reveal.

---

## 3. Label & annotation design over photos (placement/declutter/leader lines, Berann-style, legibility on busy imagery, typography used by PeakFinder/PeakVisor/PeakLens/Apple, distance/elevation encodings)

### Takeaway
- **Placement research:**
  - RL-Label (TVCG 2024) adds learned dynamic placement.
  - A 2025 clutter study shows that **grouping** labels for dense clusters measurably speeds tasks.

  For peaks, the greedy skyline-band algorithm in the earlier note remains the practical choice. The new ideas worth adding are **grouping sub-summits** and **saliency-aware placement** (SmartOverlays) so labels avoid visually busy photo regions.
- **Legibility:** AR legibility studies consistently favour **billboard (backing panel) or outline styles** and light text on dark backgrounds.
- Vendor typography specifics are not documented publicly.

### Cited Findings

**Placement and decluttering**
- **RL-LABEL** (TVCG 2024, vol. 30 no. 1): deep RL for AR label placement in dynamic scenes, optimising occlusion-free placement and legible leader lines with multiple labels. — [Harvard VCG](https://vcg.seas.harvard.edu/publications/20231021-rl-label)
- **"Exploring AR Label Placements in Visually Cluttered Scenarios"** (Park et al., arXiv June 2025):
  - "Situated Grouped" labels (one representative label per cluster) beat one-label-per-item on completion time: 14.0 ± 1.5 s vs 16.5 ± 2.6 s, p < 0.05, with equal ~91–92 % accuracy.
  - 8/15 participants preferred force-directed "Centered Grouped".
  - The authors note the leader-line length vs clutter trade-off remains unresolved.

  — [arXiv 2507.00198](https://arxiv.org/html/2507.00198v1)
- **Other placement approaches:**
  - SmartOverlays (WACV 2020): visual-saliency-driven label placement that avoids salient image regions. — [CVF](https://openaccess.thecvf.com/content_WACV_2020/papers/Hegde_SmartOverlays_A_Visual_Saliency_Driven_Label_Placement_for_Intelligent_Human-Computer_WACV_2020_paper.pdf)
  - Context-responsive AR labelling. — [arXiv 2102.07735](https://arxiv.org/pdf/2102.07735)
  - Concentric label layout avoiding leader crossings (Popescu, ISMAR/TVCG 2021). — [Purdue](https://www.cs.purdue.edu/cgvlab/papers/popescu/2021ISMARTVCGConcentricLabelsPopescu.pdf)

**Legibility**
- Gabbard et al. and Fiorentino et al. found that **white text in billboard style** (a rectangular block behind the text) works well across conditions, and a **thin outline** improves contrast. Billboard/outline styles and light-on-dark are most reliable. — [JGED review](https://sp.ftn.uns.ac.rs/index.php/jged/article/view/2719); [Google Fonts: type in AR/VR](https://fonts.google.com/knowledge/using_type_in_ar_and_vr/introducing_ar_vr)

**Products**
- PeakLens (Politecnico di Milano, Fraternali):
  - Extracts the mountain profile with a neural network and matches it to the DEM.
  - Shows name, altitude and distance per visible peak.
  - 800k+ downloads.

  — [DEIB news](https://www.deib.polimi.it/eng/news/details/982)
- PeakVisor lets users drag the peak outline to align labels when silhouettes don't match. — [PeakVisor tutorial](https://peakvisor.com/tutorial_en.html)

### Inferences
- **Group sub-summits.** Within a cluster (e.g. the 4 summits of the Monte Rosa massif), show the highest summit's label plus a "+3" chip or bracketed sub-label, expanding on hover or zoom. This applies the 2025 grouping result directly.
- **Saliency-aware vertical offset.** Compute a cheap saliency/edge-density map of the sky band (photo gradient energy in the sky mask, which captures clouds and contrails) and penalise label positions there. Combined with the skyline band this is SmartOverlays-lite.
- **Backdrop blur halo.** Beyond the luminance-inverted halo:
  - Sample the photo under the label box, blur it (13–21 px), darken or lighten 15–25 %, and draw it as a rounded "frosted" pill. This is the iOS-material look that reads as premium.
  - It satisfies the billboard-style legibility finding without an opaque box.
  - Gate it to labels whose local contrast is below a threshold (measured WCAG-like on the sampled backdrop).
- **Berann-style labels:**
  - Upright serif or humanist small caps for major peaks, italic for glaciers and passes, with leader lines that are hairline and AP-tinted.
  - Encode distance by **type size + AP-tinted colour** rather than numbers. Show numbers (elevation, distance) only on focus.
- **Distance encoding options:**
  - Leader-line length ∝ log distance (gives a perspective "ladder").
  - A tiny distance tick-ruler along the skyline band.
  - Colour along the AP gradient.

  Elevation goes in tabular numerals. Distance goes in km with one decimal under 10 km.
- **Leader occlusion.** Leaders should be drawn *behind* nearer terrain: dash or fade the segment that crosses a nearer ridge, using the range buffer. This is a small, distinctive "it knows the geometry" cue.

### Gaps
- No public documentation was found of the exact typefaces used by PeakFinder, PeakVisor, PeakLens or Apple Maps peak labels. Any claim (e.g. Apple's SF Pro) is unverified and would need app teardown or screenshots.
- No study was found specifically on peak-label legibility over mountain photos.

---

## 4. NPR stylisation of the photo and generative/diffusion approaches (real-time style transfer, watercolor/ink, edge-aware filters, colour harmonisation, ControlNet-depth Berann repaint, seasonal variants; latency/licensing)

### Takeaway
- **Browser-feasible now:**
  - classical edge-aware NPR (anisotropic Kuwahara, XDoG/flow ink, watercolor edge darkening + paper),
  - light learned harmonisation (PCT-Net-style pixel-wise affine colour transforms predicted at low resolution),
  - fast feed-forward style transfer (Magenta arbitrary-style, ~9.6 MB MobileNet distillation, runs in TF.js).
- **Diffusion-based "Berann repaint" and seasonal variants are server-only.** The licence picture:
  - **FLUX.1-dev and its ControlNets are [NC]**;
  - FLUX.1-schnell is Apache-2.0;
  - cartographic-style ControlNets exist (swisstopo / Siegfried) but with unknown licence.

  Conditioning on our DEM depth + ridgeline ink is the right control signal, because it is far better than estimated depth.

### Cited Findings

**Classical NPR**
- Anisotropic Kuwahara is real-time on GPU video and creates painterly flattening while preserving shape boundaries (see §2). — [EG DL](https://diglib.eg.org/handle/10.2312/CGF.v28i7pp1955-1963)

**Fast style transfer**
- Magenta arbitrary style transfer in the browser (TF.js):
  - A style network maps any style image to a 100-D vector consumed by a transformer network.
  - Distilling Inception-v3 to MobileNet-v2 cut the model from ~36.3 MB to ~9.6 MB.

  — [Magenta blog](https://magenta.tensorflow.org/blog/2018/12/20/style-transfer-js/)
- ONNX fast-neural-style (Johnson perceptual-loss, instance norm) models exist, e.g. "mosaic". — [OpenVINO docs](https://docs.openvino.ai/2024/omz_models_model_fast_neural_style_mosaic_onnx.html)

**Learned harmonisation**
- **PCT-Net** (CVPR 2023): a parameter network on a downsampled image predicts per-pixel affine colour transforms applied at full resolution. >20 % fMSE/MSE reduction and +1.4 dB PSNR while staying lightweight. — [CVF](https://openaccess.thecvf.com/content/CVPR2023/html/Guerreiro_PCT-Net_Full_Resolution_Image_Harmonization_Using_Pixel-Wise_Color_Transformations_CVPR_2023_paper.html)
- **Harmonizer**: white-box, resolution-independent filters. — [arXiv 2207.01322](https://arxiv.org/pdf/2207.01322)
- **Lightweight optimal-transport harmonisation on edge devices** (Nov 2025). — [arXiv 2511.12785](https://arxiv.org/html/2511.12785v1)

**Generative cartography**
- **"Generative AI in Map-Making"** (arXiv 2508.18959): ControlNets conditioned on colour-coded vector data (20+ feature classes) generate map tiles in swisstopo, Old National and Siegfried styles. — [arXiv](https://arxiv.org/pdf/2508.18959); [HF Cartographic-ControlNet](https://huggingface.co/claudaff/Cartographic-ControlNet/blob/main/README.md)

  **[?]** HF lists licence "unknown".
- **FLUX.1-dev-ControlNet-Depth** (InstantX/Shakker): Flux.1-dev Non-Commercial License **[NC]**; recommended conditioning scale 0.3–0.7. FLUX.1-schnell weights are Apache-2.0 **[COMMERCIAL-OK]**. — [PromptLayer model page](https://www.promptlayer.com/models/flux1-dev-controlnet-depth); [FLUX licence guide](https://www.promptzone.com/zuzanna_choi/flux-ai-license-key-insights-2g8d.md)

  Secondary sources; verify against BFL's own licence text.

**Berann-style rendering lineage**
- Real-time Berann-style panorama rendering (Brown et al., Expressive 2017) analysed Berann's paintings and implemented:
  - terrain deformation,
  - distorted projection,
  - terrain colouring,
  - tree brush strokes,
  - water,
  - atmospheric scattering.

  — [UCalgary GIV](https://giv.cpsc.ucalgary.ca/publication/c62/)
- Jenny's texture synthesis for panoramic maps transferred the appearance of Berann's Jungfrau panorama to other regions. — [Jenny 2013 PDF](https://mail.colororacle.org/berniejenny/pdf/2013_Jenny_TextureSynthesisForPanoramicMaps.pdf)
- Plan oblique relief. — [Cartographic Perspectives](https://cartographicperspectives.org/index.php/journal/article/view/cp57-jenny-patterson)

### Inferences

**Unify the photo with rendered layers via a shared "look" stage**
- Run a mild anisotropic Kuwahara (radius 4–6) plus flow-ink on *both* the photo and the render, with the same parameters. Shared abstraction erases the "two different media" seam more effectively than colour statistics alone.
- Weight abstraction strength by range: more abstract far away, crisp foreground. This mimics how painters treat distance.

**Watercolor**
- Kuwahara + edge darkening (gradient of a blurred alpha) + paper-texture modulation + pigment granulation noise multiplied by (1 − L), plus wobble displacement from low-frequency noise.
- About 6–8 passes; fine in WebGL2.

**Berann repaint (server)**
- Condition a diffusion model on:
  - DEM depth (exact, metric),
  - our ink ridgelines (canny-like control),
  - optionally the photo at low strength (img2img 0.3–0.5).
- Licence-clean stack: SD1.5/SDXL ControlNet-depth (OpenRAIL-family, [?] verify use-restriction terms) or FLUX.1-schnell with a commercially licensed depth control. Avoid FLUX.1-dev-based ControlNets.
- A Berann style LoRA would need training data. Berann's works are under copyright (he died in 1999), so a LoRA trained on scans has IP risk. Prefer public-domain 19th/early-20th-century Swiss panoramas (e.g. Imfeld-era) or commissioned art.

**Seasonal variants**
- Same conditioning, with the prompt "winter, snow-covered" plus a snowline from DEM elevation × aspect as a mask, so diffusion only edits where snow is physically plausible.
- A non-diffusion fallback (snow where `elevation > snowline(aspect)` and slope < 45°, blended in OKLab) is browser-feasible and deterministic.

**Latency**
- Diffusion img2img at ~1 MP is server-GPU seconds per image (typical, not measured here). Treat it as an async "art render" feature, not interactive.
- Classical NPR is real time.

### Gaps
- No verified WebGPU/WebNN benchmark for style-transfer or harmonisation nets at 12 MP in 2026 browsers was found.
- The actual licence text of Cartographic-ControlNet and the current BFL FLUX licence terms were not verified at the primary source.
- No published diffusion "Berann panorama from DEM" model was found. The EarthBender (MIG 2025) sketch-to-terrain ControlNet surfaced but could not be read.

---

## 5. Transitions between photo and 3D (photo ↔ 3D map morph, projective-texturing reveals, Gaussian-splat step-in)

### Takeaway
- The production-grade web stack for step-in exists. **Spark 2.0** (World Labs) is an open-source THREE.js/WebGL2 3DGS renderer that composites splats with meshes, has a shader graph for dynamic effects, and has streaming LoD for 100M+ splats.
- The killer transition for a registered photo is a **projective-texture camera tween**:
  1. Start at the photo's exact pose with the photo projected onto the DEM.
  2. Move the camera.
  3. As the view diverges, cross-fade per-pixel from photo texture to ortho/satellite texture by **view-angle disparity**.
  4. Fill near-field with splats.
- Single-image splat generators (SHARP) are **[NC]**.

### Cited Findings
- **Spark:**
  - Integrates with the THREE.js pipeline to "fuse splat and mesh-based objects".
  - WebGL2 (98 %+ device support).
  - Supports PLY/SPZ/SPLAT/KSPLAT/SOG.
  - Multiple splat objects, real-time editing and relighting, and a shader graph for dynamic splat effects.

  — [GitHub sparkjsdev/spark](https://github.com/sparkjsdev/spark); [sparkjs.dev](https://sparkjs.dev/docs/overview/)
- **Spark 2.0** adds a streamable LoD system and virtual memory for 100M+ splat worlds on browser, mobile and VR. — [World Labs blog](https://worldlabs.ai/blog/spark-2.0)
- SHARP outputs metric 3DGS `.ply` from one photo in under 1 s, but weights are research-only (see §1). — [apple/ml-sharp](https://github.com/apple/ml-sharp)
- The 3D Ken Burns point-cloud + inpainting approach is the reference for small camera moves away from the photo pose (see §1). — [arXiv 1909.05483](https://arxiv.org/abs/1909.05483v1)

### Inferences

**Photo → 3D morph**
- Tween camera FOV and position from the photo pose to an oblique map pose over ~1.2 s with ease-in-out.
- Per fragment, compute the angle between the current view ray and the photo-camera ray to that surface point. Blend weight = `smoothstep(θ1, θ0, angle) × visibleFromPhoto`, where visibility comes from the photo-camera range buffer (shadow-map-style test).
- Photo-texture where valid, orthophoto elsewhere, plus a Laplacian-pyramid blend (earlier note) for the seam.
- This is unstructured-lumigraph-style view-dependent texturing, cheap in a fragment shader.

**Reveal options**
- **Range sweep:** the photo "paints onto" terrain from near to far.
- **Projector cone:** visualise the photo frustum as a faint light cone, and have the photo "beam" onto the terrain, so the user understands the registration.
- **Ink-first:** ink ridgelines appear, then the photo fills in between them.

**Step-in**
- Use Spark for splat rendering alongside deck.gl/three terrain.
- Anchor splats to DEM metric scale; the repo's Step Inside service already does DEM anchoring.
- Use Spark's shader graph for a dissolve: splat opacity ramp by distance from the camera's travel path.

**Licence**
- For a shipped step-in, near-field splat generation must use a commercially licensed model. SHARP is excluded.
- See `research_notes/step_inside_models_2026-09.md` for alternatives (not re-researched here).

### Gaps
- Spark's licence was not verified in this session (believed MIT; confirm in the repo).
- No published papers specifically on photo↔3D-map transition aesthetics (e.g. Google Earth or Apple Maps photo-to-3D transitions) were found. Production teardowns of those transitions were not available.
- No 2025–2026 open, commercially licensed single-image-to-3DGS model was confirmed in this session.
