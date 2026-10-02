# Step ⑤ accept-rule: review, research, plan (2026-10-02)

*Step lead: accept-rule pod (session mt-image-17 step pods). Node `accept-rule` in `src/lib/gipfelbuch/graph.ts:206`, "A wrong pose is worse than no pose." Dev data only; the wild test half and `data_v3` were not read. The frozen product rule (`matchAccepted`) was not changed.*

## 1. Current state

How a pose becomes HIGH in the live app:

| Stage | Code | Accept test |
|---|---|---|
| Preview | `integration/second-opinion.ts:83` `choosePreview` | autoAlign confidence > 0.2 → state `auto` (never HIGH alone; 43% wild precision) |
| Second opinion (full metadata) | `second-opinion.ts:214` `opinionFromCascade` | cascade accepted ∧ app `auto` ∧ \|Δyaw\| ≤ 1° → `verified`; cascade accepted otherwise → `refined`; else `shouldEscalate` → matcher → `matched` / `unverified`; `kept`, `timeout` |
| Cascade | `geo/pipeline.ts:86`, `geo/solve.ts:464` (0.5), `refine/confidence.ts:219` (score ≥ 0.5 ∧ no hard fail), `integration/unknown-pose-core.ts:214` (0.75 when yaw or focal unknown, `ambiguous`, `weak360`) | |
| Product rule (frozen) | `matcher-client.ts:146` `matchAccepted` | fused HIGH ∧ (trusted EXIF GPS ∨ cascade within 0.5° yaw and pitch) |
| Uploads / missing sensors | `integration/unknown-pose.ts` `resolveUnknownPose` | cascade accepted, else matcher under the product rule, else `unverified` |
| Consumers | `nearfield/controller.ts:80` `poseAccepted`; `picker/candidates.ts:215` `isAutoHigh`; `concord/app/useConcordDisplay.ts:27` `concordConfidence`; `share/index.ts:17` `SHAREABLE_STATES` | four different definitions of "accepted" (§2 P2-1) |
| UI | `components/PhotoWorkspace.tsx` | Verified/Refined badge for verified, refined, matched; "Unverified alignment" banner for state `unverified`; export lock while `verify === "pending"` |

