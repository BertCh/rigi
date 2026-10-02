<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Gipfelbuch sketch conversion: inventory and work packages

Scope: convert every visualization of the Gipfelbuch explainer site to a hand-sketched look (no clean vector lines, no crisp outlined boxes or cards, no flat area fills; hachure instead). This report was produced by a static scan (grep and function-boundary counting over the JSX source); no src/ file was edited and nothing was run in a browser. Read counts as relative weight, not as an exact edit list.

## How to read the numbers

A **site** is one place in source that must change. Per function (a figure or private helper, located by its top-level `function` or component `const`), the scan counts:

- **prim**: SVG primitive tags (`rect`, `circle`, `ellipse`, `path`, `line`, `polyline`, `polygon`) in JSX. Many sit inside `.map()` loops, so one site can draw dozens of marks at run time.
- **box**: outlined containers: Tailwind `border*`, `ring*`, `outline*` classes, inline `border:` and `boxShadow` ring tricks.
- **rnd**: `rounded*` classes (each marks a card, chip, bar or pill whose crisp rounded outline or flat fill reads as non-sketch; counted separately because it overlaps box and fill).
- **fill**: flat fills: `fill="..."` other than none, `background:`/`background-color`, gradients and patterns.
- **sites** = prim + box + rnd + fill (an upper-bound estimate, there is double counting between box, rnd and fill on the same element; it is applied equally everywhere so the balance holds).
- Dynamic flags: time (`useTime`, rAF-driven via `viz/hooks.ts useRaf`), slider (`input type=range`), pointer, canvas, raf (direct requestAnimationFrame), state.
- Kit deps: kit components rendered inside the function.

Functions with fewer than 2 sites and under 60 lines are omitted from the tables (pure logic, data tables, `Page` shells with no drawing). `Page` shells are listed only when they render kit components.

### Classification rules (apply to every file)

- **DATA** (must stay faithful, keep exact values; sketch only the rendering style, never the numbers or positions): measured series and curves (Plot children, `path d={...}` from data), bar heights, scatter dots, heat/cost cells, photo-overlay marks (peaks, skyline trace, horizon line), pin and tap positions, DEM profiles.
- **FURNITURE** (free to wobble or redraw): axes, ticks, graticule, frames, cards, tiles, chips, rings, arrows, leaders, brackets, labels' backing boxes, legends, rulers, sliders' tracks, sky/ground fills, stage boxes in `Stages`/`Trio`/`Compare`.
- A flat fill that encodes data (heat cell, bar) becomes hachure with density or angle carrying the value; a decorative fill (sky, ground, card background) becomes hachure or plain paper.

### Existing assets to reuse

An earlier notebook layer exists in `src/components/gipfelbuch/notebook/`: `sketch.ts` (seeded `sketchLine`, `sketchCurve`, `sketchCircle`, `sketchArrow`, `hachureLines`), `Ink.tsx` (`PenLine`, `PenArrow`, `PenCircle`, `PenCross`, `PenDimension`, `HandText`) and `swiss/HachureRule.tsx`. Its stated rule is "only furniture wobbles, data lines are drawn exactly", which is stricter on data than this task: here data strokes also need a hand look (jitter that stays below the data tolerance, same positions). Package 1 should extend this layer (a seeded rough rect, rough polygon with hachure fill, rough polyline for data) before the page packages start, or the other packages will invent six variants. Several files are already modified in the working tree (`git status`), so agents must not revert them.

Out of scope or owned elsewhere: `viz/math.tsx` (another session), `HowItWorksScene` (src/components/site/how), `RollCompasses` (src/components/site/meta), `GraphCanvas` is in scope (see package 2).

## Totals

| Page | Lines | Funcs | prim | box | rnd | fill | Sites |
|---|---:|---:|---:|---:|---:|---:|---:|
| accept-rule | 1661 | 16 | 10 | 13 | 12 | 15 | 50 |
| baseline-pipeline | 2051 | 27 | 34 | 8 | 11 | 39 | 92 |
| camera-prior | 1489 | 13 | 31 | 8 | 11 | 29 | 79 |
| camera-roll | 2005 | 23 | 41 | 16 | 9 | 19 | 85 |
| dem-anchoring | 1804 | 23 | 38 | 7 | 7 | 25 | 77 |
| dem-horizon | 1774 | 23 | 47 | 7 | 6 | 35 | 95 |
| dem-source | 1057 | 12 | 18 | 10 | 6 | 17 | 51 |
| eye-rule | 1302 | 14 | 31 | 7 | 7 | 24 | 69 |
| peak | 1964 | 17 | 38 | 9 | 7 | 26 | 80 |
| photo-workspace | 1575 | 12 | 32 | 13 | 9 | 34 | 88 |
| photo | 1205 | 18 | 17 | 10 | 7 | 13 | 47 |
| pose-estimate | 1797 | 21 | 31 | 30 | 17 | 18 | 96 |
| rigi | 736 | 11 | 13 | 5 | 5 | 15 | 38 |
| skyline | 1331 | 15 | 17 | 6 | 4 | 6 | 33 |
| step-inside | 1971 | 19 | 45 | 3 | 7 | 34 | 89 |
| tap-a-peak | 1466 | 18 | 25 | 13 | 6 | 18 | 62 |
| terrain-sampler | 1462 | 12 | 30 | 10 | 11 | 34 | 85 |
| terrain-snapping | 967 | 13 | 23 | 12 | 9 | 18 | 62 |
| viewport-inference | 2098 | 32 | 36 | 15 | 17 | 32 | 100 |
| **19 pages** | | | | | | | **1378** |

## Bespoke pages (src/lib/gipfelbuch/pages)

Every page has the same skeleton: a `Page` default export (`Beat`, `Trio`, `Numbers`, `Details`, `Steps`/`Flow`, `Callout` from the kit), one hero (`HeroStages`/`Hero*`, `Stages` of `RealPhoto` panels), several interactive teaching figures, `Real*` figures that draw SVG overlays on measured photo data (`Measured`, `PhotoPicker`, `RealPhoto`, `DemPatch`), `Mini*` thumbnails for `Trio`, and a `Deep`/`Legacy` section built from `Section`/`Steps`/`Stat`. No page imports another page; each page's private helpers (`Slider`, `Toggle`, `Readout`, `Tag`, `Box`, `Chip`, `Cell`) are local copies, so cross-page coupling is only through the kit. Pages drive animation with `useTime` (rAF through the shared hook) and `useReducedMotion`.

