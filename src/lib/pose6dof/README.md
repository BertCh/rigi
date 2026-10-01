# pose6dof: ground-control-point solver and position refinement

> Moved from an API note in `out/lead/` on 2026-09-29. Any `out/lead/...` test, sample or result path below is local-only (gitignored).

`src/lib/pose6dof/` is pure TypeScript. It has no DOM or three.js dependency and runs in the browser and in node. It imports only `src/lib/geodesy.ts`, and only from `geo.ts`.
Tests: `npx tsx scripts/test-pose6dof.ts [--quick]`. Results were in the gitignored `out/lead/pose6dof/results.md`.

## Conventions

The conventions are identical to `src/lib/pose.ts`, and the tests check them against it:

- **Frame:** camera-anchored ENU, with x = E, y = N, z = Up, in metres.
- **Angles:** yaw is the true heading, clockwise from north. Pitch is positive upward. Roll is positive when the right side is down. vfov is the vertical FOV. All are in degrees.
- **Image coordinates:** normalised `u, v` in 0..1, with v pointing down (the same as `projectPoint`).
- **Frame origin and eye (read this before integrating):** the solver works in whatever ENU frame the correspondences are in, and `priors.position.value` is the ABSOLUTE eye position in that frame. The app's renderers (`deck/engine.ts`, `deck-webgpu/engine.ts`) use `new EnuFrame(photo.lat, photo.lon, 0)`, which puts the origin at h = 0 (sea level), with the eye at `(0, 0, eyeAlt)` and `eyeAlt = max(alt, dem + 1.6)`. To work in that frame, build points with `engineFrame(lat, lon)` (the same frame) and pass `priorsFromPhoto(photo, { eye: [eye.x, eye.y, eye.z] })`. With the default position prior `[0,0,0]`, the solver projects from sea level. A regression test shows that this costs about 3° in pitch and roll.
- **`eyeOffset` is absolute, despite its name:** it is the solved eye position `[E, N, U]` in the same frame, seeded from `priors.position.value`. Use it as the new eye (`engine.eye.set(...res.eyeOffset)`). Never add it to the old eye. Pass it as `eye` to `applyPose` or `projectPoint`.

## Exports (`import … from '#/lib/pose6dof'`)

| export | purpose |
|---|---|
| `solvePose6dof(corrs, priors, opts) → SolveResult` | Full robust solver: RANSAC over minimal solvers, then LM with Huber loss and priors, following the DOF ladder |
| `refinePosition(pose, eye, residualFn, opts) → Promise<RefineResult>` | Generic LM over `dx, dy, dz` (plus optional yaw, pitch, roll and vfov) against any residual callback, sync or async |
| `skylineResidual(samples, predictV, imageHeight) → ResidualFn` | Adapter that turns observed skyline samples and a predicted-skyline function into a pixel residual |
| `project(pose, aspect, eye, {world}\|{dir}, withJacobian?)` | Projection with an analytic Jacobian with respect to `[dx,dy,dz,yaw,pitch,roll,vfov]`. It matches `pose.ts projectPoint` to 1e-14 |
| `projectPointArr`, `unproject`, `basis`, `poseFromAxes`, `dirFromAzEl`, `azElFromDir`, `focalPx`, `vfovFromFocal` | Projection and geometry helpers (array based) |
| `pointCorr(frame, lat, lon, ele, u, v)`, `dirCorr(az, el, u, v)`, `levelCorr(el, u, v)`, `azimuthCorr(az, u, v)`, `pxToUV(x, y, basisW, aspect)` | Build correspondences |
| `engineFrame(lat, lon)` | The renderer's frame, `EnuFrame(lat, lon, 0)`. Use it with `priorsFromPhoto(photo, {eye})` |
| `cameraFrame(lat, lon, h)` | A frame with its origin at (lat, lon, h). With `h = eyeAlt`, the eye is at the origin and the default prior `[0,0,0]` is right. Its coordinates are not engine world coordinates |
| `priorsFromPhoto(photo, {eye?, gravitySigma?, compassSigma?, vfovSigmaFrac?, sigmaV?})` | Builds priors from a `photos.json` entry. The position prior is `eye` (default `[0,0,0]`), with σH = max(hAccuracy, 5) m and σV = max(1.5·σH, 10) m. Gravity σ is 2°, compass σ 10° (unknown if there is no heading), vfov σ 3 % |
| `p3p`, `dlt`, `rotationFromBearings`, `vfovFromPair`, `yawFromOnePoint`, `absoluteOrientation`, `bearing` | Minimal solvers, exposed for reuse |
| `ladder`, `residualsPx`, `wrap180`, and the types `Correspondence`, `Priors`, `SolveOptions`, `SolveResult`, `Pose` | Supporting functions and types |

