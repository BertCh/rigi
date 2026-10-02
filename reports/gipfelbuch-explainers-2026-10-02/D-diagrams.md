# Pod D: synthetic and animated diagrams (spec, 2026-10-02)

Status: **v1, spec plus round-1 landing notes.** The binding grammar is `grammar.md` (pod G). This spec applies that grammar to the drawn explainer that is not a photo: page-local animated SVG figures, `SketchSpill`, `Plot`, the hand kit (`hand.tsx`, `math.tsx`), `notebook/figures.tsx`, and `Mark` / `MarkList` / `Key` / `skylineBand`. Everything is browser-unverified until the consolidated visual pass.

## 0. What the audit found

The audit covered 31 page-local animated figures on 17 of the 19 pages. A Sonnet sweep also catalogued the landing's nuances. The full records are in the audit transcript; this section is the summary.

**Static frame.** `useTime(still)` froze only under reduced motion. Under webdriver and print every figure kept ticking.
- Many `still` values point at an uninformative frame:
  - `CostLandscape` 9 → empty heat map;
  - `HorizonLock` 7 → mid-search;
  - `PrecisionLadder` and `VerdictTree` 0 → the weakest case;
  - `Conveyor`, `CascadeFlow`, `PriorLab` and the eye-rule `Hero` default to 2;
  - `PoseExplorer`, `BilinearProbe`, `FullCircle` and `ConfidenceDisc` land on arbitrary frames.
- Pod G now freezes `useTime` under `revealsImmediately()` and `beforeprint`. Pod D fixes the call sites.

**Causality.**
- Nine figures animate with free sinusoids, which is decoration rather than a story: `PoseExplorer`, `BilinearProbe`, `ConfidenceDisc`, the `FullCircle` sweep, the `Registration` drift-away, the eye-rule pulse, the `RollLinker` dash crawl, the `PriorLab` spinning wedge and the `CandidateFigure` swing.
- Most of the rest are "sweep, hold, hard reset" loops with no settled end.

**Performance.**
- Every figure re-renders its whole SVG at 60 Hz while visible, even for a 1 Hz change.
- The worst cases:
  - `PoseExplorer`: a 300-point sketched skyline plus a wash re-sketched per frame;
  - `Sweep`: about 400 keyed lines per frame;
  - `PanoramaStrip`: about 17 paths re-sketched and remounted per frame;
  - `FullCircle`: 360 points with 8 wash layers, for a rotation.
- Good models already in the tree:
  - `ViterbiScan`: canvas plus memoised overlay, revealed by a clip;
  - `RayMarch`: series drawn once and revealed by a clip;
  - `HorizonLock`: a memoised sketch moved by a transform.

**Ground.**
- Every diagram's mountains were invented: Gaussian bumps named A–F, sums of sines.
- So no diagram showed the peaks of the photos on the same sheet.
- `SketchSpill`, by mt-image-c3, runs the invented ridge on into the margins on 4 figures:
  - rigi D1, viewport-inference D3, tap-a-peak D1 PinLock and camera-roll D5.
  - It re-sketches every margin ridge and re-walks the ruler per CSS px on every frame.
  - None of the 4 uses a `cursor`.

**Rules broken.**
- photo.tsx `Anatomy` filtered a photo (`saturate(0.5) brightness(0.8)`) on its tags layer.
- `Mark`, `Plot` and `real.tsx` still draw raw SVG `<text>`. Pages are clean (the lint covers pages only).

**Phone.** Most 640–800-unit viewBoxes letter at 10–14 units, which is 5–7 px on a 390 px phone. The legible ones (`LevelRings`, `BilinearProbe`, `FullCircle`) use 320–384-unit viewBoxes.

