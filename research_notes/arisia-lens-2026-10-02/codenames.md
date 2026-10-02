# Lensman-universe codename sweep (visgl repos + local vendor tree)

Date of sweep: 2026-10-02. Read-only (gh + git + grep; no repo files edited). Raw data in `v/` next to this file.

## Bottom line

- The ONLY Lensman codename in the visgl orbit is **Arisia**, and it is the name of ONE program: **arisia.gl**, the gpgpu / GPU command graph / GPUProgram line of luma.gl. There is no multi-name scheme (no Eddore, Boskone, Kinnison, Mentor, Tellus, etc.) anywhere searched.
- The only other Lensman word is **Ploor**, appearing once, in the branch name `codex/arisia-ploor-inspector` (empty branch; see below). Ploor is a Smith-universe term, but its role here is unknown (not verified); it sits under Arisia as a sub-name for an "inspector" tool.
- deck.gl, math.gl, loaders.gl and vis.gl have zero hits for any term. deck.gl has no compute/graph program and no codename for one.
- The local vendor tree (`vendor/luma`, `vendor/deck`, README, patches, all 7+2 tarballs unpacked) has zero hits.
- Rigi already uses the nod once: `src/routes/index.tsx` body copy says "luma.gl and its arisia.gl compute layer. Bring your own lens." and `reports/luma-frontier-2026-10-01-late.md:115` notes "`codex/arisia-ploor-inspector` is empty."

## Method

1. Branch listing per repo (`gh api repos/visgl/<r>/branches`): luma.gl 161, deck.gl 218, math.gl 16, loaders.gl 146, vis.gl 23. Grep for all terms plus lens/mentor/patrol/beam.
2. `gh search prs|issues|commits|code` per repo for all 40-ish terms, in groups of six (the search API allows five OR operators): [Lensman Lensmen Eddorian Eddore Ploor Kandron], [Boskone Kinnison Tellurian Klovia Thrale Worsel], [Palain Nadreck Tregonsee Lyrane Delgon Trenco], [Triplanetary Bergenholm Directrix negasphere inertialess Velantia], [Kimball Mentor Arisian Arisia Tellus Onlo]. 100 queries, 0 rate-limit errors in the final run (an earlier run was rate-limited and discarded). Plus per-term `Arisia` searches and a full-tree path grep (`git/trees/master?recursive`) for arisia|ploor|lensman|kandron|boskone|mentor|patrol|eddor|kinnison|tellus.
3. REST listing of last 400 PRs of luma.gl and deck.gl, grepped for gpgpu|graph|compute|kernel|solver|lens.
4. `grep -rI` over `vendor/luma/README.md`, `vendor/deck/README.md`, `vendor/luma/patches`, and every tarball unpacked to scratchpad `v/un/`.
5. Not searchable by API: Z-gun, Dauntless, "primary beam", "sunbeam", "Second-stage", "Gray Lensman", "Children of the Lens", "Galactic Patrol" were included only in the first (superseded) attempt, which found nothing; "Lens" as a bare proper noun cannot be searched without optics noise (luma has `modules/effects/src/passes/postprocessing/image-blur-filters/bloom-lens-effects.ts`, which is optics, not a codename). Treat those as "no hits in path/branch/title greps", not as exhaustively proven.

## Every hit

### Arisia in luma.gl