### Correspondence kinds

| kind | fields | equations | notes |
|---|---|---|---|
| `point` | `world: [e,n,u]` | 2 | A finite point. It is the only kind that informs position |
| `dir` | `dir: [e,n,u]` | 2 | An az/el direction at infinity. It is independent of the eye |
| `level` | `el` | 1 (counts 0.5) | Known elevation, unknown azimuth, such as a far shoreline. Gives pitch and roll |
| `azimuth` | `az` | 1 (counts 0.5) | Known azimuth, unknown elevation, such as a skyline feature at a DEM azimuth. Gives yaw |

Every kind accepts an optional per-point `sigmaPx` and `label`.

### DOF ladder

The ladder uses the effective point count n_eff among the inliers:

| n_eff | parameters solved |
|---|---|
| < 1 | pitch only (for example, a single level point) |
| 1 | + yaw, which also needs at least one azimuth-bearing correspondence |
| ≥ 2 (or ≥ 2 level points) | + roll |
| ≥ 3 | + vfov, if `solveFov` is set |
| ≥ 4 | + position, with priors |

Position unlocks only when two further conditions also hold:

- **Enough finite points:** there are at least `minFiniteForPosition` (default 3) finite points.
- **Observable parallax:** a 1σ horizontal GPS shift must move some finite point by at least `minParallaxPx` (default 2·σpx). Set `minParallaxPx: 0` to force the position solve.

With at least `relaxAt` (default 6) finite points, the position prior σ is multiplied by `relaxFactor` (default 5), so position can leave the prior.

A prior with **σ = 0 holds** its parameter exactly: it is removed from the active set and its σ is reported as 0. This applies to `position.sigmaH` (dx, dy) and `position.sigmaV` (dz) too. A σ that is undefined or `Infinity` means the value is unknown. A negative or NaN σ throws a `RangeError`.

Parameters that are not solved are held at their prior values. Their prior variance still feeds the reported σ of the solved parameters through a "consider covariance". This is how GPS error shows up in yaw σ when position is fixed.

### `SolveResult`

The result contains:

- `pose {yaw, pitch, roll, vfov}`, in exactly the pose.ts convention, with yaw in 0..360.
- `residualsPx[]`: the 2-D pixel miss for each correspondence (the 1-D miss for level and azimuth points), in pixels of `opts.imageWidth`.
- `inliers[]`: exactly the set the final LM fitted. Below `minPointsForRejection` (default 5) effective points nothing is rejected, so this is all true.
- `overThreshold[]`: residual > `inlierPx` (or NaN). This is a plain "large miss" flag, independent of rejection. With fewer than 5 points, a point can be over the threshold and still be fitted.
- `rmsPx`: RMS over `inliers` (the fitted set), so a large miss with fewer than 5 points is not hidden.
- `eyeOffset`: the absolute eye position (see Conventions).
- `sigma {dx,dy,dz,yaw,pitch,roll,vfov}`: 1σ from the covariance over the `inliers` set, scaled by the posterior variance factor when dof ≥ 3. Parameters that are not solved report their prior σ (0 if held, NaN if unknown).
- `covariance`, over the active parameters.
- `activeParams`.
- `init`: which minimal solver won. The values are `prior`, `yaw1`, `rot2`, `rot2f`, `p3p`, `dlt` or `dlt6`.
- `iterations`, `converged` and `cost`.

## Usage

```ts
import { engineFrame, pointCorr, dirCorr, levelCorr, priorsFromPhoto, solvePose6dof } from '#/lib/pose6dof'
import { applyPose } from '#/lib/pose'

const aspect = photo.width / photo.height
const frame = engineFrame(photo.lat, photo.lon)                     // == engine.frame (origin at h = 0)
const eye: [number, number, number] = [engine.eye.x, engine.eye.y, engine.eye.z] // (0, 0, eyeAlt)
const corrs = [
  pointCorr(frame, peak.lat, peak.lon, peak.ele, pin.u, pin.v, peak.name), // pin.u/v from the click, 0..1
  dirCorr(161.2, 4.3, 0.31, 0.29),                                  // DEM az/el (eye-independent)
  levelCorr(-0.04, 0.05, 0.47),                                     // far waterline
]
const res = solvePose6dof(corrs, priorsFromPhoto(photo, { eye }), { aspect, imageWidth: 1600, sigmaPx: 3 })
engine.eye.set(...res.eyeOffset)                                    // absolute: REPLACE the eye, don't add
applyPose(camera, res.pose, aspect, engine.eye)
```

