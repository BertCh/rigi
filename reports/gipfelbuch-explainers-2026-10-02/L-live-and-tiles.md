# Pod L: live plates and multi-image tiles, 2026-10-02

Status: **spec v1, round 0 landing.** It is written against `grammar.md` v0.2 (pod G): derived under measured, playback `once` with a replay on return, sequences arming at 0.45, and the tokens `turn`, `trace` and `mark`. The token and hook names (`MOTION.*`, `EASE.*`, `useArmedInView`, `useMotionAllowed`, `groundVars`, `OverlayLayer`) are the grammar's. Where the grammar's modules have not landed, pod L codes against the names given there.

Pod L owns:
- `viz/live.tsx`: `LivePlate`, `PaperSurround`, `LiveReveal`, `LiveCompare`, `LiveDrape`, `LiveStepInside`, `LivePanorama`, `LiveTopoBoard`, `LiveHowItWorks`;
- `viz/live-notes.ts`, new: pure note helpers;
- `Trio`, `Gallery`, `Numbers` and `galleryVerdict` in `viz/explain.tsx`;
- `viz/DemoImage.tsx`.

Pages are shared. Pod L edits only the call sites of these components.

## 1. Audit (summary; the full sweep is in the pod's notes)

### 1.1 Live plates: 12 on 11 sheets

| Page | Plate | Landing counterpart | Missing against the landing |
| --- | --- | --- | --- |
| peak | `LiveReveal` demo-01 | hero `RevealLoop` + `SurroundLayer reveal` | Surround not synced to the bloom (§3.2). |
| photo-workspace | `LiveReveal` demo-01 | same | Same. Also the same photo as peak; demo-09 would vary it. |
| photo | `LiveCompare` demo-09 | hero `Compare` + `--surround-left` | Left side spill always on (§3.3). |
| camera-roll | ~~`LivePanorama`~~ + `LiveDrape` | `LiveRollMap` | **Two GPU plates on one sheet**: fixed in round 0. |
| dem-source, terrain-sampler | `LiveDrape` | `LiveRollMap` | Same plate on three sheets. The topo board was considered (§7). |
| dem-horizon | `LivePanorama` | `PanoramaSection` | None (frame = 1, no paper sides). |
| dem-anchoring, step-inside | `LiveStepInside` | `StepInsideDemo` | None beyond the grammar's. |
| rigi, baseline-pipeline | `LiveHowItWorks` | `HowItWorksScene` | The same scene on two sheets. The caption on baseline-pipeline says so. |

- Every photo plate keeps its spill. The user's concept-spill rule (README, "every single-photo figure spills") replaces the old one-spill-per-sheet rule. The two page comments that said "the plate keeps its frame, no surround" were stale and are corrected.
- `spill={false}` stays as an opt-out on every plate. Nothing uses it yet.

### 1.2 Trio (19), Gallery (13), Numbers (19)

- **Trio.** Ten of the 19 put tiles of different shapes in one row: photo crops, SVG plots with their own `viewBox`, and 4:3 cards. The step titles under them then start at different heights. That breaks the row the reader scans.
  - Mixed rows: dem-anchoring, peak, rigi, dem-horizon, camera-roll, pose-estimate, dem-source, step-inside, terrain-sampler, viewport-inference.
  - Trio itself enforces no shape.
- **Gallery.**
  - The tile verdict defaults to "rejected" for every `failure` tone. Three pages use `failure` for something that is not a solver rejection: photo (altitude off by more than 200 m), skyline (hard but solved), pose-estimate (below 0.5).
  - Accepted photos are `result` on most pages but `neutral` on dem-horizon, photo and viewport-inference.
  - accept-rule draws its own always-on chip as well, so a rejected photo says "guess" three times.
- **Numbers.** 18 of 19 have a source line. step-inside:1772 states "150 m", "60 fps" and "15 %" with none.

## 2. Background ↔ image coordination

The rule from grammar §3: the ground takes its cue from the image, and the image is never touched.

