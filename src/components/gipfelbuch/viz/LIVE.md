<!--
Rigi
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: Copyright (c) Rigi contributors
-->

# Live plates and photo stories

The landing page's real-image engines, bound into the Gipfelbuch as notebook figures (`live.tsx`), plus the alignment story written by hand on a real photo (`PhotoStory.tsx`). Preview: `/dev/gipfelbuch-live` (dev only).

## Live plates (`live.tsx`)

Each figure is a `LivePlate`. It puts a `Figure` on the wide track, with a hand Kroki title over it. The frame in the middle is a dark plate (`data-theme="dark"`, so the engines and WorldView keep their dark ground). The paper around the frame carries the terrain spill and 1–3 hand notes with pencil leaders into the plate. The hand "Fig." caption states the measured claim.

| Figure | Site component (lazy) | Assets and bakes | Poster |
| --- | --- | --- | --- |
| `LiveReveal` | `site/RevealLoop` | `public/demo/shots/demo-01-overlay.jpg` or `hero.jpg`, `/demo/w/*` variants, `site/surround/demo-01.json` or `demo-09.json` | the overlay still |
| `LiveCompare` | `site/Compare` | same pairs as `LiveReveal` | the overlay still |
| `LiveDrape` | `site/LiveRollMap` | the demo roll, baked roll-map seed, `/demo/surround/live3d-lines.bin` | `/demo/shots/drape.jpg` |
| `LiveStepInside` | `site/StepInsideDemo` | `/demo/step/*`, `/demo/surround/step-lines.bin`, Google 3D tiles | `/demo/step/photo.jpg` |
| `LivePanorama` | `site/DemoSections` `PanoramaSection` | the demo roll | thumbnail contact strip |
| `LiveTopoBoard` | `site/DemoSections` `TopoSection` | swisstopo Pixelkarte tiles, `site/surround/map.json` | thumbnail contact strip |
| `LiveHowItWorks` | `site/how/HowItWorksScene` | the baked how-scene | none (the scene holds its own static state) |
| `LiveFingerprint` | `site/meta/FingerprintRing` | the meta bake (`scripts/meta/bake.ts`) | blank frame (SVG, no GPU) |
| `LiveSideSection` | `site/meta/SideSection` | the meta bake | blank frame (SVG, no GPU) |
| `LivePixelToPlace` | `site/meta/PixelToPlace` | the meta bake | blank frame (SVG, no GPU) |

- **Mounting.** A plate mounts its site component only near the viewport (`useNearViewport`), with the poster as placeholder and as Suspense fallback.
  - Under webdriver and in print, every plate shows its poster.
  - Under reduced motion, the animated ones (reveal, drape, step inside) show their poster too.
  - `LiveHowItWorks` mounts whenever it is near, because the scene freezes on its own last beat.
- **Topography on the sides.** The static bakes are drawn by `PaperSurround`, the landing's `Surround` redrawn for paper: strokes in contour brown through the WebP mask, the ruler in hand figures, and summits in hand capitals with italic "height · km". The live line art (`LiveLines`, inside LiveRollMap and StepInsideDemo) follows `--rigi-paper`, which the plate sets to `--gb-contour`; the engines' own boxes reset it to white inside the frame. Both are md and up only, as on the landing.
- **Notes.** `notes: { text, at: [fx, fy], side?, y? }[]`. `at` is a fraction of the frame and may lie outside 0..1 to point into the spill. When the gutters are at least 112 px wide, the notes sit beside the plate with leaders. Otherwise they stack under it as a numbered list, with red numbers on the plate.
- **Props.** Every figure takes `number`, `title`, `caption`, `notes`, `date` and `className`. The framed ones also take `aspect` and `frame` (the frame's share of the track). `LiveReveal` and `LiveCompare` take `photoId: "demo-01" | "demo-09"`, the two pairs the landing bakes.
- **Captions** default to measured numbers: the photo JSON for reveal and compare, `camera-roll/roll.json` for drape, panorama and board, and the step bake's counts (`STEP_BAKE`, copied from `public/demo/step/scene.json`) for step inside.
- The three `site/meta` plates are plain SVG: they mount whenever near (`motion="self"`), take no notes and no spill. They also count against the one-per-sheet rule only loosely; they run no engine.
- Use one live plate per sheet at most; each runs a GPU engine or a large image.

## Photo story (`PhotoStory.tsx`)

`<PhotoStory />` draws one demo photo with its alignment written on it as a film: guess, measure, correct, then snap (or keep, when the app refused the solve).

- One clock (`storyFilm.ts`, pure and specced) gives one frame of 0..1 values per instant. `PhotoStory` writes each frame straight onto the DOM; React only hears about a beat change and, every 33 ms at most, the pose t.
- Guess: the DEM horizon is drawn by hand at the phone's pose and the margins come up with it, then the guessed names and the pose note. Measure: the traced skyline wipes in, then gap ticks grow from the horizon to the trace, then the median. Correct: the guess ghosts, the camera turns on a moving DEM horizon (the same pose drives the spill), the arc is drawn, then the turn's numbers. Snap: red strikes, a ring on each summit, the anchor ring and the confidence. A refused solve ends on keep: the stamp, then the camera turns back to the guess.
- Names ride the camera between their guessed and solved marks, exact at both ends. Every number is read from the photo JSON.
- Playback is once and hold by default: it arms at 45 % in view, pauses below 20 %, and replays from 0 when the reader comes back, rests the pointer on it or taps it. `playback="loop"` repeats on its own.
- The stepper plays one beat and then stays manual; arrow keys move between beats. Dragging along the hairlines scrubs the clock. "again" replays.
- Static (reduced motion, webdriver, print, no IntersectionObserver) shows the settled frame, `filmFrame(plan, plan.total)`, with every focus note in it. Print commits that frame before the snapshot and restores the reader's state after.
- `focus` says what the page is about: `trace` (weight bars, the traced-column count), `gaps` (the whole residual and roll and focal in the turn), `snap` (up to six names, how far each moved), `eye` (the GPS-under-ground note), `prior` (compass, tilt and focal, how far the compass was off), `tap` (the spill needle on the tapped summit, then the heading), `search` (the tab reads "search").
- `photoId` defaults to the page's photo picker (`useNotebookPhoto`). Other props: `number`, `title`, `caption`, `bleed`, `crop`, `date`, `className`, `playback`. A crop keeps names, ticks and notes inside it.
- Its spill needs `.tafel-spill` from `tafel/tafel.css`; ConceptPage loads it with the Tafel.
