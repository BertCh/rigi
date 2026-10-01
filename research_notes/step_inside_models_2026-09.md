# Step Inside: model and licence verification (2026-09-28)

Nearly every fact below was checked today against primary sources: GitHub API licence and dates, Hugging Face API file sizes and licence tags (`?blobs=true`), repo READMEs and LICENSE files, and an HTTP HEAD on the SHARP checkpoint. Anything I could not check is marked **UNVERIFIED**. I downloaded no weights and ran no new inference. The MPS timings for MoGe-2 and DA3-Base come from existing local logs (`tools/research/tm/x2_geom/timing_mps.jsonl`, 50 images each).

**File written:** `tools/nearfield/research/models.json` holds the same data in machine-readable form. `types.ts` is unchanged.

> **Update (2026-10-01):** the §4/§6 renderer pick (Spark) was not adopted. Step Inside ships its own dependency-free EWA splat layers (deck.gl WebGL2 `src/lib/nearfield/deck-splat-layer.ts`, WebGPU `src/lib/deck-webgpu/layers/splats.ts`), and the three.js engine Spark targeted was removed (583e2b7). What was adopted is in `reports/step-inside-results.md` (Licences).

## 1. Single-photo and depth models (for P1)

| Model | Repo / HF | Released | Code licence | **Weights licence** | Commercial? | Checkpoint | In → Out | Apple Silicon |
|---|---|---|---|---|---|---|---|---|
| **Apple SHARP** | github.com/apple/ml-sharp | Dec 2025 (checkpoint Last-Modified 2025-12-08) | Apple sample-code licence (permissive) | **Apple ML Research licence (LICENSE_MODEL): "exclusively for Research Purposes … does not include … use in any commercial product or service"** | **NO** | 2.81 GB `.pt` (HEAD verified) | 1 image → 3DGS `.ply` | README says predict runs on CUDA, MPS or CPU; `--render` is CUDA-only; ~1.9 s on M4 Max (third-party report, UNVERIFIED by me). A CoreML port exists (pearsonkyle/Sharp-coreml, 2.72 GB) but carries the same research-only licence |
| **TripoSplat** | github.com/VAST-AI-Research/TripoSplat, HF VAST-AI/TripoSplat | HF 2026-05-31 (arXiv 2605.16355) | MIT | MIT (HF tag) | Yes (sub-licences of bundled flux2-vae, DINOv3-H and BiRefNet not checked individually) | 4.46 GB total (DINOv3-H 1.68 GB, flow model 0.74 GB, VAE encoder+decoder 1.26 GB, flux2-vae 0.34 GB, BiRefNet 0.44 GB) | 1 image → **object-centric** 3DGS (background removal, AABB, 50-step flow sampler, up to 262k Gaussians), `.ply` / `.splat` | UNVERIFIED. The code is pure torch with a `device` argument (default "cuda") and no custom kernels, so MPS is plausible. Speed unknown |
| **MoGe-2** | github.com/microsoft/MoGe, HF Ruicheng/moge-2-* | Jun 2025 | MIT | MIT (DINOv2 backbone is Apache-2.0) | Yes | ViT-S 0.14 GB / ViT-B 0.40 GB / ViT-L 1.2 GB | 1 image → metric point map, depth, normals, mask, FoV | **Yes, measured locally:** ViT-L median 4.17 s, ViT-B median 0.98 s |
| **Depth Anything 3** Small | depth-anything/DA3-SMALL | Nov 2025 | Apache-2.0 | Apache-2.0 | Yes | 0.14 GB | depth + pose (multi-view capable) | UNVERIFIED (Base works, so very likely) |
| DA3 Base | depth-anything/DA3-BASE | Nov 2025 | Apache-2.0 | Apache-2.0 | Yes | 0.52 GB (already local) | depth + pose | **Yes, measured locally:** median 0.83 s |
| DA3 Large-1.1 | depth-anything/DA3-LARGE-1.1 | Dec 2025 | Apache-2.0 | **CONFLICT:** the GitHub README table says CC BY-NC 4.0, the HF card says Apache-2.0 | Treat as NO until clarified | 1.64 GB | depth + pose | UNVERIFIED |
| DA3 Giant-1.1 | depth-anything/DA3-GIANT-1.1 | Dec 2025 | Apache-2.0 | CC BY-NC 4.0 | NO | 5.42 GB | depth + pose + **3DGS head** | UNVERIFIED. The GS head needs gsplat (CUDA) to render |
| DA3 Nested-Giant-Large-1.1 | same org | Dec 2025 | Apache-2.0 | CC BY-NC 4.0 | NO | 6.76 GB | everything, including metric depth and the GS head | UNVERIFIED |
| DA3 Metric-Large | depth-anything/DA3METRIC-LARGE | Nov 2025 | Apache-2.0 | Apache-2.0 | Yes | 1.34 GB | metric depth + sky segmentation | UNVERIFIED |
| **DA3 3DGS head** | — | — | — | **Only Giant and Nested-Giant have it; both are NC** | NO | — | — | CUDA gsplat |
| Depth Anything V2 Small | depth-anything/Depth-Anything-V2-Small | Jun 2024 | Apache-2.0 | Apache-2.0 (Base, Large and Giant are CC BY-NC) | Yes | 0.10 GB | relative depth; metric variants exist | Yes (README device code; CoreML, ONNX and transformers.js all exist). Can run in the browser |
| **LingBot-Depth-DC** (not on your list; relevant) | robbyant/lingbot-depth-postrain-dc-vitl14 | Jan 2026 | Apache-2.0 | Apache-2.0 | Yes | 1.28 GB | RGB + sparse or noisy metric depth → dense metric depth (MoGe-style `mdm.model.v2` API) | UNVERIFIED |
| Prompt Depth Anything (not on your list) | github.com/DepthAnything/PromptDA | 2025 | Apache-2.0 | Apache-2.0 (vitl HF tag) | Yes | not checked | RGB + low-res depth prompt → metric depth | UNVERIFIED |

