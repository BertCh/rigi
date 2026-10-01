# Docs index

Start with [status.md](status.md), then [roadmap.md](roadmap.md). Dead ends are in [negative-results.md](negative-results.md); known code defects are in [code-review-2026-09-30.md](code-review-2026-09-30.md).

## Living docs (update these)

| Doc | Covers |
|---|---|
| [status.md](status.md) | Where each thread stands; evaluation budget; decisions waiting |
| [roadmap.md](roadmap.md) | Position, rules, sequenced plan (Now / Next / Later / Parked) |
| [negative-results.md](negative-results.md) | Every experiment that didn't pan out, one line each, with its source |
| [code-review-2026-09-30.md](code-review-2026-09-30.md) | Code-health backlog from the 2026-09-30 whole-repo review: CR-01…CR-53 and CR-W1…W6 with file:line, failure and state. Set a row to `fixed <commit>` when you fix it (roadmap N7) |
| [licences.md](licences.md) | Licence register (roadmap N2): every external data, tile, API and model source, and the decisions the owner still has to make. Summarised in `NOTICE.md` |
| [cleanup-2026-10-01.md](cleanup-2026-10-01.md) | 2026-10-01 cleanup pass: inventory of what was removed, retained and refactored |
| [type-system-review-2026-10-01.md](type-system-review-2026-10-01.md) | Repo-wide type review: the domain vocabulary (`src/lib/ontology/domain.ts`), what was consolidated, and the open items by value |
| [ontology.md](ontology.md) (generated) · [ontology-design.md](ontology-design.md) | The Rigi ontology: every concept and its UI/code words, provenance axes, crosswalks from app unions, confidence scales, resolution policies, ids, storage keys, and semantic findings. Regenerate with `npx tsx scripts/ontology/doc.ts`; checked by CI `ontology` |

## Current references by thread

