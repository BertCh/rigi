// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// PhotoWorkspace's one concord call site (?concord=occl). Without the flag this hook does nothing at all:
// no import of the display pass, no renderer call. With it, it runs the display pass (display.ts) once the
// pose is final: the load is done (no status), the second opinion has settled, and the pose is
// accepted/verified. Any other state (manual drag, pins, unverified, prior fallback) is LOW confidence:
// the occluder is cleared and nothing is computed (plan §5, the wc_0069 trap).
import { type RefObject, useEffect } from "react";
import type { AlignState, Verify } from "#/lib/ontology/crosswalk/pose";
import type { Renderer } from "../../renderer";
import { concordFlags } from "../flags";
import type { PoseConfidence } from "./confidence";

export type ConcordPoseState = {
	/** The shown pose (any identity change re-runs the pass). */
	pose: unknown;
	/** True once the load finished and the second opinion is not pending. */
	settled: boolean;
	/** PhotoWorkspace's second-opinion verdict. */
	verify: Verify;
	/** PhotoWorkspace's align state. */
	alignState: AlignState | null;
};

/** The app's pose state → PoseConfidence; fail closed (null = LOW). */
export function concordConfidence(s: ConcordPoseState): PoseConfidence | null {
	if (!s.settled) return null;
	if (
		s.verify === "verified" ||
		s.verify === "refined" ||
		s.verify === "matched" ||
		s.alignState === "accepted"
	)
		return { accepted: true, level: "high" };
	return null;
}

export function useConcordDisplay(
	engineRef: RefObject<Renderer | null>,
	s: ConcordPoseState,
) {
	const { pose, settled, verify, alignState } = s;
	useEffect(() => {
		const flags = concordFlags();
		if (!flags.occl) return;
		const engine = engineRef.current;
		if (!engine || !pose) return;
		const confidence = concordConfidence({
			pose,
			settled,
			verify,
			alignState,
		});
		// an occluder belongs to the pose it was computed at: drop it until this pose's pass lands
		engine.setOccluder(null);
		if (!confidence) return;
		const ctl = new AbortController();
		// let the final pose's frame and readback land first
		const timer = setTimeout(() => {
			import("./display")
				.then((m) => m.runConcordDisplay(engine, confidence, flags, ctl.signal))
				.then((report) => {
					if (ctl.signal.aborted) return;
					console.debug("[concord]", report);
					window.__concord = report;
				})
				.catch((e) => console.warn("[concord]", e));
		}, 250);
		return () => {
			clearTimeout(timer);
			ctl.abort();
		};
	}, [engineRef, pose, settled, verify, alignState]);
}
