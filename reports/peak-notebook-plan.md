# Peak notebook: bringing the landing's data accents into the Gipfelbuch

Status: plan, written 2026-10-01 by session mt-image-2f. **Direction committed the same day (§0).** No app code changed. A working prototype (three iterations) is in [`peak-notebook/prototype/`](peak-notebook/prototype/), and its screenshots are in [`peak-notebook/img/`](peak-notebook/img/).

**The ask.** The user said: *"look at the amazing aesthetic of the home page. we have great data driven accents here. the Gipfelbuch pages have a nice design identity but the actual implementation isn't as much of a banger. we want to bring both of these together for the design of the peak notebook."*

**The answer in one paragraph.** The Gipfelbuch keeps its identity: map paper, Landeskarte inks, print for form and hand for the observer, exact data under wobbly furniture. It takes three things from the landing page:

1. **Scale.** One real photo per sheet is shown big and wide, not inside a 700 px column.
2. **Data that carries past the frame.** The terrain's ridgelines, the compass ruler and the peak names continue beyond the photo's edges onto the paper, as on a summit's *Panoramatafel*. This is the landing's `Surround` and `LiveLines` idea, re-inked for paper.
3. **Restraint around the data.** There are few chrome elements, one accent per figure, and large measured numbers.

The bridge is already in the palette. The landing's single accent, `--rigi-glow`, is Brezine **YB**, a light yellowish brown. On paper, the terrain ink is **NB**, a strong yellowish brown. They are the same role, terrain, at night and by day. So the dark landing is the notebook's *night sheet*, and the two can share one set of role tokens.

**How this relates to the design book.** [`gipfelbuch-design-book.md`](gipfelbuch-design-book.md) (session mt-image-44, being implemented now) is the base system for grid, type, ink, line, terrain and print. This plan does not re-decide any of it; where the two touch, the design book wins. This plan adds one layer the design book doesn't cover: **page composition, scale and the data-driven accents**. In design-book terms:
- The *Tafel* hero is each sheet's **G8 "one deliberate exception"**.
- The Tafel makes **P5's "panorama strip with compass ring"** concrete and moves it earlier.
- Its decided night/day rule (§0, D-PN1) is design book **D3** as written: the paper stays light, and dark appears only around live content.

---

## 0. The committed direction

The four open questions (D-PN1–D-PN4) were settled on 2026-10-01 in two steps. First came a second prototype round (v4 and v5) that renders every option on the design book's real tokens and fonts (Source Serif 4, Fira, Fira Mono and the 11/13/16/20/24/40/56 scale). Then came three independent critiques, one per question, by reviewers who were not shown the recommendations. The evidence is in `peak-notebook/img/d1-*` to `d4-*` and `final-*`. The rig is `peak-notebook/prototype/sheet.html?theme=…&title=…&size=…` and `index.html?id=demo-NN`.

**The direction in one paragraph.** Each sheet stays a paper page, light in both site themes. It opens with the sheet name at 56 px, then the claim as a serif italic dek, then three measured numbers. Under that sits the *Tafel*, full bleed, on a quiet **plate** (the existing `--gb-paper-deep`, per the softer-sheet amendment below): the photo band with its measured layer, its terrain carrying past the frame in engraved brown ink, and a compass ruler and peak names. Dark appears only where something is live (Step Inside, a live 3D view). The index keeps the `SheetMap` hero. Below it, a one-photo picker drives a *Blattübersicht* of 19 sheets, set in data-flow order along a trail. Every band has its own visual form, so the index reads as small multiples of one photo's run.

![The committed sheet](peak-notebook/img/final-sheet.jpg)

### Amendment: a softer sheet (user, via mt-image-3b, 2026-10-01)

After the decisions below, the user asked for a softer Gipfelbuch: no paper texture and no full notebook look, but keep a soft grid. mt-image-3b has already changed the tokens:
- `--gb-grain: none`;
- `--gb-paper` is W 96% + YY 4%, and `--gb-paper-deep` is 91/9;
- the notebook grid is fainter;
- the red margin rule, tape, print tilt and graticule margin ticks are removed.

This plan follows that. Where it conflicts with anything below, the amendment wins:
- **The plate is the existing `--gb-paper-deep` (91/9), not a new mid-tone token (LG 38%).** It still marks the Tafel as a plate, but quietly. Spill and label contrast are then checked against `--gb-paper-deep`. There is no new `--gb-plate` token.
- **No grain, tape, tilt or margin rules** anywhere in the Tafel, the Ledger, the Multiples or the index cards. The grid stays soft and only behind the page.
- **The Blatt number is plain:** red mono "Blatt 10 / 19", with no hand-drawn circle around the number. The index cards use the same plain number.
- **The hand stays rare:** at most one annotation per figure and the ledger note, as before. The chapter field-notes line on the index is set in the body face in the measure ink, not in the hand face.
- **The index trail becomes a thin solid route-red rule:** 1 px, with a step number at each card. It is not the 3 px red-white dashed band from v5.

 → **paper sheet; the Tafel is a plate; dark only where live**

| Option | What it is | Reviewer score (identity / impact / cohesion / legibility) | Verdict |
| --- | --- | --- | --- |
| A, day (`d1-a-day`) | everything paper, spill in brown | 6 / 5 / 6 / 6 | Kept as a base. The spill was too faint, at about 1.5:1, and the v4 rig had lost the notebook furniture. |
| B, band (`d1-b-band`) | header paper, Tafel a night island | 7 / 8 / 8 / 8 | The reviewer's top pick, but only on condition the band is *live*. As a static band it breaks the design book's rule (night only for live views) on all 19 sheets. Repeated, it becomes black chrome, and in the light theme it reads as an embedded video player. |
| C, split (`d1-c-split`) | header and Tafel night, body paper | 5 / 9 / 9 / 7 | Above the fold it is pixel-identical to D, so the notebook starts below the fold. The hard seam jolts on a phone. |
| D, night (`d1-d-night`) | everything dark | 3 / 8 / 9 / 7 | Rejected. Nothing Swiss is left. |
| A2, day strong (`d1-a2-day-strong`) | A with the spill bake at full strength, graph paper and the circled Blatt number restored | — | The spill now reads as an engraved panorama. The identity is back. |
| **E, plate (`d1-e-plate`, `final-sheet`)** | A2, with the Tafel printed on a mid-tone plate ground (LG 38% into W) and darker terrain ink (NB toward DB) | — | **Chosen.** |

**Why E.**
- **The plate gives the Tafel a destination.** That is the landing's dark frame doing its job, but without leaving paper. A separately printed panorama plate tipped into a book is a real Swiss practice (the Imfeld and SAC panoramas), so it passes the design book's kitsch test (F6): it records a practice, not a defect.
- **Night islands keep their meaning.** Dark means "this is live", so the Step Inside and live roll views earn their contrast. This is the reviewer's "earn the island", reached without forcing 19 static Tafeln to become live engines.
- **It follows the design book.** It complies with D3, and the reviewer's "don't make it theme-dependent" holds: one look in both themes.

