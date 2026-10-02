// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Wires existing outputs to the H2 inputs without computing anything new:
 *  - out/geocam/decoys/<pid>.json (geocam-decoys/1, FUND E1 hypotheses) -> h2-decoys/1: the primary
 *    (non-secondary) NE-dec hypotheses, i.e. the 56 displaced-eye decoys at >= 150 m.
 *  - out/geocam/ga5/hyps.json (scripts/geocam/ga5-eval.ts) -> h2-feature/1 "ga5_integrity": 1 = integrity pass,
 *    0 = fail, null = not available.
 */
import {
	DECOYS_SCHEMA,
	type DecoysInput,
	FEATURE_SCHEMA,
	type FeatureFile,
} from "./lib";

export interface GeocamDecoyDoc {
	format: string;
	pid: string;
	hyps: { id: string; label: string; secondary: boolean }[];
}
export interface Ga5Hyp {
	id: string;
	available?: boolean;
	integrityPass?: boolean;
}

export function adaptDecoys(docs: readonly GeocamDecoyDoc[]): DecoysInput {
	const items: DecoysInput["items"] = [];
	for (const d of docs) {
		if (d.format !== "geocam-decoys/1")
			throw new Error(`unexpected decoy format ${d.format} for ${d.pid}`);
		for (const h of d.hyps)
			if (h.label === "NE-dec" && !h.secondary)
				items.push({ id: h.id, pid: d.pid });
	}
	items.sort((a, b) => a.id.localeCompare(b.id));
	return {
		schema: DECOYS_SCHEMA,
		source: "tools/research/fund/e1_acontrario via out/geocam/decoys",
		items,
	};
}

export function adaptGa5(hyps: readonly Ga5Hyp[]): FeatureFile {
	const values: FeatureFile["values"] = {};
	for (const h of hyps)
		values[h.id] =
			h.available === false || h.integrityPass === undefined
				? null
				: h.integrityPass
					? 1
					: 0;
	return {
		schema: FEATURE_SCHEMA,
		feature: "ga5_integrity",
		version: "ga5-eval protection level + viewshed",
		direction: "higher-is-better",
		values,
	};
}
