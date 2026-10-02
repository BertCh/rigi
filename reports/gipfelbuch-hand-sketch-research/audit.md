# Gipfelbuch "lost notebook style" forensic audit (2026-10-01)

Static audit only: no browser runs and no repo edits. The counts come from regex scans in Python (`scratchpad/research/count.py`, `fn.py`) over `src/components/gipfelbuch/**`, `src/lib/gipfelbuch/pages/**` and `src/routes/gipfelbuch*.tsx`, excluding `*.check.ts`. Archives are extracted under `scratchpad/archives/<name>/`.

**Live tree warning.** Another session is editing the Gipfelbuch right now. Since 882b2d5 these files are modified: `viz/explain.tsx`, `viz/index.ts` and `viz/real.tsx`; the pages `baseline-pipeline`, `camera-prior`, `camera-roll`, `photo-workspace`, `rigi` and `viewport-inference`. `viz/StoryMap.tsx` and `viz/story.tsx` are new and untracked (an "alignment story" with crisp cones). S4 below is that working tree.

## 0. Verdict in one paragraph

The hand-made peak was **S1/S2**, after c2's sketch pass and s52's field-notebook pass (20:09–20:20). At that point:
- there were 224 `HandText`, 159 `SketchPath`, 102 `Hachure` and 0 `PrintLabel`;
- there were only 29 `<rect>`, 10 `<line>` and 17 `<circle>`;
- tick and value labels were written in the hand.

Four later passes pushed it back towards a printed document:
1. **E4 design book (44).** It set the rules "certainty is line style, never wobble", "at most 3 hand notes of ≤ 12 words", Source Serif titles and the Fira roles in `type.ts`. It also deleted `PencilFilter` from `SheetMap` and `ContourField`.
2. **E5 Tafel (2f) and the R1–R9 regression fixes.** These made photo lines crisp (R7) and "fill encodes" (R2). They converted the 187 hand tick/value labels to page-local `PrintLabel`/`PrintNote`. They also added a fully crisp Tafel and Blattübersicht.
3. **The 3b "softer" pass.** It removed the grain, tape, tilt, red margin rule and wavy underline, and cut the grid from 11 % to 6 %.
4. **The 2d/25 restore pass.** Under the label "notebook restore" it actually codified print. It added the kit `PrintLabel` (default **Fira Mono**), `CrispLine`, `data` meaning exact `<path>`, and a CI lint capping `HandText` at 3 per page. Pages went `SketchPath` → `DataLine`/`CrispLine` and hand notes went 6 → 1.

Net change, S1 → S4:
- `HandText` 224 → 41 (pages: 202 → 17).
- `PrintLabel`/`PrintNote` 0 → 132.
- Exact `data` marks 12 → 124.
- `CrispLine`/`DataLine` 0 → 30.
- Plain `<path>` 45 → 158, `<circle>` 17 → 72, `<line>` 10 → 48, `<text>` 106 → 178.

The notebook *shell pieces* came back in the restore (ContourField, FieldNotes, HandRule, NotebookTrail, NotebookMap). The *figures* inside stayed printed, and figures are most of the surface.

## 1. Timeline

| Snapshot / era | Session | Hand-feel changes | Evidence |
|---|---|---|---|
| HEAD 034856d (E0, committed explainer) | 09, bd | Dark `/atlas`, crisp glowing lines, solid fills. No hand at all. This is the "fidelity bar" later passes kept returning to. | `reports/gipfelbuch-restore-2026-10-01.md:18` |
| **S0** `before-sketch.tgz` 19:09 (E1 Swiss sheet) | 2f, 74 | Paper sheet with LK inks and furniture. The notebook kit already existed (`sketch.ts`, `sketchify.ts`, `Ink.tsx`) but only the index used it. Pages had 0 `HandText` and 0 `SketchPath`. Plain SVG: 131 rect, 177 line, 184 path, 148 circle, 312 text, 217 `rounded-*`. Hand face Architects Daughter via Google link `HandFont` (`notebook/notes.tsx:20`). H1 Fraunces bold 3.6rem. | totals table |
| **S1** `before-field-notebook.tgz` 20:09 (E2 c2 sketch) | c2 | **Peak sketch.** The user asked: "all visualizations should be sketch as possible, we don't want clean lines and stroke outlines". All pages were re-inked: `HandText` 224, `SketchPath` 159, `SketchPolyline` 31, `Hachure` 102, `Stipple` 16, `PenLine` 197, `HandDot` 99. Plain shapes collapsed (rect 29, line 10, circle 17), `rounded-*` 217 → 36. Photo lines were `SketchPath` at tolerance 0.65 with a paper halo. `PencilFilter` wobbled `SheetMap` and `ContourField`. Grid was 11 % at 20 px; red double margin rule `.nb-page`, tape `.nb-tape`, wavy `.nb-term` underline, print shadow. The README "every visualization drawn by hand" rules date from here (`README.md:113-136`). | `notebook.css` diff; README |
| **S2** `before-design-book.tgz` 20:20 (E3 s52 field notebook) | s52 | Hand face became **Caveat** (+ Shantell Sans for small labels) through Google `HAND_FONT_HREF`. `HandText` began setting **digits in print** (`splitPrintRuns`, `PRINT_SCALE 0.8`, `Ink.tsx:252-283`): the first step towards print inside the hand. Added tapered-outline strokes with ink blobs, `FieldNotes`, `NotebookTrail` and `HandRule`, and a closed type scale. Its report proposed "≤ 12 words, ≤ 3 hand notes per entry" (`field-notebook-design.md:264,329`) and Fira for H2/H3 (G13/G16 removed Fraunces from section heads). Counts were still at the peak. | `Ink.tsx` S2 |
| `gipfelbuch-grain/` 21:02 | 3b | Only `grain.png` was archived; the softer pass removed it. | — |
| (no snapshot) E4 design book | 44 | **Print-ward.** Self-hosted fonts; **Source Serif 4** replaced Fraunces; `type.ts` roles were Fira everywhere except H1 (`design-book.md:366-389`). Rules **L3 "Certainty is line style, never wobble"** (`design-book.md:464,705`) and **H2 "At most three hand notes per entry, ≤ 12 words"** (`:506,732`). **`PencilFilter` deleted from use** in `SheetMap`/`ContourField` (perf, `peak-notebook-plan.md:10`). Section sketched rule removed ("G9: sections separated by space", `Section.tsx:21`). `print.css`, `Colophon` and `StationTable` added. | memory `gipfelbuch-design-book` |
| (no snapshot) 3b softer | 3b | User: "a bit more soft … grid paper thing but softer". Removed grain, tape, tilt, the red margin rule and the SheetFrame ticks. `.nb-term` went wavy → solid at 35 %. Grid 11 % → 6 % (8 % index) at 24 px. Paper lightened. Legitimately requested, but it removed most of the "object" cues. | `notebook.css:32-34,106-115,189` |
| **S3** `before-restore-2d.tgz` 22:05 (E5 Tafel + R1–R9) | 2f | **Biggest single drop in hand.** The peak-notebook plan item 6 flagged "187 `HandText` call sites put tick and value labels in the hand" (`peak-notebook-plan.md:174`). They became page-local `PrintLabel`/`PrintNote` (S3: 59 + 39) and `HandText` fell 224 → 63. **R7** "crisp stroke with a dark under-stroke" replaced sketched photo lines (`regression:33`, `real.tsx` `PhotoLine crisp`). **R2** "hatch decorates, fill encodes" restored solid bars. The **Tafel** hero (crisp `Stroke`, mono labels) and the **Blattübersicht** index (crisp miniatures) were added. The shell **dropped** ContourField, FieldNotes, HandRule, NotebookTrail and NotebookMap. `data` props 12 → 70; `<text>` 108 → 197; `canvas` sketch draws (26 `ctx.*`) went away. | S3 counts |
| **S4** current (E6 restore) | 2d, 25 | The shell notebook pieces came back: `ConceptPage` renders `ContourField`, `FieldNotes`, one `HandRule`, `NotebookTrail` ("Where it sits"), and the index has `NotebookMap` again. **But the figure kit was codified as print:** `viz/labels.tsx` `PrintLabel` (default `mono = true`, `labels.tsx:24`), `PrintNote`, `CrispLine` (`real.tsx:262`), `DataLine` (dem-horizon). README "Data is exact" (`README.md:13-14,55-58`). `gipfelbuch.check.ts:328` **`MAX_HAND_NOTES = 3`** is enforced in CI, plus `display-title`/`rotate-` rules. Spec rules (`best-of-both.md:174-186`): "Labels are printed … never the hand", "≤ 1 hand note per figure, ≤ 3 per sheet". Results: `HandText` 63 → 41 (pages 17), SketchPath 154 → 101, `PrintLabel`+`Note` 98 → 132, data-exact 70 → 124, `CrispLine` 17, `DataLine` 13, plain `<path>` 158, `<circle>` 72. "Hand notes 6 → 1" on peak, 3 → 1 on viewport-inference and baseline (`restore:101-104`). | S4 counts |

