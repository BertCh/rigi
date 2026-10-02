# FUND E5: ray-cast oracle (F3), 2026-10-02

Verdict (dev, n = 54 eyes, not a result): **PASS** on the fixed criterion. Protocol (committed before measuring):
`tools/research/fund/e5_raycast/PROTOCOL.txt`; full report and numbers: `REPORT.txt`, `results.json` in the same dir.

- What: `src/lib/raycast/` (not wired, no flag): an f64 CPU reference and a WGSL twin (core ComputeGraph) of one
  max-mip heightfield ray caster with curvature and refraction per ray (k from `geodesy.ts`), on the horizon-fast
  mosaics. Per pixel: range, ENU xyz, sky; column mode: horizon elevation per azimuth. Harness:
  `scripts/research/e5-raycast.ts` (cpu / gpu / dense / cap100 / aggregate; `DAWN_DIR=/tmp/dawn`).
- (a) oracle vs horizon-fast on identical inputs: pooled p95 0.19 px (limit 0.5), p99 0.67, max 8.4; three narrow-FOV dev
  photos exceed 0.5 px at their own p95. POST HOC: both coarse marchers undersample narrow peaks by the same amount; a
  10x denser oracle and a 10x denser march agree to 0.023 px p95.
- (b) 1024x768 frame at 150 km: median 18.7 ms wall (limit 50) over 14 posed GT eyes, measured under a machine load
  average of 28 to 55.
- GPU f32 vs CPU f64 oracle: horizon p95 5e-6 deg; frame range relative error p95 < 5e-7.
- Not run: engine raster horizon (browser). dem.py differs by 6 px p95 (own bands, 100 km cap; its 5 m first sample
  alone makes summit eyes disagree by hundreds of px).
- Survives: the module and specs. Follow-ups: ortho colour / land-cover id outputs; whether the matcher's geometry moves
  off headless Chromium (app pipeline's call); a quiet-machine timing batch.
