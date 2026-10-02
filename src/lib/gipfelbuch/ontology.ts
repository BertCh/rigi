// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Gipfelbuch <-> ontology adapter.
 *
 * IMPORT-BOUNDARY RULE: this is the ONLY module under src/lib/gipfelbuch, src/components/gipfelbuch or
 * src/routes/gipfelbuch* that may import src/lib/ontology/**, and only from specific modules
 * (catalogue/*, core/*), never the barrel index.ts and never crosswalk/*. Everything else in the gipfelbuch
 * consumes the plain serialisable views exported here. It imports ./graph (not ./graph-utils) so
 * graph-utils can import it without a cycle. Types in ./types may import ontology types (type-only).
 */
import {
	type Cardinality,
	CONCEPTS,
	type ConceptDef,
	type ConceptId,
	DOMAINS,
	type Domain,
} from "#/lib/ontology/catalogue/concepts";
import { FINDINGS } from "#/lib/ontology/catalogue/findings";
import { CONFIDENCE_SCALES } from "#/lib/ontology/core/confidence";
import { ID_SCHEMES } from "#/lib/ontology/core/ids";
import {
	AGENTS,
	type Agent,
	EVIDENCE,
	type EvidenceFamily,
	METHODS,
	type MethodId,
	ROLES,
	STATUSES,
} from "#/lib/ontology/core/provenance";
import { RESOLUTION_POLICIES } from "#/lib/ontology/core/resolution";
import {
	STORAGE,
	type StorageMedium,
	storageKey,
} from "#/lib/ontology/core/storage";
import { GIPFELBUCH_NODES } from "./graph";
import type { GipfelbuchNode } from "./types";

export type {
	Cardinality,
	ConceptId,
	Domain,
	EvidenceFamily,
	MethodId,
	StorageMedium,
};

// ---- id guards and node lookups -----------------------------------------------------------------

const CONCEPT_MAP = CONCEPTS as unknown as Record<string, ConceptDef>;
const METHOD_MAP = METHODS as unknown as Record<
	string,
	(typeof METHODS)[MethodId]
>;

/** Every concept id in catalogue order (for coverage checks). */
/** Registered storage keys, for Gipfelbuch components (the only door into src/lib/ontology). */
export { storageKey };

export const CONCEPT_IDS = Object.keys(CONCEPT_MAP) as ConceptId[];

export const isConceptId = (s: string): s is ConceptId =>
	Object.hasOwn(CONCEPTS, s);
export const isMethodId = (s: string): s is MethodId =>
	Object.hasOwn(METHODS, s);

/** Primary gipfelbuch node of each concept (first node declaring that ontologyId). */
export const NODE_OF_CONCEPT: Map<ConceptId, string> = new Map();
/** Gipfelbuch nodes implementing each method. */
export const NODES_OF_METHOD: Map<MethodId, string[]> = new Map();
for (const n of GIPFELBUCH_NODES) {
	if (n.ontologyId && !NODE_OF_CONCEPT.has(n.ontologyId))
		NODE_OF_CONCEPT.set(n.ontologyId, n.id);
	for (const m of n.methodIds ?? []) {
		const a = NODES_OF_METHOD.get(m);
		if (a) a.push(n.id);
		else NODES_OF_METHOD.set(m, [n.id]);
	}
}
const NODE_IDS = new Set(GIPFELBUCH_NODES.map((n) => n.id));

// ---- concept view -------------------------------------------------------------------------------

export interface ConceptRef {
	concept: string;
	label: string;
	nodeId?: string;
}
export interface PartView extends ConceptRef {
	role: string;
	card: Cardinality;
}
export interface RealizationView {
	key: string;
	/** repo path, e.g. src/lib/photos.ts */
	file: string;
	exportName: string;
	canonical: boolean;
}
export interface IdView {
	kind: string;
	example: string;
	stable: boolean;
	mintedBy: string;
	note?: string;
}
export interface StorageView {
	id: string;
	medium: StorageMedium;
	key: string;
	version: number | null;
	holds: string;
	module: string;
	note?: string;
}
export interface ConceptView {
	id: ConceptId;
	label: string;
	domain: Domain;
	domainBlurb: string;
	definition: string;
	ui: string[];
	code: string[];
	avoid: string[];
	frame?: string;
	note?: string;
	parent?: ConceptRef;
	children: ConceptRef[];
	parts: PartView[];
	partOf: PartView[];
	realizations: RealizationView[];
	ids: IdView[];
	storage: StorageView[];
}

/** A chip that links to a sheet reads as that sheet's title: one name per thing. */
const refOf = (concept: string): ConceptRef => {
	const nodeId = isConceptId(concept)
		? NODE_OF_CONCEPT.get(concept)
		: undefined;
	const title = nodeId
		? GIPFELBUCH_NODES.find((n) => n.id === nodeId)?.title
		: undefined;
	return {
		concept,
		label: title ?? CONCEPT_MAP[concept]?.label ?? concept,
		nodeId,
	};
};

