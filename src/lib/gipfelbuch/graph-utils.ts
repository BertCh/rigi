// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	Aperture,
	Boxes,
	Camera,
	Cpu,
	FlaskConical,
	GalleryHorizontalEnd,
	Globe2,
	Layers,
	type LucideIcon,
	Mountain,
	Package,
	Radar,
	Sigma,
	Wrench,
} from "lucide-react";
import { GIPFELBUCH_NODES } from "./graph";
import { ONTOLOGY_LINKS } from "./ontology";
import type {
	GipfelbuchEdge,
	GipfelbuchGroup,
	GipfelbuchKind,
	GipfelbuchNode,
	GipfelbuchStatus,
} from "./types";

export interface GroupMeta {
	id: GipfelbuchGroup;
	label: string;
	blurb: string;
	color: string;
	icon: LucideIcon;
}

/**
 * Group inks for the Swiss paper ground (gb-paper #eeedeb): Brezine chart swatches, each at least 4.5:1
 * against the paper, spread over hue. Keep them 6-digit hex: consumers append alpha suffixes.
 */
export const GROUPS: GroupMeta[] = [
	{
		id: "capture",
		label: "Capture",
		blurb: "The photograph and what it carries.",
		color: "#95500c", // NB
		icon: Aperture,
	},
	{
		id: "world",
		label: "World",
		blurb: "Terrain, imagery and map data.",
		color: "#575e4e", // GG
		icon: Mountain,
	},
	{
		id: "camera",
		label: "Camera",
		blurb: "Pose, lens and projection.",
		color: "#002f55", // PB
		icon: Camera,
	},
	{
		id: "evidence",
		label: "Evidence",
		blurb: "Horizons, peaks and other cues.",
		color: "#bf2233", // SR
		icon: Radar,
	},
	{
		id: "solve",
		label: "Solve",
		blurb: "Search and refinement of the pose.",
		color: "#30626b", // GL
		icon: Globe2,
	},
	{
		id: "render",
		label: "Render",
		blurb: "Overlays, drapes and looks.",
		color: "#785840", // EB
		icon: Layers,
	},
	{
		id: "gpu",
		label: "GPU",
		blurb: "WebGPU compute and the render lock.",
		color: "#013a33", // TG
		icon: Cpu,
	},
	{
		id: "nearfield",
		label: "Near field",
		blurb: "Stepping inside the picture.",
		color: "#48442d", // G
		icon: Boxes,
	},
	{
		id: "roll",
		label: "Camera rolls",
		blurb: "Whole days of photographs at once.",
		color: "#712f26", // RB
		icon: GalleryHorizontalEnd,
	},
	{
		id: "product",
		label: "Product",
		blurb: "The app, its pages and flows.",
		color: "#4a545c", // BG
		icon: Package,
	},
	{
		id: "research",
		label: "Research",
		blurb: "Experiments, positives and graves.",
		color: "#503d33", // GA
		icon: FlaskConical,
	},
	{
		id: "infra",
		label: "Infra",
		blurb: "Tooling, tests and plumbing.",
		color: "#464544", // LD
		icon: Wrench,
	},
	{
		id: "math",
		label: "Math",
		blurb: "The geometry underneath.",
		color: "#9b2f1f", // R
		icon: Sigma,
	},
];

export const GROUP_BY_ID = Object.fromEntries(
	GROUPS.map((g) => [g.id, g]),
) as Record<GipfelbuchGroup, GroupMeta>;
export const groupColor = (g: GipfelbuchGroup) =>
	GROUP_BY_ID[g]?.color ?? "#999";

/** Status inks for the paper ground (Brezine swatches, each at least 4.5:1 on the paper). */
export const STATUS_META: Record<
	GipfelbuchStatus,
	{ label: string; color: string; blurb: string }
> = {
	live: {
		label: "Live",
		color: "#575e4e", // GG
		blurb: "Shipping in the app.",
	},
	flagged: {
		label: "Flagged",
		color: "#95500c", // NB
		blurb: "Built, behind a flag.",
	},
	research: {
		label: "Research",
		color: "#30626b", // GL
		blurb: "Open question or prototype.",
	},
	killed: {
		label: "Killed",
		color: "#464544", // LD
		blurb: "Tried and measured negative.",
	},
};

export const KIND_LABEL: Record<GipfelbuchKind, string> = {
	concept: "Concept",
	subsystem: "Subsystem",
	algorithm: "Algorithm",
	data: "Data",
	experiment: "Experiment",
	ui: "Interface",
	infra: "Infrastructure",
};

export const NODES: GipfelbuchNode[] = GIPFELBUCH_NODES;
export const byId: Map<string, GipfelbuchNode> = new Map(
	NODES.map((n) => [n.id, n]),
);

