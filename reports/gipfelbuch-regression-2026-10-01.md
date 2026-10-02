# Gipfelbuch fidelity regression (2026-10-01)

User report: "gipfelbuch or atlas had a regression. we used to have very high fidelity real photo based explainers but now its not as good … we want the current aesthetics but old functionality."

Method: HEAD (`034856d`, the committed atlas explainer pass by session 09) was served from a worktree, and a snapshot of the uncommitted Gipfelbuch tree (taken 21:10, before 2f's Figure/explain slab removal) was served next to it. All 19 concept pages were screenshotted at 1400 px with every `<details>` open (under the render lock), rendered widths were measured in the DOM, and each page's HEAD and current source were diffed. Five Sonnet agents each reviewed one cluster of pages. Their full per-page findings, with screenshot and line references, are in `gipfelbuch-regression-2026-10-01/cluster-{A..E}.md`. Nothing was measured on the live app, and none of the proposed fixes has been implemented or tested.

## What did not regress

- **Data.** `public/demo/gipfelbuch/*.json` matches `public/demo/atlas/*.json` byte for byte, apart from the `script` path string. The measured pipeline output is unchanged.
- **Figure inventory.** Real-data component usage per page (`RealPhoto`, `useGipfelbuchPhoto`, `DemPatch`, galleries, pickers, steppers) is equal or higher on every page. Almost no figure was deleted, and every stepper, picker, slider and toggle still works.
- **New things worth keeping:**
  - the Tafel hero band (measured skyline, peaks carried past the frame);
  - the page-level photo picker, with a hero ledger re-read per photo;
  - the colour-keyed `Eq` formula cards;
  - photo-workspace's `PeakProjection`;
  - camera-roll's `RollCompasses`;
  - step-inside's `RealSplit`;
  - the real step-inside photo on rigi;
  - "On this route" in place of the force graph.

The regression is presentation. The same real data is drawn smaller, in lower-contrast encodings, and in components that break at the new width.

## Root causes, by leverage

| # | Cause | Where | Pages | Fix (keeps the paper/Swiss look) |
|---|---|---|---|---|
| R1 | **Figure column narrowed.** The body sits in `content-start/margin-start`, 6 of 12 columns, and the right ~330 px of the sheet is empty. Measured: typical figures went from 712 to 518 px, bleed figures from 808 to 566 px, and gallery tiles from 171 to 118 px (median RealPhoto width −30 %, area about −50 %). SVG label constants tuned for 720 px now render at 5–8 px, side-by-side figures squeeze, and fixed `min-w` tables and SVGs clip. | `ConceptPage.tsx` `PAGE_GRID`, `Figure.tsx` `bleed` (`-mx-6` vs `-mx-12`) | all 19 | Keep prose at 66ch in cols 3–8, but let `Figure` and figure-bearing blocks span `content-start/full-end`, or at least cols 3–12 (~860 px). Restore `bleed`. This one change fixes most of the "tiny label", "squeezed side by side" and "clipped table" findings. |
| R2 | **Data encodings turned into texture.** Hachure and Stipple (`notebook/Ink.tsx`) replaced solid bars, density heat maps, class fills and dark plot grounds. Examples: viewport-inference heat map and confidence/factor bars; dem-anchoring pixel classes (5 classes as one hatch angle) and RangeCells photo overlay; terrain-sampler weight bars; baseline timing bar; camera-prior error bars buried in stipple; eye-rule blob dots. | pages, `Ink.tsx` | 15+ | Rule: **hatch decorates, fill encodes.** Value-carrying marks get a solid or graded tint (hatch may sit on top), class maps get distinct fills, and heat maps get a graded tint scale. Stipple only on non-data ground. |
| R3 | **`Stat` overflows.** 56 px numerals and a triangle glyph sit in `min-w-[120px]` cells, 4 per row, on a ~500 px column, so values wrap mid-number and overprint ("12 /\n12", "4.0° →\n0.22°"). | `viz/Section.tsx:41` (`Stat`), `Numbers` in `explain.tsx` | 43 uses, most pages | Container-query size (`clamp(26px, 9cqi, 40px)`), `white-space: nowrap`, `repeat(auto-fit, minmax(110px, 1fr))`, and no glyph inside figures. Keep 56 px for hero ledgers only. |
| R4 | **Selected chips are unreadable (red on red).** `TYPE.micro` includes `gb-coord`, and the unlayered `.gb-swiss .gb-coord { color: var(--gb-secondary) }` beats Tailwind's layered colour utilities. | `swiss/theme.css:100`, `swiss/type.ts:15` | skyline Fig 3/5, dem-horizon toggle, others | Move the `gb-coord` rule into `@layer components`, or drop its `color`. One-line fix. |
| R5 | **Real-data figures demoted into collapsed Details.** The headline evidence is now behind a click. | page files | rigi (`GuessVsSolved`), camera-roll (`RealRoll`), step-inside (`RealRange`), tap-a-peak (`MissBars`), peak (`HiddenRings`) | Move them back into the body, next to their new replacements where one exists (RollCompasses, RealSplit). Don't swap them back out. |
| R6 | **Imprint line on every photo.** "Aufnahme … · Revision … · Stich SVG" (three wrapped lines) sits under every Trio, Gallery and Compare thumbnail. | `viz/real.tsx` (`imprint = true` default) | all galleries and Trios | Default `imprint` to false inside Trio, Gallery, Stages and Compare, and keep one imprint per Figure caption. |
| R7 | **Overlay contrast on photos.** Measured lines became a 1-pass SketchPath with a paper halo instead of a crisp stroke with a dark under-stroke, and peak labels are ink with a paper halo. They read worse on bright sky and at thumbnail size. | `viz/real.tsx` `PhotoLine`, `PeakLabels` | photo figures, worst in thumbs | For lines drawn on photos use a crisp path (no wobble), a 4 px paper halo at about 0.55 opacity plus a thin dark under-stroke. Use deeper hues: magenta for prior, cyan or teal for solved, amber for skyline. Keep the hand-drawn style for furniture. |
| R8 | **Broken shared layout components.** `Flow` loses its node boxes and the arrows float. The HowItWorksScene embed is cramped, with a black void and overlapping labels. Readout tables wrap to one word per line. | `viz/Steps.tsx` (`Flow`), `site/how/HowItWorksScene.tsx` | camera-prior, viewport-inference, rigi, accept-rule, camera-roll | Boxed nodes, and a vertical layout below 560 px of container width. Container-query stacking for two-column figures. |
| R9 | **Page picker vs hard-wired figures.** The hero ledger follows the picked photo, but many figures are baked from demo-01, demo-03 or demo-09, so the sheet shows contradictory numbers (terrain-sampler: 1886.1 m in the hero vs 1,934 m in Fig 1). | pages, `tafel/sheets.tsx` | terrain-snapping, terrain-sampler, others | Drive the main figures from `useNotebookPhoto()`, or label them "fixed: demo-NN". |

## Outright bugs (not taste)

- `tafel/sheets.tsx:1526,1583`: `stat(d, "demPatch.halfKm", …, { unit: "km" })` scales by `UNIT_SCALE.km = 0.001`, but `halfKm` is already in km (20), so the ledger shows "0 km". This affects dem-source and terrain-snapping.
- peak: the visible-peak count is 260 in one place and 257 in another, and the Fig 2 hidden count (924) disagrees with the ringed summits drawn.
- Stale colour words in captions after the reskin: terrain-sampler Fig 4 says "White/Violet" for black and orange lines, and the tap-a-peak PinLock caption has the same problem.
- photo Fig 2 table: `min-w-[640px]` inside `overflow-x-auto` hides the heading and pitch/roll columns, which carry the page's point.
- baseline-pipeline Conveyor (`min-w-[620px]`) clips the confidence gate and the `refinePose` stages.
- eye-rule Fig 4: the "max rule" and "contour MAP" labels overprint.
- Unverified, low priority: SVG presentation attributes like `fill="var(--gb-paper, …)"` render in Chromium, but the design-book traps say other engines reject `var()` in attributes. Check in Safari and Firefox.

## Suggested order

1. R4 (one CSS rule), the `halfKm` bug, and R6 (imprint default): minutes, kit-only.
2. R1 (wide figure track) and R3 (`Stat`): kit and shell only, and they fix most of the illegibility on all 19 pages.
3. R5: move five figures back into the body.
4. R2 and R7: re-encode data marks (fill encodes, hatch decorates) page by page, following the cluster files.
5. R8 and R9, the remaining per-page items in the cluster files, and a re-shoot against HEAD.

Ownership at the time of writing: mt-image-2f holds ConceptPage, `tafel/**`, `viz/Figure.tsx` and `viz/explain.tsx`, and has paused its `pages/**` trimming sweep until this list arrived. Any page trims for the Tafel should remove a figure only where the Tafel shows the same real data at the same fidelity.
