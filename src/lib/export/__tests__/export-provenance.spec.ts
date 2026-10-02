// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The workspace passes ExportMenu estimate = { provenance: workspaceProvenance(alignState, verify) }
// (PhotoWorkspace.tsx). An export is marked trusted exactly when the accept rule calls the pose accepted
// (nearfield/controller poseAccepted, the same test Refine uses to decide whether to save).

import { describe, expect, it } from "vitest";
import { poseAccepted } from "#/lib/nearfield/controller";
import {
	ALIGN_STATE,
	reachableWorkspaceStates,
	workspaceProvenance,
} from "#/lib/ontology/crosswalk/pose";
import { isTrustedEstimate } from "../camera";

describe("workspace export provenance", () => {
	it("is trusted exactly when the workspace pose is accepted", () => {
		for (const [alignState, verify] of reachableWorkspaceStates())
			expect(
				isTrustedEstimate({
					provenance: workspaceProvenance(alignState, verify),
					label: ALIGN_STATE[alignState].label,
				}),
				`${alignState} / ${verify}`,
			).toBe(poseAccepted(alignState, verify));
	});

	it("never trusts a compass prior or an unverified guess", () => {
		for (const a of ["prior", "near-compass", "unverified", "auto"] as const)
			expect(
				isTrustedEstimate({ provenance: workspaceProvenance(a, null) }),
			).toBe(false);
	});
});