### accept-rule.tsx (1661 lines, ~50 sites)

Data: confidence bars (Bar), ConfidenceVsError scatter (Plot), ladder/verdict-tree nodes. Furniture: cards and rings around thumbs (ring-2 plus boxShadow selection ring), Legacy panel boxes. The 291-line `decide` is logic, not drawing.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Bar | 94 | 52 | 0 | 2 | 2 | 1 |  |  |
| RealDecisions | 146 | 149 | 0 | 3 | 2 | 1 | state | Figure,Measured,RealPhoto |
| ConfidenceVsError | 295 | 151 | 3 | 0 | 0 | 2 | pointer+state | Figure,Plot |
| Dots | 446 | 30 | 0 | 1 | 1 | 1 |  |  |
| PrecisionLadder | 476 | 96 | 0 | 0 | 3 | 2 | time+state | Figure,Stat |
| VerdictTree | 863 | 263 | 4 | 0 | 1 | 5 | time+state | Figure |
| Legacy | 1126 | 170 | 0 | 5 | 1 | 0 |  | Section,Steps,Callout |
| Verdicts | 1306 | 34 | 0 | 0 | 1 | 1 |  | Figure,Gallery,RealPhoto |
| BarScale | 1340 | 48 | 2 | 0 | 0 | 1 |  |  |
| TwoSolvers | 1388 | 27 | 0 | 2 | 0 | 0 |  |  |
| ScoreFit | 1415 | 143 | 1 | 0 | 1 | 1 | state | Figure,Measured,PhotoPicker,RealPhoto,Eq,Sym,Frac |
| AcceptRule | 1558 | 104 | 0 | 0 | 0 | 0 |  | Beat,Trio,Numbers,Details |

### baseline-pipeline.tsx (2051 lines, ~92 sites)

Conveyor (animated stage belt, 5 `*Artefact` mini-drawings), CascadeFlow, YawSearch (345 lines, Plot-less SVG score curve). Data: yaw-search curve, 12-photo bars, time bars. Furniture: Box/Rail/Panel nodes, arrows.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Conveyor | 121 | 224 | 10 | 1 | 0 | 9 | time | Figure |
| MetaArtefact | 345 | 38 | 2 | 0 | 0 | 2 |  |  |
| HorizonArtefact | 383 | 42 | 3 | 0 | 0 | 2 |  |  |
| SkylineArtefact | 425 | 44 | 4 | 0 | 0 | 3 |  |  |
| GridArtefact | 469 | 57 | 2 | 0 | 0 | 3 |  |  |
| GateArtefact | 526 | 92 | 3 | 0 | 0 | 4 |  |  |
| CascadeFlow | 618 | 101 | 2 | 0 | 0 | 2 | time | Figure |
| Box | 719 | 50 | 1 | 0 | 0 | 2 |  |  |
| Variants | 796 | 50 | 0 | 0 | 2 | 1 |  | Figure |
| TimeBar | 899 | 41 | 0 | 0 | 1 | 1 |  |  |
| MeasuredOnePhoto | 940 | 123 | 0 | 0 | 1 | 0 |  | Figure,Measured,PhotoPicker,RealPhoto |
| AllTwelve | 1063 | 113 | 0 | 2 | 3 | 2 |  | Figure,Measured |
| GroundTruthEval | 1176 | 56 | 0 | 4 | 2 | 2 |  | Figure |
| Deep | 1232 | 181 | 0 | 0 | 0 | 0 | state | Section,Steps,Stat,Callout |
| HeroStages | 1413 | 65 | 0 | 0 | 0 | 0 |  | Figure,Measured,Stages,RealPhoto |
| YawSearch | 1594 | 345 | 6 | 1 | 2 | 6 | state | Figure,Measured,PhotoPicker,RealPhoto,Eq,Sym,Frac |
| Page | 1939 | 113 | 0 | 0 | 0 | 0 |  | Beat,Trio,Figure,Gallery,RealPhoto,Details |

### camera-prior.tsx (1489 lines, ~79 sites)

PriorLab (383 lines, slider + time, 17 primitives, the densest figure), Strip (191 lines, 7 primitives + 8 fills), YawBars, PriorTrio. Data: yaw error bars, prior wedge. Furniture: lab frame, gauge ticks.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| RealPrior | 112 | 70 | 0 | 0 | 1 | 0 |  | Figure,Measured,PhotoPicker,RealPhoto,DemPatch,Stat |
| Strip | 182 | 191 | 7 | 0 | 0 | 8 |  |  |
| PriorErrors | 373 | 99 | 0 | 0 | 2 | 0 |  | Figure,Stat |
| PriorLab | 472 | 383 | 17 | 8 | 7 | 12 | time+slider+state | Key,Figure,Stat |
| Deep | 855 | 189 | 0 | 0 | 0 | 0 | state | Section,Figure,Flow,Steps,Stat,Callout |
| YawBars | 1114 | 103 | 3 | 0 | 1 | 4 |  | Figure,Measured |
| PriorTrio | 1217 | 138 | 4 | 0 | 0 | 5 |  | Trio |
| Page | 1392 | 98 | 0 | 0 | 0 | 0 |  | Beat,Figure,Gallery,RealPhoto,Details,Callout |

### camera-roll.tsx (2005 lines, ~85 sites)

