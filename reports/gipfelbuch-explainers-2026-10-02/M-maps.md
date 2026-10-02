# Pod M: maps that follow the photo (spec, 2026-10-02)

Pod M, Opus lead, in the 7-pod Gipfelbuch explainer pass. Rules: the coordinator's EXPLAINER-RULES. Grammar: `grammar.md` v0.1 (pod G).

**Scope.**
- `viz/StoryMap.tsx`, plus a new pure module `viz/story-map.ts`.
- `swiss/SheetMap.tsx`.
- `tafel/**`.
- `notebook/NotebookMap.tsx` and `notebook/carto.tsx`.

**Landing counterparts.** `site/TopoBoard.tsx` (plan wedges), `how/WorldView.tsx` (guess and doubt fan, skyline footprint), `site/Surround.tsx` (`map.json`), and `site/LiveRollMap.tsx`.

Status: **spec v1 with the landed record.** Two units landed, each through implementation, an adversarial review and a fix round. See §9.

## 1. Audit summary

### 1.1 Instances

| # | Where | What | Coordinated with its photo? |
| --- | --- | --- | --- |
| A1 | `baseline-pipeline` HeroStages | `StoryMap` as the `Stages` aside, story `initial=0` | Same `d` and story t. Peaks are not coordinated: the map names every labelled peak and the stage photo names none or some. |
| A2 | `photo-workspace` HeroJourney | `StoryMap` as the `Stages` aside | Same as A1 |
| A3 | `camera-prior` Fig. | `StoryMap` beside `RealPhoto` (with toggles), `crop=skyBand`, `maxLabels=4` | Same t. The map's peaks are navy/grey and name all labelled peaks. The photo inks priorPeaks red (RM) and peaks black, at most 4. |
| A4 | `viewport-inference` Fig. | `StoryMap` beside `Compare` (crop `skylineBand`) | Same t through the wipe. During a wipe drag the map lags: a 520 ms tween restarts on every move, while the spill follows at once. |
| A5 | `viewport-inference` MiniMap (Trio) | `StoryMap search` cropped to 4:3 by a wrapper | Not coordinated. It runs its own per-frame React loop, and the wrapper clips the cone. |
| A6 | `camera-roll` MiniAim (Trio) | `StoryMap search` | Its own loop, on the picked photo |
| A7 | `camera-roll` "Aimed" stage | `DemPatch` plus roll cones | Roll data. Out of pod M's core (the page's figure). |
| A8–A11 | `peak`, `dem-horizon`, `step-inside` minis | `DemPatch cone=["solved"]` | `peak.tsx` MiniDem is hard-coded to `demo-01` |
| B1 | Index | `SheetMap` (12 cameras) | Ignores the photo the Blattübersicht follows (`highlight` is never passed) |
| B2 | Print, `/dev/gipfelbuch-sheet` | `SheetMap` | Static |
| C1 | Four shell sheets plus `/dev/tafel` | `Tafel` | Photo plate. Ground on `--gb-paper-deep` only. |
| C2 | Index | `Blattuebersicht` | Raw `<text>` (2) in the card bands |
| D1 | Index | `NotebookMap` (Feldbuch) | Not a map. Its one plan view, `DemSketch`, belongs to pod D's `figures.tsx`. |

### 1.2 Missing against the landing

- **No skyline footprint.** WorldView draws where each sight line grazes the skyline. The side map never shows *which ground makes the photo's skyline*, even though `horizon.profile` (az, d) holds it.
- **No ray draw-on.** The cone swings, but nothing connects the camera to the summits the photo names.
- **Peaks are not the photo's peaks.**
  - Ink: navy/grey on the map, against black and RM on the photo.
  - Set: the map names every labelled peak in the patch, against the photo's crop and `maxLabels`.
- **Motion does not match the photo.**
  - The map tween is 520 ms cubic, the spill 620 ms cubic.
  - A drag restarts the map tween, so the map trails the wipe.
  - The search loop re-renders the whole DemPatch every frame.
