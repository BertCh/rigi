// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { CONCEPTS, type ConceptDef, DOMAINS } from "../catalogue/concepts";
import { FINDINGS } from "../catalogue/findings";
import { AGENTS, METHODS, OUTCOMES, ROLES, STATUSES } from "../core/provenance";
import * as world from "../crosswalk/world";
import { renderOntologyDoc } from "../doc";
import { renderDomain, renderRealizations } from "../generate";

const concepts = Object.entries(CONCEPTS) as [string, ConceptDef][];
const pascal = (id: string) =>
	id
		.split("-")
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join("");

describe("concept catalogue integrity", () => {
	it("every concept sits in a declared domain and has a label, definition and realization", () => {
		for (const [id, c] of concepts) {
			expect(Object.keys(DOMAINS), id).toContain(c.domain);
			expect(c.label.trim(), id).not.toBe("");
			expect(c.definition.trim(), id).not.toBe("");
			expect(c.realizedBy.length, id).toBeGreaterThan(0);
		}
	});

	it("realization keys are '<path>#<Export>' with a src-relative ts path", () => {
		for (const [id, c] of concepts)
			for (const k of c.realizedBy)
				expect(k, `${id}: ${k}`).toMatch(/^[\w./-]+\.tsx?#\w+$/);
	});

	it("is-a parents and has-a parts name existing concepts, and the taxonomy has no cycles", () => {
		for (const [id, c] of concepts) {
			if (c.is) expect(CONCEPTS, `${id} is ${c.is}`).toHaveProperty(c.is);
			for (const [role, p] of Object.entries(c.has ?? {}))
				expect(CONCEPTS, `${id}.${role}`).toHaveProperty(p.concept);
			const seen = new Set<string>([id]);
			let cur = c.is;
			while (cur) {
				expect(seen.has(cur), `cycle through ${cur}`).toBe(false);
				seen.add(cur);
				cur = (CONCEPTS as Record<string, ConceptDef>)[cur]?.is;
			}
		}
	});

	it("part cardinalities are one of the four forms", () => {
		for (const [, c] of concepts)
			for (const p of Object.values(c.has ?? {}))
				expect(["1", "0..1", "*", "1..*"]).toContain(p.card);
	});

	it("findings carry a kind, summary, locations and an action", () => {
		expect(FINDINGS.length).toBeGreaterThan(0);
		for (const f of FINDINGS) {
			expect(["drift", "homonym", "synonym", "units", "deferred"]).toContain(
				f.kind,
			);
			expect(f.summary.length).toBeGreaterThan(10);
			expect(f.where.length).toBeGreaterThan(0);
			expect(f.action.length).toBeGreaterThan(0);
		}
	});
});

describe("crosswalk/world provenance classes", () => {
	const flat = (o: unknown, path = ""): [string, Record<string, unknown>][] => {
		if (!o || typeof o !== "object") return [];
		const rec = o as Record<string, unknown>;
		const isClass = Object.values(rec).every(
			(v) => typeof v !== "object" || v === null,
		);
		return isClass && Object.keys(rec).length
			? [[path, rec]]
			: Object.entries(rec).flatMap(([k, v]) => flat(v, `${path}.${k}`));
	};
	const classes = Object.entries(world).flatMap(([name, v]) => flat(v, name));

	it("collects a non-trivial number of classes", () => {
		expect(classes.length).toBeGreaterThan(20);
	});

	it("every class uses only words from the canonical axes", () => {
		for (const [path, c] of classes) {
			if (c.agent !== undefined)
				expect(AGENTS, path).toHaveProperty(c.agent as string);
			if (c.method !== undefined)
				expect(METHODS, path).toHaveProperty(c.method as string);
			if (c.role !== undefined)
				expect(ROLES, path).toHaveProperty(c.role as string);
			if (c.status !== undefined)
				expect(STATUSES, path).toHaveProperty(c.status as string);
			if (c.outcome !== undefined)
				expect(OUTCOMES, path).toHaveProperty(c.outcome as string);
			if (c.level !== undefined)
				expect(["high", "medium", "low", "unknown"], path).toContain(c.level);
		}
	});

	it("a person's map pin is endorsed, a GPS fix is a sensor prior", () => {
		expect(world.USER_MAP_PIN).toMatchObject({
			agent: "user",
			status: "endorsed",
		});
		expect(world.GPS_FIX).toMatchObject({ agent: "sensor", role: "prior" });
		expect(world.UPLOAD_POSITION_SOURCE.exif).toBe(world.GPS_FIX);
	});
});

describe("renderOntologyDoc", () => {
	const doc = renderOntologyDoc();

	it("is deterministic and starts with the generated-file header", () => {
		expect(renderOntologyDoc()).toBe(doc);
		expect(doc.startsWith("# Rigi ontology\n")).toBe(true);
		expect(doc).toContain("GENERATED");
	});

	it("has every numbered section the contents list promises", () => {
		for (const h of [
			"## Concepts",
			"## Concept graph",
			"## Realizations",
			"## Provenance axes",
			"## Methods",
			"## Crosswalks",
			"## Confidence scales",
			"## Resolution policies",
			"## Units and frames",
			"## Identifiers",
			"## Storage",
			"## Findings",
		])
			expect(doc, h).toContain(`\n${h}\n`);
	});

	it("lists every concept, method and finding", () => {
		for (const [id, c] of concepts) {
			expect(doc, id).toContain(`**${c.label}** \`${id}\``);
		}
		for (const id of Object.keys(METHODS))
			expect(doc, id).toContain(`\`${id}\``);
		for (const f of FINDINGS)
			expect(doc).toContain(
				f.summary.slice(0, 40).replace(/\|/g, "\\|").replace(/\n/g, " "),
			);
	});

	it("draws is-a edges in the mermaid graph with hyphens replaced", () => {
		const m = doc.slice(
			doc.indexOf("```mermaid"),
			doc.indexOf("```", doc.indexOf("```mermaid") + 10),
		);
		expect(m).not.toMatch(/-->\|[^|]*\| [^\s]*-[^\s]*\n/);
		const withParent = concepts.find(([, c]) => c.is);
		if (withParent) {
			const [id, c] = withParent;
			expect(m).toContain(
				`${id.replace(/-/g, "_")} -->|is| ${(c.is as string).replace(/-/g, "_")}`,
			);
		}
	});

	it("keeps every markdown table row the width of its header", () => {
		const lines = doc.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!/^\|---/.test(lines[i])) continue;
			const cols = (s: string) => s.replace(/\\\|/g, "").split("|").length;
			const width = cols(lines[i - 1]);
			for (let j = i; j < lines.length && lines[j].startsWith("|"); j++)
				expect(cols(lines[j]), lines[j].slice(0, 60)).toBe(width);
		}
	});
});