| Thread | Doc | Notes |
|---|---|---|
| Registration | [terrain-matching-research.md](terrain-matching-research.md) | Synthesis of the TM studies; study records in `tools/research/tm/*/REPORT.*` |
| | [fundamentals-plan.md](fundamentals-plan.md) | 2026-09-29 first-principles review of rendering+matching: missing common core (a-contrario accept, dense feature-metric objective, ray-cast oracle), parallax/near-field observability, data engine; experiments E0–E8; phase 0 (E0–E3) run 2026-09-29, all killed; reports in `tools/research/fund/` |
| | [geometry-first-pose.md](geometry-first-pose.md) | 2026-09-29 geometry-first camera: unused 3D assets (lakes, ridges, near field, sun, vectors), occlusion-crossing eye cue, MAP solver + covariance (GTSAM/pycolmap/PoseLib), integrity; GEO phase GA0–GC3; phase A results §8 (2026-09-30: GA2–GA5 killed, GA1 solver built) |
| | [tm-strategy.md](tm-strategy.md) | Plan for H1→H2→levers (owned by session 58). Part A statuses are stale: H1 is built and P1 is done |
| | [matcher-service-v040.md](matcher-service-v040.md), [matcher-service.md](matcher-service.md) | Service ops (v0.4 policies) and API/changelog (v0.2–0.3.5). The "Running it" section's `MATCHER_MAX_PAGES` default is 1, not 2 |
| | [stage1.md](stage1.md), [fusion.md](fusion.md) | T6 two-stage search; skyline+match fusion and the a-priori HIGH rule |
| | [bench-wild.md](bench-wild.md), [bench-ablation.md](bench-ablation.md) | Wild benchmark and verification protocol (use the Mapterhorn update, not the headline); heading/gravity ablation, which is the unknown-pose design basis |
| | [matching-v2.md](matching-v2.md) | Eye fallback, calibration priors, LoMa: not shipped |
| | [v3-prereg.md](v3-prereg.md) | Draft prereg for `data_v3`; needs revision (roadmap R6) |
| Concordance | [concordance-research.md](concordance-research.md) | Whole-image concordance research and plan (2026-09-29); kept under `src/lib/concord` behind `?concord=`: core, cues, priors, occl, app; the joint solve, warp and re-match code (WP-D/E/G) was removed 2026-09-30 (a1845f5, see negative-results.md); accuracy claims pending interior pins (session f3) |
| Step Inside | [step-inside-design.md](step-inside-design.md) → [step-inside-results.md](step-inside-results.md) | Design of record, then build verdict. Experiment records in `tools/nearfield/*/{REPORT,SUMMARY,NOTES}.txt` |
| Step Inside: 3D Tiles | [step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) | Google Photorealistic 3D Tiles investigation (2026-09-29): licence per use case, EEA 403, integration design for both engines, and the licence-clean swisstopo 3D Tiles path |
| Renderer | [deck-default.md](deck-default.md) | deck.gl as the default renderer (2026-09-30): **flipped** (3b121ae) after canvas antialias off at DPR ≥ 2 (408f989) lifted world orbit to 59–60 fps. Perf baseline → final, commits, gate runs C (failed) and D (passed), Firefox smoke, known gaps and next fixes. Superseded by webgpu-default.md; WebGPU engine notes are in `src/lib/deck-webgpu/README.md` |
| Renderer | [webgpu-default.md](webgpu-default.md) | WebGPU deck as the default engine (2026-10-01, b520b1d), with WebGL deck as the fallback: what `?renderer=auto` probes, decision record and gates. The three.js renderer was removed the same day (583e2b7) |
| Renderer | [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) | luma.gl/deck.gl master + open PRs vs our pins: verified adoption plan **and its outcome** (WPs A–I, U1–U4 landed 2026-10-01; J1/J2 vendored luma pending), gate results, local upstream branches |
| GPU / renderer | [whole-app-graph-plan.md](whole-app-graph-plan.md) | Whole-app graph (WAG) plan (2026-10-01): islands I0–I12, the measured costs that remain (glue, not kernels), the target architecture (upstream `GPUCommandGraph` + manifest + inspector + `gpu/ingest`), phases WAG-0…4 and precision/parity decisions P1–P4. Evidence (dataflow map, measured data, upstream API audit, data sources, sketches) is in `research_notes/whole-app-graph-2026-10-01/` |
| Renderer | [visgl-frontier-2026-10-01.md](visgl-frontier-2026-10-01.md) | Follow-on sweep to the upstream review: luma, deck, loaders.gl and math at the bleeding edge, and the plan to express the app as one luma GPU graph |
| Atlas | [explainer-research.md](explainer-research.md) | Research on explainer design principles for the `/atlas` pages (2026-10-01) |
| Strategy | [Rigi competitive landscape and roadmap.md](<Rigi competitive landscape and roadmap.md>) | Market and competitor analysis (2026-09-26). Its sequencing is superseded by roadmap.md |
| Strategy | [extension-opportunities.md](extension-opportunities.md) | Domain expansion review (2026-09-30): art, science, sport, adventure, tourism, transport and modalities; six platform building blocks; impact × effort placement and Now/Next/Later. Advisory; roadmap.md is the plan of record |
| Literature | [Mountain photo georeferencing SoTA.md](<Mountain photo georeferencing SoTA.md>) | Skyline/DEM pose literature (2026-09-24). Later verdicts are in negative-results.md |
| Aesthetics | [Geospatial rendering aesthetics frontier.md](<Geospatial rendering aesthetics frontier.md>) | Visual/rendering frontier vs current system: new default look, quick wins, art modes, licence traps (2026-09-30) |
| Cartography | [terroir-cartography.md](terroir-cartography.md) | Cartographic/data-viz evaluation (scorecard, per-surface findings from screenshots) and the terroir plan: honest encodings (phase 0), real land cover/names/glaciers "terroir pack" (1), organic rendering (2), place stories (3); data + licence table (2026-09-30). Advisory |

## Frozen records (never edit)

