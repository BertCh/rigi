# Step ⑥ pose-estimate: review, research, plan (2026-10-02)

Gipfelbuch node `pose-estimate` ("One small record is the whole camera"), `src/lib/gipfelbuch/graph.ts:173-204`. Step lead: Opus pod for mt-image-17. Cook mode: no browser runs. Everything below was checked with node/Vitest only.

## 1. Current state

| piece | where | what it is |
|---|---|---|
| `Pose` (canonical) | `src/lib/camera/index.ts:16` | `{yaw, pitch, roll, vfov}` in degrees. Camera-anchored ENU: yaw is clockwise from true north, pitch up is +, roll right-side-down is +. **Not in the node's `modules`.** |
| pixel `Camera` | `src/lib/geo/camera.ts:16-29` | The solvers' f/cx/cy plus ENU rows. `poseToCamera`/`cameraToPose` (`camera/index.ts:107-121`) convert. |
| three.js adapter | `src/lib/pose.ts` | Bitwise equal to `camera.poseBasis` (`src/lib/__tests__/pose.spec.ts`). Still used by the deck engines and export. |
| 6-DoF result | `src/lib/pose6dof/types.ts:111-152` | `GcpSolveResult`: `pose`, absolute `eyeOffset`, per-parameter `sigma`, covariance. This is the only producer that carries a real per-angle uncertainty. |
| roll record | `src/lib/roll/types.ts:16-25` | `SolvedPose {pose, confidence, method, at}`. The ontology binds `PoseEstimate` to it (`src/lib/ontology/domain.ts:259`). |
| demo record | `src/lib/demo/index.ts:22-26` | `DemoPose {pose, source, confidence}`. |
| provenance | `src/lib/ontology/crosswalk/pose.ts` | `POSE_SOURCE`, `ALIGN_STATE`, `workspaceProvenance(alignState, verify)`. |
| persistence | `src/lib/photos.ts:114-135` (saved pose, validated); `src/lib/roll/roll.ts:43-61` (solved pose, **not validated**) | localStorage. |
| export | `src/lib/export/{camera,pose-json,xmp,kml,colmap,geojson}.ts` | `summit-lens/pose` v1 JSON, XMP (EXIF GPS + GPano + `slens`), KML, COLMAP, GeoJSON. Conventions are verified in `scripts/test-export.ts` and `src/lib/export/__tests__`. |

The eye travels beside the Pose, not inside it: `engine.eye` is ENU metres in `EnuFrame(lat, lon, 0)`, `eyeAlt` is in metres MSL, and `GcpSolveResult.eyeOffset` is absolute. Provenance also travels beside it (`alignState`, `SolvedPose.method`). Each solver returns its own result shape with a `Pose` inside: `AlignResult` (`align.ts`), `SkylineSolveResult` (`geo/solve.ts`), `GcpSolveResult`, `RefineResult`, `MatchResult` and `UnknownPoseResult`.

## 2. Findings, ranked

