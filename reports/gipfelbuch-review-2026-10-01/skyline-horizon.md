# Gipfelbuch review: Skyline & DEM horizon (2026-10-01)

Pages: `src/lib/gipfelbuch/pages/skyline.tsx`, `src/lib/gipfelbuch/pages/dem-horizon.tsx`. Code read: `src/lib/geo/skyline.ts`, `src/lib/geo/horizon.ts`, `src/lib/geo/terrain.ts`, `src/lib/geodesy.ts`. Data: `public/demo/gipfelbuch/demo-NN.json`, `index.json`. Nothing here was re-measured; numbers come from those files and `reports/`.

## skyline

Correctness (Details checked against code: the 8-term sky basis, 4 IRLS Cauchy passes, step 4 px, bands max(8, 15%/20% h), FAR_ABOVE 0.2, edge cap 0.35, edgeWeight 60, jumpCost 2, jumpCap 80, refinePasses 1, minWeight 0.1, weight = contrast x polarity x sky above x (1 - sky below). All match `skyline.ts` lines 221-590.)
- Numbers overclaimed by omission. "0.30° / 11 of 11 within 1°" is the app matcher summary "skyline auto" row (`reports/leaderboard.md:207`) on 11 curated ground-truth photos, not a held-out set. On the 100-photo blind wild set the app's skyline aligner accepted 60 and 39 were correct (precision 0.64, 19 gross errors; `reports/bench-wild.md:16,50,72`). The page showed only the flattering one. Fixed: both are shown, with the caveat.
- "The solver never looks at pixels" is false for refinePose/render-match. Reworded to "the pose search".
- Fig. numbers were out of order (1, 2, 4, 3, 5). Fixed (3 = Viterbi, 4 = hard cases).
- Slider label "the path barely moves: sky evidence dominates" was never measured. Removed.
- File header comment was stale ("Cauchy-free", Fig. 1 described as synthetic). Rewritten.
- Literature (verified only at abstract level: https://mlanthology.org/eccv/2012/baatz2012eccv-large): Baatz et al. match photo contours to DEM skylines. I could not fetch the full text, so claims about their segmentation method are not made on the page.

Phenomenon and visibility: the key idea is "one row plus one confidence per column, chosen jointly by DP". Real-photo hero (Stages) and real Fig. 2 show it well; the synthetic Viterbi figure shows the DP. What was missing was the math tying them. Added one equation under Fig. 3: argmin over y of sum of U_x(y_x) + min(lambda |dy|, T), with y coloured like the yellow detected line, lambda = 2 px, T = 80 px (code defaults). The Viterbi path is now drawn in the same yellow.

Copy: Where-it-fails now carries the wild-set failure (no method solved 8 of 10 dusk and 21 of 36 hazy photos; `bench-wild.md:80-86`, "any correct" counts across all methods, not this detector alone). Numbers row now has denominators and a source line. Visible copy is about 430 words.

## dem-horizon

Correctness (horizon.ts matches the Details: step 0.05, 150 km, minDistance 20 m, step max(10 m, 0.4% d), minOcclusion 0.08, R' = R/(1-k), k = 0.13; about 1,275 samples per azimuth, 9.2 M per horizon, verified by arithmetic):
- Hero caption said "drawn from the map alone ... lands within 1.8 px". The camera pose was solved against the photo, so this is a fit, not a prediction. Reworded: "seen from the solved camera", and the compass-guess gap (13 px) is added.
- "Earth drops away 171 m by 50 km" is the net drop after refraction (the geometric drop is 196 m). Reworded; the equation legend says "net of refraction".
- Curvature caption on the ladder figure now says "curvature, less refraction". For demo-03 the shift is 0.10° = 1.5 px (from `terrainProfile`, f = 830); across the 12 photos it is 0.06 to 2.6 px. The honest message: on these photos curvature is a pixel or two; the shift is d/(2R') rad, about 0.004° per km, so it matters for far skylines.
- Callout claim (26 km ridge with drop, 50 km summit without) re-computed: 2.96 deg at 25.9 km versus 3.09 deg at 49.9 km. Correct. Added: k uncertainty. Delta k = 0.05 moves the drop by 4 m at 33 km (0.1 px) and 39 m at 100 km (0.3 px). Arithmetic only. k = 0.13 is the usual geodetic average (search results from FIG/ITU pages; radio uses 4/3 R, a different convention).
- "Where it fails": the old gallery (photos 6, 9, 3) showed p90 of 16-27 px and did not show trees or people. Replaced with photos 8, 7, 12, where a head covers the ridge (p90 145, 103, 18 px); labels now say solved or rejected with the inlier fraction (photo 7: 53%, low-confidence).
- RayMarch caption said "heights above the eye's sight plane" but plots absolute height. Fixed.

Phenomena: (1) the DEM skyline over the photo (hero, Fig. 3) is good. (2) Curvature and refraction were a plain side plot with a slider; now the sink is a labelled bar, the sight line uses the same cyan as the DEM line, and one equation sits right under it with colours matching (cyan a, terrain h, amber curvature term; live number "48 m at 26 km"). (3) "Why distant ridges matter" was missing. Added a two-sentence beat: a 25 m position error moves a ridge 2 km away by up to 0.7° (10 px at f = 830) but one 25 km away by under 1 px (0.06°). Arithmetic from the formula, stated as such.

Equation added: a(d) = atan((h(d) - h_eye - d^2/(2R')) / d), R' = R/(1-k); cites `horizon.ts:67-68`.

Not done: FingerprintRing / SideSection from `site/meta` were not reused (they would duplicate the landing page; the page already has a real side section and 360 profile). The horizon figure's distance colours are not the khipu ramp.

## Kit requests
- `Figure bleed` clips the "Fig. N" label and caption on the left at desktop width (visible on Fig. 3 of both pages).
- Pages now render on a light paper ground: LAYER_STYLE yellow (#f4d35e) as a `Sym` colour has weak contrast on paper; a darker text variant of each layer colour for `Sym` would help.
- A `Sym`-friendly way to pass sub/superscripts in `where` (currently pass JSX).

## Sources
- Baatz, Saurer, Koser, Pollefeys, ECCV 2012: https://mlanthology.org/eccv/2012/baatz2012eccv-large
- Saurer et al., IJCV 2016, abstract only: https://www.datalearner.com/academic/journal-papers/0920-5691/volumes-and-issues/116/paper-detail/14158
- Refraction coefficient k = 0.13 (geodesy): https://www.fig.net/resources/proceedings/fig_proceedings/fig2021/papers/ts05.4/TS05.4_zacharis_pagounis_et_al_11070_abs.pdf
- Effective Earth radius factor (radio, 4/3): https://itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.834-3-199910-S!!PDF-E.pdf
- Repo: `reports/leaderboard.md`, `reports/bench-wild.md`, `src/lib/geo/README.md`.
