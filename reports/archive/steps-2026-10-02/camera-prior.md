# Step ② camera-prior: review, research, plan (2026-10-02)

Gipfelbuch node `camera-prior` ("The sensors get close. The compass drifts."). Step lead: Opus pod under
coordinator mt-image-17. Dev split and the demo/GT-12 photos only; no test-half or data_v3 input. Numbers
below are calibration observations, not results.

## 1. Current state (what the code really does)

The node lists `src/lib/pose6dof/types.ts` and `src/lib/geocam/priors/photo-priors.ts`. **Neither is on the
live path.** `mapPriorsFromPhoto` has no app caller (scripts/geocam only) and `pose6dof` has no app importer.
The live camera prior is built in four places:

| Stage | Where | Prior / window |
|---|---|---|
| Ingest (uploads) | `src/lib/upload/exif.ts:289-384` | heading = `GPSImgDirection` or null (`yawUnknown`); pitch/roll from Apple MakerNote 0x0008 gravity or 0 (`pitchRollUnknown`); f35 default 26; `local.headingRef` kept |
| Ingest (bundled) | `scripts/ingest.mjs:260-280` | same fields, but **drops `GPSImgDirectionRef`** and ignores `GPSAltitudeRef` |
| Engine prior | `deck/engine.ts:584-590`, `deck-webgpu/engine.ts:739-745` | `{yaw: priorHeading(photo) ?? 0, pitch, roll, vfov}`; `photoUnknowns` (`integration/unknown-pose.ts:47`) |
| Skyline solve | `geo/solve.ts:249-273, 354-396` | local yaw ±25° (σ 15°, quadratic), pitch ±3° (σ 1.5°), focal σ 6 %; on reject a 360° search at confidence 0.75 |
| autoAlign | `deck/engine.ts:2313-2323`, `align.ts:377, 650-655` | yaw ±25°, pitch ±6°; descent σ yaw 20°, pitch 2.5°, roll 4°, vfov 8 % |
| Unknowns freed | `integration/unknown-pose-core.ts:55-83` (pod B owns) | yaw unknown → 360°, σ 1e6, 0.75; gravity unknown → pitch ±15° σ 10°; focal unknown → hfov seeds 40/50/65° |
| Eye search | `gpu/eye/client.ts:55`, `pose6dof/eye.ts:351-455` | σH = hAcc ?? 20 (min 5), radius min(60, 2σH) |
| Declination | `geocam/priors/heading.ts:30-41` | only behind `?geoDecl=on` (default off, `flags/index.ts:187`), only for uploads with ref "M" |

The precision guard is structural and sound: a compass outside the ±25° window can only be rescued by the
360° pass, which has the stricter 0.75 bar (it exists because a 0.5 bar accepted IMG_7053 at −123.7°).

## 2. Observed prior error (dev split + demo set)

`tools/research/geo/prior_audit.py` (this pod) against the blind-verified dev refs (30 of 50 dev photos have
a correct ref):

| Prior | n | median | p90 | max | inside the live window |
|---|---|---|---|---|---|
| Heading, Commons location template | 20 | 4.4° | 25.0° | 143.7° | 17/20 within ±25° (2 gross: 83°, 144°; wc_0011 at 25.008°) |
| Heading, EXIF phone | 1 | 177° | – | – | 0/1 (wc_0071, iPhone 5s: a 180° flip) |
| Focal (FocalLengthIn35mmFormat → vfov) | 23 | 2.1 % | 7.5 % | 19.4 % | 20/23 within σ 6 %, 22/23 within 2σ; median ratio 1.003 (no bias) |

Demo set (12 iPhone photos, one 20-minute session, `public/demo/gipfelbuch/index.json`): |yaw| median ≈ 8°,
max 19.0° (demo-10); errors of photos seconds apart agree to ~1° (01/02, 09/10, 11/12), i.e. the compass
error is a **slowly varying bias, not per-shot noise**. Pitch from gravity within 2.7°. Solved focal is
2–5 % longer than the EXIF prior on 12/12 (no such bias on the dev iPhones; n = 1 session, so not acted on).

Only 2 dev photos carry an EXIF heading, so **the dev split cannot calibrate a phone-compass width**. GA0
reached the same wall: every bundled photo is true-north, so declination changes nothing measurable.

## 3. Findings (ranked)

**P1**
1. *Gipfelbuch claim vs code.* The page says the compass is "corrected for declination" and quotes widths
   "5° noise + 5° bias, gravity 1.5°" — those are the unwired geocam MAP defaults (`geocam/map/factors.ts`);
   declination is off by default; the live solve uses σ 15° in a ±25° window then a 360° pass. See §7.
