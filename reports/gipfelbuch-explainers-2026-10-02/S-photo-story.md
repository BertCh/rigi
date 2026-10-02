# S: the photo story (guess, measure, correct, snap)

Pod S, Gipfelbuch explainer pass, 2026-10-02. Owner files: `src/components/gipfelbuch/viz/PhotoStory.tsx`, `viz/story.tsx`, plus a new pure module, `viz/storyFilm.ts`, with its specs. Status: **spec v1.1, aligned to grammar v0.2.** Durations and easings are grammar tokens (§8), mirrored in `FILM_MOTION` until `viz/motion.ts` lands. The beat windows in §5 are the original design sketch; the authoritative timeline is `storyFilm.ts` and its spec.

## 1. What the figure must say

One real photo. The phone's pose labels the wrong summits. The eye traces the true skyline, and the gap between the two lines is measured. Turning the camera closes that gap, and the names land on their summits. When the fit is too weak, the app refuses and keeps the guess.

Every claim on the figure comes from the photo JSON: the prior and solved poses, `priorRows`, `solvedRows`, `skyline.rows/weight`, the residual medians, the peaks with az/el and their prior and solved px, and the acceptance and confidence. Motion is used only for the one thing a still frame cannot show: **the turn is continuous, and the gap shrinks because of it.**

## 2. Audit: 10 instances, and what is missing against the landing

| Page | Fig. | Photo | Crop | Caption | Must emphasise beyond the landing |
| --- | --- | --- | --- | --- | --- |
| rigi | Fig. 1 | picker | `skylineBand(d,360)` | gap prior → solved | landing parity (hero) |
| skyline | 4 | picker | none | default | **trace**: the eye's column-by-column trace and its confidence |
| pose-estimate | Fig. 2 | picker | none | default | **residuals**: the gap per column, median/p90/within-5 before and after, the four angles |
| terrain-snapping | Fig. 2 | picker | none | default | **snap**: every name travels to its summit; how far each moved |
| eye-rule | Fig. 4 | demo-09 | `[0,40,800,360]` | default | **eye**: GPS 1183 m is 730 m under the ground, so the eye is floored to 1915 m before any turn |
| camera-prior | 1 | picker | none | sensors vs solved | **prior**: the raw sensors (compass, tilt, focal) that made the guess |
| accept-rule | 5 | demo-07 | none | refused | **refuse**: the solve is proposed, then withdrawn (confidence 0.46 < 0.5) |
| tap-a-peak | 3 | demo-10 | none | tap shift | **tap**: one named summit pulls the others in |
| viewport-inference | 2 | picker | none | search caption | **search**: the heading turning on the compass ruler |
| dev/gipfelbuch-live | 1 | picker | none | default | preview of every state |

These gaps against the landing's HowItWorksScene, RevealLoop, Surround and LiveLines were checked in the code:

1. **Layers pop in and out.** `LAYERS[step]` mounts whole layers per step. The landing wipes each line in left to right with a clip, over 1.8 to 2 s.
2. **The correction is a crossfade.** `lineOpacity` crossfades fixed `priorRows` and `solvedRows`. The landing recomputes the DEM line at the live pose, so the line *moves*. Meanwhile the spill already moves with `horizonPoints(poseAt(t))`, so today the margin and the photo disagree on method.
3. **There is no gap.** The landing draws per-column residual ticks that shrink live and a live mismatch readout. Here the median is only in the caption.
4. **The easing is stacked.** `useTween(…, 1100)` in StorySync, then GeoSpill's own 620 ms `useSlide` on top of the already-moving t, so the spill lags the photo. Neither uses named tokens.
5. **The arc, strikes and ring pop in.** None of them draws on. The snap has no pulse. Solved names pop, with no hollow-to-solid change.
6. **The state flashes.** It starts at the last step, and an effect then resets it to step 0. With motion on, the final frame shows first and then jumps back to the guess.
7. **There is no arming threshold.** It starts at any intersection (`-8%` margin). The landing arms at 45% (how) or 75% (reveal).
8. **The steps run on a fixed 2.8 s interval.** The beats are not shaped by what happens in them.
9. **Every tween frame re-renders the React tree.** `RealPhoto` re-renders its whole subtree, labels and spill included. The landing throttles to 30 Hz, and RevealLoop writes CSS variables only.
10. **The refused case tells the accepted story.** On accept-rule (demo-07) the stepper still says "snap" and the spill still settles at the solved pose, although the app keeps the guess.
11. **Print during play** is not forced to the final frame.

## 3. Background and image coordination

