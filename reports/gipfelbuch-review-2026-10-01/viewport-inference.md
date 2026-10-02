# Review: viewport-inference, camera-prior, photo (2026-10-01)

Scope: `src/lib/gipfelbuch/pages/{viewport-inference,camera-prior,photo}.tsx`. Checked against `src/lib/upload/exif.ts`, `src/lib/camera/focal.ts`, `src/lib/geo/solve.ts`, `src/lib/geocam/{priors,map}`, `public/demo/manifest.json`, `public/demo/gipfelbuch/*.json`, `reports/negative-results.md`. Nothing new was measured except the declination (computed with `src/lib/geocam/priors/wmm.ts`, WMM2025 at 46.710 N, 7.773 E, 2026-09-07: +3.43 deg).

## camera-prior

Correctness issues
- **Misattributed negative result.** The "Where it fails" beat said pulling answers toward the prior got worse, "median 12.0 to 13.4 px". `reports/negative-results.md:82` says that number is the *altitude-contour eye rule*, not a compass/pose prior. Reworded to name altitude.
- **"Expected +-7.1 deg" band was misleading.** 7.1 = hypot(5,5) from `COMPASS_DEFAULTS` (`geocam/map/factors.ts:179`), a flag-off geometry-first path. The production solve uses yaw sigma 15 and a +-25 deg search (`geo/solve.ts:273`, `yawRange` at :354). 6 of the 10 accepted photos exceed 7.1 deg, so the band contradicted the data. The shading now shows 15 deg and the caption names the 25 deg window; a Details callout explains the 7.1 vs 15 split.
- **Declination** was not addressed: a reader assumes "compass off" = declination. It is +3.4 deg here and iPhones write true north (`GPSImgDirectionRef T`), so it explains little. Added to the caption. The 5-19 deg errors are not explained by any measured cause; we did not fit one (heading-dependent deviation, tilt compensation and local magnetic anomalies are all plausible; not tested).
- "Gravity and lens land within a degree or two": accepted pitch deltas are 0.2-2.6 deg, focal ratios 1.005-1.052. Now "within 3 deg / within 5 %". Caveat in Details: pitch is only searched within +-3 deg and prior-pulled (sigma 1.5), so "tight" is partly the window. Solved-minus-prior is the pipeline's own estimate, not ground truth.
- Lens distortion (ultra-wide) is not modelled anywhere in the code; stated in Details.

Phenomenon: a compass error shifts the whole skyline sideways. The Compare wipe shows it; the missing piece was the size. Added one equation, `dx ~ f * tan(psi_solved - psi_prior)`, with the symbols coloured as the magenta/cyan overlays and a worked demo-06 number from data (f = 801 px, -6.5 deg gives 91 px of an 800 px frame), and the sentence that ridge slope turns the slide into the vertical gap.

## photo

- Tilt mark read "-3.1 deg up or down, -2.0 deg sideways" (signed, ambiguous). Verified the sign in `exif.ts:190` (pitch = asin(-fwd.g), negative = looking down) and now says "Pointing 3.1 deg down, rolled 2.0 deg".
- Focal to field of view was only a picture. Verified `focalPxFromF35` (f = f35 * hypot(W,H) / 43.2666; 26 mm gives f = 601 px, hfov 67.3 on the 800 px frame) against the standard definition (diagonal-based, Wikipedia "35 mm equivalent focal length"). Added the equation (f and hfov) with the worked 26 mm (67 deg) and 13 mm ultra-wide (106 deg) values from data, plus the honest note that no distortion term is modelled.
- "Heading can be tens of degrees off" (Details) overclaimed; measured max is 19 deg. Fixed.
- Altitude story verified: demo-09 GPS alt 1183 m vs ground 1913 m (-730 m); code `eye = max(alt, ground + 1.6)` (`geo/pipeline.ts:49`). Correct.
- Not verified: the roll sign in the TiltMini schematic was checked by reasoning only (right side down = positive roll = horizon rises to the right).
- Not covered (kept out for concision): GPS vertical accuracy is not in the EXIF record we read; only horizontal (`GPSHPositioningError`, 5.8-121.6 m measured).

## viewport-inference

- "Median compass error found, 12 demo photos" and the gap medians included the two rejected solves (demo-07, 11), whose "solved" poses are not trusted. Now accepted photos only.
- The page never said what is *not* solved. Added: GPS fixes the position, only the three angles and the lens are solved (the free-eye 6-DoF attempts drift 180-270 m, `negative-results.md:91`).
- The core math was only in Details. Added the one equation the solver minimises (argmin over theta of sum w rho(r - h(theta))) with r yellow, h cyan, next to the hero; Details notes ρ is truncated L1 at 12 px on the grid and Cauchy at 4 px in the polish. Added a phone-vs-solved camera table (yaw, pitch, roll, focal) for the hero photo from data, as on the landing scene.
- 0.22 deg vs hand registration: matches `geo/README.md:54` (12 hand-registered photos).
- Left as is: synthetic figures in Details are labelled "Schematic (synthetic scene)".

## Kit requests
- A `Table`/readout primitive for "phone vs now" values (the landing scene has one inline).
- `Eq` children cannot hold wrapping prose, so worked numbers go in a paragraph after it; a `worked` prop would fix that.

## Sources
- https://en.wikipedia.org/wiki/35_mm_equivalent_focal_length (diagonal 43.27 mm definition)
- https://developer.apple.com/documentation/corelocation/clheading/headingaccuracy (heading accuracy is a reported bound, not a guarantee)
- https://www.ncei.noaa.gov/products/world-magnetic-model (WMM2025 used by `geocam/priors/wmm.ts`)