**Rejected:**
- The deckle edge on the band seam (`d1-b-band`) is a torn edge, which F6 bans.
- Split and night: see the table.
- Theme-following: two looks depending on the visitor's OS.

### D-PN2: title size → **56/60 desktop, 40/48 phone, never off-scale**

| Option | Score | Finding |
| --- | --- | --- |
| 40 (`d2-claim-40`) | 5 | The title is no bigger than the ledger numbers, so "730" wins the eye. |
| **56 (`d2-claim-56`)** | 8 | Two lines, with the eyebrow aligned to the ledger top. Balanced. |
| 72 (`d2-claim-72`) | 4 | Off the scale. The ledger floats loose and the title fights the photo. |

56 already exists in the scale (the stat role). This plan asks mt-image-44 to name it **`display`** and allow it for the sheet H1, so no new size is added. Title (serif 600) and stat (sans 300) are told apart by face and weight. The lead paragraph is capped at 640 px (about 70 characters). The reviewer also noted the landing's H1 at 48 px is off this scale. That is landing-owned; flagged in §16, not changed here.

### D-PN3: claim or name → **name as H1, claim as the dek**

- **H1** is the concept name in display spelling: "Terrain Sampler", not `TerrainSampler`. The `rigi` sheet needs a name other than the brand, for example "Rigi in one sheet".
- **Dek** is the claim, one sentence of at most about 60 characters, in Source Serif italic at 24/30 (20/24 on a phone). It replaces today's sans italic tagline.
- **Eyebrow** is `Blatt ⑩ / 19 · Evidence`, with no name repeated.
- **`<title>`** is `Skyline Detection · Gipfelbuch · Rigi`. The meta description is the dek plus the first body sentence.

Why not the claim as H1, which was this plan's first recommendation and is the better-looking single page (`d2-claim-56`)?
- **Wayfinding.** The signposts and the index show names, so you click "Skyline Detection" and would land on a slogan.
- **Search.** People search for "skyline detection".
- **It doesn't generalise.** The reviewer's claim test for five sheets went twee on the infrastructure ones ("Where the work happens."). Nineteen aphorisms in a row read like a slide deck.

With the dek, the voice survives and costs only one serif line (`final-sheet`). Most deks already exist as Beat titles: "The compass guesses. The ridge does not.", "A wrong pose is worse than no pose.", "Far ridges are the fingerprint.", "A day of photos is a place, not a pile." A new `claim` field on `GipfelbuchNode` holds them, for each page owner to write.

### D-PN4: index → **replace `NotebookMap` with a *Blattübersicht*, but only in the follow-one-photo form**

| Version | Finding |
| --- | --- |
| v4 own photo (`d4-own-*`) | Variety, but the thread is lost. Semantic marks land on faces (the Accept Rule ✗ on a face). It reads like a blog index. |
| v4 follow (not kept) | Coherent, but one lake twelve times. Three DEM tiles are identical. The ✗ on Accept Rule contradicted "accepted 0.79". |
| **v5 (`d4-v5-*`)** | Follows the picked photo. Bands in data-flow order on a red-white trail, steps I.1–III.4. **One visual form per sheet:** compass for the prior, a 360° strip with the frame shaded for the DEM horizon, residual bars for the pose, a confidence rail with all 12 photos for the accept rule, a stage timing bar for the pipeline, zoom rings, a sample cell and a view cone for the three DEM sheets, a metre-scale section for the eye rule, a log-distance profile for anchoring, a split wipe for the workspace and a heading rack for the roll. A field-notes line per chapter keeps the `NotebookMap`'s chained numbers ("compass said 251.4°, terrain said 260.7°, shown at 0.79"). |

The `NotebookMap`'s best idea, one photo followed through numbered, chained steps, survives as the picker plus the trail plus the chapter lines. Its text list does not. The reviewer's strongest counter-argument was "an index needs only names and numbers; the bands add 19 renderers that drift". It is answered by making the bands the **same `layer` functions the Tafel uses** (§7.1), so there is one renderer per sheet, not two, and the `tafel` check covers them.

**Numbering.** Blatt numbers follow `GIPFELBUCH_NODES` order, which is not reading order (chapter I runs 04, 05, 10, 11, 02, …). Decided: **reorder `GIPFELBUCH_NODES` to data-flow order, so Blatt *n* is the *n*-th sheet you read.** The chapter step (I.3) then becomes redundant. This is a one-line data change, but it renumbers every sheet, so the owners (bd, mt-image-44) should land it.

### Implementation traps the prototype found

1. **Role aliases must be re-declared in every theme scope.** `--gb-peak: var(--gb-navy)` on `:root` resolves there, so a night island that redefines `--gb-navy` still gets the day navy. Declare the aliases on `.gb-swiss` *and* on `[data-theme="dark"]`.
2. **Don't paste a resolved `color-mix()` string into an SVG attribute.** In the v4 rig, reading a token with `getPropertyValue` and writing that raw `color-mix(…)` text into `fill` rendered black. `fill="var(--gb-x, #hex)"` attributes are fine; the kit already uses them, as mt-image-44 confirmed, provided the variable is defined in that scope. For mixes and canvas, prefer `style` or `currentColor`, or resolve through `getComputedStyle` as `LiveLines` does.
3. **Paper needs its own spill bake, not the landing's.** The landing's light strokes used as a mask reach only about 1.5:1 on paper unless stacked 4×. Bake the paper mask with an alpha floor, so the faintest ridge clears 3:1 against the plate (design book A7 for meaningful marks), and keep depth in width as well as alpha.
4. **The ground tint under the spill needs a vertical fade.** The bake's below-skyline fill stops in a hard edge at the canvas bottom (`d1-a-day`, y≈885).
5. **Phone.** Peak labels must clear the ruler. Push the band below the ruler plus two label tiers, and clamp labels by their *text width* inside the viewport. The ledger becomes a 3-up row of 24 px stats.
6. **Legend truth.** The caption must name the colours actually drawn (teal line plus amber ticks). The reviewer caught "blue" against a teal line.