RollLinker/ViewpointWalk/PanoramaStrip/RealRoll are map-like SVG scenes with `g` groups; 14 pointer/click handlers (many are Chip/slider UI). Data: photo positions, yaw offsets, median lines. Furniture: link circles, plan frames, compass. Also embeds RollCompasses (out of scope, components/site/meta).

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Chip | 101 | 53 | 0 | 1 | 1 | 1 |  |  |
| RollLinker | 182 | 175 | 8 | 0 | 1 | 2 | time+state | Figure |
| ViewpointWalk | 384 | 126 | 4 | 0 | 1 | 2 | time+state | Figure |
| PoseLadder | 510 | 93 | 0 | 1 | 1 | 1 | state | Figure |
| CompassBias | 603 | 163 | 4 | 0 | 0 | 2 | state | Figure |
| PanoramaStrip | 843 | 212 | 5 | 10 | 1 | 2 | time+state | Figure |
| RealRoll | 1081 | 282 | 13 | 1 | 3 | 5 | state | Figure,Measured |
| RealBias | 1363 | 158 | 4 | 0 | 0 | 3 |  | Figure,Measured |
| HeroStages | 1547 | 93 | 1 | 1 | 1 | 0 |  | Figure,Measured,Stages,Gallery,RealPhoto,DemPatch |
| MiniPlan | 1640 | 39 | 2 | 2 | 0 | 1 |  |  |
| Page | 1718 | 288 | 0 | 0 | 0 | 0 |  | Beat,RollCompasses,Eq,Sym,Trio,Details,Figure,Callout,Steps |

### dem-anchoring.tsx (1804 lines, ~77 sites)

CurveFigure (276), CandidateFigure, GaugeFigure (slider) share the anchoring curve vocabulary with step-inside AnchorCurve. Data: fitted curve, candidate points, quality bars. Furniture: gauges, windows.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| CurveFigure | 371 | 276 | 9 | 3 | 1 | 7 | time+state | Figure |
| CandidateFigure | 675 | 197 | 10 | 0 | 0 | 7 | time | Figure |
| GaugeFigure | 872 | 218 | 7 | 0 | 0 | 6 | slider+state | Figure |
| HeroStages | 1133 | 62 | 0 | 0 | 1 | 1 |  | Figure,Stages,RealPhoto |
| MiniCurves | 1195 | 51 | 2 | 0 | 1 | 0 |  |  |
| MiniQuality | 1246 | 62 | 3 | 0 | 1 | 1 |  |  |
| RealCurves | 1345 | 100 | 2 | 2 | 2 | 0 |  | Figure,Plot |
| RealQuality | 1445 | 135 | 4 | 0 | 0 | 3 |  | Figure |
| Page | 1580 | 225 | 0 | 2 | 1 | 0 |  | Beat,Trio,Numbers,Details,Steps |

### dem-horizon.tsx (1774 lines, ~95 sites)

RayMarch (336 lines, 18 primitives, time + slider), Sweep (276, 14 prims), Ladder (228, 9 kit deps), ProfilePlot via Plot, HorizonOverlay on a photo. Twin of peak.tsx RayMarch. Data: terrain profile, ray samples, horizon line. Furniture: sky/ground fills, ray fans, legend.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| RayMarch | 144 | 336 | 18 | 5 | 2 | 16 | time+slider+state | Figure |
| Sweep | 567 | 276 | 14 | 2 | 1 | 11 | time+slider+state | Figure |
| DistLegend | 850 | 15 | 0 | 0 | 1 | 2 |  |  |
| HorizonOverlay | 894 | 62 | 2 | 0 | 0 | 0 |  |  |
| ProfilePlot | 956 | 75 | 3 | 0 | 0 | 2 |  | Plot |
| RealHorizon | 1031 | 88 | 0 | 0 | 1 | 0 |  | Figure,Measured,PhotoPicker,RealPhoto |
| Ladder | 1190 | 228 | 6 | 0 | 1 | 2 | slider+state | Figure,Measured,RealPhoto,Mark,Plot,MarkList,Eq,Sym,Frac |
| MiniGround | 1423 | 45 | 4 | 0 | 0 | 2 |  |  |
| Page | 1519 | 256 | 0 | 0 | 0 | 0 | state | Beat,Trio,Numbers,Details,Steps,Callout |

### dem-source.tsx (1057 lines, ~51 sites)

Hero (Compare slider), Disagree (Plot), Ladder (slider), FallbackMini, PixelCard and Encoding (bordered cards). Mostly light; small figure count.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Hero | 128 | 119 | 2 | 2 | 1 | 2 |  | Figure,Measured,Compare,Key |
| Disagree | 247 | 101 | 5 | 0 | 1 | 0 |  | Figure,Measured,Plot,Key |
| GroundGap | 348 | 60 | 1 | 0 | 0 | 2 |  | Figure,Measured |
| PixelCard | 408 | 18 | 0 | 2 | 1 | 1 |  |  |
| BandsMini | 426 | 73 | 1 | 0 | 0 | 4 |  |  |
| FallbackMini | 499 | 81 | 6 | 0 | 0 | 5 |  |  |
| Ladder | 580 | 141 | 3 | 0 | 0 | 2 | slider+state | Figure |
| Encoding | 752 | 43 | 0 | 4 | 2 | 1 |  | Figure,Measured |
| Page | 795 | 263 | 0 | 2 | 1 | 0 |  | Beat,Trio,Numbers,Details,Flow,Steps,Callout |

### eye-rule.tsx (1302 lines, ~69 sites)

Hero (301 lines, 15 prims, time), SideView, RealOffsets (188), DriftPlot via Plot. Private UI atoms Slider/Toggle/Readout/NumberCard are bordered widgets. Data: offsets, drift series. Furniture: eye-height rulers, side-view terrain fill.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Toggle | 137 | 13 | 0 | 3 | 1 | 0 |  |  |
| Readout | 150 | 20 | 0 | 2 | 1 | 0 |  |  |
| Hero | 170 | 301 | 15 | 0 | 0 | 7 | time+state | Figure |
| RealOffsets | 495 | 188 | 8 | 0 | 1 | 7 |  | Figure,Measured |
| RealContour | 683 | 92 | 0 | 0 | 1 | 1 |  | Figure,Measured |
| DriftPlot | 775 | 65 | 2 | 0 | 0 | 2 |  | Figure,Plot |
| SideView | 840 | 130 | 6 | 0 | 2 | 7 |  |  |
| NumberCard | 1060 | 13 | 0 | 2 | 1 | 0 |  |  |
| Page | 1073 | 230 | 0 | 0 | 0 | 0 |  | Beat,Trio,Numbers,Details,Flow,Callout |