| Kind | Identifier | Date | Notes |
|---|---|---|---|
| Docs (master) | `dev-docs/roadmaps/arisia-kernel-migration.md` | 2026-09-17, last touched e9c8072d (#3281) | "arisia Kernel execution migration": GPU core primitives compile WGSL via engine `Kernel`; benchmark `GPU_KERNEL_BASELINE`; architecture test bans ShaderInputs/UniformStore in GPU core |
| Docs | `dev-docs/roadmaps/arisia-solver-consolidation.md` | 2026-09-17, e9c8072d | "Arisia solver and reduction consolidation" (PCG, hierarchical reductions) |
| Docs | `dev-docs/roadmaps/arisia-execution-lifecycle.md` | 2026-09-17, e9c8072d | "Arisia execution lifecycle" audit |
| Docs | `dev-docs/roadmaps/arisia-fragmentation.md` | 2026-09-17, 3e943e03 (#3292) | "Arisia: make fragmentation inexpensive" |
| Branch (live) | `codex/arisia-ploor-inspector` | head 5f988dcd, 2026-09-16 | `compare master...branch`: ahead 0, behind 34. Its tip is #3283's commit (an already-merged `codex/gpu-project-performance-sweeps` change). EMPTY: no unique commits, no PR. Intended "Ploor inspector" is unbuilt upstream |
| PR branches (merged, branch refs deleted) | `codex/arisia-*`, 21 PRs | 2026-09-15 to 2026-09-17 | see list below |
| PR bodies | "arisia.gl" | 2026-09-11 | #3233, #3237, #3251: "first review boundary for the graph-state ... foundations that arisia.gl builds on", "second review boundary for arisia.gl", "first big-data hero for arisia.gl". These PRs use the plain branch prefix `jarnevon/` not `arisia` |

Merged `codex/arisia-*` PR series (all luma.gl, base master):
#3258 command-nodes (2026-09-15, merge 4b3a1b5e; `getCommandNodes()`, `graph.add(primitive)`), #3259 composition-vectors, #3260 batch-contracts, #3261 batch-audit, #3263 compaction-batching, #3264 offset-batching, #3265 segmented-layout-batching, #3267 gather-batching, #3268 uint64-scan-batching, #3269 byte-range-batching, #3271 transpose-batching, #3273 transform-batching (FFT1D, conv), #3274 dense-algebra-batching (MatVec/MatMul), #3276 hash-batching, #3278 spatial-batching, #3279 batching-completion, #3281 kernel-migration, #3282 execution-unification (FFT2D graph-owned), #3284 solver-unification, #3292 fragmentation (3e943e03), #3294 streaming (merge 02a8a13a, 2026-09-17; `GPUIncrementalExecution`).
Newest related, non-arisia-named: #3331 `akre54/gpu-data-shared-ownership` (open, 2026-10-01).

The Arisia program's pre-name predecessor stack is the 40-PR `jarnevon/*` series #3211 to #3250 (2026-09-11): `gpu-gather`, `gpu-scatter`, `kernel-engine-v2` (#3212, Kernel), `gpu-value-arena` (#3225), `gpu-value-inspector` (#3232, "expose GPU value arena diagnostics"), `gpu-conjugate-gradient` (#3224), `gpu-spmv`, `gpu-pcg-jacobi` (#3237), `gpu-operation-ir` (#3240), `gpu-program-split` (#3244), `command-node-boundary` (#3250, consolidated GPUProgram/compiler). Note #3232 is the likely upstream seed of the "ploor inspector" idea (an inspector over value arenas / graph state).

### Other Lensman terms

Zero hits in all five repos for: Lensman/Lensmen, Eddore/Eddorian, Kandron, Boskone, Kinnison, Kimball, Tellurian, Klovia, Thrale, Velantia, Worsel, Palain, Nadreck, Tregonsee, Trenco, Lyrane, Delgon, Triplanetary, Bergenholm, Directrix, negasphere, inertialess, Tellus, Onlo, Mentor (PRs, issues, commits, code, branch names). `Arisian` has no hits. (vis.gl has `public/images/blog/blog-2018-05-parisian-trees.png`, a substring false positive.)

### deck.gl

No compute/graph program: no path matching gpgpu/command-graph/compute in master tree; no branch or PR with a Lensman codename. Relevant deck PRs are consumers of luma, not a graph program: #10752 `codex/bump-luma-10-alpha-1` (open, WIP luma/math/loaders prerelease bump, 2026-09-25), #10753 (pad 8/16-bit attributes on WebGPU), #10779 (BinaryAttribute version invalidation), #10518 (interleave attribute buffer group on GPU, merged), #9919 (gpu-only memory option, open), `codex/webgpu-layer-stack`, `codex/webgpu-terrain-heightmap`, `codex/webgpu-mvt-*`. These are exactly the PRs vendored as deck.gl 9.4.0-rigi.2.

### Local vendor tree

`vendor/luma/*.tgz` (core, effects, engine, gpgpu, shadertools, webgl, webgpu), `vendor/deck/*.tgz` (core, layers), READMEs and `vendor/luma/patches`: no occurrence of any codename. (`gpgpu` dist has `gpu-core/gpu-program-lowering`, `gpu-program-compiler`: the Arisia GPUProgram code, unbranded.) The runtime code carries no Lensman strings, so every nod must be Rigi-originated.

## Inferred codename scheme

There is no scheme of many names. It is a single program brand plus one sub-name:

- **Arisia** (planet of the Arisians, the unseen Mentor race that guides, forges the Lens): brand for the gpgpu graph/compiler stack = "arisia.gl" (sibling-style to luma.gl, deck.gl, math.gl, loaders.gl). Prefix on branches (`codex/arisia-<topic>`) and roadmap docs (`arisia-*.md`) by the Codex-authored series from 2026-09-15 on.
- **Ploor**: unbuilt sub-name for an inspector (graph/value diagnostics). Unverified meaning.
- Everything else in the stack (GPUProgram, GPUCommandGraph, GPUIncrementalExecution, Kernel) uses plain descriptive names.

## Useful for Rigi's nod (suggestions only)

- Safe vocabulary: "Arisia" (compute graph), "Lens" (the user-facing inspection / look surface; Rigi already has "Bring your own lens" and `?look`/Looks), "Mentor" (guide/tutorial voice), "Ploor" (an inspector overlay, upstream left it empty, so Rigi can own it).
- Do not invent claims that upstream names other subsystems; none exist.
- Standing rule (reports/luma-frontier): no PRs/issues/comments on visgl; adopt locally only.

## Caveats

- GitHub code search indexes only default branch; branch-only content (e.g., arisia-* code on unmerged branches) was found via branch listing and PR REST, not content search. Deleted `codex/arisia-*` branches are merged and visible in master.
- Search-index empty results are treated as zero hits; the API returned no rate-limit errors in the final 100-query pass.
