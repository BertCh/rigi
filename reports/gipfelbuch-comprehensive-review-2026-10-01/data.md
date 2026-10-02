# Gipfelbuch data, graph and loader review (read-only, 2026-10-01)

Scope: src/lib/gipfelbuch/{graph,graph-utils,ontology,types,gipfelbuch.check}.ts, public/demo/gipfelbuch/**,
scripts/gipfelbuch/*, loaders (viz/real.tsx, tafel/useTafelBake.ts, notebook/useNotebookPhoto.ts, per-page
fetches), tafel/sheets.tsx + Ledger.tsx. Nothing in the repo was edited. All claims below were checked with
node/tsx scripts against the committed JSON (scratchpad: xcheck.js, ledger.ts, graph.ts, onto.ts).

## Checks run

`node scripts/ci/run.mjs fast --only gipfelbuch,gipfelbuch-contrast,gipfelbuch-notebook,tafel,tafel-sheets`
gave 5/5 PASS: 19 nodes, 47 edges, 11 rels; 19 sheets, 684 ledger items, 228 bands; 12 Tafel bakes.
`gipfelbuch.check.ts --strict` also passes (0 warnings). It links 12 of 48 concepts and 4 of 37 methods.

## What is clean (verified)

- graph.ts has 19 unique kebab ids and 47 curated edges, with no dangling, self or duplicate edges and no
  isolated node. `LINKS` holds 48 (one ontology-derived edge). Every `modules`/`reports` path exists and is
  git-tracked. Every path string in the prose summaries resolves.
- Every `ontologyId` and `methodIds` value is valid. The import boundary holds (only ontology.ts imports
  src/lib/ontology).
- Every baked JSON `script` path exists and is tracked (build-data, data-*). So do the source paths
  (src/lib/geo/control-points.ts, public/demo/step/scene.json, scripts/demo/bake-step.mjs,
  tools/nearfield/spike/place.json).
- The `demPatch.halfKm` "0 km" bug is fixed everywhere: sheets.tsx:1708-1711 and 1768 pass `scale: 1`. The
  other halfKm consumers (real.tsx:406/877/1007, StoryMap.tsx:99, NotebookMap.tsx:267, figures.tsx:534-569,
  sheets.tsx:1082/1133) already treat it as km.
- Cross-file agreement holds for all 12 photos:
  - index.json against demo-NN.json: peaks, labelled, confidence, stage, residual, ms.
  - pose-solve priorYaw and ambiguity.
  - step-inside/eye.json, eye-rule terrarium ground/eye and terrain.json eyes.
  - roll.json solvedYaw/hfov/yawOffset.
  - Tafel camera against solved (accepted) or app (refused).
  - peak.json profile eye against demo-10.
  - tap truth against solved.
  - index groundTruthEval is byte-identical to the local out/eval*/report.json.

## Findings

### Bugs

1. **Stale bake: tap/demo-10.json was baked from an older demo-10.json.**
   - tap/demo-10.json `labelledNames` and every `steps[].peaks` have 22 entries, with Breithorn and
     Ankenbälli each listed twice. The current demo-10.json has 20 labelled peaks.
   - data-tap.ts:78 derives these from `d.peaks.filter(p => p.labelled && p.solved)`, so the two files were
     baked from different build-data outputs.
   - The tap-a-peak figures (HeroTaps, OneTap, TrioFrame, MissBars) draw 22 peak shifts while the demo json
     says 20.
   - Fix: rerun `npx tsx scripts/gipfelbuch/data-tap.ts`. Then add a cross-file assertion (see 9).

2. **`ms.terrain` is 0 for demo-02..12.** build-data.ts:139-149 times `loadTerrain` with the shared `tiles`
   cache (line 50), so only the first photo pays the tile cost.
   - The terrain-sampler ledger then prints "0 ms to sample the tile" on 11 of 12 photos (sheets.tsx:1727).
   - The same 0 feeds baseline-pipeline.tsx:1037, 1273 and 1645, and the "ms end to end" sum at
     sheets.tsx:1702.
   - Fix: time with a fresh tile Map per photo, or record `cached: true` and drop the stat. Alternatively,
     replace the ledger item with `ms.horizon`.

3. **Two different "visible summits" counts for the same photo.**
   - data-peak.ts:76-81 counts in-frame peaks strictly in [0,W]x[0,H]: demo-01 175, demo-10 257.
   - build-data.ts:217-224 keeps a ±20 px margin: demo-01 178, demo-10 260. The Tafel "peak" sheet value
     (sheets.tsx:1760, `d.peaks.filter(p=>p.visible).length`) and index.json `peaks` use this margin.
   - The peak page reads peak.json (peak.tsx:1446, 1710), so the sheet value line and the page body
     disagree. The regression report's "260 vs 257" item is therefore still open between the shell and the
     page.
   - Fix: use one frame rule. Either bake `inFrame` with the same margin in both scripts, or have
     sheets.tsx read a stored `counts.visible` per photo.