describe("renderRealizations", () => {
	const out = renderRealizations();

	it("lists each distinct realization key once, sorted, as a type import", () => {
		const keys = [
			...new Set(concepts.flatMap(([, c]) => [...c.realizedBy])),
		].sort();
		const found = [
			...out.matchAll(/^\t"([^"]+)": import\("([^"]+)"\)\.(\w+);$/gm),
		];
		expect(found.map((m) => m[1])).toEqual(keys);
		for (const [, key, mod, name] of found) {
			const [path, exp] = key.split("#");
			expect(mod).toBe(`#/${path.replace(/\.tsx?$/, "")}`);
			expect(name).toBe(exp);
		}
	});

	it("carries the SPDX header and the equality assertion", () => {
		expect(out.split("\n").slice(0, 3)).toEqual([
			"// Rigi",
			"// SPDX-License-Identifier: MIT",
			"// SPDX-FileCopyrightText: Copyright (c) Rigi contributors",
		]);
		expect(out).toContain("Assert<");
	});
});

describe("renderDomain", () => {
	const out = renderDomain();

	it("declares one exported type per concept with a non-research realization", () => {
		for (const [id, c] of concepts) {
			const canonical = c.realizedBy.find((k) => !/^lib\/geocam\//.test(k));
			const re = new RegExp(`^export type ${pascal(id)} = import\\(`, "m");
			if (canonical) expect(out, id).toMatch(re);
			else expect(out, id).not.toMatch(re);
		}
	});

	it("binds the canonical realization, links is-a parents and names omitted concepts", () => {
		const [id, c] = concepts.find(([, x]) => x.is) as [string, ConceptDef];
		const canonical = (
			c.realizedBy.find((k) => !/^lib\/geocam\//.test(k)) as string
		).split("#");
		expect(out).toContain(
			`export type ${pascal(id)} = import("#/${canonical[0].replace(/\.tsx?$/, "")}").${canonical[1]};`,
		);
		expect(out).toContain(`Is a {@link ${pascal(c.is as string)}}.`);
		expect(out).toContain("Canonical: `");
	});

	it("has a section per domain and wraps doc comments within 100 columns", () => {
		for (const [d, blurb] of Object.entries(DOMAINS))
			expect(out).toContain(`// ---- ${d}: ${blurb} `);
		for (const line of out.split("\n").filter((l) => l.startsWith(" * ")))
			expect(line.length).toBeLessThanOrEqual(110);
	});

	it("is deterministic", () => {
		expect(renderDomain()).toBe(out);
	});
});
