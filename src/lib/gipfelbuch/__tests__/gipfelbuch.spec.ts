// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { GIPFELBUCH_NODES } from "../graph";
import {
	backlinks,
	byId,
	degree,
	GROUP_BY_ID,
	GROUPS,
	gipfelbuchHref,
	groupByRel,
	groupColor,
	incoming,
	KIND_LABEL,
	LINKS,
	NODES,
	neighbourhood,
	nodesInGroup,
	outgoing,
	STATUS_META,
	siblings,
} from "../graph-utils";
import { NODE_OF_CONCEPT, ONTOLOGY_LINKS } from "../ontology";
import type { GipfelbuchEdge } from "../types";

const luminance = (hex: string) => {
	const c = [1, 3, 5].map((i) => {
		const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
const PAPER = "#eeedeb";

describe("node data", () => {
	it("every group, kind and status in use has display metadata", () => {
		for (const n of NODES) {
			expect(GROUP_BY_ID, n.id).toHaveProperty(n.group);
			expect(KIND_LABEL, n.id).toHaveProperty(n.kind);
			expect(STATUS_META, n.id).toHaveProperty(n.status);
		}
	});
	it("group list is unique and nodesInGroup partitions the nodes", () => {
		expect(new Set(GROUPS.map((g) => g.id)).size).toBe(GROUPS.length);
		expect(GROUPS).toHaveLength(13);
		expect(GROUPS.reduce((n, g) => n + nodesInGroup(g.id).length, 0)).toBe(
			NODES.length,
		);
	});
	it("group and status inks are 6-digit hex and legible on the paper", () => {
		for (const hex of [
			...GROUPS.map((g) => g.color),
			...Object.values(STATUS_META).map((s) => s.color),
		]) {
			expect(hex).toMatch(/^#[0-9a-f]{6}$/);
			expect(contrast(hex, PAPER), hex).toBeGreaterThanOrEqual(4.5);
		}
	});
	it("groupColor falls back for an unknown group", () => {
		expect(groupColor("capture")).toBe(GROUP_BY_ID.capture.color);
		expect(groupColor("nope" as never)).toBe("#999");
	});
	it("byId indexes every node once", () => {
		expect(byId.size).toBe(NODES.length);
		expect(NODES).toBe(GIPFELBUCH_NODES);
		for (const n of NODES) expect(byId.get(n.id)).toBe(n);
	});
	it("no two nodes claim the same concept as their own page's primary subject twice in NODE_OF_CONCEPT", () => {
		const seen = new Map<string, string>();
		for (const [c, node] of NODE_OF_CONCEPT) {
			expect(seen.has(node) && seen.get(node) === c).toBe(false);
			seen.set(node, c);
			expect(byId.get(node)?.ontologyId).toBe(c);
		}
	});
});

describe("links", () => {
	it("every link resolves, has a rel, and has no self loops", () => {
		for (const l of LINKS) {
			expect(byId.has(l.from)).toBe(true);
			expect(byId.has(l.to)).toBe(true);
			expect(l.from).not.toBe(l.to);
			expect(l.rel).toBeTruthy();
		}
	});
	it("ontology-derived links never duplicate a curated pair in either direction", () => {
		const curated = new Set(
			LINKS.filter((l) => l.origin === "curated").flatMap((l) => [
				`${l.from}>${l.to}`,
				`${l.to}>${l.from}`,
			]),
		);
		const derived = LINKS.filter((l) => l.origin === "ontology");
		for (const l of derived)
			expect(curated.has(`${l.from}>${l.to}`)).toBe(false);
	});
	it("outgoing and incoming are two views of the same LINKS", () => {
		let out = 0;
		let inc = 0;
		for (const n of NODES) {
			out += outgoing(n.id).length;
			inc += incoming(n.id).length;
		}
		expect(out).toBe(LINKS.length);
		expect(inc).toBe(LINKS.length);
	});
	it("outgoing lists curated edges first, in written order, then derived ones", () => {
		for (const n of NODES) {
			const out = outgoing(n.id);
			const curated = out
				.filter((e) => e.origin === "curated")
				.map((e) => e.id);
			expect(curated).toEqual(
				n.related
					.filter((e) => byId.has(e.id) && e.id !== n.id)
					.map((e) => e.id),
			);
			const firstDerived = out.findIndex((e) => e.origin === "ontology");
			if (firstDerived >= 0)
				expect(
					out.slice(firstDerived).every((e) => e.origin === "ontology"),
				).toBe(true);
		}
	});
	it("backlinks name the source node", () => {
		for (const n of NODES)
			for (const b of backlinks(n.id)) {
				expect(
					outgoing(b.id).some((e) => e.id === n.id && e.rel === b.rel),
				).toBe(true);
			}
	});
	it("degree is in + out", () => {
		for (const n of NODES)
			expect(degree(n.id)).toBe(outgoing(n.id).length + incoming(n.id).length);
		expect(degree("not-a-node")).toBe(0);
		expect(incoming("not-a-node")).toEqual([]);
		expect(outgoing("not-a-node")).toEqual([]);
	});
	it("ONTOLOGY_LINKS are is-a or part-of between distinct primary nodes", () => {
		for (const l of ONTOLOGY_LINKS) {
			expect(["is-a", "part-of"]).toContain(l.rel);
			expect(l.from).not.toBe(l.to);
			expect(byId.has(l.from) && byId.has(l.to)).toBe(true);
		}
	});
});

describe("neighbourhood", () => {
	const start = NODES.find((n) => degree(n.id) > 0)?.id as string;
	it("depth 0 is the node itself", () => {
		expect([...neighbourhood(start, 0)]).toEqual([[start, 0]]);
	});
	it("depth 1 is exactly the undirected neighbours at distance 1", () => {
		const expected = new Set<string>([
			...outgoing(start).map((e) => e.id),
			...incoming(start).map((l) => l.from),
		]);
		const got = neighbourhood(start, 1);
		expect(got.get(start)).toBe(0);
		for (const [id, d] of got)
			if (id !== start) {
				expect(d).toBe(1);
				expect(expected.has(id)).toBe(true);
			}
		expect(got.size).toBe(new Set([start, ...expected]).size);
	});
	it("grows monotonically with depth and records shortest distances", () => {
		let prev = 0;
		for (let d = 0; d <= 4; d++) {
			const m = neighbourhood(start, d);
			expect(m.size).toBeGreaterThanOrEqual(prev);
			for (const v of m.values()) expect(v).toBeLessThanOrEqual(d);
			prev = m.size;
		}
		const all = neighbourhood(start, NODES.length);
		for (const [id, d] of all) {
			if (d === 0) continue;
			const nearer = [
				...outgoing(id).map((e) => e.id),
				...incoming(id).map((l) => l.from),
			].map((o) => all.get(o) ?? Infinity);
			expect(Math.min(...nearer)).toBe(d - 1);
		}
	});
});

describe("siblings", () => {
	it("walks a group in order without wrapping", () => {
		for (const g of GROUPS) {
			const nodes = nodesInGroup(g.id);
			nodes.forEach((n, i) => {
				const s = siblings(n.id);
				if (nodes.length < 2) {
					expect(s).toEqual({ prev: null, next: null });
					return;
				}
				expect(s.prev).toBe(i > 0 ? nodes[i - 1] : null);
				expect(s.next).toBe(i < nodes.length - 1 ? nodes[i + 1] : null);
			});
		}
	});
	it("an unknown id has no siblings", () => {
		expect(siblings("nope")).toEqual({ prev: null, next: null });
	});
});

describe("groupByRel and href", () => {
	it("groups by rel in first-seen order and keeps every edge", () => {
		const edges: GipfelbuchEdge[] = [
			{ id: "a", rel: "feeds" },
			{ id: "b", rel: "uses" },
			{ id: "c", rel: "feeds" },
		];
		expect(groupByRel(edges)).toEqual([
			["feeds", [edges[0], edges[2]]],
			["uses", [edges[1]]],
		]);
		expect(groupByRel([])).toEqual([]);
	});
	it("builds the page path", () => {
		expect(gipfelbuchHref("terrain-sampler")).toBe(
			"/gipfelbuch/terrain-sampler",
		);
	});
});
