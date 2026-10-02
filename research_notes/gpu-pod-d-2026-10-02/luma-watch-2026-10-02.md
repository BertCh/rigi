<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# luma watch, 2026-10-02 (roadmap G4, Pod D)

`node scripts/upstream/luma-watch.mjs` run on 2026-10-02 (network and `gh` available). Nothing was posted upstream.

**Verdict: no re-sweep triggered.** None of the three G4 triggers fired:

| Trigger | State |
|---|---|
| luma `10.0.0-alpha.3` published | No. `@luma.gl/core` `beta` = 10.0.0-alpha.2, `latest` = 9.4.2 |
| A vendored luma PR head moved | No. #3313, #3302, #3287, #3328, #3333, #3334, #3330 all at their recorded heads |
| deck #10752 (our luma 10 bump) activity | No. Still open, last updated 2026-09-26 |

Other state:
- luma master is still `7289d961` (= the vendor base).
- deck: `latest` 9.4.0, `beta` 9.4.0-beta.4.
- Watch list, all open: luma #3340 (progressive RAD splats), #3326 (GPUDataFrame filter fusion), #3286 / #3288 / i#3329 (shader assembler, may break the deck shim); deck #10627 (worker SplatLayer), #10778 and #10782 (already vendored into deck rigi.2), #10751 (TerrainExtension WebGPU height fit).
- New on the watch list: deck #10783 "let TerrainExtension layers follow external …" (opened 2026-10-01). Relevant only if we adopt deck's TerrainExtension on WebGPU (#10751 spike); no action now.

Re-run the watch before the next vendor bump or when a trigger is suspected.
