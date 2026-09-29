# Single-image calibration priors (GeoCalib, AnyCalib) on mountain photos

**Scope.** 2026-09-26, DEV ids only: 30 dev photos with a verified ref, plus the 12 app GT photos, 42 scored in all. No test-split or `data_v3` photo was opened.

**Setup.** Predictions for all 63 photos are in `pred_dev.json` and `pred_anycalib.json`. Accuracy is measured on CPU. The machine had a load average of about 16 from other sessions during the runs.

- **GeoCalib:** pinhole v1.0. Code Apache-2.0, weights CC-BY-4.0, 116 MB.
- **AnyCalib:** pinhole v1.0.0, DINOv2-L. Apache-2.0, 1.28 GB. It gives focal only, no gravity.

The weights are in `weights/`, which is git-ignored.

## Result

| quantity | finding |
|---|---|
| pitch (free) | Median error 2.6°, p90 10.1°, max 17.4°. Reads about +2.4° high (in-sample). σ is roughly calibrated: 64 % of truths within 1σ, 88 % within 2σ. |
| pitch (EXIF focal passed as prior) | Median 2.2°, p90 8.3°. 74 % within 1σ, 95 % within 2σ. Narrow-photo max error falls from 17.4° to 6.2°. |
| roll | **Unusable.** No correlation with the truth (r = 0.00), and errors of 16–31° on tele photos. True rolls here sit within ±3.4° of 0 for 95 % of photos. |
| focal, focal-unknown photos (n = 7) | Median vfov ratio error: **AnyCalib 1.07×**, 50° default 1.28×, GeoCalib 1.47× (worse than the default). |
| focal, normal photos (n = 35) | AnyCalib 1.10×, GeoCalib 1.18×, default 1.35×. AnyCalib's 95 % band is ×/÷1.45, about as wide as the current 35–75° hfov sweep. |
| tele detection | Neither model sees it: every true hfov < 25° is predicted at 27–44°. |
| runtime (warm) | GeoCalib: 0.63 s on MPS, about 4–6 s on CPU under load. AnyCalib: 0.39 s on MPS, 1.7 s on CPU. |
| determinism | 9 of 63 photos differ between MPS and CPU by more than 1° (wc_0019 roll +30 vs +6, wc_0063 vfov 39 vs 8). Use CPU, or cache per photo. |

**Pitch fan.** GeoCalib pitch ± 2.2σ (± 2.0σ with the EXIF prior) contains 95 % of truths. Its mean half-width is about ±9°, 37–41 % narrower than ±15°. With roll kept at ±9°, the search area is about 60 % of today's.

A constant-width fan centred on GeoCalib is no better than one centred on 0 (±12.3° vs ±11.7°). The gain comes from the per-photo σ.

**Known out-of-fan cases:**

| photo | truth pitch | GeoCalib (EXIF prior) | outcome |
|---|---|---|---|
| wc_0048 | +7.8 | +6.8 ± 4.3 | caught |
| wc_0019 | +13.5 | +19.1 ± 6.5 | caught within 1σ; roll wrong by 30° |
| wc_0011 | +14.8 | +2.1 | missed |

## Recommendation

1. **Stage-1 pitch fan.**
   - Centre it on GeoCalib pitch, and always pass the EXIF focal prior when it is known.
   - Use half-width min(15°, max(4°, 2.5·σ_p)).
   - Don't narrow the fan for narrow photos. Add GeoCalib(+prior) pitch as an extra narrow seed instead.
2. **Roll.** Ignore GeoCalib roll and keep the current roll fan.
3. **Focal unknown.** Run AnyCalib and order the hfov sweep from its estimate (×{1, 0.87, 1.15} first). Keep 35–75° as the fallback.
4. **Determinism.** Run on CPU, or cache the output per photo.

**Expected impact: small.** Nearly all verified refs already lie inside the current fan (selection bias). The main benefit is speed, from a smaller pitch grid and fewer FOV trials. There is no evidence yet of recall gains, apart from wc_0019 and wc_0048, which T6's narrow path already solves.

## Caveats

- **Small samples:** only 7 narrow and 7 focal-unknown photos. The 95 % multipliers rest on the 2nd–3rd worst photo, so use k ≈ 2.5.
- **Selection bias:** the refs come from photos that the ±15°/±9° search already solved, so photos outside the fan are under-represented.

## Files

- `calib.py`: `calib(photo_path, device="cpu", vfov_prior=None, vfov_source="geocalib"|"anycalib")` → `{pitch, roll, vfov, hfov, sigma:{…}}`, in app conventions.
- `run_eval.py`, `run_anycalib.py`, `analyze.py` (`python analyze.py pred_dev.json free|prior` prints the full tables).
- `signcheck.py`: synthetic rotate and crop sign test. It confirms pitch maps to +pitch and roll to +roll in `skyglobal.project_rel` conventions.