### 1a. The specific print-ward changes, ranked by surface affected

1. **Tick and value labels hand → print** (E5, then KR6). There are now 131 `<PrintLabel|PrintNote>` in pages. `PrintLabel` defaults to `gb-num` = Fira tabular (`labels.tsx:24,55`), or condensed. *This is the most visible loss.*
2. **`data` means exact** (KR1). `Ink.tsx:61-62,127,184,456-460,478-485,594-597` short-circuit to `ExactStroke`/plain `<path d>`. There are 124 such call sites. S1 used `sketchify` with tolerance 0.9 px, which `notebook.check.ts:83-121` proves stays within tolerance of the data.
3. **Photo overlays crisp** (R7/KR6). `PhotoLine crisp` is always on in `RealPhoto` (`real.tsx:548-565`), `PeakLabels` (`:728-735`) and `DemPatch`. There are 17 `CrispLine` and 13 `DataLine` call sites.
4. **The Tafel and the Blattübersicht are wholly print.** `tafel/sheets.tsx:170-192` `Stroke` is a 2-path dark-casing crisp line. `Ground`, `Mark` and `DemPatchImage` are plain rect/line/path/circle (9/18/15/13). `Tafel.tsx` `TafelStage` has 4 line, 2 path, 2 circle and 6 text in mono. These render as the hero on 4 sheets (accept-rule, dem-source, terrain-sampler, camera-roll) and as all 19 index cards.
5. **Hand cap** (H2 → KR11 lint). `gipfelbuch.check.ts:328,351-355`. Any page sweep that adds hand notes fails the fast tier.
6. **Type roles.** `swiss/type.ts:14-30`: kicker is condensed caps, caption is Fira 13, h2/h3 Fira semibold, claim/display Source Serif, micro Fira Mono, stat Fira 300. Every caption, Figure number, Section head, Beat claim and Ledger is print.
7. **Wobble filters removed.** `PencilFilter` (KR12 deleted it). `nb-wobble`/`nb-grain` in `SketchDefs` (`Ink.tsx:617-680`) are defined and mounted (`ConceptPage.tsx:122`) but have **0 users**.
8. **Digits in print inside the hand** (s52 G10). `Ink.tsx:252-283,320-335`: every hand note with a number switches to mono mid-line.
9. **Softer** (user-requested). Grid at 6 %, no wavy underline, no margin rule or tape. Keep, but the grid could rise a little and the pen underline could come back (both are "soft").

## 1b. Whole-tree token totals per snapshot

S0 = before-sketch, S1 = before-field-notebook (post-c2), S2 = before-design-book (post-s52), S3 = before-restore-2d, S4 = current. "data-prop(exact)" counts `<SketchPath|SketchPolyline|PenLine|PenCircle|HandDot … data>`.

| token | S0 before-sketch | S1 before-fieldnb | S2 before-designbook | S3 before-restore | S4 current |
|---|---|---|---|---|---|
| SketchPath | 10 | 159 | 159 | 154 | 101 |
| SketchPolyline | 0 | 31 | 31 | 31 | 13 |
| SketchRect | 0 | 4 | 4 | 4 | 4 |
| Hachure | 1 | 102 | 101 | 80 | 76 |
| Stipple | 0 | 16 | 16 | 10 | 10 |
| PenLine | 7 | 197 | 200 | 194 | 174 |
| PenCircle | 5 | 66 | 66 | 64 | 58 |
| PenArrow | 3 | 13 | 13 | 14 | 14 |
| PenRule | 0 | 3 | 3 | 1 | 1 |
| HandRule | 0 | 3 | 3 | 0 | 1 |
| HandText | 15 | 224 | 224 | 63 | 41 |
| StepNumber | 1 | 3 | 2 | 2 | 2 |
| HandDot | 3 | 99 | 100 | 92 | 74 |
| sketchify() | 13 | 13 | 13 | 13 | 13 |
| nb-hand cls | 12 | 27 | 30 | 25 | 25 |
| nb-wobble | 4 | 4 | 4 | 4 | 4 |
| data-prop(exact) | 11 | 12 | 12 | 70 | 124 |
| PrintLabel | 0 | 0 | 0 | 59 | 106 |
| PrintNote | 0 | 0 | 0 | 39 | 26 |
| CrispLine | 0 | 0 | 0 | 0 | 17 |
| DataLine | 0 | 0 | 0 | 0 | 13 |
| <rect | 131 | 29 | 30 | 72 | 78 |
| <line | 177 | 10 | 10 | 31 | 48 |
| <path | 184 | 45 | 53 | 108 | 158 |
| <circle | 148 | 17 | 24 | 47 | 72 |
| <polyline/gon | 6 | 0 | 0 | 0 | 2 |
| <text | 312 | 106 | 108 | 197 | 178 |
| <table | 4 | 4 | 4 | 5 | 3 |
| rounded-* | 217 | 36 | 21 | 8 | 7 |
| border-* | 94 | 28 | 26 | 30 | 32 |
| display-title/TYPE.h1|display|claim | 25 | 25 | 21 | 8 | 10 |
| TYPE.h2/h3 | 0 | 0 | 0 | 5 | 8 |
| TYPE.stat | 0 | 0 | 0 | 0 | 0 |
| gb-caps/kicker | 34 | 36 | 45 | 45 | 50 |
| font-mono/gb-coord | 315 | 321 | 329 | 447 | 446 |
| canvas ctx draw | 26 | 26 | 26 | 0 | 0 |
| RealPhoto | 80 | 80 | 80 | 80 | 80 |
| Figure plate | 0 | 0 | 0 | 0 | 4 |
| Plot | 11 | 11 | 11 | 11 | 11 |
| <Stat | 44 | 44 | 44 | 44 | 44 |
| Numbers | 19 | 19 | 19 | 19 | 19 |

## 2. Current inventory: what reads clean or printed

### 2a. Pages over time (S0 / S1 / S3 / S4)

Values are S0 / S1 / S3 / S4.

| page | HandText | Sketch(non-data) | PrintLabel/Note | Crisp/DataLine/data-prop | plain SVG shapes |
|---|---|---|---|---|---|
| accept-rule | 0 / 3 / 1 / 1 | 0 / 4 / 4 / 3 | 0 / 0 / 0 / 2 | 0 / 0 / 0 / 1 | 10 / 2 / 6 / 7 |
| baseline-pipeline | 0 / 18 / 3 / 1 | 0 / 9 / 5 / 5 | 0 / 0 / 0 / 2 | 0 / 0 / 4 / 3 | 34 / 2 / 9 / 9 |
| camera-prior | 0 / 10 / 0 / 0 | 0 / 8 / 8 / 7 | 0 / 0 / 3 / 5 | 0 / 0 / 0 / 0 | 31 / 3 / 9 / 12 |
| camera-roll | 0 / 13 / 3 / 3 | 0 / 16 / 13 / 9 | 0 / 0 / 0 / 2 | 0 / 0 / 3 / 18 | 41 / 1 / 2 / 4 |
| dem-anchoring | 0 / 20 / 1 / 1 | 0 / 8 / 7 / 3 | 0 / 0 / 0 / 0 | 0 / 0 / 2 / 27 | 38 / 5 / 14 / 14 |
| dem-horizon | 0 / 7 / 3 / 3 | 0 / 15 / 4 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 10 / 19 | 47 / 7 / 12 / 18 |
| dem-source | 0 / 7 / 0 / 0 | 0 / 10 / 8 / 7 | 0 / 0 / 7 / 7 | 0 / 0 / 2 / 4 | 18 / 0 / 2 / 4 |
| eye-rule | 0 / 17 / 3 / 1 | 0 / 5 / 1 / 1 | 0 / 0 / 14 / 16 | 0 / 0 / 3 / 20 | 31 / 0 / 7 / 5 |
| peak | 0 / 13 / 6 / 1 | 0 / 11 / 7 / 1 | 0 / 0 / 7 / 12 | 0 / 0 / 4 / 4 | 38 / 1 / 3 / 8 |
| photo-workspace | 0 / 15 / 4 / 3 | 0 / 4 / 0 / 0 | 0 / 0 / 11 / 12 | 0 / 0 / 4 / 6 | 32 / 3 / 12 / 17 |
| photo | 0 / 10 / 1 / 1 | 0 / 7 / 7 / 6 | 0 / 0 / 9 / 9 | 0 / 0 / 0 / 1 | 17 / 1 / 2 / 1 |
| pose-estimate | 0 / 7 / 1 / 0 | 0 / 8 / 6 / 2 | 0 / 0 / 6 / 6 | 0 / 0 / 2 / 5 | 31 / 5 / 9 / 17 |
| rigi | 0 / 4 / 0 / 0 | 0 / 2 / 0 / 0 | 0 / 0 / 4 / 4 | 0 / 0 / 2 / 0 | 13 / 1 / 1 / 7 |
| skyline | 0 / 2 / 1 / 0 | 0 / 10 / 1 / 0 | 0 / 0 / 1 / 1 | 0 / 0 / 9 / 0 | 17 / 4 / 5 / 21 |
| step-inside | 0 / 20 / 4 / 1 | 0 / 6 / 3 / 3 | 0 / 0 / 13 / 16 | 0 / 0 / 2 / 13 | 45 / 5 / 11 / 12 |
| tap-a-peak | 0 / 11 / 1 / 0 | 0 / 6 / 2 / 0 | 0 / 0 / 8 / 11 | 0 / 0 / 4 / 6 | 25 / 0 / 1 / 18 |
| terrain-sampler | 0 / 8 / 3 / 0 | 0 / 6 / 6 / 5 | 0 / 0 / 6 / 9 | 0 / 0 / 0 / 10 | 30 / 2 / 4 / 4 |
| terrain-snapping | 0 / 2 / 1 / 0 | 0 / 5 / 5 / 2 | 0 / 0 / 0 / 6 | 0 / 0 / 0 / 0 | 23 / 0 / 5 / 10 |
| viewport-inference | 0 / 13 / 3 / 1 | 0 / 13 / 6 / 1 | 0 / 0 / 9 / 11 | 0 / 0 / 7 / 0 | 36 / 1 / 15 / 32 |

