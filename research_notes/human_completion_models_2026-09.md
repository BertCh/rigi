# People in Step Inside: single-image human completion (2026-09-29)

**Problem.** Step Inside turns people into 2.5D front shells: no back, and smeared hair and edges (see `reports/step-inside-results.md`). The classic drape already masks 98% of person pixels. The gap is Step Inside itself: people look like cardboard as soon as the camera moves off the photo eye.

**Goal.** Give each person (1–3 per photo, often occluded, cropped or small) a full 3D body. It should be textured from the photo, have a plausible back, and stand at metric scale on the DEM ground.

**Method.** I checked licences, dates and sizes against primary sources today:
- GitHub API repo metadata, plus LICENSE and README text from shallow code clones
- Hugging Face API `?blobs=true` for weight sizes, licence tags and gating
- HTTP HEAD on direct checkpoint URLs
- the licence pages at MPI, Naver and Meta

I downloaded no weights and ran nothing. The scratch clones are in the session scratchpad, not the repo. Anything I could not confirm is marked **UNVERIFIED**.

---

## 0. Bottom line

1. **Use SAM 3D Body (3DB) with the MHR body model as the body source.** Its licence is commercial-safe (the SAM License, see the table in section 1). It is the strongest single-image human mesh recovery (HMR) model on occlusion and truncation. It accepts **our own intrinsics (`cam_int`)**, **our bounding boxes** and **our person masks** as prompts, and it returns camera-space vertices and translation. A community MPS port exists (backbone on MPS, MHR on CPU).
2. **Clothed, textured single-image reconstructors (LHM/LHM++, PSHuman, SiTH, IDOL, SIFU, ECON, DiGS-Avatar) are all research-only in practice.** Each one depends on SMPL-X, Sapiens (CC BY-NC), nvdiffrast (NVIDIA non-commercial) or Inria's 3DGS rasteriser (non-commercial). This holds even where the code or weights carry an Apache, MIT or CC-BY tag. All of them are CUDA-only. None of them places people in metric camera space.
3. **Ship the cheap path first:**
   - fit 3DB
   - pose the mesh at metric scale
   - projective-texture the front from the photo
   - fill the back with the colour of the same pixel ("through-projection"), with special handling for the head
   - convert to splats
   - LaMa-fill the background behind the person

   Everything in this chain is commercial-safe and runs on the Mac.
4. **Person height is a real near-field scale anchor.** It gives the range curve a knot at 3–40 m, where DEM calibration is weakest. Expect a log-range error of about 0.06–0.10 per standing, uncropped adult, against the curve's current residual of 0.13. Details are in section 5.

---

## 1. Body models (licence is the gate)

| Body model | Released | Licence (code / model data) | Commercial? | Notes |
|---|---|---|---|---|
| **SMPL / SMPL-H / SMPL-X** (MPI) | 2015 / 2019 | MPI "non-commercial scientific research" licence. Commercial use needs a paid licence via Meshcapade / Max-Planck-Innovation | **NO** without a paid licence | SMPL-X page: "for academic research purposes … available for commercial licensing through Meshcapade.com". Also covered by US patent US10395411B2 |
| SMPL-**Body** (MPI) | 2024 | CC BY 4.0 | Yes, for **outputs only** | A mesh, rig and pose blendshapes **without the shape space**. It lets you share SMPL-topology meshes. It does **not** let you run shape fitting |
| **MHR, Momentum Human Rig** (Meta) | GitHub Sep 2025, paper Nov 2025 (arXiv 2511.15586) | **Apache-2.0** (repo LICENSE and README "MHR is licensed under the Apache Software License 2.0") | **Yes** | 45 identity, 204 pose and 72 expression parameters. 7 levels of detail (LOD1 ≈ 18k vertices, used by 3DB). Python/Torch plus `pymomentum` (conda platforms `osx-arm64` and `linux-64`). Includes MHR↔SMPL(-X) conversion tools and a body-part segmentation tool. The copy of `mhr_model.pt` inside the 3DB Hugging Face repo falls under that repo's SAM License, which is also commercial-OK. UV layout: **UNVERIFIED** |
| **Anny** (Naver Labs Europe) | v0.1 Nov 2025; **v0.6 2026-08-06**. ECCV 2026 | **Apache-2.0** code. MakeHuman/MPFB2 assets are **CC0** | **Yes**, but avoid the optional `smplx` topology, which is non-commercial | Interpretable phenotype parameters (**age, height**, weight, muscle and so on). Covers infants to elders. Has UV texture coordinates (tutorial). README warning: "the free install may download non-commercial only assets when needed", so pin the topology |
| **SOMA-X** (NVIDIA) | Mar 2026, active | Apache-2.0 (GitHub). Hugging Face `nvidia/SOMA-X` tagged apache-2.0 | Yes (native SOMA backend). SMPL backends need your own licensed files | A unifying layer. Identity backends: SOMA, MHR, Anny, SMPL/SMPL-X (user-supplied) and others. Useful glue if we ever need to move between MHR and Anny |

