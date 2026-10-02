// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Gipfelbuch adapter (src/lib/gipfelbuch/ontology.ts) against the ontology tables it reads.
// Cross-module specs live in src/test/cross/: the module-boundary lints (here gipfelbuch.check.ts:
// gipfelbuch and ontology import each other only through that adapter) do not apply to them.

import { describe, expect, it } from "vitest";
import { byId, NODES } from "#/lib/gipfelbuch/graph-utils";
import {
	AGENT_LIST,
	CONCEPT_IDS,
	conceptView,
	findingsByKind,
	hasNode,
	isConceptId,
	isMethodId,
	methodModules,
	methodView,
	NODE_OF_CONCEPT,
	NODES_OF_METHOD,
	ONTOLOGY_STATS,
	provenanceMatrix,
	searchWords,
	storageByMedium,
} from "#/lib/gipfelbuch/ontology";
import { CONCEPTS } from "#/lib/ontology/catalogue/concepts";
import { METHODS } from "#/lib/ontology/core/provenance";
import { STORAGE } from "#/lib/ontology/core/storage";

describe("gipfelbuch nodes vs the ontology catalogue", () => {
	it("ontologyId and methodIds point at real catalogue entries", () => {
		for (const n of NODES) {
			if (n.ontologyId) expect(CONCEPTS, n.id).toHaveProperty(n.ontologyId);
			for (const m of n.methodIds ?? [])
				expect(METHODS, `${n.id}: ${m}`).toHaveProperty(m);
		}
	});
});

describe("ontology adapter", () => {
	it("type guards use own properties only", () => {
		expect(isConceptId("photo")).toBe(true);
		expect(isConceptId("toString")).toBe(false);
		expect(isConceptId("__proto__")).toBe(false);
		expect(isMethodId("cascade")).toBe(true);
		expect(isMethodId("hasOwnProperty")).toBe(false);
		expect(hasNode(NODES[0].id)).toBe(true);
		expect(hasNode("nope")).toBe(false);
	});
	it("stats equal the underlying tables", () => {
		expect(ONTOLOGY_STATS.concepts).toBe(CONCEPT_IDS.length);
		expect(ONTOLOGY_STATS.methods).toBe(Object.keys(METHODS).length);
		expect(ONTOLOGY_STATS.storage).toBe(Object.keys(STORAGE).length);
		expect(ONTOLOGY_STATS.resolutionPolicies).toBe(
			ONTOLOGY_STATS.resolutionPolicyNames.length,
		);
		expect(ONTOLOGY_STATS.linkedConcepts).toBe(NODE_OF_CONCEPT.size);
		expect(ONTOLOGY_STATS.linkedMethods).toBe(NODES_OF_METHOD.size);
	});
	it("conceptView is cached and its tree is consistent both ways", () => {
		for (const id of CONCEPT_IDS) {
			const v = conceptView(id);
			expect(conceptView(id)).toBe(v);
			expect(v.label).toBeTruthy();
			expect(v.realizations.filter((r) => r.canonical)).toHaveLength(1);
			expect(v.realizations[0].canonical).toBe(true);
			for (const r of v.realizations) {
				expect(r.file.startsWith("src/")).toBe(true);
				expect(r.exportName).toBeTruthy();
			}
			for (const c of v.children)
				expect(conceptView(c.concept as never).parent?.concept).toBe(id);
			for (const p of v.partOf)
				expect(
					conceptView(p.concept as never).parts.some(
						(q) => q.concept === id && q.role === p.role,
					),
				).toBe(true);
			for (const s of v.storage) expect(STORAGE).toHaveProperty(s.id);
		}
	});
	it("methodModules splits lists, takes the first word and adds src/ except under data/ and tools/", () => {
		expect(methodModules("lib/align.ts")).toEqual(["src/lib/align.ts"]);
		expect(
			methodModules("lib/a.ts, tools/bench (harness), data/x.json"),
		).toEqual(["src/lib/a.ts", "tools/bench", "data/x.json"]);
	});
	it("methodView resolves agent and evidence blurbs", () => {
		const v = methodView("cascade");
		expect(v.agent).toBe(METHODS.cascade.agent);
		expect(v.agentBlurb.length).toBeGreaterThan(5);
		expect(v.evidence.map((e) => e.id)).toEqual([...METHODS.cascade.evidence]);
		expect(v.modules.every((m) => /^(src|tools|data)\//.test(m))).toBe(true);
	});
	it("provenanceMatrix lists every method once with its nodes", () => {
		const m = provenanceMatrix();
		expect(m.methods).toHaveLength(Object.keys(METHODS).length);
		expect(m.agents).toBe(AGENT_LIST);
		for (const row of m.methods)
			for (const id of row.nodeIds)
				expect(byId.get(id)?.methodIds).toContain(row.id);
	});
	it("storageByMedium and findingsByKind partition their tables", () => {
		expect(storageByMedium().reduce((n, g) => n + g.entries.length, 0)).toBe(
			Object.keys(STORAGE).length,
		);
		expect(new Set(storageByMedium().map((g) => g.medium)).size).toBe(
			storageByMedium().length,
		);
		expect(findingsByKind().reduce((n, g) => n + g.findings.length, 0)).toBe(
			ONTOLOGY_STATS.findings,
		);
	});
	it("searchWords are lower-case, trimmed, unique and carry the concept label", () => {
		for (const n of NODES) {
			const w = searchWords(n);
			expect(new Set(w).size).toBe(w.length);
			for (const x of w) {
				expect(x).toBe(x.trim().toLowerCase());
				expect(x).not.toBe("");
			}
			if (n.ontologyId)
				expect(w).toContain(conceptView(n.ontologyId).label.toLowerCase());
		}
		expect(
			searchWords({ ...NODES[0], ontologyId: undefined, methodIds: undefined }),
		).toEqual([]);
	});
	it("concept chips that link to a sheet carry that sheet's title", () => {
		for (const n of NODES) {
			if (!n.ontologyId) continue;
			const v = conceptView(n.ontologyId);
			for (const r of [v.parent, ...v.children, ...v.parts, ...v.partOf]) {
				const node = r?.nodeId && NODES.find((x) => x.id === r.nodeId);
				if (node) expect(r.label).toBe(node.title);
			}
		}
	});
});
