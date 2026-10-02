# Gipfelbuch comprehensive review (2026-10-01, late)

Scope: `/gipfelbuch` (index, 19 concept sheets, `/gipfelbuch/print`, `dev.gipfelbuch-sheet`), the kit in `src/components/gipfelbuch/**`, `src/lib/gipfelbuch/**` and the baked data in `public/demo/gipfelbuch/**`.

Method: six read-only reviewers covered the kit and shell, data and graph, three page clusters, and a11y/theme/print/routing. Their detailed findings, each with file:line and a fix, are in `gipfelbuch-comprehensive-review-2026-10-01/{kit,data,pages-A,pages-B,pages-C,a11y}.md`. Nothing was rendered (cook mode), so the clipping and label-size items are estimates from geometry. Line numbers are as of HEAD `6c02f47` plus the uncommitted tree at about 23:30. mt-image-32 has since claimed `src/components/gipfelbuch/**` and `pages/**`, so the numbers will drift.

Gates run: the fast checks `gipfelbuch`, `gipfelbuch-contrast`, `gipfelbuch-notebook`, `tafel` and `tafel-sheets` all passed at the start. `tafel-sheets` then failed (see K2). `tsc` reported 0 errors in Gipfelbuch paths. Biome reported 9 warnings and 1 info, with no errors.

## Status of the earlier regression list (`gipfelbuch-regression-2026-10-01.md`)

| Item | Status |
|---|---|
| R1 wide figure track | Fixed on concept pages (`viz/Figure.tsx:83-87`). It breaks `/print` (K1). |
| R2 hatch vs fill | Mostly fixed. Still hatch-only: camera-prior Fig 2 bars, terrain-snapping RealEye bars (and their comment wrongly says "solid"), viewport-inference confidence and factor bars. |
| R3 Stat overflow | Partly fixed. Values no longer wrap, but long values now spill sideways into the next cell in fixed 4-column grids (`viewport-inference.tsx:1755,1777`). |
| R4 red-on-red chips | Fixed (`swiss/theme.css:109-118`). The same unlayered-override pattern remains at `theme.css:84-92,104-107`. |
| R5 figures in Details | Mostly fixed (GuessVsSolved, RealRoll, MissBars, HiddenRings are back in the body). |
| R6 imprint default | Fixed (`real.tsx:427`). |
| R7 overlay contrast | Fixed, but fading a line leaves its halo and under-stroke at full opacity (K3). |
| R8 Flow / Conveyor | Fixed. The baseline refinePose label now overruns the viewBox. HowItWorksScene still uses viewport breakpoints. |
| R9 picker vs fixed figures | **Open on most pages.** See D5. |
| `halfKm` "0 km" | Fixed. |
| 260 vs 257 visible peaks | **Open** (D3). |
| terrain-sampler stale colour words | Fixed. 1886 vs 1934 m is now explained in the caption, not unified. |
| eye-rule Fig 4 overprint, baseline Conveyor clipping, viewport heat-map encoding | Fixed. |

## P0: correctness bugs (wrong output)

**Data and bake**
- **D1. Stale tap bake.** `tap/demo-10.json` has 22 labels (Breithorn and Ankenbälli twice) against 20 in `demo-10.json`. `tap-a-peak.tsx:880` pairs the two lists by index, so from index 9 on the leader lines join the wrong peaks. Fix: rerun `data-tap.ts` and pair by name (and peaks are looked up by name even though names repeat).
- **D2. `ms.terrain` is 0 for demo-02 to demo-12.** The shared tile cache in `build-data.ts:139-149` means only the first photo pays the load. The terrain-sampler ledger shows "0 ms" on 11 sheets, and baseline sums include those zeros.
- **D3. Two visible-summit counts.** `data-peak.ts:76` counts strictly in frame (257). `build-data.ts:217` adds a ±20 px margin (260). `sheets.tsx:1675` also labels `peaks.length` "summits in the catalogue", when the catalogue holds about 1,122.
- **D4. Three values for "median compass error".** 9.6° counts accepted photos only (viewport-inference front, camera-prior Numbers). 7.9° counts all 12 (viewport Details, pose-estimate, camera-prior Details). The px counterpart is 2.0 vs 2.4. Pick one definition and label it.
- **D5. R9: the shell promises "every number on this sheet is re-read"** (`ConceptPage.tsx:285-293`), but these heroes are fixed to one photo: rigi:401 (demo-01), eye-rule:1177 (demo-09), dem-anchoring:1424 (demo-01), terrain-snapping:728 (demo-03), tap-a-peak:1071 (demo-10), camera-roll:1806 (demo-03). About 20 more figures are fixed too, and rigi:559 and dem-anchoring:1622 never name their photo. Prose fixed to one photo is just as wrong under the picker: pose-estimate:1504,1612,1630, the demo-03 numbers in dem-horizon:1844,1998, and terrain-sampler:1016-1040, which draws demo-01's position for any picked photo.

