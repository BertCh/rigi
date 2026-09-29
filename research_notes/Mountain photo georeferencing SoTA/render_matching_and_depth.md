# Render-and-compare pose refinement of photos against rendered terrain: learned matchers, 3D foundation models, monocular depth and calibration (as of Sept 2026)

Note on sourcing: items marked **[verified]** were checked against a fetched or searched page in this session. Items marked **[prior knowledge]** come from the researcher's background knowledge, with the canonical paper/repo URL given, but were NOT re-fetched in this session. The report writer should treat [prior knowledge] items as lower confidence, especially numbers.

---

## 1. Learned matchers and 3D foundation models: which exist, what is newest, and how they handle cross-domain (photo vs. render) matching

### Takeaway
The current (Sept 2026) frontier is RoMa v2 (DINOv3-based dense matcher, ECCV 2026, MIT code) for pairwise matching, plus feed-forward 3D models (MASt3R, VGGT, π3, MapAnything, Depth Anything 3). Nobody has published a standard photo-vs-DEM-render matching benchmark. The evidence that dense, foundation-backbone matchers transfer across domains is indirect: synthetic-to-real results (Geo-LoFTR, CrossLoc), historical-image work with SuperGlue, and a new Aug 2026 cross-view matching survey that names cross-domain generalization as an open problem. Licenses differ a lot. Several of the strongest checkpoints are non-commercial.

### Cited Findings

