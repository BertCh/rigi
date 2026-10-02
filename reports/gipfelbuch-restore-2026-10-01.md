# Gipfelbuch restore (2026-10-01, late)

User goal (session mt-image-2d): "in gipfelbuch we lost our swiss cartography and notebook style and we lost our high fidelity visual explanations (from before the refactor). dont do any testing just do a comprehensive overview of the current and past state of the repo and lets get the supporting pages back to their former glory no holds barred. we want the old fidelity with the new aesthetics of the geo data bleeding out of the visuals"

The work was split between two sessions:

- **mt-image-2d** owns the shell, the kit, the routes and the pages in clusters D and E: dem-source, terrain-sampler, eye-rule, dem-anchoring, photo-workspace, camera-roll and step-inside.
- **mt-image-25** owns the pages in clusters A, B and C: rigi, photo, camera-prior, viewport-inference, skyline, dem-horizon, pose-estimate, baseline-pipeline, accept-rule, terrain-snapping, tap-a-peak and peak. 25 also wrote the five-state code audit in `reports/gipfelbuch-best-of-both.md`.

Per the user, no browser runs, screenshots or tests were done. Every change below is **browser-unverified**. Only `tsc` and `biome` were run.

Backup of the tree before this pass: `~/mt-image-archive/2026-10-01-gipfelbuch-before-restore-2d.tgz`.

## 1. How the Gipfelbuch got here (all on 2026-10-01, uncommitted unless noted)

| Era | Who | State | Snapshot |
|---|---|---|---|
| E0 Explainers | 09, bd | `/atlas` was dark-themed. All 19 pages were rewritten visual-first: a real-photo hero (`Stages`/`Compare`), claim Beats, a `Trio`, a "where it fails" `Gallery`, `Numbers` and a collapsed `Details`. Figures were about 712 px in a 760 px article. Lines were crisp and glowing on dark scenes, and value marks were solid fills. **This is the fidelity bar.** | Committed: `HEAD:src/lib/atlas/pages/*` and `HEAD:src/components/atlas/viz/*` |
| E1 Swiss sheet | 2f | Renamed to Gipfelbuch (74). The `GB_THEME` paper sheet used Landeskarte inks, with `SheetFrame`, `Cartouche`, `SheetMap` (the real Niederhorn sheet), `ContourField`, `Waymark`, `Signpost`, `Legend`, `ScaleBar` and `HachureRule`. | `~/mt-image-archive/2026-10-01-gipfelbuch-before-sketch.tgz` (19:09) |
| E2 Sketch notebook | c2 | Every figure was re-inked with `notebook/Ink.tsx` and `sketchify.ts` (seeded pen strokes, Hachure, Stipple). `NotebookMap` became the index (3 entries, 16 numbered steps, follow-one-photo). Hand face is Architects Daughter. | `…before-field-notebook.tgz` (20:09) |
| E3 Field notebook | s52 | `ConceptNotes` added: `FieldNotes` (the measured note in the margin) and `NotebookTrail` (a pen trail of the entry, replacing the force graph). Also added: `PencilFilter`, `paint.ts`, the 6 px / 24 px type programme, and the Grinnell pair of fair copy and field note. | `…before-design-book.tgz` (20:20) |
| E4 Design book + softer | 44, 3b | Source Serif titles, self-hosted fonts, `type.ts` roles, `Register`/`Marks`, `MarginNote`. The user asked for a **softer** sheet, so grain, tape, tilt, the red margin rule and frame ticks went. Those stay gone. | — |
| E5 Peak notebook (Tafel) | 2f | The shell got name H1, claim dek, `Ledger` and the full-bleed **Tafel**: a photo band whose measured terrain, compass ruler and peak names **carry past the frame**. The index became the `Blattuebersicht`. R1–R9 of `gipfelbuch-regression-2026-10-01.md` were applied: the wide figure track, `Stat`, crisp photo lines, imprint off in galleries and `Flow` boxes. | `…before-restore-2d.tgz` (22:05) |

### What was lost along the way

- **The notebook left the shell (E5).** The Tafel shell dropped the header `ContourField`, `FieldNotes`, the pen `HandRule`s, `NotebookTrail` and the "Connections" section (Leads to / Referenced by). The index dropped `NotebookMap`. All of these components still existed, but nothing rendered them. That is most of "we lost our notebook style".
- **The Swiss furniture thinned (E4–E5).** In E3, `ContourField`, `HachureRule` and `ScaleBar` each appeared on 4–7 surfaces. By E5 they appeared on 2–3. `PencilFilter` was used nowhere.
- **Fidelity (E1→E5).** No real-data figure was deleted: per-page figure and real-photo counts are equal or higher than at HEAD. The loss was in presentation:
  - figures shrank from 712 to 518 px (R1);
  - value marks turned into hatch texture (R2);
  - dark scenes that made the lines pop became flat paper;
  - stats overflowed (R3);
  - headline evidence was demoted into `Details` (R5);
  - the HowItWorksScene embed broke (R8).
  E5 fixed R1, R3, R4, R6, R7 and the kit part of R8. The page-level R2, R5 and R9 items in the cluster files were only partly applied.