### Beyond the landing: what a diagram must explain that a photo story does not
The landing explains one thing: the guess, measure, correct, snap of one photo. A Gipfelbuch diagram explains the inside of one step, so it has more to show:
- **The intermediate state.**
  - The running maximum of a ray march.
  - The partial profile of a sweep.
  - The degrees of freedom locked after n taps.
  - The residual per column.
  - The cost at the current guess.
  - These are computed per frame from the clock, so they need a continuous clock. Per-beat CSS cannot do it.
- **Attribution.** One parameter changes per beat, so the reader can tell which number moved which line. `PoseExplorer`'s four simultaneous sinusoids broke this.
- **The counterfactual.**
  - Examples: curvature off, the guess that was wrong, a rule that rejects.
  - It stays visible as a ghost in the final frame (grammar §1.3).
- **Units on the drawing.** Readouts belong next to the mark they measure, in hand figures, and update with the clock.

## 1. Background ↔ image coordination: real ground, synthetic sensor

**Rule D1. A diagram keeps a synthetic sensor but draws real mountains.**
- The sensor is synthetic: an invented compass error, a chosen tap, a schematic camera.
- The mountains are real: one demo photo's DEM horizon, named summits, terrain section and real poses. They are baked once by `scripts/gipfelbuch/bake-diagram-scene.ts` into `viz/diagram-scene.json` (10 KB, imported synchronously, so it is deterministic and node-specable). Helpers are in `viz/scene.ts`.
- **The scene is demo-09.**
  - It is the landing's how-it-works photo: Niederhorn towards Wetterhorn, Schreckhorn, Finsteraarhorn, Eiger, Mönch and Jungfrau.
  - The 170° horizon runs from 31° to 201°, with 14 labelled summits.
  - The real phone prior is 134.6°, against a solved yaw of 116.1°, so the compass was 18.5° off.
  - The reader meets the same skyline and the same names on the landing, the sheet's photos, the spill and every diagram.
- Figures adopting it set `<Figure pinned="demo-09" ground="demo-09">`. `ground` gives the `--fig-*` washes and inks from pod G's palette bake.
- **Honesty.**
  - The DEM horizon (terrarium, 0.25° steps) runs 0.1–0.35° under the named summit heights. `summitOnSkyline()` puts a summit's mark on the drawn line and keeps foreground summits (Galtbachhoren, 3° under) below it.
  - True angles are drawn. Where a figure exaggerates vertically, a pencil note says "vertical ×k".
- **Not adopted.** These figures keep invented terrain:
  - viewport-inference's Legacy trio. It shares one 360° invented `horizon()` with `FullCircle`, and the bake covers 170°.
  - dem-horizon `Sweep`, a 2-D height field seen from above.
  - Their captions keep "Invented terrain, real method".

**Ground per kind of figure.**

| Figure kind | Ground | Spill |
| --- | --- | --- |
| Camera view, skyline against bearing (PinLock, Registration, PanoramaStrip, HorizonLock) | Paper (`surface="paper"`, `--fig-wash` from demo-09) | `SketchSpill` with the scene horizon as the "photo" ridge and the model at the figure's pose. Off-frame summits are named (`summits`). The cursor marks the tap or worst column. |
| Multi-panel (PoseExplorer plan + image, Sweep map + profile, RayMarch section + angle) | Paper; panels separated by space | **No side spill** (coordinator ruling: the scenes are sub-panels). The tie is the real scene itself: real summit bearings and distances in the plan, the real horizon in the image, the real terrain section. |
| Dark plate (PinLock today) | `surface="plate-dark"`, terrain wash from the palette | The spill stays on paper, in paper inks (grammar §2 "spill mirrors in paper inks"). |
| Plot, scatter, tree, timeline (PrecisionLadder, VerdictTree, CurveFigure, Conveyor, Plot users) | Paper, no wash | None. Plots never spill. |

**Inks.**
- Spill ridges read `var(--fig-terrain-ink, var(--gb-contour))`, and the ruler reads `var(--fig-horizon-ink, var(--gb-ink))`.
- The photo-skyline ridge in a synthetic camera view is the **measured** ink. The model horizon is the **derived** ink: `LAYER_INKS.solved.paper`, dashed when it is at the prior.

