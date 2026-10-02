# Gipfelbuch review: Terrain and snapping cluster (2026-10-01)

Pages: terrain-snapping, terrain-sampler, dem-source, eye-rule, dem-anchoring. Checked against the code, the baked data
(`public/demo/gipfelbuch/terrain/terrain.json`, `eye-rule/eye-rule.json`) and the literature. Screenshots taken at 1000 and 390 px.

## Cross-page findings
- **Datum and GPS error were absent.** Phone height error is usually 1.5 to 3 times the horizontal error; Switzerland's geoid lies 45 to 55 m above the ellipsoid, so an ellipsoidal altitude would read about 50 m high. Added to eye-rule (one sentence main copy, datum note in Details).
- **Tile pixel size is not data resolution.** dem-source said "A Terrarium pixel is 3.28 m wide" next to Mapterhorn's 0.41 m. 3.28 m is the z15 grid (156543.03 cos(lat) / 2^15 / 1); Terrarium is built from coarser sources (SRTM and others per the Joerd docs), so the grid overstates its detail. Reworded; the same caveat added to terrain-sampler's "tile pixel width" number.
- **DSM versus DTM was never mentioned.** swissALTI3D is bare earth (DTM, 0.5 m, sd 0.3 to 3 m); Copernicus GLO-30, Mapterhorn's global layer, is a 30 m surface model (canopy, roofs; LE90 < 4 m). "Ground" therefore means different things in CH and elsewhere, and it matters for "DEM + 1.6 m". Added to dem-source Details. Not measured by us.
- **Light-theme breakage.** The reskin made the ground light; figures with literal `white` / `rgba(236,230,218,.x)` are unreadable. I converted only the figures I edited or promoted (eye-rule SideView, dem-source GroundGap, terrain-sampler BilinearProbe, dem-anchoring identity line). Other literal colours remain in all five pages (terrain-snapping RealEye and PeakReal axes, dem-source Hero/Disagree text, dem-anchoring CurveFigure, eye-rule RealOffsets/RealContour, terrain-sampler LevelCost). Left for the reskin pass, per the coordinator.

## eye-rule
Issues
- Hero used Terrarium ground (730 m under) while the app's map is Mapterhorn (750 m, and the landing says about 750). Caption now states both (eye-rule.tsx, `HeroStages`).
- Stage 3 said "and the skyline then matches": not shown or measured. Now "the horizon is traced from there".
- Fig. 2 buried the most telling fact: with Mapterhorn ground the rule drops the altitude in 11 of 12 photos (alt < ground + 1.6), with Terrarium only 1 of 12. The map you use decides whether GPS height is heard at all. Now in the caption, computed from the data.
- "iPhone altitude is MSL (EGM2008)": from a code comment (`concord/priors/altitude.ts` header), not verified per device. Softened.
- "0.2 m is about 6 px on a 100 m foreground": true only for a 4000 px frame (4000 x 26/36 x atan(0.2/100) = 5.8 px; 0.58 px at 1 km). Frame size added.
- Constants verified: `eyeAltitude` (deck/scene.ts:59) is `alt != null ? max(alt, dem+1.6) : dem+1.8`; pipeline.ts uses 1.6. altBias -7, sigmaA 3 match `EYE_PRIOR_DEFAULTS`.
Phenomenon: a floating GPS fix snapping to the ground. Fig. 1 already did this on the real photo and a real terrain profile. Kept.
Change: `<Eq>` right under the hero: eye = max(alt, g + 1.6) with alt red (the red dot), eye accent (the accent dot), and demo-09's numbers substituted.

## terrain-snapping
Issues
- "0.13 median depth error" had no unit; it is log units (about 14%; one scale 0.34, about 40%). Fixed.
- "One metre of eye height moves a ridge 500 m away by about 0.11°, several pixels": atan(1/500) = 0.115° is right; it is 5.8 px in a 4000 px frame at 26 mm equiv. Stated.
- Fig. 3 caption explains the lift by "the photographer stands on the crest": an interpretation, not tested (a -7 m altitude bias or horizontal fix error give the same sign). Now "probably".
- Peak rule, curvature numbers verified: r = min(250, 60 + 0.004 d) (`deck/engine.ts:2449`, cap at 47.5 km); d^2/(2R/(1-0.13)) = 0.61 m at 3 km, 683 m at 100 km.
Change: `<Eq>` for the search radius before the peak figure, with the measured Ramsgrind example (7927 m gives 92 m); r is paper-coloured like the dashed square in Fig. 2.

