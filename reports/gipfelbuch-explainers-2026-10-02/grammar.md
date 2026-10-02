# Gipfelbuch explainer grammar (pod G), 2026-10-02

Status: **v0.2.** It amends v0.1 after the pods' first specs; §6 lists what changed. The primitives are implemented in `motion.ts`, `ground.ts`, `overlay.tsx` and `Figure.tsx`. They are landing now; the sha will be added here.
- Amendments go in the changelog at the bottom.
- A section marked *(API pending)* names functions that have not landed yet. Code against the names and signatures given here. They will not change unless a note arrives in your inbox first.
- Disagreements go to `inbox/G.md`. Do not fork the grammar.

Everything here lives in `src/components/gipfelbuch/viz/` and is re-exported from `viz/index.ts`:

| Module | What it holds |
| --- | --- |
| `motion.ts` | Motion tokens, easings, pure beat timelines, and the hooks `useMotionAllowed`, `useArmedInView`, `useBeats` (one render per beat) and `useBeatClock` (continuous, fps-capped) |
| `ground.ts` | Per-photo palette to Figure CSS vars, plus contrast math (pure) |
| `ground-palette.json` | The bake: sky, terrain and horizon tones per demo photo (about 1.5 KB), written by `scripts/gipfelbuch/bake-ground.ts` |
| `overlay.tsx` | The overlay stack: layer roles, z-order, ink, weight and opacity, and `<OverlayLayer>` for enter and leave |
| `Figure.tsx` | New props `ground` and `surface`, which set the CSS vars in §3 |

## 0. Landing nuances we inherit

The numbers come from `src/components/site/**`. Each row gives what the landing does, then the grammar it maps to.

**Entrance (`FadeIn`)**
- Landing: once, 1000 ms, `cubic-bezier(0,0,.2,1)`, 24 px rise, IO margin `0 0 -12% 0`. Transition classes are stripped after the end.
- Grammar: `MOTION.enter` and `EASE.enter`. Figure owns it (§1.4).

**Reveal bloom (`RevealLoop`)**
- Landing:
  - It arms when 75 % of the frame (or of the viewport) is shown, waiting for `img.decode()`, and resets below 20 %.
  - The play is a lead of 80 ms, then a sweep of 4200 ms on `1-(1-t)^3`.
  - A replay fades the lit frame for 450 ms (linear), then sweeps. It replays after a 350 ms pointer rest on a finished frame.
  - rAF writes only CSS vars, quantised.
  - Reduced motion shows it lit.
- Grammar: `ARM`, `RESET`, `MOTION.lead/sweep/replayFade/hoverReplay`, `EASE.out`. JS writes vars, not React state.

**Compare**
- Landing: no auto sweep. It starts at 0.42. A drag writes clip-path and the handle's `left` straight to the DOM. Arrow keys move ±0.05. `touch-pan-y`.
- Grammar: §1.6 scrub semantics.

**Near-viewport mount**
- Landing: `useNearViewport(600)` is one-shot and never unmounts. The placeholder is a sized box or a poster. The site uses margins of 800 (pano, topo), 400 (live, step) and 600 (how).
- Grammar: `MOTION.nearMargin` = 600 px.

**Poster and engine crossfade**
- Landing: 700 ms everywhere (LiveRollMap, StepInside, LiveLines).
- Grammar: `MOTION.crossfade` = 700.

**Surround (side topography)**
- Landing:
  - The bake projects the ridges through the photo's solved camera, so each line leaves the photo where its ridge does.
  - The layer sits at `-z-10`, behind the photo, and is empty over the photo.
  - A CSS mask fades the outer 60 % of each side. The top edge stays crisp for the ruler.
  - Labels show at md and up only.
  - `--surround-left` hides a side.
- Grammar: GeoSpill already does this. The spill pose follows the beat (§1.7). The spill ink reads `--fig-terrain-ink` (§3).

**LiveLines**
- Landing: the ink is the canvas's computed `color`, `var(--rigi-paper)`. It is re-read on a theme change, never per tick. Strokes fade over 6 depth buckets. It runs at 30 fps and DPR ≤ 1.5, and only redraws when the view changes.
- Grammar: line art takes its ink from a CSS var, never a literal (§3).