## 2. The overlay stack for diagrams

This is grammar §2 mapped to drawn diagrams. One `<g data-layer=…>` per role, in this order:

| z | Role | In a diagram | Ink, weight | Provenance |
| --- | --- | --- | --- | --- |
| 0 | `ground` | Wash, sky hachure, **construction pencil** (grid, axes, range rings, frame, construction rays) | Pencil or faint, 0.5–0.9; hachure 0.7 | Furniture |
| 2 | `measured` | What the (synthetic) sensor saw: the photo's skyline, tap rings, observed columns, terrain section | Measured ink 1.7, one pen pass (`data`) | Measured on the real scene, or synthetic and said so |
| 3 | `derived` | The model at the current state: horizon at a pose, running maximum, residual stems, cost bar, wedge | Derived ink 2.2, `prior` dashed | Computed per frame from the clock |
| 4 | `furniture` | Arrows, rings, strikes, leaders, the correction arc | Pencil 1.2; one red per figure | Furniture |
| 5 | `notes` | HandLabel, HandNote, circled keys, live readouts on the drawing | Ink; red numbers | – |
| 6 | `interaction` | Cursor, scrub head, the "again" button | Ink | – |

- Construction pencil sits at z0, under the data. This is what the brief means by "construction pencil, then data pen, then derived, then notes".
- The superseded guess becomes a **ghost**: opacity 0.35, struck, and it stays in the final frame.
- Moving `derived` lines are **exact paths** (a `d` per clock tick, no sketch re-seed) or a memoised sketch moved by a `transform`. Only static layers are sketched.

## 3. The animation script

- **Clock.** Pod G's `useBeatClock(beats, { playback: "once", fps: 30, arm: ARM_SEQUENCE })`, which lands in motion.ts. Until then the same contract is in pod D's `viz/script.ts` and `viz/useScript.ts`, to be deleted when it lands.
- **Commits.** The clock commits at most 30 times a second, only while a beat plays, and stops at the result.
- **Arm and replay.** It arms at a 0.45 visible share, pauses off screen, and replays on return after the share drops below 0.2, on a hover rest of 350 ms, on a tap, or from the "again" button.
- **Beats** (grammar §1.3). One idea per beat:
  - `setup`: the scene and the guess, 2.8 s.
  - `evidence`: the measured layer draws on with a clip wipe left to right over `draw` (900 ms) on `EASE.draw`, staggered 110 ms.
  - `change`: one parameter moves over `settle` (620 ms) to 2.4 s on `EASE.out`, with no overshoot. A computed sweep runs linear in its own time.
  - `result`: the dwell is 1.6 × 2.8 s. The result note fades in over `fade` (420 ms), the ghost stays, and the readout turns to the result ink.
- **Spill sync.** The spill's moving ridge is built from the same pose as the frame. Its `reveal` follows the layer it mirrors: the model ridge enters with the derived layer, and dims to 0.3 while the reader drags the pose off the solution. The cursor moves in the same frame as the figure's.
- **Interaction.**
  - The stepper is the beat index, and a jump lands on the end of a beat (its finished picture).
  - Sliders switch to manual. "▶ again" replays.
  - Drags write straight to the clock (`scrub`).

### Per-figure scripts (the main-body and flagship figures)

