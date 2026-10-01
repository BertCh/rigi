# Type-system review (2026-10-01)

A repo-wide review of how Rigi's types describe its problem, and the consolidation that followed. Six read-only surveys covered geometry primitives, camera and pose, terrain/horizon/peaks, provenance and storage adoption, the render and compute engines, and app records with dead code. Every change below is type-level, or behaviour-identical by construction, and each wave passed tsc and the fast tier on a clean clone of HEAD.

## The problem space, as types

`src/lib/ontology/domain.ts` is the entry point. It is generated from the concept catalogue and has one exported type per concept, named with the concept's own word and bound to its canonical realization. Each type carries the catalogue definition as JSDoc. The concepts are grouped in pipeline order:

| stage | concepts |
|---|---|
| capture | `Photo`, `RawExif`, `CameraPrior`, `PriorUnknowns`, `Roll`, `Viewpoint`, `Library` |
| world | `Region`, `Feature`, `Peak`, `Trail`, `Terrain`, `DemSource`, `DemTile`, `Tiles3dSource` |
| camera | `Camera`, `Orientation`, `Intrinsics`, `Eye`, `GeoPosition`, `EyeRule` |
| evidence | `Horizon` (modelled), `Skyline` (observed), `SkyMask`, `ForegroundMask`, `Correspondence`, `Pin`, `Cue` |
| estimate | `PoseEstimate`, `Candidate`, `SolveResult`, `Provenance`, `Confidence`, `GroundTruth`, `Suggestion` |
| presentation | `ViewMode`, `BlendMethod`, `Look`, `LookPreset`, `PeakLabel`, `Reveal`, `StepInside` |
| interchange | `ExportFormat`, `PoseFile` |
| system | `Renderer`, `Flag`, `Settings` |

Under the domain layer, the ontology core provides the axes:
- **Units:** `Deg`, `Metres`, `Height<Datum>` and `Px<Basis>`.
- **Geometry and frames:** `Vec3`, `Mat3`, `Size`, `LatLon`, `BBox`/`WSEN`/`SWNE`, `FramePoint<F>` and `ByteMask`.
- **Estimates:** provenance (agent, method, evidence, role, status), confidence scales and resolution policies.
- **Persistence:** ids and storage keys.

## What changed

| commit | change |
|---|---|
| fac786f | One canonical `Vec3`/`Mat3`/`LatLon`/`SWNE`/`Size`. It replaced 21 local `V3`/`Eye` aliases and 9 exported copies. A new `ByteMask` covers `FgMask`, `ForegroundMask`, two `ByteMask` copies and the photo-sky `SkyMask`. `HeightFn` is now declared once. Six hand-built storage keys now go through `storageKey()`, and the check fails on any spelled-out key. Two confidence bars are now read through `levelOf`. |
| 8fd383d | `domain.ts` vocabulary, rendered by `generate.ts` and checked current in CI. Same-name exports are renamed: `ExifPhotoMeta`, `SkylineSolveResult`/`GcpSolveResult`, `RefineConfidence`, `PeakLabelPx`/`BaselinePeakLabel`, `GeoJsonPeak`/`RidgelinePeakInput`, `FitParams`/`GcpParams` and `CompositeLookStyle`. A new rule requires catalogued types to have unique names. Missing realizations were added, with a note on the four intrinsics shapes. |
| a477911 | `CascadeStage` is declared once (it had 4 copies). `?style=` is read through `lib/flags`. The relative-rotation and spot-depth unions are crosswalked to `METHODS`. 35 exports with no importer are now module-local. |
| (renderer) | The `Renderer` interface requires the nine members both engines implement, so call sites drop `?.`. The dead `nearFieldSampleAt` member, which nothing implemented or called, is removed. |

## Open, by value

1. **Height datum is only partly carried by world types.**
   - DEM, peak and horizon heights are MSL (EGM2008), and Google 3D Tiles heights are ellipsoidal.
   - Done: `TerrainSampler.sample`, `Peak.ele`, `RegionPeak.ele`, `PoolPeak.ele` and `PhotoMeta.alt` are `Height<"msl">`, so an ellipsoidal height no longer assigns to them.
   - `DemRaster.heights` is documented as MSL. A `Float32Array` cannot carry the brand.
   - Next step: the `HorizonProfile` eye height and the tiles3d frame.
2. **Peak elevation nullability differs.** `Peak.ele` is optional, while `RegionPeak`, `PoolPeak`, `LabelCandidate` and `settings.PeakLabel` use `number | null`. `MISSING` in `core/quantity.ts` says `null`.
3. **The engine escape hatches cluster.**
   - deck.gl internals peeks: about 17.
   - Raw GPU handle casts: about 26.
   - `as unknown as ShaderModule`: 13.
   - Each cluster wants one typed accessor. These are owned by the WebGPU/compute sessions and coordinate with the WAG plan.
4. **Homonyms outside the catalogue remain.**
   - Two `RidgeTops`, in roll/mosaic and gpu/horizon. They are structurally equal, but gpu/horizon is in flight.
   - `Mask8` (it also accepts `Uint8ClampedArray`).
   - The atlas-page `Verdict` types.
   - Generic `State`/`Params`/`Source` names in about 15 files.
5. **Module names and boundaries.**
   - `align.ts` is skyline refinement plus the pin solve.
   - `pose.ts` is the three.js adapter, while `camera/` is the model.
   - `geo/` overlaps top-level `terrain.ts`, `refine/` and `horizon-fast/`.
   - UI components live under `src/lib` (export, upload, picker, roll).
   - `PhotoWorkspace.tsx` (2135 lines) mixes state, engine wiring, persistence and the matcher.
6. **Wire formats.**
   - The matcher request and response are mirrored by hand in Python.
   - The `.splat-v1` header (`GaussianMeta`) is parsed with an unchecked cast.
7. **Naming.** `yaw` and `heading` are used for the same quantity. The ontology's `Direction` uses `az`/`el`.

Parked research in `src/lib/geocam` was deliberately left untouched and is never bound in `domain.ts`.