- **One clock, one t.** The photo's moving horizon, the riding names, the gap ticks, the arc pen and the spill all read the same `t = filmPose(ms)`. The spill gets t through `SpillSideContext {t}`, which GeoSpill treats as `immediate`, so there is no second easing.
- **The horizon is continuous across the frame edge.** Inside the photo, the moving line is `horizonPoints(bake, d, poseAt(d, t))`, the same function the spill's echo uses. It meets the spill at the frame edge for every t, not only at the endpoints. `geo-spill.spec` already pins the endpoint registration at a median under 0.5 px.
- **The spill blooms in with the guess.** The margins come up with the pen wipe of the guessed horizon, through `--gb-spill-reveal` on the figure wrapper (proposal P-2). They are shown at the guess pose, because the margin is the guessed world until the turn. They slide with t during the correction and rest at the solved world. In the refused case they slide back to the guess.
- **The heading needle.** During the turn, the spill's compass ruler carries the heading as a cursor (`spillCursor {az: yaw(t)}`). Its bearing label appears only at the two measured endpoints.
- **The wash, the plate and the spill inks** take their cue from the photo through grammar §3. PhotoStory passes `<Figure ground={photoId}>` once G's `Figure.ground` lands:
  - `--fig-wash` gives the paper a breath of the photo's sky;
  - `--fig-terrain-ink` inks the spill's ridges (pod P) in a tone drawn from the photo's terrain;
  - `--fig-halo` picks the CrispLine halo from the horizon band's lightness.

  The photo pixels are never filtered.
- **The pose drives the ground.** The wash is static per photo. What moves is the spill's world, which slides from the guessed to the solved bearing on the story's clock, so the ground and the photo agree at every frame of the turn.

## 4. Overlay stack (bottom to top, inside the photo's SVG, clipped to the frame)

| z | Layer | Ink and weight | Meaning | Provenance |
| --- | --- | --- | --- | --- |
| 0 | photo | none | the picture | measured pixels, never filtered |
| 1 | prior horizon, wiped in | prior ink, dashed, CrispLine 2.2 | DEM horizon at the phone's pose; a ghost (0.35) once the turn starts | derived (`priorRows`: the DEM at a pose, on its exact pixels) |
| 2 | traced skyline, wiped in | skyline ink, CrispLine 1.7 | the eye's trace | measured (`skyline.rows`) |
| 2b | trace weight (focus `trace`) | skyline ink bars | trace confidence | measured (`skyline.weight`) |
| 3 | gap ticks | red where gap ≥ 5 px, solved ink where < 5 px, 1.4, alpha by size | gap between the DEM horizon at t and the trace, at about 11 confident columns | endpoints measured, between them derived |
| 4 | moving horizon | prior ink mixed to solved ink with t, dashed, 2.2 | DEM horizon at the pose in between | derived (DEM at `poseAt(t)`), the map's line, not data |
| 5 | solved horizon | solved ink, CrispLine 2.2 | replaces the moving line at t = 1 | derived (`solvedRows`, exact pixels) |
| 6 | guessed names (ghost) | prior ink caps, hollow dot | where the guess put them; struck in red at the snap | measured (`p.prior`) |
| 7 | riding names | dot plus caps that ride along with t | the names travelling with the camera | derived between `p.prior` and `p.solved` (endpoint-exact) |
| 8 | correction arc | red PenArrow, drawn by a centre-line mask that follows t | the turn of the anchor summit | furniture between measured endpoints |
| 9 | turn numbers | red hand figures | Δyaw and Δpitch | measured (`solved.delta`) |
| 10 | solved names | RealPhoto `peaks` (KR8 layout) | names at the summits | measured |
| 11 | snap pulse and anchor ring | red ring decaying from r 4 to 14 per summit; PenCircle draw-on at the anchor | "landed here" | furniture at measured points |
| 12 | verdict | caps note + HandLoop | accepted with confidence, or refused with the reason | measured |

Notes, gap readout and stamps use HandLabel and HandNote; raw `<text>` is not allowed. Grammar v0.2 roles: the DEM horizons (1, 4, 5) are **derived**, drawn under the **measured** trace (2), which matches RealPhoto's order. Layers 1, 2, 5, 6 and 10 sit on exact pixels. Every derived layer is dashed or furniture-inked and is never presented as a measurement. A number shown during the motion is always an endpoint: the gap readout hides while t is strictly between 0 and 1.

## 5. Animation script (`viz/storyFilm.ts`, pure)