### 2b. Current per-file counts (all files with any hit)

`c/` = src/components/gipfelbuch, `p/` = src/lib/gipfelbuch/pages. "mono" = `font-mono|gb-coord|TYPE.micro|nb-num`. The sketch columns (HandText, SketchPath, SketchPolyline, Hachure, PenLine, PenCircle, HandDot) are shown for contrast.

| file | HandText | SketchPath | SketchPolyline | Hachure | PenLine | PenCircle | HandDot | data-prop(exact) | PrintLabel | PrintNote | CrispLine | DataLine | <rect | <line | <path | <circle | <text | <table | rounded-* | border-* | display-title/TYPE.h1|display|claim | TYPE.h2/h3 | gb-caps/kicker | font-mono/gb-coord |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| c/AutoVisual.tsx | 1 | 3 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| c/ConceptPage.tsx | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 2 | 2 | 4 | 3 |
| c/OntologyPanel.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 4 | 8 |
| c/loadPage.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| c/notebook/ConceptNotes.tsx | 6 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| c/notebook/Ink.tsx | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 8 | 0 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | 1 |
| c/notebook/NotebookMap.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| c/notebook/PhotoStrip.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 3 | 0 | 0 | 0 | 0 |
| c/notebook/figures.tsx | 15 | 10 | 0 | 1 | 7 | 5 | 3 | 11 | 0 | 0 | 0 | 0 | 0 | 1 | 5 | 1 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| c/notebook/notes.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| c/swiss/Cartouche.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 1 |
| c/swiss/Colophon.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 1 | 3 | 3 |
| c/swiss/HachureRule.tsx | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| c/swiss/Legend.tsx | 0 | 6 | 0 | 0 | 6 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| c/swiss/Marks.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 3 | 4 | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| c/swiss/Register.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| c/swiss/ScaleBar.tsx | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| c/swiss/SheetFrame.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 3 |
| c/swiss/SheetMap.tsx | 2 | 1 | 1 | 0 | 1 | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 11 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 1 | 2 |
| c/swiss/Signpost.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 |
| c/swiss/Waymark.tsx | 0 | 0 | 1 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 |
| c/swiss/sheet-contour-runs.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| c/swiss/type.ts | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 1 | 1 |
| c/tafel/Blattuebersicht.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 2 | 1 | 4 |
| c/tafel/SheetColophon.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| c/tafel/Tafel.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 2 | 2 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| c/tafel/sheets.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9 | 18 | 15 | 13 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 3 |
| c/viz/Callout.tsx | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 |
| c/viz/CodeRef.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 |
| c/viz/DemoImage.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 |
| c/viz/Figure.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| c/viz/MarginNote.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| c/viz/Plot.tsx | 0 | 1 | 0 | 1 | 4 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 2 | 2 |
| c/viz/Section.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 2 | 1 |
| c/viz/Steps.tsx | 0 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| c/viz/StoryMap.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 4 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 2 |
| c/viz/explain.tsx | 0 | 4 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 | 0 | 1 | 0 | 1 | 0 | 6 | 7 |
| c/viz/labels.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| c/viz/math.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 1 | 0 |
| c/viz/real.tsx | 0 | 2 | 0 | 0 | 0 | 0 | 4 | 3 | 0 | 0 | 0 | 0 | 3 | 3 | 5 | 4 | 6 | 0 | 1 | 0 | 0 | 0 | 1 | 2 |
| p/accept-rule.tsx | 1 | 2 | 1 | 3 | 3 | 3 | 4 | 1 | 2 | 0 | 0 | 0 | 4 | 2 | 0 | 1 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 22 |
| p/baseline-pipeline.tsx | 1 | 7 | 0 | 3 | 20 | 2 | 7 | 2 | 0 | 2 | 1 | 0 | 8 | 0 | 1 | 0 | 27 | 1 | 0 | 3 | 0 | 0 | 0 | 42 |
| p/camera-prior.tsx | 0 | 7 | 0 | 2 | 10 | 1 | 4 | 0 | 5 | 0 | 0 | 0 | 9 | 1 | 0 | 2 | 11 | 0 | 0 | 1 | 0 | 0 | 0 | 10 |
| p/camera-roll.tsx | 3 | 14 | 0 | 1 | 15 | 7 | 5 | 18 | 2 | 0 | 0 | 0 | 1 | 0 | 1 | 2 | 13 | 0 | 0 | 6 | 0 | 0 | 0 | 26 |
| p/dem-anchoring.tsx | 1 | 9 | 0 | 7 | 13 | 2 | 6 | 27 | 0 | 0 | 0 | 0 | 3 | 0 | 10 | 1 | 24 | 0 | 0 | 0 | 0 | 0 | 0 | 36 |
| p/dem-horizon.tsx | 3 | 0 | 0 | 4 | 12 | 4 | 7 | 6 | 0 | 0 | 0 | 13 | 5 | 2 | 9 | 2 | 8 | 0 | 0 | 0 | 0 | 0 | 0 | 25 |
| p/dem-source.tsx | 0 | 7 | 0 | 3 | 4 | 0 | 0 | 4 | 7 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 9 | 0 | 0 | 3 | 0 | 0 | 0 | 15 |
| p/eye-rule.tsx | 1 | 2 | 2 | 3 | 12 | 1 | 4 | 20 | 16 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 8 |
| p/peak.tsx | 1 | 0 | 3 | 4 | 10 | 9 | 5 | 2 | 0 | 12 | 2 | 0 | 0 | 1 | 5 | 2 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 19 |
| p/photo-workspace.tsx | 3 | 0 | 4 | 9 | 4 | 2 | 2 | 6 | 1 | 11 | 0 | 0 | 2 | 2 | 9 | 4 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 11 |
| p/photo.tsx | 1 | 6 | 0 | 2 | 7 | 0 | 2 | 0 | 9 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 9 |
| p/pose-estimate.tsx | 0 | 2 | 0 | 2 | 7 | 2 | 2 | 0 | 6 | 0 | 5 | 0 | 4 | 2 | 5 | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 16 |
| p/rigi.tsx | 0 | 0 | 0 | 1 | 2 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 2 | 5 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 4 |
| p/skyline.tsx | 0 | 0 | 0 | 1 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | 0 | 2 | 0 | 18 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 16 |
| p/step-inside.tsx | 1 | 5 | 0 | 6 | 15 | 5 | 3 | 13 | 16 | 0 | 0 | 0 | 4 | 1 | 5 | 2 | 11 | 0 | 0 | 0 | 0 | 0 | 0 | 33 |
| p/tap-a-peak.tsx | 0 | 0 | 0 | 2 | 2 | 2 | 1 | 1 | 10 | 1 | 5 | 0 | 3 | 1 | 7 | 7 | 1 | 0 | 0 | 1 | 0 | 0 | 1 | 28 |
| p/terrain-sampler.tsx | 0 | 5 | 0 | 9 | 4 | 3 | 5 | 9 | 9 | 0 | 1 | 0 | 1 | 0 | 3 | 0 | 6 | 0 | 0 | 1 | 0 | 0 | 0 | 19 |
| p/terrain-snapping.tsx | 0 | 2 | 0 | 5 | 5 | 3 | 2 | 0 | 6 | 0 | 0 | 0 | 6 | 2 | 0 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 6 |
| p/viewport-inference.tsx | 1 | 1 | 0 | 6 | 6 | 4 | 0 | 0 | 11 | 0 | 0 | 0 | 7 | 4 | 17 | 4 | 5 | 1 | 0 | 2 | 0 | 1 | 1 | 28 |
| src/routes/gipfelbuch.$concept.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| src/routes/gipfelbuch.index.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 2 | 1 |
| src/routes/gipfelbuch.print.tsx | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 2 | 0 |