**How-it-works scene**
- Landing:
  - Six beats over 28 s: guess, skyline, terrain, measure, correct, snap.
  - Each sub-ramp uses smoothstep.
  - It is committed about every 28 ms and runs only while in view.
  - Under reduced motion or webdriver it starts at END, the settled frame.
- Grammar: this is the model for §1.3 beats. The beat kinds are setup, evidence, change and result.

**Label declutter**
- Landing:
  - Labels are placed in rank order, highest first.
  - A label is dropped when it overlaps one already placed (4 px horizontal and 2 px vertical tolerance, with 3 stem levels), and at most 8 are placed.
  - Names are capitals with an `ele` subline.
- Grammar: `layoutPeakLabels` (real.tsx). The notes layer keeps out of measured lines (§2).

**Dark plates**
- Landing: Compare, RevealLoop, LiveRollMap and the how viewport are `data-theme="dark"` islands on either site theme.
- Grammar: `surface="plate-dark"` (§3).

**Webdriver, reduced motion and print**
- Landing: handled ad hoc, and incompletely. RevealLoop has no webdriver branch, and the site has no print rules.
- Grammar: one rule (§4) through `useMotionAllowed`.

**View transitions**
- Landing: 220 ms, `cubic-bezier(0.2, 0, 0, 1)`.
- Grammar: `EASE.standard`.

## 1. Motion tokens (`viz/motion.ts`)

### 1.1 Durations (ms): `MOTION`

| Token | Value | Use | Existing value it unifies |
| --- | --- | --- | --- |
| `quick` | 160 | Hover, toggle, focus | notebook.css hover |
| `fade` | 420 | A layer enters or leaves (opacity) | explain.tsx `gipfelbuch-fade` |
| `replayFade` | 450 | A lit frame fades before a replay | RevealLoop `FADE_OUT` |
| `settle` | 620 | A pose or position change settles (the spill slides, a mark moves to its solved place) | GeoSpill `SLIDE_MS` |
| `crossfade` | 700 | Poster to image or engine; a stage swap | landing poster crossfades |
| `draw` | 900 | Pen draw-on of one stroke | notebook.css `nb-draw` |
| `enter` | 1000 | Figure entrance (fade plus a 20 px rise) | Figure, Reveal, FadeIn |
| `beat` | 2800 | Dwell of one beat in an auto-advancing sequence | PhotoStory `interval` (Stages moves from 3200 to 2800) |
| `sweep` | 4200 | A bloom or reveal across a whole frame | RevealLoop `SWEEP` |
| `lead` | 80 | Pause before a sweep or the first beat | RevealLoop `LEAD` |
| `hoverReplay` | 350 | Pointer rest on a finished frame before it replays | RevealLoop `HOVER` |
| `stagger` | 110 | Between sibling strokes, stations or layers | Steps |
| `staggerLabel` | 60 | Between the labels of one layer | figures.tsx |
| `resultHold` | 1.6 (a factor) | The result beat dwells 1.6 × `beat` | Stages |
| `nearMargin` | 600 (px) | Distance at which heavy content mounts | useNearViewport |
| `fps` | 30 | Cap for any rAF loop: a canvas, `useBeatClock`, `useTime` | LiveLines, LiveRollMap |
| `turn` | 1600 | A camera turn drawn continuously, with `EASE.inOut` | landing how scene (pod S) |
| `trace` | 1300 | The eye's trace sweeping the frame, with `EASE.linear` (an even scan) | pod S |
| `mark` | 280 | A short pen mark: a strike, a tick, a check (stagger with `stagger`) | pod S |

### 1.2 Easings: `EASE` (CSS strings) and `ease` (JS functions of t ∈ [0, 1])