- **The geo bleed lived only in the Tafel.** None of the figures below the hero had the signature look.

## 2. What this pass changes

### Shell and index (2d)

- `ConceptPage.tsx`:
  - the sheet's contour field is back behind the title (`ContourField seed={node.id}`, a different crop on each sheet);
  - `FieldNotes` sits under the Ledger as a graph-paper `nb-book` card holding the measured, hand-numbered note for the followed photo, without its own strip because the Tafel picker drives it;
  - a pen `HandRule` closes the header;
  - a `HachureRule` and a **"Where it sits"** section sit at the foot, with the `NotebookTrail` and the curated **Leads to / Referenced by** link cards (`NodeCard`, which now shows `node.claim`).

  The Tafel, Ledger, picker, wide figure track and colophon are unchanged.
- `notebook/ConceptNotes.tsx`: `FieldNotes` takes `strip` and `className`.
- `routes/gipfelbuch.index.tsx`: the **field notebook** (`NotebookMap`) is back between the sheet map and the Blattübersicht, separated by a `HachureRule`.

### Kit: geo bleed for every figure (2d)

`RealPhoto` (`viz/real.tsx`) takes `bleed` (true = 0.14 of the frame width of paper on each side). The photo stays framed, and around it a new `GeoBleed` layer draws three things:

- the Tafel bake's ridge strokes (`public/demo/gipfelbuch/tafel/<id>.webp`), re-inked in contour brown by an `feColorMatrix` and faded towards the outer edges;
- a compass ruler over the top, with ticks every 5°, labels every 15° and red cardinals;
- up to four summits outside the frame (navy triangle, name, height and distance), as on a Panoramatafel.

It works with `crop`. All of it is drawn in working-frame px, so it stays registered with the photo. Use it on one big real-photo figure per page, or as the main render inside `Stages`. Don't use it in Trio, Gallery, Compare or thumbnails.

### Pages

Brief given to every page agent: `HEAD` is the fidelity bar. Restore figure size, legibility, solid value fills and crisp lines. Bring back dark **plates** only around live or synthetic scene content, as D-PN1 allows. Hatch decorates and fill encodes. Notebook ink is for furniture only. Move headline evidence back out of `Details`. Put `bleed` on the biggest real-photo figure. Keep every improvement from E1–E5.

Per-page outcomes: see §3 (filled in as the agents report).

## 3. Per-page outcomes

Four Sonnet agents checked every figure in their pages against `HEAD` and against the cluster files. The E5 pass had already fixed most cluster items, so their work was to close what was still open.

### Pages D–E (2d)

| Page | Restored or added in this pass |
|---|---|
| dem-source | SVG labels set ink and halo through `style`, not `var()` attributes (the rule-7 trap); dotted underline on the coverage chips. The hero is a hillshade comparison, not a photo, so it has no photo bleed. |
| terrain-sampler | The same rule-7 fixes on all print, ring, grid and mini labels; the stale `decoration-white/30` link is now pencil. |
| eye-rule | Fig. 1 is a bleed Figure, and its Stages photo is `RealPhoto bleed`, so the terrain, compass and summits run past the frame. The side view and photo are capped at the wide track. |
| dem-anchoring | Fig. 1 is a bleed Figure, with `RealPhoto bleed` on all three stages so the geometry holds still between them; code cards `break-all`; the reports line is a `CodeRef` row. |
| photo-workspace | The hero Stages carry the geo bleed on all four stages. Schematic labels went from 7–8 px rendered to about 10–14 px. Pin rings are larger, and unpinned ones are red so they stand off the black crest. Fig. 2 markers are bigger. |
| camera-roll | Every caption's colour words now match the inks (`RealRoll`, `RealBias`, the Aim step, `CompassBias`, `PanoramaStrip`). `PanoramaStrip` controls sit one per row. |
| step-inside | `RealRange` stacks below `lg`, so its axis labels are no longer clipped. Its caption and `SplitRuler` colour words are fixed. Ruler labels are 12–14 px. |

### Kit follow-ups from the page agents (2d)

- `Numbers`: cells are at least 150 px wide, so "4.0° → 0.22°" no longer overflows.
- `Stages`: the tabs are one row of equal cells from 560 px of container width and two columns below that, with play/pause kept apart from them.
- `Ledger`: the value sits over its label until the container is 440 px wide. This fixes the "1918.9 m" collision with its label in the header rail.
- `Callout`: the background is a faint wash of the tone colour, where it used to be the same grey for every tone.
- Checked and already fine: the `halfKm` ledger (`scale: 1`), `Flow` (boxed nodes, vertical below 560 px), and `Stat` (container-query size, nowrap).