2. *Declination is silently inert or inconsistent.* Bundled photos never carry the ref (`ingest.mjs`), and
   the roll feature reads raw `meta.heading` (`roll/roll.ts:79`, `roll/propagate/plan.ts:106-109`,
   `roll/align/viewpoint.ts:60`, `roll/align/align.ts:356`), so with `geoDecl=on` the roll yaw-bias compares
   a corrected solve against an uncorrected heading. Owned by the camera-roll step; proposal in §6.
3. *Heading slider clamp* (`PhotoWorkspace.tsx:2087`): range = raw heading ± 40 with the yaw not unwrapped,
   so a heading near north whose solve wraps (358° → 2°) was clamped to the range end. **Fixed** (§5).

**P2**
4. `pose6dof/geo.ts:116-130` `priorsFromPhoto`: tested `=== undefined`, but `PhotoMeta` stores null, so a
   missing heading became a confident yaw prior at 0° (σ 10°). No app caller. **Fixed** (§5).
5. Eight different σH rules (`concord/priors/altitude.ts:64`, `geocam/priors/photo-priors.ts:69`,
   `pose6dof/geo.ts:106`, `refine/index.ts:147` (no clamp; hAcc 0 removes the GPS term), `gpu/eye/client.ts:55`,
   `deck/scene.ts:64`, `look/composite.ts:95`, `PhotoWorkspace.tsx:258`) and four yaw σ (20/15/10/7.07°).
   No single prior table. Proposal U6.
6. 180° heading flips exist (wc_0071). The 360° pass can find them only at the 0.75 bar. A cheap
   "heading + 180° local window" second pass is plausible but is an accept-path change → research unit U8.
7. `EYE_PRIOR_DEFAULTS.altBias −7 m / σA 3 m` are dev-fitted (`concord/priors/altitude.ts:67-70`); used only by
   unwired priors. Note only.
8. Bundled second opinion sends no `positionUncertainM` (`integration/second-opinion.ts`), uploads do.

**P3**
9. WMM2025 extrapolates silently after 2030.0 (2031 → +0.6° drift in CH); no H-blackout guard. Harmless here.
10. `mapPriorsFromPhoto` defaults `declination: true` while `priorHeading` follows the flag (opposite defaults).
11. `ingest.mjs` does not normalise heading to [0, 360); `geo/photo-meta.ts:55` parses MakerNote big-endian only.
12. `wmm.ts` has no vitest spec (covered by the `geocam-priors` check). Factor specs are pod A's (`pod/a-cov-core`).

## 4. Research summary

