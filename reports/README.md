# Docs index

Start with [status.md](status.md), then [roadmap.md](roadmap.md). Dead ends are in [negative-results.md](negative-results.md); known code defects are in [code-review-2026-09-30.md](code-review-2026-09-30.md).

## Living docs (update these)

| Doc | Covers |
|---|---|
| [status.md](status.md) | Where each thread stands; evaluation budget; decisions waiting |
| [roadmap.md](roadmap.md) | Position, rules, sequenced plan (Now / Next / Later / Parked) |
| [negative-results.md](negative-results.md) | Every experiment that didn't pan out, one line each, with its source |
| [code-review-2026-09-30.md](code-review-2026-09-30.md) | Code-health backlog from the 2026-09-30 whole-repo review: CR-01…CR-69 and CR-W1…W6 with file:line, failure and state. Set a row to `fixed <commit>` when you fix it (roadmap N7) |
| [licences.md](licences.md) | Licence register (roadmap N2): every external data, tile, API and model source, and the decisions the owner still has to make. Summarised in `NOTICE.md` |
| [cleanup-2026-10-01.md](cleanup-2026-10-01.md) | 2026-10-01 cleanup pass: inventory of what was removed, retained and refactored |
| [type-system-review-2026-10-01.md](type-system-review-2026-10-01.md) | Repo-wide type review: the domain vocabulary (`src/lib/ontology/domain.ts`), what was consolidated, and the open items by value |
| [ontology.md](ontology.md) (generated) · [ontology-design.md](ontology-design.md) | The Rigi ontology: every concept and its UI/code words, provenance axes, crosswalks from app unions, confidence scales, resolution policies, ids, storage keys, and semantic findings. Regenerate with `npx tsx scripts/ontology/doc.ts`; checked by CI `ontology` |

## Current references by thread