`filmFrame(ms, plan) → { beat, t, wipe: {prior, skyline}, spill, names[i], ticks, readout, arc, numbers, strikes[i], pulses[i], ring, verdict, ghost }`, every value in 0..1. `plan` comes from `filmPlan(d, focus)`: the beat table, which depends on `accepted` and `focus`, the guessed names, the anchor and the tick columns. PhotoStory only maps a frame onto the DOM.

| Beat | Window (ms) | Events |
| --- | --- | --- |
| 1 guess | 0–2000 | prior horizon wiped in, left to right, 150→1050 (*draw*). Spill reveal on the same front. Guessed names: dot then name, staggered 90 ms from 700, each 320 ms (*enter*). Pose note at 1300. |
| 2 measure | 2000–4400 | skyline wipe 2100→3400 (*trace*, near-linear: the eye goes column by column). "Traced" note at 3400. Gap ticks grow from the horizon to the trace, staggered 25 ms from 3500. Gap readout (prior median) at 3900. |
| 3 correct | 4400–7000 | the guess becomes a ghost, 4600→5000. t = smoothstep over 4600→6300 (*pose*): moving horizon, riding names, shrinking ticks, arc pen and spill, all on t. Turn numbers at 6300. Solved line replaces the moving one at 6300 (200 ms). Gap readout (solved median) at 6400. |
| 4a snap (accepted) | 7000–9200 | red strikes over the ghost names, staggered 120 ms, each wiped in 280 ms. Solved names enter at 7100; riding copies fade out 200 ms. Snap pulse per summit, staggered 80 ms, 600 ms decay. Anchor ring draws on, 7700→8200. Verdict at 8300. |
| 4b keep (refused) | 7000–9600 | "refused: confidence 0.46 < 0.5" stamp at 7100. t = 1→0 smoothstep over 7500→8800: the app turns back to the guess, and the spill slides back. The solved line stays as a dashed ghost. The ghost names un-ghost and are never struck. "Tap a peak" note at 8900. |
| hold | END | the final frame, held. |

- **Trigger (grammar §1.5, `ARM_SEQUENCE`).** The film arms when 45 % of the figure, or of the viewport if the figure is taller, is in view, as the landing's how-it-works scene does. Below 20 % an unfinished film pauses with its state intact and resumes from there when it is armed again.
- **First paint.** If the figure is not in view at mount, a layout effect puts it at frame 0 before paint, so there is no flash of the end state. If it is in view at mount, it plays from 0. SSR markup is the final frame, so with no JS it shows the whole story.
- **Once and hold (grammar v0.2 §1.6, the default).** The film plays, then rests on the result, which tells the whole story. A finished film replays from 0 when the reader returns (re-armed after dropping below 20 %), after a 350 ms pointer rest on the photo (`hoverReplay`), or on a tap. `playback="loop"` is opt-in (`loopFrame`: the result hold, then a `replayFade` overlay dip, then setup again). Any touch (a stepper click, a scrub or an arrow key) ends autoplay, and "again" resumes it.
- **Stepper.** There are four tabs: guess, measure, correct, and snap (keep when refused, search on `focus="search"`).
  - Each tab has a hairline showing its beat's progress, written to `transform: scaleX` directly with no re-render.
  - Clicking a tab plays that beat from its start and pauses at its end. Clicking the settled tab replays it.
  - ←/→ on a focused tab moves to the previous or next beat.
  - Dragging along the hairline row scrubs the clock while paused. During a scrub, t follows the pointer at once.
- **Rendering.**
  - The clock lives in a ref, ticked by rAF.
  - Per-frame values are written into the DOM: clip widths, `d` of the moving horizon and ticks, transforms of the riding names, mask dashoffsets, opacities.
  - React state changes only on a beat change (stepper, caption, layers) and, during the turn, at most every 33 ms for the spill t and needle. The landing does the same at 30 Hz.
  - Proposal P-3 (a subscribable t for GeoSpill) would remove the last per-frame React commit.
- **Caption.** `aria-live="polite"`, updated only on a beat change, written from measured numbers. The keep beat says why the app refuses.

## 6. States

- **Reduced motion, webdriver, print, no IntersectionObserver.** `filmFrame(END)`. Accepted: t = 1, with the ghost guess, red strikes, arc with numbers, solved names, the anchor ring, the shrunken ticks (focus `gaps` only) and the verdict. Refused: t = 0, with the dashed solved ghost, the refused stamp and the guessed names kept.
- **`beforeprint`** seeks to END.
- **Phone (< 640 px).** The stepper is 2×2. There are 7 gap ticks instead of 11. The labels keep their on-screen size through `k`. The spill shows the ruler only (GeoSpill), and the heading needle still moves on it.
- **Theme.** Line inks are photo inks on the photo. Labels use the paper halo. Both themes come from tokens, and nothing is hard-coded dark.
- **Stale data or photo change.** The previous photo stays until the next one loads, as today. A new photo resets the film to frame 0 if it is in view, otherwise to END.

