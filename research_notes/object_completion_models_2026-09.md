# Object completion: turning 2.5D front shells into full 3D objects (2026-09-29)

**What this is for.** Step Inside lifts near-field pixels with MoGe-2. That gives each object (person, hut, tree, car, pole) only its camera-facing surface. This note looks for a model that takes the **photo, an instance mask and our visible depth points** and returns a **complete 3D object**. We would then align that object to the visible shell and ground it on the DEM.

**What it builds on.** This complements `step_inside_models_2026-09.md`, and nothing already covered there is repeated here except TripoSplat. Licences and sizes were checked against the GitHub API, the HF API (`?blobs=true`: licence tag, gating, total file size) and raw LICENSE files. I re-checked the key facts myself on 2026-09-29:
- SAM 3D Objects: HF gated `manual`, licence tag `other` (SAM License), 13.17 GB.
- Cupid: MIT, 7.27 GB.
- TripoSplat: MIT, 4.46 GB.
- TripoSR: MIT, 1.68 GB.
- The SAM License text has no non-commercial clause; its only limits are trade control, ITAR and military use.

Anything I could not check is marked **UNVERIFIED**. No weights were downloaded and no inference was run.

Legend: **C-safe** means the weights and required dependencies allow commercial use in the EU. **Red flags** are CUDA-only kernels with no Mac path: spconv, flash-attn, nvdiffrast, kaolin, pytorch3d-CUDA, diff-gaussian-rasterization, custom rasterisers.

---

## 1. Object-level models (single image, with or without a mask, to a complete 3D object)

### 1a. Licence, size, commercial status

