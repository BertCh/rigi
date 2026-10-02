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

- **Mounting.** A plate mounts its site component only near the viewport (`useNearViewport`), with the poster as placeholder and as Suspense fallback.
  - Under webdriver and in print, every plate shows its poster.
  - Under reduced motion, the animated ones (reveal, drape, step inside) show their poster too.
  - `LiveHowItWorks` mounts whenever it is near, because the scene freezes on its own last beat.
- **Topography on the sides.** The static bakes are drawn by `PaperSurround`, the landing's `Surround` redrawn for paper: strokes in contour brown through the WebP mask, the ruler in hand figures, and summits in hand capitals with italic "height · km". The live line art (`LiveLines`, inside LiveRollMap and StepInsideDemo) follows `--rigi-paper`, which the plate sets to `--gb-contour`; the engines' own boxes reset it to white inside the frame. Both are md and up only, as on the landing.
- **Notes.** `notes: { text, at: [fx, fy], side?, y? }[]`. `at` is a fraction of the frame and may lie outside 0..1 to point into the spill. When the gutters are at least 112 px wide, the notes sit beside the plate with leaders. Otherwise they stack under it as a numbered list, with red numbers on the plate.
- **Props.** Every figure takes `number`, `title`, `caption`, `notes`, `date` and `className`. The framed ones also take `aspect` and `frame` (the frame's share of the track). `LiveReveal` and `LiveCompare` take `photoId: "demo-01" | "demo-09"`, the two pairs the landing bakes.
- **Captions** default to measured numbers: the photo JSON for reveal and compare, `camera-roll/roll.json` for drape, panorama and board, and the step bake's counts (`STEP_BAKE`, copied from `public/demo/step/scene.json`) for step inside.
- Use one live plate per sheet at most; each runs a GPU engine or a large image.

## Photo story (`PhotoStory.tsx`)

`<PhotoStory />` draws one demo photo with its alignment written on it in four steps:

1. **Guess.** The DEM skyline and up to four names at the phone's prior pose.
2. **Measure.** The skyline the eye traced, with a "traced by the eye" note.
3. **Correct.** A red hand arc from the guessed mark of the highest peak to its solved mark, with the yaw and pitch turn. The guessed names are struck in red.
4. **Snap.** The names at their solved summits, and the anchor summit ringed.

- Every line and point on the photo is measured: `RealPhoto` layers and `HandDot data` marks. The arc, the strikes and the ring are furniture between measured endpoints.
- The photo spills its world onto the margins (`RealPhoto bleed` → `GeoSpill`), and the spill follows the story's t (guess 0, solved 1).
- The steps advance on their own while the figure is in view, until the reader uses the stepper. Static (reduced motion, webdriver, print) shows the final step with the struck guess still visible.
- `photoId` defaults to the page's photo picker (`useNotebookPhoto`). Other props: `number`, `title`, `caption`, `bleed`, `interval`, `crop`, `date`, `className`.
- Its spill needs `.tafel-spill` from `tafel/tafel.css`; ConceptPage loads it with the Tafel.