### peak.tsx (1964 lines, ~80 sites)

RayMarch (400 lines, largest single figure, time + slider; twin of dem-horizon), LabelLayout (259, time + slider), HiddenSummit, RealOcclusion, RealSummits (pill cards). Data: summit positions, occlusion rays, label boxes. Furniture: ray fan, label leaders, frames.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| RayMarch | 139 | 400 | 10 | 3 | 2 | 9 | time+slider+state | Figure |
| LabelLayout | 586 | 259 | 9 | 2 | 2 | 8 | time+slider+state | Figure |
| HiddenSummit | 866 | 245 | 9 | 0 | 1 | 4 |  | Figure,Measured,RealPhoto,Eq,Sym,Frac |
| YawSlide | 1111 | 159 | 3 | 0 | 0 | 2 | slider+state | Figure,Measured,RealPhoto,Eq,Sym |
| RealSummits | 1275 | 113 | 1 | 4 | 2 | 0 | state | Figure,Measured,PhotoPicker,RealPhoto,DemPatch |
| RealOcclusion | 1420 | 148 | 5 | 0 | 0 | 3 |  | Figure,Measured |
| Page | 1601 | 364 | 0 | 0 | 0 | 0 |  | Figure,Measured,Compare,RealPhoto,Beat,Trio,Gallery,Numbers,Details,Section,Steps,Callout |

### photo-workspace.tsx (1575 lines, ~88 sites)

PoseJourney (414 lines, 20 prims, 24 fills, time + slider: the heaviest in the set), PinSolve (255, requestAnimationFrame easing at l.743), PeakProjection. Data: pin positions, solve trace. Furniture: workspace mock chrome (panels, toolbars, border boxes), layers.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| PoseJourney | 215 | 414 | 20 | 4 | 3 | 24 | time+slider+state | Figure |
| PinSolve | 719 | 255 | 9 | 6 | 3 | 8 | raf+state | Figure |
| MeasuredWorkspace | 1007 | 70 | 0 | 0 | 0 | 0 |  | Figure,Measured,RealPhoto |
| PeakProjection | 1077 | 122 | 3 | 2 | 2 | 2 | state | Figure,Key,Measured,RealPhoto |
| HeroJourney | 1199 | 62 | 0 | 0 | 0 | 0 |  | Figure,Measured,Stages,RealPhoto |
| Page | 1277 | 299 | 0 | 1 | 0 | 0 |  | Beat,Eq,Sym,Frac,Trio,Numbers,Details,Section,Steps,Stat,Callout |

### photo.tsx (1205 lines, ~47 sites)

Anatomy (266, time), FieldsTable/FieldRow (div table with borders), Survival, TiltMini, LensMini, AltitudeCheck. Table-style content: mostly boxes, few drawn lines.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Anatomy | 170 | 266 | 13 | 4 | 2 | 8 | time+state |  |
| RealRecord | 436 | 42 | 0 | 0 | 2 | 0 | state | Figure,Measured,PhotoPicker |
| FieldRow | 478 | 32 | 0 | 2 | 0 | 0 |  |  |
| FieldsTable | 510 | 81 | 0 | 1 | 0 | 0 |  | Figure |
| Survival | 591 | 66 | 0 | 1 | 1 | 1 | state |  |
| Deep | 663 | 129 | 0 | 0 | 0 | 0 |  | Section,Steps,Figure,Callout |
| HeroMarks | 815 | 65 | 0 | 0 | 0 | 0 |  | Figure,Measured,RealPhoto,Mark,MarkList |
| TiltMini | 903 | 47 | 2 | 0 | 0 | 1 |  |  |
| LensMini | 950 | 34 | 2 | 0 | 0 | 3 |  |  |
| AltitudeCheck | 1005 | 47 | 0 | 2 | 1 | 0 |  | Figure,Gallery,RealPhoto |
| Page | 1135 | 71 | 0 | 0 | 0 | 0 |  | Beat,Trio,Details |

### pose-estimate.tsx (1797 lines, ~96 sites)

PoseExplorer (377, 17 prims), DofLadder (12 box sites, 14 border classes in file), ProvenanceCard, Dial, PoseResiduals via Plot. Highest border/ring count of any page (30): cards and chips (Tag, Row) dominate. Data: residual series, dial needle. Furniture: dials, ladders, cards.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| PoseExplorer | 183 | 377 | 17 | 6 | 3 | 9 | time+state | Figure |
| DofLadder | 571 | 161 | 0 | 12 | 6 | 2 | state | Figure |
| ProvenanceCard | 732 | 132 | 0 | 6 | 4 | 1 | slider+state | Figure |
| RealPose | 888 | 110 | 0 | 4 | 2 | 1 |  | Figure,Measured,PhotoPicker,RealPhoto |
| PoseResiduals | 998 | 113 | 4 | 0 | 1 | 2 |  | Figure,Plot,Stat |
| Legacy | 1120 | 211 | 0 | 0 | 0 | 0 | state | Section,Steps,Stat,Callout |
| HeroPose | 1331 | 123 | 5 | 0 | 0 | 0 |  | Figure,Measured,RealPhoto,Mark,MarkList |
| Dial | 1454 | 78 | 5 | 0 | 1 | 3 |  |  |
| Tag | 1579 | 28 | 0 | 2 | 0 | 0 |  |  |
| PoseExplainer | 1664 | 134 | 0 | 0 | 0 | 0 |  | Beat,Trio,Figure,Gallery,RealPhoto,Numbers,Details |

### rigi.tsx (736 lines, ~38 sites)

Registration (259, 13 prims, time + slider; also drives the landing hero idea), Constellation (cards), HeroStages. Embeds HowItWorksScene (out of scope, components/site/how). Small page.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| Registration | 67 | 259 | 13 | 2 | 2 | 13 | time+slider+state |  |
| Constellation | 326 | 62 | 0 | 3 | 2 | 1 | state |  |
| HeroStages | 392 | 72 | 0 | 0 | 0 | 0 |  | Figure,Measured,Stages,RealPhoto,Key |
| Twelve | 571 | 37 | 0 | 0 | 1 | 1 |  | Figure,Gallery,RealPhoto |
| Page | 608 | 129 | 0 | 0 | 0 | 0 |  | Beat,HowItWorksScene,Numbers,Details,Figure |