### 2.1 Live plates
- **Frame.** The frame is an always-dark island (`data-theme="dark"`), as on the landing.
  - The poster box and any letterbox (`fit="contain"`: the step photo) use `--fig-wash` for the plate's photo on `surface="plate-dark"`, falling back to `--gb-ink`.
  - Bars beside a contain-fit photo then read as the photo's own dark terrain, not a black hole.
  - Plates with no single photo (drape, panorama, how) keep `--gb-ink`.
- **Paper sides.**
  - The static bakes (`PaperSurround`) and the live line art (`LiveLines`, through `--rigi-paper`) ink with `var(--fig-terrain-ink, CONTOUR_INK)`.
  - The plate root sets `groundVars(photoId, "paper")` where the plate shows one photo: reveal and compare (demo-01, demo-09), and step-inside (IMG_7086, falling back while it has no palette entry).
  - The ridges on the paper are then tinted toward that photo's own terrain while keeping the 3:1 floor.
- **Registration.**
  - The bake projects the ridges through the solved camera, so a stroke leaves the frame where its ridge does. Pod L does not re-bake.
  - The surround box is computed from `bake.photo` exactly as `site/Surround` does, and that code path is pinned by the spec in §6.

### 2.2 Tiles
- Trio, Gallery and thumbnails never spill (rule).
- A Gallery tile's empty box (skeleton, failed load) is `--gb-paper-deep`. A loaded tile has no fill and no ring.
- A Trio row shares one visual band (§4.1). Gaps in the band are paper, never a fill.

## 3. Overlay stack

### 3.1 Live plate (z from the image up; grammar §2 roles)

| z | Role | Content | Ink | Enter |
| --- | --- | --- | --- | --- |
| 0 | ground | Paper sides; the frame's dark ground (`--fig-wash` plate-dark) | – | With the Figure |
| 0 | ground (spill) | `PaperSurround` strokes, ruler and summits; `LiveLines` past the frame | `--fig-terrain-ink` → contour | Synced to the frame (§3.2, §3.3) |
| 1 | raster | Poster, photo, engine canvas | Never filtered | Poster → engine over `crossfade` 700 |
| 2–3 | measured, derived | The baked overlay export (RevealLoop's overlay, Compare's "after"): a raster of the solved pose's lines, names and contours. Provenance: derived from the solve. | Baked | Bloom (landing) |
| 4 | furniture | Note leaders (pencil, two hand passes) | `--gb-pencil` | Draw over `draw` 900, `stagger` 110, after the plate arms |
| 5 | notes | HandNote beside the plate; red numbered markers on the frame when the gutters are narrow | `--gb-ink`, numbers `--gb-red` | Fade over `fade`, `staggerLabel` 60 |
| 6 | interaction | Compare handle, the engines' orbit cursor | White on the photo | `quick` |

### 3.2 Reveal-synced surround (`LiveReveal`)
On the landing, the side strokes wait faint (25 %) and the summit names wait hidden until the bloom front passes, and the front band brightens the strokes it crosses. Gipfelbuch's `PaperSurround` is drawn fully lit from the start, so the margin "knows" before the photo does. That reverses the causal order.
- `PaperSurround` takes `reveal?: { fill; front }` (masks from `revealMasks(revealAt(bake.photo))`) and renders the landing's three layers: base at 0.25, the fill with labels, and the front band.
  - The front band is `brightness` on paper, which darkens nothing. Use the contour ink at full opacity in place of the landing's `brightness(1.8)` + `screen`.
- RevealLoop writes `--rigi-reveal` and `--rigi-reveal-opacity` on its own frame when it has no surround, and pod L does not edit `site/**`.
  - `LiveReveal` therefore mirrors the two vars from `[data-testid=reveal-loop]` onto the plate frame with one `MutationObserver` on the `style` attribute. That is no React render per tick.
  - It copies `--rigi-reveal-opacity` as is. It maps `--rigi-reveal` from the photo's ellipse to the surround's. The radius in % is the same physical front in both, since `revealAt` scales the ellipse with the canvas.
  - When RevealLoop settles on its full radius, the surround goes to its own full radius, so the far corners light too.