### 2c. Per component, pages (current)

Column `photo/raster` = Y when the component draws on or next to a real photo, a DEM raster or a canvas: `RealPhoto`, `<image>`, `<img>`, `useGipfelbuchPhoto`, `DemPatch`, `.webp`/`.jpg`. **In Y rows, the geometry of measured overlays must stay on exact pixels.** The stroke can still be pen-like: a single pass, sketchify tolerance ≤ 0.6 px, an untapered constant width, and the halo and under-stroke kept for contrast. Labels can be hand-small with a halo. **All other rows are synthetic, schematic or furniture**, so they can be fully sketched. Print = PrintLabel/PrintNote; Crisp = CrispLine/DataLine; exact = `data` prop; box = paper-deep slab, border, `<table>`, `Stat`/`Numbers`.


### accept-rule.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HandBar |  |  |  |  | 1 |  |  |  |  |  |  |  | 2 |  |
| Bar | Y |  |  |  | 1 |  |  |  |  | 4 |  |  | 1 |  |
| RealDecisions | Y |  |  |  |  | 1 |  |  |  | 6 |  |  |  |  |
| ConfidenceVsError |  | 1 |  |  | 1 |  |  | 1 |  | 2 |  |  | 4 |  |
| PrecisionLadder |  |  |  |  |  |  |  |  |  | 2 |  | 2 |  |  |
| VerdictTree |  |  |  |  | 1 |  |  |  | 4 |  |  |  | 6 | 1 |
| Legacy |  |  |  |  |  |  |  |  |  |  |  | 1 |  |  |
| BarScale |  | 1 |  | 1 |  |  |  |  |  |  |  | 1 | 2 |  |
| TwoSolvers | Y |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| ScoreFit | Y |  |  |  |  | 1 |  |  |  | 4 |  |  |  |  |
| AcceptRule |  |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### baseline-pipeline.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Conveyor |  | 2 |  |  | 1 |  |  |  | 8 | 18 |  | 2 | 4 |  |
| MetaArtefact |  |  |  |  |  |  |  |  | 2 | 2 |  |  | 3 |  |
| HorizonArtefact |  |  |  | 1 |  |  |  |  | 1 | 1 |  |  | 3 |  |
| SkylineArtefact |  |  |  | 1 |  |  |  |  | 1 | 1 |  |  | 4 |  |
| GridArtefact |  |  |  |  |  |  |  |  | 2 | 2 |  |  | 2 |  |
| GateArtefact |  |  |  |  |  |  |  |  | 4 | 4 |  |  | 5 | 1 |
| CascadeFlow |  |  |  |  |  |  |  |  | 1 | 1 |  |  | 1 |  |
| Box |  |  |  |  |  |  |  |  | 2 | 2 |  |  | 2 |  |
| Variants |  |  |  |  | 1 |  |  |  |  | 4 |  |  | 2 |  |
| TimeBar |  |  |  |  | 1 |  |  |  | 1 | 3 |  |  |  |  |
| AllTwelve | Y |  |  |  | 2 |  |  |  |  | 4 |  | 5 |  |  |
| GroundTruthEval |  |  |  |  | 2 |  |  |  |  | 2 |  | 1 | 2 |  |
| Deep | Y |  |  |  |  |  |  |  |  | 1 |  | 4 |  |  |
| PipelineNumbers |  |  |  |  |  |  |  |  |  |  |  | 2 |  |  |
| YawSearch | Y |  | 1 |  |  |  | 1 |  | 5 | 9 |  | 3 | 4 |  |

### camera-prior.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RealPrior | Y |  |  |  |  |  |  |  |  | 2 |  | 4 |  |  |
| Strip |  |  |  |  | 3 |  |  | 2 | 5 | 5 |  |  | 3 |  |
| PriorErrors |  |  |  |  |  |  |  |  | 1 | 1 |  | 6 | 6 |  |
| PriorLab |  | 2 |  |  | 3 |  |  |  | 2 | 5 |  | 10 | 17 |  |
| Deep |  |  |  |  |  |  |  |  |  | 1 |  | 3 |  |  |
| YawBars |  | 3 |  |  | 3 | 1 |  |  |  |  |  | 1 |  |  |
| PriorTrio | Y |  |  |  |  |  |  |  | 3 | 3 |  |  | 5 |  |
| PriorNumbers | Y |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### camera-roll.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RayLabel |  |  |  |  |  |  |  |  | 1 | 1 |  |  |  |  |
| RollLinker |  |  |  |  |  |  |  |  | 2 | 4 |  |  | 9 | 1 |
| ViewpointWalk |  |  |  |  |  |  |  | 1 | 2 | 2 |  |  | 5 | 1 |
| CompassBias |  |  |  |  |  |  |  |  | 2 | 6 |  |  | 6 |  |
| PanoramaStrip |  |  |  | 3 |  |  |  |  | 2 | 2 |  | 6 | 6 | 1 |
| RealRoll | Y | 2 |  | 10 | 1 |  |  | 1 | 1 | 3 |  |  | 13 |  |
| RealBias |  |  |  | 5 |  |  |  |  | 3 | 5 |  |  | 5 |  |
| HeroStages | Y |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| RollNumbers | Y |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |

### dem-anchoring.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CurveFigure |  |  |  | 10 | 1 |  | 1 |  | 5 | 19 |  | 2 | 10 |  |
| CandidateFigure |  |  |  | 8 | 2 |  | 2 |  | 6 | 6 |  |  | 9 |  |
| GaugeFigure |  |  |  | 5 |  |  | 3 |  | 6 | 14 |  |  | 9 | 1 |
| RangeCells |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| MiniCurves |  |  |  | 1 |  |  |  |  |  |  |  | 1 | 2 |  |
| MiniQuality |  |  |  | 1 |  |  | 2 |  | 2 | 2 |  | 1 | 3 |  |
| RealCurves |  |  |  | 1 |  |  |  |  |  | 4 |  | 2 | 3 |  |
| RealQuality |  |  |  | 1 |  |  | 1 | 1 | 5 | 9 |  | 2 | 3 |  |

### dem-horizon.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DataLine |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| RayMarch |  |  | 3 | 4 | 3 |  | 1 |  | 5 | 11 |  | 2 | 15 | 1 |
| Read |  |  |  | 1 |  |  |  |  | 3 | 3 |  |  | 4 |  |
| Sweep |  |  | 3 | 1 | 1 |  | 1 |  |  | 4 |  | 1 | 5 |  |
| DistLegend |  |  |  |  | 1 |  |  |  |  | 2 |  |  |  |  |
| HorizonOverlay |  |  | 2 |  |  |  |  | 1 |  |  |  |  |  |  |
| ProfilePlot |  |  | 1 |  |  |  | 1 | 1 |  |  |  |  | 1 | 1 |
| Ladder | Y |  | 3 |  |  | 2 | 1 |  |  | 2 |  | 1 | 3 | 1 |
| MiniGround | Y |  | 1 |  |  |  | 1 |  |  |  |  | 1 | 3 |  |
| WorstTenth |  |  |  |  |  |  | 2 |  |  |  |  |  |  |  |
| Misses | Y |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |

