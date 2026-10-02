# Gipfelbuch review: Peaks cluster (peak, tap-a-peak), 2026-10-01

Pages: `src/lib/gipfelbuch/pages/peak.tsx`, `src/lib/gipfelbuch/pages/tap-a-peak.tsx`. New data: `scripts/gipfelbuch/data-peak.ts` -> `public/demo/gipfelbuch/peak/peak.json`.

## peak

### Correctness (checked against `src/lib/geo/peaks.ts`)
- Verified OK: `apparentElevation = atan2(h - eye - d^2/(2 R_eff), d)`, `R_eff = R/(1-k)`, k = 0.13 (`geodesy.ts:16,20`); 50 m..150 km range; ray march from 20 m, step `max(10, 0.004 d)`, stop `max(150, 0.02 d)` short; 0.05 deg tolerance; score weights; greedy x-spacing (3 % of width) then cap 20. k = 0.13 and the 7/6 effective radius are the standard terrestrial value (Wikipedia, Atmospheric refraction). OSM `ele` is "recommended" and `prominence` "optional" (OSM wiki), so "prominence is rarely tagged" is fair.
- WRONG (fixed): "Crowding, not terrain, removes most summits." Recomputed over every named OSM peak in frame (data-peak.ts, 120 km): demo-10 has 1181 in frame, 924 hidden by terrain, 257 visible, 20 labelled. Terrain removes 61-89 % of named peaks in all five photos checked; the 20-label cap and spacing then trim the visible ones.
- MISLEADING (fixed): the old "hidden (tallest 40 kept)" stat showed 40/924 because `build-data.ts` stores only the 40 tallest hidden summits (`build-data.ts:246`). Now uses full counts from peak.json.
- Note: `layoutPeakLabels` spaces labels by x only; it never tests text overlap. The page already says so correctly ("minSpacingPx").
- Unmodelled (not on page, worth a Details line): the test uses a single ray at the summit bearing, so a narrow gap between two ridges can show a summit the ray calls hidden, and the 0.05 deg tolerance is 17 m at 20 km. Not measured.

### Phenomenon visibility
- Before: occlusion was shown only as an azimuth/elevation scatter (abstract) and a synthetic schematic. The reader never saw a real hidden summit.
- Now (Fig. 3): demo-10, Grosses Wannenhorn (3906 m, 35 km), ring on the real photo, the covering skyline 10 px above it, and the baked side profile along its bearing with both sight lines (to summit 3.13 deg, to the 24 km ridge 4.63 deg, gap 1.5 deg). One equation, symbols coloured to the lines. The hand-chosen peak comes from the hidden list in demo-10.json (large gap, famous neighbours).
- Fig. 4: yaw slider on demo-01: labels slide by f tan(dpsi) = 10.7 px/deg (f = 612 px, 800 px frame). Cross-check: demo-01's real compass error of 9.29 deg gave 106.7 px median label miss (tap data); f tan(9.29) = 100 px, the rest is roll/pitch/f error.

### Copy
- Visible words were well over 450 in the main path; trimmed beats to 1-2 short sentences, moved the az/el occlusion plot (old Fig. 3) and the schematics into Details. Replaced a wrong failure claim (above). Code identifiers stay in Details.

## tap-a-peak

### Correctness (checked against `geo/control-points.ts`, `align.ts`, `picker/candidates.ts`)
- Verified: unlock ladder 1/2/>=3, level point = half a point, focal prior sigma 10 % and 100 LM iterations in `solveFromControlPoints`; `solvePins` has 50 iterations and weak roll/vfov priors; `nearbyPeaks` window 15 deg, max 8, bonus 0.5 deg per 1000 m capped at 1 deg; `TAP_MAX_PX` 12 at 1000 px.
- OVERCLAIM (fixed): Fig. 1 / Numbers implied three taps "land labels on their peaks" and give 0.1 px. In `data-tap.ts` the taps are placed at the pipeline's own solved projection and the reference pose is that same solution, so three exact taps recover it by construction. Caption and source now say so. "Yaw error" is versus the pipeline solution, not ground truth.
- MISLEADING (fixed): "A single point cannot tell pitch from roll or lens." One tap fixes yaw/pitch exactly at the pin; roll and lens stay at sensor values so labels away from the pin drift (7.7 px median on demo-10).
- Honest result added: two taps are not always better than one (demo-01 median 3.6 -> 4.7 px) while the lens is still wrong; not stated on the page (length); noted here.
- The one-tap hand formula is verified on data: yaw = az - atan((x - cx)/f) = 121.0 deg vs solver 121.1; pitch -12.0 vs -12.0 (demo-10; demo-09 116.25 vs 116.33, demo-01 260.56 vs 260.69). It ignores roll and image-axis tilt (said on the page).
- Not shown (derived, not measured): GPS position error matters for near summits: demo-10 hAccuracy 47 m is 0.08 deg at 33 km but about 1.3 deg at 2 km. Left out for length; candidate for Details.

### Phenomenon visibility
- Added Fig. 2: real tap on demo-10 with the pixel offset from the image centre drawn as legs, and the one-line equation with the real numbers (math + real visual). A tap is a ray constraint; this makes "one point fixes yaw and pitch" derivable in plain sight.
- MissBars moved to Details (repeats RealTaps numbers). Synthetic PinLock stays in Details.

### Copy
- Fails beat now states the measured drift and the loose-finger rule (5 px / f = angle).

## Equations added
- peak Fig. 3: `theta_ridge = max_d theta(h(d), d) > theta_summit + 0.05 deg`, with `theta = atan2(h - z - d^2/(2 R_eff), d)`.
- peak Fig. 4: `dx ~ f tan(dpsi)`.
- tap Fig. 2: `yaw ~ az - atan((x-cx)/f)`, `pitch ~ el - atan((cy-y)/f)`.

## Kit requests
- `Eq` `where` symbol colours: colours from `LAYER_STYLE` are too pale on the light ground; a text-safe variant (`color-mix(... var(--rigi-paper))`) would help. I used local color-mix strings.
- `RealPhoto`: an optional `fontScale`/min on-screen text size for overlay children on phones (my overlay text is about 6-9 px at 390 px width).
- `Measured` could take a `script` path override so a figure built from two scripts can name both.

## Not done / not measured
- Gallery photos beyond demo-10/09/01 use baked counts only; no refraction-sensitivity figure (k 0.13 vs 0 changes the apparent elevation at 35 km by about 0.02 deg (12 m): arithmetic, not measured).
- Phone screenshots show overlay text small; not iterated further.

## Sources
- OSM wiki, Tag:natural=peak: https://wiki.openstreetmap.org/wiki/Tag:natural=peak
- Wikipedia, Atmospheric refraction (k = 0.13, 7/6 radius): https://en.wikipedia.org/wiki/Atmospheric_refraction
- Code: `src/lib/geo/peaks.ts`, `src/lib/geodesy.ts`, `src/lib/geo/control-points.ts`, `src/lib/align.ts`, `src/lib/picker/candidates.ts`