## Integration steps for session 9e (owner of align.ts, deck/engine.ts and photo.$id.tsx)

1. **Pins.** Replace or extend `align.ts solvePins(prior, aspect, eye, pins, W, H, solveFov)`. Engine `Pin.world` is already in the engine frame, so convert each `Pin {u, v, world}` directly to `{kind:'point', u, v, world}`, or to `{kind:'dir', …}` for sky or DEM-direction pins.
   - **Priors:** build them with `priorsFromPhoto(photo, { eye })`, where `eye` is the same `eye` vector that solvePins receives (engine.eye = `(0, 0, eyeAlt)`). Do **not** use the default `[0,0,0]`: that is sea level in the engine frame.
   - **Solve:** call `solvePose6dof(corrs, priors, {aspect, imageWidth: W, solveFov})`.
   - **Apply the result:** use `res.pose` as the new pose and `res.eyeOffset` as the new eye. It is absolute: it equals the input eye whenever position is not solved, so replace the eye with it and never add it.
   - **Per-pin UI:** `res.inliers` is false only for pins that were actually rejected, which can happen only with 5 or more effective points. Colour those red. `res.overThreshold` marks large misses, even when they were kept. Show those amber. `res.residualsPx` gives the miss per pin, and `res.sigma` can drive an uncertainty badge.
2. **Near-field position (IMG_7068, IMG_7059).** This uses `refinePosition` with a skyline residual:
   ```ts
   const samples = skylineColumns.map((c) => ({ u: c.u, v: c.v }))          // from segment.ts sky mask
   const predictV = async (pose, eye, us) => renderHorizonV(pose, eye, us)  // horizon at a shifted eye, v per column, or null
   const res = await refinePosition(pose, eyeOffset, skylineResidual(samples, predictV, H), {
     params: ['dx', 'dy', 'dz', 'yaw', 'pitch', 'roll'],
     priors: { position: { value: eyeOffset, sigmaH: photo.hAccuracy, sigmaV: 20 } }, // absolute eye (engine frame)
     huber: 3, central: true,
     steps: { dx: 0.5, dy: 0.5, dz: 0.5, yaw: 0.005, pitch: 0.005, roll: 0.005 },
     grid: { radius: 2 * photo.hAccuracy, step: 7.5, dz: [-10, 0, 10] },    // near silhouettes have a narrow basin
   })
   ```
   The grid moves only the axes being refined. dx and dy must be in `params`, or the grid is skipped, and the `dz` values apply only when dz is refined. The grid cost includes the position prior. `eye`, `priors.position.value` and `res.eye` are all absolute positions in the engine frame. `renderHorizonV` can be the GPU horizon from `src/lib/gpu/horizon` or a CPU ray-march of the DEM from `eye`. Each call evaluates it once. The cost is (2r/step+1)² × |dz| for the grid, plus about 2·n_params+2 per LM iteration with `central`. Cache or downsample (80–120 columns is enough). Mark columns with no data as `null` to get NaN residuals; these are charged `nanPenalty`, not fitted. The callback can return any residual vector, for example control-point residuals concatenated with skyline residuals.
3. **Peaks.** Take them from `public/photos/region-*.json` and build them with `pointCorr(engineFrame(lat, lon), …)`. They are then in the same coordinates as the engine, and the refraction matches the renderer (k = 0.13 from geodesy.ts).

## Verified numbers (`results.md`, full run)