### dem-source.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Hero | Y | 2 |  |  |  |  |  |  | 2 | 4 |  |  |  |  |
| Disagree |  |  |  | 1 |  |  |  |  |  |  |  | 1 | 5 |  |
| GroundGap |  |  |  | 1 |  |  | 1 |  | 2 | 2 |  |  | 1 |  |
| PixelCard |  |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| BandsMini |  | 2 |  |  |  |  |  |  | 2 | 2 |  | 1 | 2 |  |
| FallbackMini |  | 2 |  |  |  |  |  |  |  |  |  |  | 5 |  |
| Ladder |  | 1 |  | 2 |  |  | 1 |  | 3 | 5 |  |  | 3 |  |
| Encoding |  |  |  |  |  |  |  |  |  | 3 |  | 6 |  |  |

### eye-rule.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Toggle |  |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| Readout |  |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| Hero |  | 5 |  | 11 |  |  |  |  |  |  |  |  | 13 |  |
| RealOffsets |  | 5 |  | 3 |  |  |  | 4 | 2 | 2 |  | 1 | 4 |  |
| RealContour |  |  |  |  |  |  |  |  |  | 2 |  | 2 |  |  |
| DriftPlot |  | 1 |  | 1 |  |  |  | 1 |  |  |  |  | 1 |  |
| SideView |  | 5 |  | 5 |  |  |  |  |  |  |  | 1 | 7 | 1 |
| NumberCard |  |  |  |  |  |  |  |  |  | 2 |  | 2 |  |  |

### peak.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RayMarch |  | 4 |  | 1 |  |  |  |  | 2 | 5 |  | 1 | 11 |  |
| LabelLayout |  | 2 |  | 1 |  |  |  |  | 2 | 6 |  | 1 | 8 |  |
| HiddenSummit | Y | 4 | 1 |  |  |  | 4 |  |  |  |  |  | 6 | 1 |
| YawSlide | Y | 1 | 1 |  |  |  |  |  |  | 1 |  |  | 2 |  |
| RealSummits | Y |  |  |  |  | 1 |  |  |  | 2 |  | 1 | 1 |  |
| RealOcclusion | Y | 1 |  |  |  |  | 1 | 2 | 2 | 3 |  | 1 | 3 |  |
| BandPeaks | Y |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |

### photo-workspace.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PoseJourney |  | 9 |  | 2 | 2 |  | 8 |  | 1 | 3 |  |  | 19 | 3 |
| PinSolve |  | 2 |  | 4 |  |  | 1 | 1 |  | 4 |  |  | 6 |  |
| PeakProjection | Y | 1 |  |  |  | 2 |  | 3 |  | 2 |  |  |  |  |
| MiniLayers | Y |  |  |  |  |  |  |  |  | 1 |  | 5 |  |  |

### photo.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Anatomy | Y | 7 | 1 |  | 1 |  |  |  |  | 3 |  |  | 13 | 1 |
| RealRecord | Y |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| FieldRow | Y |  |  |  |  |  |  |  |  |  |  | 1 |  |  |
| TagsMini |  |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| TiltMini |  | 1 |  |  |  |  |  |  |  |  |  |  | 2 |  |
| LensMini |  | 1 |  |  |  |  |  |  |  |  |  |  | 3 |  |
| PhotoNumbers | Y |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### pose-estimate.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PoseExplorer |  | 6 |  |  | 2 |  | 4 |  | 2 | 4 |  | 2 | 13 |  |
| DofLadder |  |  |  |  |  |  |  |  |  | 4 |  | 2 | 1 |  |
| ProvenanceCard |  |  |  |  |  |  |  |  |  | 4 |  | 2 |  |  |
| RealPose | Y |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| PoseResiduals |  |  |  |  | 2 |  |  | 5 | 2 | 1 |  | 5 | 1 |  |
| Legacy |  |  |  |  |  |  |  |  |  |  |  | 3 |  |  |
| HeroPose | Y |  | 5 |  |  |  |  |  |  |  |  |  |  |  |
| Dial |  |  |  |  |  | 2 | 1 | 1 | 2 | 2 |  |  | 1 |  |
| Tag | Y |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| PoseExplainer | Y |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### rigi.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Registration |  | 4 |  |  |  | 2 | 5 |  | 1 | 2 |  | 1 | 3 |  |
| Constellation |  |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| Twelve | Y |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |

### skyline.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ViterbiScan | Y |  |  |  | 2 |  | 9 |  |  | 8 |  | 1 | 2 |  |
| CleanAndFuse |  | 1 |  |  |  |  | 4 | 1 |  | 4 |  | 1 | 1 |  |
| WeightStrip |  |  |  |  |  |  | 5 |  | 2 | 2 |  |  |  |  |
| Skyline |  |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### step-inside.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SplitRuler |  | 6 |  | 4 |  |  | 2 |  | 1 | 4 |  |  | 8 |  |
| ConfidenceDisc |  | 3 |  | 2 |  |  |  | 1 | 2 | 5 |  |  | 12 | 1 |
| Provenance |  |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| RealRange | Y |  |  | 2 | 1 | 1 |  |  |  | 6 |  | 2 | 3 |  |
| RealEye |  |  |  | 1 |  |  | 1 |  | 3 | 7 |  | 1 | 3 |  |
| RealCompression |  | 1 |  |  |  |  | 1 |  | 2 | 4 |  |  | 2 |  |
| RangeBar |  |  |  |  | 3 |  |  |  |  |  |  |  |  |  |
| AnchorCurve |  | 3 |  | 4 |  |  |  | 1 | 3 | 5 |  |  | 6 |  |
| RealSplit | Y |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| MiniBars |  | 3 |  |  |  |  | 1 |  |  |  |  |  | 1 |  |
| MiniEye | Y |  |  |  |  |  |  |  |  |  |  | 4 |  |  |

### tap-a-peak.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PinLock |  | 3 |  |  | 1 |  | 6 | 2 |  | 10 | 1 | 3 |  |  |
| PeakChooser |  | 3 |  | 1 | 1 | 1 |  |  | 1 | 4 |  |  | 4 |  |
| TapFrame | Y | 1 | 2 |  |  |  |  | 5 |  |  |  |  | 1 |  |
| OneTap | Y | 4 | 3 |  |  |  |  |  |  | 2 |  | 1 | 1 |  |
| MissBar |  |  |  |  | 1 |  | 1 |  |  |  |  |  | 1 |  |
| MissBars |  |  |  |  |  |  |  |  |  | 6 |  | 1 |  |  |

### terrain-sampler.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LevelRings |  | 1 |  | 4 |  |  | 1 |  | 1 | 5 |  | 2 | 7 |  |
| BilinearProbe |  | 3 |  | 4 | 1 |  | 1 |  | 1 | 7 |  | 6 | 7 |  |
| LevelCost |  |  |  | 1 |  |  |  |  |  | 2 |  | 1 | 1 |  |
| AskTheMap | Y |  | 1 |  |  |  | 1 |  |  |  |  | 1 | 2 |  |
| LevelsMini |  | 2 |  |  |  |  |  |  | 2 | 2 |  | 1 | 2 |  |
| BlendMini |  | 1 |  |  |  |  |  |  | 2 | 2 |  | 1 | 4 |  |
| HoleMini |  | 2 |  |  |  |  |  |  |  | 1 |  | 1 | 4 |  |

### terrain-snapping.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| RealEye |  | 4 |  |  | 4 |  |  |  | 2 | 1 |  | 1 | 3 |  |
| PeakReal | Y | 1 |  |  | 2 | 2 |  | 2 |  | 2 |  | 5 | 1 |  |
| Ledger |  |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| Hero | Y | 1 |  |  |  |  |  |  |  |  | 1 |  |  |  |
| MiniSvg |  |  |  |  |  |  |  |  |  |  |  | 1 |  |  |
| MiniPrior |  |  |  |  |  |  |  |  |  |  |  | 1 | 4 |  |

### viewport-inference.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HorizonLock |  |  |  |  | 2 |  | 3 |  |  | 2 |  | 2 | 1 | 1 |
| Read |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| CostLandscape |  | 5 |  |  | 1 |  | 3 | 2 | 3 | 2 |  |  | 3 |  |
| FullCircle |  | 2 |  |  |  | 2 | 3 | 1 |  | 4 |  | 1 | 5 |  |
| GateBar |  |  |  |  | 3 |  |  |  |  |  |  |  |  |  |
| ConfidenceGate |  |  |  |  |  |  |  |  |  | 7 | 1 | 1 | 1 |  |
| RealStory | Y |  |  |  |  |  |  |  |  | 2 |  | 1 |  |  |
| RealGrid | Y |  |  |  |  |  |  |  |  | 6 |  | 2 |  |  |
| RealGate |  |  |  |  |  | 1 | 1 |  | 2 | 2 |  | 1 | 2 |  |
| MeasuredStats |  |  |  |  |  |  |  |  |  |  |  | 4 |  |  |
| Legacy |  |  |  |  |  |  |  |  |  | 1 |  | 4 |  |  |
| ResidualStrip |  | 2 |  |  |  | 1 | 2 |  |  |  |  |  | 1 |  |
| CameraTable |  |  |  |  |  |  |  |  |  | 1 |  | 3 |  |  |
| ViewportInference |  |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### 2d. Per component, kit, shell and routes (current)


