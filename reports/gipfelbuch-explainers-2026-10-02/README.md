<!--
Rigi
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: Copyright (c) Rigi contributors
-->

# Gipfelbuch explainers, 2026-10-02

The user asked for this pass: "Gipfelbuch images need to have all the nice nuances of the homepage images (and beyond…) … the background is coordinated with the image … very deliberate about the overlays and their animation."

Seven Opus pods worked it, each running Sonnet implementers and reviewers, and the coordinator was session mt-image-0d. Each pod audited its explainer type against the landing page, wrote a spec, then ran two or more rounds of implementing, adversarial review and fixing. All of it is **browser-unverified**. Each spec carries a browser checklist, and `reports/batch-ledger.md` has the rows.

| Spec | Explainer type | Key commits |
| --- | --- | --- |
| [grammar.md](grammar.md) | **G**: the shared contract: motion tokens and beats, the overlay stack, the per-photo `--fig-*` ground palette, and the static, print and phone rules | d9b7320, b8e7fd9, 21ba3c0 |
| [P-hero-photo.md](P-hero-photo.md) | **P**: RealPhoto and GeoSpill: the hero bloom, the spill kept in step, ghosts, and the registration spec (≤ 0.17 px median at the frame edge) | 60e3a1f, b53dbca, 985cb14, 41ee02f |
| [S-photo-story.md](S-photo-story.md) | **S**: PhotoStory as one timed film (guess, measure, a continuous correction, snap) | d84004b … 1ca9c68 |
| [C-sequences.md](C-sequences.md) | **C**: Compare (direct-DOM drag, a play-once wipe), Stages (beat clock, crossfade, every state printed), Steps, Details | f21dfa9, 097d0b9, 5bb2c38 |
| [M-maps.md](M-maps.md) | **M**: StoryMap and SheetMap following the photo (cone, rays, inks, guess ghost) and the Tafel ground | 869335f, 3a4086e, c3596a7, 2c07aad |
| [D-diagrams.md](D-diagrams.md) | **D**: synthetic diagrams on real ground (the demo-09 scene bake), SketchSpill v2, 23 figures that play once | b3568d1, 5af6abd, 9a0746e |
| [L-live-and-tiles.md](L-live-and-tiles.md) | **L**: the margins of the live plates bloom with the photo and take its ground; Trio and Gallery tones | bde80ce, d659200, b4536b4 |

## Held back: peer-dirty lines; apply once those files are committed

- **C**: frame keys on baseline-pipeline, dem-anchoring, step-inside and tap-a-peak, plus `kind: "change"` on baseline-pipeline and eye-rule (C-sequences.md §11).
- **S**: `focus="snap"` on terrain-snapping's PhotoStory.
- **L**: drop `bleed` on rigi Fig. 4, the Gallery near line 569.
- **D**: the dem-horizon Fig. D1 caption and the "Why curvature" callout still say "invented terrain"; the replacement text is in D-diagrams.md.
- **M**: the index-route follow hunk (`src/routes/gipfelbuch.index.tsx`). Until it lands, SheetMap's follow code is dormant.

## Open decisions for the user

1. **Playback.** Sequences play once and replay on re-entry (grammar). Should Stages loop, and should the rigi hero loop as the landing does?
2. **The Compare intro.** Keep the one-time wipe from the guess to the split? The landing has none.
3. **Hero bloom by default.** It may flash the lines for one frame when a page loads with the hero already in view; it can be switched off in one line.
4. **Photo story.** Keep the guessed numbers faintly in the final frame? Is 12.9 s the right length (the landing scene runs 28 s)?
5. **Gallery.** Put the verdict circle on the photo or under it? Is "2nd solver" a caution or a plain result? Should galleries without a spill get a wide-track option?
6. **Diagrams.** Keep demo-09 as the one real ground, or follow the photo picker? Is a stated vertical exaggeration acceptable on a diagram? Is "no evidence after a change" too strict for methods that iterate?
7. **Maps.** DemPatch and SheetMap colour their DEM through an SVG ramp filter: keep it, or move the ramp into the bake ("never filter DEM rasters")? The guess ghost and the correction arc are two close reds: make the arc navy?

## Next

- One consolidated browser pass over the seven checklists, under the render lock, in light and dark, at 375 px and 1440 px. The highest-risk items are the hero bloom's first frame, the film's horizon meeting the spill at the frame edge, Stages crossfades, and the Trio grid on all 19 pages.
- Perf follow-ups: move the 23 settled `useTime` figures onto the shared clock (today they re-render at 30 fps until they leave the viewport), and make story `t` subscribable so RealPhoto and GeoSpill skip re-renders during the 1.6 s turn.