- **Static.** With no var (poster, webdriver, print, reduced motion before mount), the masks fall back to fully lit: `var(--rigi-reveal, 999%)` and `var(--rigi-reveal-opacity, 1)`.

### 3.3 Compare-synced surround (`LiveCompare`)
As on the landing hero, the left side's spill shows only when the divider is near the far left, where the photo's left edge is the overlay too. The right side always matches the "after" side.
- `PaperSurround` multiplies its left mask by `var(--surround-left, 1)`, as `site/Surround` does.
- `LiveCompare` passes `onMove={(v) => frame.style.setProperty("--surround-left", t)}` with `t = clamp((0.12 − v) / 0.1)`, the landing's ramp. It starts at 0.
- **Static** (poster: the overlay shown full): `--surround-left` is unset, so it is 1. The poster is all "after", so both sides match.

### 3.4 Gallery tile

| z | Content | Notes |
| --- | --- | --- |
| 1 | The tile (RealPhoto crop or a plot) | Untouched |
| 2–3 | The tile's own layers | Owned by the page |
| 5 | Verdict word, circled (HandLoop), top right on an 85 % paper patch | One vocabulary (§5). Always on: it is state, not decoration. |
| under | Caps tone tag (✓ result / ✗ failure) and the label | Under the tile, never on the pixels |

- Page-drawn chips on the pixels that repeat the verdict are removed (accept-rule).

## 4. Animation script

### 4.1 Trio
- **Trigger.** In view (`useArmedInView`, arm 0.45 as for sequences, no reset: once).
- **Sequence.** Step n enters at `stagger(n)` (110 ms): a fade plus a 16 px rise over `enter` 1000 with `EASE.enter`. Today's values are 120 ms, 700 ms and the Tailwind default; they move to the tokens.
- **Row band.** The visuals of one Trio share a row. The grid uses `grid-rows-subgrid`: each step spans two rows, visual and text. So the tallest visual sets the band, every visual sits on the band's bottom edge, and every title starts on one line.
  - No visual is stretched or letterboxed with a fill.
  - On a phone (one column) nothing changes.
- **Motion that explains.** The order is 1 → 2 → 3, the step order. Nothing loops.
- **Static.** Reduced motion, webdriver and print show every step at once.

### 4.2 Gallery
- Tiles enter with the section (no per-tile animation): a grid of 4–12 photos staggering in would be decoration.
- The verdict circle is drawn at rest. It is not animated.

### 4.3 Numbers
- Static. No count-up: the number is the claim.