### AutoVisual.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AutoVisual |  |  |  |  |  | 1 |  | 1 |  |  |  |  | 6 | 1 |

### ConceptPage.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ConceptPage | Y |  |  |  |  |  |  |  |  | 1 | 1 | 2 |  |  |
| NodeCard |  |  |  |  |  |  |  |  |  | 1 | 1 | 1 |  |  |
| WhereItSits |  |  |  |  |  |  |  |  |  |  | 1 | 1 |  |  |

### OntologyPanel.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OntologyPanel |  |  |  |  |  |  |  |  |  | 6 | 3 | 2 |  |  |

### legendItems.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### loadPage.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### ConceptNotes.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| NotebookTrail |  |  |  |  |  |  |  | 1 |  |  |  |  | 12 | 6 |

### Ink.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Stroke |  |  |  |  |  |  | 3 |  |  |  |  |  |  |  |
| ExactStroke |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| HandText |  |  |  |  |  |  |  |  | 1 | 1 |  |  |  |  |
| Passes |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| Hachure |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| Stipple |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| HandDot |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |
| SketchDefs |  |  |  |  |  |  |  |  |  |  |  | 1 |  |  |

### NotebookMap.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Legend |  |  |  |  |  | 1 |  |  |  |  |  |  |  |  |

### PhotoStrip.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PhotoStrip | Y |  |  |  |  |  |  |  |  |  |  | 3 |  |  |

### figures.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SkylineSketch | Y |  |  | 4 |  |  | 3 |  |  |  |  |  | 8 | 2 |
| MissSketch |  |  |  | 3 |  |  |  |  | 1 | 1 |  |  | 7 | 2 |
| DemSketch | Y |  |  | 4 |  | 1 |  |  |  |  |  |  | 10 | 5 |
| SectionSketch |  |  |  |  |  |  | 2 |  | 1 | 1 |  |  | 9 | 3 |
| TallySketch |  |  |  |  |  |  |  | 1 | 1 | 1 |  |  | 8 | 3 |

### notes.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Cartouche.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Colophon.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Colophon |  |  |  |  |  |  |  |  |  | 4 | 2 | 1 |  |  |

### ContourField.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### FurnitureSheet.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### HachureRule.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| HachureRule |  |  |  |  |  |  | 2 |  |  |  |  |  | 1 |  |

### Legend.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PeakSymbol |  |  |  |  |  |  |  |  | 1 | 1 |  |  | 1 |  |
| TrigPointSymbol |  |  |  |  |  |  | 1 | 1 |  |  |  |  |  |  |
| GlacierSymbol |  |  |  |  |  |  | 1 |  |  |  |  |  | 5 |  |

### Marks.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SpotHeight |  |  |  |  |  |  |  | 1 |  | 1 |  |  |  |  |
| TrigPoint |  |  |  |  |  |  | 1 | 1 |  |  |  |  |  |  |
| HutBullet |  |  |  |  | 1 |  | 1 |  |  |  |  |  |  |  |
| StationStamp |  |  |  |  |  |  | 1 | 2 | 2 | 1 | 1 |  |  |  |

### Register.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### ScaleBar.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ScaleBar |  |  |  |  |  |  |  |  | 2 | 1 |  |  | 3 |  |

### SheetFrame.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### SheetMap.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sheet | Y |  |  |  | 4 |  | 11 |  | 6 | 2 | 1 |  | 6 | 1 |

### Signpost.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Waymark.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Painted |  |  |  |  |  |  | 1 |  |  |  |  |  | 1 |  |

### sheet-contour-runs.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SheetContourRuns |  |  |  |  |  |  | 1 |  |  |  |  |  |  |  |

### Blattuebersicht.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PhotoPickerRow | Y |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |
| Card |  |  |  |  | 1 |  |  |  |  | 3 |  |  |  |  |

### Ledger.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### SheetColophon.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Tafel.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TafelStage | Y |  |  |  |  | 4 |  | 2 | 6 | 3 |  |  |  |  |

### sheets.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Stroke |  |  |  |  |  |  | 2 |  |  | 3 |  |  |  |  |
| Txt |  |  |  |  |  |  |  |  | 1 |  |  |  |  |  |
| Ground |  |  |  |  | 3 | 4 | 9 | 4 | 3 | 3 |  |  |  |  |
| Mark |  |  |  |  | 1 | 3 | 1 | 3 |  |  |  |  |  |  |
| DemPatchImage | Y |  |  |  | 5 | 11 | 3 | 6 |  |  |  |  |  |  |

### Callout.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Callout |  |  |  |  |  |  |  |  |  | 1 | 1 | 1 | 1 |  |

### CodeRef.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| CodeRef |  |  |  |  |  |  |  |  |  | 1 |  | 1 |  |  |

### DemoImage.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Figure.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Figure |  |  |  |  |  |  |  |  |  | 2 | 2 | 2 |  |  |

### MarginNote.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Plot.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PlotSeries |  |  |  | 1 |  |  |  |  |  |  |  |  | 1 |  |
| PlotArea |  |  |  |  |  |  | 1 |  |  |  |  |  | 1 |  |
| Plot |  |  |  |  |  |  |  |  | 4 | 2 | 2 |  | 4 |  |

### Reveal.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### Section.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Section |  |  |  |  |  |  |  |  |  | 1 | 1 | 3 |  |  |

### Steps.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Flow |  |  |  |  |  |  |  |  |  |  |  | 1 | 3 |  |
| Steps |  |  |  |  |  |  |  | 1 |  | 2 |  |  | 1 |  |

### StoryMap.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| StoryMap | Y |  | 2 |  |  |  | 4 |  | 2 | 3 | 1 |  |  |  |

### explain.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Details |  |  |  |  |  |  |  |  |  | 2 | 1 | 4 |  |  |
| Compare |  |  |  |  |  |  | 1 |  |  |  | 2 |  | 2 |  |
| Stages |  |  |  |  |  |  |  |  |  | 1 | 1 | 1 | 1 |  |
| GalleryTile | Y |  |  |  |  |  |  |  |  | 1 | 1 | 1 |  |  |
| Mark |  |  |  |  |  |  |  | 1 | 1 | 1 |  |  | 1 |  |

### labels.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PrintLabel |  |  |  |  |  |  |  |  | 1 | 1 | 6 |  |  |  |
| PrintNote |  | 1 |  |  |  |  |  |  |  |  |  |  |  |  |
| HandRange |  |  |  |  |  |  |  | 2 |  |  |  |  |  |  |

### math.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Frac |  |  |  |  |  |  |  |  |  |  |  | 2 |  |  |
| Eq |  |  |  |  |  |  |  |  |  |  | 1 | 1 |  |  |

### real.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| PhotoLine |  |  |  |  |  |  | 4 |  |  |  |  |  | 1 |  |
| RealPhoto | Y |  |  |  | 1 | 1 |  |  |  |  | 1 |  |  |  |
| PeakLabels |  |  |  | 2 |  |  |  | 2 | 2 | 1 | 1 |  | 2 |  |
| DemPatch | Y |  |  | 1 | 1 |  |  | 2 | 2 | 1 | 1 |  | 2 |  |
| GeoBleed | Y |  |  |  | 1 | 2 | 1 |  | 2 | 2 |  |  |  |  |

### story.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### gipfelbuch.index.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

### gipfelbuch.print.tsx
| component | photo/raster | Print | Crisp | exact | rect | line | path | circ | text | mono | caps | box | sketch | hand |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SheetBody |  |  |  |  |  |  |  |  |  |  | 1 | 1 |  |  |

### 2e. Kit and shell: what is printed, file by file (current)

Exactness = **overlay** (data on photo/DEM pixels: keep geometry exact, pen-like stroke allowed) or **furniture** (free to sketch).