- **Consistency:** `project` matches `pose.ts projectPoint` to 7e-15 and `unprojectDir` to 3e-16. The analytic Jacobian matches finite differences to a relative error of 5e-7. The angles match session 0f's `geo/camera.ts` to 1e-12 px.
- **Review regressions (section 3c):** these tests cover the engine frame (h = 0, eye z = 560): the pose is exact, and `eyeOffset` equals the absolute eye. `engineFrame` with `{eye}` matches `cameraFrame(lat, lon, alt)` to 4e-9°. They also cover a set of 4 points with one 60 px miss: every point stays an inlier, the RMS includes the miss, and `overThreshold` flags it. They check that a σ of 0 holds a parameter, that position σ 0 gives finite σ for the other parameters, that a negative σ throws, and that the refinePosition grid moves only the refined axes.
- **Minimal solvers:** P3P, DLT and 2-point Horn each recovered the exact pose in 200/200 noise-free cases.
- **Synthetic sweep** (1950 trials; 3–15 points at 0.5–30 km; noise 0–3 px; 0–30 % outliers; GPS error 0–50 m):

  | points | success (all angles < 0.5°, vfov < 1°) |
  |---|---|
  | ≥ 6 | 99.3 % |
  | 4–5 | 94.7 % |
  | 3 | 55 % |

  With 3 points, position stays at the GPS fix by design, and the GPS error at the range of the nearest point dominates. The reported σ covers the error in 100 % of these cases.
  - **Overall error:** median 0.008° yaw, 0.009° pitch, 0.017° roll, 0.02° vfov.
  - **Position error:** median horizontal eye error 1.1 m against 17 m for the GPS prior.
  - **σ calibration:** 93 % of angle errors are within 2σ.
  - **Speed:** mean 3.6 ms per solve, p95 11 ms.
- **refinePosition:** a 31 m eye error with a near cliff at 100–400 m converged to 0.35–0.55 m, and the skyline RMS fell from 11.6 to 0.7 px.
- **Real labels:** these are a *consistency* check against session 0f, not an independent accuracy measure. `data/ground-truth.json` was produced by 0f's plain-LS solver on the same labels. The test uses the engine frame, with the eye at the GT `eye` height, and a fixed tolerance of 0.2°. Six photos are compared (the label set is well determined and every label resolves):
  - **LS mode:** 6/6 within 0.2° of the GT, with a median |Δ| of 0.033° yaw, 0.008° pitch and 0.013° roll and a maximum of 0.04°.
  - **Robust (Huber) mode:** 6/6 within 0.2°, with a maximum of 0.125°.
  - **Not compared:** 6 photos, with n_eff < 3 or with labels that name OSM node ids missing from the region files (IMG_7131, IMG_7059).
  - **Position:** it never unlocks on real labels (every peak is too far away). The unlock path is therefore covered by a synthetic near-field test instead: 0.4–3 km, 8 points, about 33 m of GPS error. Position unlocked in 60/60 runs, the median eye error was 1.3 m, and 56/60 runs had an eye error under 5 m with angles under 0.2°.

## Known limitations

- **P3P and hypothesis focal.** The P3P uses the prior vfov (known focal); there is no P4Pf. A vfov error of 2σ or more with outliers can cost 5-point cases. The LO stage (a Cauchy pass followed by Huber inlier tightening) recovers most of them.
- **Ladder with few points.** The ladder follows the spec. With 3 points, position is not solved, and with n_eff < 3, vfov is not solved. Accuracy is then limited by the priors, which the reported σ reflects. Use `forceParams`, `minFiniteForPosition` or `minParallaxPx` to override.
- **Numeric Jacobians for 1-D constraints.** Level and azimuth correspondences use central-difference Jacobians (4 extra evaluations each). Point and dir correspondences are analytic.
- **Label noise.** On hand labels, use `sigmaPx` of about 3 px at a 1600-px width. With 2 px, the Huber loss (k = 2σ) starts to down-weight 5–10 px label misses. On IMG_6958 this moves roll by 0.1–0.2° against plain LS.
- **refinePosition cost.** It evaluates the callback many times. Budget roughly 500 grid calls plus about 100 LM calls, or drop the grid when the start is within a few metres. It does not rescale the residual σ; pass residuals in pixels and set `huber` in pixels.
- **Peak heights.** They come from OSM `ele` in the region files. 0f's ground truth uses the maximum of the DEM local max and OSM, so heights can differ by a few metres. At more than 5 km this is sub-pixel.


## `refineEyeFromSkyline` API (src/lib/pose6dof/eye.ts)


`refineEyeFromSkyline` fits the camera position `(dE, dN, dU)` to a detected photo skyline. It recomputes the DEM horizon at each candidate eye and re-solves yaw, pitch and roll there (variable projection). The horizon is injected as a callback, so the module stays pure TypeScript. In short:

