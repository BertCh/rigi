// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roadmap R5 orchestration: one accepted anchor → its neighbours → relative rotation (in-browser
// estimator, ./estimator.ts) → gate.
// Gated rows become StoredSuggestions (pending until the user accepts or dismisses). Nothing is accepted here.
import type { Mat3 } from "../../nearfield/propagate";
import { PROPAGATE_GATE } from "../../nearfield/propagate";
import type { Roll, RollPhoto } from "../types";
import { relRot, relRotAvailable } from "./estimator";
import {
	type AnchorKind,
	type Candidate,
	candidatesFor,
	cycleDeg,
	PROVENANCE,
	type PropagateMode,
	type Proposal,
	poseDeltaDeg,
	propose,
	type RelRotResult,
} from "./plan";
import { dropPending, putSuggestion, type StoredSuggestion } from "./store";

export type RowStatus =
	| "skipped"
	| "queued"
	| "running"
	| "error"
	| "rejected"
	| "suggested";

export type PropagateRow = {
	candidate: Candidate;
	status: RowStatus;
	/** Skip / error / gate-rejection reasons. */
	reasons: string[];
	result?: RelRotResult;
	proposal?: Proposal;
	cycleWith?: string;
	/** Dev: geodesic angle between the suggestion and the photo's current pose. */
	deltaToCurrentDeg?: number;
	suggestion?: StoredSuggestion;
};

export type PropagateRun = {
	anchorId: string;
	anchorKind: AnchorKind;
	/** The estimator's feature models loaded (the former "service up"). */
	available: boolean;
	rows: PropagateRow[];
	done: boolean;
};

/** Row reason when the feature models cannot load (weights missing, no runtime). */
export const UNAVAILABLE =
	"relative-rotation estimator unavailable (feature models did not load)";

const img = (p: RollPhoto, vfov: number) => ({ src: p.meta.src, vfov });

export async function runPropagation(
	roll: Roll,
	anchor: RollPhoto,
	anchorKind: AnchorKind,
	mode: PropagateMode,
	onUpdate: (r: PropagateRun) => void,
	signal?: AbortSignal,
): Promise<PropagateRun> {
	const rows: PropagateRow[] = candidatesFor(roll, anchor, mode).map((c) => ({
		candidate: c,
		status: c.skip ? "skipped" : "queued",
		reasons: c.skip ? [c.skip] : [],
	}));
	const run: PropagateRun = {
		anchorId: anchor.meta.id,
		anchorKind,
		available: await relRotAvailable(true),
		rows,
		done: false,
	};
	const emit = () => onUpdate({ ...run, rows: [...rows] });
	if (!run.available) {
		for (const r of rows)
			if (r.status === "queued") {
				r.status = "error";
				r.reasons = [UNAVAILABLE];
			}
		run.done = true;
		emit();
		return run;
	}
	emit();

	// pass 1: anchor → each neighbour
	for (const r of rows) {
		if (r.status !== "queued") continue;
		if (signal?.aborted) break;
		r.status = "running";
		emit();
		const t = r.candidate.target;
		const res = await relRot(
			img(anchor, anchor.pose.vfov),
			img(t, t.meta.vfov),
			signal,
		);
		if (typeof res === "string") {
			r.status = "error";
			r.reasons = [res];
		} else {
			r.result = res;
			settle(anchor, anchorKind, r);
		}
		emit();
	}

	// pass 2: triplet cycle for each gated row, against the strongest other trusted estimate from this anchor
	const trusted = rows.filter(
		(r) => r.result?.relR && r.result.inliers >= PROPAGATE_GATE.minInliers,
	);
	for (const r of rows) {
		if (signal?.aborted) break;
		if (r.status !== "suggested" || !r.result?.relR) continue;
		const c = trusted
			.filter((x) => x !== r)
			.sort((a, b) => (b.result?.inliers ?? 0) - (a.result?.inliers ?? 0))[0];
		if (!c?.result?.relR) continue;
		const B = r.candidate.target;
		const C = c.candidate.target;
		const bc = await relRot(img(B, B.meta.vfov), img(C, C.meta.vfov), signal);
		if (typeof bc === "string" || !bc.relR) continue;
		const cyc = cycleDeg(
			r.result.relR as Mat3,
			bc.relR as Mat3,
			c.result.relR as Mat3,
		);
		r.cycleWith = C.meta.id;
		settle(anchor, anchorKind, r, cyc);
		emit();
	}
	run.done = true;
	emit();
	return run;
}

function settle(
	anchor: RollPhoto,
	kind: AnchorKind,
	r: PropagateRow,
	cycle?: number,
) {
	if (!r.result) return;
	const p = propose(anchor, r.candidate, r.result, cycle);
	r.proposal = p;
	if (!p.suggestion) {
		r.status = "error";
		r.reasons = [p.error ?? "no suggestion"];
		return;
	}
	const s = p.suggestion;
	r.deltaToCurrentDeg = poseDeltaDeg(s.pose, r.candidate.target.pose);
	if (!s.gated) {
		r.status = "rejected";
		r.reasons = s.reasons;
		r.suggestion = undefined;
		return;
	}
	r.status = "suggested";
	r.reasons = [];
	const t = r.candidate.target;
	const stored: StoredSuggestion = {
		provenance: PROVENANCE,
		targetId: t.meta.id,
		anchorId: anchor.meta.id,
		anchorKind: kind,
		pose: s.pose,
		seedRadiusDeg: s.seedRadiusDeg,
		evidence: {
			inliers: r.result.inliers,
			rmsPx: r.result.rmsPx,
			overlap: s.overlap,
			fwdBwdDeg: r.result.fwdBwdDeg,
			cycleDeg: cycle ?? null,
			baselineM: r.candidate.baselineM,
			dtS: r.candidate.dtS,
		},
		cautions: p.cautions,
		status: "pending",
		at: new Date().toISOString(),
	};
	r.suggestion = stored;
}

/** Persist the gated rows of a finished run (pending suggestions the targets will show). */
export function persistRun(run: PropagateRun) {
	for (const r of run.rows)
		if (r.status === "suggested" && r.suggestion) putSuggestion(r.suggestion);
		// the estimator ran and the gate (or cycle) now says no: an older pending card must not linger
		else if (r.status === "rejected")
			dropPending(run.anchorId, r.candidate.target.meta.id);
}
