# Pod P: hero photo (RealPhoto, GeoSpill, DemPatch, Measured, CrispLine, PAGE_HERO), 2026-10-02

Status: **spec v1.** It is written against `grammar.md` v0.2 (pod G): derived under measured, `once` playback by default, and the tokens `turn`, `trace` and `mark`. Landed units are listed in §9 with their shas.

Pod P owns `viz/real.tsx` (RealPhoto, PeakLabels, CrispLine, DemPatch, Measured, PhotoPicker), `viz/GeoSpill.tsx` and `PAGE_HERO` in `tafel/sheets.tsx`. The **sequences around a photo** (Compare, Stages) are pod C's. The **photo story** (PhotoStory) is pod S's. The **side maps** (StoryMap) are pod M's. Pod P supplies the frame they all draw into.

## 1. Audit

### 1.1 Instances
82 `RealPhoto` / `DemPatch` call sites: 76 in pages, plus StoryMap and PhotoStory. Fifteen pages open with a `RealPhoto bleed` hero (`PAGE_HERO`). `accept-rule` also has a spilled Fig. 1 but keeps its shell Tafel.

| Kind | Where | Spill pose today |
| --- | --- | --- |
| **Static hero**: photo, marks and notes, no motion | photo, pose-estimate, terrain-snapping, step-inside*, dem-anchoring* (*Stages of children only) | Fixed at solved (t = 1) |
| **Story hero**: PhotoStory | rigi, camera-prior | `story.t` through StorySync |
| **Stages hero**: Stages of RealPhotos | skyline, dem-horizon, baseline-pipeline, eye-rule, tap-a-peak, photo-workspace | `pose` on baseline-pipeline and photo-workspace, `spillT` on tap-a-peak, otherwise only the layers shown |
| **Compare hero** | viewport-inference (with StoryMap), rigi Fig. 2, peak Fig. 2 | `SpillSideContext {t: 1 − x}` |
| **Cursor figures** | dem-horizon Fig. 2, peak Fig. 3 and Fig. 5, pose-estimate Fig. 3, photo-workspace Fig. 2, tap-a-peak Fig. 2 | `spillCursor` |
| **Picker figures** | skyline Fig. 2, dem-horizon Fig. 3, pose-estimate D1, peak Fig. 1, accept-rule Fig. 1, baseline-pipeline Fig. 3 | Static |
| **DemPatch** | StoryMap (all asides), peak Fig. 1, Trio minis | n/a |

### 1.2 What the landing hero has and ours lacks

1. **Reveal.** The landing's RevealLoop arms at 75 % in view, waits for `img.decode()`, and blooms with a lead of 80 ms and a 4200 ms sweep. It replays after a 350 ms pointer rest. On our photos every overlay is simply there from the first paint: nothing draws on and nothing tells the reader the order "photo → what was measured → what was derived → names".
2. **Layer changes pop.** A layer toggle, a Stages step or a picker change swaps strokes instantly. A Stages step also remounts the photo (`key={i}`). Only the spill slides (620 ms).
3. **Poster.** The landing crossfades a poster into the image over 700 ms. Our skeleton is replaced at once by an `<image>` that may still be decoding, so the frame flashes the paper colour.
4. **Background and image.** The landing Surround inks its ridges in a fixed paper ink. Ours does the same (`--gb-terrain`, `--gb-contour`), so the margins do not take their cue from the photo's own sky and terrain. Grammar §3 now supplies `--fig-*` per photo.
5. **The spill enters with the page, not with the figure.** It is fully drawn while the photo's lines are still to come (once 2 lands), so the margins would run ahead of the evidence. Grammar §1.7: a spill layer enters with its photo layer, never before it.
6. **The cursor.** On the landing, hover moves a cursor; on ours `spillCursor` is set only by figures that compute one. A plain hero has no hover readout of bearing.
7. **Lettering.** RealPhoto's peak names and DemPatch's labels are raw SVG `<text>`, banned by the hand rules. They should go through `HandLabel`.
8. **Static states.** There is no rule for webdriver or print. The overlays are static anyway, so this matters only once 1 and 2 land.