| File | Non-sketch elements | Exactness |
|---|---|---|
| `ConceptPage.tsx` | H1 `TYPE.display` (Source Serif 56, `:156`); claim dek serif italic (`:157`); lead Fira 20 (`:160`); kicker breadcrumb condensed caps (`:135`); `Ledger` (Fira 300 numerals); `PhotoPicker`; caption (`:192`); NodeCards `TYPE.h3`/caption/micro (`:313-330`); "Where it sits" `TYPE.h2` (`:402`) and kicker (`:398`); `SheetColophon`; `OntologyPanel`; `Signpost`s; back link. Hand: only `HandRule` (`:179`), FieldNotes, NotebookTrail, ContourField. | furniture |
| `tafel/Tafel.tsx` (`TafelStage`) | crisp `<line>` ×4, `<path>` ×2, `<circle>` ×2, `<text>` ×6 in mono; ruler; ridge-spill raster | overlay (photo) + furniture (ruler, names) |
| `tafel/sheets.tsx` | `Stroke` = dark casing + colour (`:170-192`), `Txt` mono/condensed, `Ground` (3 rect, 4 line, 9 path, 4 circle), `Mark`, `DemPatchImage` (5 rect, 11 line, 3 path, 6 circle). Feeds the Tafel layers and every Blattübersicht card. | mostly overlay on bake/DEM; ground/frames furniture |
| `tafel/Blattuebersicht.tsx` | cards with `TYPE.h3`/caption/micro, 6 `border-*`, a `<rect>`, the picker row | furniture |
| `tafel/Ledger.tsx`, `SheetColophon.tsx` | print stat numerals; colophon table, kicker, h3 | furniture |
| `viz/labels.tsx` | `PrintLabel` default **mono** Fira (`:24`), `PrintNote` sans, `HandRange` (plain circles, solid track) | labels: furniture-like (could be hand-small) |
| `viz/real.tsx` | `PhotoLine crisp` (3-path triple, `:313-341`), `CrispLine` (`:262`), `PeakLabels` condensed 600 plus mono heights (`:698-790`), `DemPatch` crisp cones and condensed labels (`:799-950`), `GeoBleed` compass ruler crisp `<line>`/`<text>`, `Measured` and `PhotoPicker` caps chips (`:632`) | overlay (lines, cones), furniture (ruler, chips, labels) |
| `viz/StoryMap.tsx` (new, untracked) | 2 `CrispLine`, 4 `<path>`, condensed `<text>` | overlay (DEM) |
| `viz/Figure.tsx` | caption number in condensed caps kicker, caption Fira 13, source and imprint in mono; `well`/`plate` paper-deep **flat rectangles**; "How to read" box | furniture |
| `viz/Section.tsx` | h2 Fira semibold 24, kicker caps, `PROSE` (Fira 16, code chips), `Stat` (Fira 300 numerals, caps label) | furniture |
| `viz/Callout.tsx` | flat tone wash rectangle, caps title; only the left rule is a `SketchPath` | furniture |
| `viz/Steps.tsx` | `Flow`: paper-deep **boxes** (`:38-46`), 13 px semibold labels; `Steps`: mono numbers, plain `<circle>` stations (`:179-185`), h4 Fira | furniture |
| `viz/Plot.tsx` | `PlotSeries` `data` exact (`:43-52`); tick labels `gb-coord` mono (`:166-192`); axis labels caps (`:215-230`); `PlotArea` solid tint `<path>` | series = data (could be pen within 0.9 px); axes furniture |
| `viz/explain.tsx` | `Beat` claim serif (`:59`) plus caps kicker; `Details` paper-deep slab plus caps summary; `Compare` handle `rounded-full` disc (`:216`) and caps chips (`:235-238`); `Stages` paper-deep panel plus caps tabs (`:322-336`); `Numbers` print; `Gallery` tiles caps plus micro; `Mark` label in Fira Mono (`:611`); `MarkList` mono | furniture (Stages/Compare wrap photos) |
| `viz/math.tsx` | `Eq` cards with border, `Frac` borders | furniture |
| `viz/CodeRef.tsx`, `DemoImage.tsx` | mono path chips; `rounded` image frames | furniture |
| `OntologyPanel.tsx` | 6 mono, 3 caps, border box | furniture |
| `swiss/Colophon.tsx`, `Register.tsx`, `Marks.tsx` | print tables and stamps, crisp `<circle>`/`<path>` in `StationStamp`/`TrigPoint`/`SpotHeight` | furniture (cartographic symbols, arguably should be crisp) |
| `swiss/SheetMap.tsx` | 4 rect, 11 path, 6 text from the baked sheet; **no PencilFilter any more** | real map: Tanaka/hachure baked, so crisp is defensible |
| `swiss/ContourField.tsx` | contour runs as plain paths; **PencilFilter removed** | furniture |
| `swiss/SheetFrame.tsx`, `Cartouche.tsx`, `Signpost.tsx` | print chrome (mono LV95 corners, caps, serif title in Cartouche) | furniture |
| `notebook/figures.tsx`, `NotebookMap.tsx`, `ConceptNotes.tsx` | still sketched (15 HandText, `nb-hand` paragraphs). 11 `data` marks in figures.tsx. | the surviving notebook |
| routes `gipfelbuch.index.tsx` | Cartouche (serif), `TYPE.body`, `TYPE.micro`, SheetMap, **Blattübersicht first** (`:89`), NotebookMap after a kicker (`:95-99`), footer `Legend` | furniture |

Native/HTML items that read printed on every page: `<details>` (Details), range inputs (solid track and thumb, `notebook.css:191-257`), `HandRange` (solid 3 px track and plain circles), and 3 `<table>`s (baseline-pipeline, viewport-inference, Colophon).

## 3. Central style levers, each with the single change that flips the most surface