## 7. Per-page `focus` (a new prop, `focus?: "trace" | "gaps" | "snap" | "eye" | "prior" | "tap" | "search"`)

| Page | focus | What changes |
| --- | --- | --- |
| rigi | (none) | default film |
| skyline | trace | measure beat +800 ms; the weight bars fade in after the wipe; note "traced N columns; tall bars = sure" |
| pose-estimate | gaps | ticks stay in the final frame; readout "median 15.4 → 2.2 px · p90 35.6 → 24.0 · ≤5 px 21% → 74%"; the arc note lists Δyaw, Δpitch, Δroll, focal × |
| terrain-snapping | snap | up to 6 names ride; each snap pulse writes "moved N px" (‖solved − prior‖, measured) |
| eye-rule | eye | guess beat adds the note "GPS 1183 m: 730 m under the ground → eye 1915 m" (from `gps`); the pitch part of the arc is drawn as its own vertical tick |
| camera-prior | prior | guess beat note "compass 134.5°, tilt −13.9°, focal 26 mm" (from `sensor`); the correct beat writes "compass off by 18.5°" |
| accept-rule | (data: refused) | beat 4b, automatic whenever `!solved.accepted` |
| tap-a-peak | tap | correct beat opens with a tap ring on the anchor's solved summit, "tap: NAME", and the spill cursor at its azimuth |
| viewport-inference | search | tab 3 is labelled "search"; the heading needle carries the moving yaw label "…" between the endpoints; no fake sweep (there is no measured search trace in the JSON) |

## 8. Motion tokens (grammar v0.1 §1.1–1.2)

