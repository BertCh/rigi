# Pod C: Sequences (Compare, Stages, Steps, Beat, Details), 2026-10-02

Status: **spec v1.3. Round 1 landed (f21dfa9) and round 2 landed (097d0b9, 5bb2c38); see §11.** It is written against `grammar.md` v0.1 (pod G); the token names (`MOTION.*`, `EASE.*`, `useBeats`, `useArmedInView`, `useMotionAllowed`, `OverlayLayer`, `spillTAt`) are the grammar's. Where this spec needs something the grammar does not give, it says so and the request is in `inbox/G.md`.

Pod C owns `Compare`, `Stages`, `Beat` and `Details` in `viz/explain.tsx`, and `viz/Steps.tsx` (`Steps`, `Flow`). The photo inside a frame is pod P's `RealPhoto`; pod C owns the **sequence around it**: what changes between frames, when, and how the spill and the side map follow.

## 1. Audit

### 1.1 Instances (pages in `src/lib/gipfelbuch/pages/`)

| Component | Count | Pages |
| --- | --- | --- |
| `Compare` | 5 | dem-source (Terrarium / Mapterhorn rasters), peak (guess / solved), rigi (guess / solved), step-inside (photo / after the split), viewport-inference (two RealPhotos) |
| `Stages` | 9 | baseline-pipeline (`aside` StoryMap, poses), camera-roll (Unsorted…), dem-anchoring, dem-horizon, eye-rule, photo-workspace (`aside` StoryMap, poses), skyline, step-inside, tap-a-peak |
| `Steps` | 13 | accept-rule, baseline-pipeline, camera-prior, camera-roll, dem-anchoring, dem-horizon, dem-source, peak, photo-workspace, photo, pose-estimate, step-inside, tap-a-peak, terrain-sampler, viewport-inference (route topo) |
| `Beat` | 3–5 per page | all 19 pages |
| `Details` | 1 per page | all 19 pages, plus OntologyPanel and SheetColophon |

The landing `Compare` in `src/routes/index.tsx` is `site/Compare` (not ours, never edited).

### 1.2 Against the landing: what is missing

**Compare** (counterpart: `site/Compare.tsx`)
1. **A React render on every pointer move.** `setLocalX` re-renders both RealPhotos and the GeoSpill on every move. The landing writes `clip-path` and `left` straight to the DOM through refs. The grammar (§1.6) makes the landing pattern the rule.
2. **The intro sweep is decorative.** It is a damped sine (out right, back left, settle) over 2600 ms, with no causal order and no token easing. Inside an alignment story it also drives `story.setT`, so the side StoryMap wobbles for 2.6 s.
3. **It runs under webdriver.** The guard is `reduce` (the media query) only, so screenshots are taken mid-sweep at an unpredictable `x`. Print is not handled either.
4. **The spill always slides between poses.** The bottom side always gets `SpillSideContext {t: 1 - x}`. That is right for guess / solved (peak, rigi, viewport-inference). *Checked in round 1: dem-source and step-inside compare plain `<img>`s, not RealPhotos, so they have no spill and nothing slides today.* The `spill="static"` prop exists for a future Compare whose sides are RealPhotos but not poses.
5. **Accessibility:** there is no `aria-valuetext` (the label for the current side), no Home/End keys, and the labels do not change emphasis as the wipe crosses.
6. **No dark-plate option.** The landing is a `data-theme="dark"` island; ours sits on paper. That is correct for the notebook, but the wipe line's paper halo (`--gb-paper`) is the only thing separating it from a light sky.

**Stages** (counterparts: the how-it-works scene's beats, and RevealLoop's arming)
1. **Each step remounts the frame.** `key={i}` throws away RealPhoto and its overlays every step, and the 420 ms fade starts at opacity 0.25, a visible flash. The overlays cannot draw on or settle between stages; they just appear. GeoSpill hides the remount for the margins (its slide), but the photo's own lines jump.
2. **It runs under webdriver** (gated by `reduce` only), so harness frames are unpredictable.
3. **Arming:** it plays from the first pixel in view (`useInView` with an 8 % margin). The landing arms at 75 % in view. Loop timing is 3200 ms with the last stage held ×1.6, close to the grammar (`beat` 2800, `resultHold` 1.6).
4. **No cue for autoplay.** Nothing shows that the frame will advance or when. The reader sees a change without knowing why.
5. **Print shows only the current stage**, and every other caption is lost.
6. **The `@keyframes gipfelbuch-fade` `<style>` is injected per instance.**
7. **The pose sync with the story is good** (a stage `pose` drives `story.setT`, and a reader turning the side map selects the nearest stage). Keep it.

