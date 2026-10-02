# Rigi ontology: design (v3, 2026-09-30)

*Design rationale and review history. Generated reference: [ontology.md](ontology.md). Current module guide: [src/lib/ontology/README.md](../src/lib/ontology/README.md). Tightened 2026-10-02.*

This is the meta layer for Rigi's types. It gives one vocabulary, one set of semantic primitives and
one machine-checked map from that vocabulary to the ~700 exported types in `src/`. It lives in
`src/lib/ontology/**`. Tables are generated into `reports/ontology.md`, and the check is
`src/lib/ontology/ontology.check.ts`, which runs in the CI fast tier.

## 1. What the survey found (2026-09-30, four parallel surveys of src/ + data/ + tools/)

| Smell | Examples |
|---|---|
| One concept, many shapes | Pose: `Pose`, `Camera` (geo), `CameraX`, `GeoState`, `Params` ×2, `PoseJson`. Peak: `Peak`, `RegionPeak`, `PoolPeak`, `PeakInput` ×2, `PeakPoint`, `PeakLabel` ×3. Skyline: `SkylineObservation`, `SkylineRows`, `SkylineInput`, `SkylineLike`, `CleanSkyline`, `SkylineSample`. Pin: `Pin`, `ControlPoint`, `Correspondence`, `Corr2D3D`, `InteriorPin`, `Cue`, plus the GT control-point `{x,y,peak}`. |
| One name, many things | `PhotoMeta` ×2, `SolveResult` ×2, `Params` ×2, `PeakLabel` ×3, `CompositeLook` (type and class), "pin" (peak pin, map position pin, control point), "stage" ×4, "source" ×12+ |
| Provenance scattered | `PoseSource`, `SolvedPose.method` (free string), `AlignState` (unexported, but consumed as `string` by picker and concord), `SecondOpinionVerdict`, `UnknownPoseOutcome.source/state`, `CandidateSource`, `positionSource` (`exif\|pin` vs `exif-gps\|manual`), `EyePrior.source`, `LakeLevel.source`, `InteriorPin.source`, nearfield `Provenance`, `SkyMask.source`, `FetchSource`, `PositionProvenance.method`, `Placement` |
| Confidence incomparable | refine ramps (accept ≥ 0.5), cascade (0.5 / 0.75), matcher (0.9 / 0.2 constants), app preview (> 0.2), concord (high/medium/low, fail-closed 0.5), sigma/cov in pose6dof and geocam |
| Units and frames implicit | pixel bases: norm 0..1, working px, px@1600-wide, px@1600-long-side, px@1000. Heights: MSL vs ellipsoidal vs above-ground vs engine-ENU-z. Four bbox orders. `[lat,lon]` vs `(lon,lat)` arguments. Missing values as `null`, `undefined`, `NaN`, −89 or −32768 |
| Ids ad hoc | `IMG_\d+`, `local-<hash>`, `demo-NN`, `wc_NNNN`, `region-N`, `local-region-…`, `node/123`, `way/…`, `z/x/y`; prefix tests scattered (`isLocalPhotoId`, `startsWith("demo-")`) |
| Persistence ad hoc | `mt-image:` / `mt-image.` / `rigi.` key prefixes; most keys unversioned; `summit-lens/pose` and slens XMP kept for compatibility |
| Vocabulary drift | UI says Blend / In map, code says `replace` / `world`. "Summit Lens" still appears in upload. Eye height is 1.6 m in one place and 1.8 m in another. Viewpoint is called "spot". |

## 1b. Iteration log

**v1 → v2.** An adversarial review (an independent Opus planner) found these problems. Each fix is
now in the code:

| v1 | Problem | v2 |
|---|---|---|
| One `Source` taxonomy with trust tiers | Mixed who, how and what. `solver.skyline` named a method by its evidence. `sensor.lens` is EXIF metadata, not a sensor. | Separate axes: **agent** (who), **method** (`METHODS` table: agent + evidence + module), **evidence** (= geocam `CueFamily` plus 6 more, with tsc-checked equality). |
| `derived.prior` as an assumed-tier source | "Prior" is a role, not a source: compass+gravity priors come from sensors. | A **role** axis: prior · observation · estimate · oracle. |
| Global `precedence()` | Ground truth is withheld in evaluation, and "saved" is an endorsement of whatever produced the pose. | Named **resolution policies** (rollDisplay, rollEval, workspace). The check proves rollDisplay equals the order in `roll.ts resolvePose`. |
| `Estimate<T>` wrapper | Changes runtime shapes, and provenance is often per field. | A **`Provenance` sidecar** plus `FieldProvenance<T>`. Value shapes are untouched. |
| Status lattice with `verified` | "verified" is corroboration (evidence), not a lifecycle step. And `asserted`/`assumed` appeared on two axes. | Flat **status** (candidate · pending · accepted · endorsed · rejected · failed · superseded). **outcome** (kept · replaced · timeout · unavailable) and **corroborated** are separate. |
| Crosswalk each union → status | `AlignState` mixes sources and statuses; `SecondOpinionVerdict` is a process outcome. | Crosswalks map to **`ProvenanceClass` tuples**. `workspaceProvenance(alignState, verify)` combines them. |
| `Confidence {score: Prob}` | Uncalibrated scores are not probabilities, and the matcher is level-only. | `score: number \| null`, a per-scale `calibrated` and `levelOnly`, `high: null` = never HIGH alone. |
| Runtime realization check that imports modules | Imports have side effects (workers, WebGPU). | Type-level realization map (`checks/realizations.ts`, generated): tsc proves every type exists and that the two key lists are equal. |
| `Deg`/`Metres` as the main unit work | The real confusions are basis and frame. | `Px<Basis>`, `Height<Datum>`, frame-tagged `FramePoint<F>`, `LonLatPair`/`LatLonPair` order brands. |
| Relations, pipeline registry, `Outcome<T>` adapters, dev page | Speculative: nothing consumes them. | **Cut.** Relations are inline `has` parts per concept (cardinality, drawn as a mermaid graph). |

The review also asked for adoption at real call sites, enforcement in CI, and runtime consumers. Done:
- CI fast-tier check `ontology`.
- The roll badges read their labels and their order from the ontology.
- Storage keys are built by `storageKey()`.
- picker and concord type their state with the canonical `AlignState`/`Verify`.

**Measured semantics.** The ontology is checked against behaviour, not only shapes:
- canonical `isTrustedAuto` equals picker `isAutoHigh` on all 23 reachable workspace states;
- concord's gate differs on exactly two states (recorded drift, see Findings in `reports/ontology.md`).

**v2 → v3.** A second review checked every mapping against the code it describes and found 18 defects.
Fixed:

- **Reachable workspace states were wrong.**
  - "verified" only confirms an `auto` preview.
  - `unverified` can coexist with `pending`.
  - A **stale-verdict path** exists: an eye move or restored save sets `manual`/`saved` without clearing an aborted verdict.
  - This is a real app bug, reported to the coordinator and listed in Findings.
  - v2's recorded concord drift (`near-compass`/`prior` + `verified`) was on unreachable states. The real drift is the 6 stale-verdict states, and it is now pinned.
- **A third accept gate was found:** nearfield `poseAccepted`. A new canonical predicate `workspaceIsSettled` (endorsed OR trusted auto) equals it on all 36 states, including the stale ones. The propagate `anchorKind` (no-chaining rule) equals the new canonical `isPropagationAnchor`.
- **Crosswalk fixes:**
  - `saved` no longer claims the user as agent (bundled sample poses also restore as `saved`).
  - `manual` no longer claims a drag (it also covers eye-search and refine re-runs).
  - `SolvedPose.method` "viewpoint" was never written, so it is removed. `viewpoint-bias` is a prior-shifting **rule**.
  - A `cascade` umbrella method is added, with a `CASCADE_STAGE` crosswalk for solve/refine.
  - `UNKNOWN_OUTCOME_SOURCE.none` is the placeholder default, not the EXIF prior.
  - Matcher `low` is any product-rule rejection.
  - Upload `positionSource:"pin"` means **not GPS**, because roll import stores track estimates as "pin". It now maps to `NOT_GPS`.
