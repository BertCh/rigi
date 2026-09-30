# Docs index

Start with [status.md](status.md), then [roadmap.md](roadmap.md). Dead ends are in [negative-results.md](negative-results.md).

## Living docs (update these)

| Doc | Covers |
|---|---|
| [status.md](status.md) | Where each thread stands; evaluation budget; decisions waiting |
| [roadmap.md](roadmap.md) | Position, rules, sequenced plan (Now / Next / Later / Parked) |
| [negative-results.md](negative-results.md) | Every experiment that didn't pan out, one line each, with its source |

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
| Concordance | [concordance-research.md](concordance-research.md) | Whole-image concordance research and plan (2026-09-29); WP-A..G being built under `src/lib/concord` behind `?concord=`; results pending interior pins (session f3) |
| Step Inside | [step-inside-design.md](step-inside-design.md) → [step-inside-results.md](step-inside-results.md) | Design of record, then build verdict. Experiment records in `tools/nearfield/*/{REPORT,SUMMARY,NOTES}.txt` |
| Step Inside: 3D Tiles | [step-inside-google-3d-tiles.md](step-inside-google-3d-tiles.md) | Google Photorealistic 3D Tiles investigation (2026-09-29): licence per use case, EEA 403, integration design for both engines, and the licence-clean swisstopo 3D Tiles path |
| Renderer | [deck-default.md](deck-default.md) | deck.gl as the default renderer: the remaining fixes (imagery pages kept across world exits, flight-frame gizmo swap, GL error spam), with perf, pixel and near-ground checks (2026-09-30) |
| Strategy | [Rigi competitive landscape and roadmap.md](<Rigi competitive landscape and roadmap.md>) | Market and competitor analysis (2026-09-26). Its sequencing is superseded by roadmap.md |
| Literature | [Mountain photo georeferencing SoTA.md](<Mountain photo georeferencing SoTA.md>) | Skyline/DEM pose literature (2026-09-24). Later verdicts are in negative-results.md |

## Frozen records (never edit)

| Doc | What |
|---|---|
| [test-prereg.md](test-prereg.md), [test-results.md](test-results.md), [test-addendum.md](test-addendum.md) | Preregistered held-out test on 50 frozen wild photos. test-results' reference to `test-prereg-addenda.md` means test-addendum.md |
| [pipeline-ab.md](pipeline-ab.md) | App pipeline variants A/B; the code it runs has been removed |
| [leaderboard.md](leaderboard.md) (+ `.json`) | All methods on the 12-photo GT (2026-09-25; regenerate with `node scripts/leaderboard.mjs`). App numbers predate pipeline-ab; not comparable with eval-app |
| [archive/](archive/) | Superseded plans (next-gen roadmap, 2026-09-29) |

## Research notes (`../research_notes/`)

| Note | Use |
|---|---|
| `step_inside_models_2026-09.md` | Licence ledger for depth, multiview, world-model and splat models |
| `completion_integration_2026-09.md` | Completion P0 spec: artefact diagnosis, plug-in points, gate |
| `object_completion_models_2026-09.md`, `human_completion_models_2026-09.md` | Completion model surveys. Their licence tables overlap the ledger, and their thresholds and provenance proposals differ (roadmap S2) |
| `tm_literature_2026-09.md` | Terrain-matching literature (R1) |
| `gpu_compute_plan_2026-09.md` | WebGPU sidecar plan and results. The "Follow-up" section supersedes its first results table |
| `rendering_aesthetics_sota.md` | Render-polish backlog (haze, relief, labels, drape) |
| `Mountain photo georeferencing SoTA/`, `Rigi competitive landscape and roadmap/` | Source notes behind the two reports |

**Removed 2026-09-29** (superseded; negatives kept in negative-results.md; recover with `git show 384df44:<path>`): `reports/{matcher,position,perf-photo-load}.md` and `research_notes/{analysis_algorithms_sota_2026,current_state_audit,implementation_summary,matching_v2_research}.md`, plus `rigi_internal_audit.md` and `existing_tools_products.md` from the two note folders.