**Steps / Flow** (counterpart: FadeIn stagger, the how scene)
1. The route segment draws on at `i·140 + 150` ms, but the station number and text are static. The pen reaches a station that was already there.
2. Dashed (approximate) and dotted (open) segments cannot draw on, so they just appear at once, before the solid ones.
3. Flow fades its stations at a 110 ms stagger and Steps does not; they should match (`MOTION.stagger`).

**Beat**: no entrance. That is acceptable, because the figure enters through `Figure` (grammar §1.4: no second fade). The one gap: the `HandHeading` underline does not draw on.

**Details**
1. **Print loses it.** A closed `<details>` prints closed, so the engineering mechanism is missing from the print sheet (`/gipfelbuch/print`).
2. Opening it has no settle; the content pops in. That is minor and stays that way, because the reader asked for it.

### 1.3 What a sequence must explain beyond the landing
The landing's Compare says only "before / after". Ours carry an **operation**: the guess, what was measured, the correction, the result. So:
- **What changed** must stay visible on the final frame. Show the superseded guess as a ghost (grammar §2), not as the other half of a wipe.
- **Why the frame moved.** Each stage names its beat kind (setup, evidence, change, result). The tab shows which kind it is, and the caption is its one claim.
- **Where in the world.** The spill and the side map move with the operation (`spillTAt(kind)`), never on their own.
- **How sure.** The route-topo dash already encodes certainty in Steps. Stages and Compare should carry it too: a `derived` layer is dashed, a `measured` one solid (the overlay stack's inks).

## 2. Background ↔ image coordination
- **The ground comes from the frame's photo.** A Stages or Compare that holds one demo photo passes `ground={photoId}` to its enclosing `Figure` (pod G's prop). Pod C does not add its own wash. A Stages whose frames hold different photos (camera-roll) leaves `ground` unset, so the paper default applies.
- **The wipe line** reads `--fig-halo` for its halo and `--gb-red` for its pen, instead of the literal `--gb-paper` halo. The halo then reads against the photo's own horizon tone, light or dark (grammar §3 `--fig-halo` picked from `horizonL`).
- **The stage frame never tints the photo.** The crossfade between stages is opacity on overlay layers only (§3 below). When the photo itself changes (camera-roll), the swap is a `crossfade` (700 ms) over the old image, never a filter.
- **The spill is in the same pose as the frame:**
  - Stages: `spillT = spillTAt(stage.kind)` for a stage without a `pose`, else `pose`.
  - Compare in pose mode: `t = 1 − x`, immediate (it is a scrub).
  - Compare in static mode (two rasters, or a layer split): the spill is pinned at the pose both sides share (`spill="static"`, §4.1).
- **The aside map** (StoryMap, pod M) is the same clock: the story `t`. Pod C only drives `t`; it does not style the map.

## 3. The overlay stack in a sequence
Pod C draws only the `interaction` layer (z 6: the wipe line, the handle, the stepper, the progress pencil) and the stage `notes` (the caption). Every other layer is the photo's, through `OverlayLayer`, and a sequence controls only its **state**:

| Layer (grammar §2) | In Stages | In Compare |
| --- | --- | --- |
| `raster` (1) | Shared across stages with the same `frame` key; it is never remounted | The same photo on both sides, pixel-aligned (unchanged) |
| `measured` (2) | Draws on (`draw`, `EASE.draw`) in the `evidence` stage where it first appears, then stays `on` | The same on both sides, so it is not part of the wipe |
| `derived` (3) | Enters in `setup` (the guess) or `change`. Superseded → `ghost` (0.35, struck) at the next `change`, and it stays | Before: the guess; after: the solve. Each half shows its own, and nothing ghosts inside a scrub |
| `furniture` (4) | Draws on after its endpoints exist, `stagger` 110 | Wipe line (red pen, 2.2, one pass) with a `--fig-halo` halo, 5 px |
| `notes` (5) | The caption (`aria-live`) fades over `fade`; in-frame notes enter `staggerLabel` apart | Side labels: caps with a paper halo. The side the handle is closer to is at full ink, the other at `--gb-secondary` |
| `interaction` (6) | Tabs with a HandLoop on the active one; a pencil progress underline under the active tab (§4.2) | The handle: blot, ring and two arrows (unchanged), with focus `quick` |