| Model | Released | Code lic. | **Weights lic.** (HF) | Gated | Ckpt size | C-safe? |
|---|---|---|---|---|---|---|
| **SAM 3D Objects** (Meta) | repo 2025-09-29; weights and paper 2025-11-19; encoder weights and Artist Object Set 2026-06 | SAM License (2025-11-19) | SAM License | manual approval | **13.17 GB** (ss_generator 6.69, slat_generator 4.91, plus decoders) | **Yes.** Royalty-free, derivatives allowed, patent grant; excludes ITAR, military, nuclear and espionage use. Default pointmap model MoGe is MIT |
| SAM 3D Body (Meta) | 2025-11 | SAM License | SAM License; MHR rig is Apache-2.0 | manual | 2.81 GB | Yes (same terms) |
| **Cupid** (pose-grounded generation, arXiv 2510.20776) | code 2025-10-27; weights 2026-02-10 | MIT | MIT | no | 7.27 GB | Code and weights yes. It inherits TRELLIS's CUDA stack (nvdiffrast is research-only, see TRELLIS) |
| TRELLIS (image-large) | 2024-12-02 | MIT | MIT | no | 3.30 GB | Weights yes. **Dependencies are not:** nvdiffrast (NVIDIA licence, "research or evaluation purposes only") and diff-gaussian-rasterization / mip-splatting (Inria non-commercial, UNVERIFIED). You'd need your own renderer and decoder path |
| TRELLIS.2-4B | 2025-11-26 | MIT | MIT (pulls DINOv3 ViT-L under the DINOv3 License, commercial OK; **RMBG-2.0 is CC BY-NC**) | no (DINOv3 manual) | **16.24 GB** | Conditional. Supply your own alpha to skip RMBG, and replace nvdiffrast. cumesh, o-voxel and flexgemm licences UNVERIFIED |
| **TripoSplat** (VAST) | HF 2026-05-31, repo 2026-06-01 | MIT | MIT | no | 4.46 GB | Yes. The bundled DINOv3-H is under the DINOv3 License (commercial OK). The flux2-vae is presumed to be BFL's Apache-2.0 FLUX.2 VAE, but the file hash was not checked (UNVERIFIED). BiRefNet is MIT |
| TripoSR | 2024-02 | MIT | MIT | no | 1.68 GB | **Yes** |
| Stable Fast 3D (SF3D) | 2024-07 | Stability Community | Stability AI Community | yes (click) | 4.03 GB | Only below US$1M annual revenue; above that you need an enterprise licence |
| SPAR3D | 2025-01 | Stability Community | Stability AI Community | yes | 7.33 GB | Same as SF3D |
| Hunyuan3D-2.0 / 2mini / 2mv | 2025-01 / 2025-03 | Tencent Hunyuan 3D 2.0 Community | same | no | 74.9 GB repo (one DiT 4.93 GB; mini DiT 3.82 GB) | **No for Rigi.** Verbatim: Territory is "excluding the territory of the European Union, United Kingdom and South Korea". Also a >1M MAU clause |
| Hunyuan3D-2.1 | 2025-06-13 | Tencent Hunyuan 3D **2.1** Community (a separate licence text, same territory exclusion) | same | no | 14.9 GB (DiT 7.37 GB) | **No** (EU excluded) |
| Hunyuan3D-Omni | 2025-09-25 | Tencent community | same | no | 25.7 GB | **No** (EU excluded) |
| Hunyuan3D 2.5 / 3.0 / 3.1 | 2025–26 | — | **No open weights** (API or product only; no HF repo exists) | — | — | n/a (3.1 assumed API-only, UNVERIFIED) |
| InstantMesh | 2024-04 | Apache-2.0 | Apache-2.0 (Zero123++ v1.2 weights carry no licence tag, UNVERIFIED) | no | 7.27 GB | **No in practice:** nvdiffrast is required and is research-only |
| **Amodal3R** (occlusion-aware, TRELLIS-based) | 2025-03 | **S-Lab License 1.0 (non-commercial)** | HF says CC-BY-4.0, which conflicts with the code licence | no | 5.95 GB | **No** |
| Apple **LiTo** (ICLR 2026) | 2026 | Apple sample-code licence | **Apple ML Research Model licence (research only)**. The LICENSE_MODEL file reads "for the purposes of scientific research" | — | UNVERIFIED | **No** |
| TripoSG / TripoSF | 2025-03 | MIT | MIT | no | 7.95 GB / 0.9 GB (TripoSF is a VAE) | Yes (shape only; CUDA stack) |
| Step1X-3D | 2025-05 | Apache-2.0 | Apache-2.0 | no | 19.6 GB | Yes (CUDA) |
| Direct3D-S2 | 2025-05 | MIT | MIT | no | 8.5 GB | Yes (CUDA sparse attention) |
| Hi3DGen | 2025-03 | MIT | MIT | no | 2.65 GB | Yes (TRELLIS stack) |
| UniLat3D | 2025-09 | Apache-2.0 | MIT | no | 7.17 GB | Yes (CUDA) |
| **Pixal3D** (SIGGRAPH 2026, TencentARC) | code 2026-05; multi-view 2026-09 | MIT | MIT | no | 46 GB repo | Yes, but it needs the TRELLIS.2 environment plus NATTEN |
| PartCrafter | 2025-06 | MIT | MIT | no | 3.97 GB | Yes (parts, CUDA) |
| Seed3D 1.0 (ByteDance) | 2025-10 | — | **API only** | — | — | n/a |

I found no public repositories for TRELLIS 3, LATTICE, Ultra3D or GaussianAnything; treat them as not open (UNVERIFIED). Sparc3D and DSO have no licence file, so they are unusable.

### 1b. Inputs, outputs, pose, compute, Mac