- **Furniture.**
  - DemPatch writes a raw `N↑ · km` `<text>`, and StoryMap two more raw `<text>`s.
  - There is no hand scale bar or north arrow, although the carto kit has both.
  - Three reds compete: the arc, the camera dot and the prior ghost.
- **Phone.** A stacked side map is a full-width 400-unit square, which dwarfs the photo.
- **Static states.** The search loop is static at solved. A story map's static frame is whatever the provider holds. Print is not handled.

### 1.3 Beyond the landing

The landing only ever shows solved wedges, or a perspective fan. A Gipfelbuch side map must also explain:
- the compass correction as an arc with its number;
- that the cone swings *about the camera* (the GPS fix stays);
- which ridge in the patch forms the skyline at each bearing;
- which summits the solved pose names, the same ones the photo names.

## 2. Background ↔ image coordination

- **The ground is the map's own raster.** The DemPatch hillshade goes through the Imhof ramp onto `--gb-paper`. It is a display-only generated still, layer `raster`.
- **Around the map, the figure's wash.** Where the map sits inside a `Figure ground=…`, the map root takes no background of its own, so the figure's `--fig-wash` reads through.
  - Proposal to pod P: DemPatch's paper rect uses `var(--fig-wash, var(--gb-paper))`, so the square of the patch melts into the figure wash instead of reading as a pasted tile.
