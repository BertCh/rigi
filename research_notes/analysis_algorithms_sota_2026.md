# Implementing the best photo↔DEM algorithms in the browser (September 2026)

*This complements `reports/Mountain photo georeferencing SoTA.md`. That report covers what the field knows. This one covers how to build it: concrete formulations, parameters and browser engineering for a TypeScript/WebGL2 app. The app already has an EXIF and gravity prior, a CPU horizon ray-march, a Viterbi skyline, grid plus coordinate-descent alignment, and LM on tapped peaks. The target is pose error below 0.1°.*

## 0. What 0.1° means in practice

- **Pixel scale.** At 4032 px and a horizontal FOV of 67–69°, f ≈ 2.95k px. So **1 px ≈ 0.019° and 0.1° ≈ 5 px**. Model error dominates, not detection noise.
- **Noise is negligible.** About 1000 columns at σ = 1 px give a pitch uncertainty of about 1/(f√m) rad ≈ 0.0006°.
- **What consumes the budget:**
  - DEM vertical error seen as an angle, σ_z/d: 10 m at 5 km is 0.11° ([Patat 2011](https://arxiv.org/pdf/1107.1957)).
  - Refraction: Δk = ±0.1 shifts the horizon by about ±0.045° at 100 km and ±0.09° at 200 km.
  - GPS and altitude error on near ridges.
  - Focal length: `FocalLengthIn35mmFilm` is an integer, so 26 vs 26.4 mm is a 1.5% scale error, about 0.5° at the frame edge.
- **Consequence:** f is always free, and every residual needs a per-column error model driven by the distance to that column's skyline point (§2.4).

## 1. Sky segmentation and skyline extraction

### 1.1 Browser models (licences verified)

| Model | Size | Licence | Sky | Notes |
|---|---|---|---|---|
| SegFormer-b0 ADE20k ([nvidia](https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512), [Xenova ONNX](https://huggingface.co/Xenova/segformer-b0-finetuned-ade-512-512/tree/main/onnx)) | 3.75M params; 15.3 MB fp32, 7.9 MB fp16, 4.4 MB q8 | **NVIDIA Source Code Licence, non-commercial** ([LICENSE](https://github.com/NVlabs/SegFormer/blob/master/LICENSE)) | class 2 | For research and evaluation only. The Cityscapes ports have the same licence. |
| MediaPipe segmenters ([docs](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter)) | 0.5–3 MB | CC BY 4.0 | **none** | Person, hair and skin classes only; DeepLabV3 uses VOC labels. |
| `skyseg.onnx` U²-Net ([HF](https://huggingface.co/JianyuanWang/skyseg/tree/main)) | **176 MB** | MIT | yes | Input 320², ImageNet normalisation ([vggt](https://raw.githubusercontent.com/facebookresearch/vggt/main/visual_util.py)). Too big for phones. |
| U²-NetP sky ([xiongzhu666](https://github.com/xiongzhu666/Sky-Segmentation-and-Post-processing)) | ~2 MB (NCNN) | MIT | yes | About 300 ms on a Snapdragon 888. Needs converting to ONNX. |
| YUNet skyline ([arXiv 2502.12449](https://arxiv.org/abs/2502.12449), [code](https://github.com/kuazhangxiaoai/SkylineDet-YOLOv11Seg)) | YOLOv11-seg | **AGPL-3.0** | yes | 1.36 px mean skyline error, the best published. |
| BiSeNetV2 ([CoinCheung](https://github.com/CoinCheung/BiSeNet)), PIDNet-S ([repo](https://github.com/XuJiacong/PIDNet)), DDRNet-23-slim ([repo](https://github.com/ydhongHIT/DDRNet)) | 3–8M params | **MIT** | Cityscapes sky | The best permissive base. Export yourself and fine-tune on GeoPose3K or Skyfinder. |
| TopFormer-T ([hustvl](https://github.com/hustvl/TopFormer)) | 1.4M params | Apache-2.0 | ADE sky | 34.6 mIoU at 512². |
| fast-skyseg ([WEIIEW97](https://github.com/WEIIEW97/fast-skyseg)) | LRASPP-MBv3 and others | "MIT" in README, no LICENSE file | yes | Training recipe with ONNX export. |

**Runtime.**
- Use transformers.js v3 with `{device:'webgpu', dtype:'fp16'}` ([dtypes](https://huggingface.co/docs/transformers.js/en/guides/dtypes)).
- WebGPU is available in Safari 26 on iOS and macOS ([WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)) and in Chrome for Android.
- WebGPU is typically 10–15× faster than WASM ([SitePoint](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/)).
- The only measured SegFormer browser figure is about 1.2 s on WASM fp32 at 1024² ([leaderboard](https://huggingface.co/datasets/whitphx/transformersjs-performance-leaderboard-results/commit/2784e91324e16f08c1ce92bc5d478207f4499b90)). Benchmark on your own devices.

**Recommendation:**
1. Train an MIT binary sky model (BiSeNetV2 or LRASPP-MBv3) at 512×384 and quantise it to fp16, about 5–10 MB.
2. Evaluate on **skyline row error, not IoU**.
3. Feed its soft p_sky into the existing Viterbi DP as the unary term, rather than using it as the final skyline.

### 1.2 DP formulation

**Lie et al. 2005** ([PRL](https://www.sciencedirect.com/science/article/abs/pii/S0167865504002302); restated in [Ahmad et al. 2021](https://arxiv.org/pdf/2107.10997)):
- The graph has one stage per column and one node per edge pixel.
- Node cost: Ψ = l on edge pixels, ∞ elsewhere.
- Link cost: |i−k| if |i−k| ≤ δ, else ∞.
- Recurrence: C(k,j+1) = Ψ(k,j+1) + min_{|i−k|≤δ} [C(i,j) + |i−k|].
- Gaps up to *tog* columns are bridged by high-cost dummy nodes.

**Ahmad and Bebis variants:**
- Node cost: Ψ = w₂·S + (1−w₂)·Gr, where S is a classifier score (SIFT-HOG SVM, or a CNN in DCSI) and Gr = w₁|∇(i,j)−∇(i,j+1)| + (1−w₁)(1−∇(i,j)).
- mDCSI keeps only the top-m candidates per column.
- A 57 KB shallow filter bank stays under 4 px error on about 90% of GeoPose3K.

**Recommended form for this app:**
```
U(y,x) = α·mean_{y-A..y}(1-p_sky) + β·mean_{y..y+B}(p_sky) − γ·max(0,G_y)·polarity
P(y,y') = min(λ|y−y'|, τ)       // λ≈1/px, τ≈20–40 px at 1k width
D(x,y) = U(y,x) + min_{y'}[D(x−1,y') + P(y,y')]
```
- Compute the min over y′ in **O(H)** with a two-pass L1 distance transform (`D[y]=min(D[y],D[y±1]+λ)`), then clip at min(D)+τ.
- Sub-pixel rows: fit a parabola to |G_y|, dy = (c₋−c₊)/(2(c₋−2c₀+c₊)) ([BMVC 2006](https://bmva-archive.org.uk/bmvc/2006/papers/328.pdf)).
- Alternatively, guided-filter p_sky with the grey image as the guide (r ≈ 8 px at 1k, ε ≈ 0.02²; fast version with s = 4; [He et al.](https://ar5iv.labs.arxiv.org/html/1505.00996)) and take the 0.5 crossing.
- **Shen & Wang 2013** is a fallback and cross-check ([paper](https://journals.sagepub.com/doi/full/10.5772/56884), [Unlicense port](https://github.com/cnelson/skydetector)):
  - The border is the first row where the Sobel gradient exceeds t.
  - Choose t ∈ [5, 600] in steps of 5 to maximise J = 1/(γ|Σ_s| + |Σ_g| + γλ₁ˢ + λ₁ᵍ), with γ = 2.
  - Runs in about 150 ms.

## 2. Pose refinement

### 2.1 Pipeline
```
L3 512px : 1-D circular correlation (elevation profile vs 360° horizon) + Baboud VCC → top-K(3–5) modes
L2 1024px: robust GN on per-column skyline rows (yaw,pitch,roll,f) per mode
L1 2048px: + oriented chamfer on inner silhouettes
L0 4032px: bands around skyline only → final IRLS, covariance, PSR/mode ratio
```

### 2.2 Baboud direction-aware score

The formulas come via the reimplementation in [arXiv 1508.02959](https://arxiv.org/pdf/1508.02959).
- Encode edges as z = ρe^{iθ} and square them (z² removes the ±π ambiguity).
- The match score is M = ρ₁²ρ₂² cos2(θ₁−θ₂): parallel edges score +1 and crossing edges −1.
- For all yaw and pitch shifts at once: `L = Re{IFFT[conj(FFT(z_r²))·FFT(z_p²)]}`, zero-padded vertically so it wraps only in azimuth.
- Loop over roll in 0.5° steps, then re-score the top-N peaks with the connected-edge metric: l^a for overlaps, −c for short crossing edges.
- Why crossings are penalised: a terrain silhouette map from a general viewpoint has T-junctions but never crossings. So a photo edge that crosses a rendered silhouette is evidence of misalignment ([Čadík thesis](https://cadik.posvete.cz/papers/cadik25visual_geo-localization.pdf)).
- Accuracy: 86% of 28 images below 0.2° ([RG](https://www.researchgate.net/publication/224254978_Automatic_photo-to-terrain_alignment_for_the_annotation_of_mountain_pictures)).
- Practical notes: don't smooth the score surface, because the true peak is sharp. Weight edges by height in the image to suppress foreground clutter, which otherwise makes up about 90% of edges.

### 2.3 Distance transform and oriented chamfer

**Felzenszwalb–Huttenlocher exact Euclidean DT, O(n)** ([PDF](https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf)). Run it on rows, then columns:
```
k=0; v[0]=0; z[0]=-INF; z[1]=INF
for q=1..n-1:
  s=((f[q]+q²)-(f[v[k]]+v[k]²))/(2q-2v[k])
  while s<=z[k]: k--; recompute s
  k++; v[k]=q; z[k]=s; z[k+1]=INF
k=0; for q: while z[k+1]<q: k++; d[q]=(q-v[k])²+f[v[k]]; arg[q]=v[k]
```

**Oriented truncated chamfer** ([Shotton](http://svr-www.eng.cam.ac.uk/reports/svr-ftp/shotton_iccv05.pdf); [FDCM](https://github.com/mingyuliutw/FastDirectionalChamferMatching)):
- E = (1/N)Σ[min(DT,τ)/τ + λ|o_t − o(ADT)|_π], with τ ≈ 30 px at full resolution and λ = 0.5.
- Project the render silhouette points into the photo DT, so each Jacobian row is ∇DT·∂π/∂θ.
- Sample the DT and its gradient bilinearly, pre-blurred with σ ≈ 1 px, inside LM with a Huber kernel. Fitzgibbon reports a basin many times wider than ICP ([Fitzgibbon 2003](https://www.robots.ox.ac.uk/~cvrg/michaelmas2004/fitzgibbon01c.pdf)).

**Inner silhouettes:**
- Mark a pixel as a contour if |Δlog Z| > log 1.1 and Z_far − Z_near > 50 m.
- Drop contours nearer than 500–1000 m unless you have lidar. About 8 m DEMs are only valid beyond about 500 m ([Čadík](https://dcgi.fel.cvut.cz/wp-content/wpallimport-dist/publications/pdf/publications-2018-cadik-cag-depth-paper.pdf)).
- The existing `ridges[]` output is the 1-D version of this.

### 2.4 Robust GN on per-column rows

This builds on the NASA Ames formulation ([NTRS](https://ntrs.nasa.gov/api/citations/20160011500/downloads/20160011500.pdf)). The residual is r_u = v_photo(u) − v_dem(u;θ).

**Jacobians** (x̃ = (u−c_x)/f, ỹ = (v−c_y)/f, s = skyline slope):
- ∂v/∂pitch ≈ f(1+ỹ²)
- ∂v/∂roll ≈ ±(u−c_x)
- ∂v/∂f ≈ (v−c_y)/f
- ∂r/∂yaw ≈ s·f(1+x̃²), so **flat skylines give no yaw information**.

Check the analytic Jacobians against central differences (h = 1e-4 rad).

**Per-column error model:**
```
σ_u² = σ_px² + (f·σ_z/d_u)² + (f·σ_k·d_u/2R)² + (f·σ_xy·|tan slope_u|/d_u)²
w_u  = p_sky_above·edgeStrength / σ_u²
```
- d_u comes from `HorizonProfile.distance`.
- σ_z ≈ 4–10 m for GLO-30 and about 1 m for lidar; σ_k ≈ 0.05; σ_xy from `GPSHPositioningError`.

**IRLS** ([M-estimators](https://metricgate.com/docs/m-estimator-tukey-biweight/)):
- Scale: σ̂ = 1.4826·MAD.
- Start with Huber, k = 1.345σ̂, then switch to Tukey, c = 4.685σ̂.
- Step: (JᵀWJ + μ·diag)δ = −JᵀWr.
- Priors as extra rows: pitch and roll σ = 0.5–1° (inclinometer accuracy; one iPhone was biased by −1.1° ([PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4340186/))), f σ = 2%, yaw σ = 10°.

### 2.5 Near-field occluders

1. **One-sided rejection.** Occluders only raise the photo skyline, so set w ≈ 0 when r_u < −2σ̂.
2. **Run-based rejection.** Drop runs of columns with high curvature or texture, such as tree tops.
3. **RANSAC over columns** when inliers are below 60%: sample 3–4 spread columns with |s| > 0.2, count inliers at 3 px, run 200 iterations, then IRLS on the inliers.
4. **Yaw observability gate.** Compute Σw s² f². If it is too low, flag the result and ask for a peak tap.

### 2.6 Confidence

- **Peak-to-sidelobe ratio:** PSR = (g_max − μ_sl)/σ_sl, with an exclusion window of about 1°. Bolme treats 20+ as good and about 7 as failure ([MOSSE](https://www.cs.colostate.edu/~draper/papers/bolme_cvpr10.pdf)).
- **Mode ratio:** s₂/s₁ < 0.8 for the best distinct mode more than 1° away.
- **Covariance:** Σ = σ̂²(JᵀWJ)⁻¹, with σ̂² = rᵀWr/(m−n) ([Gavin](https://people.duke.edu/~hpgavin/ce281/lm.pdf)). Inflate by √(correlation length), about √20.
- **Acceptance rule:** PSR > 10, ratio < 0.8, inliers > 50%, σ_yaw and σ_pitch < 0.05°, and RMS < 3 px at 4032.

## 3. Horizon computation

**What the literature offers.** Classical algorithms target "horizon at every cell":
- Dozier 1981 sweep ([SD](https://www.sciencedirect.com/science/article/abs/pii/0098300481900261));
- Stewart 1998, O(n log n) ([IEEE](https://ieeexplore.ieee.org/document/675656/));
- Timonen & Westerholm 2010, a GPU method;
- HORAYZON, Embree-based, 72–321× faster than brute force ([GMD](https://gmd.copernicus.org/articles/15/6817/2022/)).

For a single viewpoint, a radial march is best. Franklin & Ray found that thinning samples with distance cut the cost by 50× with similar accuracy ([PDF](https://wrfranklin.org/p/84-edinburgh-sdh94-higher-not-better.pdf)).

**Existing products:**
- PeakFinder renders on the fly out to 300 km ([App Store](https://apps.apple.com/us/app/peakfinder/id357421934)).
- Udeuschle uses k = 0.13 and interpolates 3″ DEMs to 1″ with cubic splines ([help](https://www.udeuschle.de/panoramas/help_01_en.htm)).
- HeyWhatsThat uses k ≈ 0.14 ([techfaq](http://www.heywhatsthat.com/techfaq.html)).

**Fixes for `computeHorizon`.** It currently does spherical `destination()` plus a string-keyed Map lookup per sample, with a step of 0.004·d.
1. Use one Float32 mosaic per zoom ring and sample it bilinearly.
2. Step incrementally in Mercator pixel space per azimuth, recomputing exactly at ring boundaries.
3. Use a step of max(cell, 3.5e-4·d), i.e. 0.02°. The current step is 11× coarser and can skip narrow summits.
4. Store t = (h−h_o)/d − d/(2R′) and take atan once per azimuth.
5. Skip blocks with a max-mipmap ([Tevs 2008](https://dl.acm.org/doi/10.1145/1342250.1342279)) when `(Hmax−h_o)/d_near − d_near/2R′ ≤ t_best`.
6. Use a worker pool (SharedArrayBuffer needs COOP/COEP headers).

**GPU version:**
- One fragment per azimuth into a 7200×1 RGBA16F or packed target.
- iOS has no float32 colour attachments ([Khronos #3093](https://github.com/KhronosGroup/WebGL/issues/3093)) and no float-linear filtering, so do bilinear sampling manually.
- Prefer WebGPU compute ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers)).
- Keep the CPU path as a reference and check the two agree to within 0.005°.

**Refraction:**
- Exact spherical form ([Patat](https://arxiv.org/pdf/1107.1957)), with θ = d/R′: α = atan((h_B cosθ − h_A − R′(1−cosθ))/((R′+h_B) sinθ)).
- Near the ground k ranges from −4 to +16 ([Hirt 2010](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2010JD014067)).
- **Fit k** (prior 0.13 ± 0.05) when columns beyond 60 km are present, with ∂α/∂k ≈ −d/2R.

**DEM resolution:**
- For 1 px (0.02°), a cell must be at most 0.35 m at 1 km, 1.7 m at 5 km, 7 m at 20 km and 35 m at 100 km.
- Mapterhorn serves 512 px WebP Terrarium tiles ([docs](https://mapterhorn.com/data-access/); [attribution](https://download.mapterhorn.com/attribution.json)). At 46° N, z12 ≈ 13 m and z14 ≈ 3.3 m. Sources are GLO-30 plus Swiss, Austrian and French lidar.
- Recommended rings:

  | Distance | Zoom |
  |---|---|
  | 0–3 km | z14 (z15 where lidar exists) |
  | 3–10 km | z13 |
  | 10–30 km | z12 |
  | 30–80 km | z11 |
  | 80–200 km | z10 |
  | 200–300 km | z9 |

## 4. iPhone camera model

- **Focal length.** f_px = f35·√(W²+H²)/43.27.
  - Rounding the integer tag adds about 2% error, so solve f.
  - Build a per-`LensModel` calibrated f/W table. iOS 17.4 changed 6.86 → 6.765 mm on the same hardware ([Adobe](https://community.adobe.com/questions-675/ios-17-4-iphone-15-pro-max-main-camera-lens-metadata-change-prevents-auto-lens-profile-correction-975492)).
  - f35 was scaled wrongly on resized exports on older iOS ([Apple 745938](https://developer.apple.com/forums/thread/745938)).
- **Crops.**
  - 28/35/48 mm are crops of the 48 MP sensor ([GSMArena](https://www.gsmarena.com/apple_iphone_15_pro-review-2620p5.php)). Use FocalLength × DigitalZoomRatio.
  - HEIF Max is 8064×6048.
  - For aspect ratios other than 4:3 or 16:9, treat the principal point as unknown.
- **Distortion.** Output is already rectified ([Adobe](https://community.adobe.com/questions-675/lightroom-fails-to-apply-built-in-lens-correction-for-iphone-13-pro-965311)). Add an optional k₁ (prior 0 ± 0.01) only when there are more than 800 inlier columns spanning more than 70% of the width.
- **Gravity (MakerNote 0x0008).**
  - Axes: +X left, +Y bottom, +Z into the face of the phone, in units of g ([ExifTool](https://exiftool.org/TagNames/Apple.html)).
  - Map through EXIF Orientation first. Elevation = asin(−a_z); roll = atan2(a_x, a_y), up to sign.
  - Calibrate the signs with a level photo.
  - Infer orientation from gravity plus aspect ratio when editors have rotated the pixels ([asterism #141](https://github.com/cwage/asterism/pull/141)).
  - Accuracy is 0.5–1°, so use it as a prior.
- **Rolling shutter.** About 5 ms readout ([CineD](https://www.cined.com/iphone-15-pro-lab-test-rolling-shutter-dynamic-range-and-exposure-latitude/)), about 0.005°. Ignore it.
- **Decoding.** Use `createImageBitmap(..., {imageOrientation:'none'})` and orient manually ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)). HEIC works only in Safari; elsewhere use libheif-wasm ([caniuse](https://caniuse.com/heif)).

## 5. Peaks and labels

- **Snapping.**
  - Search a dense 7×7 grid for the DEM local maximum within max(150 m, 3 cells) of the OSM node.
  - Use h = max(DEM, OSM `ele`), because summits are smoothed low in DEMs ([viewfinder](https://viewfinderpanoramas.org/elevmisquotes.html)).
  - Reject snaps that move more than 300 m or change height by more than 80 m.
- **Occlusion test, done during the march:**
  ```
  α_occ = max α over d < d_p − max(2·cell,150 m)
  visible   = α_p ≥ α_occ − (0.02° + σ_z/d_p)
  onSkyline = |α_p − horizon[az]| < 0.05°
  ```
  Treat marginal peaks as dimmed.
- **Prominence.** Use the OSM tag, or offline lists from Kirmse & de Ferranti's divide trees ([SAGE](https://journals.sagepub.com/doi/abs/10.1177/0309133317738163)). At runtime, angular height above the local horizon minimum within ±2° is a proxy.
- **Peaks as observations.** Converged on-skyline peaks can be added as extra yaw residuals.

## 6. Browser efficiency

- **Tile decode.** Use `createImageBitmap(blob,{premultiplyAlpha:'none',colorSpaceConversion:'none'})`, then OffscreenCanvas 2D with `willReadFrequently`.
  - deck.gl saw worker-only Terrarium corruption even with these flags ([#10400](https://github.com/visgl/deck.gl/issues/10400)). A ±1 error in R is ±256 m.
  - Validate each tile by flagging neighbour jumps of 200 m or more, and keep a JS/WASM WebP decoder as fallback.
  - `ImageDecoder` is not available in Safari ([caniuse](https://caniuse.com/mdn-api_imagedecoder)).
- **Caching.**
  - Cache API for raw tiles; IndexedDB for decoded mosaics and horizon profiles.
  - Call `navigator.storage.persist()`.
  - Safari evicts storage after 7 days without interaction ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)).
- **WASM.** SIMD128 works everywhere; relaxed SIMD is not in Safari. Threads need COOP `same-origin` plus COEP `require-corp` ([web.dev](https://web.dev/articles/coop-coep)). Good targets are the FFT and the distance transform.
- **WebGPU.** Distance transform via jump flooding ([JFA](https://www.comp.nus.edu.sg/~tants/jfa.html)) or exact Felzenszwalb passes, one workgroup per row. Batch all pose hypotheses into one dispatch.
- **Precision.**
  - Use camera-relative ENU, since ECEF in float32 is about 0.5 m.
  - Keep angles and LM state in Float64, and wrap angles.
  - Use `Math.fround` in tests to mimic GPU rounding.
- **Pipeline layout.**
  - Worker A: tiles → mosaics → horizon.
  - Worker B: photo → sky → DP → DT.
  - Transfer buffers rather than copying them.

## 7. Top 10 upgrades, ranked by impact

1. **Per-column error model plus IRLS** (Huber then Tukey), with one-sided occluder rejection. Near-ridge DEM error currently dominates.
2. **Always-free f** (optionally k₁ and refraction k) with priors, plus a per-`LensModel` focal table.
3. **Confidence gate:** PSR, mode ratio, inflated covariance, inlier fraction and yaw observability. Route low-confidence results to the tap-a-peak flow.
4. **Baboud complex-squared FFT correlation** as the global initialiser, keeping the top 3–5 modes.
5. **Oriented truncated chamfer** on inner silhouettes (log-range contours beyond 500 m) via the Felzenszwalb distance transform.
6. **Horizon march rewrite:** ring mosaics, Mercator stepping, a step of 3.5e-4·d, a max-mipmap skip, and a worker pool. Estimated 10–50× faster.
7. **Permissive MIT sky model** (fp16, WebGPU) as the unary term of the Viterbi DP, with sub-pixel row refinement. Avoid SegFormer.
8. **Coarse-to-fine pyramid**, with the final solve at full resolution on bands around the skyline only.
9. **Peak snapping and occlusion inside the march**, with peaks used as yaw residuals.
10. **Tile pipeline hardening:** decode validation, persistent caching, cached horizons, and iOS half-float or WebGPU paths.

*Estimates to calibrate on `img/`: timings, the PSR and ratio thresholds, the log 1.1 contour threshold, and the gravity sign conventions.*