// Crosswalk: every pose-provenance word in the app → canonical Provenance axes. `satisfies Record<Union, …>`
// makes each table exhaustive: a new member of an app union is a compile error here until classified.
// Imports from the app are type-only, so this file pulls no app code into a bundle.

import type {
	AppAlign,
	SecondOpinion,
	SecondOpinionVerdict,
} from "#/lib/integration/second-opinion";
import type {
	UnknownPoseOutcome,
	UnknownPoseResult,
} from "#/lib/integration/unknown-pose";
import type { MatchResult } from "#/lib/matcher-client";
import type { CandidateSource } from "#/lib/picker/candidates";
import type { AlignStatus } from "#/lib/roll/align/align";
import type { AnchorKind } from "#/lib/roll/propagate/plan";
import type { RowStatus } from "#/lib/roll/propagate/run";
import type { StoredSuggestion } from "#/lib/roll/propagate/store";
import type { PoseSource } from "#/lib/roll/types";
import type { Assert, Covers } from "../core/assert";
import type { ProvenanceClass } from "../core/provenance";
import { agentOf, isTrustedAuto } from "../core/provenance";

type Row = ProvenanceClass & { readonly label: string; readonly hint: string };

// ---- roll: where a roll photo's pose came from ------------------------------------------------------

export const POSE_SOURCE = {
	saved: {
		status: "endorsed",
		label: "saved",
		hint: "Pose you saved in the workspace",
	},
	"ground-truth": {
		agent: "reference",
		method: "ground-truth-fit",
		status: "accepted",
		label: "fitted",
		hint: "Hand-fitted to the terrain",
	},
	/** the class of the common case; the exact one is solvedPoseProvenance(SolvedPose.method) */
	solved: {
		agent: "solver",
		method: "cascade",
		status: "accepted",
		label: "solved",
		hint: "Aligned to the terrain by the roll aligner (skyline match)",
	},
	prior: {
		agent: "sensor",
		method: "exif-prior",
		role: "prior",
		status: "candidate",
		label: "prior",
		hint: "From EXIF: compass, gravity and lens (can be off by 10°+)",
	},
} as const satisfies Record<PoseSource, Row>;

/**
 * SolvedPose.method values. Writers: roll/align/align.ts ("cascade"; a viewpoint bias only shifts the
 * prior fed to the cascade, it never names the stored method) and roll/propagate/store.ts.
 */
export const SOLVE_METHOD = {
	cascade: { agent: "solver", method: "cascade", status: "accepted" },
	"propagated-suggestion": {
		agent: "user",
		method: "propagate",
		status: "endorsed",
		level: "low",
	},
} as const satisfies Record<string, ProvenanceClass>;
export type SolveMethod = keyof typeof SOLVE_METHOD;

/** A roll "solved" pose is an accepted cascade OR a person's accepted suggestion: the method decides. */
export const solvedPoseProvenance = (method: SolveMethod): ProvenanceClass =>
	SOLVE_METHOD[method];

export const ROLL_ALIGN_STATUS = {
	accepted: { agent: "solver", method: "cascade", status: "accepted" },
	"needs-review": { agent: "solver", method: "cascade", status: "candidate" },
	failed: { agent: "solver", method: "cascade", status: "failed" },
} as const satisfies Record<AlignStatus, ProvenanceClass>;

export const PROPAGATE_ROW_STATUS = {
	skipped: { method: "propagate", status: "failed" },
	queued: { method: "propagate", status: "pending" },
	running: { method: "propagate", status: "pending" },
	error: { method: "propagate", status: "failed" },
	rejected: { method: "propagate", status: "rejected" },
	suggested: { method: "propagate", status: "candidate" },
} as const satisfies Record<RowStatus, ProvenanceClass>;

export const SUGGESTION_STATUS = {
	pending: { method: "propagate", status: "candidate" },
	accepted: { agent: "user", method: "propagate", status: "endorsed" },
	dismissed: { agent: "user", method: "propagate", status: "rejected" },
} as const satisfies Record<StoredSuggestion["status"], ProvenanceClass>;

/** propagate/plan.ts AnchorKind: a parallel copy of PoseSource restricted to anchor-worthy poses. */
export const ANCHOR_KIND = {
	saved: POSE_SOURCE.saved,
	solved: POSE_SOURCE.solved,
	"ground-truth": POSE_SOURCE["ground-truth"],
} as const satisfies Record<AnchorKind, ProvenanceClass>;

