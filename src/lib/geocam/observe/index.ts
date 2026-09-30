// GA2 observability gate (reports/geometry-first-pose.md G2, guard-rail §4.1):
//   crlb           Fisher information / CRLB per DoF from prediction Jacobians (row σ only)
//   heldOutFamily  re-solve without a cue family and test whether it confirms the move
//   eyeMayMove     σ_eye < 15 m AND a held-out family confirms AND GA5 passes
export * from "./fisher";
export * from "./gate";
export * from "./heldout";