| Doc | What |
|---|---|
| [test-prereg.md](test-prereg.md), [test-results.md](test-results.md), [test-addendum.md](test-addendum.md) | Preregistered held-out test on 50 frozen wild photos. test-results' reference to `test-prereg-addenda.md` means test-addendum.md |
| [pipeline-ab.md](pipeline-ab.md) | App pipeline variants A/B; the code it runs has been removed |
| [leaderboard.md](leaderboard.md) (+ `.json`) | All methods on the 12-photo GT (2026-09-25; regenerate with `node scripts/leaderboard.mjs`). App numbers predate pipeline-ab; not comparable with eval-app |
| [archive/](archive/) | Superseded plans (next-gen roadmap, 2026-09-29) |

## Module docs (next to the code)

| Doc | Covers |
|---|---|
| `../src/lib/geo/README.md` | CPU georeferencing baseline: prior, horizon, skyline, `solvePose`; DEM-source caveats |
| `../src/lib/pose6dof/README.md`, `../src/lib/picker/README.md` | GCP solver and eye refinement; top-3 picker / tap-a-peak (R4) |
| `../src/lib/upload/README.md`, `../src/lib/export/README.md` | Upload track API; export/interchange formats and their known limitations |
| `../src/lib/roll/propagate/README.md` | Pose propagation in `/roll` (R5, suggestions only) |
| `../src/lib/sky/README.md`, `../src/lib/tiles3d/README.md` | Sky segmentation; 3D Tiles in Step Inside (S3) |
| `../src/lib/gpu/README.md` → `gpu/core/README.md`, `gpu/solve/README.md` | WebGPU compute: rules, core layer API, solve grid |
| `../src/lib/deck-webgpu/README.md` | WebGPU deck renderer (the default engine) and its gotchas |
| `../vendor/deck/README.md` | Why deck is vendored on luma 10 alpha, and how to swap back to npm |
| `../src/lib/ontology/README.md` | The ontology layer: units/frames brands, Provenance sidecar, crosswalks, how to add a concept, key or id |
| `../scripts/ci/README.md` | The regression gate: every check, tier and status |
| `../tools/research/tm/README.md` | Terrain-matching study records (`*/REPORT.md`); other study records are `REPORT.txt` / `SUMMARY.txt` under `tools/research/` and `tools/nearfield/` |
| `../tools/matcher/v2/{loma,calib}/REPORT.md`, `../tools/bench/data_v3/README.md` | Matching v2 study records; the frozen `data_v3` set |

## Research notes (`../research_notes/`)

| Note | Use |
|---|---|
| `step_inside_models_2026-09.md` | Licence ledger for depth, multiview, world-model and splat models |
| `completion_integration_2026-09.md` | Completion P0 spec: artefact diagnosis, plug-in points, gate |
| `object_completion_models_2026-09.md`, `human_completion_models_2026-09.md` | Completion model surveys. Their licence tables overlap the ledger, and their thresholds and provenance proposals differ (roadmap S2) |
| `tm_literature_2026-09.md` | Terrain-matching literature (R1) |
| `gpu_compute_plan_2026-09.md` | WebGPU sidecar plan and results. The "Follow-up" section supersedes its first results table |
| `gpu_next_2026-09-30.md` | The shared `gpu/core` layer and the move toward luma/deck "next". Written while still on luma 9.4.2; the app moved to luma 10 alpha later that day (`src/lib/gpu/README.md`) |
| `rendering_aesthetics_sota.md` | Render-polish backlog (haze, relief, labels, drape) |
| `Mountain photo georeferencing SoTA/`, `Rigi competitive landscape and roadmap/`, `Geospatial rendering aesthetics frontier/` | Source notes behind the three reports |

**Removed 2026-09-29** (superseded; negatives kept in negative-results.md; recover with `git show 384df44:<path>`): `reports/{matcher,position,perf-photo-load}.md` (links to them elsewhere read "removed") and `research_notes/{analysis_algorithms_sota_2026,current_state_audit,implementation_summary,matching_v2_research}.md`, plus `rigi_internal_audit.md` and `existing_tools_products.md` from the two note folders.