**Kit and shell**
- **K1. `/gipfelbuch/print` overflows on screen at 1024 px and up.** `Figure` and `Numbers` assume the concept-page grid.
- **K2. `tafel-sheets` fails in the current tree.** The untracked `viz/GeoSpill.tsx:11` imports `tafel.css`, and `real.tsx:23` pulls it into the node check. It belongs to session 0b (live plates; see the gipfelbuch-live-plates memory).
- **K3. Faded photo lines** (`real.tsx:340-361`): the fade does not apply to the halo and under-stroke.
- **K4. `swiss/print.css` is unscoped.** `nav{display:none!important}` and the A4 `@page` leak to every route printed after a Gipfelbuch visit. `[class*="opacity-0"]` (`:42`) reveals the native slider inputs over the hand-drawn sliders.
- **K5. Photo pick blanks the sheet.** The loader resets to empty on each switch (`real.tsx`), so the ledger and photos flash with layout shift.
- **K6. A failed fetch leaves a skeleton forever.** `useJson` (`real.tsx:194-210`) only warns. `peak.tsx:897` and `tap-a-peak.tsx:819` cache the rejected promise and don't check `r.ok`.

**Pages**
- **Undefined tokens:** `--gb-faint` (`dem-source.tsx:245,253`), `--gb-blue` (`terrain-snapping.tsx:920`), and `--accent` on the print route (about 60 uses; the selected-photo outline at `viewport-inference.tsx:1587` disappears).
- **dem-source:868:** slider `min` is 2 instead of 200, so the left 38 % of the track is dead.
- **dem-anchoring:441:** `Chip` is defined inside a component that re-renders every frame, so its buttons remount and lose focus.
- **camera-prior:491:** shows a raw float ("29.397090027280996").
- **camera-roll:494-498:** under reduced motion the viewpoint walk shows 1 of 8 photos.
- **photo:862-869:** the "19° off" arrow points at Tilt instead of Compass.
- **rigi:**
  - The ① and margin note at `:669-673` point into a collapsed Details.
  - The D1 note at `:265` overprints the 0° ruler label.
- **Stale figure references:**
  - eye-rule `(Fig. 5)` should be D2 (`:1475`).
  - step-inside "Fig. 1/2/3" should be D1–D3.
  - photo-workspace "lock row" points into Details.
- **Overruns:**
  - dem-horizon:480: the "best so far" note runs past the figure edge.
  - baseline:388-404: the refinePose label runs past the viewBox.
  - terrain-snapping:350: probably overflows too.

## P1: accuracy (the prose says something the code or data contradicts)

**rigi**
- Says "all on the CPU" (`:748`), but the GPU paths are now the default.
- "17/17 HIGH" is the matcher service, not the app (`:729`).

**photo**
- "Only yaw and position are left" (`:752,1219`): GPS fixes the position.

**camera-prior**
- Says magnetic headings are converted to true north (`:1076`). Only the MAP adapter does this; `geoDecl` is off.

**peak**
- "Same px per degree, whatever the peak" (`:1219,1845`) is wrong: 32–47 px at 3°.
- "Snapped onto the real ridge" (`:1743`) overstates a 60 m max-height lookup.

**tap-a-peak**
- "Taller C offered first" (`:594`): C ranks 5th at the default slider position.

**photo-workspace**
- "App and solved pose agree within 1°": demo-11 differs by 1.23°.

**camera-roll**
- "Four bursts": the timestamps give six.

**accept-rule**
- Omits "refined" from the certain states (`candidates.ts:223`).
- The gates table cites the wrong files (`unknown-pose-core.ts:40,47`, `matcher-client.ts:137`).
- The held-out test (11/11, 0 gross) is missing.

**viewport-inference**
- The IMG_7053 −123.7° false accept is credited to the wild benchmark. It came from the heading-removed ablation (`bench-ablation.md:332`); `solve.ts:266` and `geo/README.md` repeat the error.

**pose-estimate**
- "Rejected photo keeps the phone's pose" (`:1950,1964`): it shows the aligner's pose.
- "Only auto counts as accepted" (`:889`): auto counts only once the second opinion confirms it.

**baseline-pipeline**
- Timings are stale: 4.7 s / 150 / 95 ms, against 4.30 s / 161 / 97 ms in the data, which its own `PipelineNumbers` computes.
- Fig D4 says "8 accepted, refine rescues 3", but D5 computes 9 and 2.

**Code references that no longer exist**
- `buildPeaks` (terrain-snapping:1127).
- `engine.ts` (eye-rule:55,1480).
- The ledger label "heightAt() under the camera" (`sheets.tsx:1722`): `heightAt` belongs to the mesh.

**Mapterhorn zoom table**
- Missing the 6–15 km band (dem-source:1127, terrain-sampler:1484).

**Copy regressions**
- Two earlier copy fixes are undone: skyline:659 and dem-anchoring:1446.