Provenance: the wipe and the progress pencil are furniture. A stage caption's number must come from the page data, never be typed in by hand. Pod D's Mark lint applies to it.

## 4. Animation script

### 4.1 Compare
- **Playback** is `once`. It arms on `useArmedInView` (75 %) and runs only where `useMotionAllowed()`.

| Beat | Kind | What happens | Duration and easing |
| --- | --- | --- | --- |
| 0 | setup | `x = 1`: all "before" (the guess) | `lead` 80, then a dwell of `beat × 0.5` |
| 1 | change | A programmed scrub from `x = 1` to `x = start` | `beat` (2800) on `EASE.inOut` |
| 2 | result | Rest at `start`. Both labels are visible; the closer side is at full ink | It holds and does not loop |

- **Replay:** a `hoverReplay` (350 ms) pointer rest on a finished, untouched frame, or a tap on phone. It replays the script after a `replayFade`. The first drag or key press ends it (manual), and it never resumes.
- **Drag:** writes `clip-path`, the handle's `left`, `aria-valuenow` and `aria-valuetext` straight to the DOM through refs, as the landing does. React state changes only on pointer-up (or every 100 ms of a drag at most) so that the story `t` and the side map follow without a 60 Hz React render. *Open: pod S's subscribable `t` proposal would make even that unnecessary; adopt it when it lands.*
- **Spill:**
  - `spill="pose"` (the default, guess / solved): the bottom side gets `{t: 1 − x}`, applied immediately, with no slide.
  - `spill="static"` (dem-source, step-inside): both sides get the same fixed `t` (1, the solved pose), and the wipe moves nothing in the margins.
- **Keys:** Left and Right move ±0.05, and Home and End go to 0 and 1.
- **Static frame:** `x = start`, the result frame. It is the same for SSR, webdriver, reduced motion and print.

### 4.2 Stages
- **Stage API additions**, which are backwards compatible:
  ```ts
  interface Stage {
    label: string; caption: ReactNode; render: () => ReactNode; pose?: number;
    kind?: BeatKind;    // default: first = setup, last = result, others = evidence
    frame?: string;     // stages sharing a key keep one mounted frame (no remount)
  }
  ```
- **Clock:** `useBeats(buildTimeline(stages.map(s => ({ id: s.label, kind: s.kind }))), { playback: "loop" })`.
  - The dwell is `beat` (2800), and the result dwells ×1.6.
  - It loops through a `replayFade` back to setup (grammar §1.6, loop is the default for steppers).
  - It plays only while armed and resumes at the same stage when re-armed.
  - The first render is the last stage (grammar §1.6); the client steps back to the first stage only where motion is allowed.
- **Swap:**
  - Stages with the same `frame` key render under one keyed wrapper (the key is `frame ?? i`). React keeps the RealPhoto mounted, the `layers` prop changes, and RealPhoto's layers enter and leave through `OverlayLayer` (draw-on for measured, fade or settle for derived, ghost for superseded).
  - With a different key, the swap is a `crossfade` (700 ms, opacity 0 → 1 on the incoming frame, the outgoing frame kept underneath until the end). It replaces the 0.25 → 1 flash.
- **Progress pencil:** under the active tab, a pencil underline draws over the stage's dwell (a CSS animation of `stroke-dashoffset` with `animation-duration` = dwell and `animation-play-state` tied to playing). It tells the reader that, and when, the frame will advance. It is not shown when manual or static.
- **Hover and focus:** a pointer resting on the frame, or focus inside it, pauses the clock (but does not make it manual). Leaving resumes it.
- **Tabs and kind:** the tab number is the beat index. A `change` tab's number is in `--gb-red`, a `result` tab gets the ink circle (the route-topo summit), and the others are in `--gb-contour`.
- **Spill and story:** a stage's `pose`, or `spillTAt(kind)` when it has no pose, drives `story.setT` or the frame's `spillT`. GeoSpill slides over `settle` (620). The reverse sync from the side map is kept as it is.
- **The caption** (`aria-live`) fades over `fade`. Its height is reserved (`min-h`) so the frame does not jump.

