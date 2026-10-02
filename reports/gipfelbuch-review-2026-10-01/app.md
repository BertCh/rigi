# Gipfelbuch review: "The app" cluster (rigi, photo-workspace, camera-roll, step-inside)

Date: 2026-10-01. Gates run: `npx tsc --noEmit -p .` (no errors in gipfelbuch files), `npx biome check --write` on the changed files, `npx tsx src/lib/gipfelbuch/gipfelbuch.check.ts`, `node scripts/ci/spdx.mjs`. Screenshots checked at 1400 and 390 px. Nothing was measured on the live app; every number below comes from the baked data in `public/demo/` or from `reports/`.

## rigi.tsx (overview)

Phenomenon: a photo plus a terrain model gives a pose, and the pose unlocks labels, a roll map and a walk-in scene. Hero (four stages on one real photo) shows it well. No equation added, as planned.

Correctness
- Numbers check out: 12/14 within 1° and ~20% wild auto-accept (`reports/status.md:9`), 17/17 HIGH (`reports/test-results.md:63`). The gallery's "Two heads on the skyline" was not supported: demo-07 and demo-11 were rejected as `low-confidence` (0.46, 0.44) and both do have a person in frame, but demo-05 also has a head and is accepted. Reworded to "a person in the frame can break the match".
- The third outcome tile ("Step inside") showed a DEM cone, not the near field. Now shows the real baked split of IMG_7086 over its photo.
Structure and copy
- The prior-to-solved story was told three times (hero, wipe, HowItWorksScene). The wipe is now in Details; the landing scene stays as the interactive beat.
- Copy is within the 300-450 word budget; no identifiers outside Details.

## photo-workspace.tsx

Phenomenon: the overlay is the DEM drawn from the solved camera, so labels move when the pose moves. The page showed pose provenance (preview, second opinion, export lock) but never the projection itself.

Correctness
- `choosePreview` bar: code is `levelOf("skyline-align", c) === "medium"` (`src/lib/integration/second-opinion.ts:87`), medium threshold exclusive 0.2 (`src/lib/ontology/core/confidence.ts:37`). Page is right. AGREE_DEG 1 and CASCADE_TIMEOUT_MS 20 000 right (`second-opinion.ts:113,115`). 11/12 correct, 0 false accepts, IMG_7130 +2.98° at 0.397: `reports/leaderboard.md:15,23`.
- Misleading: hero stage 1 said the cockpit "opens on the phone's guess". It only does so when the first solve is weak (`choosePreview` falls back to near-compass, then prior). Relabelled "Fallback: phone's guess".
- Not verified: the IMG_7130 -0.02° cascade figure is quoted from the page's own source comment, not re-measured.

Changes
- New Fig. 2 (`PeakProjection`): one peak chosen by chip, drawn at the phone's yaw (magenta ring) and the solved yaw (cyan dot) on demo-01; readout gives distance, azimuth, elevation, the pixel shift (122 px for 9.3° at Niesen) and px per degree from the solved vfov (612 px focal, 10.7 px/deg). All values from `demo-01.json`.
- One equation next to it: x = c_x + f · (d·r̂(ψ)) / (d·f̂(ψ)), the pinhole projection u = K[R|t]X restricted to a yaw change, legend colours for the two yaws.

## camera-roll.tsx

Phenomenon: a roll is a place because each photo's solved heading lets the photos stitch; the compass alone does not. The page had no real figure of that; the synthetic panorama strip was in Details.

