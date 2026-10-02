# Step review, 2026-10-02: index

This pass reviewed, researched, planned and improved each of the 16 steps of the Gipfelbuch graph (`src/lib/gipfelbuch/graph.ts`, in the order of `notebook/entries.ts`). One Opus lead took each step and ran Sonnet subagents. The coordinator was session mt-image-17. The rules were cook mode: fast gates only, so every rendering change is **browser-unverified** and has a row in `reports/batch-ledger.md`. Behaviour changes to the solve or accept path ship behind flags that are off by default, unless they are bit-identical. Each step's plan doc has the findings (file:line), the research, its units, a "Gipfelbuch corrections" section, and the next steps.

The fast tier never ran green in any worktree. The leads put the failing rows down to other sessions' Biome and ontology errors, timing checks under load, a stale generated `ontology/domain.ts`, and the worktree setup:
- the `upload` specs are refused when `node_modules` is a symlink to outside the worktree;
- the python-unit specs have no venv;
- `photos.json` is missing from fresh worktrees.

None of these rows were in a lead's own files.

## Steps

| # | Step | Plan | Landed (master) | Headline |
|---|---|---|---|---|
| ① | photo | [photo.md](photo.md) | c4507f4, 03e4c47, f22da8c | EXIF placeholders (null-island GPS, zeroed gravity, 0000 dates, absurd f35) read as unknown; ingest shares the upload parser |
| ② | camera-prior | [camera-prior.md](camera-prior.md) | cd10b22, 6345569, dc9047e, 12b3f5f | The node's modules are not the live prior; the ±25° window holds on dev; the compass error within a session is a drifting bias; the Heading slider wraps at north |
| ③ | skyline | [skyline.md](skyline.md) | 26f1480, bda693e, dd5b749 | Only the classical trace feeds the solve; the sky worker can no longer hang (watchdog); row-major loops, identical output |
| ④ | baseline-pipeline (+ viewport-inference) | [baseline-pipeline.md](baseline-pipeline.md) | 9052a1e, 5e43b99, 3c8428a, 84f825b, e0d0ae7 | `/baseline` without a compass no longer accepts at 0.5 around a fake north (precision fix); `stripAgreement` signal (unread); 360° seam bug found, deferred |
| ⑤ | accept-rule | [accept-rule.md](accept-rule.md) | ab56aad, 36adadc, a90cc8b, 7dd60c9 | Auto-align and Refine no longer persist unconfirmed poses; silent second-opinion outcomes say "not verified"; Clopper-Pearson / sizing tools |
| ⑥ | pose-estimate | [pose-estimate.md](pose-estimate.md) | 0a08c9f, 5d0e957 (+ b8a6e96 wiring) | Exports carry pose provenance; fail-closed `readPoseJson`; `isPose`; specs tie the three pose representations together |
| ⑦ | tap-a-peak | [tap-a-peak.md](tap-a-peak.md) | 8ac1928, c38c8f1, 3148dfa, d1d4f0d (+ b0's 878a447 picker) | Rotation-free name check before the solve; `?pinSolve=seeded` converges from 120–180° off (197–200/200 vs 0–15/200) |
| ⑧ | dem-source | [dem-source.md](dem-source.md) | 74db489, c9f7c38, 87cfc06, f539fd2, abeb11a, 34491ef | Anti-fingerprinting canvas noise turned DEM tiles into ±256 m spikes: now detected and repaired; current zoom bands are adequate |
| ⑨ | terrain-sampler (+ terrain-snapping) | [terrain-sampler.md](terrain-sampler.md) | 6076dcb, b568ed0, 30f95bf, 68e2c99, 66fcb91 | One shared `sampleGrid`; sampler conformance spec; `?geoLakeFloor` fix (off); consumers sample the eye's ground at z14–z17 |
| ⑩ | eye-rule | [eye-rule.md](eye-rule.md) | d5cccc1, 88a7c2a, cd9bafc, db5b4d5, a3aa788 | One `geo/eye-rule.ts`; honest Camera panel row; the solve uses 1.6 m but the display 1.8 m without GPS altitude |
| ⑪ | dem-horizon | [dem-horizon.md](dem-horizon.md) | d6a83a7, 6ba4b45, 0ca2aed, 5d19fd7, 2ac1ac4 | CPU reference horizon 2.4× faster, bit-identical; three horizon worker leaks or hangs fixed; the 120 km cap is the largest far-field error (~5 px NE at Niederhorn) |
| ⑫ | peak | [peak.md](peak.md) | 81cbb99, d0a1a4f, 72fefe8, df02749, 2f1a475, 691ea1a, 75be292 | 22% of summit snaps hit the grid edge on a slope; `?peakSnapInterior` (off); OSM "4'478" read as feet fixed |
| ⑬ | dem-anchoring | [dem-anchoring.md](dem-anchoring.md) | 6ad885d, 8f7f80e, 13d9fe6, e8938dd | Extrapolation past a single knot fixed (1 km point sent to 11 km); offline anchor harness; the dev render cache is gone, so there is no real-data gate yet |
| ⑭ | photo-workspace (+ rigi platform) | [photo-workspace.md](photo-workspace.md) | 8ee2a13, bce4db3, 327aada, b8a6e96, 4727e3a, 9e7fc65 | Failure messages, a11y, timing marks for time-to-first-overlay, StrictMode init leak, export provenance wired |
| ⑮ | camera-roll | [camera-roll.md](camera-roll.md) | 96cf897, b5a93ff, 6d744fd, 36d1990, 495ecc2, ac88d4d, 31d9317 | The 45 min bias window is worse than the raw compass on the demo roll (60 s: 2.5° median, n = 10); roll prior and propagation use the true-north heading |
| ⑯ | step-inside | [step-inside.md](step-inside.md) | a568761, c574955, e55035e, f9bc526 | Back-to-photo no longer vanishes on a failed probe; SHARP is dev-only; `/health` reports only installed models |

## Cross-step themes

- **Precision leaks closed.** Four leaks of the "a wrong pose is worse than no pose" rule:
  - `/baseline` without a compass accepted at 0.5 around a made-up north (④).
  - Auto-align and Refine persisted unconfirmed poses, which then reloaded as accepted (⑤).
  - Exports did not say a pose was unverified (⑥, ⑭).
  - A mis-named tap was saved as "pinned" (⑦, decision below).
- **Duplicated rules unified, bit-identical:** the eye rule (⑩), the height sampler (⑨), summit snapping and OSM height parsing (⑫), the CPU/GPU horizon segments (⑪), the true-north heading in roll (②→⑮), gravity parsing (①→④), and the near-field low-trust constant (⑬→⑯).
- **Gipfelbuch text drift.** Most nodes overstate or misname their modules: camera-prior, skyline, dem-horizon, peak and eye-rule describe research paths, not the live app. Each plan has a "Gipfelbuch corrections" section for the page owner. graph.ts was not edited.
- **Data gaps block the next gates:**
  - Android photos with known poses (⑩ ellipsoid altitude, ② declination).
  - The dev render cache (⑬).
  - A sealed set large enough for the precision claims (⑤: about 300 photos for ≥ 0.95).

## Decisions for the user

| # | From | Decision | Lead's recommendation |
|---|---|---|---|
| 1 | ②① | Turn `geoDecl` (declination) on by default | Yes; it changes nothing on true-north photos |
| 2 | ⑩④ | One eye height without GPS altitude (1.6 m vs 1.8 m) | 1.6 m everywhere, behind a dev-split gate |
| 3 | ⑤ | Size of the sealed set (N3) | ~300 photos to show ≥ 0.95; ~100 can show only ~0.86 |
| 4 | ⑤ | Solution-separation alert → top-3 picker suggestion instead of a veto | Suggestion |
| 5 | ⑤ | Include pitch in "verified" | Flagged, batch check |
| 6 | ⑦ | A pin solve that fails the name check: "manual" plus a warning instead of "pinned" | Yes |
| 7 | ⑭ | `?firstOverlay=prior`: show the sensor pose, marked uncertain, while the solve runs | Build behind a flag |
| 8 | ⑭⑥ | Mark unverified exports visibly | Needs pod E's sign-off |
| 9 | ⑥ | "Open pose file" import; OGC GeoPose export (body frame undefined upstream) | Open |
| 10 | ⑪ | Eye-adaptive horizon range `?horizonRange=auto`, then per-photo refraction | Opt-in, needs a tile and memory budget |
| 11 | ⑫ | Peak names in the UI language; catalogue radius 60 vs 110 km; Wikidata prominence; may a ranking change move the default labels | Open |
| 12 | ⑮ | Roll bias window 45 min → ~60 s; split rolls at time gaps | After a roll-align bench |
| 13 | ⑧ | Mapterhorn production traffic: ask the maintainers or self-host (CH z13–17 = 615 GB); offline needs a new dependency | Open |
| 14 | ③ | A new model in a product path (MobileSAM / SAM 2 tiny / DA-Small, Apache-2.0); a learned mask back in the solve | Prereg first |
| 15 | ⑬ | Rebuild the dev render cache in the next browser batch (~27 photos) | Yes, it is needed for any anchoring gate |
| 16 | ⑯ | Remove the three.js splat stack (lab routes only); ship Step Inside v1.1 as an opt-in beta | Open |
| 17 | ① | Offline time-zone lookup package (new dependency) | Open |
| 18 | — | `summit-lens/pose` and `slens` readers in 7a's no-back-compat pass | 7a asks you; any edit goes to the pose-estimate owner |

## Follow-ups nobody owns yet

1. 360° seam bug in the solve confidence (④): this needs pod D's GPU selection and a worker flag.
2. 429/5xx backoff with `Retry-After` in `dem/load.ts`, and clear the known-missing set when the tile cache clears (⑧→⑨).
3. Measure the eye's ground across z14–z17 consumers, then decide whether all of them share one sampler (⑩ U5, ⑨ §8).
4. Sky model: drop the WebGPU session after two non-device-loss failures and retry the photo on WASM (③).
5. Workspace pin tool (⑦): solve from the pose before the first pin, make Clear restore it, draw residual lines, and set "pinned" only when the checks pass.
6. Picker leftovers (b0): loupe, single-tap undo, nearbyPeaks visibility.
7. Peak ranking by the distance to a higher neighbour instead of the scarce prominence tag (⑫, owner of `look/labels/**`).
8. Roll map: show "draping N of M", and stop drawing compass-less photos facing north (⑮, owner of `roll/map/**`).
9. Near-field service: cancel the server-side job when the client gives up (⑯).
10. Browser batch: everything in the ledger rows tagged "step …", plus `?pinSolve=seeded`, `?peakSnapInterior`, the canvas probe in Brave and Safari private windows, the splat colour on WebGL2 vs WebGPU, and the time-to-first-overlay marks.