### skyline.tsx (1331 lines, ~33 sites)

ViterbiScan is the only Canvas 2D figure in the pages (getContext l.365, canvas l.448; time + slider; per-pixel cost image, must stay raster, so convert by drawing sketch strokes on the canvas or replacing with hachure tiles). CleanAndFuse, WeightStrip, RealSkyline. Smallest page.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| ViterbiScan | 355 | 279 | 7 | 3 | 2 | 1 | time+slider+canvas+state | Figure |
| CleanAndFuse | 707 | 153 | 6 | 3 | 1 | 3 | state | Figure |
| WeightStrip | 884 | 49 | 4 | 0 | 0 | 2 |  |  |
| RealSkyline | 933 | 68 | 0 | 0 | 1 | 0 | state | Figure,Measured,PhotoPicker,RealPhoto |
| HeroStages | 1001 | 62 | 0 | 0 | 0 | 0 |  | Figure,Measured,Stages,RealPhoto |
| Skyline | 1105 | 227 | 0 | 0 | 0 | 0 |  | Beat,Trio,Eq,Sym,Numbers,Details |

### step-inside.tsx (1971 lines, ~89 sites)

SplitRuler (278, time), ConfidenceDisc (246, 13 prims, time), AnchorCurve (167), RealRange (194), RangeBar, MiniBars. Line-heavy (20 `line` tags): rulers, ticks. Data: split points, range bars, curve. Furniture: rulers, discs.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| SplitRuler | 111 | 278 | 11 | 0 | 0 | 8 | time+state | Figure |
| ConfidenceDisc | 431 | 246 | 13 | 1 | 0 | 8 | time+state | Figure |
| Provenance | 677 | 44 | 0 | 2 | 2 | 1 |  | Figure |
| RealRange | 738 | 194 | 5 | 0 | 3 | 0 | state | PhotoPicker,Figure,Measured |
| RealEye | 932 | 132 | 3 | 0 | 1 | 3 | state | Figure |
| RealCompression | 1064 | 85 | 2 | 0 | 0 | 4 |  | Figure |
| RangeBar | 1162 | 55 | 3 | 0 | 0 | 1 |  |  |
| HeroStages | 1217 | 90 | 0 | 0 | 0 | 0 |  | Figure,Measured,Stages,RealPhoto,Key |
| AnchorCurve | 1323 | 167 | 7 | 0 | 0 | 5 |  |  |
| RealSplit | 1490 | 65 | 0 | 0 | 1 | 0 |  | Figure,Key,Measured,Compare |
| MiniBars | 1555 | 60 | 1 | 0 | 0 | 4 |  |  |
| Page | 1629 | 343 | 0 | 0 | 0 | 0 |  | Beat,Eq,Sym,Trio,Numbers,Details,Steps,Flow,Stat,Callout |

### tap-a-peak.tsx (1466 lines, ~62 sites)

PinLock (291, 10 prims + 8 box sites, time), PeakChooser (slider), TapFrame, TapTile/Cell (tile borders), OneTap, MissBars. Data: tap positions, miss bars. Furniture: crosshair frames, tile cards.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| PinLock | 215 | 291 | 10 | 8 | 4 | 9 | time+state | Figure |
| PeakChooser | 506 | 201 | 5 | 2 | 0 | 3 | slider+state | Figure |
| TapFrame | 733 | 110 | 6 | 0 | 0 | 2 |  | RealPhoto |
| RealTaps | 843 | 66 | 0 | 3 | 1 | 0 | state | Figure,Measured,PhotoPicker |
| HeroTaps | 941 | 62 | 0 | 0 | 0 | 0 |  | Figure,Measured,Stages |
| OneTap | 1003 | 133 | 4 | 0 | 0 | 4 |  | Figure,Measured,RealPhoto,Eq,Sym |
| MissBars | 1136 | 65 | 0 | 0 | 1 | 0 |  | Figure,Measured |
| Page | 1201 | 266 | 0 | 0 | 0 | 0 |  | Beat,Trio,Figure,Gallery,Numbers,Details,Section,Flow,Steps,Callout |

### terrain-sampler.tsx (1462 lines, ~85 sites)

LevelRings (242) and BilinearProbe (349, pointer drag + time) are the only pointer-driven SVG figures; LevelCost via Plot; Mini figures (Levels/Blend/Hole) are grids of flat cells (hachure candidates). Data: sampled heights, cost series.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| LevelRings | 162 | 242 | 7 | 2 | 3 | 7 | time+pointer+state | Figure,Measured |
| BilinearProbe | 404 | 349 | 8 | 8 | 5 | 9 | time+pointer+state | Figure,Measured,Eq,Sym |
| LevelCost | 753 | 112 | 3 | 0 | 1 | 0 |  | Figure,Measured,Plot,Key |
| AskTheMap | 880 | 103 | 3 | 0 | 2 | 1 |  | Figure,Measured,Mark,MarkList |
| LevelsMini | 983 | 74 | 1 | 0 | 0 | 5 |  |  |
| BlendMini | 1057 | 75 | 2 | 0 | 0 | 5 |  |  |
| HoleMini | 1132 | 82 | 6 | 0 | 0 | 7 |  |  |
| Page | 1214 | 249 | 0 | 0 | 0 | 0 |  | Beat,Trio,Numbers,Details,Steps,Flow,Callout |

### terrain-snapping.tsx (967 lines, ~62 sites)