Hand-set thresholds on the path: about twenty constants in nine files (choosePreview 0.2; NEAR_WINDOW 4°/1.5°; solve 0.5 and FULL_SEARCH 0.75; tilt gate 3°; solve ramps; refine six ramps + two hard gates; AGREE_DEG 1° yaw only; shouldEscalate 0.5 and 1°; MATCH_AGREE_DEG 0.5°; YAW/FOCAL_UNKNOWN 0.75; concord 0.5; matcher-v01 0.5; the server's fused HIGH checks cueAgree < 1°, skyMed < 4 px, support ≥ 0.3, basinGap < 0.2; timeouts 20 s / 150 s). None is calibrated (`ontology/core/confidence.ts`, every scale `calibrated: false`).

Tests: `second-opinion.spec.ts` and `second-opinion-flow.spec.ts` cover the full verdict table including busy/upgrade, timeout and abort; `concord/app/__tests__/confidence.spec.ts`, `refine/__tests__/confidence.spec.ts`, `picker/__tests__/candidates.spec.ts` and `__tests__/matcher-client.spec.ts` exist. Coverage was not the gap.

## 2. Findings

### P1 (fixed in this pass, see §5)

1. **Auto-align persisted an unverified pose, which came back as accepted after a reload.** `PhotoWorkspace.tsx` `runAlign` → `eng.autoAlign` → `setPose(res.pose)` persisted any result. On reload a persisted pose is restored as state `saved` (`PhotoWorkspace.tsx:595`), which `poseAccepted` and `SHAREABLE_STATES` treat as accepted, so a low-confidence auto-align (43% wild precision) became an accepted pose for Step Inside and share links. The load path already refuses this ("an unverified guess is not saved as the user's alignment"). Found in review: Refine had the same leak one step later (Auto-align, then Refine, saved the refined unverified pose), and a pending load-time second opinion could still settle after the user pressed a button. Now a refinement is saved only when the start pose was already accepted or the user's own and no sensor is missing; otherwise the note says "· not saved".
2. **`kept` and `timeout` were silent.** Both return `note: ""`, so the workspace kept showing "Auto-aligned to skyline · confidence N%" with no badge and no banner. That reads as success, but the pose is not HIGH (Step Inside off, concord LOW). A cascade *error* gives the same silent `kept`.
3. **No `.catch` on two `upgrade` chains** (`PhotoWorkspace.tsx` load path and second-opinion handler). `requestMatch` never rejects today, but a throw in the callback would be an unhandled rejection.

### P2 (proposed, not done)

1. **Four definitions of "accepted".** `poseAccepted` (includes manual/pinned/saved), `isAutoHigh` (auto verdicts only), `concordConfidence` (ignores `alignState` for verdicts), `SHAREABLE_STATES` (excludes `auto`+`verified`, so a verified pose cannot be shared). One predicate in `ontology/crosswalk/pose.ts` (`workspaceIsTrustedAuto` already exists there but no runtime gate calls it) with each consumer stating which of {auto-HIGH, user-endorsed} it wants. Owners: picker (pod B, off-limits now), share (pod E), ontology (bb). Bit-identical refactor plus a cross spec in `src/test/cross/`.
2. **`verified` checks yaw only.** `second-opinion.ts:238` compares \|Δyaw\| ≤ AGREE_DEG; `shouldEscalate` and `matchAccepted` compare yaw and pitch. A cascade that accepts with the same yaw but a pitch 1–3° away leaves the app pose labelled `verified` instead of `refined` (cascade pose). Both are HIGH, so the fix changes which pose is shown, not whether one is. Behaviour change → opt-in flag and a GT-14 eval-app comparison in a batch pass.
3. **`concord` MIN_CONFIDENCE is dead in the app path.** `concordConfidence` returns `{accepted: true, level: "high"}` with no number, so `isLowConfidence` never reads `MIN_CONFIDENCE` (`concord/app/confidence.ts:21`). Harmless (fails closed), but the Gipfelbuch and ontology describe a 0.5 bar that does not act.
4. **`ALIGN_STATE.auto.status = "accepted"`** (`ontology/crosswalk/pose.ts:137`) contradicts "never HIGH alone"; it should be `candidate`. Ontology-owned.
5. **`positionSource` defaults to trusted.** `integration/unknown-pose.ts:263` returns `exif-gps` for anything that is not explicitly `pin`. All current upload records set the field and bundled photos carry GPS, so nothing leaks today, but an unknown provenance should be untrusted (fail closed). The server's `confidenceChecks.positionTrusted` overrides the client value anyway. Pod B is in this file; propose after it lands.
6. **Roll accepts on the cascade alone** (`roll/align/align.ts:~246`), with no second opinion. The cascade is the strongest single gate on record (dev 10/10), so this is a documented choice, not a bug; say so in the roll README.

### P3

- `refine/confidence.ts:65` says the ramps were "calibrated on the 9 hand-solved photos"; GT has 12–14 now and none of the ramps was refit. Doc fix.
- `angDist` duplicated (`matcher-client.ts`, `second-opinion.ts`); 0.75 bar defined twice (`solve.ts:274` unexported, `unknown-pose-core.ts:40,47`); 150 s matcher timeout in two files.
- Dead or test-only exports: `matchIsConfident` outside its file, `MIN_CONFIDENCE`, `workspaceIsTrustedAuto`/`workspaceIsSettled` (ontology checks only), geocam GA5 integrity (unwired, kept on purpose as a veto-panel candidate).
- A crafted share link can carry state `accepted` (`share/index.ts:120`); impact is low (the pose is the sender's). Pod E.

## 3. Research

### Our own record (never redo without a new reason)

- Frozen rule and its evidence: `reports/test-results.md`, `reports/test-addendum.md` (wild test SPENT 2026-09-26; product rule 11/11 on v0.3.4; T6 failed EXIF-HIGH precision post hoc and stays opt-in).
- Killed accept/veto ideas (`reports/negative-results.md`): looser rule HIGH ∧ (EXIF ∨ gap ≥ 0.20) (l.20); 360° cascade at 0.5 (l.18); margin rule; X2 monocular depth veto (l.50); X5 learned verifier, AUROC 0.40–0.69 (l.53); FUND E1 a-contrario with decoy null, 10/56 displaced-eye decoys accepted (l.60); GA2 CRLB gate; GA3 T-junction eye cue (l.97); GA5 solution separation as a zero-loss veto (rejects 12/33 correct; wrong-basin AUROC 0.94, wrong-eye 0.83; kept as a candidate, l.99); GA1 σ over-confident ×2.5 (l.100); SKYPAR skyline parallax wrong-eye test, killed 2026-10-02 (l.101).
- Open: R1 blind verification of the 120-overlay hard-negative pack (Ready) → R2 veto prereg (needs ≥ 30 hard negatives, must pass E1's displaced-eye decoys) → R3 recall levers; N4 basin-gap re-derivation; wrong-eye rejection (FUND, pod C owns E4/E5 now).

### Literature (what to take from it)

- **Selective prediction with a guarantee.** Geifman & El-Yaniv, "Selective Classification for Deep Neural Networks", NeurIPS 2017 (SGR: pick the threshold whose binomial upper bound on selective risk is under target). Angelopoulos, Bates, Candès, Jordan, Lei, "Learn then Test", arXiv 2110.01052 (2021): threshold choice as multiple testing; fixed-sequence over a pre-set grid controls FWER. Angelopoulos et al., "Conformal Risk Control", ICLR 2024. Jin & Candès, "Selection by Prediction with Conformal p-values", JMLR 2023 (FDR control on accepted items, i.e. a precision guarantee). *Take:* a threshold should come with "risk ≤ α with probability ≥ 1−δ", and that needs counts we do not have (below).
- **Small-n honesty.** Clopper & Pearson, Biometrika 1934: exact binomial bounds. 0 wrong in n accepts bounds precision only at α^(1/n) (17/17 → 0.84). *Take:* report lower bounds next to point precisions.
- **Risk–coverage evaluation.** Chow, "On optimum recognition error and reject tradeoff", IEEE TIT 1970; Ding et al., E-AURC, 2020. *Take:* compare gates by their curve, not one operating point.
- **A-contrario validation.** Desolneux, Moisan, Morel, *From Gestalt Theory to Image Analysis*, 2008; Moisan & Stival, ORSA, IJCV 2004. Tried as FUND E1: the null was degenerate (90% of hypotheses score 0) and blind to eye error. Do not retry without a non-degenerate null.
- **Integrity monitoring.** GNSS RAIM / ARAIM solution separation (Brown 1992; Blanch et al., ARAIM, 2012–2015): a protection level bounds the error and raises an alert, it is not a zero-loss veto. GA5 is this idea; its AUROC 0.94 suggests using it to *route to the picker* (suggestion) rather than as a hard veto. That still needs a prereg because it lowers recall.
- **Mountain localization.** Baatz et al., ECCV 2012; Saurer et al., "Image Based Geo-localization in the Alps", IJCV 2016; Brejcha & Čadík, GeoPose3K, 2017. These report recall at an error threshold, not a calibrated refusal, so there is no published accept rule to adopt. PeakVisor and PeakFinder align by hand.
- **Pose verification.** Taira et al., InLoc dense pose verification, CVPR 2018; Sarlin et al., PixLoc, CVPR 2021 (feature-metric cost as confidence). This is pod C's E4 lineage.
- **Combining hand gates.** With 10–20 labelled accepts, isotonic or Platt calibration is not identifiable beyond one or two features; the product of ramps (`refine/confidence.ts`) is a hand "noisy-AND" and should stay until there is data.

### Dev evidence from the new tool

`npx tsx scripts/accept/risk-coverage.ts` (wild dev half, 50 rows; planning evidence, not a result):

| Gate | Accepted | Wrong or unsure | Precision | 95% lower bound |
|---|---|---|---|---|
| cascade conf ≥ 0.5 (all dev rows are yaw-unknown) | 10 | 0 | 1.00 | 0.74 |
| cascade conf ≥ 0.75 | 10 | 0 | 1.00 | 0.74 |
| fused HIGH | 16 | 1 | 0.94 | 0.74 |
| fused HIGH, EXIF-GPS photos | 5 | 0 | 1.00 | 0.55 |

Learn-then-Test (δ 0.1, grid 0.95 … 0.05) certifies no cascade threshold at 5% or 10% risk: dev has too few accepts. Sizing: a precision lower bound of 0.90 needs 29 clean accepts, 0.95 needs 59, 0.99 needs 299; one wrong accept raises 0.95 to 93.

**Consequence for N3 / R6:** at ~20% coverage, a 100-photo sealed set gives ~20 accepts, which can certify at most ~0.86 even with zero wrong. Certifying 0.95 needs ~300 photos at today's coverage. Retuning any threshold on the dev half cannot be justified statistically; the thresholds should stay frozen until N3 is larger.

## 4. Plan

| # | Unit | Size | Risk | Gate | When |
|---|---|---|---|---|---|
| A1 | `src/lib/accept/bounds.ts` + `scripts/accept/risk-coverage.ts` | S | none (tooling) | specs | **landed** |
| A2 | Workspace: Auto-align never saves, Refine saves only from an accepted/user pose; user align aborts a pending second opinion; `notVerifiedReason` suffix for `kept`/`timeout`; logged `.catch` on `upgrade` | S | low, UI | specs + batch row | **landed** |
| A3 | One "accepted" predicate + cross spec (P2-1), bit-identical | M | low | `src/test/cross` spec | after pods B/E land; needs picker, share and ontology owners |
| A4 | `verified` compares pitch too (P2-2), flag `secondOpinionPitch` off | S | medium (pose shown changes) | eval-app GT-14 both engines in a batch | next wave |
| A5 | `positionSource` fail closed on unknown provenance (P2-5) | XS | low | spec | after pod B leaves `unknown-pose.ts` |
| A6 | Risk-coverage panel per gate in the R2 prereg: require each veto candidate (GA5 routing, H2 set) to report its curve and CP bounds on the hard-negative pack and E1 decoys | S | none | prereg text | with R2 (waits on R1) |
| A7 | GA5 as a *router to the picker*, not a veto: when the protection level alerts, show the pose as a suggestion with the top-3 picker open | M | medium (recall) | R2 prereg; owner sign-off | later |
| A8 | Doc fixes: refine "9 photos" comment, concord dead bar, ontology `auto` status | XS | none | | with A3 |

Needs the user: (1) N3 size: ~300 photos to certify 0.95 at today's coverage vs the planned ~100; (2) whether A7's "route to the picker" is an acceptable product meaning for a GA5 alert; (3) A4 changes which pose is shown on a pitch disagreement.

## 5. What landed

Two iterations (implement → independent Sonnet review → fix → second review, no blockers left).

| Commit | What |
|---|---|
| ab56aad | `src/lib/accept/bounds.ts` + spec (binomial CDF, one-sided Clopper-Pearson, `riskCoverage`, `riskAt`, fixed-grid `learnThenTest`, `acceptsNeeded`); `scripts/accept/risk-coverage.ts` (dev rows only) |
| 36adadc | Auto-align no longer persists; `notVerifiedReason` (`second-opinion.ts`) appended to the note for `kept`/`timeout`; `.catch` on both `upgrade` chains; specs (WIP, browser-unverified) |
| a90cc8b | Review fixes: Refine saves only from an accepted or user pose with all sensors (else "· not saved"); a user align aborts a pending second opinion first; upgrade errors logged; `riskAt` ignores non-finite scores; the evidence script cross-checks `tools/bench/split.json` ids (WIP, browser-unverified) |

Batch-ledger row: "accept-rule (step ⑤)", 36adadc + a90cc8b.

Checks: `npx tsc --noEmit -p .` clean; `npx vitest run src/lib/accept src/lib/integration` 89/89; biome clean on the changed files; `node scripts/ci/spdx.mjs` clean. The full fast tier in the worktree ran under a load average of 17–32: 101 pass, 12 fail, none in a touched file (8 timeouts, `roll-propagate` missing the worktree's `public/photos/photos.json`, `render-lock-signals` never started, `biome` new errors in a peer's `roll/import` files on master, `unit` 3 failures from the worktree's symlinked node_modules being denied by vite's fs allow list and the python-unit colour output). Not re-run on an idle machine.

Not measured: no browser run of the workspace changes; no eval-app numbers. Negative: none tried. Re-review found that Refine laundered an unsaved Auto-align pose one click later, now fixed.

Next, in order: (1) A3 one "accepted" predicate once pods B and E land; (2) A6 put risk-coverage curves and CP bounds into the R2 prereg text; (3) the user's N3 sizing decision.

## 6. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts and pages not edited)

- `graph.ts` accept-rule `summary`: "About a dozen hand-set thresholds" → "About twenty hand-set thresholds in nine files, none calibrated". `modules` should add `src/lib/matcher-client.ts` (the frozen product rule lives there), `src/lib/ontology/core/confidence.ts` and `src/lib/accept/bounds.ts`.
- `pages/accept-rule.tsx:789`: `shouldEscalate` "solvers disagree > 1°" applies to yaw *and* pitch; `agree` (AGREE_DEG) is yaw only.
- The verdict tree should show that `kept` and `timeout` are "not verified" (now said in the UI), not a silent pass.
- A "precision 1.00" figure should carry its lower bound (17/17 → ≥ 0.84 at 95%; dev 10/10 → ≥ 0.74).