| # | Lever (file) | Today | One change → surface flipped |
|---|---|---|---|
| L1 | **`viz/labels.tsx` `PrintLabel`/`PrintNote`** | `<text>` in Fira Mono (`mono = true`, `:24`) or condensed, with a paper halo | Render through `HandText variant="label"` (Shantell small; `splitPrintRuns` already keeps digits legible) and keep the `size`/`halo` API. **About 131 page labels in 15 pages flip at once** (eye-rule 16, step-inside 16, peak 12, photo-workspace 12, viewport-inference 11, tap-a-peak 11 …). Keep a `print` opt-out for tick numbers if wanted. |
| L2 | **`notebook/Ink.tsx` `data` semantics** (`SketchPath :456-460`, `SketchPolyline :478-485`, `PenLine :127`, `PenCircle :184`, `HandDot :594-597`, `ExactStroke`) | `data` returns the exact `<path>`/`<line>`/`<circle>` | Make `data` = one pass, `sketchify` tolerance 0.6 px, no taper, constant width ≥ 1.2. That is the S1 contract, and `notebook.check.ts:83-121` already asserts a sketched series stays within tolerance. **124 marks flip** (dem-anchoring 27, eye-rule 20, camera-roll 18, step-inside 13, figures.tsx 11 …) without moving data off its pixels. The KR1 acceptance check (`d` out == `d` in) must change accordingly. |
| L3 | **`viz/real.tsx` `PhotoLine` / `CrispLine`** (`:262-341`; `RealPhoto :548-565`, `PeakLabels :728`, `DemPatch :864-874`) | the `crisp` triple (halo + dark under-stroke + colour), always on | Keep the halo and dark under-stroke (they fix R7 contrast) but draw the top colour stroke with `SketchPath passes=1 tolerance≈0.5`, as S1 did at 0.65. Swap `PeakLabels`/`DemPatch` label `<text>` to hand-small with the dark halo. **Every RealPhoto, DemPatch and Tafel-style photo overlay on all 19 sheets flips**, plus 17 `CrispLine` users. Also make `DataLine` in dem-horizon (13) delegate to it. |
| L4 | **`tafel/sheets.tsx` `Stroke`/`Txt`/`Ground`/`Mark`/`DemPatchImage` and `tafel/Tafel.tsx` `TafelStage`** | crisp casing lines, mono text, plain rect/line/circle (about 70 elements) | Route `Stroke` through the L3 pen stroke, `Txt` through hand-small, and frames through `SketchRect`/`PenLine`. **This flips the hero of 4 sheets and all 19 Blattübersicht cards (the index's first screen).** |
| L5 | **`swiss/type.ts` `TYPE`** (+ `theme.css` `.gb-caps :86-92`, `.display-title :76-83`) | All roles print: kicker = condensed caps, caption = Fira, h2/h3 = Fira semibold, claim/display = Source Serif, micro = mono | Add `TYPE.hand` / `TYPE.handLabel` (`nb-hand`, `nb-hand nb-hand-small`) and repoint **`kicker`** (figure numbers, Section kickers, Beat kickers, Stages tabs, Gallery tags), **`caption`** (every figcaption) and **`claim`** (every Beat headline) to the hand. Keep `body`, `lead`, `h1`, `micro` and `stat` in print for legibility. One file restyles about 130 HTML labels (`TYPE.caption` ×74, `TYPE.kicker` ×23, `TYPE.claim`). Raw `gb-caps` is used ×30 outside TYPE, so also add a `.gb-swiss .gb-caps` hand override in theme.css (no uppercase, no tracking) to catch those. |
| L6 | **Font tokens** `swiss/fonts.css :330-343` (`--gb-font-condensed`, `--gb-font-hand-small`) | condensed = Fira Sans Condensed | Nuclear option: set `--gb-font-condensed` to the hand-small stack. Every `gb-caps`, `nb-label`, `.gb-table th`, the `PrintLabel condensed` labels, and `PeakLabels`/`DemPatch` (`CONDENSED_STACK` in real.tsx `:251`, StoryMap) go hand at once. Uppercase plus 0.12 em tracking in Shantell needs a rule tweak. It is a single line, but less controlled than L5. |
| L7 | **CI and the written rules** `src/lib/gipfelbuch/gipfelbuch.check.ts:328` (`MAX_HAND_NOTES = 3`), `PAGE_RULES :292-326` (`display-title`, `rotate-`); `components/gipfelbuch/README.md:13-14,55-58,106` ("Data is exact", PrintLabel); `best-of-both.md §2.4`; design-book L3/H2 | Lint fails a page with more than 3 `HandText`; agents follow "data exact / labels printed / never the hand" | Raise or remove the cap (or count only body-prose hand notes) and rewrite README §"Data is exact" back to the S1 rule (`README.md:113-136`: "every visualization drawn by hand", with data within tolerance). **Without this, any sweep fails `run.mjs fast` and future agents re-print it.** The README currently contradicts itself (lines 13-14/55-58 against 113-136). |
| L8 | **Wobble filters** `notebook/Ink.tsx` `SketchDefs` `#nb-wobble`/`#nb-grain` (`:617-680`, mounted in `ConceptPage.tsx:122` and `NotebookMap`); deleted `PencilFilter` (S2 `swiss/PencilFilter.tsx`, used in `SheetMap:64`, `ContourField:74`) | defined, **0 users** | One CSS rule in `theme.css`: `.gb-swiss figure svg:not([data-exact]) > g { filter: url(#nb-wobble) }`, with photo, raster and text groups opted out. That roughens every remaining plain `<rect>/<line>/<path>/<circle>` in figures (about 350) without touching code. Restore `PencilFilter` on `ContourField` and SheetMap line work. Perf was the reason it was cut (`peak-notebook-plan.md:174` row 10), so scope it to static SVG and skip animated ones. |
| L9 | **Box primitives** `viz/Figure.tsx` (`well`/`plate`/"How to read" flat paper-deep slabs, caption), `viz/Steps.tsx` `Flow` boxes (`:38-46`) and station `<circle>` (`:179`), `viz/Callout.tsx` wash, `viz/explain.tsx` `Details`/`Stages`/`Compare`/`Gallery`, `viz/Section.tsx` `Stat` | flat CSS rectangles with crisp edges and print labels | Give them one shared sketched edge: an absolutely positioned `SketchRect` (`Ink.tsx:491`) or a `PenRule` top and bottom (`:684`). Use `StepNumber` (circled hand numeral) for the Figure `number` and Flow/Steps stations. Every figure, Details block and Stages panel on all pages changes at once. |
| L10 | **`viz/Plot.tsx`** | series exact (`:43-52`), ticks `gb-coord` mono (`:166-192`), axis titles caps (`:215-230`) | Pick up L2 for the series; set the axis titles in hand-small; ticks can stay print (as in S1's README). Covers 11 `<Plot>` uses. |
| L11 | **`ConceptPage.tsx` shell + `routes/gipfelbuch.index.tsx`** | H1 Source Serif 56, serif italic dek, Ledger in Fira 300, OntologyPanel and colophon in mono; the index shows Blattübersicht first and NotebookMap below | Move `FieldNotes`/hand note higher (beside the Ledger), set the dek in the Caveat hand (a field-book subtitle), and on the index put `NotebookMap` before or interleaved with the Blattübersicht (conflict C1 in `best-of-both.md:197`). Affects the first screen of every sheet. |
| L12 | **`notebook/Ink.tsx` `HandText`** (`:286-353`) and **`notebook.css`** | digits forced to mono at 0.8 (`splitPrintRuns`, `PRINT_SCALE :57`); `.nb-hand` weight 500; grid 6 %/8 % (`:33-34`); `.nb-term` solid underline (`:110`) | Drop or soften print digits (Caveat numerals are legible at ≥ 16 px); restore the wavy `.nb-term` underline (soft, not a prop); grid to about 9 % (still "soft"). The grid and the underline are touched by the user's "softer" request, so confirm first. |

Sketchify defaults (`notebook/sketchify.ts:145-148`: tolerance 0.9, passes 2, overshoot 1.6; hachure tolerance 0.6 at `:476`) are **unchanged across all five snapshots**, so they are not the cause. The loss is entirely in *who calls* the sketch path: `data` short-circuits, PrintLabel and crisp lines.

## 4. Hand fonts: loaded? (static reasoning)

- **Caveat** (`GB Hand`) and **Shantell Sans** (`GB Hand Small`) are self-hosted. They live in `public/fonts/gipfelbuch/caveat-normal-400-700-latin{,-ext}.woff2` (75 KB + 30 KB) and `shantell-sans-normal-300-800-latin{,-ext}.woff2` (174 KB + 71 KB). All files start with `wOF2` magic and are git-tracked. The `@font-face` rules are at `swiss/fonts.css:225-263`, with `font-display: swap`.
- **CSS chain:**
  - The routes import `GB_THEME` from `swiss/palette.ts`, which runs `import "./theme.css"` (`palette.ts:9`).
  - `theme.css:6` has `@import "./fonts.css"`, which Vite inlines.
  - `notebook.css` (`.nb-hand`, `--nb-hand: var(--gb-font-hand)`) is imported by `swiss/index.ts:5` (ConceptPage and the index import the barrel) and by `NotebookMap.tsx:28`.
  - The tokens are declared on `.gb-swiss, .nb-book` (`fonts.css:326-343`, `notebook.css:11-36`). `SheetFrame` renders `.gb-swiss` (`:56`) and `.nb-book` (`:61`), and both routes wrap in `GB_THEME`, so SVG `<text class="nb-hand">` inherits the variables.
  - **Conclusion: Caveat and Shantell should render on every Gipfelbuch surface.** Nothing in the CSS shows the hand failing to load. The "lost" feel comes from how few elements use the hand, not from the fonts.
- **Architects Daughter / Kalam** (the S0/S1 hand) are **no longer loaded anywhere**. `HandFont` and `HAND_FONT_HREF` were removed. The root Google link (`src/routes/__root.tsx:19`) loads Fira, Fraunces, Plex Mono and Manrope, but no hand face. They survive only as names in the `--gb-font-hand` stack (`fonts.css:339-340`), so they resolve only if installed locally. If Caveat fails, the next face is `GB Hand Fallback` = local Comic Sans MS / Segoe Print with `size-adjust 71.91%`.
- Shantell's `font-variation-settings: "INFM" 35, "BNCE" 0, "SPAC" 10` (`notebook.css:68-71`) needs the INFM/BNCE/SPAC axes. `LICENSES.md` says the file includes them and the 174 KB size is consistent, but this was not verified: fontTools is not installed. If the axes are missing, the settings are ignored silently and the result is plain Shantell, which is still hand-like.
- The root still downloads Fraunces and Manrope from Google on Gipfelbuch pages. They are unused there (`gipfelbuch.check.ts:304` forbids naming them), so this is wasted bytes but has no style effect.

## 5. Suggested order (if the user wants the S1 feel with the S4 fidelity)

1. L7 first: relax the lint and rewrite the README rules. Otherwise CI and agents fight the change.
2. Kit flips: L1 (PrintLabel → hand-small), L2 (`data` → bounded pen), L3 (photo pen line over the dark under-stroke), L5 (kicker, caption and claim → hand). Together these touch nearly every figure on all 19 sheets, with no page edits.
3. L4 Tafel/sheets and L9 boxes, then L8 wobble as a catch-all for the remaining plain SVG.
4. Then a per-page pass only for leftovers: the plain `<rect>/<line>/<circle>` in viewport-inference (32 shapes), skyline (21), tap-a-peak (18), photo-workspace (17), pose-estimate (17) and dem-horizon (18 + 13 DataLine).
5. Keep the user's "softer" decisions (no grain, tape, tilt or margin rule). Keep R2 "fill encodes": solid fills can carry a hachure on top and still read as sketched.