RealEye (174, 10 fills), PeakReal (222, 8 box sites), Ledger table, Mini* (Snap/Bound/Prior). Several terrain-bound figures on real DEM. Moderate.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| RealEye | 127 | 174 | 5 | 0 | 1 | 10 |  | Figure,Measured |
| PeakReal | 329 | 222 | 5 | 8 | 6 | 3 |  | Figure,Measured |
| Ledger | 551 | 48 | 0 | 4 | 1 | 0 |  |  |
| Hero | 599 | 63 | 0 | 0 | 0 | 1 |  | Figure,RealPhoto,Mark,MarkList |
| MiniSnap | 683 | 28 | 4 | 0 | 0 | 2 |  |  |
| MiniBound | 711 | 47 | 6 | 0 | 0 | 2 |  |  |
| MiniPrior | 758 | 28 | 3 | 0 | 0 | 0 |  |  |
| Page | 786 | 182 | 0 | 0 | 0 | 0 |  | Beat,Trio,Numbers,Details |

### viewport-inference.tsx (2098 lines, ~100 sites)

Largest and most varied: HorizonLock (249, time), CostLandscape (heat grid via memoised HeatCells, `GRID`/`RING` constants, flat cells), FullCircle (163, time), ConfidenceGate/RealGrid/RealGate, ResidualStrip, Legacy (209 lines of Steps/Flow). 32 functions. Data: cost grid cells (many; keep memo), residuals. Furniture: ring/gate/frames.

| Function | Line | Span | prim | box | rnd | fill | Dynamics | Kit deps |
|---|---:|---:|---:|---:|---:|---:|---|---|
| HorizonLock | 183 | 249 | 11 | 4 | 5 | 12 | time+state | Figure |
| CostLandscape | 627 | 175 | 7 | 0 | 0 | 5 | time | Figure |
| FullCircle | 802 | 163 | 9 | 1 | 1 | 5 | time | Figure |
| ConfidenceGate | 1060 | 112 | 0 | 4 | 4 | 2 | state | Figure |
| RealStory | 1191 | 90 | 0 | 2 | 2 | 1 | time+state | Figure,Measured,PhotoPicker,RealPhoto |
| RealGrid | 1281 | 79 | 0 | 3 | 3 | 1 |  | Figure |
| RealGate | 1360 | 105 | 4 | 0 | 1 | 3 |  | Figure,Plot |
| Legacy | 1499 | 209 | 0 | 1 | 0 | 0 | state | Section,Flow,Steps,Stat,Callout |
| ResidualStrip | 1708 | 76 | 4 | 0 | 0 | 2 |  |  |
| Verdicts | 1927 | 46 | 0 | 0 | 1 | 1 |  | Figure,Gallery,RealPhoto |
| ViewportInference | 1973 | 126 | 0 | 0 | 0 | 0 |  | Beat,Trio,Numbers,Details |

## Shared kit (src/components/gipfelbuch/viz)

`viz/index.ts` and `viz/hooks.ts` have no drawing (`useInView`, `useReducedMotion`, `useRaf`, `useTime` are the animation clock for every page; leave them alone).

### viz/explain.tsx (564 lines, ~45 sites)

The most reused file: `Stages` (ring cards with state), `Trio`, `Compare` (drag-to-reveal slider: pointer capture plus a requestAnimationFrame auto-sweep at l.133, the hardest kit item), `Details` (disclosure box), `Numbers` (stat boxes), `Gallery`/`GalleryTile`, `Mark`/`MarkList` (SVG overlay glyphs for peak marks, data), `Key` (legend swatches). 13 ring and 5 border classes in total; touching it changes every page's chrome at once.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Details | 69 | 34 | 0 | 2 | 3 | 0 |  |
| Compare | 103 | 106 | 0 | 8 | 3 | 0 | pointer+raf+state |
| Stages | 209 | 88 | 0 | 9 | 4 | 0 | state |
| Trio | 297 | 49 | 0 | 4 | 2 | 0 |  |
| Numbers | 346 | 35 | 0 | 2 | 0 | 0 |  |
| GalleryTile | 411 | 30 | 0 | 0 | 1 | 0 |  |
| Mark | 441 | 43 | 1 | 0 | 0 | 2 |  |
| MarkList | 484 | 25 | 0 | 2 | 1 | 0 |  |
| Key | 509 | 40 | 1 | 0 | 0 | 0 |  |

### viz/real.tsx (779 lines, ~36 sites)

`RealPhoto` (196 lines: photo with SVG overlay: skyline trace, horizon, peak pins; DATA marks, plus a bordered frame), `PeakLabels` (label boxes and leaders), `DemPatch` (154 lines: DEM heightmap tile with contour/ridge paths and fills; image-based, no canvas), `PhotoPicker` (thumbnail chips with rings), `Measured` (caption chip). Used by 16 of 19 pages.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| RealPhoto | 251 | 196 | 4 | 5 | 4 | 1 | state |
| PeakLabels | 447 | 109 | 3 | 0 | 0 | 0 |  |
| DemPatch | 556 | 154 | 6 | 2 | 2 | 5 |  |
| PhotoPicker | 740 | 40 | 0 | 3 | 1 | 0 |  |

### viz/Plot.tsx (163 lines, ~4 sites)

Shared SVG plot: axes, graticule, ticks, labels (all FURNITURE) and the `s.line`/`s.area` helpers whose output pages render as DATA paths. Converting the axis and grid here converts every Plot caller (used in 8 pages); the area helper is where flat area fills become hachure.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Plot | 36 | 128 | 4 | 0 | 0 | 0 |  |

### viz/Steps.tsx (123 lines, ~9 sites)

`Flow` (node boxes with arrow `path`s, SVG) and `Steps` (numbered list with border-left rule).

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Flow | 20 | 70 | 2 | 0 | 2 | 1 |  |
| Steps | 90 | 34 | 0 | 3 | 1 | 0 |  |

### viz/Figure.tsx (57 lines, ~1 sites)

Figure frame (border plus rounded) used by nearly every figure on every page.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Figure | 10 | 48 | 0 | 0 | 1 | 0 |  |

### viz/Section.tsx (83 lines, ~2 sites)

`Section` heading rule (border) and `Stat` tile.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Section | 17 | 40 | 0 | 1 | 1 | 0 |  |

### viz/Callout.tsx (48 lines, ~2 sites)

Rounded callout box.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Callout | 17 | 32 | 0 | 0 | 2 | 0 |  |

### viz/CodeRef.tsx (36 lines, ~1 sites)

