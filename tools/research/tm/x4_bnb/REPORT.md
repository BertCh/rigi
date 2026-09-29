# X4 — exact pitch/roll search, branch-and-bound, strip agreement (TM program)

*Written by the main session from X4's returned findings (the subagent could not write report files). Open `results/x4_results.json` first.*

**Set-up.**
- DEV only, offline on `tools/matcher/v2/.cache/edges`, no renders.
- `x4lib.Objective` is bit-exact with `SkyGlobal.grid` (max |Δ| 6e-17).
- Design choices were fixed on the 27 odd ids (14 with refs) before looking at the rest: closed form `cf_top_pol`, 3 strips with ε = 2°, and the certified gap as the gap signal.

**Methods.**
- **Closed form (cf):** yaw sampled on the baseline grid. Per yaw, pitch is inverted in closed form from the photo skyline taken from the coarse score map (weighted median), followed by 4 Huber/Tukey Gauss–Newton steps on (pitch, roll). Each yaw is scored with the exact objective.
- **Branch and bound (B&B):**
  - Upper bound: a rigorous interval bound plus a 2-D sparse-table max of the score map. Admissibility was checked on 48k random boxes with 0 violations.
  - Search: exact top-8 by sequential exclusion with the same NMS as the baseline.
  - Certified gap: the best score minus the largest upper bound outside ±3° of yaw. Median slack at the top-1 is 0.012.
- **Strips:** an independent closed-form pitch per strip. Agreement is the number of strips whose best yaw is within ε of the top-1.

## Verdict
- The exact search removes pitch-grid brittleness at the search stage, but it does **not** beat the baseline's hit counts.
- The baseline's 23/30 is itself a lucky grid phase: half-step shifts give 18–21.
- **Adopt 3-strip agreement as an abstain signal.** Do not replace the skyline search with B&B.

## Results (50 dev photos; hits over the 30 with refs)

| method | top1@3° | top4@3° | top1@1° | top4@1° | half-step shift: top-4 flips / top-1 moves > 3° (of 50) | time, median (max)* |
|---|---|---|---|---|---|---|
| baseline replay | 19 | **23** | 17 | 18 | pitch 4/14 · roll 3/5 · yaw 2/4 · all 5/15 | 20.5 s (49 s) |
| closed form `cf_top_pol` | 17 | 21 | 16 | 16 | yaw 1/8 (no pitch/roll grid) | **1.2 s** (3.2 s) |
| B&B, same refine tail | 18 | 20 | 16 | 16 | yaw 2/5 | 36 s (241 s) |
| B&B ranked by coarse score (post hoc) | 19 | 20 | 16 | 17 | yaw 1/1 | 36 s |

\*Timed under heavy machine load; only the ratios mean anything. B&B certified 49/50 within its 240 s budget; wc_0005 did not finish.

**Where the remaining instability comes from.**
- **B&B's losses:** wc_0019, 0028 and 0054 are baseline-phase-brittle anyway; wc_0002 is 3.1° off.
- **Search stage:** B&B has 0 top-4 flips before refine, and 0/50 top-1 moves under a different partition.
- **What's left in the final output:** the refine/fine re-rank step, the yaw-grid phase (the DEM horizon is binned, so the phase changes the objective itself), and near-tied lower basins. 11–24 of 50 final top-4 sets still change.

## Abstain signals
AUROC for "own top-1 within 3° of a correct ref", 30 photos:

| signal | baseline | cf | B&B |
|---|---|---|---|
| fine gap (top-1 − top-2) | 0.952 | 0.914 | 0.986 |
| coarse gap to best outside ±3° | 0.900 | 0.606 | 0.917 |
| certified gap | — | — | 0.912 |
| **strip agreement (3 strips, ε = 2°)** | 0.947 | 0.946 | **0.988** (odd 1.0 / even 0.984) |

**Abstain when no strip agrees:**
- B&B: keeps 18/18 correct top-1s and lets 2/16 wrong through (wc_0052 at 3.2°, wc_0070).
- Baseline: keeps 17/19 correct and lets 1 wrong through (wc_0070).

**Traps:**

| photo | strips agreeing (of 3) | B&B certified gap | outcome |
|---|---|---|---|
| wc_0001 | 0 | 0.097 | strips abstain, the gap does not |
| wc_0069 | 0 | ≈ 0 | both abstain |
| wc_0074 | 0 | ≈ 0 | both abstain |
| wc_0070 | 2 | 0.208, the largest of all 50 | top-1 is 0.3° from the known wrong basin; no skyline signal catches it |

## Recommendations
1. **Keep the baseline search.** B&B is 2–5× slower and only reaches the phase-averaged hit level, because the near-ties are in the scoring function itself.
2. **Adopt 3-strip agreement as the abstain signal.** It costs about 1–2 s.
3. **Use the closed form where speed matters.** It is 17× cheaper at a cost of 2 top-4 hits.
4. **Coarse-score re-ranking needs a pre-registered test.** The current result is post hoc.
5. **Skip the certified gap.** It adds nothing over the free fine gap, and it is confidently large on wc_0001 and wc_0070.

**Caveats.**
- n = 30, so AUROC differences under about 0.05 are noise.
- The gap neighbourhood is yaw-only.
- Gaps are on the coarse score, not the final fine ranking.
- vfov is the baseline's discrete set in every method.
