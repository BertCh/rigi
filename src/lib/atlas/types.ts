import type { ConceptId } from "#/lib/ontology/catalogue/concepts";
import type { MethodId } from "#/lib/ontology/core/provenance";

export type AtlasGroup =
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
export type AtlasKind =
	| "concept"
	| "subsystem"
	| "algorithm"
	| "data"
	| "experiment"
	| "ui"
	| "infra";
export type AtlasStatus = "live" | "flagged" | "research" | "killed";
export interface AtlasEdge {
	id: string;
	rel: string;
	origin?: "curated" | "ontology";
} // rel: short verb phrase e.g. "feeds", "renders", "is-a", "replaced-by", "uses"
export interface AtlasNode {
	id: string; // kebab-case slug, unique, used in URL /atlas/<id>
	title: string;
	group: AtlasGroup;
	kind: AtlasKind;
	status: AtlasStatus;
	tagline: string; // <= 90 chars, evocative
	summary: string; // 2-4 sentences, accurate to the code
	lede?: string; // <= 30 words, plain language, no identifiers; shown as the page lead (summary moves to the rail)
	modules: string[]; // repo paths e.g. "src/lib/geo/solve.ts"
	reports: string[]; // repo paths e.g. "reports/concordance-research.md"
	related: AtlasEdge[]; // outgoing edges to other node ids
	visual: string; // 1-2 sentence idea for a BESPOKE custom visual for this concept's page
	ontologyId?: ConceptId; // key in CONCEPTS (src/lib/ontology/catalogue/concepts.ts) when this node IS that concept
	methodIds?: readonly MethodId[]; // keys in METHODS (core/provenance.ts) this node implements
}
