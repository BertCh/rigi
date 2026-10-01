// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// L3: resolution policies. When several estimates of one thing exist (a photo's saved, ground-truth,
// solved and prior poses), WHICH wins depends on the context, not on a global ranking of sources:
// in evaluation ground truth is an oracle and must never be shown; a "saved" pose is a person's
// endorsement of whatever produced it. A policy is an ordered list of rules over Provenance.

import type { Provenance, ProvenanceClass } from "./provenance";
import { agentOf } from "./provenance";

export type ResolutionRule = {
	readonly label: string;
	readonly match: (p: Provenance) => boolean;
};

export type ResolutionPolicy = {
	readonly label: string;
	readonly purpose: string;
	/** first matching rule ranks highest; estimates matching no rule are never chosen */
	readonly rules: readonly ResolutionRule[];
	/** where the policy is implemented today */
	readonly implementedBy: string;
};

const endorsed: ResolutionRule = {
	label: "endorsed by a person (saved, pinned, dragged, accepted suggestion)",
	match: (p) => p.status === "endorsed",
};
const groundTruth: ResolutionRule = {
	label: "hand-fitted ground truth",
	match: (p) => p.method === "ground-truth-fit" && p.role !== "oracle",
};
const acceptedSolve: ResolutionRule = {
	label: "accepted by a solver",
	match: (p) => agentOf(p) === "solver" && p.status === "accepted",
};
const prior: ResolutionRule = {
	label: "device prior (EXIF compass + gravity + lens)",
	match: (p) => p.role === "prior",
};

export const RESOLUTION_POLICIES = {
	rollDisplay: {
		label: "Roll display",
		purpose: "the pose drawn for each photo in /roll and the panorama",
		rules: [endorsed, groundTruth, acceptedSolve, prior],
		implementedBy: "lib/roll/roll.ts resolvePose",
	},
	rollStateless: {
		label: "Roll, ignoring this device's state",
		purpose:
			"a pose independent of saved/solved localStorage (lab views; ground truth is still shown)",
		rules: [groundTruth, prior],
		implementedBy:
			"lib/roll/roll.ts resolvePose({ignoreStored}) (routes/lab.generate.tsx)",
	},
	evaluation: {
		label: "Evaluation",
		purpose:
			"scoring: ground truth is an oracle and is never a candidate; only what the system itself produces competes",
		rules: [acceptedSolve, prior],
		implementedBy:
			"tools/bench harness + scripts/eval-app.mjs (outside resolvePose; resolvePose's ignoreGroundTruth option has no caller)",
	},
	workspace: {
		label: "Photo workspace",
		purpose:
			"the pose shown on /photo/$id: a person's choice, else a verified/accepted solve, else the best guess",
		rules: [
			endorsed,
			{
				label: "accepted and corroborated (verified)",
				match: (p) => p.status === "accepted" && p.corroborated === true,
			},
			acceptedSolve,
			{
				label: "best-guess candidate (near-compass, unverified)",
				match: (p) => p.status === "candidate" && p.role !== "prior",
			},
			prior,
		],
		implementedBy: "components/PhotoWorkspace.tsx (AlignState transitions)",
	},
} as const satisfies Record<string, ResolutionPolicy>;
export type ResolutionPolicyId = keyof typeof RESOLUTION_POLICIES;

/** Rank of `p` under `policy` (0 = best), or -1 if the policy never chooses it. */
export function rankUnder(
	policy: ResolutionPolicyId,
	p: ProvenanceClass,
): number {
	return RESOLUTION_POLICIES[policy].rules.findIndex((r) => r.match(p));
}

/** Pick the winning estimate under `policy`; ties keep input order. */
export function resolve<T>(
	policy: ResolutionPolicyId,
	items: readonly { value: T; prov: Provenance }[],
): { value: T; prov: Provenance; rank: number } | null {
	let best: { value: T; prov: Provenance; rank: number } | null = null;
	for (const it of items) {
		const rank = rankUnder(policy, it.prov);
		if (rank < 0) continue;
		if (!best || rank < best.rank) best = { ...it, rank };
	}
	return best;
}