export interface Link {
	from: string;
	to: string;
	rel: string;
	/** "curated" = written in graph.ts; "ontology" = derived from the ontology is/has structure */
	origin: "curated" | "ontology";
}

/** Curated edges whose endpoints both exist (dangling ids are dropped). */
const CURATED_LINKS: Link[] = NODES.flatMap((n) =>
	n.related
		.filter((e) => byId.has(e.id) && e.id !== n.id)
		.map((e) => ({
			from: n.id,
			to: e.id,
			rel: e.rel,
			origin: "curated" as const,
		})),
);

const curatedPairs = new Set(
	CURATED_LINKS.flatMap((l) => [`${l.from}>${l.to}`, `${l.to}>${l.from}`]),
);

/** Ontology-derived edges for pairs with no curated edge in either direction. */
const DERIVED_LINKS: Link[] = ONTOLOGY_LINKS.filter(
	(l) =>
		byId.has(l.from) &&
		byId.has(l.to) &&
		!curatedPairs.has(`${l.from}>${l.to}`),
).map((l) => ({
	from: l.from,
	to: l.to,
	rel: l.rel,
	origin: "ontology" as const,
}));

/** Every edge whose endpoints both exist: curated first, then ontology-derived. */
export const LINKS: Link[] = [...CURATED_LINKS, ...DERIVED_LINKS];

const incomingMap = new Map<string, Link[]>();
const outgoingMap = new Map<string, Link[]>();
for (const l of LINKS) {
	const a = incomingMap.get(l.to);
	if (a) a.push(l);
	else incomingMap.set(l.to, [l]);
	const o = outgoingMap.get(l.from);
	if (o) o.push(l);
	else outgoingMap.set(l.from, [l]);
}

/** Edges pointing at `id`. */
export const incoming = (id: string): Link[] => incomingMap.get(id) ?? [];
/** Backlinks as GipfelbuchEdge-shaped (id = source node). */
export const backlinks = (id: string): GipfelbuchEdge[] =>
	incoming(id).map((l) => ({ id: l.from, rel: l.rel, origin: l.origin }));
/** Outgoing edges, curated (in graph.ts order, as written) then ontology-derived. */
export const outgoing = (id: string): GipfelbuchEdge[] => [
	...(byId.get(id)?.related ?? [])
		.filter((e) => byId.has(e.id))
		.map((e) => ({ ...e, origin: "curated" as const })),
	...(outgoingMap.get(id) ?? [])
		.filter((l) => l.origin === "ontology")
		.map((l) => ({ id: l.to, rel: l.rel, origin: l.origin })),
];

/** Undirected degree. */
export const degree = (id: string) => outgoing(id).length + incoming(id).length;

/** Ids within `depth` undirected hops of `id` (including itself), with hop distance. */
export function neighbourhood(id: string, depth = 1): Map<string, number> {
	const dist = new Map<string, number>([[id, 0]]);
	let frontier = [id];
	for (let d = 1; d <= depth; d++) {
		const next: string[] = [];
		for (const f of frontier) {
			for (const e of outgoing(f))
				if (!dist.has(e.id)) {
					dist.set(e.id, d);
					next.push(e.id);
				}
			for (const l of incoming(f))
				if (!dist.has(l.from)) {
					dist.set(l.from, d);
					next.push(l.from);
				}
		}
		frontier = next;
	}
	return dist;
}

export const nodesInGroup = (g: GipfelbuchGroup) =>
	NODES.filter((n) => n.group === g);

/** Previous / next node in the same group (wraps; null when the group has one node). */
export function siblings(id: string): {
	prev: GipfelbuchNode | null;
	next: GipfelbuchNode | null;
} {
	const n = byId.get(id);
	if (!n) return { prev: null, next: null };
	const g = nodesInGroup(n.group);
	if (g.length < 2) return { prev: null, next: null };
	// no wrap-around: in a two-node group both links would otherwise point at the same page
	const i = g.findIndex((x) => x.id === id);
	return {
		prev: i > 0 ? g[i - 1] : null,
		next: i < g.length - 1 ? g[i + 1] : null,
	};
}

/** Group edges by rel for a connections list. */
export function groupByRel(
	edges: GipfelbuchEdge[],
): [string, GipfelbuchEdge[]][] {
	const m = new Map<string, GipfelbuchEdge[]>();
	for (const e of edges) {
		const a = m.get(e.rel);
		if (a) a.push(e);
		else m.set(e.rel, [e]);
	}
	return [...m.entries()];
}

export const gipfelbuchHref = (id: string) => `/gipfelbuch/${id}`;
