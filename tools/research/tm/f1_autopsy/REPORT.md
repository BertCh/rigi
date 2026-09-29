# F1 — failure autopsy of dev photos (TM program)

*2026-09-27/28 · written by the main session from F1's returned findings (the subagent could not write this file).*
Scope: the 31 dev photos that are not a correct HIGH under T6 (30 LOW + wc_0076, HIGH/unsure). Attributions are the
agent's own visual judgement — **not blind**, post hoc on dev; some position claims (wc_0035, wc_0087 distances) are
geographic estimates, not measurements. Treat counts as ±2–3. No rendering; C0 cache + existing records only.
Per-photo evidence: `taxonomy.json`; sheets in `sheets/`; scripts alongside.

## 1. Causes (a photo can have several)

| cause | any | primary |
|---|---|---|
| d appearance gap (snow vs summer drape, haze, backlight, dusk, grading) | 22 | 7 |
| c near-field / non-DEM foreground | 20 | 3 |
| a_small eye error < 400 m (parallax) | 8 | 7 |
| g DEM/drape limit (near-field ortho blur, smeared steep faces) | 7 | 0 |
| a_big position wrong > 400 m / wrong vantage | 5 | 5 |
| b clouds / fog sea / hidden skyline | 5 | 3 |
| e narrow FOV | 4 | 2 |
| i right pose rejected by rule | 2 | 2 |
| h not a clean terrain view | 2 | 0 |
| f focal unknown | 1 | 1 |
| j GT ambiguity (wc_0076) | 1 | 1 |

Failing stage: matching 12 (0002, 0034, 0052, 0055, 0001, 0005, 0013, 0033, 0037, 0053, 0058, 0098) · position 9
(big: 0035, 0069, 0073, 0087, 0095; small: 0010, 0070, 0074, 0086) · decision 5 (0006, 0063, 0046, 0071, 0072) ·
search 3 (0040, 0015, 0023) · refine 1 (0028) · GT 1 (0076).

**11 photos with a verified-correct pose:** search never fails (a T6 candidate within 4° every time — partly selection
bias). 7 have the right pose at LOW: wc_0063 (1188 inl, support 0.91, basin gap 0.182 < 0.20) and wc_0006 (1935 inl,
fails the 0.3° match-only clause) are pure rule rejections; 0034/0046/0055/0071/0072 are weak matching (LoMa lifts all
but 0055 to 268–967 inliers, still LOW under the frozen rule). 3 wrong despite the right massif: 0052 (LoMa → correct
HIGH), 0028 (unknown-focal near-miss), 0002 (all matchers 10° off → eye).

**15 zero-support photos:** appearance/matching 8 (0005, 0013, 0034, 0037, 0052, 0053, 0055, 0098) · gross position 4
(0035, 0073, 0087, 0095) · near-field/search 2 (0015, 0040) · small eye 1 (0010). A 400 m eye search fixes neither big group.

Notable: wc_0073 EXIF GPS ~16 km off (lake shore vs Pilatus summit); wc_0069 eye ~600 m too low (Fronalpstock slope
blocks the lake view — the known trap); wc_0033 LoMa's unverified pose (61, −5.8, 1219 inl) matches the ring layout →
blind-verify; wc_0040 Moléson visible at ~230° in the ring but never proposed. Renders: terrain < ~300 m is a smooth
blur, steep faces smear. Post hoc: failures with a correct pose have median 44% of DEM terrain within 300 m vs 16% for
correct HIGHs.

## 2. Ceiling (plausible correct *poses*, not safe accepts)

| lever | photos | n |
|---|---|---|
| rule change only | 0006, 0063 | 2 |
| LoMa-class matcher + recalibrated rule | 0052, 0033, 0034, 0046, 0071, 0072, 0028, 0005 (0023?) | ~8 |
| eye refinement ≤ 400 m incl. height/shoreline | 0074 (proven), 0086, 0070, 0010, 0002 (0001, 0037?) | ~5 |
| better position prior | 0069, 0073, 0035, 0087 (0095 wide-area) | ~4 |
| better search | 0040 | ~1 |
| nothing near-term | 0013, 0053, 0055, 0058, 0098, 0015, 0076 | ~6–7 |

≈19–20 of 31 recoverable as poses; realistic HIGH gain ≈ +4–8 (19 → ~23–27 of 50), because the eye-error group is where
wrong poses also get strong support (wc_0001, 0069, 0070, 0074: 330–1800 inliers at wrong poses).

## 3. Directions
1. LoMa + a rule recalibrated on its statistics; fix the fragile basin-gap and 0.3° clauses; validate on traps 0069,
   0001, 0070, 0074; blind-verify wc_0033 first.
2. Eye refinement (position + height) with shoreline/low-point candidates, and a parallax-based wrong-eye veto.
3. Position sanity checks before matching: visibility > 1 km in the photo direction, lake-level vs looking-down,
   geocoding summit names in titles → "position suspect" instead of a pose.
4. Render-side masking of near-field/steep faces; sun-lit hillshade from EXIF time for snow photos (speculative).
5. Photo-side masks (sky, fog sea, buildings, people) for the skyline search (1–3 photos).