Correctness
- Constants match code: ROLL_LINK_M 15 km, VIEWPOINT 250 m, BIAS_WINDOW 45 min, MIN/MAX_BIAS 1/90, OUTLIER_DEG 8 (`src/lib/roll/align/viewpoint.ts:17-28`), retry 2° (`align.ts:105`).
- Bug: Details said "mip-mapped GIPFELBUCHES" (a bad rename of "texture atlases"). Fixed.
- Inconsistent: Details caption said "within a hundred metres", hero says 112 m (measured). Now "about 110 m".
- Panorama mapping matches `unprojectAzEl` in the page and `panorama.ts:32-33` (atan2 of ENU, asin).
Changes
- Added the existing `RollCompasses` (real roll, slider moves every photo from compass pose to solved pose) straight after the idea; its default state is the solved one so it reads without interaction.
- One equation: az(u) = ψ + atan((u − ½)·2 tan(hfov/2)), level-camera form, with the pitch/roll caveat in the legend.
- The plan-view `RealRoll` (grouping, GPS circles) moved into Details after the viewpoint linker; the "Group" trio tile carries that idea in the main flow.
- Idea copy trimmed to two sentences.
- Not done: the strip and the multi-photo drape blend (TOP_K = 4 weights) have no real-data figure; only the app screenshot `public/demo/shots/drape.jpg`.

## step-inside.tsx

Phenomenon: model depth is rescaled against the terrain, then each pixel is classed Object (lift to 3D), Terrain (drape) or Far (terrain only). The page showed DEM ranges on the demo photos but never the result of the split, and had no real anchor curve.

Correctness
- Split rule matches `classifyRange` (`src/lib/nearfield/split.ts`): person forced Object; beyond 150 m Far; no DEM hit Object; Object when range < dem(1-0.5) and dem - range >= 3 m.
- Stale: "4 % / 15 % (three / deck)" and "renderers (three, deck) agree within 3 %". three.js was removed (583e2b7; note at `reports/step-inside-results.md:5`). Reworded to 15% on deck.gl, with three noted as removed.
- MiniBars (1x, 2.9x, 6.6x) are DEM/model range ratios from the report (`step-inside-results.md:34`), previously labelled "error". Relabelled "terrain ÷ model range".
- The baked scene's fit quality is 0.347, just under the 0.35 low-trust threshold; shown honestly in the figure note (not claimed otherwise).
Changes
- New data: `scripts/gipfelbuch/data-step-inside.ts` (extended, run) writes `public/demo/gipfelbuch/step-inside/split.png` (the real split of IMG_7086 from `public/demo/step/scene.json`) and `split.json` (class counts, anchor curve).
- New Real 1: wipe between photo and split, beside the real anchor curve (log-log, with the 150 m radius; the model's 133 m becomes 1338 m). Caption states that the hiker is lifted by the people mask, not by depth. Pixel classes were spot-checked: the hut, lift cabin and fence post are classed Object, so the first caption draft ("they stay in the ground") was wrong and was corrected.
- One equation: the split rule, symbols coloured to the overlay (accent = lifted, orange = terrain range).
- The centre-line range figure moved to Details (it duplicated the hero).

## Index (gipfelbuch.index.tsx, CoreMap)
- Trimmed the two deep-dive blurbs to one sentence, added a "New here? Start with Rigi in one page" link, and a clearer "The app" blurb.
- CoreMap (read-only review): not opened in a browser for this pass; no layout changes proposed.

## Kit requests
- `RollCompasses`: arrow labels clip at 390 px (right edge). Needs a smaller font or wrapped labels on phones.
- `Eq`: allow the display line to wrap or scale on phones (the camera-roll equation scrolls at 390 px).
- A `Measured` variant that accepts any `{script, generated}` object (I cast).
- Dark-background SVG tiles (`bg-[#11161a]` in `MiniPlan`, `PanoramaStrip` etc.) will need theme tokens under the paper reskin; I fixed only `MiniBars`.

## Sources
- Segal et al., Fast shadows and lighting effects using texture mapping, SIGGRAPH 1992 (projective texture mapping): https://my.eng.utah.edu/~cs5610/handouts/sgi-shadows.pdf
- MoGe-2, metric scale and the focal-distance ambiguity: https://arxiv.org/html/2507.02546v1
- Repo: `reports/step-inside-results.md`, `reports/leaderboard.md`, `reports/status.md`, `reports/test-results.md`.