- **P1. Exports did not say how the pose is known.** `PhotoWorkspace.tsx:1153` unlocks exports for any settled pose, including the "Phone sensors" compass prior and "Unverified" (`ALIGN_STATE`). The pose JSON, XMP and COLMAP files of a prior looked exactly like an accepted pose's. That contradicts the project rule "a wrong pose is worse than no pose" once the file leaves the app. → U3 (landed); the workspace wiring is W1 (needs the photo-workspace owner).
- **P1. `loadSolvedPose` trusts localStorage** (`roll/roll.ts:43-53`, an unchecked `JSON.parse(raw) as SolvedPose`). `JSON.stringify(NaN)` writes `null`, so one bad write reaches the renderer as `yaw: null`. `loadSavedPose` (`photos.ts:114-127`) already guards this. → `isPose` landed (U1); adopting it is W2 (needs the camera-roll owner).
- **P2. There was no reader for the pose JSON**, although `export/README.md` lists "re-import" as a consumer. → U2 `readPoseJson` (landed).
- **P2. The doc for the roll sign in `geo/camera.ts` `CameraParams.roll` was wrong.** It said "positive = clockwise image rotation of the scene". The math (and `Camera.roll`, `camera/index`, GPano) means the camera is turned clockwise and the horizon turns counterclockwise in the image. The code was right and only the comment was wrong. Fixed, with a spec that pins the sign (U1).
- **P2. No spec tied the three representations together.** Pose, pixel Camera and the OpenCV R each had their own specs, but nothing proved they project the same pixel or that R is proper. → `pose-invariants.spec.ts` (U1). A deliberate roll sign flip in `poseToCamera` fails 3 of its cases (checked).
- **P2. Uncertainty is dropped at every boundary.** `GcpSolveResult.sigma` and the covariance are computed and then lost. `SolvedPose`, the saved pose and the exports keep at most a scalar confidence. U3 gives exports a `sigmaDeg` slot. Filling it from the pin solve is W1b.
- **P3. Local copies of `Pose`:** `scripts/gpu/precision-gate-node.ts:102`, `scripts/gpu/precision-gate-score.d.mts:6`, `scripts/geocam/ga5-eval.ts:61`, `src/components/site/how/model.ts:10` (`Angles`) and `src/components/site/lineArt.ts:198`. All are structurally equal. Fold them in when those owners touch the files.
- **P3. Hand-rolled angle wrapping** outside `geodesy.wrap180/wrap360`: `demo/index.ts:138`, `matcher-client.ts:440`, `gpu/eye/bench.ts:114`. They are equivalent today.
- **P3. `geo/camera.ts:71` `focalPx`** is `focalPxFromF35` without the crop handling. Its callers are `baseline-ui/BaselinePage.tsx:93` and `scripts/gpu/baseline-worker-check.mjs:63`. It is harmless, but it is a second focal path.
- **P3. Naming:** `yaw` and `heading` mean the same quantity (type-system review, open item 7). The `summit-lens/pose` schema id and the `slens` namespace keep the old brand on purpose (`ontology/core/storage.ts:162-176`). Never rename them.
- Not a bug: `cameraFromGravity` is singular at pitch = ±90° (`fh` = 0/0). Mountain photos never reach it. The new spec covers |pitch| ≤ 89.5° and checks that the basis agrees there, where yaw and roll individually become ill-conditioned.

## 3. Research summary