- **Terrain ink follows the photo.** The skyline footprint and the scale-bar ink read `var(--fig-terrain-ink, var(--gb-contour))`, the same var the photo's spill ridges use. The ridge that leaves the photo frame in the spill is therefore the same ink as the ridge that forms the skyline on the map.
- **Pose is shared.**
  - The map reads the same alignment story t as the photo, the wipe and the spill.
  - It settles over `MOTION.settle` (620 ms) with `ease.out`, the GeoSpill slide, so the cone and the spill arrive together.
  - It follows a drag (its own, or a wipe's) at once, as the spill does.
- **The same peaks in the same inks.**
  - The map names exactly the photo's label set: the labelled peaks inside the photo's `crop` at the solved and prior poses, capped at `maxLabels`. That is the same filter as `RealPhoto`.
  - A peak's ink follows the photo layer that shows it at that pose: `priorPeaks` RM at the guess, mixing to `peaks` ink at the solved pose. It is mixed by t only while the peak is inside the live cone.
  - Other summits in the patch are unlabelled pencil ticks. They are context, not claims.
- **SheetMap** follows the photo that the Blattübersicht and notebook picker follow.
  - The `highlight` camera shows its guess cone ghost (RM, dashed) and its solved cone (GL).
  - Pencil rays run to the summits that photo names, where those summits are on the sheet.
  - The other 11 cameras keep their red sheet cones, dimmed.

## 3. Overlay stack (StoryMap)

One square SVG, `viewBox 0 0 400 400`, in two parts:
- a base, memoised per photo and never re-rendered per frame;
- a live layer, a second SVG on top with the same viewBox, re-rendered as t moves (a few paths and at most 8 peaks).

| z | Role | Layer | Ink | Weight | Provenance | Base / live |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | ground | figure wash (from the Figure) | `--fig-wash` | – | furniture | – |
| 1 | raster | Imhof hillshade (DemPatch) | none, never tinted | – | measured DEM, generated still | base |
| 2 | measured | skyline footprint: (az, d) of the skyline-forming ridge, column by column, broken where d jumps > 12 % | `--fig-terrain-ink` (NB). Inside the live cone 1.6 px at 0.95; outside 0.9 px at 0.35. | 1.6 / 0.9 | measured (`horizon.profile`, DEM) | outside run in base, inside run in live |
| 2 | measured | camera (GPS fix) | DemPatch dot | – | measured | base |
| 3 | derived | guess cone ghost | `prior` paper RM, dashed `dashFor` | 1.3, fading 0.85 → 0.45 with t | derived (sensor prior) | base (opacity in live) |
| 3 | derived | solved cone ghost | `solved` paper GL | 0.9 at 0.6 | derived (solve) | base |
| 3 | derived | live cone, fill plus edge | `mixHex(prior, solved, t)`, fill 0.12 | 2 | visual tween between the two measured poses | live |
| 3 | derived | rays camera → the photo's named peaks | `solved` paper GL | 1.2 | derived (the solved bearing to each named summit) | live, draw-on |
| 4 | furniture | correction arc and its signed degrees | `--gb-red` (the one red) | 1.8 | between measured endpoints | live |
| 4 | furniture | hand scale bar (true: 400 units = 2·halfKm) and north arrow | ink / pencil | carto tiers | furniture | base |
| 5 | notes | peak names (HandLabel caps), in the photo's set only | see §2 | – | measured names | live |
| 5 | notes | state word ("phone's guess" / "correcting" / "solved") | prior or solved ink | – | – | HTML |
| 6 | interaction | grab cursor, slider ARIA, focus ring | – | – | – | HTML |

- **Rays draw on** over the last stretch of the swing: ray i is drawn to `clamp((t − 0.82)/0.14 − 0.08·i)`, by rank.
  - They appear only as the cone arrives, so the order reads "turn, then the names line up".
  - Under a drag they follow t, so dragging back retracts them.
- **The footprint** is one fixed geography; the live cone *reveals* the part of it that the photo sees. At t = 1 the bright run is exactly the photo's skyline.
- **Red.** The arc is the one red emphasis. The camera dot (DemPatch, pod P) should move to ink; that is a proposal to P.

## 4. Animation script

**Story-driven (A1–A4).** The story is the clock; the beats come from the photo figure (Stages or Compare).

| Beat (grammar kind) | Story t | Map |
| --- | --- | --- |
| setup | 0 | Live cone on the guess (RM), names at the guess in RM, arc hidden, rays none |
| evidence | 0 | Unchanged: the evidence is drawn on the photo, and the footprint is already there |
| change | 0 → 1 over `settle` with `ease.out` (a drag is immediate) | The cone swings about the camera. The arc grows with its signed degrees. Peaks fade in and out of the cone (160 ms). Inks mix. |
| result | 1 | Rays draw on to the named summits. The state word reads "solved". The guess ghost stays dashed at 0.45. |

**Search (A5, A6; no story).** This is a `once`-then-loop demo of "try small turns".
- Arm at 75 %, then `MOTION.lead`.
- A damped sweep either side of the guess over `MOTION.sweep` (4200 ms).
- Hold the result for `beat × 1.6` (rays drawn).
- `replayFade`, then repeat while armed.
- Only the live layer re-renders.

**Fit.** `fit="cone"` crops the square to the box around the camera and both cones (padding 8 %) at the tile's aspect. A Trio tile shows the action, not a clipped square.

## 5. States

- **Static** (reduced motion, webdriver, print, no IntersectionObserver), via `useMotionAllowed` once it lands, with `useReducedMotion` plus webdriver until then.
  - Search maps: t = 1, rays drawn, ghost kept.
  - Story maps follow their provider. Stages already jumps to its last stage under reduced motion.
- **Print.** The live layer is drawn at the current t. The state word prints. The grab cursor and the readout's "drag the cone" are hidden.
- **Phone.**
  - A stacked side map is capped at `max-w-[22rem]` and centred (the aside column at lg is 15 rem anyway).
  - Peak names: at most 4 under 400 px of rendered width.
  - `touch-pan-y` is kept.
- **Dark.** The map is paper. It is never a dark plate.

## 6. Per page

| Instance | Change |
| --- | --- |
| A1 baseline | No prop change. It gets the footprint, rays and the new inks. The stage photo has no crop. |
| A2 workspace | Same as A1 |
| A3 camera-prior | `crop={skyBand(d)} maxLabels={4}`, the photo's own |
| A4 viewport-inference | `crop={crop}`, the Compare's band |
| A5 MiniMap | Drop the 4:3 wrapper and use `fit="cone" aspect={4/3}` |
| A6 MiniAim | `fit="cone" aspect={4/3}` |
| A9 peak MiniDem | Use the picked photo instead of `demo-01`, a one-line page hunk |
| B1 index | `<SheetMap highlight={photoId}/>` |
| C2 Blattübersicht | Raw `<text>` → `HandLabel` |
| C1 Tafel | The plate reads `var(--fig-wash, var(--gb-paper-deep))` through `groundVars(photo)`, once `ground.ts` lands. The spill ink reads `--fig-terrain-ink`. |

## 7. Proposals sent

- **P** (`real.tsx`):
  - DemPatch paper rect: `var(--fig-wash, var(--gb-paper))`.
  - Camera dot in ink, not red.
  - A `furniture={false}` prop that drops the raw `N↑ · km · min–max` `<text>` (StoryMap draws a hand scale bar and north arrow instead).
  - DemPatch peak labels → HandLabel.
- **S** (`story.tsx`): `setT(v, { instant?: boolean })`, so drag writers can say "follow now". Until then, StoryMap follows a run of small, fast steps at once (`followMode`).
- **G**: StoryMap consumes `MOTION.settle`, `MOTION.sweep`, `MOTION.lead`, `MOTION.beat`, `MOTION.resultHold`, `MOTION.replayFade`, `MOTION.quick`, `ease.out`, `useMotionAllowed` and `useArmedInView`.

## 8. Browser-pass checklist

1. `/gipfelbuch/camera-prior`.
   - Drag the map: the cone, arc and peak inks follow the finger with no lag.
   - The photo's prior and solved line opacities follow.
   - The map names the same ≤ 4 peaks as the photo, in RM at the guess and ink at solved.
2. `/gipfelbuch/viewport-inference` Fig.
   - Drag the wipe: the map cone tracks it frame by frame.
   - Release: both stop together.
   - At t = 1 the bright footprint run lies under the cone and the rays draw on.
3. `/gipfelbuch/baseline-pipeline` and `/gipfelbuch/photo-workspace`.
   - The stage advance swings the cone over about 620 ms, in step with the spill's slide.
   - No double red: the camera dot, if P agreed.
4. The Trio minis (viewport-inference, camera-roll):
   - the cone is not clipped;
   - the loop sweeps, holds with rays, fades and repeats;
   - it stops off-screen.
5. Index:
   - picking a photo in the Blattübersicht highlights its camera on the sheet, with its guess ghost and rays;
   - the other cameras dim.
6. `?theme=dark` and `?theme=light`: the map stays paper and readable. Phone at 390 px: the map is capped and names ≤ 4 peaks.
7. Reduced motion, `navigator.webdriver` and print preview: settled frames.

## 9. Landed, negative and deferred (2026-10-02)

### Landed (browser-unverified)

**M1 StoryMap** follows its photo. Commits: 869335f round 1, 3a4086e round 2, e090f29 ledger. Round 1 was implemented, then adversarially reviewed, then fixed.
- `viz/story-map.ts` (pure, 20 specs, with real-data cases on all 12 JSONs) holds:
  - `mapPeakSet`, the photo's label filter;
  - `placeNamed` and `declutterRim`;
  - `footprintRuns`, `rayDraw`, `followMode`, `coneFitBox` and `searchT`.
- **Same peaks, same inks.** Peaks beyond the 20 km patch sit on a rim at their bearing, with "km". On demo-03, 09 and 10 none of the named peaks lie inside the patch.
- **Footprint and rays.** The skyline footprint is drawn in `--fig-terrain-ink`. Rays draw on once t passes 0.82, and at t = 1 every ray is complete.
- **Motion.**
  - Settle: `MOTION.settle` with `ease.out`.
  - Drags and streams follow at once: `followMode` treats updates under 90 ms apart as a drag, and `story.instant` is read optionally.
  - The base is memoised and only a small live SVG redraws.
  - The search loop is fadeIn, lead, sweep, hold (rays over `MOTION.draw`), then fadeOut. It arms at `ARM_SEQUENCE` and is capped at 30 fps.
  - Under static conditions it shows t = 1 with the rays.
- **Furniture.** A hand scale bar and north arrow, drawn with DemPatch `furniture={false}` (pod P's b53dbca). There is no raw `<text>`.
- **Minis.** `fit="cone"` with aspect 4:3 replaces the clipping 4:3 wrapper. The map is capped at 22 rem, with at most 4 names under 280 px.

**M2 SheetMap and grounds.** Round 1, then review, then round 2. The commits are c3596a7 (round 1), 2c07aad (round 2) and 4b8ff6c (ledger).
- **SheetMap `follow`** (pure `swiss/sheet-follow.ts`, with real-data specs). The index's followed photo shows:
  - the guess ghost (RM, dashed);
  - the solved wedge in GL;
  - a red correction arc whose signed degrees equal the pages' `solved.yaw − prior.yaw` to within 0.05;
  - pencil rays to the sheet summits that lie in its frame.

  The swing is WAAPI, once per photo, armed in view. A refused photo (demo-07, demo-11) shows only the guess and its unsolved cone, marked "not solved".
- **Ground.**
  - `Figure ground={d.id}` is set on the four StoryMap figures.
  - The Tafel root sets `groundVars(photo)`.
  - `.tafel-root` and `.tafel-halo` read `--fig-wash`. `.tafel-spill` reads `--fig-terrain-ink`, so GeoSpill inside a grounded Figure takes the photo's terrain ink.
- **Blattübersicht.** The two raw `<text>` become HandLabel.

### Pending wiring

The index route wiring (`<SheetMap highlight={photoId} follow={…}/>` and the caption) collided with a peer's uncommitted Wegnetz edit in `src/routes/gipfelbuch.index.tsx`, so it was held back (e36ddcb).
- The patch is in the coordinator scratchpad, as `M-index-follow.patch`.
- Until it lands, `SheetMap follow` is dormant code.

### Negative and findings

- The sheet bake's viewpoint `yaw` is the compass heading for refused photos, and it is rounded to 0.1°. Pose numbers must come from the photo JSON, never from `sheet.json`.
- Few photos get rays on the sheet: 0 to 4 per photo, because the sheet holds 13 peaks. That is honest, and the figure is not padded.
- The skyline footprint is sparse on most photos: about 27 to 149 points inside the patch, because most skyline ground lies beyond 20 km. It is honest. A larger `demPatch.halfKm` would need a re-bake of the 12 DEM patches.

### Deferred

- **Contour spill around SheetMap.** Off for now, by coordinator decision: it needs a larger sheet re-bake.
- **Raw `<text>` lettering in SheetMap** (contour labels on `textPath`, places, peaks, credit) is sheet-unit cartographic lettering and stays as it is. `tafel/sheets.tsx` `Txt`, the photo-shadow variant, is not a mechanical HandLabel swap.
- **carto.tsx.** `PeakLeader`, `StationRays`, `ContourScribble`, `SpotX`, `TrigTriangle` and `ProfileSketch` are still unused, and they use raw `<text>`. A later pass could adopt StationRays for the sheet rays.
- **The label filter is duplicated** between `mapPeakSet` and RealPhoto. Pod P was asked for `labelledPeaksIn`, so the two cannot drift.
- **`story.instant`** is pending in pod S (story.tsx) and pod C (Compare's drag). StoryMap already reads it.
- **`notebook/NotebookMap` / DemSketch** belong to pod D's figures and were left alone.

### Open decisions for the user

1. **Imhof ramp on DEM rasters.** DemPatch and SheetMap pass the hillshade and tint through an SVG colour-ramp filter with a multiply blend. The pixels are display-only generated stills, not photos, but the "never filter DEM rasters" rule reads strictly. Keep it as it is (the wave-5 decision), or move the ramp into the bake?
2. **Two reds on the maps.** The guess ghost in prior RM and the correction arc in route red are close hues. Options: keep them (the inks match the photo layers), or make the arc navy.