| Thread | Doc | Notes |
|---|---|---|
| Registration | [terrain-matching-research.md](terrain-matching-research.md) | Synthesis of the TM studies, plus the strategy carried forward from the archived tm-strategy (construction negatives, miss-rate bounds, Part A status); study records in `tools/research/tm/*/REPORT.*` |
| | [fundamentals-plan.md](fundamentals-plan.md) | 2026-09-29 first-principles review of rendering+matching: missing common core (a-contrario accept, dense feature-metric objective, ray-cast oracle), parallax/near-field observability, data engine; experiments E0–E8; phase 0 (E0–E3) run 2026-09-29, all killed; reports in `tools/research/fund/` |
| | [geometry-first-pose.md](geometry-first-pose.md) | 2026-09-29 geometry-first camera: unused 3D assets (lakes, ridges, near field, sun, vectors), occlusion-crossing eye cue, MAP solver + covariance (GTSAM/pycolmap/PoseLib), integrity; GEO phase GA0–GC3; phase A results §8 (2026-09-30: GA2–GA5 killed, GA1 solver built) |
| | [matcher-service.md](matcher-service.md) | Matcher service: running it (env knobs), API and `policy`, changelog v0.1–v0.4, test records. The v0.4 ops doc is merged in (`archive/matcher-service-v040.md`) |
| | [stage1.md](stage1.md), [fusion.md](fusion.md) | T6 two-stage search; skyline+match fusion and the a-priori HIGH rule. The vendored stage-1 render workers were re-based on the ported deck/WebGPU service worker (wave5/S1, browser-unverified; batch-verify before the v3 freeze) |
| | [bench-wild.md](bench-wild.md), [bench-ablation.md](bench-ablation.md) | Wild benchmark and verification protocol (use the Mapterhorn update, not the headline); heading/gravity ablation, which is the unknown-pose design basis |
| | [matching-v2.md](matching-v2.md) | Eye fallback, calibration priors, LoMa: not shipped |
| | [v3-prereg.md](v3-prereg.md) | Draft prereg for `data_v3`; needs revision (roadmap R6) |
| Concordance | [concordance-research.md](concordance-research.md) | Whole-image concordance research and plan (2026-09-29); kept under `src/lib/concord` behind `?concord=`: core, cues, priors, occl, app; the joint solve, warp and re-match code (WP-D/E/G) was removed 2026-09-30 (a1845f5, see negative-results.md); accuracy claims pending interior pins (a parallel workstream) |
| Step Inside | [step-inside-design.md](step-inside-design.md) → [step-inside-results.md](step-inside-results.md) | Design of record, then build verdict. Experiment records in `tools/nearfield/*/{REPORT,SUMMARY,NOTES}.txt` |
| Step Inside: 3D Tiles | [step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) | Google Photorealistic 3D Tiles investigation (2026-09-29): licence per use case, EEA 403, integration design (three.js part since removed; tiles render in both deck engines, `src/lib/tiles3d/README.md`), and the licence-clean swisstopo 3D Tiles path |
| Renderer | [deck-default.md](deck-default.md) | deck.gl as the default renderer (2026-09-30): **flipped** (3b121ae) after canvas antialias off at DPR ≥ 2 (408f989) lifted world orbit to 59–60 fps. Perf baseline → final, commits, gate runs C (failed) and D (passed), Firefox smoke, known gaps and next fixes. Superseded by webgpu-default.md; WebGPU engine notes are in `src/lib/deck-webgpu/README.md` |
| Renderer | [webgpu-default.md](webgpu-default.md) | WebGPU deck as the default engine (2026-10-01, b520b1d), with WebGL deck as the fallback: what `?renderer=auto` probes, decision record and gates. The three.js renderer was removed the same day (583e2b7) |
| Renderer | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) | luma.gl/deck.gl master + open PRs vs our pins: verified adoption plan **and its outcome** (WPs A–I, U1–U4 landed 2026-10-01; J1/J2 vendored luma pending), gate results, local upstream branches |
| Plan | [wave5-plan-2026-10-02.md](wave5-plan-2026-10-02.md) | Wave 5 (2026-10-02): Swiss signature by default on the luma frontier; 15 parallel streams (relief v2, hatch v2, labels/palette, chrome, fonts, WGSL compile gate, subgroups, GPU skyline cost, peak-snap gathers, render-bundle spike, publication, CR backlog) and wave 2 |
| GPU / renderer | [luma-frontier-2026-10-01-late.md](luma-frontier-2026-10-01-late.md) | luma.gl frontier after master `7d1d11e9` (2026-10-01 late): the 10-01 merges (#3312, #3335, the stylized-rendering kit #3310–#3325), open PRs and branches, v10 roadmap signals, workarounds; roadmap LF1–LF8 and their outcome |
| | [lens-nods-2026-10-02.md](lens-nods-2026-10-02.md) | luma.gl's Arisia program (codename of the `GPUCommandGraph` / gpgpu work): PR timeline, the empty Ploor inspector branch, deck.gl has no command graph; the subtle lens nods in Rigi (no visible name-drop) and the veto list. Raw notes in `research_notes/arisia-lens-2026-10-02/` |
| GPU / renderer | [whole-app-graph-plan.md](whole-app-graph-plan.md) | Whole-app graph (WAG) plan (2026-10-01): islands I0–I12, the measured costs that remain (glue, not kernels), the target architecture (upstream `GPUCommandGraph` + manifest + inspector + `gpu/ingest`), phases WAG-0…4 and precision/parity decisions P1–P4. Evidence (dataflow map, measured data, upstream API audit, data sources, sketches) is in `research_notes/whole-app-graph-2026-10-01/` |
| Gipfelbuch | [explainer-research.md](explainer-research.md) | Research on explainer design principles for the `/gipfelbuch` pages (formerly `/atlas`) (2026-10-01) |
| Gipfelbuch | [gipfelbuch-review-2026-10-01/](gipfelbuch-review-2026-10-01/) | Content review of the 19 Gipfelbuch pages: domain research, math checked against code, fixes applied (2026-10-01) |
| Gipfelbuch | [gipfelbuch-design-book.md](gipfelbuch-design-book.md) | Design book: Swiss cartography, Swiss typography, field notebooks and NPR rendering research, a 60-rule programme, gap audit and phased plan for the Gipfelbuch overhaul (2026-10-01) |
| Gipfelbuch | [peak-notebook-plan.md](peak-notebook-plan.md) | Peak notebook: merging the landing's data-driven accents (terrain spill past the frame, scale, measured numbers) into the Gipfelbuch; Tafel hero, sheet anatomy, night/day roles, prototype in peak-notebook/ (2026-10-01) |
| Gipfelbuch | [gipfelbuch-comprehensive-review-2026-10-01.md](gipfelbuch-comprehensive-review-2026-10-01.md) | **Current fix list** (P0–P3) for `/gipfelbuch`; start here |
| Gipfelbuch | design history | [swiss-aesthetic](gipfelbuch-swiss-aesthetic.md) → [notebook-research](gipfelbuch-notebook-research.md) → [field-notebook-design](gipfelbuch-field-notebook-design.md) → [regression](gipfelbuch-regression-2026-10-01.md) → [restore](gipfelbuch-restore-2026-10-01.md) → [best-of-both](gipfelbuch-best-of-both.md) → [hand-sketch](gipfelbuch-hand-sketch-2026-10-01.md); sketch kit specs: [swiss-sketch-research](gipfelbuch-swiss-sketch-research.md), [sketch-rendering](gipfelbuch-sketch-rendering.md), [sketch-inventory](gipfelbuch-sketch-inventory.md). Later docs supersede earlier ones |
| Examples | [summit-example-spec.md](summit-example-spec.md) | Build spec of `examples/deck/landeskarte` (Landeskarte Abendlicht) |
| GPU / renderer | [gpu-luma-native-2026-10-01.md](gpu-luma-native-2026-10-01.md) | Luma-native GPU/compute pass (session 07, 2026-10-02): upstream sweep (luma, deck, loaders.gl, math.gl), audit, plan, outcomes of 15 packages incl. vendored luma rigi.4 + deck rigi.2 and the `gpu-raw-lint` ratchet |
| Process | [batch-ledger.md](batch-ledger.md) | Cook-mode ledger: one row per unverified commit for the batch browser pass (keep / revert / doc-only) |
| Strategy | [extension-opportunities.md](extension-opportunities.md) | Domain expansion review (2026-09-30): art, science, sport, adventure, tourism, transport and modalities; six platform building blocks; impact × effort placement and Now/Next/Later. Advisory; roadmap.md is the plan of record |
| Literature | [Mountain photo georeferencing SoTA.md](<Mountain photo georeferencing SoTA.md>) | Skyline/DEM pose literature (2026-09-24). Later verdicts are in negative-results.md |
| Aesthetics | [Geospatial rendering aesthetics frontier.md](<Geospatial rendering aesthetics frontier.md>) | Visual/rendering frontier vs current system: new default look, quick wins, art modes, licence traps (2026-09-30) |
| Cartography | [terroir-cartography.md](terroir-cartography.md) | Cartographic/data-viz evaluation (scorecard, per-surface findings from screenshots) and the terroir plan: honest encodings (phase 0), real land cover/names/glaciers "terroir pack" (1), organic rendering (2), place stories (3); data + licence table (2026-09-30). Advisory |
| Cartography | [cartography-consolidation-2026-10-02.md](cartography-consolidation-2026-10-02.md) | Deep dive + refactor of every cartographic style surface (2026-10-02): inventory, style-system research, `style/palette.ts` tokens with GLSL/WGSL emitters, `PRESET_INFO` registry + `?style=landeskarte`, swisstopo name typography wired, Landeskarte casing/bands fixes; open decisions and ranked follow-ups |

## Frozen records (never edit)

| Doc | What |
|---|---|
| [test-prereg.md](test-prereg.md), [test-results.md](test-results.md), [test-addendum.md](test-addendum.md) | Preregistered held-out test on 50 frozen wild photos. test-results' reference to `test-prereg-addenda.md` means test-addendum.md |
| [pipeline-ab.md](pipeline-ab.md) | App pipeline variants A/B; the code it runs has been removed |
| [leaderboard.md](leaderboard.md) (+ `.json`) | All methods on the 12-photo GT (2026-09-25; regenerate with `node scripts/leaderboard.mjs`). App numbers predate pipeline-ab; not comparable with eval-app |
| [archive/](archive/) | Superseded docs: next-gen roadmap (2026-09-29), tm-strategy and matcher-service-v040 (merged 2026-10-01), visgl-frontier sweep (carried into the WAG plan, 2026-10-01) |

## Module docs (next to the code)

| Doc | Covers |
|---|---|
| `../src/lib/geo/README.md` | CPU georeferencing baseline: prior, horizon, skyline, `solvePose`; DEM-source caveats |
| `../src/lib/pose6dof/README.md`, `../src/lib/picker/README.md` | GCP solver and eye refinement; top-3 picker / tap-a-peak (R4) |
| `../src/lib/upload/README.md`, `../src/lib/export/README.md` | Upload track API; export/interchange formats and their known limitations |
| `../src/lib/roll/propagate/README.md` | Pose propagation in `/roll` (R5, suggestions only) |
| `../src/lib/sky/README.md`, `../src/lib/tiles3d/README.md` | Sky segmentation; 3D Tiles in Step Inside (S3) |
| `../src/lib/gpu/README.md` → `gpu/core`, `gpu/solve`, `gpu/horizon`, `gpu/precision`, `gpu/splat-sort` READMEs | WebGPU compute: rules, core layer API (`ComputeGraph`), solve grid, horizon march, certified-f32 precision, splat sort |
| `../src/lib/deck-webgpu/README.md` | WebGPU deck renderer (the default engine) and its gotchas |
| `../vendor/deck/README.md` | Why deck is vendored on luma 10 alpha, and how to swap back to npm |
| `../src/lib/ontology/README.md` | The ontology layer: units/frames brands, Provenance sidecar, crosswalks, how to add a concept, key or id |
| `../scripts/ci/README.md` | The regression gate: every check, tier and status |
| `../scripts/terroir/README.md` | Building terroir packs (land cover, names, glaciers) and their identity snapshots |
| `../examples/README.md` | Standalone luma.gl / deck.gl examples and how to run them |
| `../tools/research/tm/README.md` | Terrain-matching study records (`*/REPORT.md`); other study records are `REPORT.txt` / `SUMMARY.txt` under `tools/research/` and `tools/nearfield/` |
| `../tools/matcher/v2/{loma,calib}/REPORT.md`, `../tools/bench/data_v3/README.md` | Matching v2 study records; the frozen `data_v3` set |

## Research notes (`../research_notes/`)

| Note | Use |
|---|---|
| `step_inside_models_2026-09.md` | Licence ledger for depth, multiview, world-model and splat models |
| `completion_integration_2026-09.md` | Completion P0 spec: artefact diagnosis, plug-in points, gate |
| `object_completion_models_2026-09.md`, `human_completion_models_2026-09.md` | Completion model surveys. Their thresholds and provenance proposals differ; the reconciliation note in `completion_integration_2026-09.md` lists where (roadmap S2) |
| `tm_literature_2026-09.md` | Terrain-matching literature (R1) |
| `gpu_compute_plan_2026-09.md` | Historical: the WebGPU sidecar plan and first results (luma 9.4). Current state is in `src/lib/gpu/README.md` |
| `gpu_next_2026-09-30.md` | Historical: the plan for the shared `gpu/core` layer, written on luma 9.4.2 just before the move to luma 10 alpha. Current state is in `src/lib/gpu/README.md` |
| `rendering_aesthetics_sota.md` | Render-polish backlog (haze, relief, labels, drape) |
| `Mountain photo georeferencing SoTA/`, `Geospatial rendering aesthetics frontier/` | Source notes behind the two reports |

**Removed 2026-09-29** (superseded; negatives kept in negative-results.md; recover with `git show 384df44:<path>`): `reports/{matcher,position,perf-photo-load}.md` (links to them elsewhere read "removed") and `research_notes/{analysis_algorithms_sota_2026,current_state_audit,implementation_summary,matching_v2_research}.md`, plus `rigi_internal_audit.md` and `existing_tools_products.md` from the two note folders.