- It helps only on a high-resolution DEM (Mapterhorn) with a near (≤ 5 km) skyline, a poor rotation-only fit, and no occluders.
- On Terrarium it can fit a person in the frame instead of the terrain.
- It does not fix IMG_7059.

```ts
import { refineEyeFromSkyline, vfovFromFocal } from '#/lib/pose6dof'
import { computeHorizonFast } from '#/lib/horizon-fast'

// Skyline samples, normalised (u right, v down); w = detector weight
const samples = cols.map((x) => ({ u: (x + 0.5) / sky.width, v: sky.rows[x] / sky.height, w: sky.weight[x] }))
const pose0 = { yaw, pitch, roll, vfov: vfovFromFocal(f, H) }   // e.g. from solvePose at the GPS eye
const eye0: [number, number, number] = [0, 0, eyeAlt]           // local ENU at the GPS fix, U = MSL
const res = await refineEyeFromSkyline(samples, pose0, eye0,
  (e) => sectorHorizon(mosaics, toLatLon(e[0], e[1]), e[2]),     // {step, elevation[, distance]}; ≤ -89 = no data
  { aspect: W / H, imageHeight: sky.height, sigmaH: photo.hAccuracy, sigmaV: 50,
    ground: (dE, dN) => demHeight(toLatLon(dE, dN)), clearance: 1.5 })   // aboveGround default {1.6, σ 3, cap 10}
if (res.moved) { useEye(res.eye); usePose(res.pose) }            // else res.pose is the rotation-only fit at eye0
```

| field or option | meaning |
|---|---|
| `res.eye` / `res.shift` | Absolute eye in the caller's frame, and eye − eye0 in metres. Both equal eye0 / 0 unless `moved`. |
| `res.refinedEye` | The best eye found, whether or not it passed the gain gate. |
| `res.moved` | True when the normalised cost fell by at least `minGain` (default 2; 5–10 is safer). |
| `res.before` / `res.after` | `SkylineFit`: the pose, the normalised cost, residuals in px, and `rmsInlierPx`, `medianAbsPx`, `inlierFrac` and `meanClippedPx`. `before` is at eye0; `after` is at `refinedEye`. |
| `res.gridBest`, `res.sigma`, `res.clamped` | The best coarse-grid cell, the LM 1σ in metres, and whether the eye sits on the ground clamp. |
| `res.horizonCalls`, `res.cacheHits`, `res.ms` | Cost. Horizons are cached at 0.25 m. |
| `grid` | Default: a disc of radius min(60, 2σH) m at a 20 m step, with dz ∈ {−100, −60, −30, 0, 30, 60, 100}. `false` runs LM only. |
| `ground`, `clearance` | Keep the eye at or above DEM + 1.5 m at every shifted position. |
| `aboveGround` | Limits on height above `ground`, relative to max(nominal, start height above ground). Soft: an eye more than `height` above the DEM costs (excess / `sigma`)². Hard: the eye is clamped to at most `max` above the DEM. Default `{ height: 1.6, sigma: 3, max: 10 }`. `false` turns both off and restores the old floor-only behaviour, which let the eye float 26 m over the Niederhorn cliff. An eye sitting on the cap means "not trustworthy". |
| `res.aboveGroundM`, `res.refinedAboveGroundM` | Height above `ground` of the returned / refined eye. |
| `cauchy`, `sigmaPx`, `effectiveSamples` | Robust scale (4 px). The data term is normalised to 60 independent 2 px observations, because columns are correlated. This makes the σH and σV priors meaningful. |
| `rotationSigma`, `priorPose` | Rotation priors: 5°, 3° and 3° around pose0. vfov is held. |

Also exported:

- `fitRotationToHorizon(samples, horizon, start, opts)`: the rotation-only Cauchy fit at a fixed eye.
- `skylineResidualsPx(samples, horizon, pose, aspect, H)`: the per-sample px residuals.

Self-checks (synthetic ridge, exact horizon): `npx tsx src/lib/pose6dof/eye.check.ts`, or call `runEyeChecks()` from it.

**Cost:** about (grid cells + 7 per LM iteration) horizon calls. In node this measured 2–42 s per photo, with 30–210 calls at 30–175 ms each (horizon-fast, sector only). Trim the grid for the UI.
