// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ConceptId } from "#/lib/ontology/catalogue/concepts";
import type { MethodId } from "#/lib/ontology/core/provenance";

export type GipfelbuchGroup =
	| "capture"
	| "world"
	| "camera"
	| "evidence"
	| "solve"
	| "render"
	| "gpu"
	| "nearfield"
	| "roll"
	| "product"
	| "research"
	| "infra"
	| "math";
export type GipfelbuchKind =
	| "concept"
	| "subsystem"
	| "algorithm"
	| "data"
	| "experiment"
	| "ui"
	| "infra";
export type GipfelbuchStatus = "live" | "flagged" | "research" | "killed";
export interface GipfelbuchEdge {
	id: string;
	rel: string;
	origin?: "curated" | "ontology";
} // rel: short verb phrase e.g. "feeds", "renders", "is-a", "replaced-by", "uses"
export interface GipfelbuchNode {
	id: string; // kebab-case slug, unique, used in URL /gipfelbuch/<id>
	title: string; // display spelling, the sheet's H1 ("Terrain Sampler", not the code name)
	claim?: string; // the dek under the H1: one sentence, <= ~60 chars, a claim, no digits (required by gipfelbuch.check.ts)
	group: GipfelbuchGroup;
	kind: GipfelbuchKind;
	status: GipfelbuchStatus;
	tagline: string; // <= 90 chars, evocative
	summary: string; // 2-4 sentences, accurate to the code
	lede?: string; // <= 30 words, plain language, no identifiers; shown as the page lead (summary moves to the rail)
	modules: string[]; // repo paths e.g. "src/lib/geo/solve.ts"
	reports: string[]; // repo paths e.g. "reports/concordance-research.md"
	related: GipfelbuchEdge[]; // outgoing edges to other node ids
	visual: string; // 1-2 sentence idea for a BESPOKE custom visual for this concept's page
	ontologyId?: ConceptId; // key in CONCEPTS (src/lib/ontology/catalogue/concepts.ts) when this node IS that concept
	methodIds?: readonly MethodId[]; // keys in METHODS (core/provenance.ts) this node implements
}