/**
 * Canonical anchor rule for propagation: an endorsed or solver-accepted pose that did not itself come
 * from propagation (no chaining); ground truth only in dev mode. propagate/plan.ts anchorKind must agree.
 */
export function isPropagationAnchor(
	p: ProvenanceClass,
	mode: "off" | "on" | "dev",
): boolean {
	if (mode === "off" || p.method === "propagate") return false;
	if (p.method === "ground-truth-fit") return mode === "dev";
	return (
		p.status === "endorsed" ||
		(agentOf(p) === "solver" && p.status === "accepted")
	);
}

// ---- workspace: the pose shown on /photo/$id -----------------------------------------------------------

/**
 * The workspace's align state. Canonical home of the union PhotoWorkspace.tsx declares locally
 * (adoption there waits on in-flight patches; see reports/ontology.md Findings). `label` is a
 * PROPOSED UI word: the workspace shows its alignNote text, not these labels.
 */
export const ALIGN_STATE = {
	auto: {
		method: "skyline-align",
		status: "accepted",
		label: "Auto-aligned",
		hint: "autoAlign result (preview: confidence > 0.2; a re-run from the prior sets it unconditionally); never HIGH alone",
	},
	"near-compass": {
		method: "near-compass",
		status: "candidate",
		label: "Near compass",
		hint: "ambiguous skyline: refined near the compass heading",
	},
	prior: {
		agent: "sensor",
		method: "exif-prior",
		role: "prior",
		status: "candidate",
		label: "Phone sensors",
		hint: "compass + gravity; the skyline match was weak",
	},
	saved: {
		status: "endorsed",
		label: "Saved",
		hint: "your saved alignment, or a bundled sample's shipped pose (demo / roll aligner on the author's device)",
	},
	accepted: {
		agent: "solver",
		status: "accepted",
		level: "high",
		label: "Accepted",
		hint: "a strict independent check (cascade or matcher) accepted it",
	},
	unverified: {
		status: "candidate",
		corroborated: false,
		label: "Unverified",
		hint: "best guess: priors are missing, or the solvers disagree; may be the placeholder prior",
	},
	manual: {
		agent: "user",
		status: "endorsed",
		label: "Manual",
		hint: "you moved it, re-ran a refine from it, or took an eye-search result",
	},
	pinned: {
		agent: "user",
		method: "pin-solve",
		status: "endorsed",
		label: "Pinned",
		hint: "solved from the peaks you pinned",
	},
} as const satisfies Record<string, Row>;
export type AlignState = keyof typeof ALIGN_STATE;

/** AppAlign.state ⊂ AlignState (the automatic preview states). */
export type _appAlignIsAlignState = Assert<
	Covers<AlignState, AppAlign["state"]>
>;

export const VERDICT = {
	verified: { outcome: "kept", corroborated: true },
	refined: {
		outcome: "replaced",
		method: "cascade",
		status: "accepted",
		level: "high",
	},
	kept: { outcome: "kept" },
	unverified: { outcome: "kept", corroborated: false },
	matched: {
		outcome: "replaced",
		method: "matcher",
		status: "accepted",
		level: "high",
	},
	timeout: { outcome: "timeout" },
} as const satisfies Record<SecondOpinionVerdict, ProvenanceClass>;

/** The workspace's `verify` state: a verdict, "pending" while it runs, or null (none / user took over). */
export type Verify = SecondOpinionVerdict | "pending" | null;

export const MATCHER_STATE = {
	unavailable: { method: "matcher", outcome: "unavailable" },
	busy: { method: "matcher", status: "pending" },
	"no-result": { method: "matcher", status: "failed" },
	/** any result failing matchAccepted, including HIGH matches the product rule rejects */
	low: { method: "matcher", status: "rejected" },
	high: { method: "matcher", status: "accepted", level: "high" },
} as const satisfies Record<
	NonNullable<SecondOpinion["matcher"]>,
	ProvenanceClass
>;

/** The matcher's native level, before the product accept rule (matchAccepted). */
export const MATCH_LEVEL = {
	high: { method: "matcher", level: "high" },
	low: { method: "matcher", level: "low" },
} as const satisfies Record<
	NonNullable<MatchResult["confidenceLevel"]>,
	ProvenanceClass