### 4.3 Steps and Flow
Each station `i` enters at `stagger(i, MOTION.stagger)`.
- The circled number and the title fade over `fade` with a 6 px rise.
- Then the route segment below the station draws on over `draw` (`EASE.draw`), starting at `stagger(i) + fade × 0.5`, so the pen leaves a station that already exists and reaches the next one as that station appears.
- Dashed and dotted segments fade over `fade` at the same delay (a dash cannot be drawn on).
- The final station (the summit register) closes its ink circle last.
- Flow uses the same timing (its 110 ms already matches `MOTION.stagger`). Its arrows start at `stagger(i) + fade × 0.5` instead of `+350`.

### 4.4 Beat
- No content fade (the Figure owns the entrance).
- The `HandHeading` underline draws on once when armed (`draw`, `EASE.draw`, `lead` delay). It is static where motion is not allowed.

### 4.5 Details
- On `beforeprint`, every `<details>` in the sheet opens, and the ones that were closed close again on `afterprint`.
- Use the print stylesheet instead if it can do this (`details:not([open]) > :not(summary)` cannot be shown by CSS alone in every browser, so a hook it is: `useOpenForPrint(ref)`).
- The triangle rotates over `quick` with `EASE.standard`.

## 5. Static, print, reduced motion, webdriver and phone

| State | Compare | Stages | Steps / Flow | Details |
| --- | --- | --- | --- | --- |
| SSR / first paint | `x = start` | Last stage | All stations drawn | Closed |
| Reduced motion, webdriver | `x = start`, no sweep, no replay | Last stage, no clock, no progress pencil; tabs still work (a jump is instant) | Static, all drawn | Closed |
| Print | `x = start`, handle hidden (`print:hidden`), both labels | Last stage's frame, then an ordered list of every stage's number, label and caption (`hidden print:block`); stepper and play button hidden | All drawn | Forced open |
| Phone (< 640 px) | Handle 44 px hit area; `touch-pan-y`; a tap replays; spill is the ruler only (GeoSpill) | Tabs in 2 columns (as today), and the `aside` map below the frame; a tap on the frame toggles pause | Unchanged (it is vertical already) | Unchanged |
| Dark theme | The wipe halo reads `--fig-halo`, so it works on both themes | Unchanged; the inks are tokens | Unchanged | Unchanged |

`useMotionAllowed()` is the single gate for every motion in this table. That fixes the webdriver bugs in Compare and Stages.

## 6. Per-page instances

| Page | Component | What it does on this page |
| --- | --- | --- |
| peak, rigi, viewport-inference | Compare | `spill="pose"`; the setup beat shows the guess, and the scrub runs to `start` |
| dem-source | Compare | `spill="static"`; both sides are rasters, and the labels name the DEM sources |
| step-inside | Compare | `spill="static"`; before = photo, after = the split layers |
| baseline-pipeline, photo-workspace | Stages + `aside` StoryMap | Poses already set; add `kind` (setup → evidence → change → result) and `frame: "photo"` on the stages that show the same RealPhoto |
| dem-horizon, skyline, dem-anchoring, step-inside | Stages | Stage 1 is a bare photo. All the stages share `frame: "photo"`, so the measured line draws on in place instead of remounting |
| eye-rule, tap-a-peak | Stages | `kind`: sensors and taps are evidence, the floor rule or 3 taps is the change, and snapped is the result |
| camera-roll | Stages | Different images per stage: no shared frame; the swaps crossfade; no `ground` |
| 13 Steps pages | Steps | No page edits; the timing change is inside the component |
| all 19 | Beat, Details | No page edits |

Page edits are small hunks that only add `kind`, `frame` and `spill` props, landed through land.py.