| Film event | Token | Easing |
| --- | --- | --- |
| Pen wipe of the guessed horizon | `draw` 900 | `EASE.draw` |
| The eye's trace (skyline wipe) | `trace` 1300 (trace focus + 800) | `EASE.linear` |
| Names, notes, ticks and readouts enter | `fade` 420, `staggerLabel` 60 | `EASE.out` |
| Beat dwell | `beat` 2800; result `beat × resultHold` (1.6) | n/a |
| Lead before each beat's first event | `lead` 80 | n/a |
| Camera turn (and the refused turn back) | `turn` 1600 (added in grammar v0.2 at S's request) | `EASE.inOut` |
| Strikes | `mark` 280, `stagger` 110 | `EASE.draw` |
| Snap pulse | `settle` 620, `stagger` 110 | `EASE.out` |
| Anchor ring | `draw` 900 | `EASE.draw` |
| Loop | `replayFade` 450 | linear |
| Arm and reset | `ARM_SEQUENCE` 0.45 and 0.2 | n/a |

## 9. Proposals to other pods

- **P-1 → pod P.** `RealPhoto lines={false}`: the spill still echoes `layers`, but the photo draws no prior/solved/skyline/weight strokes, so PhotoStory can wipe its own CrispLines in. Sent to inbox/P.md.
- **P-2 → pod P.** The GeoSpill root reads `opacity: var(--gb-spill-reveal, 1)`.
- **P-3 → pod P (perf, later).** A subscribable t for GeoSpill.
- **M-1 (from pod M, done by S).** `setT(t, { instant })` and `story.instant` in story.tsx: followers draw an instant t as given and settle only on jumps. Compare's drag should pass `instant: true` (sent to pod C).
- **G-1 → pod G.** A `MOTION.turn` token, and §1.7 extended to "a change beat whose pose is drawn continuously follows t at once" (sent to inbox/G.md).

## 10. Browser-pass checklist

For each page in §7 and for /dev/gipfelbuch-live, check with `?theme=light` and `?theme=dark`, at desktop width and at 390 px:

1. At 45 % in view the film plays once and holds. Mid-film it pauses below 20 % and resumes. Finished, it replays on return, on a 350 ms hover and on a tap. No final-frame flash happens first.
2. The prior horizon and the spill appear on one front. The skyline wipe reads as a trace.
3. During the turn, the moving horizon meets the spill's horizon at both frame edges with no visible step, and the ticks shrink. The gap readout is hidden while the camera moves.
4. The riding names arrive on the solved dots, and the solved labels take over with no jump larger than the label's leader.
5. The arc pen follows the anchor, the numbers appear at the end, the strikes stagger, and the pulses and ring play.
6. On accept-rule (demo-07), the turn goes out and comes back. The stamp shows, nothing is struck, and the spill ends at the guess.
7. Stepper: a click plays one beat, the arrows work, the scrub drags, and "again" replays the film.
8. Scrolling away mid-film pauses it, and scrolling back resumes it.
9. Reduced motion, `navigator.webdriver` and print show the final frame (print mid-play too).
10. Performance: no long tasks over 50 ms during the turn, and React commits during the turn stay at or under 30 Hz.

## 11. What landed (2026-10-02, all WIP, browser-unverified)

| sha | What |
| --- | --- |
| d84004b | `viz/storyFilm.ts`: the film as a pure clock-to-frame script (filmPlan, filmFrame, loopFrame, beatSpan, rowAt, pickTickColumns, ridePoint) with grammar tokens; `story-film.spec.ts`; spec draft |
| 61215b8, 8a4321a | `viz/story.tsx`: `setT(t, { instant })`, `story.instant` (pod M's proposal) and a stable `setT` identity (pod C's report); `story.spec.tsx` |
| 0fd5d8c | `PhotoStory.tsx` rewritten as the film, with `viz/storyGeometry.ts` (path, ticks, layers, needle, arming, commit throttle, scrub) and specs, plus a happy-dom spec of the static frames (accepted and refused) |
| e82ae57 | Fixes from the adversarial review, listed below |
| bc8498e | Per-page `focus` (trace, gaps, snap, eye, prior, tap, search) with pure note builders, specced against the real JSON; call sites; LIVE.md |
| 00a67a1 | The guess's pose note ghosts to 0.35, so the static frame keeps the sensor reading |
| 6b3ff13 | Ledger row |
| c28b867, b3ac55f, 1ca9c68 | Call-site hunks moved off lines that peers had edited without committing |

The fixes in e82ae57:
- a stepper click landed on the next beat;
- the moving horizon disappeared during the hand-over;
- the film restarted on an inline `crop` or the 640 px breakpoint;
- print did not flush the settled frame;
- the picks ignored the crop;
- the stepper used roving tabindex, and the caption did not freeze while scrubbing.

**Checks.**
- Run: biome, tsc, spdx, and the gipfelbuch fast checks. `npx vitest run src/components/gipfelbuch` passes (237 tests after the rebase).
- The fast tier's failing rows are outside pod S:
  - the Python venv and `src/lib/upload` unit specs;
  - the biome ratchet in `shell.spec.ts` and `camera-roll.tsx`;
  - the ontology `picker/schema.ts` check;
  - the align-cert timeout under load.
- After the final rebase, `tsc` fails on master's `viz/explain.tsx` duplicate `MOTION` import, which belongs to pod C and has been reported to them.

**Negative or deferred.**
- **terrain-snapping `focus="snap"` is not on the page.** A peer's uncommitted retitle owns that exact line. Add `focus="snap"` once their edit lands.
- **No search sweep on viewport-inference.** The photo JSON has no measured search trace (`solved.search` is just "local"), so the page shows only the moving heading needle. Faking a sweep would break "numbers are measured".
- **`useBeatClock` was not adopted.** It landed (grammar v0.3) after the film's clock was written. The film has a private rAF clock with the same semantics, marked `TODO(grammar)`; swapping is round-3 work.
- **`Figure ground={photoId}` is not wired.** It waits for pod G's `Figure.ground` to be on master.
- **No drag-the-horizon interaction.** The landing's spring-back is excluded by the grammar (no overshoot), and a drag would need a pose solver in the page.
- **Commit rate during the turn.** RealPhoto and GeoSpill still re-render at ≤ 30 Hz during the 1.6 s turn. P-3 (a subscribable t) is deferred until the browser pass shows a cost.
- **`pickTickColumns` is sparse on demo-06.** It finds 5 of 11 columns: the trace is only confident (weight ≥ 0.4) in part of that photo.

**Open for the user.**
1. **Playback.** The grammar's once + hold (replay on return, hover or tap) is the default, and `playback="loop"` is opt-in. Should the hero (rigi Fig. 1) loop like the landing's RevealLoop?
2. **Pose-note ghost.** Ghosting the guess's numbers to 0.35 in the final frame, as opposed to hiding them, keeps the static frame complete but adds ink.
3. **Duration.** The film runs 12.9 s (three 2.8 s beats and a 4.5 s result hold; the trace focus adds 0.8 s), against the landing's 28 s scene.

**Top next items.**
1. A browser pass over §10, especially the frame-edge registration of the moving horizon, and riders handing over to the KR8 labels.
2. Swap to `useBeatClock` and `Figure ground`.
3. terrain-snapping `focus="snap"` once the peer's line is committed.
