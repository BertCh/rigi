# src/lib/ontology: Rigi's semantic type layer

This module names every concept once. It defines the axes along which a value is known (provenance,
confidence, units, frames, ids, storage) and maps every existing app type and union onto them.

**Start with `domain.ts`.** It is the problem space as types: one exported type per concept (`Photo`,
`Orientation`, `Horizon`, `Skyline`, `PoseEstimate`, `PeakLabel`, …), grouped by stage (capture → world →
camera → evidence → estimate → presentation → interchange → system), each bound to its canonical
realization and documented with the catalogue's definition. Write `import type { Orientation } from
"#/lib/ontology/domain"` when a signature talks about the concept rather than one module's representation.

- Generated reference: `reports/ontology.md`.
- Design and review history: `reports/ontology-design.md`; type-system review and open items: `reports/type-system-review-2026-10-01.md`.

```
core/quantity     L0  Deg Rad Metres Height<Datum> Px<Basis> Norm Prob Millis Seconds IsoTime; HeightDatum; PixelBasis + rebasePx
core/geometry     L1  Vec3 Mat3 Size LatLon GeoPoint FrameId FramePoint<F> Direction ImagePoint<B> BBox (+WSEN/SWNE) LonLatPair/LatLonPair
core/provenance   L3  AGENTS EVIDENCE ROLES STATUSES OUTCOMES METHODS; Provenance (sidecar), ProvenanceClass, isTrustedAuto
core/confidence   L3  CONFIDENCE_SCALES, Confidence, levelOf, compareLevel
core/resolution   L3  RESOLUTION_POLICIES (rollDisplay, rollStateless, evaluation, workspace), rankUnder, resolve
core/ids          L4  ID_SCHEMES, classifyId, photoKind, Ref, toUrn/parseUrn
core/storage      L4  STORAGE (every key/store/file), storageKey, storageEntryOf
catalogue/        L4  CONCEPTS (definitions, UI/code/avoid words, parts, realizations), FINDINGS
crosswalk/        L4  app unions → canonical axes (pose, world, presentation); AlignState, Verify, SolveMethod, FormatDescriptor
checks/           compile-time only: realizations.ts (generated)
doc.ts            renders reports/ontology.md
domain.ts         GENERATED: concept name → canonical type (the vocabulary); generate.ts renders it
ontology.check.ts runtime integrity + "canonical semantics == app behaviour"
```

## Rules

- **Soft brands.** A plain `number` is assignable to `Deg`, `Metres`, `Px<"wide1600">` and the rest, but
  two different units never mix. Put brands on interfaces (fields and signatures), not on expressions.
- **Provenance has separate axes.** Never invent a new `source: "a" | "b"` union. Describe the value as
  `{agent, method, evidence, role, status, outcome, corroborated, level}`. If an app union has to
  exist, add a crosswalk row for it.
- **The sidecar never wraps.** Write `pose` plus `poseProv: Provenance`, not `{value: pose, …}`.
- **Never compare scores across scales.** Use `levelOf(scale, score)` and compare the levels.
- **"Which estimate wins" is a policy.** Choose among estimates with a `ResolutionPolicy`, never with
  a global ranking of sources.
- **Import from the specific module** (`#/lib/ontology/core/storage`), not the barrel, in hot or
  worker code. The core has no app imports and no side effects. Crosswalks import app types with
  `import type` only.

## How to …

| task | do |
|---|---|
| add a concept | Add a row to `catalogue/concepts.ts`, then run `npx tsx scripts/ontology/gen-realizations.ts` (realizations + `domain.ts`) and `npx tsx scripts/ontology/doc.ts` |
| name a new exported type | Pick a name no other export uses (the check's homonym rule is in `FINDINGS`); if it realizes a concept, add it to that concept's `realizedBy` |
| add a value to an app union that has a crosswalk | tsc fails in `crosswalk/*`. Classify the new value there. |
| add a new provenance-like union | Prefer `Provenance` directly. Otherwise add a `satisfies Record<YourUnion, ProvenanceClass>` table and list it in `doc.ts` CROSSWALKS |
| add a method or algorithm | Add a row to `METHODS` with its agent, evidence, estimates and module |
| persist something | Add a `STORAGE` row and build keys with `storageKey(id, …)`. The check fails on any unregistered `rigi.`, `rigi-uploads` or `rigi-tiles-` literal. |
| mint a new id kind | Add an `ID_SCHEMES` row (most specific first) with an example |
| record a semantic disagreement | Add a `FINDINGS` row. If it can be measured, pin it in `ontology.check.ts` |

## Checks

- `npx tsc --noEmit -p .` checks that crosswalks are exhaustive and every realization exists.
- `npx tsx src/lib/ontology/ontology.check.ts` (CI fast tier, id `ontology`) checks catalogue
  integrity, id schemes against the data on disk, the storage registry, the thresholds, and that
  canonical semantics match app behaviour (picker HIGH and resolvePose order). It also checks that
  the generated doc is current.