## 7. Implementation units (round 1, then an adversarial review, then round 2)
1. **C1 Compare** (explain.tsx): ref-driven drag; `useBeats` once-script; `spill` prop; `useMotionAllowed`; keys and aria; print and handle states. Specs: the script timeline (pure), the x↔t mapping, the static frame, and that the spill t is static in static mode.
2. **C2 Stages** (explain.tsx): `useBeats` clock with `kind` and `frame`; crossfade; progress pencil; hover pause; the print list; move the keyframes out of the inline `<style>` (into theme.css, which is pod G's: a proposal in `inbox/G.md`; until then keep one module-level style). Specs: default kinds, frame-key grouping, dwell and hold, and the last stage when motion is not allowed.
3. **C3 Steps/Flow**: the station and segment timing from `stagger`. Specs: the delay table.
4. **C4 Beat/Details**: the underline draw-on and `useOpenForPrint`. Specs: the hook opens and restores.
5. **C5 Page props**: `kind` / `frame` / `spill` on the 14 Compare and Stages call sites.

Every unit is browser-unverified and gets one `reports/batch-ledger.md` row.

## 8. Depends on
- **Pod G:**
  - `useBeats`, `useArmedInView`, `useMotionAllowed`, `buildTimeline`, `spillTAt` and `stagger` (motion.ts)
  - `OverlayLayer` (overlay.tsx)
  - `Figure ground`
  - a home in theme.css for `gb-stage-in` and the progress-pencil keyframes
- **Pod P:** RealPhoto must keep its mount across a `layers` change, entering and leaving layers through `OverlayLayer`. Without it, a shared `frame` only saves the photo decode, and the lines still pop.
- **Pod S:** the subscribable `t` (optional; it would remove the throttled React update during a Compare drag).

## 9. Browser-pass checklist
- [ ] peak, rigi, viewport-inference Compare: setup shows the guess, the scrub runs once on `EASE.inOut`, it rests at `start`, and the margins slide with the wipe; a drag shows no React re-render jank; Home and End work.
- [ ] dem-source and step-inside Compare: the margins do not move during the wipe.
- [ ] Stages on baseline-pipeline and photo-workspace: the photo does not flash between stages; the derived horizon settles and the guess ghosts; the StoryMap and the spill move with the stage; a side-map turn selects the nearest stage.
- [ ] Stages on dem-horizon and skyline: the measured skyline draws on in place in its evidence stage.
- [ ] camera-roll Stages: the image swap is a 700 ms crossfade with no 0.25 flash.
- [ ] The progress pencil matches the dwell, stops on pause or hover, and is absent when manual.
- [ ] `?theme=light` and `?theme=dark`: the wipe halo is legible against a bright sky and a dark ridge.
- [ ] Phone width: the tabs are in 2 columns, the aside map is below the frame, a tap replays a Compare, and the page still scrolls vertically over a Compare.
- [ ] Webdriver harness: Compare at `start`, Stages on the last stage, and Steps fully drawn, all deterministic.
- [ ] `/gipfelbuch/print`: Details open, the Stages caption list printed, no stepper chrome.

## 10. Open decisions for the user
1. **Stages loop or settle?** Grammar v0.2 (pod G's ruling) makes `once` the default: play through, rest on the result, replay when the reader comes back. Stages follows it as of round 2. Before that, the coordinator's default was `loop`. This stays open for the user.
2. **The Compare intro script** (guess first, then a one-time wipe to the split) replaces today's wobble sweep. The landing has no sweep at all. Should Gipfelbuch also drop it?

## 11. Progress

### Round 1: bug fixes that do not need motion.ts
- **New `viz/sequence.ts`:**
  - pure timing (`compareIntroX`, `compareKeyX`, `compareSide`, `stepsStationDelay`, `stepsSegmentDelay`, `stagesInitialIndex`, `stageFrameKey`), with grammar token values held as local constants;
  - `useSequenceMotion`, a stand-in for `useMotionAllowed`: it is off on the server, under reduced motion, under webdriver and in print, and comes back after print;
  - `useOpenForPrint`.
- **Compare:**
  - The drag writes the clip, handle, aria and labels straight to the DOM, and commits to React at most every 33 ms and on release or a key press.
  - The intro plays once: the guess held (x = 1), then one in-out scrub to `start`, then rest.
  - A story moved from outside (the side map) ends the intro.
  - Home and End keys; `aria-valuetext`; the larger side's label is at full ink.
  - New `spill` prop; the handle is hidden in print; print commits the result synchronously.
- **Stages:**
  - The first render is the last stage. The client steps back to the first stage in a layout effect, where motion is allowed.
  - No clock under webdriver.
  - A mouse resting on the frame holds the clock.
  - New `frame` key (`frame:<key>` / `stage:<i>`).
  - Print: the result frame plus a numbered list of every caption, and the controls hidden.
  - The play button is invisible where nothing plays.
- **Details** opens for print and closes again after.
- **Steps:** each station fades in as the pen reaches it (period 690 ms), and dashed and dotted segments fade in at their slot.
- **Adversarial review** (Sonnet), and what was fixed:
  - Stages' reverse story sync fired on mount when the story starts at t = 0 (baseline-pipeline, photo-workspace), which killed autoplay and the static result frame. It now ignores the echo of its own pose write and the story's initial t.
  - The pose effect re-fired on every story move, because `setT` changes identity with every t. It now runs only when the stage's pose changes, reading `setT` through a ref.
  - The other fixes: a story moved from outside ends the Compare intro; layout effects stop the result frame flashing before the first beat on client mounts; `flushSync` on print; the commit timer is reset on cleanup; the stage index is clamped; the hover hold is released on a stage change; frame keys no longer collide; the Steps number wrapper is `flex`.
  - Specs now cover a Stages inside a story at t = 0, under webdriver and with motion allowed.
- **Proposal to pod S** (story.tsx): give `setT` a stable identity in `AlignmentStoryProvider`.

### Round 1 landed
- f21dfa9 is the code, and 35ced0e is the ledger row. The row cites e3217a4, the pre-rebase sha of f21dfa9; round 2's ledger hunk corrects it.

### Round 2: adopting motion.ts (d9b7320)
- **sequence.ts:** constants from `MOTION` / `ease`; `useSequenceMotion` dropped for `useMotionAllowed`; `defaultStageKind`.
- **Stages:**
  - `useBeats` drives it, with `once` playback (grammar v0.2), arming at `ARM_SEQUENCE`, `hold` on hover, and replay on return.
  - `Stage.kind` (default setup, evidence …, result); dwell = `dwellOf(kind, interval)`; `interval` defaults to `MOTION.beat`; the tab number ink follows the kind.
  - The pencil progress stroke (`.gb-progress`, `--gb-progress-ms` = the dwell) is drawn only while playing, armed and not held.
  - The crossfade keeps the outgoing frame mounted, in the same keyed list, absolute, with `SPILL_OFF` and fading out, while the new frame fades in with `.gb-stage-in`. It is skipped on the first rewind and in print.
- **Compare:** `useMotionAllowed`, `useArmedInView({ arm: ARM })`; the intro plays once and never replays (a hover is drag intent; the landing has no replay either). The wipe halo reads `--fig-halo`.
- **Pages (C5):**
  - `frame: "photo"` on the Stages of baseline-pipeline, photo-workspace, dem-anchoring, dem-horizon, skyline and step-inside (all one RealPhoto) and tap-a-peak (TapFrame). React keeps one frame mounted there, and pod P's layer transitions animate the change.
  - `kind: "change"` on "Slide to match" (baseline-pipeline) and "The rule" (eye-rule).
  - camera-roll (mixed components) and eye-rule (opaque `frame(n)`) crossfade.
- **Adversarial review 2, and what was fixed:**
  - The outgoing frame remounted cold under a new key (a blank flash): it is now one keyed list.
  - The mount rewind crossfaded result → stage 1: now skipped through a `primed` flag.
  - The pencil ran while the figure was disarmed: it now needs `armed`.
  - Print could capture a crossfade: a `printing` flag stops it.
  - The layout jumped with frames of different heights: the outgoing frame is absolute.
  - The pencil showed with no CSS: it now has a hidden dash default.
- **Deferred:**
  - Compare `setT(…, { instant: true })`, until pod S lands it (inbox from S and M).
  - Beat heading underline draw-on (Section.tsx is not pod C's).
  - Compare replay (deliberately not done).
  - First-paint flash of the last beat on client mounts, which comes from `useMotionAllowed`'s passive effect (asked of pod G).

### Round 2 landed
- **097d0b9:** Stages on useBeats, Compare on motion.ts, and the page props.
- **5bb2c38:** the root ref feeds grammar v0.3's ElementRefs through one stable callback.
- **Page hunks:**
  - `frame: "photo"` landed on photo-workspace, dem-horizon and skyline.
  - It was left out (9e633c0, 2693bf8) on baseline-pipeline, dem-anchoring, step-inside, tap-a-peak and eye-rule, because peers have uncommitted edits on those lines.
  - Re-apply them once those pages are committed. Add `frame: "photo"` after each stage `label` in the Stages array of baseline-pipeline, dem-anchoring, step-inside and tap-a-peak. Add `kind: "change"` on "Slide to match" (baseline-pipeline) and "The rule" (eye-rule).
- **Ledger:** rows 35ced0e and b29ea6f carry the landed shas.
- **Not adopted:** pod P's offer of `reveal="none"` on Stages photos. The first arm plays P's bloom on stage 1, which has no layers to draw. That is harmless, and worth a look in the browser pass.