## 2. Multi-view and registration models (for P2)

| Model | Released | Code licence | Weights licence | Commercial? | Checkpoint | Apple Silicon |
|---|---|---|---|---|---|---|
| **VGGT-1B** (facebook/VGGT-1B) | Mar 2025 | VGGT License v1 (2025-07-29): commercial use allowed except military | CC BY-NC 4.0 | NO | 5.03 GB | UNVERIFIED (the README picks cuda or cpu) |
| **VGGT-1B-Commercial** | Jul 2025 | same | VGGT licence; **gated, manual application form**; commercial allowed except military | **YES, once the application is approved** | 5.03 GB | UNVERIFIED |
| MASt3R | 2024 | CC BY-NC-SA 4.0 | CC BY-NC-SA 4.0, plus the training-dataset terms (the README calls the MapFree licence "very restrictive") | NO | 2.75 GB | UNVERIFIED (CUDA-oriented) |
| DUSt3R | 2023/24 | CC BY-NC-SA 4.0 | same, plus NC dataset terms (CO3D, ARKitScenes, ScanNet++, Waymo) | NO | ~2.2 GB (UNVERIFIED) | UNVERIFIED |
| DA3 Small / Base | — | Apache-2.0 | Apache-2.0 | Yes | 0.14 / 0.52 GB | Base yes, measured locally |
| HunyuanWorld-Mirror (not on your list) | Oct 2025 | Tencent community licence | Tencent community licence: **not valid in the EU, UK or South Korea**; above 1M MAU needs a separate licence; outputs may not be used to train other models | Conditional | 5.06 GB | UNVERIFIED |
| LingBot-Map (not on your list) | Apr 2026 | Apache-2.0 (README badge; no HF licence tag) | same | Probably | 14.2 GB | UNVERIFIED |

## 3. Generation and world models (for P3)

