# Step Inside completion on the frontend: models that run on src/lib/nn (2026-10-02)

**Question.** Splatted people and objects look right from the photo eye but become cardboard shells from the side, and moving the camera opens holes behind them. Which models can complete them **in the browser**, on our own WebGPU tensor runtime (`src/lib/nn`: WGSL kernels on luma's ComputeGraph, fp16 safetensors, no ONNX), under a commercial-safe licence?

**Builds on.** `human_completion_models_2026-09.md`, `object_completion_models_2026-09.md` and `completion_integration_2026-09.md`. Those picked SAM 3D Body/Objects and TripoSplat, which are multi-GB CUDA paths. This note re-ranks under the frontend constraint.

**Method.** Three parallel web surveys (appendices A–C). Licences and file sizes were checked against the GitHub and HF APIs and LICENSE files. **Every GFLOP and seconds figure is a desk estimate**, using the measured nn throughput on an M3 Pro over Dawn: matmul/attention about 1.4–1.7 TFLOP/s, conv about 0.4–0.7, short-sequence attention about 0.3–0.4. Nothing was downloaded or run.

## Synthesis

| Problem | First build (frontend, commercial-safe) | Size fp16 | Est. runtime | Missing in nn | Effort |
|---|---|---|---|---|---|
| Hole **behind** objects (disocclusion) | **MI-GAN-512** (MIT code and weights), inpaint once in photo space, lift onto the DEM (§2.5 of the integration note) | ~15 MB | ~0.1–0.2 s | nothing | ~1 day |
| … higher quality, large masks | LaMa big-lama (Apache), FFC done as DFT-by-matmul at its fixed small sizes (64², 32²) | ~104 MB | ~1 s | rfft2/irfft2 (as matmul: ~1–1.5 days; luma `GPUFFT2D` also exists in gpgpu but gains nothing at these sizes) | ~3 days |
| **People** (back and sides) | Keypoint net (ViTPose-B Apache, or MediaPipe Pose) → fit **Anny** (Apache, CC0 assets) or **MHR** (Apache) on the CPU with the solved K and a person-height prior → front projective texture, back through-projection → splats | ~170 MB (ViTPose-B) + ~30–70 MB body model | ~0.1–0.2 s net + ms fit | nothing (the body model is evaluated in TS on the CPU, since nn has no scatter/sparse) | ~1 week |
| … best quality people | SAM 3D Body as an opt-in download (DINOv3-H+ backbone 840M params) | ~1.7 GB + decoder ~97 MB | ~2–3.5 s per person | nothing | gated SAM License redistribution; size |
| … middle road | a ViT-S/B student distilled from 3DB | ~90–350 MB | ~0.15–0.5 s | — | training project |
| **Objects** (huts, rocks, benches) | **TripoSR** (MIT per HF tag; verify the upstream LICENSE, as one ONNX card says "Stability Community"), with WGSL marching cubes at 128³, then align to the shell and add only hidden-side samples as `generated` | ~0.84 GB | ~2–4 s per object | marching cubes (ours, in WGSL) | ~1 week |
| … object back prior only | Splatter Image (BSD-3 / MIT) | <100 MB | ~0.1–0.3 s | nothing | weak on real photos |

**Conclusions.**
1. Order: **behind layer first** (MI-GAN: tiny, cheap, the geometry is the true DEM, and it fixes the most visible artefact). Then **people** via keypoints, a permissive body-model fit and through-projection. **Objects** via TripoSR come last; they are the largest download and have the most uncertain alignment.
2. No commercial-safe model under 500 MB completes general outdoor objects well. TripoSplat has a browser port (ORT-Web, 6.5 GB fp32), but it takes 248 s for 4 steps on an M3 Max, so it is not viable as is.
3. No small permissive back-normal or clothed-human net exists (PIFuHD, ECON, LHM, PSHuman, IDOL, Sapiens: NC or SMPL-X bound). The fitted body model is the back.
4. No candidate needs an op nn lacks except LaMa's FFT and our own marching cubes.

**Licence decisions for the user.**
- **Places2** training data (LaMa, MI-GAN, AOT-GAN) carries research/education terms, and the page could not be loaded to confirm. Needs a policy call (the weights themselves are MIT/Apache).
- TripoSR: an MIT vs "Stability Community" discrepancy. Check the upstream LICENSE.
- RTMW3D training-data provenance; MediaPipe Pose weights licence UNVERIFIED.
- SAM 3D Body: whether we may self-host the gated weights under the SAM License.

**Excluded (NC or other licence):** MAT, 3D Photo Inpainting nets (EdgeConnect CC BY-NC), Amodal Depth Anything (DA-V2-L, NC), ProPainter, E2FGVI, SMPL/SMPL-X-based HMR (Multi-HMR, CameraHMR, PromptHMR, NLF), Sapiens, OpenLRM weights, Amodal3R, SHARP, LiTo, Flash3D/GRM (no licence file), SF3D/SPAR3D/SD-Turbo/Stable-Zero123 (Stability licences), Hunyuan (EU excluded), YOLO11 (AGPL).

**Biggest uncertainty.** All runtimes assume our fused graph runs about 10–20× faster than ORT-Web. The first port (MI-GAN) should measure this before the larger ports are committed.


## Experiment 1 (2026-10-02): people volumes on the demo photo (IMG_7086)

Evidence is CPU-rendered orbit views of the baked landing scene. Nothing has been checked in a browser.
- Inflation (`out/people-complete/sheet.png`): `scripts/nearfield/people-complete-views.ts`.
- Body fit (`out/people-body/{sheet,fit}.png`): `scripts/nearfield/people-body-views.ts`.

**Built:**
- **Inflation** (`src/lib/nearfield/complete/people.ts`), ~40 ms on the CPU:
  - person instances on a 192-column photo grid;
  - Poisson inflation, lap(f) = −2, h = 0.7·√f, capped at 0.2 m; the photo frame is treated as a cut, not an outline;
  - back sheet on the same rays, at the smoothed front + 2h;
  - side-seam layers at the silhouette rim;
  - through-projected colour, with the hair-rim colour in the head band;
  - observed strays behind the back are dropped.
- **Body fit** (`src/lib/body`), the `backDepth` provider:
  - ViTPose-B on nn: 172 MB fp16, per-layer parity with PyTorch ≤ 3e-6, 40–85 ms per person on Dawn;
  - Anny LOD10 body model: 99 KB, 1229 vertices, Apache code and CC0 assets;
  - LM fit, ~200 ms per person on the CPU;
  - the mesh's far surface is rasterised into the people grid.
  - Scene depth fixes placement and shape. A free scene scale keeps the height prior; MoGe's near field reads ~1.5× deep here, and trusting it gave a 2.16 m body.

**Seen:**
1. From behind (180°), the shell showed her face mirrored. With completion it shows a body: hair on the back of the head, a purple back, shorts. The body fit gives a slimmer, more anatomical torso than inflation.
2. The side views (70°/110°) are still dominated by observed edge-ramp smear (hair) from the depth lift. Completion does not fix that. The live edge snap (`?nearfield=complete`) does not reach the old bake.
3. Body-fit artefacts:
   - a boxy seam at the hip in the side views;
   - the fit turns her ~42° (following the tilt in the lifted depth).
4. Body fit vs inflation is a modest gain, not a leap. The next visible wins are:
   - the hair smear (edge snap / matting on the person rim);
   - the disocclusion hole behind her (MI-GAN behind layer).

**Wiring:**
- `completeScene` adds people volumes under `?nearfield=complete` (live Step Inside).
- The landing demo does the same under `?nearfield=complete`; it segments the photo with MediaPipe only then.
- `?peopleBody=on` adds the body fit on the demo. It is not in the live controller yet: `completeScene` is synchronous and the fit needs an async ViTPose pass.

---

# Appendix A

## In-browser human completion for Step Inside (2026-10-02)

Scope: complements `research_notes/human_completion_models_2026-09.md` (not repeated). Constraint: everything runs on `src/lib/nn` (WebGPU WGSL graph, fp16 safetensors, no ONNX, no CUDA ops), commercial-safe licences only.
Verification: licences and sizes from GitHub API / HF API (`?blobs=true`) / raw READMEs today. Anything else is **UNVERIFIED**.

Runtime model used for all estimates (from the coordinator, M3 Pro over Dawn): matmul/attention 1.4-1.7 TFLOP/s (long sequences), conv 0.4-0.7 TFLOP/s, short-sequence attention (a few hundred tokens) 0.3-0.4 TFLOP/s. I take "effective" = 60% of those, plus ~1 s first-run graph compile per new input shape. FLOPs are my own arithmetic (2 x params x tokens for transformers, plus 4 N^2 D L for attention); they are estimates, not measurements.

Op coverage reminder (types.ts): rotaryEmbed (takes cos/sin tensors, so 2D axial RoPE is a table), gelu/silu, gridSample, gather, flash attention with mask, layer/group norm, convTranspose. **Missing for the human models below: scatter / index_add / sparse matmul** (needed for MHR/Anny LBS and sparse correctives on GPU; do those on CPU in TS or as a dense matmul). **None of the candidates needs FFT** (only LaMa's FFC does, already known).

---

### 0. Bottom line

1. **3DB is the only commercial-safe high-quality HMR and its decoder side is small, but its DINOv3-H+ backbone (840M params, 1.7 GB fp16) is the problem**, not the ops: ~1.9 TFLOP per 512x512 crop = **~2-3.5 s per person on the M3 Pro once weights are loaded**. Compute is fine; the 1.7 GB first download (plus a gated HF licence acceptance that the end user cannot do on our behalf: we would have to redistribute under the SAM License) is the real blocker. No small/distilled 3DB exists (Fast-SAM-3D-Body is training-free pruning/TensorRT, still ViT-H). A 3DB -> DINOv2/v3 ViT-S/B **distillation** (we run 3DB offline as teacher, MHR pseudo-labels) would give ~0.1-0.3 s and 90-350 MB, but is a training project.
2. **Cheapest build that is fully commercial-safe and runs today in nn: 2D/3D keypoints + Anny (or MHR) fitting on CPU.** ViTPose-B or RTMW3D-x (Apache) as nn nets (0.1-0.3 s), then a Gauss-Newton fit of Anny/MHR skeleton + a prior-height phenotype in plain TS (no autodiff network needed), then through-projection texturing from the 2025-09 note. Quality is "plausible mannequin with right pose", no shape detail beyond priors.
3. **No small, permissive, feed-forward "back view / clothed human" network exists.** Every back-normal/back-depth net found (PIFuHD, NormalGAN, Front2Back, ECON/ICON normal nets, IDOL/LHM) is NC, SMPL-X-bound, or needs Sapiens. With a fitted body mesh you do not need one: the mesh gives the back geometry, and the colour comes from through-projection.
4. **Browser evidence for the pattern exists but not for people**: SF3D and TripoSplat run on ORT-WebGPU for generic objects (GB-scale downloads, 30+ s). No in-browser SAM 3D Body, MHR or Anny-HMR port found. Only the CUDA-only ONNX/C++ port (AmmarkoV/SAM3DBody-cpp, MIT) which tells us exactly what the pieces weigh (below).

---

### 1. Body models and what they cost to evaluate in the browser

| Model | Licence (code / data) | Size on disk | Eval cost / ops | Notes |
|---|---|---|---|---|
| **MHR** (facebookresearch/MHR) | Apache-2.0 (verified, GitHub API) | Official `mhr_model.pt` 696 MB (TorchScript, fp64, mostly not needed). SAM3DBody-cpp extracts the real data: `body_model.lbs` **27.6 MB** + `correctives.bin` **34.3 MB** + heads `pipeline.gguf` 5.3 MB (MIT repo; weights follow the SAM/MHR licences) | 127 joints, 204 pose params (136 pose + 68 skeleton), 45 identity + 72 expression; LOD1 = 18,439 verts, 4 influences per vertex. LBS = gather + weighted sum (use dense [V x 127] matmul or CPU); correctives = small per-joint MLPs + sparse linear (needs scatter/sparse; CPU TS or densify). <5 ms CPU in TS, ~0 GFLOP on GPU | Needs a **converter script** (extract from TorchScript or reuse the cpp `.lbs`/`.bin`, formats UNVERIFIED). MHR repo ships a web viewer but it is a Flask server evaluating TorchScript, **not** a JS port. No JS/WebGPU port found |
| **Anny** v0.6 (naver/anny) | Code Apache-2.0 (GitHub API says NOASSERTION, README says Apache-2.0); MPFB2/MakeHuman + Face Units data CC0; "smplx" topology download is NC (avoid) | Repo 46 MB total (assets cached/computed by the parser; exact runtime asset size UNVERIFIED) | Blendshape sum (phenotype params age/gender/height/weight/muscle ...) + LBS on a 104-bone rig, UVs included. All linear: trivially JS | Children/elders and explicit height/age parameter make it the better body for the person-height scale knot. **No permissive regressor**: Multi-HMR-Anny checkpoint is NC; Anny-One dataset licence UNVERIFIED (not stated on page) |
| SOMA-X (NVIDIA) | Apache-2.0 | n/a | Glue/convert layer between MHR/Anny/SOMA | Only useful for MHR<->Anny pose transfer |

---

### 2. Human mesh recovery regressors

| Candidate | Date / URL | Licence (code / weights) | Params, fp16 size | GFLOPs per forward, est. runtime in nn | Ops vs nn | In / out | Quality | Browser evidence |
|---|---|---|---|---|---|---|---|---|
| **SAM 3D Body, DINOv3-H+** | 2025-11-19, github.com/facebookresearch/sam-3d-body | SAM License (commercial OK) / SAM License, HF gated (`other`) | Backbone ~840M, **model.ckpt 2.11 GB fp32? (HF) -> ~1.7 GB fp16 if halved (cpp repo: backbone.onnx 1.68 GB fp16 + 3.37 GB data BF16/fp32 copies)**; decoder 6 layers ~97 MB (UNVERIFIED param split) | Backbone: 1029 tokens (512/16 + registers) x 2 x 840M = ~1.73 TFLOP + attention 4 N^2 D L = 0.17 TFLOP => **~1.9 TFLOP**. At ~1.0 TF/s effective: **~2-3.5 s per person** (+hand crops if enabled: x2-3). Decoder (~48M params, ~150 prompt tokens, cross-attn over 1024 image tokens): ~50 GFLOP => **~0.2 s**. MHR eval on CPU ms | Backbone: ViT linear/matmul, layerNorm, flash attention, SwiGLU (silu x mul), LayerScale (mul), 2D RoPE via `rotaryEmbed` with precomputed tables (OK), register/cls tokens (concat). Decoder: self/cross attention, MLP, keypoint-token sampling probably via gridSample/gather (UNVERIFIED). Rot6d -> matrix, MHR on CPU. **Missing: nothing on GPU, MHR needs CPU or scatter** | Image crop 512x512 + optional bbox/mask/2D keypoints/`cam_int` -> MHR pose/shape/cam_t, 18k verts | Best HMR on occlusion/truncation | None in browser. SAM3DBody-cpp ONNX is CUDA-EP BF16. GEM-X redistributes ONNX 3.36 GB. **Blockers: 1.7 GB download/cache, gated licence, GPU memory on low-end devices** |
| **3DB ViT-H variant** | same | same | ViT-H 632M; model.ckpt 1.69 GB fp32 per HF listing (so likely ~0.85-1.3 GB fp16; the HF files are measured, the halving is UNVERIFIED) | ~1.3-1.5 TFLOP => **~1.5-2.5 s** | same | same | Slightly below DINOv3 per paper (table values not retrieved: UNVERIFIED) | none |
| **Fast-SAM-3D-Body** | 2026-03, github.com/yangtiming/Fast-SAM-3D-Body (arXiv 2603.15603) | MIT code (verified) / same weights as 3DB | unchanged (training-free: multi-crop batching, "architecture-aware pruning", feed-forward MHR->SMPL mapper, TensorRT) | up to 10x speedup comes from TensorRT/compile on RTX; FLOPs not materially smaller (pruning detail UNVERIFIED, PDF too large to fetch) | its MHR->SMPL mapper outputs SMPL: not usable | | on par | none; **not a small model** |
| **Distilled 3DB student (to build)** | n/a | Training-data/teacher outputs: SAM License allows; DINOv2 ViT-S/B code+weights Apache-2.0; DINOv3 weights under the DINOv3 License (gated, `other`, commercial use allowed, UNVERIFIED terms) | ViT-S 22M = 44 MB fp16; ViT-B 86M = 172 MB; + decoder 48M (97 MB) | ViT-S @512 (1024 tokens): 2x22Mx1024 = 45 GFLOP + attention 19 => **~65 GFLOP => ~0.1-0.2 s**. ViT-B: ~215 GFLOP => **~0.3-0.5 s**. Decoder ~50 GFLOP => ~0.15 s | all ops present | same as 3DB | Unknown: needs training (pseudo-label images with 3DB). Multi-HMR shows ViT-S 672 is PVE 102 vs ViT-L 94 (SMPL-X, 3DPW), so a ~8% loss is plausible | MoGe-2 ViT-S already runs in nn (same backbone family) |
| **Multi-HMR 672_S / 672_B** | 2024-02, github.com/naver/multi-hmr | **Naver NC** code and checkpoints (also Anny ckpt NC) | S 0.13 GB fp32 (~33M => 65 MB fp16); B ~86M | S @672 (2304 tokens): 2x22Mx2304 = 100 GFLOP + attention 98 => ~200 GFLOP => ~0.5 s; B ~0.9 TFLOP => ~1.2 s | ViT + HPH cross-attn head, ops all present | whole image, multi-person, SMPL-X | PVE 102.4 (S) / 94.0 (B) on 3DPW | none. **NC: architecture reference only** |
| HMR 2.0, CameraHMR, PromptHMR, NLF | -- | MIT / MPI NC / Meshcapade NC / NLF weights NC (README: "noncommercial research use") | -- | -- | -- | SMPL(-X) outputs | -- | **Excluded: SMPL(-X) dependency or NC weights** |
| GEM-X (SOMA) | 2026 | Apache code, NVIDIA Open Model | 542 MB ckpt | video model, needs a 3DB-feature input; not a standalone image HMR (UNVERIFIED single-image use) | -- | -- | -- | CUDA ONNX only |

---

### 3. 2D / 3D keypoint nets for optimisation-based fitting (no big network)

| Candidate | URL / date | Licence | Params / fp16 size | GFLOPs, est. runtime in nn | Ops vs nn | Output | Browser evidence |
|---|---|---|---|---|---|---|---|
| **MediaPipe Pose Landmarker** (BlazePose GHUM) | developers.google.com/mediapipe | Apache-2.0 code; model-card weights licence UNVERIFIED | `.task` bundles verified: lite **5.8 MB**, full **9.4 MB**, heavy **30.7 MB** (float16) | UNVERIFIED but small: ~0.3-1 GFLOP for lite/full, a few GFLOP heavy => **<50 ms** (dispatch-bound, ~100 kernels). Detector + landmarker pair | conv, depthwise, PReLU/relu, add, resize; SSD anchor decode + NMS on CPU. Producer must unpack the tflite inside `.task` to weights (extra work) | 33 landmarks (image + 3D world coords, GHUM-based, hip-centred metric), visibility | **Yes: MediaPipe Tasks Vision runs in browsers (WASM/WebGL)** natively, so we could even use its runtime as a fallback instead of nn |
| **ViTPose-B simple** | github.com/ViTAE-Transformer/ViTPose, HF `usyd-community/vitpose-base-simple` | Apache-2.0 code (verified) and HF weights `apache-2.0` (verified). Trained on COCO etc. (dataset terms UNVERIFIED) | 343.7 MB fp32 => **~172 MB fp16**, ~86M | 256x192 = 192 tokens: 2x86Mx192 = 33 GFLOP + deconv head ~5 => **~40 GFLOP => ~0.1 s** (short-seq attention rate) | ViT, convTranspose2d, 1x1 conv, argmax of heatmaps: all present | 17 COCO kpts (2D) + heatmap confidence; needs a person bbox (we have masks) | transformers.js/ORT-web ports exist for ViTPose (UNVERIFIED which repo); sizes of Xenova exports not retrievable (HF 401) |
| ViTPose+ small | `usyd-community/vitpose-plus-small` (apache-2.0) | Apache | 132.6 MB fp32 => ~66 MB fp16, ~33M | ~15 GFLOP => ~50 ms | same | COCO 17 | -- |
| **RTMPose-m/l** | Tau-J/RTMPose (HF, apache-2.0, verified) | Apache-2.0 code and weights tag; trained on Body7 mix (some NC datasets possible: UNVERIFIED) | m 50.8 MB zip (ONNX fp32), l 103 MB | m 256x192 ~2 GFLOP, l ~4 GFLOP (from RTMPose paper, from memory: UNVERIFIED) => **<30 ms** | CSPNeXt convs + SiLU + GAU (attention relu^2) + SimCC linear heads + 1D softmax/argmax: all present (relu^2 via binary mul) | 17 / 26 (halpe) / 133 (RTMW) 2D kpts with SimCC confidence | rtmlib / ORT-web demos exist (UNVERIFIED); litert-community has RTMPose LiteRT |
| **RTMW3D-x** (mmpose projects/rtmpose3d) | `rbarac/rtmpose3d`, `bukuroo/RTMW3D-ONNX` (HF, both apache-2.0 verified) 2024-07 arXiv 2407.08634 | Apache-2.0; training data cocktail14 (includes research-only sets such as H3WB/UBody: **weights provenance UNVERIFIED, flag for legal**) | x: ONNX 369 MB fp32 => **~185 MB fp16**, ~98M; l: 231 MB ckpt, ~65M | x @384x288: ~40 GFLOP (UNVERIFIED) => **~0.1-0.15 s** (conv rate) | same as RTMPose plus a z SimCC head | 133 whole-body kpts with **3D (x,y + relative z)**: body+feet+face+hands | none in browser; ONNX exists |
| MotionBERT | github.com/Walter0807/MotionBERT | Apache-2.0 code (verified); weights UNVERIFIED | -- | 2D->3D lifting, needs a **sequence** (video), single-image use poor | transformer | -- | -- |
| ViTPose-H / Sapiens pose | -- | Sapiens CC BY-NC: **excluded** | -- | -- | -- | -- | -- |

**Fitting step (no network):** Gauss-Newton / LM over ~70-110 params (bone orientations, root, Anny height/age phenotype, camera fixed to our K) against 17-133 2D keypoints + optional z from RTMW3D, with joint-angle limits and a stature prior. Cost: CPU TS, tens of ms per person; no autodiff library needed (analytic Jacobians by finite differences on a 100-DoF LBS skeleton are cheap). Mask silhouette term can be added by projecting a few thousand verts into the mask distance transform. This is a plain algorithm: no new ops in nn. Anny-Fit (naver/anny-fit, arXiv 2605.04728) does the same idea but needs ViTPose + UniDepthV2 + Grounded-SAM + Qwen2.5-VL + an HMR init, and its licence was not retrievable (UNVERIFIED): use as a design reference only.

---

### 4. Single-image clothed human / back-view prediction

| Candidate | Date | Licence (verified where noted) | Size | GFLOPs / runtime if ported | Dependency problem | Verdict |
|---|---|---|---|---|---|---|
| **LHM++ 700M** (aigc3d/LHM-plusplus) | 2026-03 | Apache-2.0 code (verified); HF `LHMPP-700M` no licence tag; `LHMPP-Prior` redistributes SMPL-X/FLAME | **4.53 GB fp32 => ~2.3 GB fp16** | 160k Gaussians, 700M params: est. 1-3 TFLOP per image => ~2-5 s *if it fit* (UNVERIFIED token counts) | The prior pack includes `human_model_files` (SMPL-X/FLAME, NC), BiRefNet, arcface; install needs pytorch3d, diff-gaussian-rasterization (Inria NC), gsplat. The "SMPLX-FREE" and "PixelShuffle" variants drop SMPL-X conditioning at the model level but README still ships the prior pack (not proven independent): **UNVERIFIED**. Encoder identity (Sapiens in LHM v1) for the "SMPLX-FREE" variant not confirmed | Not shippable: size + licence uncertainty |
| LHM-MINI | 2025 | Apache code; HF card untagged | 2.78 GB (safetensors fp32?) | -- | Sapiens-1B encoder (CC BY-NC) per prior note | NO |
| PSHuman / SiTH / IDOL / ECON / SIFU | | see prior note | multi-GB diffusion | -- | NC or nvdiffrast/SMPL-X | NO |
| GUAVA (upper body), FiCA (head/portrait) | 2025-05 / 2026-06 | repo licence UNVERIFIED (GitHub guess 404) | -- | -- | SMPL-X / FLAME based | NO (and upper body / portrait only) |
| Back normal / depth nets (PIFuHD back normals, NormalGAN, Front2Back, IRN) | 2019-2022 | PIFuHD CC-BY-NC; others research code, mostly NC or unlicensed (UNVERIFIED each) | 10-100 MB pix2pixHD-like | would be ~50-200 GFLOP convs => 0.2-0.5 s | NC / no weights | NO |
| **ECON d-BiNI** | 2022 | MPI NC code | -- | pure math: sparse CG solve, ~ms on CPU | The licence applies to the code. The BiNI algorithm is published (arXiv 2205.XXXXX family) and could be re-implemented, **needs legal read**. It also still needs a **back normal map** which no permissive net provides | not useful alone |
| **Through-projection on the fitted mesh** (from the 2025-09 note) | -- | our code | 0 | 0 | none | **Use this** for the back |
| SF3D (WebGPU port `needle-tools/SF3D-webgpu`, `BasinShapers/sf3d-webgpu-weights`) | 2024-08 / port 2026-08 | Stability AI Community licence (HF `other`: free below revenue threshold, **flag**) | backbone 912 MB + tokenizer 764 MB fp16 ONNX + 54 MB tets | ~33 s on M4 Max (author's claim, UNVERIFIED) | -- | objects, not people; browser evidence only |
| TripoSplat WebGPU (`Yosun/TripoSplat-WebGPU`) | 2026-07 | MIT (HF tag verified) | DINOv3 3.36 GB fp32 + DiT 1.63 GB + VAE 138 MB (fp32 ONNX) | ORT-WebGPU, generic objects | DINOv3 licence | evidence that GB-scale WebGPU pipelines are accepted by users; not people-aware |
| TripoSR ONNX (`brodatech/triposr-onnx`) | 2024 | MIT | -- | -- | -- | objects only |

---

### 5. Existing browser ports (feasibility evidence)

| What | Where | Result |
|---|---|---|
| MediaPipe Pose Landmarker | Google, Tasks Vision (WASM/WebGL) | Mature, real-time, 33 3D landmarks, 5.8-30.7 MB |
| ViTPose / RTMPose in ORT-web / transformers.js / LiteRT | HF `litert-community/RTMPose-*`, `onnx-community/vitpose-*` UNVERIFIED (HF 401 on direct fetch) | Plausible; exports exist for RTMPose/RTMW/RTMW3D ONNX (bukuroo) |
| SAM 3D Body | AmmarkoV/SAM3DBody-cpp (MIT), HF `AmmarkoV/SAM3DBody-cpp-onnx-models` | ONNX/C++/ggml, CUDA/TRT/CPU, **not browser**. Useful: body-model data as `.lbs` 27.6 MB + `correctives.bin` 34.3 MB + heads 5 MB, decoder 97 MB. YOLO11 detector there is AGPL: do not reuse |
| MHR / Anny in JS | none found | We write the evaluator (hundreds of lines) |
| SF3D, TripoSplat | WebGPU/ORT | generic objects; 1.7-5 GB; 30+ s |

---

### 6. Ranked shortlist (feasibility in nn, commercial-safe)

| Rank | Build | Download | Compute / person | Quality | Risk |
|---|---|---|---|---|---|
| 1 | **Keypoints -> Anny/MHR fit on CPU -> through-projection texture -> splats.** Keypoints: ViTPose-B (172 MB fp16, ~0.1 s) or RTMW3D-x (185 MB, ~0.15 s, adds z + hands/face) or MediaPipe full (9.4 MB, <50 ms) for tiny budgets | 10-190 MB + Anny assets (UNVERIFIED size) | ~0.2 s net + ms fit | Right pose and stature prior, generic shape, no clothing detail; hands usable only with RTMW | Low: no new ops, no gated licences. Check RTMW3D training-set provenance |
| 2 | **Distilled 3DB student** (DINOv2/v3 ViT-S/B + 3DB decoder -> MHR params), pseudo-labelled by running 3DB offline on our photo set / permissive datasets | 90-350 MB | 0.15-0.5 s | Close to 3DB pose, learned shape/camera; handles occlusion better than keypoint fit | Medium-high: a training project; student quality unproven |
| 3 | **3DB DINOv3-H+ as is, in nn** (with MHR evaluator in TS) | ~1.7 GB (fp16) + 62 MB body model | ~2-3.5 s | Best | High: download size, gated licence redistribution, GPU memory; fine as an opt-in "high quality" download on desktop |
| 4 | LHM++ research flag | 2.3 GB | ~2-5 s if ported (est.) | Full Gaussian avatar with generated back | NC deps unresolved; not recommended |

### Concrete "first build"

1. Producer scripts: `scripts/models/vitpose.ts` (ViTPose-B simple -> fp16 safetensors; weights Apache) and optionally `rtmw3d-x` (SimCC heads, GAU). Parity check vs PyTorch in `scripts/nn/parity.check.ts`.
2. `src/lib/body/anny.ts`: Anny evaluator in TS (blendshapes + 104-bone LBS), data baked to a compact binary by a Python script (pin `topology="anny"`, never `smplx`).
3. `src/lib/body/fit.ts`: LM fit of pose + height/age to keypoints, camera = solved K, scale knot from the person-height prior; output vertices + part labels.
4. Reuse the 2025-09 note's steps 4-8 (front projective texture, back through-projection with head special-casing, area-weighted flat splats tagged `generated`, LaMa background fill).
5. Measure with the existing gate: silhouette IoU of the fitted mesh vs person mask and foot-range error, before any distillation work. If IoU < 0.6 on the wild set, spend the effort on option 2 (3DB distillation) rather than on a bigger keypoint net.

### Flags
- NC / excluded: SMPL/SMPL-X (and everything outputting it), Multi-HMR, CameraHMR, PromptHMR, NLF weights, Sapiens, PIFuHD, ECON, LHM v1 (Sapiens), IDOL, SiTH, Inria rasteriser, nvdiffrast, YOLO11 (AGPL), SF3D (Stability community licence: conditional).
- UNVERIFIED: MediaPipe weights licence and GFLOPs, RTMW3D training-data provenance, DINOv3 licence terms for redistribution, whether browser ports of ViTPose exist beyond mentions, 3DB layer-level params/FLOPs (paper PDF not retrievable), LHM++ SMPLX-FREE independence from SMPL-X/Sapiens, Anny runtime asset size.
- FFT: none of these models need it.

---

# Appendix B

## Small, in-browser single-image -> 3D object / splat / completion models (2026-10-02)

Scope: complements `research_notes/object_completion_models_2026-09.md` (not repeated: SAM 3D, TRELLIS(.2), Hunyuan, Amodal3R, LiTo, Cupid, etc. are all >2 GB or CUDA-bound or non-commercial).
Method: GitHub API + HF API (`?blobs=true`) for licence/size; model cards via fetch. **No weights downloaded, no inference run.** FLOP and seconds figures are MY ESTIMATES from architecture recall and file sizes (marked EST); they use the coordinator's measured nn rates: matmul/attention 1.4-1.7 TFLOP/s (use 1.4), conv 0.4-0.7 (use 0.5), short-seq attention (hundreds of tokens) 0.3-0.4. First run at each input size pays a graph compile pause.
fp16 size = file size if the repo ships fp16, else fp32/2.

### 1. Headline findings
1. **Nothing both small (<500 MB) and good exists for general outdoor objects under a commercial-safe licence.** The tiny feed-forward models (Splatter Image, LaRa, LGM) are Objaverse object-centric, give poor results on real photos, and the ones with multi-view front-ends need a diffusion step that is ~50-100x our budget.
2. **TripoSR (MIT/MIT, 0.42B, 0.84 GB fp16) is the only candidate that is small, MIT, op-clean and has an end-to-end ONNX export already.** Ops: DINO ViT-B, transformer with cross-attn, deconv, grid_sample, tiny MLP, then marching cubes (ours, WGSL). Est. 2-4 s on M3 Pro. Output is a vertex-colour mesh, canonical frame, not metric.
3. **TripoSplat (MIT/MIT) already has a WebGPU/ONNX port (Yosun/TripoSplat-WebGPU, 2026-07-15)**, but 6.47 GB fp32, 248 s for 4 steps on an M3 Max 128 GB with ORT-web. Proves the op set runs in a browser; fp16 native would be 3.2 GB (4.46 GB official bundle incl. DINOv3-H). Too big for default; usable as an opt-in "high quality" download.
4. **No FFT is needed by any shortlisted model.** (Only sin/cos Fourier positional features, which are plain elementwise.) FFT is not a blocker anywhere here.
5. Few-step novel-view diffusion at SD-Turbo size works in WebGPU (ORT-web SD-Turbo, MS blog: ~1 s on RTX 4090), but no distilled 1-step Zero123-like model with a commercial-safe licence was found (UNVERIFIED negative; searched HF/GitHub/arXiv titles only).

### 2. Feed-forward image -> 3D object

| Model | Date | URL | Code / weights licence | Params, fp16 size | Ops (missing from nn?) | Input -> output, frame | Quality notes | Browser evidence |
|---|---|---|---|---|---|---|---|---|
| **TripoSR** | 2024-02 (repo pushed 2026-06) | github.com/VAST-AI-Research/TripoSR, hf stabilityai/TripoSR | MIT / MIT (GitHub API + HF tag `license:mit`) | ~0.42B (1.68 GB fp32 ckpt) -> **~0.84 GB fp16** | DINOv1 ViT-B/16 @512 (1024 tok), 16-layer transformer on 3x32x32 tri-plane tokens w/ cross-attn, deconv upsample, grid_sample (tri-plane), 10-layer 64-wide MLP, marching cubes (write WGSL). **Missing: none** | RGBA 512 -> density/colour field -> mesh. Canonical, object centred, not metric | Good silhouettes, soft/blurry back, vertex colours low-res; needs clean RGBA (we have SAM-style mask) | `brodatech/triposr-onnx` (2026-06-10): triplane.onnx 3.35 GB (fp32 + fp16 variants), nerf.onnx tiny, opset 17, MC on host. Runtime numbers: none published (UNVERIFIED). NOTE: its card says Stability Community licence; HF tag and upstream LICENSE say MIT, so check upstream LICENSE at implementation time |
| **Splatter Image** | 2023-12 (CVPR24) | github.com/szymanowiczs/splatter-image, hf szymanowiczs/splatter-image-v1 | code BSD-3-Clause / weights HF tag `license:mit`; training renders ODC-By + per-object CC | est. 40M (ckpt 677 MB incl. EMA+optimizer, EST) -> **<100 MB fp16** | SongUNet (EDM) conv + low-res self-attn, 128x128 -> 1 Gaussian per pixel (SH deg 1). **Missing: none** (convs, GN, attn). Rasteriser dependency (Inria diff-gaussian-rasterization) is for rendering/training only, we splat ourselves | 128x128 image -> 16k Gaussians, camera frame of an object-centred cam at fixed distance | Single-view, only front 16k splats; back is mushy because one Gaussian per input pixel (still a 2.5D shell, but with learned thickness). Objaverse model exists (`model_latest.pth`); category models cars/chairs/hydrants. Weak on in-the-wild | none found (UNVERIFIED) |
| **LGM** | 2024-02 | github.com/3DTopia/LGM, hf ashawkey/LGM | MIT / MIT | 0.415B (`model_fp16.safetensors` 830 MB) | Asymmetric U-Net with cross-view attention, 256x256 x 4 views -> 65k Gaussians. No missing ops. **Needs 4 views from ImageDream (Apache) / MVDream (MIT)**, an SD2.1-size multi-step diffusion | image -> 4 views (diffusion) -> Gaussians, canonical | Decent objects; seam/ghost artefacts, 4 fixed views | none |
| **LaRa** | 2024-07 | github.com/autonomousvision/LaRa, hf apchen/LaRa | MIT / `license:apache-2.0` tag | ckpt 1.51 GB incl. optimizer (EST params ~100-300M, UNVERIFIED) | Feed-forward transformer + volume Gaussians + 2DGS decode; deformable-attn-like sampling (we have deformConv/gridSample). Needs 4+ views from **zero123plus** | views -> 2DGS; canonical | Needs the multi-view diffusion too | none |
| GRM | 2024-03 | github.com/justimyhxu/GRM | **no licence file (GitHub API None)** -> unusable | 0.36B? (715 MB ckpts, fp32 => ~180M, UNVERIFIED) | pixel-aligned transformer, needs 4-view diffusion | | | none |
| OpenLRM small/base | 2023-11 | 3DTopia/OpenLRM | code Apache-2.0 / **weights CC-BY-NC-4.0 (HF tag)** | | | | **NC: reject** | |
| SF3D | 2024-07 | hf stabilityai/stable-fast-3d | **Stability Community** (code NOASSERTION) <US$1M revenue | 1B (4.03 GB fp32 -> 2 GB fp16) | tri-plane transformer + UV baking | | **Flag** | none |
| SPAR3D | 2025-01 | | Stability Community | 7.3 GB | | | **Flag** | |
| **TripoSplat** | 2026-05/06 | github.com/VAST-AI-Research/TripoSplat, hf VAST-AI/TripoSplat | MIT / MIT | fp16 files: DINOv3-H 1.68 GB, DiT 0.74 GB, VAE enc 0.68 GB, Gaussian decoder ~0.5 GB (WebGPU port has 1.08 GB fp32) = **4.46 GB bundle; ~3.2 GB ex-VAE-enc** | DINOv3-H (RoPE), flow-matching DiT, **dynamic octree density prediction** (data-dependent token count -> needs compaction/scan, not in nn; can be done on CPU between graphs), Gaussian decoder up to 262k. No FFT | RGBA crop -> up to 262,144 Gaussians (SH0), canonical | Best quality of the open set; "clean single subject" happy path | **Yosun/TripoSplat-WebGPU** (ORT-web, MIT, 6.47 GB fp32, 10 ONNX graphs, 4-step 248 s / 20-step 677 s on M3 Max; parity not established, 20-step fails thresholds, 16 GB machines unqualified). Weights DINOv3 under DINOv3 licence |
| TRELLIS-lite / tiny variants | | | | | | | none found <1B with open weights (UNVERIFIED) | |
| Apple SHARP | 2025-12 | github.com/apple/ml-sharp | **Apple ML Research licence, research only** | | | scene view-synthesis, metric | **NC: reject** (even though the architecture, DPT-ish ViT + Gaussian head, would be browser-friendly) | CoreML/MLX ports exist (agg23/Sharp-mlx-f16) |

### Runtime estimates on our nn (M3 Pro; EST)
| Model | GFLOP per forward | Steps | Seconds |
|---|---|---|---|
| TripoSR DINO ViT-B @512 (1024 tok): 2*86M*1024 + attn | ~220 | 1 | 0.16 s (matmul 1.4T) |
| TripoSR tri-plane transformer (16 layers, 3072 tok, ~260M params): 2*260M*3072 + attn ~0.6 T | ~2200 | 1 | ~1.6 s (long-seq attn runs at matmul rate) |
| TripoSR deconv + MLP @128^3 (2.1M pts * ~80 kFLOP) | ~170 (256^3 = 1.3 T, avoid) | 1 | 0.3-1 s (small-width MLP is memory bound; hierarchical/sparse MC cuts it) |
| **TripoSR total** | **~2.6 T** | 1 | **~2-4 s** + compile pause |
| Splatter Image UNet @128^2 | ~40-100 | 1 | 0.1-0.3 s (conv rate) |
| LGM U-Net 4x256^2 (EST ~0.6-1 T, conv) | ~800 | 1 | 1.6 s |
| LGM front-end ImageDream 4 views, 32^2 latent, SD2.1 UNet ~0.2 T/view/step, CFG x2 | ~1600/step | 30-50 | **50-100 s** |
| TripoSplat DINOv3-H (840M, 1024 tok) | ~1800 | 1 | ~1.3 s |
| TripoSplat DiT (~370M; ~2k latent tokens assumed, token count UNVERIFIED) | ~1500/step | 4 / 20 | 4-5 s / 20-25 s |
| TripoSplat Gaussian decoder (~270M params, per-token; size UNVERIFIED) | ~1000-5000 | 1 | 1-5 s |
| **TripoSplat total** | ~10-40 T | | **~10 s (4 step) / ~30-40 s (20 step)**; but 3.2 GB download and GPU memory > 8 GB is the real limit |
Compare: the ORT-web TripoSplat port needed 248 s for 4 steps on an M3 Max, so our fused graph path is plausibly 10-20x faster than ORT-web (ours needs measuring; this is the headline uncertainty).

### 3. Scene-level completion / novel view / amodal

| Model | Date | URL | Licence | Size | Verdict |
|---|---|---|---|---|---|
| Flash3D | 2024-06 (3DV25), pushed 2025-06 | github.com/eldar/flash3d | **no LICENSE file found (raw 404)**; relies on UniDepth (ViT-L ~0.35B, **licence NOASSERTION, CC-BY-NC in practice, UNVERIFIED**) | ~0.4B | Layered Gaussians (8 per pixel, depth-offset layers) = built-in occlusion fill-in. Ops fine (ResNet U-Net + ViT). **Reject on licence** unless we swap depth for MoGe-2 (MIT, 141 MB) and retrain the Gaussian head (idea worth stealing) |
| CompleteSplat (Niantic Spatial, arXiv 2508.21542) | 2025-08 | nianticspatial.github.io/completesplat | no code/weights found (UNVERIFIED) | SD encoder + diffusion in latent | Not obtainable |
| GSComplete (arXiv 2609.08449) | 2026-09 | arxiv | UNVERIFIED | needs 2D inpainting prior | not small |
| DIFIX-style one-step refiner (arXiv 2606.02068; One-Shot Refiner 2601.14161) | 2026 | arxiv | UNVERIFIED code | SD-Turbo-size 1-step | Interesting as an *artefact cleaner for side views*, not completer |
| Depth Anything 3 small | 2026 | hf depth-anything/DA3-SMALL, github ByteDance-Seed/Depth-Anything-3 | Apache-2.0 / Apache-2.0 | 137 MB (fp32? ~68M ViT-S) | Depth/geometry only (also pose, optional GS head in larger variants, UNVERIFIED). Candidate for amodal back-depth if fine-tuned; no completion by itself |
| Depth Anything V2 small | 2024 | hf depth-anything/Depth-Anything-V2-Small-hf | Apache-2.0 | 99 MB | depth only |
| MoGe-2 ViT-S (already running) | | Ruicheng/moge-2-vits-normal | MIT | 141 MB | already in nn |
| Amodal Depth Anything | 2025 | | MIT code, weights UNVERIFIED | | predicts hidden-surface depth = a back-thickness prior; could be a 2nd head on our ViT |
| Zero123 / Zero123-XL | 2023 | cvlab-columbia/zero123 | MIT code; weights UNVERIFIED (Objaverse-XL licence mix) | 0.86B UNet, ~1.7 GB fp16 | 50 steps x SD1.5 UNet = heavy |
| Zero123++ v1.2 | 2023-24 | SUDO-AI-3D/zero123plus | Apache-2.0 code; weights untagged, UNVERIFIED | 0.86B | 6 views in one 960x640 canvas; est. ~1.6 T/step x 28 steps ~ 45 T ~ 60-90 s. no |
| Stable-Zero123 | | | `license:other` (NC unless Stability membership) | 17 GB repo | **flag/reject** |
| SD-Turbo | 2023-11 | hf stabilityai/sd-turbo | **Stability research / "refer to stability.ai/license" for commercial**; HF has no licence tag -> treat as Community licence (flag) | UNet fp16 1.73 GB (865M) | 1-step; EST UNet 512^2 ~0.8 T ~1.6 s + VAE dec 512^2 ~1.2 T ~2.4 s = **~4 s/image** |
| SDXL-Turbo | | | `license:other` (NC/Community) | 13.9 GB | too big, flag |

WebGPU stable-diffusion evidence: ONNX Runtime Web WebGPU runs SD-Turbo in the browser in ~1 s on RTX 4090 (opensource.microsoft.com blog 2024-02-29), mlc-ai/web-stable-diffusion (SD1.5 on WebGPU/TVM), `Zhare-AI/sd-1-5-webgpu`. Mac numbers: none found (UNVERIFIED).
Practical value of a few-step NVS model for us: **none under a commercial-safe licence** with a trained camera-pose conditioning at <1 B. Skip.

### 4. Browser ports found
| Port | What | Numbers | Notes |
|---|---|---|---|
| Yosun/TripoSplat-WebGPU (hf, 2026-07-15, MIT) | TripoSplat, ORT-web WebGPU, 10 ONNX graphs, fp32 6.47 GB | M3 Max 128 GB: 4-step 248 s, 20-step 677 s, components 1.3-102 s | experimental; no parity; 16 GB machines unqualified. Live e2e page yosun-triposplat-webgpu.static.hf.space/e2e-web.html |
| brodatech/triposr-onnx (hf, 2026-06-10, MIT tag) | TripoSR 2 graphs + host marching cubes | none published | fp16 variant available; opset 17 |
| SplatDrop (splatdrop.com) | TripoSplat web tool | "no GPU required" = almost certainly server side (UNVERIFIED) | not browser inference |
| Sharp-mlx-f16, Sharp-coreml | SHARP on MLX/CoreML | | NC licence |
| SD-Turbo / SD1.5 ORT-web, mlc web-stable-diffusion | text-to-image | ~1 s on 4090 | runtime evidence only |

### 5. Ranked shortlist (in-browser feasibility x licence x usefulness)
1. **TripoSR** - MIT, 0.84 GB fp16, op-clean, ~2-4 s est., ONNX export available as a reference for parity. Gives a complete (blurry-back) mesh for hut/bench/rock/tree trunk; person/object alignment per prior note section 4.2.
2. **Splatter Image (Objaverse model)** - BSD-3 + MIT weights, <100 MB, <0.5 s. Cheap to port, nice direct-splat output, but quality on real photos is poor; useful only as a thin "thickness/back" prior or a fast preview.
3. **TripoSplat in fp16, 4-step** - best quality + direct splat output + MIT; 3.2-4.5 GB, octree compaction needed, ~10 s est. Opt-in "HQ" tier; the ORT-web port is the parity oracle.
4. LGM / LaRa - small reconstructors but gated by a 50-100 s multi-view diffusion front-end. Skip.
5. Flash3D idea (layered Gaussian per pixel) - licence blocks the checkpoint; re-implement with MoGe-2.
Rejected: SHARP, OpenLRM, Amodal3R, LiTo (NC/research), SF3D/SPAR3D/SD-Turbo (Stability Community, flag), Hunyuan (EU excluded), GRM/Flash3D (no licence), Stable-Zero123.

### 6. Concrete first build (small, MIT-only)
**TripoSR on src/lib/nn, ~1-2 weeks of work:**
1. Convert `model.ckpt` -> fp16 safetensors (script in scripts/, one-off Python, not shipped). Use brodatech ONNX as shape/parity oracle (run it in node onnxruntime for reference tensors).
2. Implement in nn: DINO ViT-B (we already have ViT-S for MoGe-2, widen), transformer blocks with cross-attn (flash attention op), tri-plane deconv (convTranspose), tri-plane sampling via `gridSample` x3 + the 10-layer MLP as `linear` chain. Check: 3072-token self-attention at 1024 dim fits the attention kernel (the 0.3 T/s short-seq path does not apply, it will run at ~1.4 T/s).
3. Marching cubes in WGSL at 128^3 (not 256^3) in chunks, with a coarse-to-fine occupancy pass to skip empty cells; output vertices + vertex colours.
4. Parity gate like `ab4365d` (per-layer rel L2 vs PyTorch on Dawn), then a bench row.
5. App side: feed the SAM mask crop as RGBA, then the alignment/merge pipeline from the September note (4.2): upright lock, yaw sweep, bounded-scale ICP vs MoGe points, add only z-buffer-hidden samples as `generated` Gaussians (sample mesh colours into splats).
Second: port TripoSplat fp16 as an opt-in tier, reusing the DINO/transformer blocks plus a DiT and an octree-compaction step (CPU between two graphs is acceptable).
Risks: tri-plane resolution 3x32^2 upsampled to 64^2 x 40 ch memory ~ fine; the first-size graph compile pause; TripoSR blurry back means orientation prior (we know up and gravity) matters more than detail.

---

# Appendix C

## In-browser inpainting for the Step Inside "behind layer" (2026-10-02)

Constraint: run on `src/lib/nn` (WebGPU, no ONNX), commercial-safe. nn op set read from `types.ts`: linear/matmul, conv2d (+groups, depthwise direct kernel), convTranspose2d, deformConv, attention, softmax, layer/group/batch norm, relu/gelu/silu/sigmoid/tanh/leakyRelu, clamp, interpolate (nearest/bilinear/bicubic), gridSample, pad, gather, slice/concat/permute, reduce, topk. **No FFT, no gated/partial conv, no einsum (use matmul+permute).**
Verification key: V = checked from LICENSE file / GitHub API / HF API in this session. U = UNVERIFIED (memory, estimate, or inference).

### 1. Candidate table (2D inpainting)

| Model | Date | Code licence | Weights licence | Params / fp16 | Ops vs nn | Quality / browser evidence |
|---|---|---|---|---|---|---|
| **MI-GAN-512 (Places2)** https://github.com/Picsart-AI-Research/MI-GAN | ICCV 2023, repo active 2026-09 | MIT (V, LICENSE) | MIT (V, LICENSE-WEIGHTS) | ~7.4M; 14.76 MB fp16 GGUF (V, Acly/MIGAN-GGUF), 16.3 MB fp16 tflite (V) | All present: depthwise-separable conv (groups), nearest upsample + fixed FIR depthwise conv, leakyReLU with gain + clamp(+-256*gain), 1x1 conv; no norm layers; fixed noise buffers (constants). **Nothing missing.** | Distilled from Co-Mod-GAN; FID close to LaMa at 512 on Places2 free-form masks, weaker on very large masks (U, paper not fetched: 403). Browser: **22.0 ms p50 on M4 Max, LiteRT.js 2.5.3 WebGPU (V, edge-compat card; "output differs from CPU, max rel diff 0.7", fp16 noise)**; 6 ms on Pixel 8a GPU (V, HF card); inpaint-web (GPL-3.0 app, do not copy code) ships MI-GAN ONNX 28 MB fp32 in WebGPU/WASM (V). |
| **LaMa / big-lama** https://github.com/advimman/lama | WACV 2022 | Apache-2.0 (V) | Apache-2.0 (V, repo; HF smartywu/big-lama, Carve/LaMa-ONNX tagged apache-2.0) | 51M; ONNX fp32 208 MB (V, Carve), so ~104 MB fp16 | Needs **rfft2/irfft2** (FFC FourierUnit + local FU on 2x2 patches). Rest: 3x3/7x7/strided convs, convT or nearest+conv, reflect pad (check `PadOptions`), BN (fold), ReLU, tanh/sigmoid. | Best-known convnet on large masks and periodic structure; resolution-robust (trained 256, fine to ~2k). Browser: many ONNX ports exist (Carve, sapienkit lama_fp32 512x512 fixed, onnxruntime-web WebGPU works per search) but **no ms numbers found (U)**; the dynamo-exported ONNX is "slow" per its card (V). |
| **Moebius** (hustvl, ECCV 2026) https://github.com/hustvl/Moebius | 2026-06 (arXiv 2606.19195), repo 2026-08 | Apache-2.0 (V, GitHub API) | HF tag says **MIT** on hustvl/Moebius, Apache-2.0 on simonw/Moebius-ONNX (V); both permissive. VAE comes from PixelHacker (MIT tag, V). Training data not checked (U) | UNet 226M (V); fp32 .bin 905 MB so ~450 MB fp16; VAE enc 137 MB + dec 198 MB fp32 (V) => **~620 MB fp16 total** | UNet = "lambda-DWConv" linear attention; export has einsum, Conv3d (already rewritten to Conv2d by simonw so Safari Metal compiles), nn.Embedding(20,3072) gather, groupnorm VAE with 64x64 attention. Mappable to matmul/permute/conv2d/gather/attention; **no missing primitive, but the lambda layers are new model code**. Spatial size FIXED 512x512 (rel-pos embedding tied to resolution). | Claims parity with FLUX.1-Fill-Dev on Places2/CelebA-HQ/FFHQ (V, README), 26 ms/step on a "single GPU" (V). Browser: **works in Chrome/Firefox/Safari via ORT-Web WebGPU (V, Willison 2026-06-22, https://simonwillison.net/2026/jun/22/porting-moebius, https://github.com/simonw/moebius-web)**; no ms figures published (U). Needs DDIM 20 steps x CFG(x2) in the port; fp16 reported "numerically unstable for this VAE" (V) => VAE must stay f32. 1.27 GB first download. |
| MAT https://github.com/fenglinglwb/MAT | 2022 | CC BY-NC (V, LICENSE head) | NC (NVIDIA-derived, U) | 62M | window attention | **EXCLUDED (NC).** |
| AOT-GAN https://github.com/researchmm/AOT-GAN-for-Inpainting (Qualcomm port qualcomm/AOT-GAN) | 2021 / port 2025 | Apache-2.0 (V); Qualcomm port tagged MIT (V) | MIT on Qualcomm repo (V); original weights on Drive (U) | ~15M, 58 MB float (V) | AOT block = dilated conv branches + gated blend (sigmoid, mul): **expressible** with conv2d dilation (check dilation option exists) | 44-180 ms on Snapdragon NPU at 512 (V). Weaker than LaMa/MI-GAN on large masks (U). Fallback only. |
| SD/SDXL-class inpainters (SD 1.5 inpaint, SD-Turbo, SDXS) | 2022-2024 | various | CreativeML OpenRAIL-M / Stability community licence (U) | 860M+ | full SD UNet + text encoder | Browser ports exist (jdp8/sd-inpainting-ort-web-fp16, V existence) but ~1.7 GB fp16 and licence strings with use restrictions. Superseded by Moebius. Not recommended. |
| InverFill (Qualcomm, CVPR 2026, arXiv 2603.23463) | 2026-03 | U | U | needs a few-step T2I base | Method, not a small net; adds 0.04-0.06 s on A100 (V from search). Not a browser candidate. |
| Classical: Telea / Navier-Stokes (OpenCV, Apache-2.0 V), PatchMatch, Poisson | - | permissive | none | 0 | CPU/GPU compute, trivial | Fine for thin holes (<~20 px), smears texture on large ones. Good fallback and for the 1-3 px rim around a fill. |

Places-trained weights note (U): LaMa, MI-GAN and AOT-GAN weights were trained on Places2 images, whose terms are research/educational (page not reachable, ECONNREFUSED). Every GAN inpainter here shares this caveat; Moebius/PixelHacker use other data (U). Flag to whoever owns the licence audit; the weights' own licences are permissive.

### 2. Depth / LDI completion

| Item | Licence | Verdict |
|---|---|---|
| 3D Photo Inpainting, Shih 2020 https://github.com/vt-vl-lab/3d-photo-inpainting (edge 46 MB, color 206 MB, depth 206 MB fp32 on HF mirror, V) | LICENSE file is MIT but **appends "LICENSE FOR EdgeConnect: CC BY-NC 4.0"** (V) and code builds on EdgeConnect + partial-conv (V README). | **NC risk, exclude.** Also needs partial conv and the bilateral/mesh pipeline. We do not need depth inpainting anyway: the plan lifts onto the true DEM. |
| Amodal Depth Anything https://github.com/zhyever/Amodal-Depth-Anything (ICCV 2025) | Code MIT (V). HF config `encoder: vitl` (V), i.e. Depth Anything V2 **Large = CC-BY-NC** | **NC, exclude** (also 335M ViT-L, 1.43 GB). |
| Depth Anything V2 Small (25M, Apache-2.0, U from memory) | Apache | Not an inpainter. Use only as "predict depth on the inpainted RGB" if a depth under the fill were ever wanted; we already have a mono depth net in nn. |
| Non-learned depth baselines | n/a | Edge-aware (guided) diffusion of the far-side depth into the hole, or masked Poisson; already planned in §2.5 item 5. DEM gives exact ground depth, so **no depth completion model is required for the grass-behind-person case.** |

### 3. Video / multi-view consistent filling
ProPainter: S-Lab licence, non-commercial (V). E2FGVI: CC BY-NC (V). No small commercial-safe video inpainter found. The design already avoids the need: inpaint once in photo space and lift, so views are consistent by construction. If per-view refinement is wanted later, the same 2D net can be re-run on the rendered view with the hole mask (no temporal model).

### 4. Runtime estimates on src/lib/nn (M3 Pro, Dawn; convs 0.4-0.7 TFLOP/s, matmul/attention 1.4-1.7, short attention 0.3-0.4)
All FLOP numbers are my hand estimates from the architectures (U), 2 FLOP per MAC, 512x512 input. Add the first-run graph compile pause per new input size; keep the crop fixed at 512.

| Model | GFLOP / forward | Seconds at the measured rates | Notes |
|---|---|---|---|
| MI-GAN-512 | ~10 (U: 7.4M params but most MACs at 128-512 px in depthwise-separable blocks; HF card says 6 ms on Pixel 8a GPU, 22 ms M4 Max) | **~0.03-0.15 s.** Depthwise convs are bandwidth-bound, not TFLOP-bound, so expect the low end of efficiency; budget 0.1-0.2 s. | Single forward. 15 MB download. |
| LaMa big-lama @512 | ~330 (U: bottleneck 64x64x512ch, 18 FFC convs about 1.3 M MAC/pixel each = ~96 GMAC; encoder+decoder ~35 GMAC; total ~165 GMAC) | convs 330 GFLOP / 0.4-0.7 TFLOP/s = **0.5-0.8 s**, plus FFT matmuls (<5 GFLOP) and elementwise: **~1 s** | ~104 MB fp16. At 256x256 crops it is 4x cheaper (~0.25 s) and the model was trained there. |
| Moebius @512 | UNet ~250 per pass (U, 226M params, 64x64 latent, hybrid conv/linear-attn; SD1.5 UNet is ~800) x 38 passes (19 DDIM steps x CFG x2; batching CFG does not reduce FLOPs) = ~9,500; VAE enc ~0.5 TFLOP, dec ~1.2 TFLOP (U, SD-VAE-sized) | at 0.5 TFLOP/s conv-dominated: **~19 s UNet + ~3 s VAE = 20-25 s**; at an optimistic 1 TFLOP/s ~12 s. Cutting to 8 steps without CFG (needs a quality check, U) would be ~2-4 s. | 620 MB fp16 download; VAE must stay f32 (reported fp16 instability), doubling its bandwidth. Not interactive; fine as an opt-in "high quality" pass. |
| AOT-GAN | ~100-150 (U) | ~0.3-0.5 s | fallback only |

### 5. FFT: add rfft2/irfft2 to nn vs pick an FFT-free model

LaMa's FFC sizes are small and fixed: FourierUnit runs on [B, 384, 64, 64] at 512 input (the local FU on 32x32 quarter patches). Two ways:
- **DFT as matmul (recommended), no new kernel:** W-axis real DFT = `matmul(x, [64,66])` (cos/sin interleaved), H-axis complex DFT = permute + `matmul` with a [128,128] real block matrix; irfft2 = the transposed pair with Hermitian doubling weights (ortho scaling folded into the constants). Cost: <5 GFLOP total per forward (negligible), runs at matmul rate. Work: ~1-1.5 days to write `rfft2/irfft2` as composite ops in `base.ts` (so CPU and GPU share them) + `parity.check.ts` case vs a CPU naive DFT, plus the LaMa graph (~1 day) and a producer script dumping `state_dict` to safetensors with BN folded (~0.5 day). Total about 3 days to a working LaMa. Only works for power-of-two-or-small sizes where the DFT matrix fits (<=128; scales O(N^2) per row, fine here).
- **Wrap luma's GPU FFT:** a real kernel node in `k-*.ts` calling luma's FFT over nn buffers; needs buffer/layout interop (luma's FFT API takes its own resources, U not inspected in this pass), channel batching, a CPU reference and a node-over-Dawn parity case. Estimate 2-4 days for the op alone, mostly interop risk, and no speed benefit at 64x64. Worth it only if we later want FFT at large sizes (deblur, frequency-domain features).
- **FFT-free model (MI-GAN):** zero new ops. Port is ~1 day (model code ~150 lines: SeparableConv2d, Upsample2d with FIR const, encoder/synthesis blocks, lrelu_agc) + weight dump script + parity vs the PyTorch checkpoint. 14 MB weights, ~0.1 s.
Trade: LaMa is better on big masks and repeating texture (grass/rock periodicity is exactly what the behind layer fills), MI-GAN is 10x cheaper and ships sooner. They share everything but the net, so build MI-GAN first, LaMa second behind the same interface.

### 6. Ranked shortlist and first build

1. **MI-GAN-512 (MIT/MIT, no missing ops, 15 MB, proven in-browser at 22 ms)**. First build.
2. **LaMa big-lama via DFT-matmul rfft2/irfft2 (Apache/Apache, ~1 s)**. Quality upgrade for larger behind-object regions; adds two reusable composite ops to nn.
3. **Moebius (Apache/MIT, 0.22B, ~20 s, 620 MB)**. Optional "best quality" pass for big holes; heaviest port (lambda layers, DDIM loop, VAE f32), only if 1+2 look mushy on real photos.
Fallbacks: Telea/NS (OpenCV Apache) for thin holes and rim feathering, AOT-GAN. Excluded: MAT, 3D-Photo-Inpainting nets (EdgeConnect NC), Amodal Depth Anything (DAV2-L NC), ProPainter/E2FGVI (NC).

**Concrete first build (MI-GAN in nn):**
1. `scripts/models/migan.py`: load `migan_512_places2.pt` (Google Drive link in MI-GAN README; or invert from `Acly/MIGAN-GGUF`), dump fp16 safetensors incl. the `filter_const`/`noise_const` buffers, add a row to `manifest.json`.
2. `src/lib/nn/models/migan.ts`: input `concat(mask-0.5, rgb*mask)` (mask 1 = keep, rgb in [-1,1]), SeparableConv2d = depthwise `conv2d(groups=C)` then 1x1, `leakyRelu(0.2)*sqrt2` then `clamp(+-256*sqrt2)`, Upsample2d = `interpolate(nearest)` + FIR depthwise conv, no norms; output `rgb*mask + out*(1-mask)` composite. Check how the repo's `fromTexture`/`pad` modes serve the 512 crop.
3. Parity: `DAWN_DIR=/tmp/dawn` node check vs a PyTorch dump (tolerance like the depth-net row; litert saw corr 0.99998 fp16 on device, so rel L2 ~1e-3 is expected).
4. Wire into `completeBehindLayer`: crop 512 around the dilated mask (the MI-GAN ONNX pipeline script also crops around the mask, V), run once per object group, lift via `holes.ts liftGenerated` at DEM range, provenance `generated`. Large masks: iterate in small increments (MI-GAN README advice, V).
5. Browser-unverified until the batch pass; record in the ledger.

### Sources
https://github.com/Picsart-AI-Research/MI-GAN , https://huggingface.co/litert-community/MI-GAN-512-Places2-LiteRT , https://huggingface.co/Acly/MIGAN-GGUF , https://github.com/john-rocky/edge-compat , https://github.com/advimman/lama , https://huggingface.co/Carve/LaMa-ONNX , https://github.com/hustvl/Moebius , https://huggingface.co/simonw/Moebius-ONNX , https://github.com/simonw/moebius-web , https://simonwillison.net/2026/jun/22/porting-moebius , https://github.com/hustvl/PixelHacker , https://github.com/lxfater/inpaint-web (GPL-3.0) , https://huggingface.co/qualcomm/AOT-GAN , https://github.com/vt-vl-lab/3d-photo-inpainting , https://github.com/zhyever/Amodal-Depth-Anything , https://huggingface.co/zhyever/Amodal-Depth-Anything-DAV2 , https://github.com/sczhou/ProPainter , https://github.com/fenglinglwb/MAT , https://arxiv.org/abs/2603.23463
