# v2 dev blind pack (written 2026-09-26T19:33:52Z, before any verdict was collected)

- Builder: build_pack.ts (Mapterhorn overlay.ts at the exact candidate eye; neutral "candidate XX" header; random labels and widths). Input cands.json; scoring key key.json (verifiers never see it).
- Verifiers: 2 fresh general-purpose agents (va, vb), each with its own scratch dir holding only copies of pack/<pid>/ under hashed folder names; C1–C4 checklist, near-miss = wrong, unsure only for unjudgeable skylines.
- Content: wc_0086 (v2 moved-eye HIGH, its duplicate, a +5° yaw decoy at the moved eye, and the same pose drawn at the stated eye); wc_0074 (v2 moved-eye LOW suggestion, the known-wrong ref A at the stated eye, a −5° decoy); wc_0004 (positive control: verified-correct ref A, and a +5° decoy).
- Decision rule: the wc_0086 moved-eye HIGH is **correct** iff both verifiers call the v2-moved candidate correct; **wrong** if either calls it wrong; otherwise unsure. Duplicate disagreement within a verifier → that verifier's verdict is unsure. If a verifier fails the positive control (wc_0004 ref A not correct) or accepts a decoy, their verdicts are reported but flagged. wc_0074 is informational (suggestion path, not an accept).

## Round 2 (written 2026-09-26T19:38:30Z, after round 1, before any round-2 overlay was rendered)

Round 1 result for wc_0086: va **unsure** (skyline hidden under the overlay title bar), vb correct (moderate confidence, same caveat) → **unsure** under the rule above. Both verifiers independently reported that the black title bar covered wc_0086's skyline. That is a pack defect, not a method result, so wc_0086 is re-packed once:
- PACK_PAD=1: the photo is padded with equal black bands top and bottom and the vfov widened to match (exact for a centred pinhole), so the bar covers only padding.
- Same 4 wc_0086 candidates with new random labels and widths, plus the wc_0004 positive control and a new −4° decoy.
- 2 NEW fresh verifiers (vc, vd), same checklist and instructions, same decision rule. Round 2 replaces round 1 for wc_0086 only; both rounds are reported.