| Model | Released | Code | **Weights** | Commercial? | Size | Conditioning | Hardware |
|---|---|---|---|---|---|---|---|
| **LingBot-World v1** base-cam | 2026-01-29 | Apache-2.0 | **Apache-2.0** | Yes | **160 GB** | image + text + **camera poses (intrinsics + extrinsics)** → 480p/720p video | multi-GPU CUDA (the README uses 8 GPUs); a 4-bit community quantisation exists. Not feasible on a Mac |
| LingBot-World-Fast | Apr 2026 | Apache-2.0 | Apache-2.0 | Yes | 74 GB | causal, fast | multi-GPU CUDA |
| **LingBot-World v2 ("Infinity")** | 2026-07-09 | CC BY-NC-SA 4.0 | CC BY-NC-SA 4.0 | **NO** | 14B: 86 GB; 1.3B causal-fast: 6.84 GB | image + text + **actions** (camera pose conditioning not shown in the README examples) | 1.3B: 4 GPUs; 14B: 8 GPUs |
| **WorldSplat** | paper Sep 2025; code 2026-03 (xiaomi-research) | Apache-2.0 | **Weights NOT released** ("coming soon") | n/a | — | driving only (nuScenes: RGB, depth, segmentation, road sketch) | CUDA. **Not usable** |
| **GEN3C-Cosmos-7B** (NVIDIA) | Jun 2025 | Apache-2.0 | **NVIDIA Open Model License: commercial OK** | Yes | 29 GB | image + **depth-derived 3D point-cloud cache rendered along a camera trajectory** → video | Linux; Ampere, Hopper or Blackwell only |
| Lyra 2.0 (NVIDIA) | Apr 2026 | Apache-2.0 | **NVIDIA Internal Scientific R&D licence: no production use, no distribution** | NO | 98 GB | image → long video → 3DGS | Linux, H100/GB200 |
| FlashWorld | Oct 2025 (ICLR'26 oral) | Apache-2.0 | **CC BY-NC-SA 4.0** (HF tag) | NO | 21 GB | image/text (+ camera trajectory) → 3DGS in ~7 s on an A100 | CUDA (gsplat) |
| HunyuanWorld-Voyager | Sep 2025 | Tencent community licence | same: excludes EU/UK/KR, 1M MAU cap, output-training ban, AI content must be labelled | Conditional (**EU users are excluded**, and Rigi's Alps audience is largely in the EU) | 86 GB | image + camera path + **RGB-D world cache** → RGB-D video | CUDA |

**DEM-conditioned generation: what exists.** No model takes a DEM as input. The workable pattern is the "3D cache" approach from GEN3C and Voyager:
1. Render the solved-pose DEM, the photo drape and the near-field splats into RGB-D along the target camera path.
2. Feed that render as the conditioning signal. The model then only fills disocclusions.

- **GEN3C** is the only one of these whose weights are commercially usable. It needs a Linux GPU.
- **LingBot-World v1** is Apache but conditions on camera pose only, not geometry.

**DEM-conditioned depth** (which is cheaper, and runs locally): LingBot-Depth-DC and PromptDA both take metric depth as a prompt. Rigi's DEM range buffer (terrain pixels, with sky and people masked out) could be that prompt, giving near-field depth that agrees with the DEM by construction. Nobody has tested this yet; it is my suggestion.

## 4. Web splat renderers

| Renderer | npm / version | Licence | Notes |
|---|---|---|---|
| **Spark** (World Labs) | `@sparkjsdev/spark` 2.2.0, published 2026-09-11; repo pushed 2026-09-25 | MIT | peer `three >=0.180`, and the repo has `three ^0.186.1`, so it is compatible. Formats: ply, compressed ply, spz, splat, ksplat, sog. WebGL2; merges splats and meshes with correct depth sorting. 16.9 MB unpacked. Three.js path only; the deck.gl renderer would need its own layer |
| gsplat.js (HF) | `gsplat` 1.2.9, npm 2025-07 (repo pushed 2026-09) | MIT | Its own engine, not three.js; `.splat` and `.ply` |
| antimatter15/splat | — (last push 2025-11) | MIT | WebGL1 reference viewer; its README now points users to Spark |
| mkkellogg GaussianSplats3D | 0.4.7 (2025-01) | MIT | Stale |

## 5. Splat training on a Mac

| Tool | Licence | Latest | Mac backend | Input |
|---|---|---|---|---|
| **Brush** | Apache-2.0 | v0.3.0 (2025-09-14), prebuilt `aarch64-apple-darwin` binary | wgpu (Metal/WebGPU); can also train in the browser | COLMAP, nerfstudio |
| **OpenSplat** | **AGPL-3.0** | v1.2.2 (2026-09-16) | libtorch with MPS/Metal; CPU fallback is ~100x slower; ~2 KB RAM per Gaussian | COLMAP, nerfstudio, OpenSfM, ODX. Needs sparse points (no random init) |
| gsplat (nerfstudio) | Apache-2.0 | v1.5.3 (2025-07) | **CUDA only upstream** (MPS issue #163). Community Mac ports exist but I have not vetted them: gsplat-mlx, gsplat-mps (fork of 0.1.3), metalsplat, msplat, metal-gauss | COLMAP |

Two notes on the rendering pipeline:
- **SHARP:** `pip install` pulls gsplat 1.5.3, which only JIT-compiles CUDA when you render, so predict-only use on a Mac should work (consistent with its README). I have not run it.
- **DA3 GS head:** it would hit the same CUDA wall when rendering.

## 6. Recommendations

| Phase | (a) Research-only | (b) Commercial-safe |
|---|---|---|
| **P1 single photo** | **SHARP** (predict on MPS, ~2 s, 2.8 GB), with the DEM scale fit from the design. Fallback and verifier: MoGe-2 ViT-L. | **MoGe-2 depth-lift** (MIT, already local and measured on MPS: ViT-B ~1 s, ViT-L ~4 s): turn pixels into Gaussians, fit scale to the DEM. Optional upgrade: **LingBot-Depth-DC** (Apache, 1.28 GB) with DEM range as the sparse depth prompt (MPS UNVERIFIED). For single objects standing out (huts, people), **TripoSplat** (MIT, 4.46 GB) could generate a completed object splat, but it is generative and object-centric, so tag its output "generated"; MPS UNVERIFIED. Browser-only fallback: DA-V2-Small (Apache). |
| **P2 multi-view / pose propagation** | VGGT-1B or DA3-Giant-1.1 (GS head, CUDA) or MASt3R; train with Brush. | **VGGT-1B-Commercial** (apply now; the approval workflow is manual) for relative poses. Meanwhile **DA3-Base/Small** (Apache, Base already runs on MPS) for pose and depth. Poses come from Rigi's COLMAP export, then train with **Brush** (Apache, Mac binary). Avoid shipping OpenSplat (AGPL) inside the product. Running it as an unmodified internal tool is probably fine, but that needs legal review. |
| **P3 generation / hole-fill** | Lyra 2.0, FlashWorld, Voyager, LingBot-World v2. All are CUDA-only and none is feasible on this Mac. | **GEN3C-Cosmos-7B** (NVIDIA Open Model License), fed a DEM-anchored RGB-D cache render: the closest thing to real "DEM-conditioned generation". Alternative: **LingBot-World v1 base-cam** (Apache, camera-pose conditioned, 160 GB). Both need rented Linux GPUs. Everything else is NC, gated by territory (Tencent excludes the EU), or unreleased (WorldSplat). |

**Renderer: Spark 2.2.0** (MIT, three 0.186-compatible). **Trainer: Brush.**

Corrections to the design doc:
- SHARP is **research-only**; it cannot back a commercial P1.
- The only DA3 checkpoints with a Gaussian head are NC.
- "LingBot-World-Infinity" (v2) is NC. v1 is Apache.
- WorldSplat has no weights and covers driving only.

## Could NOT verify
- MPS support and speed for: TripoSplat, VGGT, DA3 Small/Large/Giant, the DA3 GS head, MASt3R/DUSt3R, LingBot-Depth, PromptDA, HunyuanWorld-Mirror.
- SHARP's M4 Max speed (a third-party figure).
- Whether SHARP's output scale is metric.
- DA3-Large-1.1's true licence (the GitHub and HF pages disagree).
- The sub-licences of TripoSplat's bundled components.
- The exact terms of the VGGT-1B-Commercial form and whether it gets approved.
- LingBot-Map's licence, which comes only from a README badge.
- DUSt3R checkpoint size.
- Brush's current version beyond the v0.3.0 GitHub release.

## Sources
- [apple/ml-sharp](https://github.com/apple/ml-sharp), [9to5Mac on SHARP](https://9to5mac.com/2025/12/17/apple-sharp-ai-model-turns-2d-photos-into-3d-views/), [Sharp-coreml](https://huggingface.co/pearsonkyle/Sharp-coreml)
- [TripoSplat](https://github.com/VAST-AI-Research/TripoSplat), [HF VAST-AI/TripoSplat](https://huggingface.co/VAST-AI/TripoSplat)
- [VGGT](https://github.com/facebookresearch/vggt), [VGGT-1B-Commercial](https://huggingface.co/facebook/VGGT-1B-Commercial)
- [Depth-Anything-3](https://github.com/ByteDance-Seed/Depth-Anything-3), [DA3-GIANT-1.1](https://huggingface.co/depth-anything/DA3-GIANT-1.1), [Depth-Anything-V2](https://github.com/DepthAnything/Depth-Anything-V2)
- [MoGe](https://github.com/microsoft/MoGe), [moge-2-vitl-normal](https://huggingface.co/Ruicheng/moge-2-vitl-normal)
- [MASt3R](https://github.com/naver/mast3r), [DUSt3R](https://github.com/naver/dust3r)
- [lingbot-world](https://github.com/robbyant/lingbot-world), [lingbot-world-v2](https://github.com/Robbyant/lingbot-world-v2), [lingbot-world-base-cam](https://huggingface.co/robbyant/lingbot-world-base-cam), [lingbot-depth](https://huggingface.co/robbyant/lingbot-depth)
- [WorldSplat](https://github.com/xiaomi-research/worldsplat), [arXiv 2509.23402](https://arxiv.org/abs/2509.23402)
- [GEN3C](https://github.com/nv-tlabs/GEN3C), [GEN3C-Cosmos-7B](https://huggingface.co/nvidia/GEN3C-Cosmos-7B), [Lyra](https://github.com/nv-tlabs/lyra), [FlashWorld](https://github.com/imlixinyang/FlashWorld)
- [HunyuanWorld-Voyager licence](https://github.com/Tencent-Hunyuan/HunyuanWorld-Voyager/blob/main/LICENSE), [HunyuanWorld-Mirror](https://github.com/Tencent-Hunyuan/HunyuanWorld-Mirror)
- [Spark](https://github.com/sparkjsdev/spark), [gsplat.js](https://github.com/huggingface/gsplat.js), [antimatter15/splat](https://github.com/antimatter15/splat)
- [OpenSplat](https://github.com/pierotofy/OpenSplat), [Brush](https://github.com/ArthurBrussee/brush), [gsplat MPS issue #163](https://github.com/nerfstudio-project/gsplat/issues/163), [gsplat-mlx](https://github.com/RobotFlow-Labs/gsplat-mlx)