| Model | Mask input? | Occluded objects? | Small crops (100–300 px) | Output | **Pose frame** | Runtime / VRAM | Apple Silicon |
|---|---|---|---|---|---|---|---|
| **SAM 3D Objects** | **Yes:** image plus binary mask (packed as alpha) | **Yes.** Trained with occlusion and clutter; the README claims it handles "small objects and occlusions" | Claimed robust (UNVERIFIED on our 100 px crops) | 3DGS `.ply` and/or GLB mesh (vertex colour, optional texture bake) | **Camera frame:** layout head gives a rotation quaternion (6D internally), translation and scale. Also **accepts our own pointmap:** `inference(image, mask, pointmap=HxWx3)` skips MoGe and infers intrinsics from it. The pointmap must be in PyTorch3D camera convention (code reading). Optional render-and-compare pose refinement | "A few seconds" (4-step distilled; Meta blog). **Needs ≥32 GB NVIDIA VRAM**, Linux, CUDA 12.1 | Official: **no** (spconv, flash-attn, xformers, kaolin, pytorch3d, gsplat). Community ports: **appautomaton/mlx-spatial** (MIT, pushed 2026-09-13, 11★; marks SAM3D "Stable"; outputs Gaussian PLY; no timings). **ZimengXiong/Sam3D-Objects-MLX** (no licence file, Dec 2025, mesh only, "fits within 48 GB"). Both UNVERIFIED |
| SAM 3D Body | optional mask or keypoints | yes | — | MHR full-body rigged mesh (with hands) | camera frame; an official notebook aligns it with SAM 3D Objects in one frame | UNVERIFIED | CUDA (UNVERIFIED MPS) |
| **Cupid** | yes, per-object masks in its scene demo | **No:** README says "Currently, we only support non-occluded assets" | resizes to 512 | 3DGS plus mesh, plus **camera extrinsics and intrinsics** (`metadata.json`) from PnP on generated pixel-to-3D correspondences. Scenes are assembled by Umeyama to MoGe points | camera-aligned; metric scale UNVERIFIED | ≥16 GB NVIDIA, "seconds" | No (flash-attn, spconv, kaolin, nvdiffrast, pytorch3d, `.cuda()` calls) |
| TRELLIS | via RGBA alpha (rembg otherwise) | no (canonical, needs a clean object) | resizes to 518 | 3DGS, radiance field, GLB | **canonical** | ≥16 GB | Port: vinayapathak/trellis-mac-mps (MIT), UNVERIFIED |
| TRELLIS.2 | via RGBA alpha | no | 512+ | PBR GLB (no splats) | canonical | ≥24 GB; H100 ~3 s at 512³ | Ports: shivampkumar/trellis-mac (MIT, 488★) reports **~5 min 13 s on an M4 Pro 24 GB** at 512³; gtrg55/trellis2-mlx; mlx-spatial; upstream PR #175 (unmerged) |
| **TripoSplat** | **RGBA alpha skips BiRefNet** (the alpha acts as the mask; eroded 1 px, cropped with 1.2× padding, composited on black) | not trained for occlusion | crop is upsampled | 3DGS only, 32k–262k Gaussians (`.ply`/`.splat`) | **canonical**; the crop throws away image position | 20 flow steps; timing UNVERIFIED | Pure torch SDPA, no custom kernels (default `device='cuda'`). ai3d-dev/TripoSplatMacApp (MIT, 0★) runs it on MPS on an M3 Max with 16 GB recommended. **Most Mac-friendly of the modern models** (speed UNVERIFIED) |
| TripoSR | foreground via rembg / RGBA | no | 512 internal | vertex-colour mesh (marching cubes), optional baked texture | canonical, not metric | <0.5 s on A100, ~6 GB | Likely works: pure PyTorch, torchmcubes builds CPU-only, `--device` flag. MPS speed UNVERIFIED |
| SF3D | RGBA | no | 512 | **UV-textured PBR GLB** | canonical | ~6 GB, ~0.5 s (UNVERIFIED) | **Official experimental MPS** (Metal texture-baker kernels, `PYTORCH_ENABLE_MPS_FALLBACK=1`, tested on an M1 Max 64 GB; README suggests CPU below 32 GB) |
| SPAR3D | RGBA | no | 512 | PBR mesh through an **intermediate point cloud** that can be edited | canonical | 10.5 GB (7 GB low-VRAM mode) | Official experimental MPS (macOS 15.2+, M4 Max 36 GB). Swapping our visible points into the point-cloud stage is possible in principle, but they must be in its normalised canonical frame (UNVERIFIED) |
| Hunyuan3D-2 / mini | RGBA | no | — | shape, plus optional paint stage | canonical | shape 6 GB; shape + texture 16 GB | README says "supports macOS" for shape; texture needs CUDA `custom_rasterizer`. **Licence excludes the EU anyway** |
| InstantMesh | RGBA → Zero123++ 6 views | no | — | FlexiCubes mesh | canonical | — | nvdiffrast: no |
| **Amodal3R** | **image plus 3-level mask** (visible / occluder / background) | **Yes, built for it**; reports it beats 2D-amodal-then-3D pipelines | 518 | TRELLIS 3DGS / mesh | canonical | CUDA 11.8 | No (full TRELLIS stack) |
| Apple LiTo | RGBA | no | — | 3DGS | canonical | torch.compile on CUDA | **Official MLX path on macOS** (README); also LiToStudio (MLX-Swift). Research-only licence |
| Pixal3D | masked image, back-projection-conditioned (pixel-aligned) | no | — | mesh / PBR | pixel-aligned (closer to camera-aligned) | — | No (TRELLIS.2 + NATTEN); mlx-spatial lists it "in development" |

