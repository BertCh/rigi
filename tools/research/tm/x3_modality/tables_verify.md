candidates: 32 correct refs, 128 wrong refs (over 50 photos)

| combo | AUC | correct refs supported ≥30 | wrong refs supported ≥30 | ≥100 | ≥300 | max wrong support | correct refs > max wrong |
|---|---|---|---|---|---|---|---|
| aliked:sat | 0.909 | 26/32 | 7/128 | 6 | 2 | 616 | 13 |
| aliked:p_dehaze | 0.926 | 28/32 | 6/128 | 6 | 2 | 624 | 14 |
| loma:sat | 0.942 | 29/32 | 7/128 | 6 | 3 | 743 | 15 |
| loma:hill | 0.895 | 23/32 | 4/128 | 3 | 1 | 319 | 17 |
| mroma:hill | 0.942 | 29/32 | 10/128 | 10 | 8 | 1902 | 18 |
| mxoftr:depth | 0.910 | 24/32 | 3/128 | 0 | 0 | 67 | 21 |
| mxoftr:hill | 0.911 | 24/32 | 5/128 | 0 | 0 | 79 | 19 |

Same, with the solve's INLIER FRACTION as the support score (scale-free; needed for dense MINIMA-RoMa):

| combo | AUC (frac) | max wrong frac | correct refs > max wrong frac | wrong refs with frac ≥ 0.3 | correct refs with frac ≥ 0.3 |
|---|---|---|---|---|---|
| aliked:sat | 0.905 | 0.95 | 0 | 4/128 | 27/32 |
| aliked:p_dehaze | 0.923 | 0.93 | 2 | 3/128 | 27/32 |
| loma:sat | 0.939 | 0.94 | 0 | 3/128 | 28/32 |
| loma:hill | 0.892 | 0.86 | 1 | 5/128 | 25/32 |
| mroma:hill | 0.941 | 0.49 | 19 | 3/128 | 25/32 |
| mxoftr:depth | 0.902 | 0.88 | 8 | 8/128 | 27/32 |
| mxoftr:hill | 0.910 | 0.88 | 6 | 3/128 | 26/32 |

Proposer + verifier (accept iff proposer ≥ 30 AND verifier ≥ t): correct refs accepted / wrong refs accepted

| proposer | verifier | t=10 | t=20 | t=30 | t=50 | proposer alone |
|---|---|---|---|---|---|---|
| aliked:sat | mxoftr:depth | 25 / 5 | 23 / 4 | 22 / 1 | 19 / 0 | 26 / 7 |
| aliked:sat | mxoftr:hill | 24 / 6 | 24 / 6 | 23 / 5 | 21 / 3 | 26 / 7 |
| aliked:sat | loma:hill | 24 / 4 | 22 / 3 | 22 / 3 | 21 / 3 | 26 / 7 |
| aliked:sat | mroma:hill | 25 / 6 | 25 / 6 | 25 / 6 | 25 / 6 | 26 / 7 |
| aliked:p_dehaze | mxoftr:depth | 26 / 5 | 24 / 4 | 23 / 1 | 20 / 0 | 28 / 6 |
| aliked:p_dehaze | mxoftr:hill | 25 / 6 | 24 / 6 | 23 / 5 | 21 / 3 | 28 / 6 |
| aliked:p_dehaze | loma:hill | 25 / 4 | 23 / 3 | 23 / 3 | 22 / 3 | 28 / 6 |
| aliked:p_dehaze | mroma:hill | 26 / 6 | 26 / 6 | 26 / 6 | 26 / 6 | 28 / 6 |
| loma:sat | mxoftr:depth | 27 / 5 | 25 / 4 | 24 / 1 | 21 / 0 | 29 / 7 |
| loma:sat | mxoftr:hill | 26 / 6 | 25 / 6 | 24 / 5 | 22 / 3 | 29 / 7 |
| loma:sat | loma:hill | 25 / 5 | 23 / 4 | 23 / 4 | 22 / 3 | 29 / 7 |
| loma:sat | mroma:hill | 28 / 7 | 28 / 7 | 28 / 7 | 28 / 7 | 29 / 7 |
| loma:hill | mxoftr:depth | 22 / 2 | 21 / 1 | 21 / 0 | 20 / 0 | 23 / 4 |
| loma:hill | mxoftr:hill | 22 / 3 | 21 / 3 | 21 / 3 | 19 / 1 | 23 / 4 |
| loma:hill | mroma:hill | 23 / 4 | 23 / 4 | 23 / 4 | 23 / 4 | 23 / 4 |
| mroma:hill | mxoftr:depth | 26 / 5 | 25 / 4 | 24 / 1 | 21 / 0 | 29 / 10 |
| mroma:hill | mxoftr:hill | 26 / 6 | 25 / 6 | 24 / 5 | 22 / 3 | 29 / 10 |
| mroma:hill | loma:hill | 25 / 5 | 23 / 4 | 23 / 4 | 22 / 3 | 29 / 10 |
| mxoftr:depth | mxoftr:hill | 24 / 1 | 23 / 1 | 23 / 0 | 22 / 0 | 24 / 3 |
| mxoftr:depth | loma:hill | 22 / 0 | 21 / 0 | 21 / 0 | 21 / 0 | 24 / 3 |
| mxoftr:depth | mroma:hill | 24 / 1 | 24 / 1 | 24 / 1 | 24 / 1 | 24 / 3 |
| mxoftr:hill | mxoftr:depth | 24 / 4 | 23 / 3 | 23 / 0 | 20 / 0 | 24 / 5 |
| mxoftr:hill | loma:hill | 22 / 4 | 21 / 3 | 21 / 3 | 21 / 3 | 24 / 5 |
| mxoftr:hill | mroma:hill | 24 / 5 | 24 / 5 | 24 / 5 | 24 / 5 | 24 / 5 |