| Name | CSS | Use |
| --- | --- | --- |
| `out` | `cubic-bezier(0.33, 1, 0.68, 1)`, which equals `1-(1-t)^3` | Blooms, settles, a mark arriving: a lunge, then a rest |
| `enter` | `cubic-bezier(0, 0, 0.2, 1)` | Figure entrance (Tailwind `ease-out`, as FadeIn uses) |
| `draw` | `cubic-bezier(0.55, 0.1, 0.3, 1)` | Pen draw-on |
| `inOut` | `cubic-bezier(0.65, 0, 0.35, 1)` | A programmed scrub or wipe between two states (never a drag) |
| `standard` | `cubic-bezier(0.2, 0, 0, 1)` | UI chrome, view transitions |
| `linear` | `linear` | Only for a ping-pong demo scrub, a replay fade or a reader's drag |

There are no springs and no overshoot: a measured mark must never pass its pixel. The how scene's spring-back is a landing exception and is not copied.

### 1.3 Beats: the causal script

Every animated explainer is a sequence of beats. There are four kinds, and they come in this order. A kind may repeat, and any kind except `result` may be skipped.

| Kind | Means | What moves | Spill (`spillT`) |
| --- | --- | --- | --- |
| `setup` | The givens: the photo, the guess, the question | Furniture and derived layers (at the guess) fade in | 0 |
| `evidence` | What was measured | Measured layers draw on (`draw`, stagger 110) | 0 |
| `change` | The operation: the turn, the snap, the fit | Marks and lines move to their new place over `settle`. Superseded marks become **ghosts** (struck, opacity 0.35) | Slides from 0 to 1 over `settle` |
| `result` | The outcome, with its number | Result notes fade in. The beat holds for `beat × 1.6` | 1 |

Rules:
- A beat changes **one** idea.
- Within a beat, layers enter in stack order (§2), with `stagger` between them.
- The final (result) frame keeps the ghosts, so the static frame still shows what changed.

API:
```ts
type BeatKind = "setup" | "evidence" | "change" | "result";
interface BeatSpec { id: string; kind: BeatKind; dwell?: number /* ms; default MOTION.beat, result ×1.6 */ }
buildTimeline(beats: BeatSpec[]): Timeline   // pure: { beats: {id, kind, start, end}[], total }
sampleTimeline(tl, ms, { loop?: boolean }): { index: number; kind: BeatKind; progress: number /*0..1 within the beat*/; done: boolean }
spillTAt(kind: BeatKind): 0 | 1               // setup and evidence 0; change and result 1
stagger(i: number, step = MOTION.stagger, base = 0): number   // delay in ms for the i-th sibling
```

### 1.4 Entrance and settle
- The figure entrance belongs to Figure: once, `enter`, `EASE.enter`. Do not add a second fade to the content.
- Beats start only once the figure is armed (§1.5). The first beat starts after `MOTION.lead`.
- Any value that ends on a measured position settles over `settle` ms with `EASE.out`.