4. **Mislabelled ledger stat.** sheets.tsx:1675 shows `peaks.length` as "summits in the catalogue" (218 for
   demo-01).
   - `peaks` is the in-frame visible set plus at most 40 hidden peaks (build-data.ts:241-245). The real
   catalogue is about 1,122 named peaks (terrain.json `peakRule.n`).
   - Fix: relabel it "named peaks near the frame", or switch to visible-labelled.

5. **The page picker promises something the figures do not do.** ConceptPage.tsx:288-291 says "every
   number on this sheet is re-read from its measured run". These figures ignore the picked photo while the
   header ledger follows it (R9):
   - **Heroes** (PAGE_HERO pages):
     - rigi HeroStages (rigi.tsx:401, demo-01)
     - eye-rule HeroStages (eye-rule.tsx:1177, demo-09)
     - dem-anchoring HeroStages (dem-anchoring.tsx:1424, demo-01)
     - terrain-snapping Hero (terrain-snapping.tsx:728, demo-03)
     - tap-a-peak HeroTaps (tap-a-peak.tsx:1071, demo-10)
     - peak RealSummits (peak.tsx:1335, local state starting at demo-10)
     - camera-roll HeroStages (camera-roll.tsx:1806, demo-03)
     - step-inside: its split.json is IMG_7086, not a demo photo.
   - **Other figures:**
     - rigi GuessVsSolved and Outcomes (rigi.tsx:499, 559, demo-03)
     - dem-anchoring MiniWindow (dem-anchoring.tsx:1622, demo-01)
     - eye-rule EyeEquation (eye-rule.tsx:1235, demo-09 row)
     - terrain-snapping RealEye (terrain-snapping.tsx:368-371, demo-09)
     - peak HiddenSummit, RealOcclusion and HiddenMini (peak.tsx:913, 1500, 1673, demo-10), YawSlide and
       MiniDem (peak.tsx:1181, 1330, demo-01), and the Page counts (peak.tsx:1707-1710, demo-01 and demo-10)
     - photo LensEquation (photo.tsx:1084, demo-02) and PhotoNumbers (photo.tsx:1126, demo-09)
     - pose-estimate CompassShift (pose-estimate.tsx:1821, demo-09)
     - accept-rule TwoSolvers (accept-rule.tsx:1642, demo-01) and RealDecisions/ScoreFit (accept-rule.tsx:268,
       1668, local demo-11)
     - tap-a-peak OneTap, TrioFrame and MissBars (tap-a-peak.tsx:1133, 1065, 1331-1401). Tap bakes exist
       only for demo-01, 09 and 10.
     - camera-roll RealRoll (camera-roll.tsx:1297)
     - Every terrain.json figure on dem-source, dem-anchoring, terrain-snapping and terrain-sampler: the
       bake is for the demo-01 site only.
   - Already fixed: terrain-sampler AskTheMap (terrain-sampler.tsx:1015) follows the pick and labels the rest
     "fixed: demo-01".
   - Unlabelled: rigi Outcomes (rigi.tsx:559) and dem-anchoring MiniWindow (dem-anchoring.tsx:1622) never
     name their photo in the caption.
   - Fix:
     - Drive the hero from `useNotebookPhoto()` wherever per-photo data exists (rigi, eye-rule,
       dem-anchoring, terrain-snapping, camera-roll).
     - Everywhere else, add a "fixed: demo-NN" note.
     - Change the picker sentence to "the header and hero are re-read…".

6. **Fetches that fail stay on the loading state forever, with no error UI.**
   - real.tsx:195-210 `useJson` logs `console.warn` and keeps `null`.
     - ConceptPage hides the ledger (`figures && data &&`, ConceptPage.tsx:263).
     - Figures show "Loading measured data." pulses indefinitely (e.g. terrain-sampler.tsx:1007-1011).
     - It also does not reset `d` when `url` becomes null (`if (!url) return` comes before `setD(null)`),
       so stale data can show.
   - Loaders that cache the rejected promise for the whole session (no retry after a transient failure):
     - tap-a-peak.tsx:819-820 (`tapCache`, no `r.ok` check)
     - peak.tsx:897-900 (`peakDataPromise ??=`, no `r.ok`, error swallowed by `.catch(() => {})`)
   - Loaders with no `r.ok` check:
     - camera-roll.tsx:1273 (no cache)
     - baseline-pipeline.tsx:1824 (`poseSolveCache` does reset on failure)
   - Only useSheet.ts (with a `status: "error"`) and useTafelBake.ts (null on HTML fallback) handle errors
     on purpose.
   - Fix: have one loader in real.tsx return `{status, data}` with an `r.ok` check, a content-type check and
     cache eviction, render a "data missing: <path>" state, and route all page fetches through it.

### Risks

7. **The bake cannot be reproduced from a clean clone.**
   - index.json `groundTruthEval` comes from gitignored `out/eval*/report.json` (build-data.ts:449-466). It
     is written as `null` without a warning when those files are absent, and accept-rule and
     baseline-pipeline Fig. D5 then render nothing.
   - The comment there says "12 hand-registered photos", but the data has 19 rows (14 with GT).
   - Fix: fail or warn when the reports are missing, keep the old rows, and fix the comment. Alternatively,
     commit a pinned copy under public/demo.