>;

/**
 * Provenance of the workspace pose from (alignState, verify). A verdict belongs to the AUTOMATIC pose
 * it judged: on a person's pose it is stale and ignored. A verdict that REPLACED the pose supplies the
 * method; one that KEPT it adds only outcome/corroboration.
 */
export function workspaceProvenance(
	alignState: AlignState,
	verify: Verify,
): ProvenanceClass {
	const base: ProvenanceClass = { ...ALIGN_STATE[alignState] };
	if (verify == null || base.status === "endorsed") return base;
	if (verify === "pending") return { ...base, status: "pending" };
	return { ...base, ...VERDICT[verify] };
}

/**
 * (alignState, verify) pairs the workspace reaches by design (PhotoWorkspace.tsx, second-opinion.ts):
 * "verified" only confirms an "auto" preview (appAccepted); "refined"/"matched" promote to "accepted";
 * onUnverified sets "unverified" while the check is still pending; a person's pose clears verify.
 */
export function reachableWorkspaceStates(): [AlignState, Verify][] {
	const out: [AlignState, Verify][] = [];
	for (const a of Object.keys(ALIGN_STATE) as AlignState[]) out.push([a, null]);
	for (const a of ["auto", "near-compass", "prior", "unverified"] as const)
		out.push([a, "pending"]);
	out.push(["auto", "verified"]);
	for (const a of ["auto", "near-compass", "prior"] as const)
		for (const v of ["kept", "timeout"] as const) out.push([a, v]);
	out.push(["unverified", "unverified"]);
	for (const v of ["refined", "matched"] as const) out.push(["accepted", v]);
	return out;
}

/**
 * Pairs once reached through the STALE-VERIFY bug (fixed in b9d29b1): an eye move or restored save
 * re-created the engine and set "manual"/"saved" without clearing an aborted verdict. Unreachable now;
 * kept so the checks prove every gate would still ignore a verdict on a person's pose.
 */
export function staleVerifyStates(): [AlignState, Verify][] {
	const out: [AlignState, Verify][] = [];
	for (const a of ["manual", "saved"] as const)
		for (const v of [
			"pending",
			"verified",
			"refined",
			"matched",
			"kept",
			"unverified",
			"timeout",
		] as const)
			out.push([a, v]);
	return out;
}

/** Canonical "HIGH" for the workspace pose (= picker isAutoHigh on every reachable state). */
export const workspaceIsTrustedAuto = (a: AlignState, v: Verify) =>
	isTrustedAuto(workspaceProvenance(a, v));

/** Canonical "usable": a person's pose, or a trusted automatic one (= nearfield poseAccepted). */
export const workspaceIsSettled = (a: AlignState, v: Verify) => {
	const p = workspaceProvenance(a, v);
	return p.status === "endorsed" || isTrustedAuto(p);
};

// ---- integration outcomes -------------------------------------------------------------------------

export const UNKNOWN_OUTCOME_STATE = {
	accepted: { status: "accepted", level: "high" },
	unverified: { status: "candidate", corroborated: false },
} as const satisfies Record<UnknownPoseOutcome["state"], ProvenanceClass>;

export const UNKNOWN_OUTCOME_SOURCE = {
	cascade: { agent: "solver", method: "cascade" },
	matcher: { agent: "solver", method: "matcher" },
	/** the fallback: on load the placeholder prior (yaw 0, default focal); from a re-run, the current pose */
	none: { agent: "rule", method: "default", role: "prior" },
} as const satisfies Record<UnknownPoseOutcome["source"], ProvenanceClass>;

/** The cascade's stage names the exact method. */
export const CASCADE_STAGE = {
	solve: { agent: "solver", method: "cascade-solve" },
	refine: { agent: "solver", method: "cascade-refine" },
} as const satisfies Record<UnknownPoseResult["stage"], ProvenanceClass>;

export const CANDIDATE_SOURCE = {
	shown: { status: "candidate" },
	align: { agent: "solver", method: "skyline-align", status: "candidate" },
	cascade: { agent: "solver", method: "cascade", status: "candidate" },
	tap: { agent: "user", method: "picker-tap", status: "candidate" },
} as const satisfies Record<CandidateSource, ProvenanceClass>;