Inline code chip.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| CodeRef | 9 | 28 | 0 | 0 | 1 | 0 |  |

### viz/DemoImage.tsx (45 lines, ~4 sites)

Rounded demo image with frame (4 rounded classes).

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| DemoImage | 21 | 25 | 0 | 0 | 4 | 0 |  |

### viz/math.tsx (130 lines, ~7 sites)

OWNED BY ANOTHER SESSION, do not touch (fraction bars, `Eq` frame).

## Shell components (src/components/gipfelbuch)

### AutoVisual.tsx (152 lines, ~6 sites)

Generated fallback visual for concepts with no bespoke page: SVG circles, path and line from a seeded hash, gradients, `useTime` animation. Furniture mostly; data-free.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| AutoVisual | 27 | 126 | 5 | 0 | 0 | 1 | time |

### ConceptPage.tsx (518 lines, ~7 sites)

Page shell: border rules (inline `borderTop`/`borderBottom` style, 7), `Chip`, `NodeCard`, `ConnectionGroup`, `Rail`. Boxes only, no SVG.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Chip | 71 | 23 | 0 | 1 | 0 | 0 |  |
| NodeCard | 94 | 53 | 0 | 1 | 0 | 0 |  |
| ConnectionGroup | 147 | 64 | 0 | 1 | 0 | 0 |  |
| ConceptPage | 211 | 288 | 0 | 3 | 0 | 0 |  |
| Rail | 499 | 20 | 0 | 1 | 0 | 0 |  |

### CoreMap.tsx (560 lines, ~14 sites)

SVG concept map: node rects, edge `path`s (`edgePath`), legend, pointer hover and click. Edges are DATA (graph links), node rects FURNITURE.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| CoreMap | 251 | 249 | 8 | 1 | 0 | 4 | pointer+state |
| Legend | 524 | 37 | 1 | 0 | 0 | 0 |  |

### GraphCanvas.tsx (725 lines, ~9 sites)

653-line Canvas 2D force-graph renderer with its own requestAnimationFrame loop (l.338, 360, 656), gradients, ring selection. HARD: every stroke and fill is canvas `ctx` calls, needs a canvas-side rough-stroke helper (seeded, cached per edge, not re-randomised per frame). Does not use React JSX primitives, so the scan under-counts it; real sites are the ctx.stroke/fill calls.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| GraphCanvas | 73 | 653 | 0 | 5 | 3 | 1 | canvas+raf+state |

### GraphView.tsx (322 lines, ~22 sites)

Container for GraphCanvas plus legend and `StatusGlyph` (5 SVG glyph primitives), `NeighbourhoodGraph`. Bordered panels and toggles.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| useOpen | 20 | 9 | 0 | 2 | 0 | 0 |  |
| GraphView | 29 | 209 | 0 | 6 | 6 | 3 | state |
| StatusGlyph | 238 | 54 | 5 | 0 | 0 | 0 |  |

### OntologyPanel.tsx (366 lines, ~5 sites)

Card and chip list: rounded boxes only, no SVG.

| Function | Line | Span | prim | box | rnd | fill | Dynamics |
|---|---:|---:|---:|---:|---:|---:|---|
| Word | 36 | 18 | 0 | 0 | 1 | 0 |  |
| Card | 69 | 6 | 0 | 0 | 1 | 0 |  |
| OntologyPanel | 108 | 259 | 0 | 0 | 3 | 0 |  |

## Swiss sheet furniture (src/components/gipfelbuch/swiss)

This is the cartographic-furniture set (`SheetMap`, `SheetFrame`, `Legend`, `Cartouche`, `ScaleBar`, `Signpost`, `Waymark`, `ContourField`, `HachureRule`, `FurnitureSheet`), used by the routes `gipfelbuch.index`, `gipfelbuch.$concept` and `dev.gipfelbuch-sheet`, not by the 19 pages. It is already close to the target look (hachure rule, contour field); the work is to remove crisp frames and flat fills. Counts come from stroke/fill attributes more than tags: `SheetMap` has 35 stroke and 18 fill attributes, `Legend` 18 and 11, `SheetFrame` and `Cartouche` use inline `background` and gradients for the frame and title block (outlined box furniture, no SVG tags).

| File | Lines | ~Sites | Notes |
|---|---:|---:|---|
| Cartouche | 56 | 2 | title block, inline background fill |
| ContourField | 91 | 4 | contour paths + 2 gradients (DATA: contours) |
| FurnitureSheet | 79 | 0 | layout wrapper |
| HachureRule | 71 | 3 | seeded hachure generator, reusable |
| Legend | 159 | 15 | 7 symbol drawers (Contour, Water, Route, Peak, Viewpoint, Rock, Glacier) |
| ScaleBar | 78 | 3 | alternating rect bar, flat fills |
| SheetFrame | 125 | 4 | neat-line frame, graticule gradients, formatLv95 |
| SheetMap | 312 | 30 | Sheet (219 lines: terrain, water, routes, peaks, 15 prims, 12 fills), ViewpointCallout |
| Signpost | 72 | 1 | inline background plate |
| Waymark | 83 | 7 | Blaze (5 prims) path markers |

Stroke/fill attribute counts, which include props inherited via `<g>`: SheetMap ~53, Legend ~29, ContourField 8, HachureRule 8, ScaleBar 5, Waymark 7. Treat the swiss set as roughly 90 sites despite the low tag count.

## Hard items (read before assigning)

