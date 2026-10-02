# FUND E4 step 1: dense feature-metric refinement (2026-10-02)

Study: `tools/research/fund/e4_featuremetric/` (PROTOCOL.txt committed before any score; REPORT.txt; results.json).

**What.** Frozen DINOv2 ViT-B/14 patch tokens (from the local MoGe-2 ViT-B checkpoint), photo vs an offline render,
coarse-to-fine LM over (yaw, pitch, roll, f) with Cauchy loss, norm-ratio confidence weights, 3x3 restarts, and a
Gauss-Newton sigma. The C0 cache is pruned and browser rendering is forbidden, so the render comes from a new offline
ray marcher (Mapterhorn to 40 km, curvature and refraction, SWISSIMAGE colour), validated to the app's GT skyline
(median 0.3 px) before scoring.

**Verdict: KILL** (dev, n = 12 primary GT photos, 90 secondary runs; not a result).
- Primary median rotation error: start 0.50 deg -> refined 1.70 deg (better on 1/12). Fixed criterion needs lower.
- Spearman(sigma_pred, error) over 102 runs: 0.394 (< 0.4). sigma is ~200x too small (median 0.013 deg).
- Secondary: 10 deg starts improve (median 7.4 -> 5.3 deg) but never reach 0.3 deg; 1 deg starts get worse (0.50 -> 2.4).
- Post hoc: the refined cost is below the cost at the GT pose in 92% of runs; the token cost surface is nearly flat, so
  the objective, not the optimiser, fails.
- Not evaluated: the eye-step clause (needs E3 renders; E3 was killed). GT noise is ~0.2-0.4 deg and the pipeline's own
  start median is already 0.50 deg on this set.

**Survives.** The validated offline far-field renderer and `start_poses.ts`; nothing for the product path.
**Follow-ups (new protocol needed).** f fixed, an ALIKED/other dense map, a skyline channel next to the features.