**Stale colour words**
- skyline:1341 "yellow" for a green line.
- camera-prior:1497 "cyan" for a teal line.
- accept-rule:280,731.
- step-inside:1001,1309,1549.
- dem-horizon equation colours (`:1568-1621`) and its depth caption (`:838`).
- The dem-source and terrain-snapping maps swap which colour stands for which source.

## P2: accessibility, theme, print

**Screen reader and keyboard**
- `role="button"` groups sit inside `role="img"` SVGs, which hides them from screen readers: photo-workspace:956, camera-prior:360, camera-roll:1371,1540.
- Several of those buttons respond to Enter only, not Space, and none reports a selected state.
- `accept-rule:566` is a button that does nothing.
- `baseline:1275` is a clickable `<tr>` that the keyboard cannot reach.

**Contrast**
- `--nb-faint` text measures 3.63:1 in 12 places.
- `SiteNav` without `variant="paper"` gives 3.99:1.
- `contrast.check.ts` uses an out-of-date paper colour and covers no colour set in TSX, no text over photos, and no SVG text.

**Theme and print**
- No `color-scheme: light` on `.gb-swiss` / `.nb-book`: native controls render dark under the dark theme, and the theme toggle does nothing here.
- Print keeps all 19 Details closed, so the engineer notes are dropped.
- Stepper and compare figures print only their current state.

**Text size and fonts**
- About 190 text uses at 11 px or below in a hand font. Labels sized against the figure width render at about 5–6 px on a 390 px phone.
- Add a minimum label size to the kit.
- About 460 KB of hand fonts per page, none preloaded. The root preloads Fira Sans, which the body doesn't use. `GB Sans Condensed` (101 KB) is never used.

**Routing**
- An unknown concept renders an in-page message, not a 404.
- Pages set a title but no description.
- The `dev.gipfelbuch-sheet` stub ships to production.

## P3: architecture and size

- **Four overlapping kits.** `viz`, `notebook`, `swiss` and `tafel` overlap rather than layer:
  - 4 circled-number components;
  - 2 hand-text components (`HandLabel` / `HandText`);
  - 2 pen-stroke implementations;
  - 3 scale bars;
  - the seeded hash copied 7 times;
  - the colour-name lookup 4 times;
  - the JSON fetch-and-cache 5 times;
  - `useWidth` 5 times.
- **Dead code:**
  - 14 never-rendered components in `notebook/carto.tsx`, which the README advertises.
  - `DemoImage` and `LEGEND_BY_CONCEPT`.
  - `NoImprint`, which now does nothing.
  - `AutoVisual`: a node-link graph, which the README forbids. It recomputes paths every frame and only shows as the fallback.
- **Pages are 1,200–2,400 lines; 60–85 % of each is the old page inside `<Details>`**, often repeating front figures. Per-page copies to merge into the kit:
  - `useTerrainData` (4×);
  - crop helpers (4×);
  - slider wrappers (4×);
  - `median` (6×);
  - `angDiff`/`cone`;
  - chips;
  - `ROLL_IDS`;
  - skyline's `bandCrop` (= `skylineBand`), and its own `rejectSpikes`/`fuseSkylines`, which it could import.
- **Two pickers for one state:** skyline and dem-horizon each have a second photo picker for the header's state.
- **Lazy-load the Details content** as a separate per-page chunk; that would roughly halve every page module.
- **Stale README:** it still says "print is the form", "seven sizes", "serif Stat", "Plex Mono" and describes the rail.

## Check gaps (why these got through)

- No check compares baked JSON files against each other. Such a check would have caught D1–D3.
- `sheets.check.ts:95` accepts either the scaled or the raw value, so a percentage printed unscaled would pass.
- `tafel.check` reports PASS when no bakes exist.
- The KR11 tilt rule misses negative rotations.
- `index.json`'s ground-truth eval is read from gitignored `out/eval*`, so on a clean clone it is silently written as null.
- The bake order is undocumented, and no driver script runs it.

## Suggested order

1. **Minutes, kit only:**
   - scope `print.css` (K4);
   - fix the undefined tokens and the dem-source slider min;
   - hoist `Chip` in dem-anchoring;
   - add an error state and `r.ok` checks to the fetch hooks (K6);
   - move the GeoSpill CSS import out of the node check's import graph (K2).
2. **Data:**
   - rebake tap and pair by name (D1);
   - time the terrain load per photo (D2);
   - one visible-peak definition (D3);
   - one compass-error definition (D4);
   - add a cross-file bake consistency check.
3. **R9:**
   - make each hero follow the picker or label it "fixed: demo-NN";
   - soften the shell's promise until all heroes follow;
   - remove prose fixed to one photo.
4. **The P1 accuracy list.** It is copy-only and safe to do in one sweep.
5. **The a11y items**, plus `color-scheme: light` and opening the Details for print.
6. **Kit consolidation:**
   - merge the duplicated primitives;
   - delete the dead code;
   - lazy-load the Details;
   - update the README.
7. **Browser batch**, under the render lock with `?renderer=` pinned:
   - all 19 sheets plus `/print`;
   - confirm K1, the label sizes and the overruns.