const storageView = (id: string): StorageView => {
	const e = (STORAGE as Record<string, (typeof STORAGE)[keyof typeof STORAGE]>)[
		id
	];
	return {
		id,
		medium: e.medium,
		key: e.key,
		version: e.version,
		holds: e.holds,
		module: e.module,
		...("note" in e && e.note ? { note: e.note as string } : {}),
	};
};

const conceptCache = new Map<ConceptId, ConceptView>();

export function conceptView(id: ConceptId): ConceptView {
	const hit = conceptCache.get(id);
	if (hit) return hit;
	const c = CONCEPT_MAP[id];
	const parts: PartView[] = Object.entries(c.has ?? {}).map(([role, p]) => ({
		role,
		card: p.card,
		...refOf(p.concept),
	}));
	const partOf: PartView[] = [];
	const children: ConceptRef[] = [];
	for (const [oid, o] of Object.entries(CONCEPT_MAP)) {
		if (o.is === id) children.push(refOf(oid));
		for (const [role, p] of Object.entries(o.has ?? {}))
			if (p.concept === id) partOf.push({ role, card: p.card, ...refOf(oid) });
	}
	const view: ConceptView = {
		id,
		label: c.label,
		domain: c.domain,
		domainBlurb: DOMAINS[c.domain],
		definition: c.definition,
		ui: [...(c.ui ?? [])],
		code: [...(c.code ?? [])],
		avoid: [...(c.avoid ?? [])],
		frame: c.frame,
		note: c.note,
		parent: c.is ? refOf(c.is) : undefined,
		children,
		parts,
		partOf,
		realizations: c.realizedBy.map((key, i) => {
			const [path, exportName] = key.split("#");
			return { key, file: `src/${path}`, exportName, canonical: i === 0 };
		}),
		ids: ID_SCHEMES.filter((s) => s.concept === c.ids).map((s) => ({
			kind: s.kind,
			example: s.example,
			stable: s.stable,
			mintedBy: s.mintedBy,
			...("note" in s && s.note ? { note: s.note as string } : {}),
		})),
		storage: (c.storage ?? []).map(storageView),
	};
	conceptCache.set(id, view);
	return view;
}

// ---- method view --------------------------------------------------------------------------------

export interface MethodView {
	id: MethodId;
	label: string;
	agent: Agent;
	agentBlurb: string;
	evidence: { id: EvidenceFamily; blurb: string }[];
	estimates: string[];
	/** repo-relative paths (src/ prefixed unless under tools/ or data/) */
	modules: string[];
}

/** Module paths of a METHODS entry, parsed like ontology.check.ts (split ",", first word, src/ prefix). */
export function methodModules(module: string): string[] {
	return module.split(",").map((part) => {
		const p = part.trim().split(" ")[0];
		return p.startsWith("data/") || p.startsWith("tools/") ? p : `src/${p}`;
	});
}

export function methodView(id: MethodId): MethodView {
	const m = METHOD_MAP[id];
	return {
		id,
		label: m.label,
		agent: m.agent,
		agentBlurb: AGENTS[m.agent],
		evidence: m.evidence.map((e) => ({ id: e, blurb: EVIDENCE[e] })),
		estimates: [...m.estimates],
		modules: methodModules(m.module),
	};
}

// ---- derived links ------------------------------------------------------------------------------

export interface OntologyLink {
	from: string;
	to: string;
	rel: "is-a" | "part-of";
	role?: string;
	card?: Cardinality;
}

/** is-a (child -> parent) and part-of (part -> whole) between primary nodes of linked concepts. */
export const ONTOLOGY_LINKS: OntologyLink[] = [];
for (const [cid, node] of NODE_OF_CONCEPT) {
	const c = CONCEPT_MAP[cid];
	if (c.is && isConceptId(c.is)) {
		const to = NODE_OF_CONCEPT.get(c.is);
		if (to && to !== node) ONTOLOGY_LINKS.push({ from: node, to, rel: "is-a" });
	}
	for (const [role, p] of Object.entries(c.has ?? {})) {
		if (!isConceptId(p.concept)) continue;
		const part = NODE_OF_CONCEPT.get(p.concept);
		if (part && part !== node)
			ONTOLOGY_LINKS.push({
				from: part,
				to: node,
				rel: "part-of",
				role,
				card: p.card,
			});
	}
}

// ---- findings -----------------------------------------------------------------------------------

export interface FindingView {
	kind: (typeof FINDINGS)[number]["kind"];
	summary: string;
	where: string[];
	action: string;
}
const findingView = (f: (typeof FINDINGS)[number]): FindingView => ({
	kind: f.kind,
	summary: f.summary,
	where: [...f.where],
	action: f.action,
});
// ---- search words -------------------------------------------------------------------------------

/** Lower-cased words a graph search should match for this node, drawn from the ontology. */
export function searchWords(node: GipfelbuchNode): string[] {
	const out = new Set<string>();
	const add = (s: string) => {
		const t = s.trim().toLowerCase();
		if (t) out.add(t);
	};
	if (node.ontologyId) {
		const c = CONCEPT_MAP[node.ontologyId];
		add(c.label);
		for (const w of [...(c.ui ?? []), ...(c.code ?? [])]) add(w);
		for (const k of c.realizedBy) add(k.split("#")[1] ?? "");
	}
	for (const m of node.methodIds ?? []) add(METHOD_MAP[m].label);
	return [...out];
}

