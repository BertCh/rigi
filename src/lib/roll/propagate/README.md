# Pose propagation in the camera roll (roadmap R5): suggestions only

When a photo has an accepted pose, it can suggest poses for overlapping neighbours in the same roll. The suggestion
comes from a relative rotation between the two photos. Everything here is opt-in and never accepts a pose on its own.

- **Flag**: `/roll/<id>?propagate=on`. The anchors are photos with a `saved` pose (the user saved it) or a `solved`
  pose (the roll aligner accepted it). The targets are photos with only the EXIF prior.
  `?propagate=dev` also lets the hand-fitted ground truth act as an anchor, makes every photo a target, and shows
  the angle between each suggestion and the photo's current pose.
  `?propagate=off` (the default) turns it off. Without the flag nothing renders, and the page is unchanged.
- **Service**: `tools/nearfield/propagate/run_service.sh` starts the service on `:8769`, or at `VITE_PROPAGATE_URL`.
  It runs on CPU and uses the same estimator as the study (`run_propagate.py` `rot`): ALIKED + LightGlue at a 1024 px
  long side, plus a pure-rotation RANSAC and a backward estimate. On 7063→7068 its output matches the study's
  cache exactly. If the service is down, the panel says so, the button is disabled, and no pose changes.
  Why a service: there is no in-browser ALIKED or LightGlue. DA3 `/multiview` on `:8767` is also not used, because
  it has no confidence signal and the gate rejects its method.
- **Gate**: `PROPAGATE_GATE` in `src/lib/nearfield/propagate.ts` is used unchanged. Pairs whose baseline is over
  250 m are skipped before the estimator runs. In mode `on`, pairs whose compass prior predicts no overlap are also
  skipped (the margin is 45°). Only the 8 nearest neighbours are sent to the estimator. A gated pair also gets a
  triplet-cycle check against the strongest other estimate from the same anchor.
  Every skipped or rejected neighbour shows its reason in the panel.
- **Cautions**: a gated suggestion can still carry a warning:
  - Baselines over 50 m show a parallax warning. `REPORT.txt` post hoc gives the bias as ≈ baseline / 3 km of
    terrain, which is 1.4° at 73 m.
  - Lenses with a vfov over 80° show an ultrawide warning.
- **Accept or dismiss**: suggestions are stored in `localStorage` under `rigi.propagate.v1`, with
  `provenance: "propagated-suggestion"` and status `pending`. Accept is always a user click. It writes the roll's
  solved-pose slot with `method: "propagated-suggestion"` and `confidence: 0`, so the pose is never HIGH.
  - A pose accepted this way never becomes an anchor itself (no chaining; see `PREREG_DRAFT.txt` §2).
  - Undo removes the pose only if it is still the propagated one.
  - Accept is enabled only on a prior-only photo: a saved, ground-truth or aligner-solved pose is never
    overwritten, and a second suggestion needs the first accept undone.
  - A re-run whose gate or cycle now rejects a pair drops that pair's pending card; accepted and dismissed
    decisions are kept as they were.
  - The roll GeoJSON export tags such a camera `poseMethod: "propagated-suggestion"` (absent otherwise).
- **Never** used in benchmarks, the accept rule or confidence. The gate has not been validated on held-out data.
  `tools/nearfield/propagate/PREREG_DRAFT.txt` needs sign-off before any stronger use.

## Invariants and where they are tested
All in `__tests__/` next to the modules (Vitest, service client mocked). `invariants.spec.ts` is the end-to-end set.
- Nothing is written to a pose slot without an explicit accept call (a run plus `persistRun` writes only the
  suggestion store): `invariants.spec.ts`.
- An accepted pose has method `propagated-suggestion`, confidence 0 and never anchors, in any mode:
  `invariants.spec.ts`, `store.spec.ts`, `plan.spec.ts` (`anchorKind`).
- `acceptSuggestion` returns false and writes nothing when the photo already has a saved, ground-truth or
  solved pose (the check lives in the store, not only the button); a second suggestion needs undo first:
  `invariants.spec.ts`.
- Undo removes only a still-propagated pose, and only for the accepted record: `invariants.spec.ts`, `store.spec.ts`.
- A re-run that now rejects drops only the pending card: `invariants.spec.ts`, `run.spec.ts`.
- Service down changes nothing; baseline over 250 m is skipped before the estimator; 8-nearest cap;
  compass skip only in mode `on`: `invariants.spec.ts`, `run.spec.ts`, `plan.spec.ts`.
- Parallax (over 50 m) and ultrawide (over 80 deg) warnings: `plan.spec.ts`.
- Export tags `poseMethod` only for propagated poses: `src/lib/roll/__tests__/export.spec.ts`.
- The store survives corrupt or missing localStorage: `store.spec.ts`.

Files: `plan.ts` (pure: eligibility, candidates, `propose`, cycle), `client.ts` (service), `run.ts` (orchestration),
`store.ts` (suggestions and decisions), `PropagatePanel.tsx` (UI), `flag.ts`. The hook is a few lines in
`src/routes/roll.$id.tsx`.

Checks:
- `npx tsx src/lib/roll/propagate/propagate.check.ts` runs in node against the study cache.
- `node scripts/gpu/with-render-lock.mjs -- node scripts/roll/propagate-ui.mjs` runs in the browser on the bundled
  Niederhorn roll. It needs the dev server on `:3100` and the service.