**Implication:** every HMR or avatar model trained to output SMPL/SMPL-X inherits the MPI non-commercial restriction at inference time, because you need `SMPL*_NEUTRAL.pkl` to decode vertices. MHR and Anny are the only permissive full-body models with pretrained image regressors, and only 3DB (MHR) has a commercial-OK regressor.

---

## 2. Human mesh recovery (HMR): body shape, pose and camera-space placement

| Model | Released | Code licence | **Weights licence** | Body model | Commercial-safe? | Checkpoint | Inputs / robustness | Output | Apple Silicon |
|---|---|---|---|---|---|---|---|---|---|
| **SAM 3D Body (3DB)**, `facebookresearch/sam-3d-body` | **2025-11-19** (checkpoints). Paper arXiv 2602.15989 | SAM License (2025-11-19) | SAM License. Hugging Face **gated, manual approval**. Blocked in sanctioned jurisdictions | MHR | **YES.** Grants use, reproduction, distribution and modification. Restrictions: trade controls and military/ITAR end uses, attribution in publications, no reverse-engineering, Meta may amend the terms. Not OSI-open, but no non-commercial clause | DINOv3-H+ `model.ckpt` **2.11 GB** + `mhr_model.pt` 0.70 GB. ViT-H `model.ckpt` **1.69 GB** + 0.70 GB (HF API). Both are over the 1 GB no-download limit | Image plus optional **bboxes, masks, 2D keypoints and `cam_int`** (verified in `process_one_image`). Encoder input is 512×512 per person crop. Trained with a data engine targeting occlusion, truncation and "extreme scale". Mask prompts help a lot for multi-person scenes (paper Table 8). The detector (ViTDet via detectron2) and FoV estimator (MoGe-2) are **optional**: pass our own boxes and K | Per person: `pred_vertices` (≈18k verts, LOD1), `pred_cam_t` (camera-space translation, metres given K), `focal_length`, 3D/2D keypoints (70), MHR shape, scale and pose parameters. **No texture.** Paper reports no absolute-depth or stature evaluation, so metric translation is only as good as the body-size prior (see §5) | **Feasible.** Stock code hard-codes `"cuda"` (`recursive_to(batch,"cuda")`), the MHR TorchScript uses float64 (issue #93), and detectron2/pyrender are needed only for the demo and visualisation. Open PR #125 (device-agnostic, MHR on CPU) and `sprited-ai/sam-3d-body-mps` (24-line patch, backbone on MPS, MHR via `pymomentum-cpu`): **~7.5–12 s/frame on an M-series Mac vs 51 s CPU vs 0.04 s on an RTX PRO 6000** (their numbers, UNVERIFIED by me). ONNX/C++ port `AmmarkoV/SAM3DBody-cpp` (MIT) exists but its backbone ONNX is BF16 and CUDA-EP only, and it bundles YOLO11 (**AGPL**, avoid). Fast-SAM-3D-Body (MIT code, ECCV 2026) gives about 10× speed via TensorRT, CUDA only |
| **HMR 2.0 / 4DHumans** | 2023-05 | MIT | Checkpoint distributed without a separate licence (UNVERIFIED), but it **needs the SMPL neutral model** (MPI NC) | SMPL | **NO** (SMPL) | `hmr2_data.tar.gz` 2.71 GB (HEAD, re-uploaded 2026-02-07) | Crop-based. Weak-perspective camera with a fixed large focal length, so translation is not metric | SMPL mesh | Likely (pure Torch). The demo uses detectron2. UNVERIFIED |
| **Multi-HMR** (Naver) | 2024-02. **Anny checkpoint 2026-01-29/02-17** | Naver **non-commercial** | **Non-commercial**, including `multiHMR_672_L_anny` (separate "Checkpoint_License_Anny.txt", also NC) | SMPL-X or Anny | **NO** | 672_L_anny 1.53 GB; 896_L 1.29 GB; 672_S 0.13 GB (HEAD) | Whole image, multi-person in one shot, camera-space 3D positions (it predicts depth). Good at small people (896/1288 input) | Meshes in camera space | Likely (ViT + Torch). Tested only on CUDA 12.1. UNVERIFIED |
| **CameraHMR** (MPI) | 2024-12 (3DV 2025) | No LICENSE in the repo. Website licence: **MPI non-commercial** "including SMPL parameters, model checkpoints, and scripts" | NC | SMPL (+ SMPL-X/BEDLAM2 variant) | **NO** | UNVERIFIED | Perspective camera (predicts FoV), so better placement than HMR2 | SMPL mesh in camera space | detectron2 in requirements. UNVERIFIED |
| **PromptHMR** (Meshcapade) | 2025-05 (CVPR 2025) | **Meshcapade non-commercial** licence | NC. No training code | SMPL-X | **NO** | UNVERIFIED | Prompts: boxes, masks, text, interaction. Camera-space. Video variant | SMPL-X | UNVERIFIED (the pipeline pulls in detectron2, SAM2, DROID-SLAM and Metric3D) |
| GEM-X (NVIDIA) | 2026-03/04 | Apache-2.0 | NVIDIA Open Model License (commercial OK) | SOMA | Yes | `gem_soma.ckpt` 0.54 GB. The Hugging Face repo **also redistributes the 3DB checkpoint and a 3DB-backbone ONNX (3.36 GB)** | **Video** model (dynamic cameras). Single-image use is UNVERIFIED | SOMA 77-joint motion | CUDA 12.6+ per badge |

---

## 3. Clothed, textured single-image human reconstruction (the full avatar)

| Model | Released | Code licence | Weights licence | Hidden dependency licences | Commercial-safe? | Size | Input needs | Output | Metric / camera-space? | Runtime | Mac |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **LHM** (Alibaba Tongyi), ICCV 2025 | 2025-03 | Apache-2.0 | Hugging Face 500M-HF / 1B-HF tagged apache-2.0; MINI untagged | **Sapiens-1B encoder is CC BY-NC 4.0.** SMPL-X `human_model_files` (MPI NC). The rasteriser is Inria `diff-gaussian-rasterization` (**non-commercial**) | **NO** in practice | MINI 2.78 GB, 500M-HF 3.93 GB, 1B-HF 6.85 GB, all-in-one repo 46.6 GB | Full body (500M/1B) or "half & full body" (MINI, -HF variants: random-crop training). Clean, fairly large person crop; background removed with SAM2/BiRefNet | Animatable **3DGS** avatar in SMPL-X canonical space (~40k Gaussians). **Back is generated** | No. Canonical, normalised scale | 1.4–6.6 s on GPU; 14–24 GB VRAM | **No**: xformers, pytorch3d, CUDA diff-gaussian-rasterization, simple-knn |
| **LHM++ / PF-LHM** | Open-sourced 2026-03 | Apache-2.0 | Hugging Face `LHMPP-700M` has no licence tag (4.53 GB). `LHMPP-Prior` (7.67 GB) **redistributes FLAME and SMPL-X assets** | Same stack as LHM (Sapiens; SMPL-X/FLAME; pytorch3d; diff-gaussian-rasterization; gsplat) | **NO** in practice | 4.5 + 7.7 GB | 1 to N pose-free images | 160k-Gaussian avatar. `gs.ply` export in T-pose or a given SMPL-X pose. "SMPLX-FREE" variant: meaning UNVERIFIED (it still uses SMPL-X canonical space) | No | **0.79 s** (1 view) on GPU; 8 GB | No (CUDA wheels) |
| **PSHuman** (Fudan), CVPR 2025 | 2024-09; SMPL-free weights 2024-11-30 | MIT | **CC-BY-4.0** (Hugging Face `PSHuman_Unclip_768_6views`, 3.95 GB). Base: SD-2.1-unCLIP (OpenRAIL++, UNVERIFIED today) | **nvdiffrast (NVIDIA non-commercial source licence)**, kaolin, pytorch3d, torch_scatter, xformers. The SMPL-conditioned mode needs SMPL-X. The SMPL-free mode (`with_smpl=false`) avoids it | **Weights OK, pipeline NO** until nvdiffrast is replaced | 3.95 GB + SD2.1 | RGBA full-body crop | 6-view diffusion (colour + normals), then a textured **mesh** with a generated back | No | "within one minute"; **>40 GB VRAM** at 768 | No |
| **SiTH** (ETH), CVPR 2024 | 2024-04 | MIT | **CC BY-NC 4.0** (Hugging Face) | SMPL-X required; kaolin, nvdiffrast | **NO** | 6.44 GB | RGBA full body; SMPL-X fit into a [-1,1] cube | Textured mesh with a diffusion-hallucinated back | No | ~2 min on an RTX 3090 | No |
| **IDOL** (NJU et al.), CVPR 2025 | 2024-12 | MIT per README badge (**no LICENSE file in the repo**) | Hugging Face untagged, 13.78 GB | **Sapiens-1B (CC BY-NC)**, SMPL-X, Inria 3DGS rasteriser. Its HuGe100K dataset includes DeepFashion images that may not be used commercially | **NO** | 13.8 GB | Full-body crop | Animatable 3DGS (SMPL-X) | No | ~1 s on GPU (paper; UNVERIFIED) | No (CUDA 11.8) |
| **SIFU**, CVPR 2024 | 2023-12 | MIT | Needs ICON/SMPL data (MPI NC) | SMPL-X, pytorch3d, kaolin | **NO** | UNVERIFIED | Full body | Textured mesh; the texture refinement uses SD | No | Minutes; >16 GB | No |
| **ECON** (MPI), CVPR 2023 | 2022-10 | **MPI non-commercial** | Same | SMPL-X, pytorch3d | **NO** | UNVERIFIED | Full body. Multi-person supported | Clothed mesh; partial texture (TeCH adds full texture) | No | Minutes | No |
| DiGS-Avatar | 2026-06/08 (arXiv 2608.20759) | MIT | Teacher/student checkpoints; licence UNVERIFIED | SMPL-X, DINOv3 (DINOv3 licence), SANA | **NO** (SMPL-X) | UNVERIFIED | Single image | UV-space Gaussian avatar, 0.71 s | No | GPU | No |
| CrowdGaussian (CVPR 2026) | 2026-03 | **No code found** | — | Builds on a "pretrained large human model" (likely LHM, UNVERIFIED) | UNVERIFIED | — | **Single image, many people, heavy occlusion, low clarity**: the closest match to our setting | Multi-person 3DGS | UNVERIFIED | — | — |
| HumanSplat (NeurIPS 2024), HumanRAM, AniGS, MoGA, HumanDreamer-X | 2024–25 | various | UNVERIFIED | Almost all SMPL/SMPL-X plus CUDA 3DGS | Assume **NO** | — | Full-body, centred | 3DGS | No | — | No |

**General-object alternatives for a person crop** (both are generative, and people are out of their training focus):
- **SAM 3D Objects** (Meta, SAM License, commercial-OK): gated, 13.2 GB, **Linux + NVIDIA ≥32 GB only** (pytorch3d, kaolin). It reconstructs any masked object, people included, with texture and **layout** (pose/scale in the scene). Meta ships a notebook that aligns 3DB and 3DO outputs in one frame. Best-quality commercial-safe option **if we rent a GPU**, but the shape is not articulated.
- **TripoSplat** (MIT, 4.46 GB): see `step_inside_models_2026-09.md`. MPS is UNVERIFIED.
- **TRELLIS.2** (MIT): Linux + NVIDIA ≥24 GB, flash-attn, cumesh, flexgemm, **nvdiffrast**.

**Summary of section 3:** no textured-avatar model is both commercial-safe and Mac-local today. The blockers are almost never the headline licence. They are **SMPL-X, Sapiens and the NC rasterisers (nvdiffrast, Inria diff-gaussian-rasterization)**. gsplat (Apache) is the permissive rasteriser replacement, but it is also CUDA-only.

---

## 4. The cheap fallback: 3DB body, then a textured, completed person splat (commercial-safe, Mac-local)

Pipeline per person. Items marked (have) already exist in the repo or service; the rest are new.

1. **Detect and segment.** Use the engine's `peopleMask` (have), split into instances. Candidates: SAM 2 (Apache) or the existing segmenter. If SAM 3 is used, it falls under the SAM License, which is fine. Do **not** use YOLO11/Ultralytics (AGPL).
2. **Fit.** Run 3DB with `bboxes`, `masks` and `cam_int = K_photo` from the solved pose. We know K better than MoGe's FoV guess, so skip 3DB's FoV estimator. Runs as a new `/body` service endpoint using the MPS port (MHR on CPU through `pymomentum-cpu`). Expect roughly 8–12 s per person (UNVERIFIED), cached.
3. **Place at metric scale.** `pred_cam_t` is metric *given 3DB's body-size prior*. Then:
   - Reconcile it with the anchored depth and DEM ground contact (see §5).
   - Snap the lowest foot vertices to the near-DEM ground, the same way `grounding` already rescales objects.
   - Rescale about the camera centre, which preserves the 2D projection exactly.
4. **Texture the front.** Project each vertex into the photo. A vertex is visible when it passes a z-buffer test against the other bodies and it lies inside the person mask. Visible vertices take the photo colour directly. Erode the mask by 1–2 px to drop background halo, which fixes the "smeared hair edge" from the depth lift.
5. **Complete the back (through-projection).** A back-facing vertex that projects inside the silhouette takes the colour at *the same pixel*: the front surface along that ray. This is the standard PIFu/ECON back-texture trick. It is right for jackets, trousers and backpacks-as-colour, and wrong for faces. Handle these parts separately:
   - **Head/face:** use MHR part segmentation (`tools/mhr_create_segmentation`). Back-of-head vertices get the median colour of the top-of-head and hair pixels, not the face.
   - **Hands and arms occluded by the torso:** take the nearest visible same-part colour.
   - **Truncated or occluded parts** (outside the frame or behind a rock): tint them a neutral average of that part's visible colours, and flag them.
   - Optional: bake the colours into Anny's UV layout (Anny ships UVs; MHR UV is UNVERIFIED) and LaMa-inpaint the UV holes. LaMa is already in the service. The through-projection alone is probably enough at ≤ 300 px person height.
6. **Convert to splats.** Sample about 20–60k surface points (area-weighted). Make each a flat Gaussian: normal-aligned, with scales set from local edge length. That keeps it inside the existing GaussianCloud, renderers and export contract. Tag everything that did not come from a directly visible photo pixel as `generated`. It then stays out of exports and the hover readout under the existing rule.
7. **Background behind the person.** Mask the person out of the depth-lift, then LaMa-fill the RGB and extend the DEM-anchored depth into the hole (have: `/inpaint` and the generation path). Moving the viewpoint then shows terrain, not a person-shaped hole.
8. **Gating.** Do not complete a person when any of these holds:
   - the 3DB keypoint confidence is low
   - the mask-to-mesh silhouette IoU is under about 0.6
   - the person is under about 60 px tall

   In those cases keep today's shell with an edge-alpha feather. Add a "3D person" provenance class to the Truth view.

**Why not mirror left-right?** A sagittal mirror copies the front onto the front: the photo *is* the front. The back needs front-to-back transfer along the view ray, which is what step 5 does.

**Small people (~150 px tall).** 3DB crops to 512 px, so it upsamples about 3.4×. Pose and shape are still usable (it was trained for "extreme scale"; exact accuracy is UNVERIFIED). Texture then has about 50 px of body width, which is fine for splats seen from within ±30° of the photo view. At that size the clothed-avatar models would add nothing visible anyway.

**Where to run it.** 3DB inference is in Python. Steps 3–7 can live in the service (numpy z-buffer) or in TypeScript. A projective-texture shader in three/deck would even let the front stay photo-exact at any resolution.

---

## 5. Person height as a near-field scale anchor for the range curve

**The problem it solves.** The per-photo log-log curve (`anchor.ts: curveRange`) is calibrated on DEM terrain from 15 m to 3 km. Below the nearest knot it falls back to MoGe-2 "at face value" (`CURVE_METRIC_NEAR = 15 m`). That fallback is exactly where hikers stand, at 3–40 m. The DEM there is coarse (z16) and often hidden under the person. A standing adult is a ruler of known length in the one depth band the DEM can't calibrate.

**Two estimators per person.**

1. **Pinhole, no HMR.** Let *h* be the vertical pixel extent from the top of the head to the soles (from the mask), *f* the focal length in pixels (from our pose), and *H* the stature. For an upright, uncropped, standing person, `d ≈ f · H · cos(θ) / h`, where θ is the ray's elevation off the image vertical and needs a small tilt correction. Use the prior H = 1.70 m ± 0.10 (adult, sex-mixed; European hikers skew about 1.72). That gives σ_log(H) ≈ 0.06. Pixel error adds about 2/h (≈0.013 at 150 px).
2. **3DB.** Use `‖pred_cam_t‖` with our K. It already accounts for pose, including bent knees, leaning and the camera-tilt foreshortening. Its stature is effectively a regressed-to-the-mean prior (arXiv 2601.06035 finds 3DB "regression to the mean" on body shape). Treat it as the same prior with a better pose model. Optional: renormalise the MHR scale so the T-pose stature = 1.70 m, making the prior explicit.

**Turning it into a curve knot.**
- Take the model ray from the MoGe depth: the median over an eroded person mask, or the MoGe depth at the foot-contact pixels.
- Add the knot `(log m_person, log d_person)` to the anchor fit with weight 1/σ². Use σ_log ≈ 0.07 for a clean, standing, full-body adult and inflate it otherwise. The knot then limits the extrapolation below 15 m instead of the face-value fallback.
- With several people, take a robust (Huber) combination. People disagreeing by more than 0.25 log means a child, a seated person or a bad mask: downweight the outlier.

**Cross-check with the ground.**
- The DEM or near-DEM range at the foot pixel gives a third, independent distance.
- If the person anchor and the DEM agree within about 0.1 log, raise the trust label.
- If the DEM puts the feet much farther away than height does, the person is probably on a nearer ledge the DEM doesn't resolve (a cliff lip: this is the IMG_7059 failure). Trust the person for their own placement and don't bend the terrain curve.

**Rejection rules** (the knot is unsafe when any holds):
- the bbox touches a frame edge (cropped)
- the feet are occluded (the mask's lower boundary doesn't meet ground or sky)
- the person is seated, crouched or lying: 3DB pelvis height under about 0.6 × leg length, or bbox aspect h/w under about 1.8 when not using 3DB
- the person is under about 60 px
- 3DB estimates a child: Anny/MHR age or stature regressions below adult, or keypoint bone-ratio heuristics
- the person is a reflection or a poster

**Expected value.** At 20 m MoGe's DEM/model ratio is about 1 (spike data), so the knot will usually *confirm* near scale rather than move it. Its main value is:
- consistent person size, since a 1.7 m person no longer renders as 1.2 m or 2.5 m
- a stable foot-to-ground contact for grounding
- a trust signal where the DEM is silent

Measure it before adopting it. On photos that have people plus a GT-posed DEM, compare the foot-point range from (a) the curve alone and (b) the curve plus person knots against the DEM foot range. Pre-register the rule, as usual.

---

## 6. Ranked recommendation

### Commercial-safe

| Rank | What | Where it runs | Why |
|---|---|---|---|
| 1 | **3DB (ViT-H or DINOv3) + MHR → metric placement → through-projection texture → splats (§4) + person-height knot (§5)** | **Mac-local** through the MPS port (MHR on CPU). About 10 s per person, UNVERIFIED | Only commercial-OK single-image HMR. Accepts our K, boxes and masks. Occlusion- and truncation-robust. Output is honest: a visible front, with the back flagged as generated. Download needs a gated HF request, and the checkpoint is over 1 GB, so the user must approve and download it |
| 2 | Same, but with **Anny** as the output mesh (convert MHR→Anny via SOMA-X, or fit Anny to 3DB keypoints) | Mac-local (pure Torch) | Apache/CC0 end to end, with UVs, an explicit **height/age** parameter for the §5 prior, and child handling. Costs extra fitting work |
| 3 | **SAM 3D Objects** on the person mask, aligned with 3DB (Meta notebook) | **CUDA only** (Linux, ≥32 GB, rented) | Generated textured shape with a plausible back, commercial-OK. Not articulated. Heavy (13 GB) |
| 4 | PSHuman SMPL-free weights (CC-BY-4.0) **with nvdiffrast replaced** (e.g. by a pytorch3d/gsplat-free rasteriser) | CUDA only, >40 GB | The best textured-back quality among the weights that are nominally commercial-OK. Needs a porting job and a legal read of SD-2.1-unCLIP OpenRAIL++ |

### Research-only (dev flag, as with SHARP)

| Rank | What | Where | Notes |
|---|---|---|---|
| 1 | **LHM++ (700M)** / LHM-MINI | CUDA (8–16 GB) | Best speed and quality for a full Gaussian avatar with a generated back. Output is in canonical space: re-pose it with the 3DB→SMPL-X conversion and place it with §5. Sapiens, SMPL-X and the Inria rasteriser make it NC |
| 2 | PSHuman (as is) | CUDA, >40 GB | Textured mesh with a detailed back |
| 3 | Multi-HMR-Anny / CameraHMR / PromptHMR | CUDA; Multi-HMR is probably MPS-able | Multi-HMR is the best one-shot multi-person model for small people in camera space; the others give better perspective placement. None beats 3DB enough to justify NC |
| 4 | SiTH, IDOL, SIFU, ECON, DiGS-Avatar | CUDA | Older, slower or tightly SMPL-X-bound. Don't bother |

**Suggested order:**
1. Build a `/body` endpoint with 3DB on MPS, after the user approves the gated download (about 1.7–2.1 GB + 0.7 GB).
2. Build the §4 person splats in dev.
3. Run the §5 knot as a pre-registered measurement.
4. Only then consider an LHM++ research flag on a rented GPU.

---

## Sources (checked 2026-09-29)

- SAM 3D Body: https://github.com/facebookresearch/sam-3d-body (README, INSTALL.md, LICENSE "SAM License, Last Updated: November 19, 2025", `sam_3d_body_estimator.py`). HF API `facebook/sam-3d-body-dinov3`, `facebook/sam-3d-body-vith`. Paper https://arxiv.org/abs/2602.15989
- MPS port: https://github.com/sprited-ai/sam-3d-body-mps; upstream PR https://github.com/facebookresearch/sam-3d-body/pull/125; issue #93
- C++/ONNX port: https://github.com/AmmarkoV/SAM3DBody-cpp. Fast 3DB: https://github.com/yangtiming/Fast-SAM-3D-Body
- 3DB anthropometric study: https://arxiv.org/abs/2601.06035
- MHR: https://github.com/facebookresearch/MHR (LICENSE Apache-2.0, pyproject platforms), https://arxiv.org/abs/2511.15586
- Anny: https://github.com/naver/anny (README licence section, news), https://arxiv.org/abs/2511.03589
- SOMA-X: https://github.com/NVlabs/SOMA-X, https://huggingface.co/nvidia/SOMA-X. GEM-X: https://github.com/NVlabs/GEM-X, HF `nvidia/GEM-X`
- SMPL-X licence: https://smpl-x.is.tue.mpg.de/modellicense.html. SMPL-Body CC-BY: https://smpl.is.tue.mpg.de/bodylicense.html
- 4DHumans: https://github.com/shubham-goel/4D-Humans; HEAD https://www.cs.utexas.edu/~pavlakos/4dhumans/hmr2_data.tar.gz
- Multi-HMR: https://github.com/naver/multi-hmr (LICENSE.txt), https://download.europe.naverlabs.com/ComputerVision/MultiHMR/Checkpoint_License_Anny.txt
- CameraHMR: https://github.com/pixelite1201/CameraHMR, https://camerahmr.is.tue.mpg.de/license.html
- PromptHMR: https://github.com/yufu-wang/PromptHMR (LICENSE)
- LHM: https://github.com/aigc3d/LHM (modelcard.md, INSTALL.md), HF `3DAIGC/LHM-*`. LHM++: https://github.com/aigc3d/LHM-plusplus, HF `3DAIGC/LHMPP-700M`, `3DAIGC/LHMPP-Prior`
- Sapiens licence (CC BY-NC 4.0): https://github.com/facebookresearch/sapiens/blob/main/LICENSE
- nvdiffrast licence: https://github.com/NVlabs/nvdiffrast/blob/main/LICENSE.txt. Inria 3DGS: https://github.com/graphdeco-inria/gaussian-splatting/blob/main/LICENSE.md
- PSHuman: https://github.com/pengHTYX/PSHuman, HF `pengHTYX/PSHuman_Unclip_768_6views` (cc-by-4.0)
- SiTH: https://github.com/SiTH-Diffusion/SiTH, HF `hohs/SiTH-diffusion-2000` (cc-by-nc-4.0)
- IDOL: https://github.com/yiyuzhuang/IDOL, HF `yiyuzhuang/IDOL`
- SIFU: https://github.com/River-Zhang/SIFU. ECON: https://github.com/YuliangXiu/ECON
- DiGS-Avatar: https://github.com/KLMAV-CUC/DiGS-Avatar, https://arxiv.org/html/2608.20759v1
- CrowdGaussian: https://arxiv.org/abs/2603.17779
- SAM 3D Objects: https://github.com/facebookresearch/sam-3d-objects (doc/setup.md: Linux, ≥32 GB NVIDIA). TRELLIS.2: https://github.com/microsoft/TRELLIS.2