### 1.3 What a hero must explain beyond the landing
- **Provenance per stroke.** Measured (the eye's skyline, the weights), derived (the DEM horizon at a pose) and named (summits at a pose). The landing has one kind of line; ours has three, and their order of arrival is the argument.
- **Which pose a line belongs to.** The prior is dashed magenta and the solved is cyan. When both show, a story fades one into the other, and a reader who sees only the final frame must still see that the guess was replaced: **ghosts**.
- **The world past the frame registers with the frame.** The spill's horizon must meet the photo's line at the frame's edge (rules: within 0.5 px median). Until now nothing tests this.

## 2. Background ↔ image coordination
- The **figure ground** belongs to Figure (`ground={photoId}`, pod G). RealPhoto adds no wash of its own and never tints the photo.
- **GeoSpill reads the vars with today's fallbacks:**
  - ridges (`.tafel-spill` background): `var(--fig-terrain-ink, var(--gb-terrain))`;
  - sky hachure: `var(--fig-sky-ink, <sky paper ink>)`;
  - ruler and ticks: `var(--fig-horizon-ink, <ink>)`.

  When a Figure sets `ground`, the margins pick up the photo's terrain and sky hue. Without it, nothing changes.
- **When there is no Figure ground,** RealPhoto with `bleed` sets `groundVars(data.id)` on its own host. A bleed photo is always one demo photo, so it can.
- **`--fig-halo`** is used only for the outer halo of `CrispLine` (dark over a bright horizon band, light over a dark one). Peak names keep the paper halo, because their ink is dark. This note goes to G (§10).
- **Dark plates** (`surface="plate-dark"`) get the plate variants from `groundVars` through the same names. The spill's text labels read `--gb-*` tokens, which a `data-theme="dark"` island already flips.

## 3. Overlay stack inside RealPhoto

Each role is one `<g>` in a single svg, in grammar order (v0.2):

| z | Role | RealPhoto content | Ink | Enter / leave |
| --- | --- | --- | --- | --- |
| 1 | raster | `<image>` (poster: the 160 px thumb under it while the 800 px decodes) | none, never filtered | Crossfade over `crossfade` once decoded |
| 1b | raster | `sky` mask (screen, 0.7) | sky photo ink | Fade (it is a generated image, display-only) |
| 2 | derived | `prior`, `solved` (DEM horizon at a pose) | magenta dashed / cyan | Fade over `fade`. A superseded one goes **ghost** (0.35) |
| 3 | measured | `skyline`, `weight` | amber | Pen draw-on over `trace` (1300) with `EASE.draw`. A leave is a fade |
| 5 | notes | `priorPeaks`, `peaks` (dot, leader, name) | ink on a paper halo | Fade, labels `staggerLabel` apart in rank order |
| – | caller | `children(d)` (marks, arrows, notes) | caller's | Caller's (Mark, HandNote and so on, with their own draw-on) |

- **Mounting.** A spilled photo (`bleed`, one per figure) mounts every layer group up front, hidden where it is off, so even a layer's first entrance fades or draws. Other photos mount a group the first time it shows. Either way a group stays mounted, and the `<image>` never remounts across a `layers` change, so pod C can key Stages by frame.
- **Draw-on mechanics.** A measured stroke draws on through WAAPI over `pathLength=1` (`DRAW_ON_KEYFRAMES`, `fill: backwards`). It runs only when the stroke goes from hidden to shown with motion allowed, and drops the dash when it ends. The settled DOM is the plain path, so a static render never carries a dash.
- **Ghosts.** A new prop, `ghosts?: PhotoLayer[]`, lists layers kept at 0.35 when they are not in `layers`. A ghosted `prior` keeps its dash. The red strike is furniture and is the caller's choice: a horizon is too long to strike.
- **The story fade** (`lineOpacity` with an AlignmentStory and both lines on) stays, and multiplies the group's opacity.
- **`lines={false}`** (landed, 60e3a1f) drops the prior, solved, skyline and weight groups; PhotoStory draws its own.

## 4. Animation script

### 4.1 The hero bloom (`reveal`)
A new prop, `reveal?: "bloom" | "none"`. It is `"bloom"` by default when `bleed` is set, `lines` is not false, there is no SpillSideContext (Compare) and there is no AlignmentStory, and `"none"` otherwise. Those owners run their own clocks.

| Beat | Kind | Starts (ms after armed) | What moves | Spill |
| --- | --- | --- | --- | --- |
| photo | setup | 0 (poster to image when decoded) | raster | Ruler and ridges fade in with the raster (`--gb-spill-reveal` via the root's own opacity, see 4.3) |
| derived | setup | `lead` 80 | prior and solved fade (`fade`) | Echo of prior and solved, same delay |
| measured | evidence | 80 + `stagger` | skyline draws on (`trace`) | Echo of skyline and sky, same delay |
| names | result | 80 + `stagger` + `trace` × 0.6 | labels fade, `staggerLabel` apart | Spill summits fade with them |

- **`once` playback.** The bloom plays the first time the figure arms (ARM 0.75). It replays when the figure re-arms after leaving (grammar v0.2 "replay on return"), and after a `hoverReplay` pointer rest on a settled frame (`replayFade` first).
  - There is no hover replay on a figure with `toggles`: the reader is working the chips.
  - Tap-to-replay on phones is deferred to round 2.
- **Static.** Under `useMotionAllowed() === false` (reduced motion, webdriver, print, the server and the first paint), everything is `on` from the first paint. No layer is ever hidden in SSR HTML.
- **Hydration.** The client hides layers only in a layout effect after the first commit, and only when motion is allowed and the figure is not yet armed. On a hard load with the hero already in view, the reader may see the lines for one frame before they draw on. That case goes on the browser-pass list. Fallback if it reads badly: skip the bloom for a figure that is armed at mount.

### 4.2 Layer changes (pod C, toggles, pickers)
- A layer added after the bloom enters with its role's timing at delay 0.
- A layer removed leaves over `fade × 0.6`.
- With a `ghosts` entry, it goes to 0.35 instead of leaving.
- A **picker** change of photo (`data.id` changes) re-runs the bloom from the measured beat on. The raster crossfades from the stale image, which is already dimmed by `isStaleData`.

### 4.3 The spill in sync
- GeoSpill's root reads `opacity: var(--gb-spill-reveal, 1)` (landed). Pod S drives that var from PhotoStory.
- For RealPhoto's own bloom, GeoSpill takes `reveal?: { shown: boolean; echo: Partial<Record<PhotoLayer, LayerState>> }`.
  - The root's opacity becomes `calc(var(--gb-spill-reveal, 1) * <0|1>)`, with a transition over `fade` timed with the raster.
  - Each echo line gets the same state, delay and transition as its photo layer, so a margin line never runs ahead of the frame.
  - Wrapping GeoSpill in an opacity div would lift its `-z-10` layer over the photo, so the opacity stays on the root.
- The pose slide stays at 620 ms (= `settle`).

### 4.4 Hover cursor (deferred to round 2, see §8)
A hero with a spill and no `spillCursor` would show the bearing under the pointer. Pointer column to azimuth uses the spill's own conversion. It writes a CSS var and the caret's transform straight to the DOM, with no React render per move. Not on phones.

## 5. Static, print, reduced motion, webdriver, phone
- Static, print, reduced motion and webdriver all get the settled frame: every layer `on`, ghosts at 0.35, the spill fully shown.
- Print: the spill stays. It is line art on paper, and print.css already whitens washes.
- Phone (< 640 px): the spill is the ruler only (unchanged). The bloom still plays, armed by the viewport share. A tap replays.

## 6. Data stays on its pixels
- Skyline, prior and solved remain one pen pass within 0.5 px (`PHOTO_PEN_TOLERANCE`).
- The draw-on animates `stroke-dashoffset` with `pathLength=1`, so the drawn path is the same path.
- New spec: the spill's echo of the solved horizon meets `solvedRows` at the frame's left and right edges within 0.5 px (median over the edge columns) for each demo photo with a bake.

## 7. Per-page instances

| Page | Figure | Change |
| --- | --- | --- |
| photo, pose-estimate, terrain-snapping, dem-anchoring, step-inside | Static heroes | Bloom by default. The caller's marks keep their own draw-on |
| skyline, dem-horizon, eye-rule, tap-a-peak, baseline-pipeline, photo-workspace | Stages heroes | Pod C keys by frame. RealPhoto animates the layer changes. Bloom on the first arm only |
| rigi, camera-prior, and the PhotoStory on the other pages | PhotoStory | `reveal="none"` (story present). Pod S drives `--gb-spill-reveal` |
| viewport-inference, rigi Fig. 2, peak Fig. 2 | Compare | `reveal="none"` (SpillSideContext) |
| viewport-inference Fig. 1 | Compare and StoryMap grid | **Fix:** add `data-gb-bleed-bounds="right"` on the grid, so the spill stops at the StoryMap (page hunk, P's) |
| baseline-pipeline Fig. 3 (YawSearch) | Runner-up hypothesis | **Fix:** pass `spillT` and a `spillCursor` at the runner-up yaw, so the margins match the drawn rival line (page hunk) |
| photo-workspace Fig. 2 | Peak projection | Deferred: a second cursor for the prior bearing needs `spillCursor` to accept an array (round 2) |
| peak Fig. 1 | `maxLabels=7` on a 440 × 140 crop | Leave it. `layoutPeakLabels` already numbers the dropped names. Flag for the browser pass |
| photo-workspace Fig. 1 stage 4 | `maxLabels=12` | Flag for the browser pass |
| terrain-snapping Fig. 1 | Crop starts at y=300 | Flag for the browser pass (the ridge top may be cut) |
| Figures with `bleed` but no spilled photo (rigi Fig. 4, photo Fig. 4, camera-prior Fig. 3, baseline-pipeline D1, viewport-inference Fig. 3, accept-rule Fig. 4) | Figure | Pod G's or the page's call: a wide Figure with an empty margin. Reported to G |

## 8. Rounds
- **Round 1:**
  - layer state machine and mounting (§3);
  - `ghosts`;
  - `reveal` bloom with arming, replay and static (§4.1, 4.2);
  - GeoSpill `reveal` sync (§4.3);
  - `--fig-*` reads in GeoSpill and CrispLine (§2);
  - PeakLabels lettering to HandLabel;
  - DemPatch (pod M's three asks).

  Pure timing in `viz/real-reveal.ts`, with specs.
- **Round 2:**
  - the registration spec (§6);
  - the page hunks (§7 fixes);
  - the poster crossfade;
  - the hover cursor (§4.4);
  - fixes from the adversarial review.

## 9. Landed
- 60e3a1f: `RealPhoto lines={false}` and GeoSpill `--gb-spill-reveal` (asks from pod S).
- b53dbca: DemPatch `--fig-wash` ground, ink camera dot, `furniture` prop, HandLabel lettering (asks from pod M).
- Round 1 (see the commit `gipfelbuch/hero-photo: overlay stack, hero bloom ...`):
  - `viz/real-reveal.ts` (roles, order, bloom timing, `useHeroBloom`);
  - RealPhoto `ghosts` and `reveal`;
  - layer groups as `OverlayLayer`, with the WAAPI draw-on;
  - PeakLabels through HandLabel, staggered;
  - GeoSpill `echo.states` and `shown`, plus the `--fig-terrain-ink`, `--fig-sky-ink`, `--fig-horizon-ink` and `--fig-halo` reads;
  - `labelledPeaksIn` (an ask from pod M).

  Specs: real-reveal, useHeroBloom, RealPhoto and GeoSpill.

## 10. Notes to other pods
- **G:** `--fig-halo` is used only on line halos. Text halos stay paper because the ink is dark. Six Figures widen with `bleed` and have nothing in the margin (§7).
- **C:** RealPhoto keeps its mount across `layers`. Use `ghosts` for a superseded guess.
- **S:** `lines={false}` and `--gb-spill-reveal` are landed; `reveal` is `"none"` inside a story.
- **M:** DemPatch wash, ink camera, `furniture` and HandLabel are in round 1.

## 11. Browser-pass checklist
1. `/gipfelbuch/photo` and `/gipfelbuch/pose-estimate`, hero, scrolled to from above:
   - photo, then prior and solved fading, then the skyline drawing left to right, then the names;
   - the margins follow the same beats;
   - hover rest on the settled frame replays it.
2. The same pages loaded with the hero in view: check for a one-frame line flash before the draw-on (§4.1 hydration).
3. `?theme=light` and `?theme=dark`: the spill ridges take the photo's terrain hue when Figure has `ground`. Without it, the contour brown is unchanged.
4. Stages heroes (skyline, baseline-pipeline) after pod C's keying: no photo flash, layers draw or fade, prior goes ghost.
5. A picker change (skyline Fig. 2): the stale photo is dimmed, then the new photo's lines redraw.
6. Reduced motion, webdriver (`eval` harness), print preview: settled frame, nothing hidden.
7. Phone at 375 px: ruler only, the bloom plays, a tap replays it.
8. viewport-inference Fig. 1: the right spill stops before the StoryMap.
9. DemPatch in a StoryMap aside: the wash matches the figure ground, the camera dot is ink, the HandLabel names are legible.
10. peak Fig. 1, photo-workspace Fig. 1 stage 4 and terrain-snapping Fig. 1: label clutter and crop.