## terrain-sampler
Issues
- The bilinear probe (the page's best real-data figure, built from a real tile seam) was hidden in Details. Promoted to the main flow with its own beat.
- "Worst error of the band rule" is a difference from the finest map (z15), not from truth. Reworded.
- Verified: `sample()` uses `t.x*tileSize - 0.5` (pixel centres), matching the figure; mpp formula and tile counts match terrain.json; sea clamped to 0 in `decodeTerrarium`.
Change: `<Eq>` under the probe: h = (1-fy)·top + fy·bottom, with live substitution from the dragged point.

## dem-source
Issues
- Beat said "Terrarium is the global default"; the code and Details say MAPTERHORN is the approved default. Fixed.
- Pixel size vs detail (see above); DSM vs DTM added.
- Fig. 2 lower y label was clipped ("Terr. minus Map. ("); shortened.
- Decode check: (135,142,32) gives 1934.125; (135,90,130) gives 1882.51; both match the data. Terrarium: v+32768, R = floor(v/256), G = floor(v mod 256), B = floor(frac x 256) (Joerd docs).
- "Terrarium 21 to 87 m lower": measured at the 12 camera spots, all on crests/ridges; do not generalise to flat terrain (transect shows mostly under 20 m).
Change: `<Eq>` for Terrarium decode with R, G, B coloured and the real Mapterhorn pixel under the camera substituted.

## dem-anchoring
Issues
- Copy said a depth model "sees shape, not metres". MoGe-2 is a metric model; the measured problem is range compression (reports/step-inside-results.md). Reworded. The classic affine-invariant case (s·d + t, least squares) is the "one scale" baseline in the legend; Rigi's code has no shift term in the curve (`scaleOnly` uses scale and shift only for comparison).
- Fig. 2's median DEM/model ratios (1.5, 5.8, 6.1 at 20/100/300 m, curves of 27 wild photos) differ from the report's 1 / 2.9 / 6.6 at 20 / 100-300 / 300-1000 m (different aggregation). Not reconciled; both are shown.
- Details said the inlier median is "always near 0.07"; this is from a code comment, not measured. A uniform residual in the +/-25% band would have median about 0.11. Softened.
- The fit data are 27 wild spike photos, not the demo set (no depth maps baked for demo photos); stated in the caption, kept.
Change: `<Eq>` for the loss (truncated L1 in log space, `anchor.ts` fitCurve) after Fig. 2, with f accent like the curves.

## Kit requests
- `Eq`: allow wrapping or a smaller font under 480 px; the substituted lines (bilinear, anchoring) clip at 390 px and need a sideways scroll.
- `Eq`/`Sym`: a `c` that accepts a theme token; the light reskin needs `LAYER_STYLE` colours to be re-checked on paper.
- `Trio`: the mini-visuals are tall squares on phones; roughly 40% of the phone page height is empty cards.

## Not done
- No new baked data. Real MoGe depth versus DEM scatter for one demo photo would be the best "scale and shift" figure but needs the depth model run.
- Light-theme literal colours in the remaining figures (see above).

## Sources
- Terrarium format: https://github.com/tilezen/joerd/blob/master/docs/formats.md
- Mapterhorn: https://mapterhorn.com/ and https://mapterhorn.com/attribution
- swissALTI3D: https://www.swisstopo.admin.ch/en/height-model-swissalti3d
- Copernicus GLO-30: https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM
- GPS vertical vs horizontal error: https://www.okmap.org/en/en_articles/en_gpsAccuracy.aspx
- Swiss geoid: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11548381/ ; https://insidegnss.com/how-do-gnss-derived-heights-differ-from-other-height-systems/