- **Phone compass error.** Field studies: 1–3° right after calibration, 2–3× worse without recalibration,
  isolated 13–25° outliers ([Lviv Polytechnic field study](https://science.lpnu.ua/node/42954)); 5–10° typical
  across 17 devices in AR navigation, with iPhone 4s/5/5s at 10–28° in one test
  ([Open University, compass errors in mobile AR](https://oro.open.ac.uk/84729),
  [Engadget 2013](https://www.engadget.com/2013-10-18-get-lost-iphone-compass-app-struggles-in-tests.html)).
  Our demo set (≤19°, session-correlated) and template headings (median 4.4°, 10 % gross) fit this: a σ of
  ~10–15° plus a heavy tail, and **bias-dominated within a session**.
- **EXIF semantics.** iPhone writes `GPSImgDirectionRef = T`. An unverified ExifTool-forum report says the
  iPhone ref follows the Compass app's True North toggle inversely; we could not open the thread. Until
  verified, a "T" from iPhone is trusted as true north (what the code does).
- **Declination.** WMM2025 valid 2025.0–2030.0; declination uncertainty √(0.26² + (5417/H)²)° → ≈ 0.36° in
  Switzerland (H ≈ 21 500 nT) ([NOAA WMM](https://ncei.noaa.gov/products/world-magnetic-model)). Our port
  matches the 100 NOAA test values to 0.005° (`geocam-priors` check); Bern 2026-10-01 D = +3.37° E.
- **Mountain geo-localization prior art.** Baatz et al. ECCV 2012 and Saurer et al. IJCV 2016 (ETH, all of
  Switzerland) search orientation by contour matching with a consistent-orientation constraint; the
  compass is a window, not a pull ([Baatz 2012](https://mlanthology.org/eccv/2012/baatz2012eccv-large)).
  Brejcha & Čadík (3DV 2018) fuse semantic segments + edges against the DEM for orientation
  ([project page](https://cphoto.fit.vutbr.cz/semantic-orientation/)). GeoCalib/AnyCalib priors were tried
  here and are off (speed-only, near-neutral, `reports/matching-v2.md` §4). The "priors off" lesson in
  matching v2 is about **learned calibration and eye priors as pulls**, not the compass window.
- **Already recorded negatives** (not redone): GeoCalib/AnyCalib priors; altitude-contour eye rule; joint
  whole-frame solve with priors; free eye from matches; GA2–GA4 (`reports/negative-results.md`).

## 5. Landed this session

| Unit | Commit | What |
|---|---|---|
| U1 | cd10b22 | `pose6dof/geo.ts` `priorsFromPhoto`: null heading/pitch/roll = unknown; spec |
| U2 | cd10b22 | `tools/research/geo/prior_audit.py`: dev-only prior-error audit (§2 numbers) |
| U3 | 6345569 | `geocam/priors/heading.ts` `headingControlWindow` + the workspace heading slider (browser-unverified, ledger row) |

Iterations: (1) review sweepers (live path; priors + WMM) → U1–U3; (2) independent adversarial review of the
diff: no defects at medium or above; fixed its two low notes (audit docstring: crops treated as uncropped;
pose6dof README null rule). Fast tier in the worktree: 109 pass, 5 fail, none in touched files (peer biome
errors in `roll/import`, ontology storage-key rule in `picker`/`roll/propagate` specs, `flow` timing under
load, `upload/index.spec.tsx` vite "Denied ID" through the symlinked node_modules, python tooling specs).
Browser-unverified: U3 (ledger row in `reports/batch-ledger.md`).

## 6. Plan (later / other owners)

| Unit | Size | Risk | Gate | Owner |
|---|---|---|---|---|
| U4 `photoYawPrior(meta)` used by roll (`roll.ts`, `plan.ts`, `viewpoint.ts`, `align.ts`) so declination is consistent | S | low (bit-identical with `geoDecl` off) | roll specs | camera-roll step |
| U5 `ingest.mjs` keeps `headingRef` (`local.headingRef`) + `GPSAltitudeRef` sign | S | low until a re-ingest | ingest spec | photo-capture step |
| U6 One prior-width table (`src/lib/geocam/priors/widths.ts`): σH rule, yaw/pitch/focal σ and windows; callers import it; bit-identical values | M | med (touches solve, align, refine, eye) | fast tier + byte-identical solve on GT-12 | baseline-pipeline + this step |
| U7 Flip `geoDecl` on | XS | low (only "M"-ref uploads change, by ≤ ±4° in CH; all bundled/dev bit-identical) | GA0 passed no-regression | **user decision** |
| U8 Heading-flip pass: after a local reject, try a local window at heading + 180° at the full-search bar (0.75) before 360° | M | accept path | flag, dev strip bench + blind pack; n = 1 motivating case | later, research |
| U9 Session compass bias: photos of one trip share a bias, so a solved neighbour narrows the next photo's window (roll/propagate already does this for yaw offsets) | M | accept path | flag + dev roll bench | camera-roll step |
| U10 Wire `second-opinion` `positionUncertainM` for bundled photos | XS | matcher input | matcher spec | pose-estimate / pod B |

Not proposed: narrowing the ±25° window. 3/20 template headings sit at or beyond 25°, the demo set reaches
19°, and the 360° fallback is the precision guard; a narrower window only shifts work to the stricter pass.
Widening it is also not proposed: the local bar is 0.5, and a wider local window at 0.5 is the IMG_7053 trap.

## 7. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts / pages not edited)

- `modules`: add `src/lib/upload/exif.ts` (ingest), `src/lib/geocam/priors/heading.ts` (declination),
  `src/lib/integration/unknown-pose.ts` (`photoUnknowns`) and `src/lib/geo/solve.ts` (window); keep
  `pose6dof/types.ts`/`photo-priors.ts` but mark them "GEO research adapters, not the live prior".
- `summary`: "Compass heading, tilt, lens and GPS position form a first guess of the camera. The solve
  searches ±25° of the compass and ±3° of the tilt; when that fails it searches the whole circle at a
  stricter bar."
- Page `camera-prior.tsx:1055`: "the compass gives yaw, corrected for declination" → "the compass gives yaw
  (true north; magnetic headings are corrected only with `?geoDecl=on`)". Caption at :637 quotes the GEO
  research widths; label them as such or show the live σ 15° / ±25°.
- Ontology `camera-prior.realizedBy` (`ontology/catalogue/concepts.ts:98`) lists only the unwired adapters.

## 8. Needs the user

- U7: turn `geoDecl` on by default? Recommendation: yes (physically correct, bit-identical on every bundled
  and dev photo, matches NOAA to 0.005°), but no photo in hand can show a gain.
- A small set of own uploads with magnetic refs (Android) and known poses would be the only way to measure
  declination and phone-compass widths; the dev split has 2 EXIF headings.