// ---- stats and WP5 getters ----------------------------------------------------------------------

export interface OntologyStats {
	concepts: number;
	domains: number;
	methods: number;
	storage: number;
	findings: number;
	idSchemes: number;
	resolutionPolicies: number;
	resolutionPolicyNames: string[];
	confidenceScales: number;
	linkedConcepts: number;
	linkedMethods: number;
}

export const ONTOLOGY_STATS: OntologyStats = {
	concepts: Object.keys(CONCEPTS).length,
	domains: Object.keys(DOMAINS).length,
	methods: Object.keys(METHODS).length,
	storage: Object.keys(STORAGE).length,
	findings: FINDINGS.length,
	idSchemes: ID_SCHEMES.length,
	resolutionPolicies: Object.keys(RESOLUTION_POLICIES).length,
	resolutionPolicyNames: Object.keys(RESOLUTION_POLICIES),
	confidenceScales: Object.keys(CONFIDENCE_SCALES).length,
	linkedConcepts: NODE_OF_CONCEPT.size,
	linkedMethods: NODES_OF_METHOD.size,
};

export interface LegendRow {
	id: string;
	blurb: string;
}
const rows = (o: Record<string, string>): LegendRow[] =>
	Object.entries(o).map(([id, blurb]) => ({ id, blurb }));

export const AGENT_LIST: LegendRow[] = rows(AGENTS);
export const EVIDENCE_LIST: LegendRow[] = rows(EVIDENCE);
export const ROLE_LIST: LegendRow[] = rows(ROLES);
export const STATUS_LIST: LegendRow[] = rows(STATUSES);

/** Every method as a view (METHODS order). */
export const methodViews = (): MethodView[] =>
	(Object.keys(METHODS) as MethodId[]).map(methodView);

export interface ProvenanceMatrix {
	agents: LegendRow[];
	evidence: LegendRow[];
	methods: (MethodView & { nodeIds: string[] })[];
	roles: LegendRow[];
	statuses: LegendRow[];
}
/** METHODS x EVIDENCE with agent, plus the ROLES / STATUSES legends. */
export function provenanceMatrix(): ProvenanceMatrix {
	return {
		agents: AGENT_LIST,
		evidence: EVIDENCE_LIST,
		methods: methodViews().map((m) => ({
			...m,
			nodeIds: NODES_OF_METHOD.get(m.id) ?? [],
		})),
		roles: ROLE_LIST,
		statuses: STATUS_LIST,
	};
}

export interface StorageGroup {
	medium: StorageMedium;
	entries: StorageView[];
}
/** STORAGE grouped by medium (first-seen order). */
export function storageByMedium(): StorageGroup[] {
	const g = new Map<StorageMedium, StorageView[]>();
	for (const id of Object.keys(STORAGE)) {
		const v = storageView(id);
		const a = g.get(v.medium);
		if (a) a.push(v);
		else g.set(v.medium, [v]);
	}
	return [...g].map(([medium, entries]) => ({ medium, entries }));
}

export interface FindingGroup {
	kind: FindingView["kind"];
	findings: FindingView[];
}
/** FINDINGS grouped by kind (first-seen order). */
export function findingsByKind(): FindingGroup[] {
	const g = new Map<FindingView["kind"], FindingView[]>();
	for (const f of FINDINGS) {
		const a = g.get(f.kind);
		if (a) a.push(findingView(f));
		else g.set(f.kind, [findingView(f)]);
	}
	return [...g].map(([kind, findings]) => ({ kind, findings }));
}

export interface ResolutionPolicyView {
	id: string;
	label: string;
	purpose: string;
	rules: string[];
	implementedBy: string;
}
export const resolutionPolicies = (): ResolutionPolicyView[] =>
	Object.entries(RESOLUTION_POLICIES).map(([id, p]) => ({
		id,
		label: p.label,
		purpose: p.purpose,
		rules: p.rules.map((r) => r.label),
		implementedBy: p.implementedBy,
	}));

export interface ConfidenceScaleView {
	id: string;
	label: string;
	calibrated: boolean;
	high: number | null;
	medium: number;
	accept: string;
	module: string;
	levelOnly: boolean;
}
export const confidenceScales = (): ConfidenceScaleView[] =>
	Object.entries(CONFIDENCE_SCALES).map(([id, s]) => ({
		id,
		label: s.label,
		calibrated: s.calibrated,
		high: s.high,
		medium: s.medium,
		accept: s.accept,
		module: s.module,
		levelOnly: !!("levelOnly" in s && s.levelOnly),
	}));

export const idSchemeViews = (): (IdView & { concept: string })[] =>
	ID_SCHEMES.map((s) => ({
		concept: s.concept,
		kind: s.kind,
		example: s.example,
		stable: s.stable,
		mintedBy: s.mintedBy,
		...("note" in s && s.note ? { note: s.note as string } : {}),
	}));

/** True when a node id exists (helper for views that carry optional nodeIds). */
export const hasNode = (id: string) => NODE_IDS.has(id);