**Sparse matchers**
- SuperPoint+SuperGlue and LightGlue use attention to solve the optimal assignment. They give accurate, evenly distributed matches with few mismatches, suited to high-precision matching. [verified] — [LightGlue ResearchGate](https://www.researchgate.net/publication/377420496_LightGlue_Local_Feature_Matching_at_Light_Speed)
- LightGlue has a maintained ONNX export (`fabio-sim/LightGlue-ONNX`, mirrored as `colmap/LightGlue-ONNX`) with SuperPoint/DISK + LightGlue models, including FP16 variants, and supports TensorRT/OpenVINO. [verified] — [colmap/LightGlue-ONNX](https://github.com/colmap/LightGlue-ONNX); [fabio-sim/LightGlue-ONNX](https://github.com/fabio-sim/lightglue-onnx)
- Detector-free semi-dense matchers include LoFTR (CVPR 2021) and Efficient LoFTR (CVPR 2024, "sparse-like speed"). [verified] — [LoFTR arXiv](https://arxiv.org/pdf/2104.00680); [Efficient LoFTR arXiv](https://arxiv.org/pdf/2403.04765)

**Dense matchers**
- RoMa (CVPR 2024) is a robust dense matcher that uses a frozen DINOv2 backbone. [verified] — [RoMa arXiv 2305.15404](https://arxiv.org/pdf/2305.15404)
- **RoMa v2** ("Harder Better Faster Denser Feature Matching", arXiv 2511.15706, submitted 19 Nov 2025, ECCV 2026 poster) [verified]:
  - Frozen **DINOv3 ViT-L** backbone, a multi-view transformer with alternating global/axial RoPE attention, a decoupled matching-then-refinement pipeline, and a custom CUDA kernel that cuts refinement memory. [verified] — [arXiv abs](https://arxiv.org/abs/2511.15706); [ECCV 2026 poster](https://eccv.ecva.net/virtual/2026/poster/3967)
  - It reportedly outperforms RoMa and UFM, e.g. EPE 13.82 vs UFM 15.85 on TA-WB. This number comes from an aggregator summary, not the paper table. [verified-secondary] — [emergentmind summary](https://www.emergentmind.com/papers/2511.15706)
  - License: code is **MIT**, but the DINOv3 backbone carries Meta's custom DINOv3 license. Reported benchmark AUC@5/10/20: MegaDepth-1500 [62.8, 76.8, 86.5]; ScanNet-1500 [34.0, 56.5, 73.9]. Resolution is configurable (low-res matching plus high-res refinement). [verified] — [GitHub Parskatt/romav2](https://github.com/Parskatt/romav2)
- MV-RoMa (arXiv 2603.27542, 2026) extends RoMa from pairwise matching to multi-view track reconstruction. [verified, title only] — [arXiv 2603.27542](https://arxiv.org/pdf/2603.27542)
- DKM (CVPR 2023) is RoMa's predecessor from the same group. [prior knowledge] — [arXiv 2202.00667](https://arxiv.org/abs/2202.00667)
- ASpanFormer (ECCV 2022) is a LoFTR-family semi-dense matcher. It is superseded in accuracy by RoMa-class methods. [prior knowledge] — [arXiv 2208.14201](https://arxiv.org/abs/2208.14201)

**3D foundation models (pointmap regressors)**
- **MASt3R** extends DUSt3R with metric pointmaps and a matching head. It handles very sparse overlaps and generalizes well. [verified] — [NAVER LABS 3D foundation models](https://europe.naverlabs.com/research/3d-foundation-models/); [naver/mast3r](https://github.com/naver/mast3r)
- MASt3R license is **CC BY-NC-SA 4.0** (non-commercial). A `CHECKPOINTS_NOTICE` warns that training datasets add further restrictions, notably MapFree. The model is a ViT-L encoder with a base decoder trained at 512-px widths. The repo ships visual-localization examples (Aachen, InLoc, Cambridge, 7-Scenes). [verified] — [naver/mast3r](https://github.com/naver/mast3r)
- **VGGT** won the CVPR 2025 Best Paper. Since 29 July 2025 the code license permits commercial use, but only the separate **VGGT-1B-Commercial** checkpoint (gated application form) is commercially licensed. The original VGGT-1B weights stay **CC BY-NC 4.0**. [verified] — [facebookresearch/vggt](https://github.com/facebookresearch/vggt); search summary of license
- **π3 (Pi3)**: code is BSD-2 for academic use, and commercial use requires contacting the authors. Weights are reported as CC-BY-NC-4.0. [verified] — [HF yyfz233/Pi3](https://huggingface.co/yyfz233/Pi3)
- **MapAnything** (Meta, V1 Sept 2025) is a single transformer that regresses factored metric 3D geometry. It optionally takes intrinsics, poses (OpenCV convention), depth maps and ray directions, and outputs world/camera pointmaps, depth, cameras and confidence. Code is **Apache 2.0**. Checkpoint `facebook/map-anything` is **CC-BY-NC 4.0** (best performance). Checkpoint `facebook/map-anything-apache` is **Apache 2.0** (commercial-friendly). It also wraps DUSt3R/MASt3R/VGGT behind a unified interface. [verified] — [facebookresearch/map-anything](https://github.com/facebookresearch/map-anything)
  - Relevance: MapAnything can accept known intrinsics/pose/depth, so in principle a DEM render's depth + pose could be fed as one "view" and the photo as another. This is an inference, not documented as a use case.
- **Depth Anything 3** (ByteDance Seed, released 14 Nov 2025) is an any-view model that outputs depth plus pose/rays. It also has pose-conditioned depth, a metric model, and sky segmentation in the Nested series. See section 5 for licenses. [verified] — [ByteDance-Seed/Depth-Anything-3](https://github.com/ByteDance-Seed/Depth-Anything-3)
- VGG-T³ ("Offline Feed-Forward 3D Reconstruction at Scale", CVPR 2026, NVIDIA) is another 2026 successor. [verified, title only] — [nv-dvl/vgg-ttt](https://github.com/nv-dvl/vgg-ttt)
- An evaluation of DUSt3R/MASt3R/VGGT on photogrammetric aerial blocks was published online on 11 Dec 2025 (Geo-spatial Information Science). It is relevant for how these models behave on geospatial imagery. [verified, metadata only] — [arXiv 2507.14798](https://arxiv.org/pdf/2507.14798); [T&F](https://www.tandfonline.com/doi/full/10.1080/10095020.2025.2597491)
- `gmberton/awesome-3D-vision` maintains a comparison table of image-to-3D methods, useful for tracking licenses and successors. [verified, existence] — [GitHub](https://github.com/gmberton/awesome-3D-vision)

**Cross-domain / photo-to-render evidence**
- A cross-view feature matching survey (Du, Lu, Wu, Lu, Xiao, Fan, Ma, Ikenaga; arXiv 2608.11093, 11 Aug 2026) benchmarks state-of-the-art matchers under unified protocols, covers foundation-model-based matchers, and names **cross-domain generalization** as an open challenge. The abstract does not report photo-vs-render results. [verified] — [arXiv 2608.11093](https://arxiv.org/abs/2608.11093)
- **Geo-LoFTR** (NASA JPL, arXiv 2502.09795) is a geometry-aided LoFTR that uses DTM geometric context. It improves localization by up to 31.8% under large illumination differences. It was trained **entirely on synthetic renders** (MARTIAN, a Blender renderer over HiRISE orthoimagery + DTM), yet localized real descent frames from 6 km to 960 m altitude and real Mars2020 LCAM-vs-CTX imagery. This is direct evidence of synthetic-render-to-real matching transfer when the observation-to-map scale ratios are comparable. [verified] — [arXiv 2502.09795](https://arxiv.org/html/2502.09795v3); [MARTIAN arXiv 2605.29647](https://arxiv.org/html/2605.29647); [nasa-jpl/martian](https://github.com/nasa-jpl/martian)
- **CrossLoc + TOPO-DataGen** (EPFL TOPO lab, CVPR 2022): TOPO-DataGen generates multimodal synthetic data (RGB, depth/scene coordinates, semantics) from off-the-shelf geodata (swisstopo DEM + orthophoto) at matching geographic viewpoints. CrossLoc learns scene-coordinate regression from it for aerial absolute localization and ships sim-to-real benchmark datasets on Zenodo. [verified] — [arXiv 2112.09081](https://arxiv.org/abs/2112.09081); [TOPO-DataGen](https://github.com/EPFL-ENAC/TOPO-DataGen); [CrossLoc](https://github.com/TOPO-EPFL/CrossLoc); [Zenodo datasets](https://zenodo.org/records/6376262)
- An EPFL/ETH-era photo-to-historical-render benchmark was requested but not found (see Gaps).

### Inferences
- For photo vs. orthophoto-textured DEM render, dense DINO-backbone matchers (RoMa, RoMa v2) are the most likely to succeed. Their frozen foundation features are fairly invariant to appearance, and RoMa v2 was trained explicitly for "harder" cases. Sparse SuperPoint+LightGlue relies on local corner/texture statistics that differ strongly between a hazy distant ridge and a crisp orthophoto render. It is fast and browser-feasible but likely weaker cross-domain.
- For untextured shaded-relief or depth/normal renders, appearance matchers have little shared texture to use. Structural cues (skylines, ridgeline/occlusion edges) or geometry-to-geometry alignment (mono depth vs. rendered depth) are more reliable. The JPL salient-edge work (section 3) supports edge-domain matching for textureless models.
- Pointmap models (MASt3R/VGGT/π3/MapAnything) may give more robust correspondences between photo and render than 2D matchers. However, they were trained on real imagery at metres-to-hundreds-of-metres scale, and km-scale landscape baselines are out of distribution. They are also mostly non-commercial except MapAnything-apache, VGGT-1B-Commercial and DA3 Base/Small.

### Gaps
- No published benchmark was found specifically for **photo vs. DEM-render** (or historical photo vs. Google Earth render) matching comparing LightGlue/LoFTR/RoMa/MASt3R. A small in-house test set (e.g. GeoPose3K images with known poses) would be needed.
- Did not verify RoMa v2 runtime numbers, or whether RoMa v2's training mix includes synthetic/rendered data.
- ASpanFormer, DKM and MASt3R-SfM details are prior knowledge only.

---

## 2. Specific pipelines: mountain / historical photo localization against DEM renders, and related render-based localization

### Takeaway
Mountain-specific work goes from skyline/horizon matching (Baatz 2012, Saurer 2016, historical-horizon orientation 2022) to learned cross-domain descriptors against textured terrain (LandscapeAR, ECCV 2020, with an iPhone implementation). Historical-image photogrammetry (Maiwald et al.) showed that SuperGlue-class matchers plus retrieval work across large radiometric and temporal gaps. For a peak-labelling app, the proven recipe is: GPS/compass prior, then render DEM+ortho, then learned matching, then lift to 3D, then PnP+RANSAC, then iterate. OrienterNet/MapLocNet/PixLoc are 2D-map or featuremetric relatives, not direct DEM-render solutions.

### Cited Findings
- **LandscapeAR** (Brejcha et al., ECCV 2020) learns a cross-domain feature embedding between photographs and textured terrain models. Internet photos are reconstructed with SfM and aligned to the terrain to produce training correspondences. The dataset is 16k images with precise single-image poses, which the authors describe as by far the largest such dataset in mountains. The system runs **on iPhone**, showing on-device large-scale localization. [verified] — [Springer ECCV 2020](https://link.springer.com/chapter/10.1007/978-3-030-58526-6_18); related patent [USPTO 11568642](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11568642)
  - The same line of work lists the core difficulties. DEMs are often too coarse for local peak features, which causes horizon mismatches. Photos also have unknown intrinsics, seasonal/weather variation, foreground occluders and objects missing from the DEM. [verified] — same source
- **GeoPose3K** is a mountain landscape dataset with camera poses for outdoor pose estimation. It is a candidate evaluation set. [verified, existence] — [ResearchGate](https://www.researchgate.net/publication/317693172_GeoPose3K_Mountain_Landscape_Dataset_for_Camera_Pose_Estimation_in_Outdoor_Environments)
- Older DEM-alignment baselines [verified, existence/titles]:
  - Baum/Baboud et al. "Automatic photo-to-terrain alignment for the annotation of mountain pictures" (CVPR 2011). — [ACM DL](https://dl.acm.org/doi/10.1109/CVPR.2011.5995727)
  - "An automatic image-to-DEM alignment approach for annotating mountains pictures on a smartphone". — [ResearchGate](https://www.researchgate.net/publication/308417285_An_automatic_image-to-DEM_alignment_approach_for_annotating_mountains_pictures_on_a_smartphone)
  - "Pose estimation of landscape images using DEM and orthophotos". — [ResearchGate](https://www.researchgate.net/publication/261170116_Pose_estimation_of_landscape_images_using_DEM_and_orthophotos)
  - Baatz et al., "Large Scale Visual Geo-Localization of Images in Mountainous Terrain" (skyline vs. synthetic skyline from swisstopo DEM; 40,000 km² of Switzerland; >200 test images). — [Semantic Scholar](https://www.semanticscholar.org/paper/Large-Scale-Visual-Geo-Localization-of-Images-in-Baatz-Saurer/02d3f73761b8aab57f063dea5002b532ac8ace76)
  - Saurer et al., "Image Based Geo-localization in the Alps". — [ResearchGate](https://www.researchgate.net/publication/279220469_Image_Based_Geo-localization_in_the_Alps)
- **Historical terrestrial images**:
  - Maiwald et al. combine CNN image retrieval with SuperPoint+SuperGlue for fully automated selection and pose estimation of historical terrestrial images for 4D GIS. [verified] — [MDPI IJGI 10(11):748](https://www.mdpi.com/2220-9964/10/11/748)
  - Maiwald 2021, "An automatic workflow for orientation of historical images with large radiometric and geometric differences" (Photogrammetric Record). [verified, existence] — [Wiley](https://onlinelibrary.wiley.com/doi/full/10.1111/phor.12363)
  - "Automatic orientation of historical terrestrial images in mountainous terrain using the visible horizon" (ISPRS Open Journal of Photogrammetry and Remote Sensing, 2022) orients historical mountain photos from the visible horizon against the DEM. [verified, existence; full text 403] — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2667393222000151). Authors believed to be Mikolka-Flöry & Pfeifer (TU Wien) [prior knowledge, unverified].
- **Historical aerial images** [verified]:
  - Zhang et al., "Feature matching for multi-epoch historical aerial images" (ISPRS J. 2021) matches DSMs with SuperGlue for rough inter-epoch co-registration, then guides precise RGB matching. This DSM-rendered-as-image trick is directly relevant. — [arXiv 2112.04255](https://arxiv.org/pdf/2112.04255)
  - "Solving photogrammetric cold cases using AI-based image matching" (ISPRS J. 2023). — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0924271623003131)
- **DEM-to-DEM registration via rendering** (Applied Sciences 16(3):1238, Jan 2026) converts DEMs to images using an irradiance (physically consistent shading) model and then applies multimodal image matching. This supports "render DEM as hillshade, then match" as a practical cross-modal bridge. [verified, abstract-level] — [doi 10.3390/app16031238](https://doi.org/10.3390/app16031238)
- **Salient edge rendering** (Pham et al., NASA JPL, arXiv 2509.25520, 2025) renders salient edges of low-fidelity **textureless** 3D models. It uses a weighted-Hamming template-matching metric in the edge domain for 6-DoF localization, and beats the state of the art in compute/memory-constrained localization on synthetic, Earth testbed and Mars data. This is a strong analogue for ridgeline/skyline render-and-compare against an untextured DEM. [verified] — [arXiv 2509.25520](https://arxiv.org/abs/2509.25520)
- **OrienterNet** (Sarlin et al., CVPR 2023) localizes a ground image in 2D OpenStreetMap with sub-metre accuracy using a neural BEV-vs-map matcher, estimating 3-DoF (x, y, yaw). **PixLoc** (CVPR 2021) does featuremetric direct alignment of learned features against a 3D model and is the canonical learned render-and-compare refinement. **MapLocNet** is a later OSM/nav-map variant. [prior knowledge] — [OrienterNet arXiv 2304.02009](https://arxiv.org/abs/2304.02009); [PixLoc arXiv 2103.09213](https://arxiv.org/abs/2103.09213)
- **Map-free relocalization** (Niantic, ECCV 2022) is a benchmark for metric relative pose from a single reference image. MASt3R's `CHECKPOINTS_NOTICE` flags the MapFree dataset's restrictive license. [verified for license note] — [naver/mast3r](https://github.com/naver/mast3r)
- **MegaLoc** (Berton & Masone, 2025) is a retrieval (VPR) model, useful only for coarse place recognition. [prior knowledge] — [arXiv 2502.17237](https://arxiv.org/abs/2502.17237)

### Inferences
- Recommended architecture:
  1. Coarse pose from EXIF GPS + compass/heading (if present) + GeoCalib gravity/focal.
  2. Render the DEM (orthophoto-textured and hillshade) at that pose with a wide FoV.
  3. Match photo↔render with RoMa/RoMa v2 (server) or SuperPoint+LightGlue (browser).
  4. Look up each render match's 3D point from the rendered depth/XYZ buffer.
  5. PnP+RANSAC with unknown focal (P4Pf/P5Pfr in PoseLib).
  6. Re-render at the new pose and iterate 2–4 times. Finish with a skyline/edge alignment term.
- LandscapeAR's learned embedding is the most on-target prior art. Its failure modes (coarse DEM, missing objects) argue for using high-res DEMs (swissALTI3D 0.5–2 m, USGS 3DEP 1 m) near the camera, with robust weighting that favours distant ridgelines.

### Gaps
- Could not find a 2024–2026 paper that runs RoMa/MASt3R/VGGT on photo-vs-Google-Earth/swisstopo renders for mountain or historical photos. Searches returned only the older SuperGlue-based works. This may exist in ISPRS Archives 2025/2026 but was not surfaced.
- "Snap", "Adaptive Render" and "Time Machine"-style EPFL works were not found or verified in this session.
- OrienterNet/PixLoc/MapLocNet/MegaLoc details are unverified prior knowledge.

---

## 3. Lifting 2D matches to 3D via rendered depth, PnP/RANSAC, and differentiable-rendering refinement

### Takeaway
The standard lift is to render depth (or better, a world-XYZ buffer in float32) alongside the colour render, read the 3D point under each matched render pixel, then solve absolute pose with a minimal solver inside LO-RANSAC. PoseLib supports unknown focal length. Refinement is an iterative render→match→PnP loop, optionally followed by direct/differentiable alignment (featuremetric or edge/skyline) using nvdiffrast/PyTorch3D-style rasterizers. No turnkey differentiable-skyline library was found.

### Cited Findings
- The MASt3R repo includes visual-localization examples that lift 2D matches to 3D via predicted/known depth, then apply PnP on standard benchmarks (Aachen, InLoc, Cambridge, 7-Scenes). [verified] — [naver/mast3r](https://github.com/naver/mast3r)
- Geo-LoFTR shows that injecting DTM geometry into the matcher (not just using it at PnP time) improves robustness to illumination by up to 31.8%. [verified] — [arXiv 2502.09795](https://arxiv.org/html/2502.09795v3)
- The JPL salient-edge method refines 6-DoF pose against renders of a textureless model using an edge-domain similarity. It is a render-and-compare loop that needs no texture. [verified] — [arXiv 2509.25520](https://arxiv.org/abs/2509.25520)
- PoseLib provides minimal absolute-pose solvers (P3P, P4Pf, P5Pfr for unknown focal/radial distortion) with LO-RANSAC and bundle refinement. OpenCV provides `solvePnPRansac` and `solvePnPRefineLM`, but only with known intrinsics. [prior knowledge] — [PoseLib GitHub](https://github.com/PoseLib/PoseLib)
- PixLoc's featuremetric Levenberg–Marquardt alignment against a 3D model is the learned analogue of render-and-compare refinement. [prior knowledge] — [arXiv 2103.09213](https://arxiv.org/abs/2103.09213)

### Inferences
- Implementation details for the DEM case:
  - Render a float32 **world-coordinate buffer** (or linear depth plus inverse projection) in a projected CRS local to the camera (ENU), so precision is not lost at km range.
  - Use a logarithmic or reversed-Z depth buffer.
  - Reject matches on sky pixels and on rendered pixels where the depth gradient is large (occlusion boundaries), where a 1-px error means a km-scale 3D error.
- Use a PnP solver with unknown focal (P4Pf), then bundle-adjust f (and k1) together with pose over all inliers. The iPhone EXIF focal length (35 mm equivalent) gives a strong prior. Crop/zoom invalidates it unless the pixel dimensions are checked.
- Far-range geometry is poorly conditioned: translation along the view direction is weakly observable when all points are 5–50 km away. The GPS position should be a strong prior, and optimisation should often be rotation+focal only, or pose with a GPS position regulariser.
- Differentiable refinement: a skyline/ridgeline silhouette loss (distance transform of photo edges vs. rendered occlusion contours) is easy to write with PyTorch3D or nvdiffrast soft rasterization. In the browser it can be approximated with numerical Jacobians over re-rendered WebGL frames, since the parameter space is small (6–8 DoF).

### Gaps
- No verified source was found for an off-the-shelf "differentiable skyline" or nvdiffrast-based DEM pose-refinement project. Neither nvdiffrast nor PyTorch3D was verified in this session.
- No verified quantitative accuracy for photo-to-DEM PnP with modern matchers (e.g. median angular error) was found.

---

## 4. Monocular depth/geometry models and single-image calibration as priors

### Takeaway
The newest models:
- Depth Anything 3 (Nov 2025)
- MoGe-2 (Jul 2025) and **MoGe-3** (arXiv Jul 2026, officially released 18 Aug 2026)
- UniDepthV2, Depth Pro, Metric3D v2
- Marigold (diffusion)

MoGe, UniDepth and Depth Pro also estimate the field of view. On km-scale landscapes, metric depth is unreliable and tends to saturate or compress distant ranges. Relative ordering, occlusion edges, sky masks and the FoV estimate are the useful signals for DEM alignment. GeoCalib (ECCV 2024) is the best-documented single-image gravity (roll/pitch) + focal estimator.

### Cited Findings
- **MoGe-3** ("Fine-Detail Monocular Geometry Estimation with Self-Guided Sparse Volumetric Refinement", arXiv 2607.17967, July 2026, Tsinghua/USTC/Microsoft Research) lifts refinement into sparse 3D for high-fidelity metric-scale point maps. Official release is reported as 18 Aug 2026. [verified] — [arXiv 2607.17967](https://arxiv.org/abs/2607.17967); [Microsoft Research](https://www.microsoft.com/en-us/research/publication/moge-3-fine-detail-monocular-geometry-estimation-with-self-guided-sparse-volumetric-refinement/)
- **MoGe-2** (arXiv 2507.02546): "Accurate Monocular Geometry with Metric Scale and Sharp Details". MoGe (v1) was a CVPR'25 Oral. The repo is microsoft/MoGe. [verified] — [arXiv 2507.02546](https://arxiv.org/pdf/2507.02546); [microsoft/MoGe](https://github.com/microsoft/moge)
- One robustness study (procedural scene perturbations, 2025) found:
  - **Depth Pro** has the lowest error vs ground truth by ~13% but is less robust to perturbations than other models.
  - Among scale-invariant models, **UniDepthV2** has the best self-consistency, closely followed by **MoGe**.
  
  [verified, via search snippet] — [arXiv 2507.00981](https://arxiv.org/html/2507.00981v1)
- New 2026 evaluation resources:
  - "Depth2Pose: A Pose-Based Benchmark for Monocular Depth Estimation without Ground-Truth Depth" (arXiv 2605.19797).
  - "Sparse-LiDAR Prompting of Monocular Geometry Foundations: An Empirical Study Toward Long-Range Driving Depth" (arXiv 2605.26456).
  - Survey "Monocular Depth Estimation from a Single Image: Progress and Opportunities" (arXiv 2609.01172).
  
  [verified, titles only] — [2605.19797](https://arxiv.org/pdf/2605.19797); [2605.26456](https://arxiv.org/pdf/2605.26456); [2609.01172](https://arxiv.org/pdf/2609.01172)
- **Depth Anything 3** models support relative depth and pose. DA3METRIC-LARGE and the Nested series add metric depth. The Nested series includes **sky segmentation**. DA3-Streaming handles long videos in <12 GB. [verified] — [ByteDance-Seed/Depth-Anything-3](https://github.com/ByteDance-Seed/Depth-Anything-3)
- **GeoCalib** (Veicht, Sarlin, Lindenberger, Pollefeys; ECCV 2024) estimates focal length and gravity direction (roll/pitch) from one image with a network plus geometric optimization. Code is **Apache-2.0**, weights are **CC BY 4.0** (commercial use OK with attribution). [verified] — [cvg/GeoCalib](https://github.com/cvg/GeoCalib)
- **AnyCalib** (arXiv 2503.12701, 2025) is a newer model-agnostic single-view calibration method. [verified, title] — [arXiv 2503.12701](https://arxiv.org/pdf/2503.12701)
- **Other models**: Perspective Fields (CVPR 2023) predicts per-pixel up-vector/latitude. DeepCalib (2018) is an older single-image intrinsics CNN. Metric3D v2 (TPAMI 2024) gives metric depth + normals. Marigold (CVPR 2024) is a diffusion-based affine-invariant depth model. Depth Anything V2 (NeurIPS 2024): Small is Apache-2.0, Base/Large/Giant are CC-BY-NC-4.0. [prior knowledge] — [Perspective Fields arXiv 2212.03239](https://arxiv.org/abs/2212.03239); [Metric3D v2 arXiv 2404.15506](https://arxiv.org/abs/2404.15506); [Marigold arXiv 2312.02145](https://arxiv.org/abs/2312.02145); [Depth Anything V2](https://github.com/DepthAnything/Depth-Anything-V2)

### Inferences
- **Saturation at km range**: most metric models were trained on driving/indoor/urban data with depth caps of roughly 80–200 m. Distant mountain ranges will be heavily compressed, and metric values beyond a few hundred metres should not be trusted. This is an inference from training distributions and was not verified with a landscape benchmark (see Gaps).
- **Useful derived signals for DEM alignment**:
  - Sky mask / skyline, from DA3-Nested sky segmentation or the depth=∞ region, for skyline matching against the rendered horizon.
  - Occlusion boundaries: depth discontinuities in mono depth correspond to ridgeline edges in the DEM render.
  - Ordinal depth: which ridge is in front of which, as a robust rank correlation (Spearman/Kendall) against rendered depth, usable as a hypothesis-scoring function.
  - FoV/focal: take the estimate from MoGe/UniDepth/Depth Pro/GeoCalib and check it against EXIF.
  - Gravity: GeoCalib roll/pitch, which constrains 2 of the 3 rotation DoF.
- For near-field foreground (0–500 m), mono depth can help decide which photo pixels belong to terrain in the DEM and which to occluders (trees, people, buildings), and so down-weight them in matching.

### Gaps
- Found no published benchmark that measures mono-depth models on km-scale mountain landscapes (e.g. against GeoPose3K DEM-rendered depth). The saturation claim is inferred, not sourced. GeoPose3K's DEM-rendered depth could serve as ground truth for an in-house test.
- UniDepthV2, Depth Pro and Metric3D v2 maximum depth ranges and licenses were not verified in this session.

---

## 5. Compute, browser feasibility, and licenses

### Takeaway
Only lightweight sparse matching (SuperPoint/DISK + LightGlue via ONNX Runtime Web) and small depth models (e.g. DA3-Small/Base, Depth Anything V2 Small) are realistic in-browser. WebGPU has known correctness issues with LightGlue-ONNX, and WASM is correct but slower. RoMa v2 (DINOv3 ViT-L plus a custom CUDA kernel), MASt3R/VGGT/MapAnything/π3 and MoGe-3 belong on a Python GPU server. For a commercial product, the licenses rule out MASt3R/DUSt3R (CC BY-NC-SA), VGGT-1B original, π3 weights, MapAnything non-apache, and DA3 Large/Giant/Nested.

### Cited Findings
- **Browser**:
  - fabio-sim/LightGlue-ONNX provides SuperPoint+LightGlue ONNX models usable with onnxruntime-web.
  - ONNX Runtime issue #25227 reports that **WebGPU results differ from WASM** for LightGlue-ONNX: WASM gives the expected keypoints and matches, WebGPU loses matches.
  
  [verified] — [onnxruntime #25227](https://github.com/microsoft/onnxruntime/issues/25227); [fabio-sim/LightGlue-ONNX](https://github.com/fabio-sim/lightglue-onnx)
- LandscapeAR's learned photo-terrain matching ran on an iPhone (2020), which shows that mobile-class compute is enough for a lighter learned descriptor approach. [verified] — [Springer](https://link.springer.com/chapter/10.1007/978-3-030-58526-6_18)
- **RoMa v2**: DINOv3 ViT-L backbone, and a custom CUDA kernel is needed for memory-efficient refinement. MIT code + DINOv3 license. [verified] — [Parskatt/romav2](https://github.com/Parskatt/romav2)
- **MapAnything** memory profiling shows scaling up to 2000 views on a 140 GB GPU. [verified] — [map-anything](https://github.com/facebookresearch/map-anything)

**License table (verified unless noted):**

| Model | Code | Weights | Commercial? | Source |
|---|---|---|---|---|
| LightGlue / SuperPoint | Apache-2.0 (LightGlue); SuperPoint original weights have a restrictive Magic Leap license [prior knowledge] | — | LightGlue yes; for SuperPoint use DISK/ALIKED or re-trained SuperPoint [prior knowledge] | [cvg/LightGlue](https://github.com/cvg/LightGlue) |
| RoMa v2 | MIT | DINOv3 custom license | Check DINOv3 terms | [romav2](https://github.com/Parskatt/romav2) |
| MASt3R (and DUSt3R) | CC BY-NC-SA 4.0 | same + dataset restrictions (MapFree) | **No** | [naver/mast3r](https://github.com/naver/mast3r) |
| VGGT | VGGT License (commercial OK since Jul 2025) | VGGT-1B: CC BY-NC 4.0; VGGT-1B-Commercial: gated commercial | Only the Commercial checkpoint | [vggt](https://github.com/facebookresearch/vggt) |
| π3 | BSD-2 (academic); commercial: contact authors | reported CC-BY-NC-4.0 | **No** (without agreement) | [HF Pi3](https://huggingface.co/yyfz233/Pi3) |
| MapAnything | Apache-2.0 | `map-anything`: CC-BY-NC 4.0; `map-anything-apache`: Apache-2.0 | Yes with apache checkpoint | [map-anything](https://github.com/facebookresearch/map-anything) |
| Depth Anything 3 | Apache-2.0 | Small, Base, Metric-Large, Mono-Large: Apache-2.0; Large, Giant, Nested: CC BY-NC 4.0 | Small/Base/Metric/Mono yes | [DA3](https://github.com/ByteDance-Seed/Depth-Anything-3) |
| GeoCalib | Apache-2.0 | CC BY 4.0 | Yes | [GeoCalib](https://github.com/cvg/GeoCalib) |
| Depth Pro | Apple custom LICENSE (code + weights) | Apple custom | Unclear; a GitHub issue asks for clarification on commercial terms (not fetched) | [LICENSE](https://github.com/apple/ml-depth-pro/blob/main/LICENSE) |
| MoGe / MoGe-2 / MoGe-3 | not verified this session | not verified | [prior knowledge: MoGe code MIT; check weights per release] | [microsoft/MoGe](https://github.com/microsoft/moge) |

### Inferences
- **Suggested split**:
  - **Browser**: WebGL/WebGPU DEM rendering (depth/XYZ buffers), SuperPoint- or DISK+LightGlue via ORT-Web (use WASM or validate WebGPU outputs), PnP+RANSAC in JS/WASM (e.g. PoseLib compiled to WASM or a custom P4Pf), and skyline edge refinement.
  - **Server (Python, GPU)**: RoMa v2 dense matching for hard cases, GeoCalib, MoGe-2/3 or DA3 depth/sky, and optionally MapAnything-apache for geometry-conditioned matching.
- For a commercial app, the safest high-quality stack is RoMa v2 (MIT, subject to DINOv3 terms), GeoCalib, DA3-Base/Metric (Apache), MapAnything-apache and LightGlue with a permissively licensed extractor. Avoid MASt3R/DUSt3R.

### Gaps
- No verified in-browser demos of RoMa, MASt3R or VGGT via transformers.js/ORT-Web were found. They are probably infeasible given ViT-L/1B-parameter sizes, but this is unverified.
- MoGe-2/3, UniDepthV2, Metric3D v2 and Marigold licenses, and Depth Pro commercial terms, were not verified in this session.
- No latency/VRAM figures for RoMa v2 at typical resolutions were retrieved.