### Pages A–C (25)

Session 25 ran four Sonnet packages (PK-A to PK-D) against `reports/gipfelbuch-best-of-both.md` §4. 2d read back the result from the code, comparing each page with the pre-restore backup.

- **Shared across all 12 pages:**
  - Each page opens with its own real-photo hero drawn with `RealPhoto bleed`: HeroStages, HeroMarks, HeroCompare, HeroPose, HeroTaps, RealSummits or the terrain-snapping Hero. accept-rule is the exception and keeps the shell Tafel, per spec §2.1.
  - Page-local `PrintLabel`/`PrintNote`/`HandRange` copies are gone in favour of the kit's.
  - "Next:" lines and `imprint={false}` are dropped.
  - Synthetic and schematic figures are renamed D1…n and body figures run 1…n.
- **No real-data component was removed.** Fewer `<Figure>` wrappers on terrain-snapping, tap-a-peak, peak and dem-horizon only means wrappers were merged into heroes or duplicate labels were fixed. Every real component is still rendered.
- **Data marks.** Sketched data strokes were replaced by exact marks:
  - dem-horizon: `SketchPath`/`SketchPolyline` 14 → 0, with a local exact `DataLine`;
  - tap-a-peak: 6 → 0;
  - peak: `SketchPath` 7 → 0.
- **Hand notes** were cut to the §2.4 budget: on peak from 6 to 1, on viewport-inference from 3 to 1, on baseline-pipeline from 3 to 1.

| Page | Hero (geo bleed) | Notable |
|---|---|---|
| rigi | HeroStages, 4 stages, on a plate | `GuessVsSolved` back in the body |
| photo | HeroMarks | — |
| camera-prior | HeroCompare (bleed photos in the wipe) | — |
| viewport-inference | HeroCompare | hand notes 3 → 1 |
| skyline | HeroStages | — |
| dem-horizon | HeroStages | exact `DataLine`, `WorstTenth` figure added |
| pose-estimate | HeroPose | — |
| baseline-pipeline | HeroStages, 5 stages | — |
| accept-rule | shell Tafel; `ScoreFit` photo bleeds in the body | — |
| terrain-snapping | Hero | data marks exact |
| tap-a-peak | HeroTaps (`TapFrame bleed`), on a plate | sketched data 6 → 0 |
| peak | RealSummits | hand notes 6 → 1, figures renumbered |

`PAGE_HERO` now lists 15 sheets. The shell Tafel stays on accept-rule, dem-source, terrain-sampler and camera-roll, whose heroes are maps on a plate. Every sheet therefore has exactly one spilled photo.

### Checks run (no browser, per the user)

- `npx tsc --noEmit -p .`: no errors under any Gipfelbuch path.
- `npx biome check --write` on every file touched.
- Two node checks were re-run, only to confirm fixes for breakage this pass caused (the `SWISS` move): `tafel/sheets.check.ts` OK, and `swiss/contrast.check.ts` OK.

- Final gate (session 25, after the last edits):
  - the fast tier passed: 73 pass, 0 fail, 1 skip;
  - `tsc` reported 0 errors;
  - SPDX was clean;
  - all five Gipfelbuch and Tafel checks passed.

Not run: every browser check. Nothing has been rendered yet.

## 4. Open items

- `src/components/site/how/HowItWorksScene.tsx` (a landing component, embedded on rigi) still has the R8 layout problems at the Gipfelbuch width. Its owner is the landing session, so it was not edited here.
- Browser batch: one consolidated pass over `/gipfelbuch` and all 19 sheets, under the render lock, with `?renderer=` pinned. It needs to confirm hero sizes, the bleed spill registration, label sizes (several pages retuned their SVG label constants for a ~960 px track) and the plate grounds. Run the fast tier before landing.
- KR11 (page lint) landed in `gipfelbuch.check.ts` (session 25). All 19 pages pass it.
- Some synthetic Details figures still use sketch strokes for measured-looking lines: camera-roll's `RollLinker`, `ViewpointWalk` and `CompassBias`.
- `PageBoundary` and other shell pieces are unchanged. `MarginNote` is still unused by pages.

## 5. Superseded by the hand pass (f5e51f3, session 16)

This restore was committed inside f5e51f3, together with session 16's user-requested hand pass. That pass changes some rules above:

- the body face is Playpen Sans, and print is kept for code and math only;
- `PrintLabel` is renamed `HandLabel`;
- `data` marks are now a pen pass within 0.5 px, no longer exact geometry;
- the page lint now requires at least 6 hand notes per page and bans raw `<text>`.

The current rules are in `src/components/gipfelbuch/README.md` and `reports/gipfelbuch-hand-sketch-2026-10-01.md`. The geo bleed, `PAGE_HERO`, plates and the notebook shell from this pass carry over.