Sources are listed at the bottom.

---

## 2. Compositional scene methods (image plus instance masks to a posed multi-object scene)

| Method | Date | Code / weights licence | Size | What it gives | Fit for Rigi |
|---|---|---|---|---|---|
| **SAM 3D Objects** (per-object calls share one pointmap) | 2025-11 | SAM License | 13.2 GB | each object posed in the camera frame against a shared pointmap | **Best fit.** Our DEM-calibrated pointmap puts every object in one metric frame |
| **Cupid** | 2025-10 | MIT / MIT | 7.3 GB | per-object PnP pose, then Umeyama to MoGe points | good pose recipe; no occlusion; CUDA |
| MIDI-3D (VAST, CVPR'25) | 2025-03 | Apache-2.0 / Apache-2.0 | 5.1 GB | multi-instance meshes in a shared layout | ~30 GB VRAM, **indoor-only training (3D-Front)** |
| SceneGen (3DV 2026) | 2025-08 | MIT / MIT | 4.7 GB (plus SAM2, VGGT-1B, TRELLIS) | assets plus relative poses in one pass | ≥16 GB CUDA; indoor; VGGT-1B weights are NC |
| DepR (ICCV'25) | 2025 | **CC-BY-SA-4.0** | 2.7 GB | depth-guided instance diffusion plus layout optimisation | 3D-FRONT only; share-alike |
| Gen3DSR | 2024 | CC-BY-4.0 (uses third-party models) | — | per-object meshes composed in the camera frame, with amodal completion | ≥20 GB, Docker |
| CAST (SIGGRAPH'25) | 2025 | **no official code** (an unofficial MIT re-implementation calls paid APIs) | — | occlusion-aware generation plus physics-corrected layout | not usable |
| REPARO (ICCV'25) | — | MIT | uses TripoSR / DreamGaussian | layout by differentiable rendering (nvdiffrast) with an OT loss | idea reusable; CUDA |
| Diorama | 2024 | MIT | third-party | retrieves CAD models, doesn't generate | no |
| SceneComplete | 2024/25 | no licence; uses FoundationPose (NC) | — | RGB-D scene completion | no |
| SceneReGen (arXiv 2608.23930), SimuScene (2606.03994) | 2026 | **no code** | — | camera-aligned layout; gravity-simulated correction | watch list |

**Takeaway.** Everything except SAM 3D was trained on indoor furniture (3D-Front / 3D-FUTURE) or needs a large CUDA stack. For outdoor people, huts, trees and cars, calling SAM 3D Objects once per object with a shared pointmap is the only practical "scene" method.

---

## 3. 2D amodal completion as a preprocessing step

| Method | Licence | Size | Notes |
|---|---|---|---|
| pix2gestalt | **CC-BY-NC-4.0** (code and weights) | 15.5 GB | research only; SD-based, MPS plausible but UNVERIFIED |
| Progressive Mixed Context Diffusion (CVPR'24, k8xu/amodal) | **no licence file** | training-free on SD inpainting | reimplement the idea; the code can't be used as-is |
| OWAAC (CVPR'25) | Apache-2.0 | heavy: LISA-13B, Grounded-SAM, SD2-inpaint | too heavy |
| Amodal Depth Anything (ICCV'25) | MIT code; weights licence UNVERIFIED | — | predicts **amodal depth** of hidden parts, a useful back-thickness prior; its install pulls in pix2gestalt |
| LaMa (big-lama) | Apache-2.0 | 0.38 GB | already in our service (`/inpaint`). Good for backgrounds; poor at completing object *shape* |
| Qwen-Image-Edit (2509/2511) | **Apache-2.0** weights | 57.7 GB repo (~20B) | commercial-safe instruction editor ("complete the occluded hut"). Needs 64 GB+ on a Mac or quantisation (UNVERIFIED) |
| FLUX.1 Fill / Kontext [dev] | FLUX.1-dev **Non-Commercial** | ~58 GB | research only |
| SDXL-inpainting-0.1 | OpenRAIL++ | 20.8 GB repo | commercial OK with use restrictions |

**Verdict.** Amodal3R's paper reports that end-to-end occlusion-aware 3D generation beats 2D-amodal-then-3D. SAM 3D was also trained with occlusion. So 2D amodal completion is only needed in front of **canonical, non-occlusion-aware** models (TripoSplat, SF3D, TripoSR), and only for objects that touch an occluder or the frame edge. Commercial-safe options are a Qwen-Image-Edit sidecar (heavy) or LaMa with a mask dilated into the occluded region (weak).

---

## 4. Aligning a generated object to our visible shell, then grounding it on the DEM

What we already have for each object:
- Photo crop and instance mask.
- The solved camera K, R, t.
- Visible points P_vis. These are MoGe points passed through the per-photo log-log DEM range curve and object grounding, so they are **metric in ENU**.

### 4.1 Pose-grounded route (SAM 3D Objects)

1. Build the full-frame pointmap from our DEM-calibrated depth: back-project the calibrated depth with the solved K. Convert it to **PyTorch3D camera convention** (x left, y up, z forward, so flip x and y from OpenCV). Pass it through `pointmap=`. Without this, SAM 3D uses raw MoGe, and its scale then has the range compression we measured (×2.9 at 100–300 m).
2. SAM 3D returns the object in the camera frame plus its layout (quaternion, translation, scale). Transform to ENU with the known camera pose.
3. **Check, don't trust.** Render the posed object's depth from the photo camera and compute:
   - mask IoU against the instance mask;
   - median |depth − P_vis depth| over pixels in both;
   - the up-axis angle against world up.

   If IoU < ~0.6, or the depth residual exceeds ~10% of range, fall back to §4.2 initialised from SAM 3D's pose. These thresholds are my suggestion, uncalibrated.

### 4.2 Canonical route (TripoSplat, SF3D, TripoSR, TRELLIS)

1. **Upright prior.** Most generators output Y-up canonical objects. Lock that axis to ENU up (DEM gravity), which leaves 4 DoF: yaw, scale and translation. For poles and trees, force vertical.
2. **Initial guess:**
   - translation = centroid of P_vis, pushed back by half the expected depth extent;
   - scale = ratio of mask-projected height (metric, from the calibrated depth at the base) to the canonical bbox height;
   - yaw swept over 12–36 hypotheses. The canonical front often faces +Z (the input view), so start with the canonical front pointing at the camera.
3. **Visible-surface-only registration.** Stops the full object sliding into the partial shell. For each hypothesis:
   - render the generated object's z-buffer from the photo camera;
   - keep only the points that are visible (the generated "front shell");
   - run point-to-plane ICP with **bounded scale** (Umeyama similarity inside the ICP loop, scale clamped to ±20% of the initial guess) against P_vis. Open3D (MIT) is enough. Use TEASER++ (MIT) if outliers dominate.
4. **Render-and-compare refinement.** Minimise (1 − soft-mask IoU) + λ·|depth − P_vis| over (yaw, s, t). At 100–300 px crops, a CPU z-buffer grid search or a tiny PyTorch/MPS soft rasteriser is enough; no need for nvdiffrast or gsplat. SAM 3D (App. E.3) and REPARO use the same idea.
5. **Ground on the DEM.** Translate along up until the lowest point in the object's footprint touches the DEM surface; this is the same step as the current object grounding. Keep the horizontal translation from the shell fit.
6. **Scale sanity** against category priors: person 1.5–1.95 m, car 4–5 m long, door ~2 m, pole 6–12 m. Reject rather than rescale if the result is off by more than 1.5×.
7. **Merge with the observed shell.** Keep the real photo Gaussians as the front. Add generated Gaussians only where they are **not visible from the photo camera** (z-buffer test with a small margin). Tag them `generated` (the existing provenance flag: excluded from exports and hover readout, tinted in Truth view).

**Do not use FoundationPose** as a refiner commercially: its NVIDIA licence limits use to non-commercial research and evaluation.

### 4.3 Failure modes to expect, and how to catch them

| Failure | What it looks like | Detection / mitigation |
|---|---|---|
| **Hallucinated back** | plausible but invented rear: a hut gets a second door, a person gets a backpack that isn't there | unavoidable. Tag `generated`, lower opacity, fade when the view is >90° from the photo ray |
| **Wrong depth extent** (flattened or bloated) | hut 2 m deep instead of 8 m; person as thin as a slab | category thickness priors; Amodal Depth Anything as a back-surface prior |
| **Wrong scale** | object floats or sinks after grounding; person 3 m tall | use the calibrated pointmap (never raw MoGe); category priors; clamp scale |
| **Yaw flip / Janus** | back rendered facing the camera; mirrored asymmetric huts | yaw sweep with a visible-depth residual; reject if the best and second-best yaw are within ε |
| **Occlusion truncation** | half a person (cut by a rock or the frame edge) generated as a complete "short person" | occlusion-aware models (SAM 3D, Amodal3R). For canonical models, flag masks touching the frame edge or a nearer object and skip them or apply 2D amodal completion |
| **Low-resolution input** (≤100 px) | blobby shape, smeared texture, wrong category | minimum 96–128 px mask height before attempting; otherwise keep the 2.5D shell or use a primitive / billboard |
| **Thin structures** | poles and fences become slabs; tree branches become a blob | primitive fallbacks: cylinder for poles, billboard or cone impostor for trees |
| **Background leakage** | sky or rock colour on the silhouette; ground plane welded to the feet | erode the mask 1–2 px (TripoSplat already erodes 1 px); composite on neutral grey; crop below the ground contact |
| **Baked lighting** | photo shading baked into the back (Cupid notes this as a limitation) | acceptable near the photo view; desaturate or average the back colours |
| **Hidden frame mismatch** | SAM 3D pointmap passed in OpenCV convention gives a mirrored or behind-camera object | unit test with a known synthetic cube before any real run |

---

## 5. Ranked recommendation

### Commercial-safe

| Rank | Model | Where it runs | Why |
|---|---|---|---|
| **1** | **SAM 3D Objects** + our DEM-calibrated pointmap + §4.1 check | **Needs CUDA** (≥32 GB: rented A100/L40S/H100 on a sidecar like the GEN3C adapter). Mac: try `appautomaton/mlx-spatial` (MIT port; outputs Gaussian PLY) on a ≥48 GB Mac as an experiment only | Only model that takes image plus mask, handles occlusion and small objects, **returns camera-frame pose and scale, and accepts our own pointmap**. SAM License allows commercial use; weights are gated (apply now) |
| **2** | **TripoSplat** (RGBA crop) + §4.2 alignment | **Mac-local** (pure torch; third-party MPS app exists; speed UNVERIFIED) | MIT, 4.46 GB, Gaussians match our splat pipeline directly. Canonical and not occlusion-aware, so use it only for unoccluded objects ≥128 px and always run the full alignment |
| 3 | **SF3D** (below US$1M revenue) or **TripoSR** (MIT, 1.68 GB) + §4.2 | **Mac-local** (SF3D officially experimental on MPS; TripoSR pure torch) | Fast, small, textured mesh; convert to Gaussians or render as mesh. Lower quality than 2025–26 models. SF3D's revenue cap needs to be watched |
| 4 | SAM 3D Body for people | CUDA | rigged full-body mesh in the camera frame; same licence. People are already 98% masked, so this matters mostly for Step Inside visuals |
| — | TRELLIS / TRELLIS.2 / Cupid | CUDA (Mac ports are slow: ~5 min per object on an M4 Pro) | Weights are MIT, but the default pipelines pull in nvdiffrast (research-only) and RMBG-2.0 (NC) in TRELLIS.2. Only usable commercially after replacing those. Cupid's PnP-plus-Umeyama recipe is worth copying for §4.2 |

### Research-only (evaluation and benchmarks, don't ship)

1. **Amodal3R**: the best occlusion-specific model (S-Lab NC); CUDA.
2. **Apple LiTo**: Mac-local via official MLX, research licence; canonical.
3. **pix2gestalt** as a 2D amodal step in front of canonical models (NC).

### Avoid

- **Hunyuan3D 2.x**: excludes the EU and UK; 2.5/3.x have no weights.
- **InstantMesh**: needs nvdiffrast.
- **MIDI / DepR / SceneGen**: trained indoors; DepR is share-alike; SceneGen pulls VGGT (NC).
- **FoundationPose**: NC.
- **CAST**: no code.

### Suggested first experiment (cheap)

1. Request SAM 3D Objects access on HF.
2. On a rented 40–80 GB GPU, run 20 masked near-field objects from `tools/nearfield/smear/labels.json` photos:
   - (a) with default MoGe;
   - (b) with our calibrated pointmap.
3. In parallel on the Mac, run TripoSplat on the same unoccluded crops, using the §4.2 aligner.
4. Score both on:
   - mask IoU from the photo camera;
   - visible-depth residual;
   - height error against category priors;
   - blind human judgement of a 90°-rotated render.

## Could not verify

- Real runtimes of SAM 3D Objects, TripoSplat, TripoSR and SF3D on our hardware.
- Behaviour on 100–300 px crops (all models resize to about 512).
- Metric scale of SAM 3D and Cupid outputs when given our pointmap.
- Quality and licences of the community Mac ports:
  - mlx-spatial is MIT;
  - Sam3D-Objects-MLX has no licence file;
  - the ports inherit the upstream weight licences.
- Licences of cumesh, o-voxel, flexgemm and mip-splatting.
- Whether TripoSplat's flux2-vae file is the Apache-2.0 release.
- LiTo checkpoint size.
- Amodal Depth Anything weight licence.
- DeOcc-1-to-3 weights.
- SDAmodal and "Seeing the Unseen" (not checked).

## Sources

- SAM 3D Objects: [repo](https://github.com/facebookresearch/sam-3d-objects), [LICENSE](https://raw.githubusercontent.com/facebookresearch/sam-3d-objects/main/LICENSE), [setup.md](https://github.com/facebookresearch/sam-3d-objects/blob/main/doc/setup.md), [HF](https://huggingface.co/facebook/sam-3d-objects), [paper arXiv 2511.16624](https://arxiv.org/abs/2511.16624), [Meta blog](https://ai.meta.com/blog/sam-3d/)
- SAM 3D Body: [repo](https://github.com/facebookresearch/sam-3d-body), [MHR LICENSE](https://raw.githubusercontent.com/facebookresearch/MHR/main/LICENSE)
- Mac ports: [mlx-spatial](https://github.com/appautomaton/mlx-spatial), [Sam3D-Objects-MLX](https://github.com/ZimengXiong/Sam3D-Objects-MLX), [trellis-mac](https://github.com/shivampkumar/trellis-mac), [trellis2-mlx](https://github.com/gtrg55/trellis2-mlx), [TRELLIS.2 PR #175](https://github.com/microsoft/TRELLIS.2/pull/175), [trellis-mac-mps](https://github.com/vinayapathak/trellis-mac-mps), [TripoSplatMacApp](https://github.com/ai3d-dev/TripoSplatMacApp), [LiToStudio](https://github.com/MenuuTUX/LiToStudio)
- Cupid: [repo](https://github.com/cupid3d/Cupid), [HF hbb1/Cupid](https://huggingface.co/hbb1/Cupid), [arXiv 2510.20776](https://arxiv.org/abs/2510.20776)
- TRELLIS: [TRELLIS](https://github.com/microsoft/TRELLIS), [TRELLIS.2](https://github.com/microsoft/TRELLIS.2), [arXiv 2512.14692](https://arxiv.org/abs/2512.14692), [nvdiffrast LICENSE](https://raw.githubusercontent.com/NVlabs/nvdiffrast/main/LICENSE.txt), [DINOv3 LICENSE](https://raw.githubusercontent.com/facebookresearch/dinov3/main/LICENSE.md), [RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0)
- TripoSplat: [repo](https://github.com/VAST-AI-Research/TripoSplat), [HF](https://huggingface.co/VAST-AI/TripoSplat), [arXiv 2605.16355](https://arxiv.org/abs/2605.16355), [FLUX.2 VAE (BFL)](https://bfl.ai/blog/flux-2)
- TripoSR: [repo](https://github.com/VAST-AI-Research/TripoSR), [MPS issue #119](https://github.com/VAST-AI-Research/TripoSR/issues/119)
- Stability: [SF3D](https://github.com/Stability-AI/stable-fast-3d), [SF3D LICENSE](https://raw.githubusercontent.com/Stability-AI/stable-fast-3d/main/LICENSE.md), [SPAR3D](https://github.com/Stability-AI/stable-point-aware-3d)
- Hunyuan3D: [2.0 repo](https://github.com/Tencent-Hunyuan/Hunyuan3D-2), [2.0 LICENSE](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2/main/LICENSE), [2.1 repo](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1), [2.1 LICENSE](https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE)
- Other image-to-3D: [InstantMesh](https://github.com/TencentARC/InstantMesh), [Amodal3R](https://github.com/Sm0kyWu/Amodal3R) ([LICENSE](https://raw.githubusercontent.com/Sm0kyWu/Amodal3R/main/LICENSE.txt), [arXiv 2503.13439](https://arxiv.org/abs/2503.13439)), [Apple LiTo](https://github.com/apple/ml-lito), [Pixal3D](https://github.com/TencentARC/Pixal3D), [TripoSG](https://github.com/VAST-AI-Research/TripoSG), [Step1X-3D](https://github.com/stepfun-ai/Step1X-3D), [Direct3D-S2](https://github.com/DreamTechAI/Direct3D-S2), [Hi3DGen](https://github.com/Stable-X/Stable3DGen), [UniLat3D](https://github.com/UniLat3D/UniLat3D), [Seed3D](https://seed.bytedance.com/en/blog/seed3d-1-0-released-generate-high-fidelity-3d-models-from-single-images-featuring-sota-texturing)
- Scenes: [MIDI-3D](https://github.com/VAST-AI-Research/MIDI-3D), [SceneGen](https://github.com/Mengmouxu/SceneGen), [DepR](https://github.com/mlpc-ucsd/DepR), [Gen3DSR](https://github.com/andreeadogaru/Gen3DSR), [CAST](https://arxiv.org/abs/2502.12894), [REPARO](https://github.com/VincentHancoder/REPARO), [Diorama](https://github.com/3dlg-hcvc/diorama), [SceneComplete](https://github.com/scenecomplete/SceneComplete), [SceneReGen](https://arxiv.org/abs/2608.23930), [SimuScene](https://arxiv.org/abs/2606.03994)
- Amodal: [pix2gestalt](https://github.com/cvlab-columbia/pix2gestalt), [k8xu/amodal](https://github.com/k8xu/amodal), [OWAAC](https://github.com/saraao/amodal), [Amodal-Depth-Anything](https://github.com/zhyever/Amodal-Depth-Anything), [LaMa](https://github.com/advimman/lama), [Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511), [FLUX.1-Kontext-dev](https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev)
- Alignment: [Open3D](https://github.com/isl-org/Open3D), [TEASER++](https://github.com/MIT-SPARK/TEASER-plusplus), [FoundationPose](https://github.com/NVlabs/FoundationPose), [gsplat](https://github.com/nerfstudio-project/gsplat)