- **OGC GeoPose 1.0 Basic-YPR** (schema https://schemas.opengis.net/geopose/1.0/schemata/GeoPose.Basic.YPR.Schema.json; standard https://docs.ogc.org/is/21-056r11/21-056r11.html, §7.2.1). The JSON is `{"position": {"lat", "lon", "h"}, "angles": {"yaw", "pitch", "roll"}}`. `h` is metres above the WGS-84 ellipsoid. The angles are "three consecutive rotations of a reference frame oriented East-North-Up … about the local (rotated) axes z, y, and x, applied in that order". The standard does **not** say which body axis is the camera's forward axis, and it gives no positive sense beyond the right-handed LTP. With the common x-forward, y-left, z-up reading, the mapping would be `geoYaw = 90 − yaw`, `geoPitch = −pitch`, `geoRoll = roll`. That reading is an assumption, not text from the standard, so a GeoPose export needs an explicit body-frame note. **Deferred (L2).** There is no covariance field.
- **GPano** (XMP `PoseHeadingDegrees`/`PosePitchDegrees`/`PoseRollDegrees`): the existing `xmp.ts` header already quotes the roll sign. It is unchanged.
- **EXIF** `GPSImgDirection` + `GPSImgDirectionRef="T"` is already written. `GPSHPositioningError` exists in EXIF 2.31 and could carry the horizontal σ of the eye. That is L3, once an eye σ exists.
- **COLMAP** `images.txt` (world→camera qvec/tvec, OpenCV axes) is already exported and verified.
- **Our own records:** the type-system review (`reports/type-system-review-2026-10-01.md`, open items 5-7) and the ontology `PoseEstimate`/`PoseFile` concepts. No recorded negative touches the pose record or the exports.

## 4. Plan

| unit | size | risk | gate | state |
|---|---|---|---|---|
| U1 `isPose` + pose-invariants spec + roll doc fix | S | none (additive) | vitest camera, tsc | **landed** (see §6) |
| U2 `readPoseJson` fail-closed reader + round-trip spec | S | none (new export) | vitest export | **landed** |
| U3 `PoseEstimateNote` → pose JSON `estimate`, XMP `slens:Pose*`, untrusted-export note, ExportMenu/engine pass-through | M | low: unwired, only `"estimate": null` is new in today's files | vitest export, tsc | **landed** |
| W1 workspace wiring: `PhotoWorkspace.tsx:1423` `<ExportMenu estimate={{provenance: workspaceProvenance(alignState, verify), label: ALIGN_STATE[alignState].label}} …/>` | XS | low; user-visible export note | photo-workspace owner; browser batch row | **proposed** (photo-workspace owns the file) |
| W1b pin-solve σ: pass `GcpSolveResult.sigma` (yaw/pitch/roll/vfov) as `sigmaDeg` while `alignState === "pinned"` | S | low | same | proposed |
| W2 `roll.ts loadSolvedPose`: `return s && isPose(s.pose) && Number.isFinite(s.confidence) ? s : null`; `photos.ts loadSavedPose` → `isPose(p) ? p : null` (bit-identical rule) | XS | none | vitest roll, photos | **proposed** (camera-roll / photo own the files) |
| L1 import UI: "Open pose file" in the workspace through `readPoseJson`, as a person's endorsed pose | M | medium (UI) | user decision | later |
| L2 OGC GeoPose Basic-YPR export with an explicit body-frame note | S | the convention is ambiguous in the standard | user decision: is an interop target asked for? | later |
| L3 eye σ in the pose record and EXIF `GPSHPositioningError` | M | needs a real eye-σ producer | after the eye-rule work | later |
| L4 fold the P3 local `Pose` copies and the angle wraps | XS each | none | owners' passes | later |

Needs the user: L1 (import UI) and L2 (GeoPose: which body frame, and whether it is wanted at all).

## 5. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts is not edited here)

- **summary** (the current text says that every solver reads and writes the same record, with the camera position in it, and that is not true): "The answer is four angles: direction, tilt, roll and field of view. The eye position (local metres) and how it is known travel beside them. Every solver hands back this same four-angle record inside its own result, and exports carry all three."
- **modules:** add `src/lib/camera/index.ts` (where `Pose` lives) and `src/lib/export/pose-json.ts`. Keep `geo/camera.ts`, `roll/types.ts` and `pose6dof/README.md`. `src/lib/pose.ts` is only the three.js adapter.
- **lede** is fine. **claim** "One small record is the whole camera" holds for the orientation and lens, not the eye. A more precise version is "Four numbers are the whole view."

## 6. Iteration log

- **Iteration 1** (Opus): U1-U3 implemented in `step/pose-estimate-a`. A mutation check flipped the roll sign in `poseToCamera`, and 3 invariant cases failed, as they should.
- **Review 1** (Sonnet, adversarial): no blockers. It ran 20 000 random build→read round trips (pitch up to ±90°, yaw at 360−1e-6, vfov 179.9) with 0 failures, so `ROTATION_TOL = 1e-6` is safe. It raised three should-fix items:
  - a file could still make its pose `trusted` through the provenance words it claims
  - the returned `json` was a spread of the raw file, so unvalidated and stale fields survived
  - the frame lat/lon were not bounded
- **Iteration 2** (fixes): the reader now returns the file's provenance only as `claimed`, with `json.estimate.trusted` always false. `json` is re-derived through `buildPoseJson(input)`. Frame lat/lon are bounded and `fx` is cross-checked against the vfov. Specs were added for each point. The README bullet placement was fixed.
- **Gates (worktree):** `npx vitest run src/lib/export src/lib/camera` gives 219 passed. `tsc --noEmit` is clean, biome is clean on the changed files, and spdx is OK. Fast tier: see the commit.
- **Worktree artefact, not a regression:** in a worktree with a symlinked `node_modules`, `src/lib/upload/__tests__/index.spec.tsx` fails with Vite "Denied ID …libheif-bundle.mjs?url", and the python-unit rows fail. The same upload spec passes in the main tree.
- CHANGELOG: land.py refused the CHANGELOG hunk because it conflicts with a peer's uncommitted edit. The entry to append later is: "Pose exports say how the pose is known (`src/lib/export`): an `estimate` block in `summit-lens/pose` v1 (`null` when unknown), `slens:Pose*` XMP tags, a 'Pose not verified' export note, the fail-closed `readPoseJson`, and `isPose`. The workspace is not wired yet (W1)."
- Nothing is browser-relevant: all changes are pure TS export/model code, so there is no batch-ledger row. The browser check comes with W1.