### 4.4 Live plates
- **Mount.** Near the viewport (margin 400 for the engines, `MOTION.nearMargin` 600 where a plate is the sheet's first figure). Poster → engine crossfade 700.
- **Reveal.** The landing's arm (0.75) and reset (0.2), lead 80, sweep 4200 on `1-(1-t)^3`, a replay fade of 450 and a hover replay at 350. The surround follows it (§3.2). On a phone, a tap replays it (grammar §4).
- **Compare.** No auto-sweep (landing). It starts at 0.42, and the left side follows the divider (§3.3).
- **Drape, step and panorama.** The engine's own motion. The line art ink follows `--rigi-paper` = contour, and it is re-read on a theme change.
- **Notes.** The leaders draw on once the plate is armed, one after another. The notes fade in after their leader.

## 5. Gallery verdict vocabulary (one meaning per word)

| Tone | Means | Caps tag | Circled word |
| --- | --- | --- | --- |
| `result` | The solver accepted this photo (a pose was shown) | ✓ result | none |
| `failure` | The solver refused or rejected it (no pose shown) | ✗ failure | "rejected" by default, or the page's word for the refusal ("guess", "ask") |
| `neutral` | No verdict on this figure | none | none |
| `caution` (new) | Solved, but this tile shows the thing that went wrong or is hard (altitude off, a hard skyline, low score) | ! check | The page's word, **required** (for example "240 m off", "hard", "0.41") |

Pages:
- photo, skyline and pose-estimate move from `failure` to `caution` with their own word.
- dem-horizon, photo and viewport-inference move "accepted" from `neutral` to `result`.
- viewport-inference's second solver is `caution` with "2nd solver".
- accept-rule drops its own chip, and its `tag` keeps "guess".

## 6. Static, print, reduced motion, webdriver, phone

| State | Plate | Trio | Gallery |
| --- | --- | --- | --- |
| Reduced motion | `animated` plates show the poster. The reveal is lit, with the surround lit. | All steps shown | Same as default |
| Webdriver | Poster, surround fully lit (var fallback) | All shown | Same |
| Print | Poster (`print:block`). Notes as a list when gutters are narrow. | All shown, no rise | Same |
| Phone (under 640 px) | Notes under the plate as a numbered list, with red numbers on it. Surround labels from md up only (landing). | One column | Two columns |

Specs (Vitest, node), round 1:
- `framedNotes` (landed in round 0);
- the pure helpers that land: the surround reveal mapping (radius in, radius out, settle), the compare ramp, `galleryVerdict` for the four tones, and the Trio grid class choice.

## 7. Per-page changes

| Page | Change |
| --- | --- |
| camera-roll | Panorama plate removed; drape becomes plate 3, the bias figure Fig. 4 (round 0) |
| peak, dem-source | Stale "no surround" comments corrected (round 0) |
| peak, photo-workspace | Reveal-synced surround (round 1, no page edit) |
| photo | Compare-synced left side (round 1, no page edit); Gallery `caution` with its altitude word |
| skyline, pose-estimate | Gallery `caution` with their word |
| dem-horizon, viewport-inference | Accepted becomes `result`; viewport-inference's second solver becomes `caution` |
| accept-rule | Own chip removed |
| step-inside | Numbers: a source line, or the unsourced values reworded or dropped |
| all Trio pages | Row band through subgrid (no page edit) |
| dem-source, terrain-sampler | **Not changed.** The topo board shows the swisstopo map, not the height model these pages explain. The drape is the height model under the photos, so it stays. |

## 8. Browser-pass checklist (for the coordinator's batch; everything here is browser-unverified)

1. `/gipfelbuch/peak`, `/gipfelbuch/photo-workspace` (Fig. 7 / Fig. 3 reveal plates) at 1440 px, dark and light:
   - the paper ridges sit faint at the start;
   - the bloom front crosses frame and margin as one curve;
   - the far margin corners are lit at rest;
   - a hover replay re-fades both.
2. The same under `?webdriver` (harness) and print preview: the poster, with the margin fully lit.
3. `/gipfelbuch/photo`, the Compare plate:
   - the left margin is empty at the 0.42 start;
   - it fades in as the handle nears the left edge;
   - the right margin is always on.
4. `/gipfelbuch/camera-roll`: one live plate (the drape) numbered 3, and the bias figure labelled Fig. 4.
5. Any Trio with mixed visuals (peak, rigi, dem-source, step-inside):
   - the step numbers and titles start on one line;
   - the visuals sit on a common bottom edge;
   - check at 640, 1024 and 1440 px.
6. Galleries on photo, skyline, pose-estimate, accept-rule and viewport-inference:
   - no tile says "rejected" unless the solver rejected it;
   - accept-rule tiles carry one verdict, not three.
7. Phone (390 px): plate notes become a numbered list, and Trio is one column.

## 9. Landed

| Round | sha | What |
| --- | --- | --- |
| 0 | (this commit) | live.tsx `spill` opt-out on compare, step and panorama, which also drops notes that point into an undrawn spill (`live-notes.ts` + spec); camera-roll's second GPU plate removed; stale comments corrected |