| Figure | Beats (kind: what changes) | Settled frame |
| --- | --- | --- |
| pose-estimate `PoseExplorer` (main-body hero) | setup: the plan wedge and the image at the real phone prior (134.6°), summits named → evidence: the photo's skyline draws on (the horizon at the solved pose, measured ink) → change yaw: 134.6 → 116.1, the wedge turns and the model slides 18.5° → change pitch: −13.6 → −12.6 → change roll: −0.2 → +0.7 → change focal: 601 → 613 px → result: the lines coincide, the guess becomes a ghost, the note reads "the compass was 18.5° off; gravity and lens nearly right" | The solved pose with the guess ghost; the sliders are live |
| tap-a-peak `PinLock` | setup: guess at the real prior → evidence: tap 1 on Eiger (ring) → change: yaw and pitch lock → evidence: tap 2 on Wetterhorn → change: roll locks → evidence: tap 3 on Jungfrau → change: focal locks → result. The spill cursor marks each tap bearing. | 3 taps, all locked, ghost of the prior line |
| dem-horizon `RayMarch` | setup: the real demo-09 section along 116.1° from Niederhorn, eye 1,915 m → change: the march runs 0 → 33 km (linear in story time), the running max climbs → result: the horizon point and angle, ghost of the flat-earth answer when curvature changes it | End of the march |
| dem-horizon `Sweep` | setup → change: 360° sweep → result. A distance legend is added and the profile is chunked (perf). | Full profile |
| rigi `Registration` | setup: 3.4° off → change: converge → result: hold (the drift-away phase is cut) | Within 1°, verdict |
| camera-roll `PanoramaStrip` | setup: the middle photo off by 7° and 3.2° → evidence: seam → change: the pose settles → result: continuous ridge; the spill follows the middle photo's pose | Aligned, ghost seam |
| viewport-inference `HorizonLock`, `CostLandscape`, `FullCircle` | Keep the scripts. Play once, settled stills (9.2, 7, the result), and the `FullCircle` sweep draws the cost as it passes | Solved |
| All other `useTime` figures | Play once (`Math.min(t, settle)` in place of `t % period`) and fix `still` to the result | The result |

## 4. Static, print, reduced motion, webdriver, phone

- **Static** is the settled result frame, with ghosts, notes and readouts (grammar §4). The clock never starts.
- **Print** is the same frame. Stepper chrome is `print:hidden`, and the spill keeps its ruler only.
- **Phone.**
  - The spill is the ruler only, with no summits.
  - New or reworked diagrams use a 360–420-unit viewBox per panel, or keep 640 with labels at 18 or more units, so lettering stays at 10 px or more at 390 px.
  - Multi-panel figures stack.

## 5. Kit changes (pod D files)

- `viz/scene.ts` and `viz/diagram-scene.json`, with the bake script: the real ground. Specced in `viz/__tests__/diagram-kit.spec.ts`.
- `viz/script.ts` and `viz/useScript.ts`: the causal clock, temporary until `useBeatClock` lands.
- `SketchSpill` v2:
  - geometry-keyed memo, so an unchanged ridge or ruler is never re-sketched;
  - `reveal` opacity;
  - `summits` named in the margins, with declutter and at most 4 per side;
  - inks from the `--fig-*` vars.
- `Mark` loses its raw `<text>` (HandLabel).
- `Plot`'s raw `<text>` is the next kit item.

## 6. Browser-pass checklist (pod D)

For each figure below, check `?theme=light` and `?theme=dark`, 1280 px and 390 px, reduced motion, and print preview.
- pose-estimate Fig. D3:
  - the beats play once at a 45 % share;
  - yaw visibly turns the wedge and slides the line;
  - the ghost stays;
  - the summit names are the real ones and match the hero photo;
  - the sliders work after the play.
- tap-a-peak D1 PinLock: the spill cursor is on the tap bearing, the summits are named in the margins, and the margin ridge meets the frame's ridge at the edge.
- dem-horizon D1 RayMarch (the real section) and D2 Sweep (perf: no jank at 60 Hz, the legend shows).
- rigi D1 and camera-roll D5: the spill ridges continue the frame's lines with no step at the frame edge, and the reveal dims on drag.
- Every `useTime` figure: the webdriver and print frame is the result, not a mid-loop frame.
- photo Fig. D1 Anatomy: the photo is unfiltered on the tags layer.
- Performance: the DevTools performance panel on pose-estimate shows commits stop after the result, about 30 per second while playing.

## 7. Landed, negative, deferred

To be filled at the end of round 2.
