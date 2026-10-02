# Archive

Superseded docs kept because code comments, negative results or frozen records still cite them. Don't update them; current state is in [../status.md](../status.md) and the topic docs listed in [../README.md](../README.md).

| Doc | Why it is kept | Superseded by |
|---|---|---|
| [matcher-service.md](matcher-service.md) | Design, policy and test record of the removed Python matcher; code cites it | `src/lib/matcher`, [../stage1.md](../stage1.md) |
| [deck-default.md](deck-default.md) | three.js → deck flip: perf numbers, gates C/D (negative-results source) | [../webgpu-default.md](../webgpu-default.md) |
| [luma-deck-upstream-2026-10-01.md](luma-deck-upstream-2026-10-01.md) | "Do not adopt" verdicts and gates of the 10-01 upstream alignment | [../gpu-renderer.md](../gpu-renderer.md) |
| [geospatial-rendering-aesthetics-2026-09-30.md](geospatial-rendering-aesthetics-2026-09-30.md) | Look frontier review; licence verdicts | [../swiss-cartography-review.md](../swiss-cartography-review.md) §5.3 |
| [gipfelbuch-design-book.md](gipfelbuch-design-book.md) | Research and rule ids (T, I, G, L, F, H, A) cited by Gipfelbuch code | [../gipfelbuch.md](../gipfelbuch.md) |
| [gipfelbuch-swiss-cartography.md](gipfelbuch-swiss-cartography.md) | S1–S32 sketch primitives cited by `notebook/carto.tsx`, `swiss/Marks.tsx` | [../gipfelbuch.md](../gipfelbuch.md) |
| [steps-2026-10-02/](steps-2026-10-02/README.md) | Per-step reviews: sweeps, bounds and leave-one-out tables cited by code | Open items in [../roadmap.md](../roadmap.md) (P-rows) and [../gipfelbuch.md](../gipfelbuch.md) |

`peak-notebook/img/` is gitignored local screenshots only.

Deleted in the 2026-10-02 consolidation (recover with `git show 9e011141:<path>`): the Gipfelbuch design history (`reports/gipfelbuch-*.md` and folders, `explainer-research.md`, `peak-notebook-plan.md`, `peak-notebook/`), `summit-example-spec.md`, the GPU wave plans (`whole-app-graph-plan.md`, `gpu-luma-native-2026-10-01.md`, `luma-frontier-2026-10-01-late.md`, `wave5-plan-2026-10-02.md`, `roll-map-webgpu-plan-2026-10-02.md`, `luma-native-dependency-audit-2026-10-02.md`), `cartography-consolidation-2026-10-02.md`, archive `tm-strategy.md`, `matcher-service-v040.md`, `next-gen-roadmap.md`, `visgl-frontier-2026-10-01.md`, and the one-off 10-02 research-note folders. Deleted 2026-09-29: recover with `git show 384df44:<path>`.