8. **Bake order is undocumented and implicit.**
   - data-tap, data-peak, data-sheet, data-tafel, data-terrain, data-camera-roll and data-step-inside all
     read `public/demo/gipfelbuch/demo-NN.json`. Rerunning build-data without them produces item 1.
   - The README (src/components/gipfelbuch/README.md:201-205) documents only build-data. No npm script or
     driver exists.
   - data-camera-roll.ts:25/66 and data-step-inside.ts:16/53 use cwd-relative paths, unlike the others,
     which use `ROOT`.
   - Fix: add `scripts/gipfelbuch/bake-all.ts` that runs them in dependency order, and switch to ROOT paths.

9. **No CI check reads the baked JSON across files.** sheets.check and tafel.check validate one file at a
   time. Fix: add a `gipfelbuch-data` fast check covering:
   - script paths exist
   - index against demo json
   - tap labelledNames against demo labelled (would catch item 1)
   - peak.json counts against the demo json frame rule (would catch item 3)
   - eye/roll/sheet against solved
   - `ms.terrain > 0` (would catch item 2)

10. **Refused photos (demo-07, demo-11) get three different cameras.**
    - sheet.json viewpoints use compass yaw with the *solved* hfov (data-sheet.ts:475-476): 5.0° vs 3.22°.
    - The Tafel uses the app camera (3.16°).
    - The ledger prints the refused solve as "where the terrain says 3.2°" and "aligned to 1.6 px"
      (camera-prior, rigi sheets).
    - Fix: pick one fallback per refused photo, or mark refused values in the ledger.

11. **The Fig. D4 vs D5 contradiction is visible on one page.**
    - baseline-pipeline.tsx:706/735 hard-codes "solvePose alone 8, refine rescues three (7063, 7068, 7155)"
      from the 09-24 README.
    - Fig. D5 (baseline-pipeline.tsx:1365+) computes 9 and two rescues (IMG_7068, IMG_7155) from the baked
      eval.
    - Fix: drive D4 from `groundTruthEval`, or drop its numbers.

12. **Name homonyms in the peak lists.** demo-10 has two Breithorns, two Rotstocks and others.
    - `peaks.find(p => p.name === …)` takes the first match: peak.tsx:917, peak.tsx:1523,
      terrain-snapping.tsx:730.
    - tap demo-10 "Breithorn" (3780 m, 27.0 km) resolves to a different Breithorn (3784 m, 33.7 km) by name.
    - Fix: match on name plus az/distance, or bake stable peak ids.

13. **Gaps in sheets.check.ts:85-98.**
    - It accepts *either* the scaled or the raw value, so a `%` fraction printed unscaled ("1" for 0.695)
      passes.
    - It duplicates `UNIT_SCALE` instead of importing it.
    - Fix: assert against the declared `scale ?? UNIT_SCALE[unit]` only, with `scale` exported in
      `LedgerItem`.

14. **Gaps in gipfelbuch.check.ts.**
    - The "tilted print" rule `(?<![\w-])rotate-\d` (line 299) misses `-rotate-N`. KR11 specified
      `\brotate-\d`. No page uses it today.
    - The page lint covers only src/lib/gipfelbuch/pages, not components/gipfelbuch.
    - Paths are checked with `existsSync`, not git-tracked.
    - Lede ≤30 words (types.ts) is not checked.
    - KR11's "more than 3 `<HandText`" cap is inverted to "at least 6", per the later hand pass. That is
      correct per memory, but best-of-both.md:233 is stale.
    - tafel.check.ts prints SKIP but exits 0 when no bakes exist, so run.mjs reports PASS.

### Cleanup

15. ontology.ts:60-61: an orphaned doc comment ("Every concept id in catalogue order") sits on the
    `storageKey` re-export.
16. Node `modules` omit several ontology realizations named in the same summaries:
    - photo: upload/store.ts, geo/photo-meta.ts
    - dem-horizon: horizon-fast/march.ts, peakfix/layered.ts, pose6dof/eye.ts
    - pose-estimate: integration/*, demo/index.ts
    - peak: picker/candidates.ts, export/geojson.ts
    - step-inside: nearfield/types.ts

    It is harmless, but the rail lists differ from conceptView.
17. useNotebookPhoto.ts:37-48 starts on demo-01 and then switches to the stored id after mount, which
    fetches demo-01 needlessly and makes the page flash. It has no `storage` listener for other tabs. Fix:
    lazy initial state from `readStored()` on the client.
18. terrain-sampler ledger "heightAt() under the camera" (sheets.tsx:1722) is Terrarium (1886.1 m), while
    Fig. 1 point 1 is Mapterhorn (1934.3 m). The caption explains this. Add "(Terrarium)" to the ledger label.
19. Date stamps disagree: demo json `generated` 2026-10-01, tafel and sheet 2026-10-02, imprint
    `STAND = "2026-10"` (ConceptPage.tsx:57, a hand-updated constant).