0. [The committed direction](#0-the-committed-direction)
1. [What we looked at](#1-what-we-looked-at)
2. [Why the landing works](#2-why-the-landing-works)
3. [Why the Gipfelbuch is not yet a banger](#3-why-the-gipfelbuch-is-not-yet-a-banger)
4. [Principles of the merge](#4-principles-of-the-merge)
5. [Design iteration log](#5-design-iteration-log)
6. [The sheet anatomy](#6-the-sheet-anatomy)
7. [Signature components](#7-signature-components)
8. [Tokens: one set of roles, two sheets](#8-tokens-one-set-of-roles-two-sheets)
9. [Motion and interaction](#9-motion-and-interaction)
10. [Data and bakes](#10-data-and-bakes)
11. [The index](#11-the-index)
12. [Phased plan](#12-phased-plan)
13. [Verification](#13-verification)
14. [Decisions for the user](#14-decisions-for-the-user)
15. [Risks](#15-risks)
16. [Coordination and ownership](#16-coordination-and-ownership)
17. [References](#17-references)

---

## 1. What we looked at

| Source | What was done |
| --- | --- |
| The running app (`:3100`, WebGPU) | Viewport screenshots at 1440×900 of `/`, `/gipfelbuch`, `/gipfelbuch/skyline` and `/gipfelbuch/pose-estimate`, plus 390 px phone shots. Taken through the render lock. |
| Landing code | An audit of `src/routes/index.tsx` and `src/components/site/**`, covering `Surround`, `LiveLines`, `RevealLoop`, `TopoBoard`, `FadeIn`, `NearViewport`, the bakes in `scripts/demo/bake-surround*.ts` and `bake-live-lines.ts`, and the light-theme mechanism in `src/styles.css`. |
| Gipfelbuch code | An audit of `ConceptPage`, `viz/explain.tsx`, `notebook/**`, `swiss/**` and all 19 pages: their structure, counts, dead code and weak spots. |
| Earlier reports | `gipfelbuch-design-book.md` (§7–§8, §15–§17, §20–§21 read closely), `gipfelbuch-swiss-aesthetic.md`, `gipfelbuch-notebook-research.md` and `explainer-research.md`. |
| External references | Scrollytelling and explorables (Ciechanowski, The Pudding, Snow Fall, Distill, NZZ Visuals), tasteful sketch styles (Nicky Case, Maggie Appleton, rough.js), Swiss panorama drawing (Imfeld, Berann, the *Panoramatafel*), dark/paper pairings, and scroll-driven animation support. These came from a research subagent. Only the browser-support claims were checked live, so treat the other links as **[U]** until opened. |
| Prototype | Three iterations of a standalone HTML sheet for *Skyline detection*, built only from measured data (`public/demo/gipfelbuch/*.json`) and the landing's demo-01 surround bake. Rendered in day, night and split themes at 1440 px and 390 px. |

## 2. Why the landing works

Evidence: [`img/ref-landing-hero.jpg`](peak-notebook/img/ref-landing-hero.jpg) and [`img/ref-landing-story.jpg`](peak-notebook/img/ref-landing-story.jpg).

1. **The data leaves the frame.** `Surround.tsx` lays baked ridgelines beyond the photo's edges, plus a compass ruler and peak names with elevation and distance. The strokes are traced from the photo's own eye and projected through its solved camera (`scripts/demo/bake-surround.ts`), so each ridge leaves the photo exactly where the real ridge does. This one device makes every figure feel *measured*, not illustrated.
2. **Depth is encoded in ink.** There are 8 distance buckets. Ridge alpha runs `0.85 − 0.5d`, ridge width `(1.3 − 0.6d)`, and slopes are fainter still. Far is lighter and thinner. This is the Imhof aerial-perspective rule applied to lines.
3. **Scale.** The hero photo is about 610 px wide in a 5/7 split. The story photo and the 3D views take the full 1088 px column or the full bleed (`w-[calc(100vw-12px)]`). Text never competes with the image at the same size.
4. **One accent.** The palette is `--rigi-glow` plus paper at a stepped alpha ladder (90 → 35). Cardinals on the ruler are the only coloured text inside a figure.
5. **Quiet, fixed type.** An 11 px mono eyebrow with 0.18 em tracking, then the headline, then one 15 px paragraph, then the figure. Every section has exactly this rhythm (`Story`, `index.tsx:361`).
6. **It runs live, and it's honest about it.** The live roll map, Step Inside and `LiveLines` re-project the baked lines through the live camera at 30 fps. Heavy pieces mount only when near the viewport (`NearViewport`) and pause offscreen.
7. **Strong default theming.** The `--color-white` swap re-inks every alpha utility, and `data-theme="dark"` islands keep imagery dark in the light theme.

**What the landing gets wrong** (and what not to copy):
- The surround strokes are baked light and use `light:invert`. That gives a cool blue-black, not brand LK. The map variant does it correctly, as a grey coverage mask tinted with a token. Do the same here.
- The type sizes are arbitrary.
- Paper colours are duplicated as literals (`236,230,218`).
- Reduced-motion handling is uneven across components.

## 3. Why the Gipfelbuch is not yet a banger

Evidence: [`img/now-skyline-head.jpg`](peak-notebook/img/now-skyline-head.jpg), [`img/now-skyline-body.jpg`](peak-notebook/img/now-skyline-body.jpg) and [`img/now-index-notebook.jpg`](peak-notebook/img/now-index-notebook.jpg).

| # | Problem | Evidence | Effect |
| --- | --- | --- | --- |
| 1 | **The figures are small.** The article column is capped near 760 px beside a 250 px rail. `Figure` pads `p-5 sm:p-8`, and `bleed` adds only 24 px each side. | `ConceptPage.tsx:375-420`, `viz/Figure.tsx` | The real photos, which are the most striking material we have, show at about 680 px. Nothing on a sheet is as big as the landing's smallest figure. |
| 2 | **The hero is chrome, not data.** Above the fold there are a breadcrumb, a kicker, the H1, a tagline, a chip row (group, Waymark, kind, ontology), a hand rule, "Eintrag", the lede and a FieldNotes strip. The first real photo starts below the fold. | `img/now-skyline-head.jpg` | About 12 furniture and meta element types surround the body. The data loses the first screen. |
| 3 | **The sticky rail is metadata.** Status, Domain, Technical summary, Code and Reports stay pinned beside every Beat. | `ConceptPage.tsx:421-470` | Reader-facing space is spent on developer facts, the opposite of the landing's single-subject sections. |
| 4 | **Data stops at the frame.** No Gipfelbuch figure continues past its photo, even though `public/demo/gipfelbuch/*.json` holds `horizon.profile` with ridge crests for ±15° beyond each frame. | data audit | The signature landing device is missing exactly where it would explain the most. |
| 5 | **The slab look.** Every figure is a `paper-deep` slab with a tape strip. Trio cards are three more slabs. | `img/now-skyline-body.jpg` | It reads as a document of boxes, not a sheet with drawings on it. |
| 6 | **Small and faint labels.** About 200 labels are below 11 px (`text-[11px]` ×103, `[10px]` ×35, `[9px]` ×15). About 180 text uses sit below 4.5:1 contrast. 187 `HandText` call sites put tick and value labels in the hand. | grep counts; design book §17 | Hierarchy flattens and nothing reads as a hero number. |
| 7 | **The structure is uniform.** All 19 pages run the same Hero → Beats → Trio → Gallery → Numbers → Details. Nine heroes are `HeroStages`. | page audit | Every sheet has the same cadence, so no sheet has a peak moment. |
| 8 | **Mechanism figures fall back to synthetic scenes.** For example, the 120×64 sinusoid in `skyline.tsx` Fig. 3. | `pages/skyline.tsx:55-110` | The "real data" promise holds for heroes, not for the explanations. |
| 9 | **The index has two competing heroes.** `SheetMap` (strong) sits above `NotebookMap` (a text list in a notebook skin). | `img/now-index-notebook.jpg` | The best image, the real Niederhorn sheet with 12 view cones, is not connected to the entries below it. |
| 10 | **Live filters and dead code.** `PencilFilter` sits on 2400-unit groups. `nb-wobble` and `nb-grain` are defined but unused. About 1,840 lines of graph code have no importer. | `swiss/PencilFilter.tsx`, `notebook/Ink.tsx:467-530` | Soft lines on retina, repaint cost and noise in the kit. (The design book already plans fixes, §17 #15–16.) |

**What is already strong and stays:**
- the paper and the Brezine inks with Ascher codes;
- the real Niederhorn `SheetMap`;
- the seeded sketch engine with its 0.9 px data tolerance;
- "print is the form, the hand is the observer";
- `Measured` provenance;
- the `Compare` wipe on real photos;
- claim-as-headline Beats;
- the lazy page glob with `PageBoundary`.

## 4. Principles of the merge

These sit on top of the design book's §7 principles, without replacing them.

- **M1. One big real thing per sheet, first.** The first screen is a title, a one-sentence claim, three measured numbers and the Tafel. Metadata moves to the colophon.
- **M2. Data carries past the frame.** Every hero photo continues into its terrain: ridge strokes, the skyline, peak names and the compass ruler, all projected through the solved camera. Inside the frame the photo's measured layer shows (here, the detected skyline). Outside it, the model's prediction carries on. The seam is the claim. On demo-01 the projection of `horizon.profile` lands on the detected `solvedRows` with a median error of −0.01 px (p10 −0.25, p90 0.16), checked in the prototype (`proj.check`), so the seam is exact.
- **M3. Paper is the ground, and the ink does the work.** No slabs. A figure is drawings on the sheet, separated by space (design book G9). `paper-deep` is kept for interactive wells, such as a picker or a stepper, where a ground carries the state.
- **M4. Big measured numbers.** Each sheet gets a *Ledger*: two to four values set in the design book's `TYPE.stat` role (GB Sans 300, tabular lining, 40/56), each with a two-line label. The hand annotates the ledger once ("re-read from the run on this photo"). Hand-written digits are never a value.
- **M5. One accent per figure.** Terrain ink carries the spill, measure ink (GL) the image-measured line, and route red the single answer or failure. Peak names are PB navy by day and paper by night.
- **M6. Vary the cadence.** Each sheet has one *peak moment*: the Tafel, a sticky scrolly, or a live view. The other beats stay quiet. Uniform Trio, Numbers and Gallery blocks become optional.
- **M7. Paper always; dark means live.** The sheet is paper in both site themes. The Tafel is a mid-tone plate, not a dark band. Night islands, which share the roles and are re-inked rather than inverted (§8), appear only around something live: Step Inside or a live 3D view. Decided in §0.

## 5. Design iteration log

The prototype is `reports/peak-notebook/prototype/index.html`; run it as described in §13. All values are measured: demo-01 skyline rows and weights, the solved pose, `horizon.profile`, the peaks with distance and elevation, and `ms.skyline`. The spill strokes are the landing's `public/demo/surround/demo-01.webp`, used as a luminance mask and filled with the terrain ink.

### v1: first pass

[`img/v1-day-hero.jpg`](peak-notebook/img/v1-day-hero.jpg)
- Layout: hero 7/4 (title and claim, then a ledger), with a full-bleed Tafel under it.
- The DEM skyline and ridge chains were computed in the browser from `horizon.profile`.
- Leaders ran from a label row above the photo down to each summit.

**Problems found:**
- The spill was sparse. The profile's ridge crests chain into only a few lines, while the landing's traced bake is far richer.
- The full 4:3 photo dominated the page.
- Long white leaders cut through the sky.
- Labels collided, because only the name width was checked and not the "2362 · 12 km" line under it.
- The gap annotation sat under the frame, far from the gap.

### v2: the landing's spill, panoramic band

[`img/v2-day-hero.jpg`](peak-notebook/img/v2-day-hero.jpg), [`img/v2-night-hero.jpg`](peak-notebook/img/v2-night-hero.jpg), [`img/v2-split-seam-fig1.jpg`](peak-notebook/img/v2-split-seam-fig1.jpg) and [`img/v2-day-multiples.jpg`](peak-notebook/img/v2-day-multiples.jpg)
- The spill now uses the baked ridge strokes as a mask in terrain ink. It is dense and depth-faded, and reads as an engraved panorama drawing on the paper.
- The photo is cropped to a **panoramic band** (working rows 120–455, about 2.4:1). The format alone says *Panoramatafel*.
- The confidence ticks hang under the detected line, so 730 votes are visible at once.
- The red pen circle marks the 41-column glare gap.
- Labels use two tiers.
- The **split theme** is added: a dark hero island over a paper body. It works: the top of the sheet *is* the landing, and the seam reads as turning from the night view to the field book.
- Fig. 1 aligns the photo band with a hachured weight strip, column for column.
- The failure gallery is four real cases with tone-coded tags: Haze, Rejected, Occluder, Rescued.

**Problems found:**
- In-photo labels were too many and smudged by stroke halos.
- The spill was faint at the outer edges.
- The glare note crossed the photo with a long arrow.

### v3: restraint

[`img/v3-day-hero.jpg`](peak-notebook/img/v3-day-hero.jpg), [`img/v3-split-hero.jpg`](peak-notebook/img/v3-split-hero.jpg), [`img/v3-phone-hero.jpg`](peak-notebook/img/v3-phone-hero.jpg) and [`img/v3-phone-seam.jpg`](peak-notebook/img/v3-phone-seam.jpg)
- The photo shows at most 6 labelled peaks on desktop and 3 on a phone. Spill labels appear only on desktop, which matches the landing's `hidden md:block`.
- Photo labels use a soft text shadow, as the landing does. Paper labels use a paper halo.
- The spill strength is doubled.
- The glare note is a short white pen arrow inside the sky.
- Phone: the hero stacks, the ledger runs after the claim, and the Tafel becomes the photo band alone.

**Still open, for the real build:**
- Ticks, stroke widths and label sizes must scale with the rendered width. The phone ticks are too tall, so use the design book's `cqi` floors.
- The ruler should show fewer labels below 600 px.
- The title face follows design book D1, which mt-image-44 has since decided: Source Serif 4, self-hosted as the scoped "GB Serif" through `--gb-font-*`. The prototype uses Fraunces, and the composition doesn't depend on the face.
- Hero H1 size: see D-PN2.

**Verdict at v3** (superseded): v3 met M1, M2, M4 and M5, and the split looked best. The v4 and v5 round in §0, run on the design book's real tokens with independent reviews, overturned this in favour of the paper sheet with a plate Tafel.

### v4 and v5: the decision rig

See §0. v4 renders every option on the real type scale and fonts. v5 adds the follow-one-photo index with one form per sheet. The committed sheet is `img/final-sheet.jpg`, `final-sheet-body.jpg`, `final-phone.jpg` and `final-phone-seam.jpg`.

## 6. The sheet anatomy

Target layout for every concept page. It uses the design book's named-line grid (G6): `full`, `feature`, `content` and `margin`.

```
┌ full ─────────────────────────────────────────────────────────────────────┐
│ [paper; soft grid; plain red Blatt number; no grain/tape/margin rule]     │
│  nav (paper on paper, or night)                                           │
│ ┌ content ───────────────────────────────┐ ┌ margin ──────────────┐       │
│ │ BLATT ⑩/19 · EVIDENCE (caps)          │ │ 730 / 800  columns   │ Ledger│
│ │ H1 name (56/60 · 40/48)               │ │ 2.7 px     miss      │       │
│ │ dek: claim, serif italic 24/30        │
│ │ lead ≤ 640 px (18/30)                 │ │ 180 ms     CPU       │       │
│ └────────────────────────────────────────┘ │ hand: re-read from…  │       │
│                                            └──────────────────────┘       │
│ ░░ plate ground (--gb-paper-deep, full bleed) ░░░░░░░░░░░░░░░░░░░░░░░░░ │
│  ─── compass ruler (graticule), cardinals in route red ──────────────     │
│  ridge spill ░░░ [ photo band 2.4:1 with measured layer ] ░░░ ridge spill │
│        peak names + ele · km, leaders            hand notes in margin     │
│  caption: place · date · claim       provenance (Aufnahme/Revision/Stich) │
├───────────────────────────────────────────────────────────────────────────┤ ← plate ends (straight cut)
│ Beat 01  [sticky text 4 col] │ [figure 8 col, aligned to the Tafel band]  │
│ Beat 02  failure multiples, 2-up, real cases, tone-tagged                 │
│ Beat 03  (optional) mechanism figure on real data, equation (math.tsx)    │
│ Details (collapsed): the old dense prose and code identifiers             │
│ Signposts ← Blatt 09 · Blatt 11 →   (big serif, paper-deep wells)         │
│ Colophon: status · code · reports · ontology · measured-on · imprint      │
└───────────────────────────────────────────────────────────────────────────┘
```

What moves where, compared with today's `ConceptPage`:
- Breadcrumb, group chip, Waymark, kind and ontology link go into one caps eyebrow line. The Waymark can stay as a 12 px glyph in it.
- Rail (Status, Domain, Technical summary, Code, Reports) moves to the **colophon** at the foot. Technical summary moves into `Details`.
- The `Standortfeld` and `Eintrag` block is dropped; the eyebrow says it.
- `FieldNotes` (the photo picker strip) moves under the Tafel caption as the Tafel's own picker: "follow another photo". It keeps the shared `useNotebookPhoto`.
- `ContourField` page-header contours are removed. The Tafel's spill is the header's terrain now, and it is real.
- The `SheetFrame` neatline and graticule ticks become *one* compass ruler inside the Tafel. LV95 corners and the Blatt box move to the colophon imprint. This follows design book F1: furniture must be true, and the Tafel's ruler is true.
- Connections (`NodeCard` groups) turn into the two signposts plus an "also on this route" line in the colophon.
- Footer `Legend` and `ScaleBar` follow design book F1: per-page and true, or removed.

## 7. Signature components

These are new kit pieces in `src/components/gipfelbuch/` (paths are proposals). Each is built once and used by all 19 sheets.

### 7.1 `Tafel`: the panorama table hero

```ts
<Tafel
  photo="demo-01"                 // GipfelbuchPhotoData via useGipfelbuchPhoto
  band={[120, 455]}               // working-frame rows to show (auto from skyline if omitted)
  layer={(d, px) => <svg …/>}     // the sheet's measured layer, in working px (skyline, prior/solved, peaks…)
  notes={[{ at: [col, row], text: "glare: 41 columns abstain", tone: "route" }]}
  maxPeaks={6}
/>
```

**Geometry.** One projector, the same pinhole the prototype uses: yaw, pitch, `roll`, `f` from `solved`, `(az, el) → (x, y)` in working px. It is validated against `solvedRows`. Ruler ticks are `az` every 5°, labelled every 15°, with cardinals in route red.

**Spill.** A baked luminance mask per photo (§10), tinted with `--gb-terrain` through CSS `mask-image`. The prototype uses an SVG `<mask>`; `mask-image` is cheaper. It fades over the outer 40% of each side (the landing's mask maths). The photo rect is cleared in the bake.

**Peaks.**
- Greedy placement by elevation, collision-checked on the wider of the name line and the sub line, in two tiers.
- At most `maxPeaks` inside the frame (`labelled` only) and 8 in the spill.
- Name in the `caption` role (13 px) semibold. The sub line `{ele} m · {km} km` is in the `micro` role (11 px, GB Mono). Use the design book's TYPE roles only (`swiss/type.ts`: 11/13/16/20/24/40/56), with no new sizes and no inline font names. Fonts come from classes and `--gb-font-*` tokens.
- Leaders are 0.8 px; they count as furniture. Any line that carries data, such as the skyline or the spill skyline, is at least 1.2 px (design book L2). A dot sits on the summit.

**Theme.** Inks come from tokens through `currentColor` and CSS variables. There are no light-baked strokes and no `invert`.

**Responsive.**
- At 720 px and up: a full bleed with spill and spill labels.
- Below 720 px: the band at full width, at most 3 labels, and the ruler thinned to labels every 30°. Rendered stroke and tick sizes take `px × (renderedWidth / 800)` with floors.

**Accessibility.** `role="img"` with a title and a description generated from the data ("Skyline detected in 730 of 800 columns; peaks: Niesen 2362 m, …"). Numbers stay as HTML in the ledger and caption.

**Perf.** No live SVG filters. The spill is one masked element. Labels and paths are memoised per width bucket. The picker swaps `photo` without remounting.

**Variants per sheet.** The `layer` prop decides what the Tafel shows inside the frame. That keeps the device uniform while each sheet's claim differs:

| Sheet | Inside the frame | Outside |
| --- | --- | --- |
| skyline | detected line + confidence ticks | DEM ridges |
| dem-horizon | the DEM skyline (solved) | DEM ridges, distance-coloured |
| camera-prior / viewport-inference | prior (dashed) against solved skyline, Δyaw arrow on the ruler | ruler shows prior and solved headings |
| peak / tap-a-peak | labelled peaks with leaders | spill peaks |
| pose-estimate | residual ticks per column | — |
| accept-rule | inlier/outlier columns, confidence | — |
| eye-rule / dem-anchoring / terrain-snapping | eye height bar and ground line | side section (see 7.4) |
| camera-roll | — | 12 frames placed by solved heading on one ruler (the landing panorama, on paper) |
| step-inside | `StepInsideDemo` poster in a night island | — |
| photo / photo-workspace | EXIF marks on the photo | — |
| rigi | the landing hero pair (`Compare` photo ↔ overlay) | full spill + names |

### 7.2 `Ledger`

Two to four measured values: `{value, unit, label, from}`. Values use `TYPE.stat`. If a mono stat is wanted, ask mt-image-44 to add one role rather than inventing a size. Units and labels are in `--gb-secondary` (solid BG) at the `caption` role, on two lines. Then one hand note at most. It sits in the margin track on desktop and after the claim on a phone. Values must come from the JSON; `notebook.check.ts` can assert that every ledger value is a field path, not a literal.

### 7.3 `Beat` v2: the sticky beat

The text column (4 of 12) is `position: sticky; top: 96px`, with the figure on 8 columns. A figure that shares the Tafel's photo uses the **same band and column scale**, so the eye carries over (Fig. 1 in the prototype). An optional `steps` prop turns the figure into a scrolly: each paragraph in the text column sets a figure state, driven by `IntersectionObserver` and never by scroll position maths. On a phone the text sits above and the steps become buttons.

### 7.4 `Multiples`

Two-up real cases, each cropped to the skyline band. Each has a tone-tagged caps label (result `--gb-forest`, failure `--gb-red`, neutral `--gb-secondary`), the measured value in mono and a one-line hand note. This replaces `Gallery` slabs.

### 7.5 `MarginNote` and `PenMark`

Hand notes that anchor to a point in a figure. They use CSS anchor positioning where supported (design book H6), with an SVG fallback. A note is the observer's voice: short and never a number on its own. `PenMark` is the circle, bracket or arrow from `Ink.tsx`, with seeds as today.

### 7.6 `Signposts` and `Colophon`

Signposts are the two big serif links in paper-deep wells; that ground carries the hover and focus state. The colophon is one mono line group carrying:
- status (a Waymark glyph);
- code paths and reports;
- the ontology link;
- the *Siegfried imprint* (design book F2): Aufnahme demo-01 2026-09-07 · Revision `build-data.ts` 2026-10-01 · Stich Rigi;
- the LV95 sheet corners.

## 8. Tokens: one set of roles, two sheets

Pages and the kit name **roles**, never inks. Per design book I1 there is **no alpha ladder**: text is `--gb-ink`, `--gb-secondary` (solid BG) or a semantic ink. The role names below are **aliases** of the existing tokens (`--gb-terrain` → `--gb-contour`, `--gb-measure` → `--gb-water`, `--gb-route` → `--gb-red`, `--gb-peak` → `--gb-navy`, `--gb-result` → `--gb-forest`), and the originals keep their names. The prototype's `--ink-2`/`--ink-3` alpha greys were a shortcut and are not carried over. The design book's I1 table sets the exact day values and their contrast; this plan adds the night column. All are Brezine swatches.

| Role | Day sheet (paper) | Night sheet (landing) | Used for |
| --- | --- | --- | --- |
| `--gb-paper` | W 90% + YY 10% | LK `#131313` | ground |
| `--gb-paper-deep` | paper 82% + LG | LK 88% + LC | interactive wells only |
| `--gb-ink` | LK | W | text, axes |
| `--gb-ink-2` | BG `#4a545c` | W 62% on LK | secondary text |
| `--gb-terrain` | NB `#95500c` | **YB `#bb8b54`** (= landing `--rigi-glow`) | DEM, ridges, contours, kickers |
| `--gb-measure` | GL `#30626b` | GL 45% + W | image-measured lines |
| `--gb-route` | SR `#bf2233` | SR 75% + W | the answer, cardinals, failures |
| `--gb-peak` | PB `#002f55` | W | peak lettering |
| `--gb-result` | GG `#575e4e` | PG `#8d917a` | accepted, results |
| on-photo | `#fff` with a soft shadow; skyline GL with a white halo; confidence SY `#e59e1f` | same | overlays never re-ink with the theme |

**Scope (decided, §0):** the paper sheet stays light in both site themes (design book D3). The night column is used only inside night islands around live content: Step Inside, a live roll or 3D view. The Tafel's plate is the existing day token `--gb-paper-deep` (softer-sheet amendment, §0). The terrain ink is checked against it, and darkened toward DB inside the plate only if the 3:1 check fails. There is no full night sheet: PN-7 is dropped.

The **night island** is the existing `data-theme="dark"` pattern (`src/styles.css:173-186`): one attribute re-declares the roles. Gipfelbuch adds the `--gb-*` night values to `[data-theme="dark"] .gb-swiss, .gb-swiss [data-theme="dark"]`. Canvas code reads roles from `getComputedStyle` with a `MutationObserver`, as `LiveLines` already does, and never from `SWISS` literals. `SWISS` stays only for bakes.

## 9. Motion and interaction

Static is the design (design book A1). Motion is an enhancement.

- **Arrival.** On first view the Tafel's spill fades in over 600 ms after the photo decodes, then the measured line draws on (`pathLength=1`, dashoffset, 900 ms). Labels and hand notes appear last, staggered 80 ms. Under reduced motion, webdriver or print, the end state shows at once.
- **Scroll.** `animation-timeline: view()` only for decorative draw-on, such as the weight strip or the pen circles, inside `@supports`. Firefox stable still flags it, and the static fallback covers that. Scrolly beats use `IntersectionObserver` state.
- **Follow a photo.** The Tafel picker swaps the photo and every figure that shares the sheet photo, through `useNotebookPhoto`, with a 250 ms crossfade on the band and the spill. The ledger numbers tick to the new values in 300 ms (tabular figures, so nothing jitters).
- **Hover.** Hovering a peak name lifts it and draws its leader in route red, with its distance in the caption. Hovering a ledger value outlines its source in the Tafel; for example, the 41-column gap gets its circle. This is the Distill "number ↔ figure" link.
- **Page to page.** View transitions (design book A3), with `view-transition-name: tafel-ruler` on the compass ruler, so the ruler stays put while the sheet turns.
- **Live (optional, one sheet).** `rigi` and `step-inside` may mount a live engine view in a night island, using the landing's `NearViewport` gate and pausing offscreen. Nothing else on the Gipfelbuch starts GPU work.

## 10. Data and bakes

| Need | Source today | Work |
| --- | --- | --- |
| Solved pose, skyline rows and weights, peaks, `horizon.profile` | `public/demo/gipfelbuch/demo-NN.json` (12 photos) | none |
| Ridge spill strokes per photo | Landing bakes exist only for demo-01, demo-09 and `how`, as light RGBA strokes | Extend `scripts/demo/bake-surround.ts` with a `--mask` mode: a grey coverage WebP, as the map variant already does, with depth carried in coverage. Output to `public/demo/gipfelbuch/tafel/demo-NN.webp` and JSON to `…/tafel/demo-NN.json` (photo rect, ruler ticks, spill peaks), for all 12 photos. Roughly 50–90 kB each, about 1 MB in all, loaded lazily per sheet. The landing can switch to the mask bakes too, which fixes its `light:invert` mismatch (§2). |
| Spill peak names outside the frame | the bake's greedy placer (`bake-surround.ts:255-292`) | reuse; raise the label reach to the Tafel's spill width |
| Band crop per photo | none | computed at render: rows from the 10th to 90th percentile of the skyline ±18% of the height, clamped. The bake JSON stores it so it isn't recomputed. |
| Failure cases per sheet | `useGipfelbuchIndex()` + per-photo JSON | none |
| Synthetic mechanism figures (skyline Fig. 3, others) | page-local generators | replace with real-data versions where a real case shows the mechanism. Keep a synthetic figure only when the mechanism can't be seen on real data, and caption it so. |

Run the bake with `npx tsx scripts/demo/bake-surround.ts --mask demo-01 … demo-12`. It needs the cached Mapterhorn tiles and `@napi-rs/canvas`, which the landing bake already uses. Check `df -h` first, because the machine runs near full.

## 11. The index

`/gipfelbuch` keeps the `SheetMap` as its one hero (it is the strongest image we have) and connects it to the entries:

- **Map as the table of contents.** Each of the 12 view cones on the `SheetMap` links to the photo that the sheets follow. Hovering a cone shows a small Tafel thumbnail, the band with its spill, in the margin.
- **The entries become a *Blattübersicht*** (design book D4/F5), in the form decided in §0 (v5, `img/d4-v5-*`): a follow-one-photo picker under the `SheetMap`, then three chapters in data-flow order on a red-white trail. Each card is the sheet's own `layer` function in miniature, with one visual form per sheet, the circled Blatt number, the name, the tagline and one measured value in mono. A field-notes line per chapter chains the numbers. Hand-written words are allowed there, but no hand-written digits. This replaces the `NotebookMap` text list and the `NodeCard` sections.
- **No night variant.** The `SheetMap` stays the hero. A live roll map belongs on the Camera Roll sheet, as its earned night island.

## 12. Phased plan

Phases are labelled **PN-*n*** so they don't clash with the design book's P0–P6. PN-0 and PN-1 can run once the design book's P1 tokens land. Until then the PN-1 component can be built against the current `--gb-*` names behind a role alias file.

| Phase | Scope | Files (proposal) | Depends on | Size |
| --- | --- | --- | --- | --- |
| **PN-0. Decide** | Done 2026-10-01 (§0). What remains: agree the lane split with mt-image-44 and the page owners, the `display` role name, and the node reorder. | this report | — | S |
| **PN-1. Bake** | `bake-surround.ts --mask` and the Tafel JSON for 12 photos. Switch the landing to the mask bakes as an optional follow-up. | `scripts/demo/bake-surround.ts`, `public/demo/gipfelbuch/tafel/**` | — | S–M |
| **PN-2. Tafel + Ledger** | `Tafel` (projector, ruler, spill, peaks, notes, picker), `Ledger`, the role tokens with night values, the `tafel` check (projector ↔ `solvedRows` median under 0.5 px for 12/12; ledger values are data paths). Preview at `/dev/gipfelbuch-sheet`. | `src/components/gipfelbuch/tafel/**`, `swiss/theme.css` (night block only), `notebook/notebook.check.ts` or a new `tafel.check.ts` | PN-1; design book P1 | M |
| **PN-3. Shell** | The new `ConceptPage` anatomy (§6): eyebrow line, hero grid, Tafel slot, colophon, signposts. Rail and FieldNotes move. `ContourField`, `SheetFrame` chrome and the footer `Legend`/`ScaleBar` are removed from concept pages. Optional night island hero behind a flag. | `ConceptPage.tsx`, `viz/Figure.tsx` (slab → sheet), `swiss/SheetFrame.tsx` | PN-2, and after mt-image-44 releases the paths. Its lane C is reworking `ConceptPage`, `SheetFrame`, `Legend` and `ScaleBar` (adding a Figure `imprint` prop), and lane B is rewriting `ContourField`. The colophon and imprint may already land there. | M |
| **PN-4. Pages** | 19 sheets, in 4 clusters by owner, run by sonnet agents. Per sheet: (a) its Tafel `layer` from the §7.1 table, (b) a Ledger of 3 values, (c) one peak moment, (d) Gallery → Multiples, (e) synthetic → real where possible, (f) drop the Trio, Numbers or Details blocks that repeat the hero. `skyline.tsx` is the exemplar and lands first. | `src/lib/gipfelbuch/pages/*.tsx` | PN-3 | L |
| **PN-5. Motion** | Arrival sequence, draw-on, picker crossfade, ledger ↔ figure hover, the view transition on the ruler. | `tafel/**`, `viz/hooks.ts` | PN-2 | S–M |
| **PN-6. Index** | SheetMap cones as the table of contents, the *Blattübersicht* of 19 Tafel bands, `NotebookMap` retired (or kept as a section if D-PN4 says so). | `routes/gipfelbuch.index.tsx`, `notebook/**`, `tafel/**` | PN-2, design book D4 | M |
| ~~PN-7. Night sheet~~ | Dropped by the §0 decision. Night tokens ship only for live islands, as part of PN-2. | — | — | — |

Each phase lands on the fast tier and a screenshot review at 390, 768 and 1440 px, in both themes where relevant.

## 13. Verification

**Required on every PN phase:**
- `npx biome check --write <changed files>`
- `npx tsc --noEmit -p .`
- `node scripts/ci/run.mjs fast` (it includes `gipfelbuch`, `gipfelbuch-notebook` and the new `tafel` check)
- `node scripts/ci/spdx.mjs`

**New checks:**
- **`tafel` (fast tier).** For each of the 12 photos, the projector maps `horizon.profile` onto `solvedRows`, with the median |Δ| under 0.5 px and p90 under 3 px. On demo-01 today the median is −0.01 and p90 is 0.16 (prototype check). The bake JSON's photo rect must match the photo's aspect. Every `Ledger` value must resolve to a JSON field.
- **Contrast.** The design book's A7 gate extended to the night column.
- **Screenshots.** `scripts/shot.mjs` or a small harness under `scripts/gipfelbuch/` that shoots `/gipfelbuch/skyline` and `/gipfelbuch` at 390, 768 and 1440 px in `?theme=light` and `?theme=dark` (the sheet must look the same in both), through `scripts/gpu/with-render-lock.mjs`. This is a review artifact, not a pixel gate, until the design settles.
- **Perf budget per sheet.**
  - First screen under 250 kB of images (band photo + spill mask).
  - No live SVG filter on any element larger than 400×400.
  - Long tasks under 50 ms on a mid laptop while scrolling, measured with `scripts/gpu/longtask-probe.mjs` or the equivalent.

**How to run the prototype:**
```
npx tsx reports/peak-notebook/prototype/mkdata-v4.mjs   # writes data-v4.js (gitignored) for the v4/v5 rig
node reports/peak-notebook/prototype/mkdata.mjs         # writes data.js (gitignored) for v3.html
node reports/peak-notebook/prototype/serve.mjs          # http://127.0.0.1:3277/
#   /sheet.html?theme=plate&title=namedek&size=56   the committed sheet
#   /sheet.html?theme=day|day2|band|band2|split|night|plate  &title=claim|name|namedek  &size=40|56|72
#   /index.html?id=demo-09                            the committed index, following one photo
#   /v3.html?theme=day|night|split                    the v3 prototype
```

**What was checked for this plan:**
- The projector matches `solvedRows` on demo-01: median −0.01 px, n = 133.
- The screenshots in `peak-notebook/img/`.
- The current-state counts in §3, which come from the subagent audits and the design book.

**What was not checked:**
- No app code was built, so nothing was type-checked or run through CI.
- No perf was measured.
- No Tafel mask bake was made for photos other than demo-01. The prototype reuses the landing's demo-01 bake.
- The other 11 photos' projector error is unmeasured.
- External reference URLs were not opened.

## 14. Decisions

All four are decided (2026-10-01). Reasons and evidence are in §0.

| # | Question | Decision |
| --- | --- | --- |
| D-PN1 | How do night and day meet? | Paper in both themes. The Tafel sits on a quiet plate (`--gb-paper-deep`, softer-sheet amendment). Night islands appear only around live content. |
| D-PN2 | Hero title size | 56/60 on desktop, 40/48 on a phone, as `TYPE.display` (H1 only). mt-image-44 added it to `swiss/type.ts` on 2026-10-01. Never off-scale. |
| D-PN3 | Claim or name as H1 | The name is the H1, in display spelling. The claim is a serif italic dek at 24/30, from a new `claim` field. `<title>` is the name. |
| D-PN4 | Index | Replace `NotebookMap` with the v5 *Blattübersicht*: picker, data-flow trail, one form per sheet, chapter field notes. Reorder `GIPFELBUCH_NODES` so Blatt numbers follow reading order. |

Still open for the owners, not the user:
- the 19 `claim` deks;
- the display name for `rigi`;
- landing the node reorder and the `claim` field in `graph.ts` (content, so owned by bd; mt-image-44 confirmed it isn't in its lanes);

## 15. Risks

- **Collision with the in-flight overhaul.** mt-image-44 is implementing the design book now, and touches `swiss/**`, `notebook/**`, `ConceptPage`, the viz kit and the pages. PN-3 and PN-4 must not run in parallel with its P1 and P2. Either merge PN-3 into its P2 pass, or start after P2 lands (§16).
- **The Gipfelbuch is uncommitted.** Most of `src/components/gipfelbuch/**` and `src/lib/gipfelbuch/**` show as `AM` in `git status`. Land a commit of the current state, or at least an archive, before PN-3. The design book's backup at `~/mt-image-archive/2026-10-01-gipfelbuch-before-design-book.tgz` covers the start of its pass only.
- **People in photos.** Only demo-01, 02, 03 and 06 are people-free. Tafel bands crop to the skyline band, which removes most faces. demo-11 and demo-12 are kept on purpose where the person is the occluder.
- **Spill truth near the camera.** Ridges closer than about 1 km can be cut by the band crop or look discontinuous at the frame edge. The bake already skips them, and the `tafel` check guards the seam.
- **Phone.** The spill is desktop-only, by the same rule as the landing. The phone experience rests on the band, the ledger and the multiples, and that was checked only in the prototype.
- **Kitsch drift.** Hand notes multiply easily. Budget: one hand note per figure and one in the ledger, with no hand-written numbers (design book F6 and H rules).

## 16. Coordination and ownership

- **mt-image-44** runs the design book overhaul (grid, type, ink, line, terrain, print), started 2026-10-01 with 6 subagents. Until it says done, it holds `src/components/gipfelbuch/**`, `src/lib/gipfelbuch/pages/**`, `src/routes/gipfelbuch.*.tsx`, `dev.gipfelbuch-sheet.tsx`, `scripts/gipfelbuch/data-sheet.ts` and the new `sheet-*.ts` files, `public/demo/gipfelbuch/{sheet,paper}/**` and `public/fonts/gipfelbuch/**`, plus a new CI check `gipfelbuch-contrast`. Nothing from PN-2 onwards starts until it releases them. This plan's lanes:
  - **PN-1** is landing-owned. `scripts/demo/bake-surround.ts` was written for the landing; ask its owner before adding `--mask`, or add a separate `scripts/gipfelbuch/data-tafel.ts` that imports its tracer.
  - **PN-2** is a new folder, `src/components/gipfelbuch/tafel/**`, so it doesn't collide.
  - **PN-3 to PN-6** touch shared kit and page files. Schedule them with mt-image-44 and the page owners (bd for the curated set, c2 for the notebook and `ConceptPage`, 74 for page content). Per the project notes, page edits are done by sonnet agents, one per cluster.
- Someone else edited about 25 Gipfelbuch files at 20:10–20:12 on 2026-10-01 (`swiss/Register.tsx`, `Marks.tsx`, `type.ts`). mt-image-44 asked about it; it was not this session. Whoever owns those edits should be part of the lane split.
- The landing (`src/routes/index.tsx`, `src/components/site/**`) is not changed by this plan except for the optional mask-bake switch in PN-1.

## 17. References

Internal:
- `reports/gipfelbuch-design-book.md`: the base system (§7 principles, §8 grid, §15 furniture, §16 motion, §20 phases, §21 decisions)
- `reports/gipfelbuch-swiss-aesthetic.md`, `gipfelbuch-notebook-research.md`, `gipfelbuch-field-notebook-design.md` and `explainer-research.md`
- Landing devices:
  - `src/components/site/Surround.tsx`
  - `src/components/site/LiveLines.tsx`
  - `src/components/site/lineArt.ts`
  - `src/components/site/RevealLoop.tsx`
  - `scripts/demo/bake-surround.ts`
  - `scripts/demo/bake-surround-map.ts`
  - `scripts/demo/bake-live-lines.ts`
- Data: `public/demo/gipfelbuch/demo-NN.json` and `scripts/gipfelbuch/build-data.ts`

External (from a research subagent, not opened this session, **[U]**):
- Bartosz Ciechanowski, *GPS* and *Mechanical Watch*: https://ciechanow.ski/gps/. Calm ink-on-white widgets, one question per widget.
- The Pudding, https://pudding.cool, and scrollama, https://github.com/russellgoldenberg/scrollama: sticky figure with step state.
- NYT *Snow Fall* (2012): https://www.nytimes.com/projects/2012/snow-fall/. Full-bleed hero, then data growing out of it.
- Distill, https://distill.pub: marginalia, and number ↔ figure links.
- NZZ Visuals, https://www.nzz.ch/visuals: Swiss restraint, one accent on a grid.
- Nicky Case, https://ncase.me, and Maggie Appleton, https://maggieappleton.com: hand-drawn wrapper, precise core, a restrained palette.
- rough.js, https://roughjs.com: low, seeded roughness; never animate the wobble.
- Xaver Imfeld, https://en.wikipedia.org/wiki/Xaver_Imfeld, and Heinrich Berann, https://en.wikipedia.org/wiki/Heinrich_C._Berann: panorama drawing and the *Panoramatafel* label conventions (names on leaders above the skyline, a bearing ruler).
- Scroll-driven animations: MDN, https://developer.mozilla.org/en-US/docs/Web/CSS/animation-timeline (checked: Chrome and Edge 115+, Safari 26+, Firefox behind a flag), and https://scroll-driven-animations.style.