- **ids:**
  - `photoKind("demo-region")` no longer returns demo.
  - The photo-id minting site is corrected, and the FNV/SHA overlap is recorded.
  - The `preview-<i>` roll ids are registered.
- **confidence:**
  - The autoAlign "medium" bar is strict (`> 0.2`).
  - The matcher's legacy heuristic and the cascade's 0.75 bar are documented.
- **policies:** `rollEval` had no caller, so it is replaced by `rollStateless` (the real `ignoreStored` caller) plus an `evaluation` policy that withholds GT.
- **concepts:**
  - `foreground-mask` is split out of the sky mask.
  - Ground truth is realized by the newly exported `roll.ts GtEntry`.
  - Trail coords are `[lon, lat]` while the region centre is `[lat, lon]`: same record, opposite orders. Now typed and listed in Findings.

## 2. Principles

1. **Describe, then converge.** The ontology first *names* what exists: every existing union and type maps
   onto a canonical term. Code then moves onto the canonical types gradually, and each step changes types
   only, with no runtime drift.
2. **Exhaustive crosswalks, enforced by tsc.** A crosswalk is `satisfies Record<ExistingUnion, Canonical>`.
   Adding a member to `PoseSource` without classifying it is a compile error.
3. **Soft-branded quantities.** `Deg = number & {[unit]?: "deg"}`. A plain `number` still flows in, so
   adoption is free, but `Deg` → `Metres` is a type error. This makes the units explicit without a big-bang
   migration.
4. **Data, not prose.** Concepts, relations, sources, statuses, id schemes, storage keys and formats are
   runtime catalogues (frozen objects). Docs, the dev page and the checks are generated from them.
5. **Core is dependency-free.** `ontology/core/**` imports nothing from the app. Crosswalks and
   realizations import app *types* only (`import type`). Nothing in the ontology changes runtime behaviour
   except the small id and storage helpers, which existing code may delegate to.
6. **Open for extension.** Catalogues are typed by `const` tables, so new terms are one row. The concept
   type map is an interface (`ConceptShapes`), so a module can augment it.

## 3. Shape of the module

The layer map and the per-file contents are in [src/lib/ontology/README.md](../src/lib/ontology/README.md), which wins over any older text. In brief: L0 quantities (`Deg`, `Metres`, `Height<Datum>`, `Px<Basis>`), L1 geometry and frames (`Vec3`, `Mat3`, `LatLon`, `FramePoint<F>`, `BBox`), L3 epistemics (provenance axes, confidence scales, resolution policies), L4 meta (ids, storage registry, concept catalogue, crosswalks, generated `domain.ts`). The v1 designs that v2 replaced (one `Source` taxonomy with trust tiers, a status lattice with `verified`, global `precedence()`, `Estimate<T>`/`Outcome<T>` wrappers, relations and a pipeline registry) are in git history; §1b says why each was cut.

## 4. Adoption (type-only, zero runtime drift): outcome

Landed (39da866, edc485a, fac786f, 8fd383d, a477911): one canonical `Vec3`/`Mat3`; `ViewMode` (with `StyleMode` and `DeckStyleMode` aliasing it); `AlignState` and `Verify` in the ontology, used by picker and concord; a typed `SolveMethod`; photo-id predicates on the id-scheme registry; `ExportFormat` and `SplatExportFormat` as `FormatDescriptor<K>`; storage keys through `storageKey()`. The stale-verdict app bug from §1b was fixed in b9d29b1. Not built: a `/dev/ontology` page (the catalogue is browsed through the generated [ontology.md](ontology.md) and the Gipfelbuch `OntologyPanel`). The vocabulary entry point is `domain.ts`; later consolidation and open items are in [type-system-review-2026-10-01.md](type-system-review-2026-10-01.md).