| Item | Where | Why hard |
|---|---|---|
| Canvas 2D per-pixel/cost drawing | skyline.tsx ViterbiScan (l.355 getContext, l.448 canvas, time + slider) | Not JSX; sketch strokes must be drawn on the canvas or the raster replaced with hachure tiles |
| Canvas 2D force graph with own rAF loop | GraphCanvas.tsx (653 lines, rAF at l.338/360/656) | All drawing is `ctx` calls; roughness must be seeded and cached per node/edge or it shimmers every frame; scan undercounts sites |
| Drag-to-reveal comparator with rAF sweep | viz/explain.tsx Compare (l.103, pointer + rAF l.133) | Used by many pages; the clip edge must stay pixel-exact while its frame sketches |
| Direct rAF easing | photo-workspace.tsx PinSolve (l.743) | Geometry changes every frame; seeded jitter must not re-roll per frame |
| Pointer-driven SVG | terrain-sampler.tsx LevelRings (l.214), BilinearProbe (l.483), CoreMap hover | Hit-testing must keep using exact geometry, only the paint changes |
| Time-driven figures (useTime) | about 50 figures, every page; biggest: photo-workspace PoseJourney 414 lines, peak RayMarch 400, pose-estimate PoseExplorer 377, camera-prior PriorLab 383, dem-horizon RayMarch 336 | Jitter keyed to element identity (seed) not to frame; reduced-motion path must still render |
| Slider-driven figures | 30 `type="range"` sites over 13 pages | Same: stable seeds as value changes; the native range input is itself a clean box (needs custom track or styling) |
| Large grids of flat cells | viewport-inference CostLandscape/HeatCells (memo), terrain-sampler Mini* grids, dem-source BandsMini | Each cell currently a flat fill; hachure per cell is costly, consider one pattern with density by value or per-row strokes; keep memoisation |
| Long data series | Plot callers (8 pages), skyline Viterbi trace, dem-horizon ProfilePlot, dem-anchoring fitCurve output | Hand-look jitter must stay below data tolerance and not alter x/y values, nor add thousands of nodes |
| Photo and DEM overlays | viz/real.tsx RealPhoto/PeakLabels/DemPatch (used by 16 pages) | Raster stays; only SVG overlay and frame convert; label boxes sit on busy photos |
| Out-of-scope embeds | rigi.tsx HowItWorksScene, camera-roll.tsx RollCompasses, viz/math.tsx | Not converted by these packages |
| Native form controls | all `Slider`/`Toggle` copies (camera-prior, eye-rule, pose-estimate, step-inside, viewport-inference, dem-*) | Browser chrome is crisp; replace with drawn track and thumb |
| Style baselines | scripts/ci style-baseline browser check | Will change on purpose; re-baseline once per wave under the render lock |

## Work packages

Sites are the scan estimate (prim+box+rnd+fill); sketch-rendering is double-counted work per site, so treat the numbers as ratios. Pages inside a package are grouped because they share a figure vocabulary (twin figures, same data) or because one agent should keep one idiom. No page imports another page, so packages 3 to 7 touch disjoint files and can run in parallel. All of them depend on package 1's primitives.

Order: package 1 first lands a small primitive API (rough rect/box, rough polygon with hachure fill, rough polyline for data, jitter-free mode for reduced motion, a seeded PRNG keyed by id), ideally by extending `notebook/sketch.ts` and `notebook/Ink.tsx`. Pages can start in parallel against that API once its signature is agreed, and each page package should only call primitives, not hand-roll jitter.

| # | Package | Files | ~Sites | Hard items |
|---|---|---|---:|---|
| 1 | Shared kit | `src/components/gipfelbuch/viz/{Callout,CodeRef,DemoImage,Figure,Plot,Section,Steps,explain,real}.tsx` (math.tsx excluded; hooks.ts and index.ts untouched) and `src/components/gipfelbuch/swiss/{Cartouche,ContourField,FurnitureSheet,HachureRule,Legend,ScaleBar,SheetFrame,SheetMap,Signpost,Waymark}.tsx` | ~170 (plus the new primitive module, and the effect on every page) | Compare drag + rAF, RealPhoto/DemPatch overlays, Plot area hachure |
| 2 | Shell and light pages | `src/components/gipfelbuch/{AutoVisual,ConceptPage,CoreMap,GraphCanvas,GraphView,OntologyPanel}.tsx`, `src/lib/gipfelbuch/pages/{rigi,skyline,photo,dem-source}.tsx` | ~230 (shell 63 + rigi 38, skyline 33, photo 47, dem-source 51) | GraphCanvas canvas rAF, skyline ViterbiScan canvas, rigi Registration (time + slider) |
| 3 | Ray-march and eye family | `src/lib/gipfelbuch/pages/{dem-horizon,peak,eye-rule}.tsx` | ~244 (95 + 80 + 69) | Twin RayMarch figures (336 and 400 lines), LabelLayout, sliders |
| 4 | Anchoring and snapping family | `src/lib/gipfelbuch/pages/{dem-anchoring,step-inside,terrain-snapping}.tsx` | ~228 (77 + 89 + 62) | Anchor-curve twins (CurveFigure, AnchorCurve), SplitRuler and ConfidenceDisc (time) |
| 5 | Solver and decision family | `src/lib/gipfelbuch/pages/{viewport-inference,pose-estimate,accept-rule}.tsx` | ~246 (100 + 96 + 50) | CostLandscape heat grid, border-heavy cards (DofLadder, ProvenanceCard, ConfidenceGate), many private chips |
| 6 | Interaction and roll family | `src/lib/gipfelbuch/pages/{photo-workspace,tap-a-peak,camera-roll}.tsx` | ~235 (88 + 62 + 85) | PoseJourney (414 lines, 24 fills), PinSolve rAF, PinLock, PanoramaStrip (10 box sites), RollCompasses stays out of scope |
| 7 | Pipeline, prior and sampler family | `src/lib/gipfelbuch/pages/{baseline-pipeline,camera-prior,terrain-sampler}.tsx` | ~256 (92 + 79 + 85) | Conveyor and 5 Artefact mini-drawings, PriorLab, BilinearProbe and LevelRings (pointer + time), Mini grids |

Coverage check: 19 pages (4 in package 2, 3 each in packages 3 to 7), 9 viz files, 10 swiss files, 6 shell components. Not assigned (no drawing): `viz/hooks.ts`, `viz/index.ts`, `loadPage.tsx`, `force.ts`, the `notebook/` folder (reuse base), `viz/math.tsx` (another session).

Verification each package should run (AGENTS.md): `npx biome check --write` on changed files, `npx tsc --noEmit -p .`, then the fast tier once at the end; style-baseline and the browser checks are expected to move and should be re-baselined once after all packages merge, through `scripts/gpu/with-render-lock.mjs`. This inventory was not validated in a browser.