### 1.5 In-view gating
`useArmedInView({ arm, reset = 0.2, nearMargin = 600 })` returns `{ ref, armed, near }`.
- **`armed`** turns on when `arm` of the frame, or of the viewport if the frame is taller, is on screen. A beat sequence arms at **0.45** (`ARM_SEQUENCE`, as the landing's how-it-works scene does). A single bloom or sweep arms at **0.75** (`ARM`, as RevealLoop does).
- **`reset`**: below 20 % it turns off.
- **Sequences** play only while armed. If they had not finished, they **resume** from the beat they were on when re-armed. A finished `once` sequence **replays** when the reader comes back.
- **A single bloom or sweep** in the RevealLoop style restarts instead, as the landing does.
- **`near`** (600 px) gates mounting heavy content.

### 1.6 Loop, hold, stepper, scrub
- **`playback: "once"` is the default** (v0.2). It plays, then rests on `result`. A diagram is an argument, and looping it re-asks the question. It replays when the reader returns (re-armed after dropping below 0.2), after a `hoverReplay` pointer rest, or on a tap.
- **`playback: "loop"`** is opt-in, for ambient demos with no story (a search sweep). It cycles while armed. After the result hold, it returns to `setup` through a `replayFade`.
- **Hold.** A hover or focus pause is `hold(true)` and `hold(false)`. It is not manual: letting go resumes.
- **Touch ends autoplay.** A stepper click, a scrub drag or a key press switches to manual. Autoplay never resumes on its own; a "▶" button resumes it. This is today's behaviour in Stages and useAutoScrub.
- **Stepper** = the beat index. A jump animates over `settle` (it is not instant), and ghosts appear as they do in the sequence.
- **Compare** is a scrub, not a sequence. Each half shows its own state, so a Compare has **no ghost layers**. Its result frame is the split at its `start`.
- **Scrub** = story time t ∈ [0, 1].
  - A drag writes straight to the DOM (a style or a CSS var), not to React state on every pointer move. This is the Compare pattern.
  - A programmed scrub uses `EASE.inOut`. A ping-pong demo scrub is linear.
- `useBeats(beats, { playback = "once", arm = ARM_SEQUENCE })` returns `{ ref, index, kind, spillT, playing, manual, motion, setIndex, play, pause, replay, hold }`.
  - It re-renders **once per beat**.
  - Anything finer is a CSS transition keyed off `data-beat` or a CSS var.
  - The first render (server, first paint) is the **last** beat; the client steps back to the first beat only where motion is allowed (PhotoStory's pattern).

- **Continuous figures.** Some figures compute each frame from time: a ray march's running maximum, a camera turn, a solver converging. These use `useBeatClock(beats, { playback, arm, fps = 30 })`, which returns `{ ref, ms, total, index, kind, progress, done, playing, manual, motion, seek(i), scrub(ms), play, hold }`. It follows the same rules as `useBeats`. It commits at most 30 times a second and only while playing, and its static value is `ms = total`. Inside a change beat, use `ease.inOut(progress)` for a turn.
- **`useTime`** (hooks.ts) now follows §4 as well. It freezes at `still` under reduced motion, under webdriver, in print and without IntersectionObserver, and it commits at 30 fps. `still` must be the figure's informative frame.
- **CSS-only motion** reads `--gb-dur-{quick,fade,settle,crossfade,draw}` and `--gb-ease-{out,draw,in-out,standard}` from theme.css. Shared keyframes:
  - `.gb-stage-in` is a crossfade in;
  - `.gb-progress` is a pencil progress stroke (`pathLength="1"`) that draws over `--gb-progress-ms`.

### 1.7 Spill sync
- The spill runs on the same clock as the figure.
- Pass `spillT={spillTAt(kind)}`; GeoSpill slides over its own 620 ms, which is `settle`.
- During a drag, pass the scrub's t instead, which applies immediately with no slide. The same immediate path serves a **change beat whose pose is drawn continuously** (a `useBeatClock` turn). Feed the spill the same per-frame t (`SpillSideContext {t}`), so the photo's moving horizon and the spill's meet at the frame edge for every t, not only at the endpoints.
- The spill cursor moves in the same frame as the photo cursor.
- A spill layer enters with its matching photo layer, at the same delay, never before it.

## 2. The overlay stack (`viz/overlay.tsx`)

The z-order is fixed, from the image up. Use one `<svg>` or `<div>` per role, or one `<g>` per role inside a single svg, in this order.

| z | Role | Content | Ink (photo / paper) | Weight (display px) | Opacity | Enter / leave |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | `ground` | Figure wash, plate, spill ground, sky hachure | `--fig-wash`, `--fig-sky-ink` | Hachure 0.7 | 1 (hachure 0.4) | With the Figure |
| 1 | `raster` | Photo, DEM raster, generated stills | None: **never filtered or tinted** | – | 1 | Poster to image over `crossfade` |
| 2 | `derived` | DEM horizon at a pose (`priorRows`, `solvedRows`), residuals, cones, fitted values | `LAYER_INKS` (`prior` dashed) | 2.2 (halo 4.6) | 0.9 | Fades over `fade`; moves over `settle` |
| 3 | `measured` | Eye skyline, sky mask, detected peaks, GPS fix: data on its pixels | `LAYER_INKS[*].photo` / `.paper` | 1.7 (halo 4) | 1 (sky mask 0.7, screen) | Draw-on over `draw` with `EASE.draw` |
| 4 | `furniture` | Arcs, arrows, rings, strikes, rulers, leaders, compass | `--gb-pencil`; corrections `--gb-red` | 1.2, two hand passes | 0.85 | Draw-on over `draw`, after its endpoints exist |
| 5 | `notes` | HandLabel, HandNote, circled numbers | `--gb-ink`; numbers `--gb-red` | – | 1 | Fades over `fade`, `staggerLabel` apart |
| 6 | `interaction` | Cursor, wipe handle, focus ring | `--gb-ink`, white on the photo | 1.5 | 1 | `quick` |

The weights are today's RealPhoto values (skyline 1.7, prior and solved 2.2), so nothing visibly changes when a figure adopts the stack.
- **Order.** Derived sits under measured (v0.2), as RealPhoto already draws it, so the thin traced line reads over the thicker model lines.
- **Provenance.** A horizon at a pose is *derived*: it comes from the DEM and a pose, even though it is drawn on its exact pixels.
- **Paper figures** (maps, diagrams) may scale the weights down, but they keep the role order and the inks.

- **Ghost** (a superseded guess): opacity 0.35, struck in `--gb-red` by the furniture layer, and it stays to the end.
- **Leave**: layers leave in reverse stack order, over `fade × 0.6`. A layer never leaves the final frame unless the story says it was wrong, and then it becomes a ghost.
- **Spill**: past the frame, the spill mirrors layers 2–5 in their **paper** inks, at the same z.
- **Declutter**:
  - Notes (5) never sit within 4 px of a measured line (2).
  - Peak labels go through `layoutPeakLabels`.
  - At most 8 labels per layer.

API:
```ts
type OverlayRole = "ground" | "raster" | "measured" | "derived" | "furniture" | "notes" | "interaction";
type LayerState = "hidden" | "on" | "ghost";
OVERLAY_ROLES  // bottom to top: ground, raster, derived, measured, furniture, notes, interaction
OVERLAY_STACK: Record<OverlayRole, { z: number; opacity: number; weight?: number; halo?: number; enter: "draw" | "fade" | "crossfade" | "quick" | "none" }>
overlayStyle(role, state, { delay?, previous? }): CSSProperties   // z-index, opacity, transition (leave timing when previous was brighter)
layerOpacity(role, state), layerDelay(role, leaving?), layerDuration(role, leaving?), sortByStack(items: { layer }[])
<OverlayLayer layer state? delay? as?="g" | "div">   // the prop is `layer`, not `role` (that would read as an ARIA role); data-layer, data-state
```

## 3. Background ↔ image coordination (`viz/ground.ts`)

The figure's ground takes its cue from its own photo. A bake measures each demo photo once and writes `ground-palette.json`:

```json
{ "demo-01": { "sky": "#…", "terrain": "#…", "horizon": "#…", "skyL": 0.0, "terrainL": 0.0, "horizonL": 0.0 } }
```

- `sky` is the median of the photo pixels above the measured skyline.
- `terrain` is the median of the pixels below it.
- `horizon` is the median of a band of ±2 % around it.
- They are read from the 800 px demo photo and the skyline rows in the photo JSON.

From that palette, pure functions derive the CSS custom properties that `Figure` sets on its root:

| Var | On light paper (default surface) | On a dark plate (`surface="plate-dark"`) | Used by |
| --- | --- | --- | --- |
| `--fig-wash` | Paper mixed 6 % toward the sky tone, chroma-capped | `#131313` mixed 10 % toward the terrain tone | Figure plate and well, spill ground |
| `--fig-sky-ink` | Navy shifted toward the sky hue, ≥ 3:1 on the wash | Sky tone lightened, ≥ 3:1 | Sky hachure in the spill |
| `--fig-terrain-ink` | Contour brown shifted toward the terrain hue, ≥ 3:1 | Terrain tone lightened, ≥ 3:1 | Spill ridges, LiveLines (`--rigi-paper` on plates), ruler |
| `--fig-horizon-ink` | Ink of the horizon band, ≥ 4.5:1 | ≥ 4.5:1 | Horizon tick, compass ruler figures |
| `--fig-halo` | A dark or light halo for photo-ink lines, picked from `horizonL` | Same | CrispLine halo |

Rules:
- Photos are **never** filtered, tinted or blended. Only the ground around them changes.
- Every derived ink passes its contrast floor, and Vitest specs pin this.
- Without `ground`, the vars fall back to today's tokens (`--gb-paper-deep`, `--gb-navy`, `--gb-contour`), so nothing changes until a pod opts in.

API:
```ts
<Figure ground="demo-09" surface="paper" | "plate-dark">   // sets the --fig-* vars
groundVars(photoIdOrPalette, surface): Partial<Record<GroundVar, string>>   // for roots that are not a Figure, e.g. a dark plate inside a paper Figure
groundPalette(photoId): GroundPalette | undefined
contrastRatio(a, b), mixHex(a, b, t), ensureContrast(ink, ground, min)    // pure
```

Pods always read the vars with their fallback, for example `var(--fig-terrain-ink, var(--gb-contour))`.

Notes (v0.2):
- **The bake** is `npx tsx scripts/gipfelbuch/bake-ground.ts`. It runs on macOS only (decoding with `sips`), and the output is 1.7 KB for demo-01 to demo-12.
- **The sky is bluish on every photo** (`#93aacb` to `#bccce0`). The paper wash therefore stays within a breath of paper-deep (contrast < 1.15, pinned), and the difference between photos is felt more in the inks than in the wash.
- **A mixed figure** (a dark plate inside a paper Figure) sets `groundVars(id, "plate-dark")` on the plate element itself.
- **The plate and well** read `--fig-wash`. In print they drop to transparent.

## 4. Static, print, reduced motion, webdriver, phone

- **Static is the result frame**, with ghosts and every note.
  - `useMotionAllowed()` is false under reduced motion, under webdriver, in print (`beforeprint`) and when there is no IntersectionObserver.
  - When it is false, `useBeats` returns the last index and never ticks.
- **Print**:
  - Washes drop to white; print.css already does this for the sheet. Inks stay.
  - Live plates show their posters.
  - Stepper chrome is hidden (`print:hidden`), and the stepper's beat labels print as a numbered list.
- **Webdriver**: the same as static, plus posters on live plates.
- **Phone (under 640 px)**:
  - The spill is the ruler only (the GeoSpill rule).
  - Notes stack under the figure as a numbered list, with red numbers on the figure.
  - Steppers go full width.
  - Autoplay is still allowed, and arming uses the viewport share.
  - A tap on the frame replays it, in place of the hover replay.
  - Scrubs use `touch-pan-y`.

## 5. Changelog
- v0.1 (pod G): the short version. It includes the landing catalogue from the Sonnet sweep.
- v0.2 (pod G, after the C, D, M and S specs):
  - **Playback:** `once` is the default and replays on return; `loop` is opt-in.
  - **Arming:** sequences arm at 0.45 (`ARM_SEQUENCE`).
  - **Tokens:** `turn`, `trace` and `mark` are added.
  - **New API:** `useBeatClock` (pod D); `hold()` (pod C); `BeatSpec.label`.
  - **Static rule:** `useTime` follows §4.
  - **Compare:** it has no ghosts.
  - **Overlay stack:** derived now sits under measured, and the `OverlayLayer` prop is `layer`.
  - **CSS:** motion vars and keyframes in theme.css.

## 6. Cross-pod consistency notes (pod G review)
- **S (photo story):**
  - Its private token table maps onto MOTION:
    - trace → `trace`;
    - strike 280 / 120 → `mark` with `stagger`;
    - enter 320 / 90 → `fade` with `staggerLabel`;
    - pulse 600 → `settle`;
    - pose 1700 smoothstep → `turn` with `EASE.inOut`.
  - `priorRows` and `solvedRows` are derived.
- **C (sequences):** Stages moves to `once` (decision 1 ruled; it remains open to the user). The Compare intro is a `once` script.
- **M (maps):** it already follows the grammar (settle 620 for the cone, so the map and the spill arrive together). Its search demo may use `loop`.
- **D (diagrams):** `script.ts` and `useScript.ts` fold into `useBeatClock`. `useTime` is fixed at the hook side; D fixes the `still` values at the call sites.
